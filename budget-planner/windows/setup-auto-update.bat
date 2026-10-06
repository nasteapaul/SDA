@echo off
setlocal
:: Budget Planner - automatic updates (one-time setup, double-click this file).
:: Every 10 minutes the PC checks GitHub; when a new version was pushed there,
:: it is downloaded and the server restarted. No more copying files by hand.
cd /d "%~dp0.."
set "APP=%CD%"
set "BRANCH=claude/budget-planner-bank-sync-03ykf8"

where git >nul 2>&1 || (
  echo Git was not found. Install it from https://git-scm.com and run this file again.
  pause & exit /b 1
)
:: A real git copy of the app (not just any folder inside some repo) can update itself.
git -C "%APP%" ls-files --error-unmatch server.js >nul 2>&1 && goto schedule

:: This folder was copied by hand, so it cannot update itself. Download a proper
:: copy from GitHub and move your private files (not on GitHub) into it.
set "DEST=%USERPROFILE%\SDA"
if exist "%DEST%" (
  echo "%DEST%" already exists. Rename or move it and run this file again.
  pause & exit /b 1
)
echo Downloading Budget Planner from GitHub into %DEST% ...
git clone -b %BRANCH% https://github.com/nasteapaul/SDA.git "%DEST%" || (
  echo Download failed - check that you are logged in to GitHub and try again.
  pause & exit /b 1
)
set "NEW=%DEST%\budget-planner"
echo Copying your data, .env and keys ...
if exist "%APP%\.env" copy /y "%APP%\.env" "%NEW%\" >nul
copy /y "%APP%\*.pem" "%NEW%\" >nul 2>&1
if exist "%APP%\data" robocopy "%APP%\data" "%NEW%\data" /E /XF server.pid >nul
if exist "%APP%\keystore" robocopy "%APP%\keystore" "%NEW%\keystore" /E >nul

:: Stop the server running from the old folder; it will run from the new one.
schtasks /End /TN "Budget Planner" >nul 2>&1
if exist "%APP%\data\server.pid" powershell -NoProfile -Command "$id = [int](Get-Content -LiteralPath '%APP%\data\server.pid' -TotalCount 1); $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force }" >nul 2>&1
set "OLD=%APP%"
set "APP=%NEW%"
schtasks /Query /TN "Budget Planner" >nul 2>&1 && schtasks /Create /F /SC ONLOGON /TN "Budget Planner" /TR "wscript.exe \"%APP%\windows\start-server.vbs\"" /RL LIMITED >nul
schtasks /Run /TN "Budget Planner" >nul 2>&1 || start "" wscript.exe "%APP%\windows\start-server.vbs"
echo.
echo Budget Planner now lives in %APP%
echo Check that the app works, then you can delete the old folder: %OLD%

:schedule
schtasks /Create /F /SC MINUTE /MO 10 /TN "Budget Planner Update" /TR "wscript.exe \"%APP%\windows\auto-update.vbs\"" /RL LIMITED >nul
if errorlevel 1 (
  echo Could not create the update task.
  pause & exit /b 1
)
schtasks /Run /TN "Budget Planner Update" >nul 2>&1
echo.
echo Done. Every 10 minutes Budget Planner checks GitHub for a new version and
echo installs it by itself. What happened is written to data\update.log.
echo To turn it off, run uninstall-autostart.bat.
pause
