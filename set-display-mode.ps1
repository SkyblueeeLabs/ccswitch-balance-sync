param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("compact", "full")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$modePath = Join-Path $PSScriptRoot "display-mode.json"
$tempPath = "$modePath.$([Guid]::NewGuid()).tmp"

try {
  $json = ConvertTo-Json -InputObject ([ordered]@{ mode = $Mode })
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, $utf8NoBom)
  if ([System.IO.File]::Exists($modePath)) {
    [System.IO.File]::Replace($tempPath, $modePath, [System.Management.Automation.Language.NullString]::Value)
  } else {
    [System.IO.File]::Move($tempPath, $modePath)
  }
  Write-Host "Balance display mode saved: $Mode"
} catch {
  Write-Error "Failed to save display mode: $($_.Exception.Message)"
  exit 1
} finally {
  [System.IO.File]::Delete($tempPath)
}
