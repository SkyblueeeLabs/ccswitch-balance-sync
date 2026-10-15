$ErrorActionPreference = 'Stop'
$legacyScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'balance-proxy.mjs'))
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
      $_.CommandLine -and (
        $_.CommandLine.IndexOf($legacyScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $_.CommandLine -match '(?:^|[\\/"\s])balance-proxy\.mjs(?:["\s]|$)'
      )
    }

  foreach ($process in $legacyProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Host "已关闭旧版余额代理进程 $($process.ProcessId)"
  }
} catch {
  Write-Error "检查旧版余额代理失败：$($_.Exception.Message)"
  exit 1
}
