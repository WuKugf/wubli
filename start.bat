@echo off
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   wubli launcher
echo ==========================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Please install Node.js LTS from https://nodejs.org
  echo Then run this file again.
  echo.
  start "" "https://nodejs.org/zh-cn"
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo.
  echo First run: installing dependencies, please wait 1-3 minutes...
  echo.
  call npm install --no-audit --no-fund
  if not exist "node_modules\express" (
    echo.
    echo Install failed, retrying with npmmirror registry...
    echo.
    call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
  )
)

if not exist "node_modules\express" (
  echo.
  echo [ERROR] Could not install dependencies. Check your network and try again.
  pause
  exit /b 1
)

echo.
echo Starting wubli at http://localhost:3200
echo Close this window to stop the server.
echo.
start "" "http://localhost:3200"
node server.js
pause
