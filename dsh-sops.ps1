param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string]$Profile,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$DshArgs,

  [string]$SecretFile = (Join-Path $HOME '.config\sops\secrets\global.sops.json'),

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Resolve-SopsExecutable {
  $command = Get-Command sops.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command sops -ErrorAction SilentlyContinue
  }
  if ($null -ne $command) {
    return $command.Source
  }

  $wingetPath = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\SecretsOPerationS.SOPS_Microsoft.Winget.Source_8wekyb3d8bbwe\sops.exe'
  if (Test-Path $wingetPath -PathType Leaf) {
    return $wingetPath
  }

  throw 'SOPS executable was not found. Install SOPS or add sops.exe to PATH.'
}

function Resolve-VendorDshExecutable {
  # dsh.cmd may itself be our SOPS guard in ~/.local/bin. Resolve the next
  # real DSH executable on PATH instead of recursing through that guard.
  $wrapperRoot = $PSScriptRoot
  $selfShim = [System.IO.Path]::GetFullPath((Join-Path $wrapperRoot 'dsh.cmd'))

  $commands = @(Get-Command dsh.cmd -All -ErrorAction SilentlyContinue)
  foreach ($command in $commands) {
    if ([string]::IsNullOrWhiteSpace($command.Source)) {
      continue
    }
    $candidate = [System.IO.Path]::GetFullPath($command.Source)
    if ($candidate -ne $selfShim) {
      return $candidate
    }
  }

  $npmDsh = Join-Path $env:APPDATA 'npm\dsh.cmd'
  if (Test-Path $npmDsh -PathType Leaf) {
    return $npmDsh
  }

  throw 'Vendor DSH executable was not found behind the SOPS guard.'
}

function Get-ProfileCredentialRefs {
  param([Parameter(Mandatory = $true)][string]$ProfileName)

  $patch = Join-Path $HOME ".dsh\profiles\$ProfileName\cordis.patch.yml"
  if (-not (Test-Path $patch -PathType Leaf)) {
    throw "DSH profile patch not found: $patch"
  }

  $refs = foreach ($line in Get-Content -LiteralPath $patch) {
    if ($line -match '^\s*apiKeyEnv:\s*["'']?([A-Za-z_][A-Za-z0-9_]*)["'']?\s*(?:#.*)?$') {
      $Matches[1]
    }
  }

  @($refs | Sort-Object -Unique)
}

$sops = Resolve-SopsExecutable
if (-not (Test-Path $SecretFile -PathType Leaf)) {
  throw "SOPS secrets file not found: $SecretFile"
}

$requiredRefs = @(Get-ProfileCredentialRefs -ProfileName $Profile)
if ($requiredRefs.Count -eq 0) {
  throw "No apiKeyEnv references were found in DSH profile '$Profile'."
}

# Credentials used by local routing/usage helpers rather than an LLM provider's
# apiKeyEnv. These are optional: inject them when present in SOPS, but do not
# make profiles that do not use the corresponding helper fail to start.
$optionalRefs = @(
  'AIHUBMIX_MANAGE_KEY'
)

$rawSecrets = (& $sops decrypt --output-type json $SecretFile 2>$null | Out-String)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rawSecrets)) {
  throw 'SOPS decryption failed. No secret values were printed.'
}

try {
  $secretMap = $rawSecrets | ConvertFrom-Json
} catch {
  throw 'Decrypted SOPS content is not valid JSON.'
}

$injectable = New-Object System.Collections.Generic.List[string]
$missing = New-Object System.Collections.Generic.List[string]
foreach ($ref in $requiredRefs) {
  $property = $secretMap.PSObject.Properties[$ref]
  if ($null -ne $property -and $property.Value -is [string] -and -not [string]::IsNullOrWhiteSpace($property.Value)) {
    $injectable.Add($ref)
  } else {
    $missing.Add($ref)
  }
}

foreach ($ref in $optionalRefs) {
  if ($requiredRefs -contains $ref) {
    continue
  }
  $property = $secretMap.PSObject.Properties[$ref]
  if ($null -ne $property -and $property.Value -is [string] -and -not [string]::IsNullOrWhiteSpace($property.Value)) {
    $injectable.Add($ref)
  }
}

Write-Output ("DSH SOPS launcher: profile={0}" -f $Profile)
Write-Output ("SOPS-injected refs: {0}" -f ($(if ($injectable.Count) { $injectable -join ', ' } else { '(none)' })))
if ($missing.Count) {
  throw ("Required DSH credential refs are missing from SOPS: {0}" -f ($missing -join ', '))
}

if ($DryRun) {
  $rawSecrets = $null
  $secretMap = $null
  exit 0
}

$dsh = Resolve-VendorDshExecutable

$previous = @{}
$exitCode = 1
try {
  foreach ($ref in $injectable) {
    $previous[$ref] = [Environment]::GetEnvironmentVariable($ref, 'Process')
    $value = [string]$secretMap.PSObject.Properties[$ref].Value
    [Environment]::SetEnvironmentVariable($ref, $value, 'Process')
  }

  # Keep secrets process-local. They are inherited by the DSH child only and are
  # never written to the Windows User environment or to settings.yaml.
  & $dsh --profile $Profile @DshArgs
  $exitCode = $LASTEXITCODE
} finally {
  foreach ($ref in $injectable) {
    $oldValue = $previous[$ref]
    [Environment]::SetEnvironmentVariable($ref, $oldValue, 'Process')
  }
  $rawSecrets = $null
  $secretMap = $null
  $previous.Clear()
}

exit $exitCode
