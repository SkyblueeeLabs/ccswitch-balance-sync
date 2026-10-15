@echo off
cd /d "%~dp0"
echo ==========================================
echo   CC Switch Balance Sync - Install
echo ==========================================
echo.
echo   This will install:
echo     1. Playwright (npm package)
echo     2. Chromium browser (Playwright)
echo.
pause

echo.
echo [0/2] Checking Node.js SQLite support...
node -e "require('node:sqlite').DatabaseSync" >nul 2>nul
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Node.js 22.5 or newer is required & pause & exit /b 1 )
echo [OK] Node.js supports node:sqlite
echo.

echo [1/2] Installing Playwright...
call npm install -g playwright
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Failed to install Playwright & pause & exit /b 1 )
echo [OK] Playwright installed
echo.

echo [2/2] Installing Chromium browser...
call npx playwright install chromium
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Failed to install Chromium & pause & exit /b 1 )
echo [OK] Chromium installed
echo.
echo ==========================================
echo   Installation complete!
echo ==========================================
echo.
echo   Next: double-click 2-login.bat
pause
