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

exec > /var/log/budget-setup.log 2>&1
chmod 600 /var/log/budget-setup.log
for i in 1 2 3 4 5; do
  curl -fsSL -o /root/setup-linux.sh \
    https://raw.githubusercontent.com/nasteapaul/SDA/claude/budget-planner-bank-sync-03ykf8/budget-planner/deploy/setup-linux.sh && break
  sleep $((i * 10))
done
UNATTENDED=1 TS_AUTHKEY="$TS_AUTHKEY" bash /root/setup-linux.sh
