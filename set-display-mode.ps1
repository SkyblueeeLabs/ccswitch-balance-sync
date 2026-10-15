param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("compact", "full")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$modePath = Join-Path $PSScriptRoot "display-mode.json"

try {
  $json = ConvertTo-Json -InputObject ([ordered]@{ mode = $Mode })
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($modePath, $json + [Environment]::NewLine, $utf8NoBom)
  Write-Host "Balance display mode saved: $Mode"
} catch {
  Write-Error "Failed to save display mode: $($_.Exception.Message)"
  exit 1
}
