@echo off
:: Restarts the Budget Planner server (e.g. after downloading a new version).
schtasks /End /TN "Budget Planner" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 1 >nul
schtasks /Run /TN "Budget Planner" >nul 2>&1 || wscript.exe "%~dp0start-server.vbs"
echo Server restarted. Log: data\server.log
timeout /t 2 >nul
