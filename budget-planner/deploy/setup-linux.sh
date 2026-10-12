#!/usr/bin/env bash
# Budget Planner — one-command setup on a Linux server (Oracle Cloud Always Free
# with Ubuntu, Google Cloud e2-micro with Debian, or any Debian/Ubuntu machine).
#
# Oracle Cloud, nothing typed on the server: paste deploy/oracle-cloud-init.sh
# (with your Tailscale auth key) as the VM's cloud-init script. The server starts
# without data and the PC's updater hands over its data, settings and bank key
# by itself over Tailscale (deploy/receive-linux.sh). See README section 5.
#
# By hand:
# 1. In the VM's browser SSH window, upload with "Upload file" (they land in your
#    home folder):
#      budget.json        your data (laptop: SDA\budget-planner\data\budget.json)
#      enablebanking.pem  your bank key
#      .env               optional: your laptop's .env (APP_PASSWORD, EB_APP_ID are reused)
# 2. Run:
#      curl -fsSL https://raw.githubusercontent.com/nasteapaul/SDA/claude/budget-planner-bank-sync-03ykf8/budget-planner/deploy/setup-linux.sh | sudo bash
#
# What it does: Bucharest time zone, 1 GB swap, Node.js LTS (checksum-verified),
# the app from GitHub in /opt/budget/SDA (own system user "budget"), your data,
# key and settings, Tailscale (private HTTPS address for the phone — nothing is
# opened to the internet), a hardened systemd service that starts at boot, and
# automatic updates from GitHub every 10 minutes. Safe to run again.
set -euo pipefail

REPO_URL=https://github.com/nasteapaul/SDA.git
BRANCH=claude/budget-planner-bank-sync-03ykf8
APP_USER=budget
BASE=/opt/budget
REPO=$BASE/SDA
APP=$REPO/budget-planner
TS_HOSTNAME=${TS_HOSTNAME:-budget}
TS_AUTHKEY=${TS_AUTHKEY:-}            # Tailscale auth key: joins your tailnet without a login link
APP_PASSWORD_IN=${APP_PASSWORD:-}     # optional; otherwise taken from .env or asked
EB_APP_ID_IN=${EB_APP_ID:-}
# Unattended (cloud-init, no terminal): no questions; a temporary password is
# made up and replaced by the PC's when it hands over its data.
UNATTENDED=${UNATTENDED:-}
[ -n "$UNATTENDED" ] || { : < /dev/tty; } 2>/dev/null || UNATTENDED=1
NODE_MAJOR=${NODE_MAJOR:-22}

say() { printf '\n\033[1m• %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v=""; [ -n "$UNATTENDED" ] || read -r -p "$1" v < /dev/tty; printf '%s' "$v"; }
ask_secret() { local v=""; [ -n "$UNATTENDED" ] || { read -r -s -p "$1" v < /dev/tty; echo > /dev/tty; }; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || die "run it with sudo (see the top of this file)."
command -v apt-get >/dev/null || die "this script needs a Debian/Ubuntu system."
UPLOADS=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
[ -n "$UPLOADS" ] || UPLOADS=/root

say "Time zone Europe/Bucharest (pay periods and dates are computed in local time)"
timedatectl set-timezone Europe/Bucharest 2>/dev/null || ln -sf /usr/share/zoneinfo/Europe/Bucharest /etc/localtime

if ! swapon --show | grep -q .; then
  say "1 GB swap (small VMs such as the e2-micro or Oracle's E2.1.Micro have 1 GB of memory)"
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "System packages"
export DEBIAN_FRONTEND=noninteractive
# On a VM's first boot, Ubuntu's own updates may hold the package lock: wait for it.
echo 'DPkg::Lock::Timeout "900";' > /etc/apt/apt.conf.d/90budget-lock-wait
for i in 1 2 3 4 5 6 7 8 9 10; do apt-get update -qq && break; [ "$i" = 10 ] && die "apt-get update kept failing."; sleep 30; done
apt-get install -y -qq git curl ca-certificates xz-utils tar >/dev/null

if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  say "Node.js ${NODE_MAJOR} LTS"
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums=$(curl -fsSL "$dist/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}')
  [ -n "$file" ] || die "could not find the Node.js download."
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$dist/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --quiet) || die "Node.js download failed its checksum."
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -rf "${tmp:?}"
fi
echo "  node $(/usr/local/bin/node --version)"

say "App user and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$BASE" && chown "$APP_USER:$APP_USER" "$BASE"
if [ -d "$REPO/.git" ]; then
  runuser -u "$APP_USER" -- git -C "$REPO" fetch --quiet origin "$BRANCH"
  runuser -u "$APP_USER" -- git -C "$REPO" checkout --quiet "$BRANCH"
  runuser -u "$APP_USER" -- git -C "$REPO" merge --ff-only --quiet "origin/$BRANCH" || true
else
  runuser -u "$APP_USER" -- git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP/data"

say "Your data and bank key"
if [ -f "$UPLOADS/budget.json" ]; then
  if [ -f "$APP/data/budget.json" ]; then
    echo "  data/budget.json already exists on the server - kept it (the uploaded copy was NOT used)."
  else
    install -o "$APP_USER" -g "$APP_USER" -m 0600 "$UPLOADS/budget.json" "$APP/data/budget.json"
    echo "  data restored from $UPLOADS/budget.json"
  fi
elif [ ! -f "$APP/data/budget.json" ]; then
  echo "  no budget.json uploaded - the app starts empty (you can still import CSV statements)."
fi
if [ -f "$UPLOADS/enablebanking.pem" ]; then
  install -o "$APP_USER" -g "$APP_USER" -m 0600 "$UPLOADS/enablebanking.pem" "$APP/enablebanking.pem"
  echo "  bank key installed"
fi

say "Tailscale (private HTTPS address for your phone and laptop)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
if ! tailscale status >/dev/null 2>&1; then
  echo "  Open the link below and log in with the SAME Tailscale account as your phone:"
  if [ -n "$TS_AUTHKEY" ]; then
    tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME"
  else
    tailscale up --hostname="$TS_HOSTNAME"
  fi
fi
TS_NAME=$(tailscale status --json | /usr/local/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
[ -n "$TS_NAME" ] || die "Tailscale is not connected."
PUBLIC_URL="https://$TS_NAME"
echo "  address: $PUBLIC_URL"

say "Settings (.env)"
envval() { # value of KEY in a .env file (Windows line endings tolerated)
  [ -f "$2" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$2" | tail -n1 | tr -d '\r' | sed 's/^"\(.*\)"$/\1/'
}
OLD_ENV=""
for f in "$APP/.env" "$UPLOADS/.env" "$UPLOADS/env.txt"; do [ -f "$f" ] && { OLD_ENV=$f; break; }; done
APP_PASSWORD=${APP_PASSWORD_IN:-$(envval APP_PASSWORD "$OLD_ENV")}
EB_APP_ID=${EB_APP_ID_IN:-$(envval EB_APP_ID "$OLD_ENV")}
SYNC_INTERVAL_HOURS=$(envval SYNC_INTERVAL_HOURS "$OLD_ENV")
if [ -z "$APP_PASSWORD" ] || [ "$APP_PASSWORD" = "change-me-to-something-long" ]; then
  APP_PASSWORD=$(ask_secret "  App password (the one you log in with): ")
  if [ -z "$APP_PASSWORD" ] && [ -n "$UNATTENDED" ]; then
    APP_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
    echo "  temporary app password made up (the PC's replaces it when it hands over its data)"
  fi
fi
[ ${#APP_PASSWORD} -ge 8 ] || die "the app password must have at least 8 characters."
if [ -z "$EB_APP_ID" ] && [ -f "$APP/enablebanking.pem" ]; then
  EB_APP_ID=$(ask "  Enable Banking Application ID (Enter to skip): ")
fi
umask 077
cat > "$APP/.env" <<EOF
# Written by deploy/setup-linux.sh — the server listens only on this machine;
# Tailscale serves it over HTTPS at PUBLIC_URL.
APP_PASSWORD=$APP_PASSWORD
HOST=127.0.0.1
PORT=8080
PUBLIC_URL=$PUBLIC_URL
EB_APP_ID=$EB_APP_ID
EB_PRIVATE_KEY_PATH=./enablebanking.pem
SYNC_INTERVAL_HOURS=${SYNC_INTERVAL_HOURS:-6}
EOF
chown "$APP_USER:$APP_USER" "$APP/.env" && chmod 600 "$APP/.env"
umask 022
for f in "$UPLOADS/.env" "$UPLOADS/env.txt" "$UPLOADS/enablebanking.pem" "$UPLOADS/budget.json"; do
  [ -f "$f" ] && shred -u "$f" 2>/dev/null || rm -f "$f" 2>/dev/null || true
done
echo "  uploaded copies removed from $UPLOADS (the app keeps its own)"

say "Service (starts at boot, restarts if it stops)"
cat > /etc/systemd/system/budget-planner.service <<EOF
[Unit]
Description=Budget Planner (RON) with bank sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP
Environment=TZ=Europe/Bucharest
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP/data
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
UMask=0077
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

install -m 0755 "$APP/deploy/update-linux.sh" /usr/local/sbin/budget-planner-update
cat > /etc/systemd/system/budget-planner-update.service <<EOF
[Unit]
Description=Budget Planner: update from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=BUDGET_REPO=$REPO BUDGET_BRANCH=$BRANCH BUDGET_USER=$APP_USER
ExecStart=/usr/local/sbin/budget-planner-update
EOF
cat > /etc/systemd/system/budget-planner-update.timer <<'EOF'
[Unit]
Description=Budget Planner: check GitHub for a new version every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
EOF

# No data yet: wait for the PC to hand over its own (data, .env values, bank key).
if [ ! -f "$APP/data/budget.json" ] || [ -f "$APP/data/.awaiting-import" ]; then
  say "Waiting for your PC's data (it sends it by itself over Tailscale)"
  install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/null "$APP/data/.awaiting-import"
  install -m 0755 "$APP/deploy/receive-linux.sh" /usr/local/sbin/budget-planner-receive
  cat > /etc/systemd/system/budget-planner-receive.service <<EOF
[Unit]
Description=Budget Planner: receive the PC's data over Tailscale
After=tailscaled.service budget-planner.service
Wants=tailscaled.service

[Service]
Type=simple
Environment=BUDGET_APP=$APP BUDGET_USER=$APP_USER
ExecStart=/usr/local/sbin/budget-planner-receive
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
  RECEIVE=1
fi
systemctl daemon-reload
systemctl enable --now budget-planner-update.timer >/dev/null
systemctl enable budget-planner >/dev/null
systemctl restart budget-planner
[ -z "${RECEIVE:-}" ] || systemctl enable --now budget-planner-receive >/dev/null

say "HTTPS for your devices (tailscale serve)"
timeout 30 tailscale serve --bg 8080 </dev/null >/dev/null 2>&1 || {
  echo "  'tailscale serve' failed: turn on HTTPS certificates in the Tailscale admin console"
  echo "  (DNS page → HTTPS Certificates → Enable), then run: sudo tailscale serve --bg 8080"
}

say "Checking"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:8080/; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  echo "  the app answers on this server"
else
  echo "  the app did not answer yet - see: journalctl -u budget-planner -n 50"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 Done.  Budget Planner runs in the cloud: $PUBLIC_URL

 Phone app : Settings → Server address → Change → $PUBLIC_URL
 Laptop    : open $PUBLIC_URL in the browser (Tailscale on)
 Bank      : in the Enable Banking control panel add the redirect URL
             $PUBLIC_URL/bank/callback   (needed when you re-link the bank)
 Updates   : automatic every 10 min   (journalctl -u budget-planner-update)
 Logs      : journalctl -u budget-planner -f
 Laptop    : if this server started without data, the PC hands over its data
             and stops its own server by itself within ~10 min (Tailscale on,
             logged in to the same account; see data\\update.log on the PC).
             Otherwise stop it yourself (windows\\uninstall-autostart.bat),
             or two copies sync the bank and drift apart.
────────────────────────────────────────────────────────────
EOF
