# setup-task.ps1 - 创建 CC Switch 余额自动刷新任务
# 需要管理员权限运行
$ErrorActionPreference = 'Stop'

$taskName   = "CCSwitchBalanceSync"
$scriptPath = Join-Path $PSScriptRoot "playwright-auto.mjs"
$runnerPath = Join-Path $PSScriptRoot "run-auto-sync.ps1"
$cleanupPath = Join-Path $PSScriptRoot "stop-legacy-proxy.ps1"
$logPath    = Join-Path $PSScriptRoot "auto-sync.log"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$refreshMinutes = 10

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Create CC Switch Balance Sync Auto-Refresh Task" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Task name:  $taskName"
Write-Host "  Script:     $scriptPath"
Write-Host "  Log:        $logPath"
Write-Host "  User:       $currentUser"
Write-Host "  Frequency:  Every $refreshMinutes minutes"
Write-Host ""

if (-not (Test-Path $scriptPath)) {
  Write-Host "[ERROR] 找不到脚本: $scriptPath" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}
if (-not (Test-Path $runnerPath)) {
  Write-Host "[ERROR] 找不到隐藏运行器: $runnerPath" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "[ERROR] 需要管理员权限，请右键以管理员身份运行 4-setup-task.bat" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}

# 定位 node.exe（计划任务不继承用户的 PATH，必须用绝对路径）
$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe"
  )
  $nodeCmd = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $nodeCmd) {
  Write-Host "[ERROR] 找不到 node.exe，请先安装 Node.js" -ForegroundColor Red
  Read-Host "按 Enter 退出"
  exit 1
}
Write-Host "  Node:       $nodeCmd" -ForegroundColor Gray
Write-Host ""

# 隐藏运行器短暂启动 Node，同步完成后进程退出，不常驻。
$powerShellCmd = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$escapedPowerShell = [System.Security.SecurityElement]::Escape($powerShellCmd)
$escapedNode   = [System.Security.SecurityElement]::Escape($nodeCmd)
$escapedScript = [System.Security.SecurityElement]::Escape($scriptPath)
$escapedRunner = [System.Security.SecurityElement]::Escape($runnerPath)
$escapedLog    = [System.Security.SecurityElement]::Escape($logPath)
$escapedPwd    = [System.Security.SecurityElement]::Escape($PSScriptRoot)
$escapedUser   = [System.Security.SecurityElement]::Escape($currentUser)
$arguments     = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedRunner`" -NodePath `"$escapedNode`" -ScriptPath `"$escapedScript`" -LogPath `"$escapedLog`""
$startBoundary = (Get-Date).ToString("s")

# 清理由旧版同步脚本留下的本项目代理进程。
if (Test-Path $cleanupPath) {
  & $powerShellCmd -NoProfile -ExecutionPolicy Bypass -File $cleanupPath
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CC Switch 余额静默同步（每 $refreshMinutes 分钟）</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${refreshMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escapedPowerShell</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$escapedPwd</WorkingDirectory>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <UserId>$escapedUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
</Task>
"@

Write-Host "创建任务..." -ForegroundColor Yellow
schtasks /Delete /TN "$taskName" /F 2>$null | Out-Null

$tmp = Join-Path $env:TEMP "ccswitch-task.xml"
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)

schtasks /Create /TN "$taskName" /XML "$tmp" /F
$ok = ($LASTEXITCODE -eq 0)
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($ok) {
  Write-Host "[OK] 任务创建成功！" -ForegroundColor Green
  Write-Host ""
  Write-Host "  运行日志: $logPath" -ForegroundColor Gray
  Write-Host "  立即测试: schtasks /Run /TN `"$taskName`"" -ForegroundColor Gray
  Write-Host ""
} else {
  Write-Host "[ERROR] 任务创建失败。" -ForegroundColor Red
}

Read-Host "按 Enter 退出"
