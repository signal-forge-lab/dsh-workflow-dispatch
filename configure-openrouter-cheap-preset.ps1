[CmdletBinding()]
param(
  [string]$ApiKey = $env:OPENROUTER_API_KEY,
  [switch]$PersistUserEnv,
  [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'
$PresetSlug = 'iw-v4-flash-cheap'
$Model = 'deepseek/deepseek-v4-flash-0731'
$PromptMaxUsdPerM = 0.10
$CompletionMaxUsdPerM = 0.20

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $sops = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\SecretsOPerationS.SOPS_Microsoft.Winget.Source_8wekyb3d8bbwe\sops.exe'
  $secretFile = Join-Path $HOME '.config\sops\secrets\global.sops.json'
  if ((Test-Path $sops -PathType Leaf) -and (Test-Path $secretFile -PathType Leaf)) {
    $secretMap = (& $sops decrypt $secretFile | Out-String | ConvertFrom-Json)
    if ($LASTEXITCODE -eq 0) {
      $ApiKey = [string]$secretMap.PSObject.Properties['OPENROUTER_API_KEY'].Value
    }
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  if ($NoPrompt) {
    [Console]::Error.WriteLine('OPENROUTER_API_KEY is not configured.')
    exit 2
  }
  $secure = Read-Host 'OpenRouter API key (input is hidden)' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw 'OpenRouter API key is empty.'
}

if ($PersistUserEnv) {
  Write-Warning '-PersistUserEnv is deprecated. OPENROUTER_API_KEY is no longer written to the Windows User environment; store it in the shared SOPS secrets file.'
}

$headers = @{
  Authorization = "Bearer $ApiKey"
  'Content-Type' = 'application/json'
}
$body = @{
  model = $Model
  provider = @{
    sort = 'price'
    allow_fallbacks = $true
    require_parameters = $true
    max_price = @{
      prompt = $PromptMaxUsdPerM
      completion = $CompletionMaxUsdPerM
    }
  }
  messages = @(
    @{ role = 'user'; content = 'preset configuration only' }
  )
} | ConvertTo-Json -Depth 8

$uri = "https://openrouter.ai/api/v1/presets/$PresetSlug/chat/completions"
$response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body

if ($response.data.slug -ne $PresetSlug) {
  throw "Preset creation returned an unexpected slug: $($response.data.slug)"
}

Write-Output "OpenRouter preset ready: @$('preset')/$PresetSlug"
Write-Output "Model: $Model"
Write-Output "Routing: sort=price, allow_fallbacks=true, require_parameters=true"
Write-Output "Hard ceiling: prompt <= `$${PromptMaxUsdPerM}/M, completion <= `$${CompletionMaxUsdPerM}/M"
if ($PersistUserEnv) {
  Write-Output 'OPENROUTER_API_KEY was not written to the Windows User environment.'
} else {
  Write-Output 'API key source: process override, shared SOPS store, or one-time prompt.'
}
