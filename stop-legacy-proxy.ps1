$ErrorActionPreference = 'Stop'
$legacyScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'balance-proxy.mjs'))
$escapedScript = [regex]::Escape($legacyScript)
$legacyArgument = '(?:^|\s)(?:"' + $escapedScript + '"|' + $escapedScript + ')(?:\s|$)'
$listenerIds = @(
  netstat -ano -p tcp | ForEach-Object {
    if ($_ -match '[:.]3456\s+.*LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
  } | Sort-Object -Unique
)

if ($listenerIds.Count -eq 0) { exit 0 }

try {
  $legacyProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $listenerIds -contains $_.ProcessId -and
      $_.CommandLine -and $_.CommandLine -match $legacyArgument
    }

  foreach ($process in $legacyProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped old balance proxy process $($process.ProcessId)"
  }
} catch {
  Write-Error "Could not check the old balance proxy: $($_.Exception.Message)"
  exit 1
}
