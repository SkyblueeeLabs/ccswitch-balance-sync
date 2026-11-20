$ErrorActionPreference = 'Stop'

$taskName   = "CCSwitchBalanceSync"
$scriptPath = Join-Path $PSScriptRoot "playwright-auto.mjs"
$runnerPath = Join-Path $PSScriptRoot "run-auto-sync.ps1"
$hiddenLauncherPath = Join-Path $PSScriptRoot "run-auto-sync-hidden.vbs"
$cleanupPath = Join-Path $PSScriptRoot "stop-legacy-proxy.ps1"
$logPath    = Join-Path $PSScriptRoot "auto-sync.log"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentUser = $identity.Name
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

foreach ($file in @($scriptPath, $runnerPath, $hiddenLauncherPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file missing: $file" }
}

if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
  throw 'Right-click 4-setup-task.bat and select Run as administrator.'
}

# Scheduled tasks use an absolute executable path.
$nodeCmd = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $nodeCmd) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe"
  )
  $nodeCmd = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $nodeCmd) { throw 'Node.js was not found.' }
& $nodeCmd --disable-warning=ExperimentalWarning -e "require('node:sqlite').DatabaseSync"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.13 or newer with node:sqlite is required.' }
Write-Host "  Node:       $nodeCmd" -ForegroundColor Gray
Write-Host ""

# WSH starts the PowerShell runner without opening a console.
$powerShellCmd = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$wscriptCmd = "$env:SystemRoot\System32\wscript.exe"
$escapedWscript = [System.Security.SecurityElement]::Escape($wscriptCmd)
$escapedPowerShell = [System.Security.SecurityElement]::Escape($powerShellCmd)
$escapedNode   = [System.Security.SecurityElement]::Escape($nodeCmd)
$escapedScript = [System.Security.SecurityElement]::Escape($scriptPath)
$escapedRunner = [System.Security.SecurityElement]::Escape($runnerPath)
$escapedLauncher = [System.Security.SecurityElement]::Escape($hiddenLauncherPath)
$escapedLog    = [System.Security.SecurityElement]::Escape($logPath)
$escapedPwd    = [System.Security.SecurityElement]::Escape($PSScriptRoot)
$escapedUser   = [System.Security.SecurityElement]::Escape($currentUser)
$arguments     = "`"$escapedLauncher`" `"$escapedPowerShell`" `"$escapedRunner`" `"$escapedNode`" `"$escapedScript`" `"$escapedLog`""
$startBoundary = (Get-Date).ToString("s")

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sync CC Switch balances every $refreshMinutes minutes</Description>
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
  <Principals>
    <Principal id="Author">
      <UserId>$escapedUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
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
      <Command>$escapedWscript</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$escapedPwd</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Write-Host 'Registering task...' -ForegroundColor Yellow
$tmp = Join-Path $env:TEMP "ccswitch-task-$([Guid]::NewGuid()).xml"
try {
  [System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)
  schtasks.exe /Create /TN $taskName /XML $tmp /F
  if ($LASTEXITCODE -ne 0) { throw "Task Scheduler registration failed (exit $LASTEXITCODE)." }
} finally {
  [System.IO.File]::Delete($tmp)
}

if (Test-Path -LiteralPath $cleanupPath -PathType Leaf) {
  & $powerShellCmd -NoProfile -ExecutionPolicy Bypass -File $cleanupPath
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not stop the old balance proxy.' }
}
Write-Host "[OK] Task registered. Run now with: schtasks /Run /TN `"$taskName`"" -ForegroundColor Green
exit 0
