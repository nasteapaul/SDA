# Budget Planner / SDA - set up a new Windows PC for working on the code with
# Claude Code. The app's server runs in the cloud, so nothing is started here.
# Run in PowerShell (no admin needed; Windows may ask to allow the installers):
#   irm https://raw.githubusercontent.com/nasteapaul/SDA/claude/budget-planner-bank-sync-03ykf8/budget-planner/windows/setup-dev-pc.ps1 | iex
# Installs (only what is missing): Git, Node.js LTS, Claude Code; clones SDA into
# C:\Claude\SDA on the app's branch and runs its tests. Safe to run again.
$ErrorActionPreference = 'Stop'
$Root = 'C:\Claude'
$Dir = Join-Path $Root 'SDA'
$Repo = 'https://github.com/nasteapaul/SDA.git'
$Branch = 'claude/budget-planner-bank-sync-03ykf8'

function Say($msg) { Write-Host "`n* $msg" -ForegroundColor Cyan }
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\bin')
}
function Install-IfMissing($command, $wingetId, $name) {
  if (Get-Command $command -ErrorAction SilentlyContinue) { Write-Host "  $name is already installed"; return }
  Say "Installing $name"
  winget install --id $wingetId -e --source winget --accept-package-agreements --accept-source-agreements --silent
  Update-Path
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$name did not install - run this script again, or install it by hand." }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget is missing: install "App Installer" from the Microsoft Store, then run this again.'
}

# npm and other tools ship as .ps1 scripts, which Windows blocks by default: allow
# local and signed scripts for this user (the usual developer setting).
if ((Get-ExecutionPolicy -Scope CurrentUser) -in 'Undefined', 'Restricted', 'AllSigned') {
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
}

Install-IfMissing git 'Git.Git' 'Git'
Install-IfMissing node 'OpenJS.NodeJS.LTS' 'Node.js LTS'

Update-Path
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Host '  Claude Code is already installed'
} else {
  Say 'Installing Claude Code'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Update-Path
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'Claude Code did not install - run this script again.' }
}

# Commits made on this PC need a name and e-mail (only set when missing).
if (-not (git config --global user.name)) { git config --global user.name 'nasteapaul' }
if (-not (git config --global user.email)) { git config --global user.email 'nasteapaul@gmail.com' }

Say "SDA in $Dir (branch $Branch)"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
  git -C $Dir fetch --quiet origin $Branch
  if (git -C $Dir status --porcelain --untracked-files=no) {
    Write-Host '  It already exists and has unsaved changes - left as it is.'
  } else {
    git -C $Dir checkout --quiet $Branch
    git -C $Dir merge --ff-only --quiet "origin/$Branch"
    Write-Host '  Updated to the latest version.'
  }
} else {
  git clone --quiet --branch $Branch $Repo $Dir
  if ($LASTEXITCODE -ne 0) { throw 'Downloading SDA from GitHub failed - check the internet connection and run this again.' }
}

Say 'Checking the app (tests)'
Push-Location (Join-Path $Dir 'budget-planner')
$ErrorActionPreference = 'Continue' # test output on stderr is not an error here
try { npm.cmd test --silent 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 8 } finally { Pop-Location }

Write-Host @"

------------------------------------------------------------
 Done.
 Code     : $Dir
 Start    : open PowerShell, then   cd $Dir ; claude
            (the first time Claude Code asks you to log in)
 The app  : https://budget.tail5efbc4.ts.net  (Tailscale on) -
            the server runs in the cloud, nothing to start here.
 Branches : keep $Dir on $Branch; for other
            projects use another folder (git worktree add ..\<name> <branch>).
------------------------------------------------------------
"@ -ForegroundColor Green
