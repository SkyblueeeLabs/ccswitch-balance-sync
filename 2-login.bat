@echo off
cd /d "%~dp0"
echo ==========================================
echo   CC Switch Balance Sync - Login
echo ==========================================
echo.
echo   A browser will open for each provider.
echo   Log in to all providers, then press ENTER here.
echo.
node playwright-login.mjs
echo.
pause
