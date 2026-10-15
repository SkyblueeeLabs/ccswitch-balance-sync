@echo off
cd /d "%~dp0"
echo ==========================================
echo   CC Switch Balance Sync - Login
echo ==========================================
echo.
echo   The saved login status will be checked for all providers.
echo   If it is still valid, balances sync automatically.
echo   If login is needed, complete it in the browser and press ENTER.
echo.
node playwright-login.mjs
echo.
pause
