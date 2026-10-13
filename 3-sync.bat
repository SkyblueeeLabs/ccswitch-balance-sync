@echo off
cd /d "%~dp0"
echo ==========================================
echo   CC Switch Balance Sync
echo ==========================================
echo.
node playwright-cookie.mjs
echo.
pause
