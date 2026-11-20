param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$log = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
if ($log -and $log.Length -ge 512KB) {
  $archivePath = Join-Path $log.DirectoryName "$($log.BaseName).1.log"
  Move-Item -LiteralPath $LogPath -Destination $archivePath -Force -ErrorAction Stop
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Content -LiteralPath $LogPath -Encoding utf8 -ErrorAction Stop -Value "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
& $NodePath --disable-warning=ExperimentalWarning $ScriptPath 2>&1 |
  ForEach-Object { [string]$_ } |
  Out-File -LiteralPath $LogPath -Append -Encoding utf8 -ErrorAction Stop
exit $LASTEXITCODE
