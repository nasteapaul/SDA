#!/bin/bash
# Budget Planner — Oracle Cloud (Always Free) cloud-init script.
# When creating the VM (Ubuntu image): Show advanced options → Management →
# "Paste cloud-init script" → paste this file, with your Tailscale auth key below
# (Tailscale admin console → Settings → Keys → Generate auth key; one-off is fine).
# The VM then installs everything by itself (deploy/setup-linux.sh), joins your
# tailnet as "budget" and waits for your PC to hand over its data (the PC's
# updater does that by itself). Nothing is opened to the internet.
# Progress on the VM: sudo cat /var/log/budget-setup.log
TS_AUTHKEY='tskey-auth-PASTE-YOUR-KEY-HERE'

# Progress also goes to the serial console: Oracle console → instance →
# Console history → Capture console history shows it without logging in.
touch /var/log/budget-setup.log && chmod 600 /var/log/budget-setup.log
exec > >(tee -a /var/log/budget-setup.log | sed -u 's/tskey-[A-Za-z0-9-]*/tskey-***/g; s/^/[budget] /' > /dev/console) 2>&1
case "$TS_AUTHKEY" in tskey-auth-PASTE*|'') echo "Stopped: put your Tailscale auth key in TS_AUTHKEY."; exit 1 ;; esac
# setup-linux.sh is safe to run again: retry if the network or the package lock got in the way.
for attempt in 1 2 3; do
  for i in 1 2 3 4 5; do
    curl -fsSL -o /root/setup-linux.sh \
      https://raw.githubusercontent.com/nasteapaul/SDA/claude/budget-planner-bank-sync-03ykf8/budget-planner/deploy/setup-linux.sh && break
    sleep $((i * 10))
  done
  UNATTENDED=1 TS_AUTHKEY="$TS_AUTHKEY" bash /root/setup-linux.sh </dev/null && { echo "BUDGET SETUP OK"; exit 0; }
  echo "Setup attempt $attempt failed - retrying in 60 s."
  sleep 60
done
echo "BUDGET SETUP FAILED - see /var/log/budget-setup.log"
