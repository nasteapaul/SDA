#!/usr/bin/env bash
# Budget Planner — receives the PC's data on a new cloud server (installed by
# deploy/setup-linux.sh when the server starts without data).
# While data/.awaiting-import exists, /api/health says awaitingData and the PC's
# updater (windows/auto-update.ps1) sends over Tailscale (Taildrop, only between
# your own devices): data.tgz (the data folder), laptop.env (its .env),
# enablebanking.pem and, last, handover-done.txt. This script then stops the
# app, installs them, starts it again, removes the marker and turns itself off.
# Logs: journalctl -u budget-planner-receive
set -uo pipefail

APP=${BUDGET_APP:-/opt/budget/SDA/budget-planner}
APP_USER=${BUDGET_USER:-budget}
INBOX=/var/lib/budget-planner-inbox
MARKER="$APP/data/.awaiting-import"
NODE=/usr/local/bin/node

mkdir -p "$INBOX" && chmod 700 "$INBOX"

envval() { # value of KEY in a .env file (Windows line endings and quotes tolerated)
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$2" | tail -n1 | tr -d '\r' \
    | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}
setenv() { # KEY VALUE: replace or add KEY in the app's .env
  local f="$APP/.env" tmp
  tmp=$(mktemp)
  grep -v "^[[:space:]]*$1[[:space:]]*=" "$f" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  install -o "$APP_USER" -g "$APP_USER" -m 0600 "$tmp" "$f" && rm -f "$tmp"
}

install_handover() {
  local work; work=$(mktemp -d)
  # Only regular files and folders, nothing outside the archive's own folder.
  if ! tar -tzf "$INBOX/data.tgz" > "$work/list" 2>/dev/null || grep -qE '(^/|(^|/)\.\.(/|$))' "$work/list"; then
    echo "data.tgz is not a valid archive - waiting for a new one."; rm -rf "$work"; return 1
  fi
  mkdir "$work/data"
  tar -xzf "$INBOX/data.tgz" -C "$work/data" --no-same-owner --no-same-permissions --exclude='*.log' --exclude='server.pid' || { rm -rf "$work"; return 1; }
  find "$work/data" -type l -delete
  if [ ! -f "$work/data/budget.json" ] || ! "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$work/data/budget.json"; then
    echo "data.tgz has no valid budget.json - waiting for a new one."; rm -rf "$work"; return 1
  fi

  systemctl stop budget-planner
  # The empty start-up data goes to a side folder (never deleted), then the PC's data comes in.
  local aside; aside="$APP/data-before-handover-$(date +%Y%m%d-%H%M%S)"
  mv "$APP/data" "$aside"
  install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP/data"
  cp -a "$work/data/." "$APP/data/"
  chown -R "$APP_USER:$APP_USER" "$APP/data" "$aside"
  chmod -R go-rwx "$APP/data" "$aside"

  if [ -f "$INBOX/enablebanking.pem" ] && grep -q 'PRIVATE KEY' "$INBOX/enablebanking.pem"; then
    install -o "$APP_USER" -g "$APP_USER" -m 0600 "$INBOX/enablebanking.pem" "$APP/enablebanking.pem"
    setenv EB_PRIVATE_KEY_PATH ./enablebanking.pem
    echo "Bank key installed."
  fi
  if [ -f "$INBOX/laptop.env" ]; then
    local v
    v=$(envval APP_PASSWORD "$INBOX/laptop.env")
    if [ ${#v} -ge 8 ] && [ "$v" != change-me-to-something-long ]; then setenv APP_PASSWORD "$v"; echo "App password taken from the PC."; fi
    for key in EB_APP_ID SYNC_INTERVAL_HOURS AUTO_SYNC_MIN_MINUTES SESSION_DAYS; do
      v=$(envval "$key" "$INBOX/laptop.env")
      [ -n "$v" ] && [[ "$v" =~ ^[A-Za-z0-9._-]+$ ]] && setenv "$key" "$v"
    done
  fi

  rm -f "$MARKER"
  systemctl start budget-planner
  rm -rf "$work"
  find "$INBOX" -type f -exec shred -u {} + 2>/dev/null || rm -f "$INBOX"/*
  echo "Handover done: the PC's data runs here now (the empty start-up data is in $aside)."
  return 0
}

while [ -f "$MARKER" ]; do
  # Blocks until files arrive; each file is moved into the inbox as it comes.
  tailscale file get --wait --conflict=overwrite "$INBOX" >/dev/null 2>&1 \
    || tailscale file get --wait "$INBOX" >/dev/null 2>&1 \
    || sleep 30
  if [ -f "$INBOX/handover-done.txt" ]; then
    if [ -f "$INBOX/data.tgz" ] && install_handover; then break; fi
    rm -f "$INBOX/handover-done.txt"
  fi
done

systemctl disable budget-planner-receive >/dev/null 2>&1 || true
exit 0
