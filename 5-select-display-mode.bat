@echo off
cd /d "%~dp0"
echo ==========================================
echo   Balance Display Mode
echo ==========================================
echo.
echo   1. Compact: balance and TP on one line
echo   2. Full: separate balance and Token Plan details
echo.
choice /C 12 /N /M "Select a display mode: "
if errorlevel 2 goto full
if errorlevel 1 goto compact
goto end

:compact
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-display-mode.ps1" -Mode compact
if errorlevel 1 goto failed
goto sync

:full
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-display-mode.ps1" -Mode full
if errorlevel 1 goto failed
goto sync

:sync
echo.
echo Applying the selected mode to CC Switch...
call "%~dp0\3-sync.bat"
exit /b %ERRORLEVEL%

:failed
echo.
echo Could not save the display mode.
pause
exit /b 1

:end
exit /b 0
