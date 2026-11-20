@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo   Create Auto-Refresh Task (run as administrator)
echo ==========================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-task.ps1"
set "taskExit=%ERRORLEVEL%"
echo.
pause
exit /b %taskExit%
