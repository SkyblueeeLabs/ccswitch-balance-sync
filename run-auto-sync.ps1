param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Continue'
Add-Content -LiteralPath $LogPath -Value "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
& $NodePath $ScriptPath 2>&1 | Out-File -LiteralPath $LogPath -Append -Encoding utf8
exit $LASTEXITCODE
