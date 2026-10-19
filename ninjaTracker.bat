@echo off
setlocal
title ninjaTracker
cd /d "%~dp0"

set "URL=http://localhost:3717"

rem --- Already running? Just show it, do not fight over the port. -------------
netstat -ano | findstr ":3717" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo ninjaTracker is already running.
  start "" "%URL%"
  goto :eof
)

rem --- First run, or a rebuild was asked for. ---------------------------------
if not exist "node_modules\" (
  echo Installing dependencies. This only happens once...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if /i "%~1"=="rebuild" goto :build
if not exist "dist\web\index.html" goto :build
goto :run

:build
echo Building the web app...
call npm run build
if errorlevel 1 goto :fail

:run
rem Open the browser only once the API actually answers, so the first load never
rem lands on a connection error. Runs beside the server instead of blocking it.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "for ($i=0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing '%URL%/api/status' -TimeoutSec 1 ^| Out-Null; Start-Process '%URL%'; exit } catch { Start-Sleep -Milliseconds 500 } }"

echo.
echo   ninjaTracker  -  %URL%
echo   The browser opens by itself once the server is ready.
echo   Closing this window stops the tracker.
echo.
npm start
goto :eof

:fail
echo.
echo Startup failed. The messages above say why.
pause
