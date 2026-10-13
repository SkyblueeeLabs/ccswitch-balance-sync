@echo off
cd /d "%~dp0"
echo ==========================================
echo   Create Auto-Refresh Task (UAC required)
echo ==========================================
powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0setup-task.ps1\"'"
timeout /t 10 /nobreak >nul
echo.
schtasks /Query /TN "CCSwitchBalanceSync" /V /FO LIST
echo.
pause
