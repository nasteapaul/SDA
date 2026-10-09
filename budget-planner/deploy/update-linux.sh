#!/usr/bin/env bash
# Budget Planner — automatic updates on a Linux server (run every 10 minutes by
# the budget-planner-update.timer that deploy/setup-linux.sh installs).
# - Keeps the app folder on the app's branch (switches back if it was changed
#   and has no unsaved edits).
# - When GitHub has a newer version: fast-forwards and restarts the server.
# - Never touches data/, .env or the bank key (they are not in git).
# This copy lives in /usr/local/sbin (outside the app folder) and refreshes
# itself from the repo after each update. Logs: journalctl -u budget-planner-update
set -uo pipefail

REPO=${BUDGET_REPO:-/opt/budget/SDA}
BRANCH=${BUDGET_BRANCH:-claude/budget-planner-bank-sync-03ykf8}
APP_USER=${BUDGET_USER:-budget}
SELF=/usr/local/sbin/budget-planner-update

as_app() { runuser -u "$APP_USER" -- git -C "$REPO" "$@"; }

[ -d "$REPO/.git" ] || { echo "No app repo at $REPO"; exit 0; }
changed=0

current=$(as_app rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
if [ "$current" != "$BRANCH" ]; then
  if [ -n "$(as_app status --porcelain --untracked-files=no)" ]; then
    echo "App folder is on '$current' with unsaved changes - not switching back to '$BRANCH'."
    exit 0
  fi
  as_app checkout --quiet "$BRANCH" || { echo "Could not switch back to $BRANCH"; exit 0; }
  echo "App folder had been switched to '$current'; switched back to '$BRANCH'."
  changed=1
fi

if as_app fetch --quiet origin "$BRANCH"; then
  local_rev=$(as_app rev-parse HEAD)
  remote_rev=$(as_app rev-parse "origin/$BRANCH")
  if [ "$local_rev" != "$remote_rev" ]; then
    if [ -n "$(as_app status --porcelain --untracked-files=no)" ]; then
      echo "Update skipped: files were changed on this server (git status)."
    elif as_app merge --ff-only --quiet "origin/$BRANCH"; then
      echo "Updated ${local_rev:0:7} -> ${remote_rev:0:7}"
      changed=1
    else
      echo "Update skipped: this server has its own commits."
    fi
  fi
fi # else offline: next run

# Keep the installed updater as new as the repo's copy.
src="$REPO/budget-planner/deploy/update-linux.sh"
if [ -f "$src" ] && ! cmp -s "$src" "$SELF"; then install -m 0755 "$src" "$SELF"; fi

if [ "$changed" = 1 ]; then
  systemctl restart budget-planner && echo "Server restarted."
fi
exit 0
