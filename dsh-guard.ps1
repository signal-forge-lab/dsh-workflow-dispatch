param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$DshArgs
)

$ErrorActionPreference = 'Stop'

if ($null -eq $DshArgs -or $DshArgs.Count -eq 0) {
  throw 'DSH SOPS guard requires an explicit profile. Use: dsh --profile <profile> ...'
}

$profile = $null
$forward = @()

if ($DshArgs[0] -eq '--profile') {
  if ($DshArgs.Count -lt 2 -or [string]::IsNullOrWhiteSpace($DshArgs[1])) {
    throw 'Missing value for --profile.'
  }
  $profile = $DshArgs[1]
  if ($DshArgs.Count -gt 2) {
    $forward = @($DshArgs[2..($DshArgs.Count - 1)])
  }
} elseif ($DshArgs[0] -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and
          (Test-Path (Join-Path $HOME ".dsh\profiles\$($DshArgs[0])\cordis.patch.yml") -PathType Leaf)) {
  $profile = $DshArgs[0]
  if ($DshArgs.Count -gt 1) {
    $forward = @($DshArgs[1..($DshArgs.Count - 1)])
  }
} else {
  throw 'DSH SOPS guard could not determine a profile. Use: dsh --profile <profile> ...'
}

& (Join-Path $PSScriptRoot 'dsh-sops.ps1') -Profile $profile -DshArgs $forward
exit $LASTEXITCODE
