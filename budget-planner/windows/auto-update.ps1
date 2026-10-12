# Budget Planner - automatic updates from GitHub.
# setup-auto-update.bat installs a copy of this script in
# %LOCALAPPDATA%\BudgetPlanner (outside the app folder, so it keeps working
# whatever happens to that folder) and runs it hidden every 10 minutes.
# - If the app folder was switched to another branch (e.g. another project
#   worked in it), it switches it back to the app's branch.
# - When a new version is on GitHub it downloads it and restarts the server.
# - If the new version doesn't answer within ~30 s, it goes back to the previous
#   one and doesn't try that version again (only a newer one).
# Your data, .env and keys are never touched (they are not on GitHub), except
# for the one-time move to a cloud server described at Move-ToCloud below.
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
# A version that failed to start: skipped until a newer one is on GitHub.
$badFile = Join-Path $dataDir 'update-bad-commit.txt'

# Where the server answers: PORT / HOST / TLS_CERT from .env, as server.js reads them.
$envCfg = @{}
$envFile = Join-Path $app '.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*(\w+)\s*=\s*(.*?)\s*$') { $envCfg[$matches[1]] = ($matches[2] -replace '\s+#.*$', '').Trim('"', "'") }
  }
}
$port = if ($envCfg['PORT'] -match '^\d+$') { $envCfg['PORT'] } else { '8080' }
$hostName = $envCfg['HOST']
if (-not $hostName -or $hostName -in '0.0.0.0', '::', 'localhost') { $hostName = '127.0.0.1' } elseif ($hostName -match ':') { $hostName = "[$hostName]" }
$scheme = if ($envCfg['TLS_CERT']) { 'https' } else { 'http' }
$health = '{0}://{1}:{2}/api/health' -f $scheme, $hostName, $port

Set-Location -LiteralPath $app
$branch = (git rev-parse --abbrev-ref HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $branch) { Write-Log 'Not a git folder - run setup-auto-update.bat.'; exit 0 }
$branch = $branch.Trim()
$restart = $false
$prev = $null

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
  $bad = if (Test-Path -LiteralPath $badFile) { "$(Get-Content -LiteralPath $badFile -TotalCount 1)".Trim() } else { '' }
  if ($local -ne $remote -and $remote -ne $bad) {
    if (git status --porcelain --untracked-files=no) {
      # Never overwrite changes made by hand on this PC.
      Write-Log 'Update skipped: files were changed on this PC (see git status).'
    } else {
      git merge --ff-only --quiet "origin/$branch" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Log 'Update skipped: this PC has its own commits that are not on GitHub.' }
      else {
        Write-Log ('Updated {0} -> {1}' -f $local.Substring(0, 7), $remote.Substring(0, 7))
        $restart = $true
        $prev = $local # the folder was clean, so going back to it loses nothing
      }
    }
  }
} # else offline: try again next time

function Stop-Server {
  schtasks /End /TN 'Budget Planner' 2>$null | Out-Null
  $pidFile = Join-Path $dataDir 'server.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $id = [int](Get-Content -LiteralPath $pidFile -TotalCount 1)
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force }
  }
}

# Restart the server so the new version is used (same steps as restart-server.bat).
function Restart-Server {
  Stop-Server
  Start-Sleep -Seconds 1
  schtasks /Run /TN 'Budget Planner' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Start-Process wscript.exe -ArgumentList ('"{0}"' -f (Join-Path $app 'windows\start-server.vbs')) }
}

# Waits up to ~30 s for the restarted server to answer /api/health.
function Test-Server {
  if ($scheme -eq 'https') {
    # Local check only: the certificate is for the public name, not 127.0.0.1.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $health).StatusCode -eq 200) { return $true } } catch { }
  }
  return $false
}

# ---- One-time move to a cloud server ----
# A new cloud server (deploy/setup-linux.sh, Tailscale name "budget") that started
# without data says so on /api/health (awaitingData). This PC then stops its own
# server, sends that server its data folder, .env and bank key over Tailscale
# (Taildrop: only between your own devices, encrypted), and once the server
# confirms it took them, removes its own auto-start for good: two copies would
# both sync the bank and drift apart. Recorded in data\moved-to-cloud.txt.
# If anything fails, this PC's server is started again and it tries again later.
$movedFile = Join-Path $dataDir 'moved-to-cloud.txt'
$retryFile = Join-Path $dataDir 'handover-retry-after.txt'

function Find-Tailscale {
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $exe) { return $exe }
  return $null
}

function Get-CloudHealth($url) {
  try { return Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri "$url/api/health" } catch { return $null }
}

function Move-ToCloud {
  if (Test-Path -LiteralPath $retryFile) {
    $after = [datetime]::MinValue
    if ([datetime]::TryParse("$(Get-Content -LiteralPath $retryFile -TotalCount 1)", [ref]$after) -and (Get-Date) -lt $after) { return $false }
  }
  $ts = Find-Tailscale
  if (-not $ts) { return $false }
  try { $status = (& $ts status --json 2>$null | Out-String) | ConvertFrom-Json } catch { return $false }
  if (-not $status -or -not $status.Peer) { return $false }
  $peer = $status.Peer.PSObject.Properties.Value |
    Where-Object { $_.HostName -eq 'budget' -and $_.OS -eq 'linux' -and $_.Online -and $_.DNSName } | Select-Object -First 1
  if (-not $peer) { return $false }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $url = 'https://' + $peer.DNSName.TrimEnd('.')
  $h = Get-CloudHealth $url
  if (-not $h -or -not $h.awaitingData) { return $false }
  $target = "$($peer.TailscaleIPs | Select-Object -First 1):"

  Write-Log "Cloud server $url is waiting for data - handing over this PC's data, settings and bank key."
  $tmp = Join-Path $env:TEMP ('budget-handover-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Stop-Server # so the data doesn't change while it is copied
    Start-Sleep -Seconds 2
    $files = @()
    tar.exe -czf (Join-Path $tmp 'data.tgz') -C $dataDir --exclude '*.log' --exclude '*.log.1' --exclude 'server.pid' `
      --exclude 'update-bad-commit.txt' --exclude 'handover-retry-after.txt' . 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'packing the data folder failed' }
    $files += Join-Path $tmp 'data.tgz'
    if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination (Join-Path $tmp 'laptop.env'); $files += Join-Path $tmp 'laptop.env' }
    $key = if ($envCfg['EB_PRIVATE_KEY_PATH']) { $envCfg['EB_PRIVATE_KEY_PATH'] } else { './enablebanking.pem' }
    if (-not [IO.Path]::IsPathRooted($key)) { $key = Join-Path $app $key }
    if (Test-Path -LiteralPath $key) { Copy-Item -LiteralPath $key -Destination (Join-Path $tmp 'enablebanking.pem'); $files += Join-Path $tmp 'enablebanking.pem' }
    & $ts file cp @files $target 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'sending the files over Tailscale failed (is Taildrop / "Send files" allowed in your tailnet?)' }
    Set-Content -LiteralPath (Join-Path $tmp 'handover-done.txt') -Value (Get-Date -Format o)
    & $ts file cp (Join-Path $tmp 'handover-done.txt') $target 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'sending the files over Tailscale failed' }

    $deadline = (Get-Date).AddMinutes(4)
    $done = $false
    while (-not $done -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      $h = Get-CloudHealth $url
      $done = $h -and $h.ok -and -not $h.awaitingData
    }
    if (-not $done) { throw "the cloud server did not confirm it took the data within 4 minutes" }

    schtasks /Delete /F /TN 'Budget Planner' 2>$null | Out-Null
    Set-Content -LiteralPath $movedFile -Value @(
      "Moved to $url on $(Get-Date -Format 'yyyy-MM-dd HH:mm').",
      'This PC no longer starts the Budget Planner server; the cloud server has the data.',
      "Phone: Settings -> Server address -> Change -> $url")
    Remove-Item -LiteralPath $retryFile -ErrorAction SilentlyContinue
    Write-Log "Handover done: Budget Planner now runs on $url. This PC's server is stopped and no longer starts with Windows."
    return $true
  } catch {
    Write-Log "Handover to $url failed: $_. This PC's server runs again; next try in 6 hours."
    Set-Content -LiteralPath $retryFile -Value (Get-Date).AddHours(6).ToString('o')
    schtasks /Run /TN 'Budget Planner' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Start-Process wscript.exe -ArgumentList ('"{0}"' -f (Join-Path $app 'windows\start-server.vbs')) }
    return $false
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Once moved, this PC never runs its own server: a copy still running (started by
# hand or before the move) is stopped, and the auto-start task removed, so only the
# cloud server syncs the bank.
function Stop-LeftoverServer {
  # The node process listening on this app's port (not other node programs).
  $ids = @(Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  $procs = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_.ProcessName -eq 'node' })
  schtasks /Query /TN 'Budget Planner' 2>$null | Out-Null
  $task = $LASTEXITCODE -eq 0
  if ($procs.Count -eq 0 -and -not $task) { return }
  if ($task) { schtasks /End /TN 'Budget Planner' 2>$null | Out-Null; schtasks /Delete /F /TN 'Budget Planner' 2>$null | Out-Null }
  foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Write-Log 'Budget Planner runs in the cloud now (see moved-to-cloud.txt): stopped the server still running on this PC.'
}

if (Test-Path -LiteralPath $movedFile) { $restart = $false; Stop-LeftoverServer }
elseif (Move-ToCloud) { $restart = $false; Stop-LeftoverServer }

if ($restart) {
  Restart-Server
  Write-Log 'Server restarted.'
  if (Test-Server) {
    if ($prev) { Remove-Item -LiteralPath $badFile -ErrorAction SilentlyContinue }
  } elseif ($prev) {
    $new = (git rev-parse HEAD).Trim()
    Write-Log ("Version {0} did not answer on {1} within 30 s - going back to {2}; it won't be tried again until a newer version is on GitHub." -f $new.Substring(0, 7), $health, $prev.Substring(0, 7))
    Set-Content -LiteralPath $badFile -Value $new
    git reset --hard --quiet $prev 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Log "Going back to $($prev.Substring(0, 7)) failed - see git status in $app" }
    else {
      Restart-Server
      Write-Log ('Server restarted on {0}.' -f $prev.Substring(0, 7))
      if (-not (Test-Server)) { Write-Log 'The server still does not answer - see data\server.log.' }
    }
  } else {
    Write-Log "The server does not answer on $health after the restart - see data\server.log."
  }
}

# Keep the installed copy of the updater as new as the app's (after a possible rollback).
if ($cfg['app']) {
  foreach ($f in 'auto-update.ps1', 'auto-update.vbs') {
    $src = Join-Path $app "windows\$f"; $dst = Join-Path $PSScriptRoot $f
    if ((Test-Path -LiteralPath $src) -and ((Get-FileHash -LiteralPath $src).Hash -ne (Get-FileHash -LiteralPath $dst -ErrorAction SilentlyContinue).Hash)) { Copy-Item -LiteralPath $src -Destination $dst -Force }
  }
}
