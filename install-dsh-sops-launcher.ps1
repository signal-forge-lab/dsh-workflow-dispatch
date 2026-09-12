param(
  [string]$Destination = (Join-Path $HOME '.local\bin')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $sourceRoot 'dsh-sops.ps1') -Destination (Join-Path $Destination 'dsh-sops.ps1') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'dsh-sops.cmd') -Destination (Join-Path $Destination 'dsh-sops.cmd') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'dsh-guard.ps1') -Destination (Join-Path $Destination 'dsh-guard.ps1') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'dsh.cmd') -Destination (Join-Path $Destination 'dsh.cmd') -Force

Write-Output "Installed dsh-sops launcher and plain-dsh SOPS guard to $Destination"
Write-Output 'Usage: dsh-sops web'
Write-Output 'Usage: dsh-sops headless "task"'
Write-Output 'Plain dsh --profile <profile> ... is now routed through the same SOPS launcher.'
