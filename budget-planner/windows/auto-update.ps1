# Budget Planner - automatic updates from GitHub.
# Run every 10 minutes (hidden) by the "Budget Planner Update" task that
# setup-auto-update.bat creates. When a new version was pushed to GitHub it is
# downloaded and the server restarted. Your data, .env and keys are never touched
# (they are not on GitHub). Activity is logged to data\update.log.
$ErrorActionPreference = 'Continue'
$app = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $app 'data'
$log = Join-Path $dataDir 'update.log'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
function Write-Log($msg) { Add-Content -LiteralPath $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg) }

Set-Location -LiteralPath $app
$branch = (git rev-parse --abbrev-ref HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $branch) { Write-Log 'Not a git folder - run setup-auto-update.bat.'; exit 0 }
$branch = $branch.Trim()
git fetch --quiet origin $branch 2>$null
if ($LASTEXITCODE -ne 0) { exit 0 } # offline: try again next time
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse "origin/$branch").Trim()
if ($local -eq $remote) { exit 0 }

# Never overwrite changes made by hand on this PC.
if (git status --porcelain --untracked-files=no) { Write-Log 'Update skipped: files were changed on this PC (see git status).'; exit 0 }
git merge --ff-only --quiet "origin/$branch" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Log 'Update skipped: this PC has its own commits that are not on GitHub.'; exit 0 }
Write-Log ('Updated {0} -> {1}' -f $local.Substring(0, 7), $remote.Substring(0, 7))

# Restart the server so the new version is used (same steps as restart-server.bat).
schtasks /End /TN 'Budget Planner' 2>$null | Out-Null
$pidFile = Join-Path $dataDir 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
  $id = [int](Get-Content -LiteralPath $pidFile -TotalCount 1)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force }
}
Start-Sleep -Seconds 1
schtasks /Run /TN 'Budget Planner' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Start-Process wscript.exe -ArgumentList ('"{0}"' -f (Join-Path $PSScriptRoot 'start-server.vbs')) }
Write-Log 'Server restarted.'
