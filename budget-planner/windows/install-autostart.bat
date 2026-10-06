@echo off
setlocal
:: Budget Planner - run at Windows startup (one-time setup, double-click this file).
:: Creates a Scheduled Task that starts the server, hidden, whenever this user logs in.
cd /d "%~dp0.."
set "APP=%CD%"

where node >nul 2>&1 || (
  echo Node.js was not found. Install it from https://nodejs.org and run this file again.
  pause & exit /b 1
)
if not exist "%APP%\.env" (
  echo No .env file found in "%APP%". Copy .env.example to .env and set APP_PASSWORD first.
  pause & exit /b 1
)

schtasks /Create /F /SC ONLOGON /TN "Budget Planner" /TR "wscript.exe \"%APP%\windows\start-server.vbs\"" /RL LIMITED >nul
if errorlevel 1 (
  echo Could not create the startup task.
  pause & exit /b 1
)

echo.
echo Done. Budget Planner will start automatically every time you log in to Windows.
echo Starting it now...
schtasks /Run /TN "Budget Planner" >nul
timeout /t 3 >nul
start "" http://localhost:8080
echo.
echo To remove it later, run uninstall-autostart.bat.
pause
