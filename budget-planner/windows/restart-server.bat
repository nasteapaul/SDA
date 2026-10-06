@echo off
:: Restarts the Budget Planner server (e.g. after downloading a new version).
schtasks /End /TN "Budget Planner" >nul 2>&1
:: Stop only this app's server: the process id it wrote to data\server.pid,
:: and only if that process is still node (not another program that got the id).
set "PIDFILE=%~dp0..\data\server.pid"
if exist "%PIDFILE%" (
  powershell -NoProfile -Command "$id = [int](Get-Content -LiteralPath $env:PIDFILE -TotalCount 1); $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force }" >nul 2>&1
)
timeout /t 1 >nul
schtasks /Run /TN "Budget Planner" >nul 2>&1 || wscript.exe "%~dp0start-server.vbs"
echo Server restarted. Log: data\server.log
timeout /t 2 >nul
