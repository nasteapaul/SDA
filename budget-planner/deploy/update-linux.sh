#!/usr/bin/env bash
# Budget Planner — automatic updates on a Linux server (run every 10 minutes by
# the budget-planner-update.timer that deploy/setup-linux.sh installs).
# - Keeps the app folder on the app's branch (switches back if it was changed
#   and has no unsaved edits).
# - When GitHub has a newer version: fast-forwards and restarts the server.
# - If the new version doesn't answer within ~30 s, goes back to the previous
#   one and doesn't try that version again (only a newer one).
# - Never touches data/, .env or the bank key (they are not in git).
# This copy lives in /usr/local/sbin (outside the app folder) and refreshes
# itself from the repo after each update. Logs: journalctl -u budget-planner-update
set -uo pipefail

REPO=${BUDGET_REPO:-/opt/budget/SDA}
BRANCH=${BUDGET_BRANCH:-claude/budget-planner-bank-sync-03ykf8}
APP_USER=${BUDGET_USER:-budget}
STATE_DIR=${BUDGET_STATE_DIR:-/var/lib/budget-planner-update}
SELF=/usr/local/sbin/budget-planner-update
APP="$REPO/budget-planner"
BAD_FILE="$STATE_DIR/bad-commit" # a version that failed to start: skipped until a newer one arrives

as_app() { runuser -u "$APP_USER" -- git -C "$REPO" "$@"; }

# Where the server answers: PORT / HOST / TLS_CERT from .env, as server.js reads them.
env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$APP/.env" 2>/dev/null | tail -n 1 \
    | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}
port=$(env_value PORT); [[ "$port" =~ ^[0-9]+$ ]] || port=8080
host=$(env_value HOST)
case "$host" in ''|0.0.0.0|::|localhost) host=127.0.0.1 ;; *:*) host="[$host]" ;; esac
scheme=http; [ -n "$(env_value TLS_CERT)" ] && scheme=https
HEALTH="$scheme://$host:$port/api/health"

# Waits up to ~30 s for the restarted server to answer.
healthy() {
  local end=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$end" ]; do
    sleep 2
    [ "$(curl -ks -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH")" = 200 ] && return 0
  done
  return 1
}

[ -d "$REPO/.git" ] || { echo "No app repo at $REPO"; exit 0; }
changed=0
prev_rev=""

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
  bad_rev=$(cat "$BAD_FILE" 2>/dev/null || true)
  if [ "$local_rev" != "$remote_rev" ] && [ "$remote_rev" != "$bad_rev" ]; then
    if [ -n "$(as_app status --porcelain --untracked-files=no)" ]; then
      echo "Update skipped: files were changed on this server (git status)."
    elif as_app merge --ff-only --quiet "origin/$BRANCH"; then
      echo "Updated ${local_rev:0:7} -> ${remote_rev:0:7}"
      changed=1
      prev_rev=$local_rev # the tree was clean, so going back to it loses nothing
    else
      echo "Update skipped: this server has its own commits."
    fi
  fi
fi # else offline: next run

if [ "$changed" = 1 ]; then
  systemctl restart budget-planner && echo "Server restarted."
  if healthy; then
    [ -n "$prev_rev" ] && rm -f "$BAD_FILE"
  elif [ -n "$prev_rev" ]; then
    new_rev=$(as_app rev-parse HEAD)
    echo "Version ${new_rev:0:7} did not answer on $HEALTH within 30 s - going back to ${prev_rev:0:7}; it won't be tried again until a newer version arrives."
    mkdir -p "$STATE_DIR" && echo "$new_rev" > "$BAD_FILE"
    if as_app reset --hard --quiet "$prev_rev"; then
      systemctl restart budget-planner && echo "Server restarted on ${prev_rev:0:7}."
      healthy || echo "The server still doesn't answer - check: journalctl -u budget-planner"
    else
      echo "Going back to ${prev_rev:0:7} failed - check: git -C $REPO status"
    fi
  else
    echo "The server doesn't answer on $HEALTH after the restart - check: journalctl -u budget-planner"
  fi
fi

# HTTPS for phone and PC: `tailscale serve` only works once HTTPS certificates are
# turned on in the tailnet (Tailscale admin → DNS); keep trying until it is set up.
if command -v tailscale >/dev/null && ! tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$port"; then
  if timeout 30 tailscale serve --bg "$port" </dev/null >/dev/null 2>&1; then
    echo "HTTPS turned on (tailscale serve -> port $port)."
  else
    echo "tailscale serve failed: turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page); retrying in 10 minutes."
  fi
fi

# Keep the installed updater as new as the repo's copy (after a possible rollback).
src="$APP/deploy/update-linux.sh"
if [ -f "$src" ] && ! cmp -s "$src" "$SELF"; then install -m 0755 "$src" "$SELF"; fi
exit 0
