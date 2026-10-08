# Budget Planner - automatic updates from GitHub.
# setup-auto-update.bat installs a copy of this script in
# %LOCALAPPDATA%\BudgetPlanner (outside the app folder, so it keeps working
# whatever happens to that folder) and runs it hidden every 10 minutes.
# - If the app folder was switched to another branch (e.g. another project
#   worked in it), it switches it back to the app's branch.
# - When a new version is on GitHub it downloads it and restarts the server.
# Your data, .env and keys are never touched (they are not on GitHub).
# Activity is logged to data\update.log in the app folder.
$ErrorActionPreference = 'Continue'

# updater.ini (written by setup-auto-update.bat): app=<app folder>, branch=<app branch>
$cfg = @{}
$ini = Join-Path $PSScriptRoot 'updater.ini'
if (Test-Path -LiteralPath $ini) {
  foreach ($line in Get-Content -LiteralPath $ini) { if ($line -match '^\s*(\w+)\s*=\s*(.+?)\s*$') { $cfg[$matches[1]] = $matches[2] } }
}
$app = if ($cfg['app']) { $cfg['app'] } else { Split-Path -Parent $PSScriptRoot }
$want = $cfg['branch']
$dataDir = Join-Path $app 'data'
$log = Join-Path $dataDir 'update.log'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
function Write-Log($msg) { Add-Content -LiteralPath $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg) }

Set-Location -LiteralPath $app
$branch = (git rev-parse --abbrev-ref HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $branch) { Write-Log 'Not a git folder - run setup-auto-update.bat.'; exit 0 }
$branch = $branch.Trim()
$restart = $false

# The app folder must stay on the app's branch: another branch (another project)
# has no budget-planner files, so the app would vanish from the folder.
if ($want -and $branch -ne $want) {
  if (git status --porcelain --untracked-files=no) {
    Write-Log "The app folder is on branch '$branch' (not '$want') and has unsaved changes there - not switching back. Save or move that work, or run: git checkout $want"
    exit 0
  }
  git checkout --quiet $want 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Log "The app folder is on branch '$branch'; switching back to '$want' failed - run: git checkout $want"; exit 0 }
  Write-Log "The app folder had been switched to branch '$branch' (another project?). Switched it back to '$want'."
  $branch = $want
  $restart = $true
}

git fetch --quiet origin $branch 2>$null
if ($LASTEXITCODE -eq 0) {
  $local = (git rev-parse HEAD).Trim()
  $remote = (git rev-parse "origin/$branch").Trim()
  if ($local -ne $remote) {
    if (git status --porcelain --untracked-files=no) {
      # Never overwrite changes made by hand on this PC.
      Write-Log 'Update skipped: files were changed on this PC (see git status).'
    } else {
      git merge --ff-only --quiet "origin/$branch" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Log 'Update skipped: this PC has its own commits that are not on GitHub.' }
      else { Write-Log ('Updated {0} -> {1}' -f $local.Substring(0, 7), $remote.Substring(0, 7)); $restart = $true }
    }
  }
} # else offline: try again next time

# Keep the installed copy of the updater as new as the app's.
if ($cfg['app']) {
  foreach ($f in 'auto-update.ps1', 'auto-update.vbs') {
    $src = Join-Path $app "windows\$f"; $dst = Join-Path $PSScriptRoot $f
    if ((Test-Path -LiteralPath $src) -and ((Get-FileHash -LiteralPath $src).Hash -ne (Get-FileHash -LiteralPath $dst -ErrorAction SilentlyContinue).Hash)) { Copy-Item -LiteralPath $src -Destination $dst -Force }
  }
}

if (-not $restart) { exit 0 }
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
if ($LASTEXITCODE -ne 0) { Start-Process wscript.exe -ArgumentList ('"{0}"' -f (Join-Path $app 'windows\start-server.vbs')) }
Write-Log 'Server restarted.'
