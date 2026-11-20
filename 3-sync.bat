@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo   CC Switch Balance Sync
echo ==========================================
echo.
node "%~dp0playwright-cookie.mjs"
set "syncExit=%ERRORLEVEL%"
echo.
pause
exit /b %syncExit%
