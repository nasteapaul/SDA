@echo off
:: Removes the Budget Planner startup task and stops the server.
schtasks /End /TN "Budget Planner" >nul 2>&1
schtasks /Delete /F /TN "Budget Planner" >nul 2>&1
schtasks /Delete /F /TN "Budget Planner Update" >nul 2>&1
if exist "%LOCALAPPDATA%\BudgetPlanner" rmdir /s /q "%LOCALAPPDATA%\BudgetPlanner"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
echo Budget Planner will no longer start automatically.
pause
