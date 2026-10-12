# Budget Planner (RON)

A self-hosted budget app for your phone and laptop:

- **Income and expenses in RON**: add, edit and delete them, with a live "left to spend this month" balance
- **Category breakdown**: a chart of spending by category, monthly budgets, and income vs. spending over 6 months
- **Bank sync**: links your main bank account through PSD2 open banking (BT, BCR, BRD, ING, Raiffeisen, CEC, Revolut and others). New transactions come in automatically and are sorted into categories.
- **Multiple savings goals**: each has a target, a deadline (optional) and a priority. You record money added to or taken out of a goal.
- **Savings plan**: learns your spending habits from your history and builds a monthly plan to reach your goals. It covers how much to save, which flexible categories to trim, realistic dates, recurring payments and categories that are rising.
- **One app on phone and laptop**: it installs on the phone's home screen and runs in any browser on the laptop. Both devices update live.
- **Numbers you can check**: a *Bank check* card shows when each account last synced, whether the app's transactions explain the bank balance (and the likely reason when they don't), and how many days the bank access has left.
- **Safe to spend until payday**: the balance minus the bills, subscriptions and card repayment still due before the next salary, shown as a range and per day, with a calendar of what's coming.
- **Subscriptions and bills**: found from payments that repeat, with price rises and next due dates (Plan tab). Confirm or hide each one.
- **Alerts**: bills due soon, price rises, yearly renewals, late refunds, the card repayment, bank access running out, a summary on payday. On the Overview, and as notifications in the Android app.
- **More**: a *To check* list for guessed categories (and rule suggestions after you correct a merchant twice), split purchases across categories, refunds you're waiting for, meal vouchers kept apart from the current account, interest and fees shown as the cost of the credit card, the bank's exchange-rate markup vs BNR, net worth with pensions and loans you add, CSV export and a printable period report.

```
 ┌──────────── your home Wi-Fi ────────────┐
 │                                         │        PSD2 / open banking
 │  phone (app) ─┐                         │      ┌──────────────────────┐
 │               ├──►  home server  ───────┼─────►│ Enable Banking → bank │
 │  laptop (web) ┘    (Raspberry Pi,       │      └──────────────────────┘
 │                     old PC, NAS…)       │
 └─────────────────────────────────────────┘
```

The **home server** stores your data in a single file (`data/budget.json`) and checks the bank every few hours. Your phone and laptop connect to it over the home Wi-Fi. When you open the app at home it syncs right away. Away from home it shows the last data it saved. Changes you make offline wait in a queue and upload when you're back on your Wi-Fi.

---

## 1. Run it (5 minutes)

You need [Node.js 20+](https://nodejs.org). There are no other dependencies.

```bash
cd budget-planner
cp .env.example .env        # then edit .env: set APP_PASSWORD at least
npm start
```

The terminal prints the address:

```
  Budget planner running on http://localhost:8080
```

- **Laptop:** open that address on the computer running the server.
- **Phone or another computer:** the server must use HTTPS first (see [Use it from your phone](#4-use-it-from-your-phone-https)). The server refuses to listen on the network over plain HTTP, because your password and bank data would travel unencrypted. Then open the HTTPS address and add it to your home screen so it opens like an app:
  - **iPhone (Safari):** Share → *Add to Home Screen*
  - **Android (Chrome):** ⋮ → *Add to Home screen* / *Install app*

> Tip: in your router, give the server a fixed IP (a "DHCP reservation") so the address never changes.

### Android app (APK)

`android/` contains a small native app that wraps the web app (package `ro.budgetplanner.app`, Android 7.0+).

1. Copy `Budget.apk` to the phone and open it. Android asks you to allow installing apps from that source (your browser or file manager); allow it. Play Protect may warn about an app from an "unknown developer"; tap *Install anyway*.
2. Open **Budget**, enter the server's HTTPS address (for example your Tailscale `https://<machine>.<tailnet>.ts.net` address), then log in with your `APP_PASSWORD`. The app only connects over HTTPS. Tailscale is the easiest choice here: its certificates are trusted by Android out of the box, while an mkcert certificate is not trusted by apps.

How the app behaves:
- **At home** it shows the live data.
- **Away from home** it opens with the last data it saved. Changes you make are queued and sent when you're back on your Wi-Fi.
- **Bank login** opens in your normal browser, because many banks block logins inside apps. When the browser says the bank is linked, switch back to the app.
- **CSV import** uses the phone's file picker. **Export** opens Android's "Save to…" dialog.
- To point the app at a different server, go to **Settings → Server address → Change**.
- **Notifications:** every few hours the app asks your server for new alerts (`/api/alerts`) and shows each one once. Android 13+ asks for permission the first time; which alerts you get is set in **Settings → Alerts**. Away from home it can only check once you're back on your Wi-Fi (or with Tailscale on).
- **From 2027** Android only installs apps from verified developers. A free *limited distribution* account in the Android Developer Console (up to 20 devices, no ID needed) keeps this app installable; set it up before then.

To rebuild it you need Linux or macOS with a JDK 11+, python3, git and curl. No Android Studio is required:

```bash
cd android && ./build.sh          # → android/build/Budget.apk
```

The first build downloads the tools it needs into `android/.tools/` and creates a signing key in `android/keystore/`. **Keep that key.** An update only installs over the existing app if it is signed with the same key. If you lose the key, uninstall the old app first. Your data lives on the server, so nothing is lost; you only need to log in again.

**Try it with demo data first:** `npm run demo` loads 4 months of realistic transactions and 3 goals into a separate `demo-data/` folder. Your real data is not touched.

### Keep it running

On a Raspberry Pi or any Linux box, edit the paths and user in `budget-planner.service`, then run:

```bash
sudo cp budget-planner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now budget-planner
```

**Windows:** double-click `windows\install-autostart.bat` once. It creates a scheduled task that starts the server, hidden (no window), every time you log in, and opens the app. `windows\restart-server.bat` restarts it after you download a new version; `windows\uninstall-autostart.bat` removes the auto-start. The server's output goes to `data\server.log`.

**Automatic updates (Windows):** double-click `windows\setup-auto-update.bat` once. Every 10 minutes the PC checks GitHub; when a new version was pushed, it downloads it and restarts the server by itself, so you never copy files or restart by hand. If the folder was copied by hand (not a git clone), the script first makes a proper copy in `%USERPROFILE%\SDA` and moves your `.env`, keys and `data\` into it. Files you changed on the PC are never overwritten (the update is skipped and noted). Log: `data\update.log`. `uninstall-autostart.bat` turns it off too.

On macOS you can use `npx pm2 start server.js --name budget`, or just leave a terminal open.

---

## 2. Link your bank account

Bank sync uses **[Enable Banking](https://enablebanking.com)**, a licensed PSD2 provider. Individuals can link their **own** accounts with it for free. Check their current terms when you sign up.

1. Create an account at **enablebanking.com** and open the **Control Panel → Applications → Add application**.
2. Choose the **Production** environment and give it a name, e.g. "My budget".
3. Under **Redirect URLs**, add `https://<your-server-address>/bank/callback`. This must exactly match `PUBLIC_URL` + `/bank/callback` in your `.env`.
4. Let the panel **generate the private key**. Save the downloaded `.pem` file into the `budget-planner` folder as `enablebanking.pem`. Keep it secret.
5. Copy the **Application ID** into `.env`:
   ```ini
   EB_APP_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
   EB_PRIVATE_KEY_PATH=./enablebanking.pem
   PUBLIC_URL=https://budget.example.ts.net
   ```
6. Restart the server. In the app, go to **Settings → Bank connection**, pick your bank and tap **Connect bank**.
7. Log in at your bank and approve. You'll land back in the app, and your last 90 days of transactions are imported.

If the Control Panel says your application needs activation, linking your own account from the app is how you activate it.

**Good to know**
- **When it syncs:** every `SYNC_INTERVAL_HOURS` (6h by default), and also whenever you open the app at home if the last sync is older than 2h. PSD2 allows banks to limit background access to about 4 times a day, which is why it isn't more frequent. **Sync now** in Settings forces an update.
- **Re-linking:** consent lasts 90–180 days depending on the bank. The app warns you when it expires, and you re-link from Settings in a few seconds.
- **No duplicates:** re-syncing never imports the same transaction twice. Transactions you delete stay deleted. Pending card payments are added once they're booked.
- **Teaching categories:** if you change the category of a bank transaction, tick *"Always put … in this category"*. The app then remembers that merchant for all future syncs (see Settings → Learned rules).
- **If the bank can't redirect back** (for example, your provider only accepts `https://` redirect URLs), register any URL you control. After approving at the bank, copy the address you landed on and paste it into **Settings → Redirect didn't come back to the app?**

**No API access yet?** Use **Settings → Import a bank statement (CSV)**. It reads CSV exports from BT, BCR, ING, Raiffeisen, BRD, Revolut and most other banks, and skips duplicates.

---

## 3. Using it

| Tab | What it's for |
|---|---|
| **Overview** | Left to spend this month, income / spending / saved, spending by category against your budgets, the 6-month trend, goals and recent transactions. Tap a category bar to see its transactions. |
| **Transactions** | Search and filter by month, type or category. Tap a row to edit it; delete it from the edit form (undo is available). |
| **Goals** | As many goals as you want. **Add money** records a *Savings* transaction, so your left-to-spend balance drops by the same amount. **Withdraw** reverses it. |
| **Plan** | Choose *Gentle / Balanced / Aggressive* and which goals to include. The plan uses your average income and spending from the last full months (up to 6). It only trims **flexible** categories, never rent, bills, groceries, transport or health; you can change which categories are essential in Settings. It also shows when each goal will be reached and gives practical tips. **Use as my budgets** turns the suggested limits into budget markers on the Overview. |
| **Settings** | Bank link, CSV import, categories, learned rules, theme, data export, sign out. |

---

## 4. Use it from your phone (HTTPS)

Anything other than the computer running the server connects over **HTTPS**. If `HOST` is a network address (or `APP_PASSWORD` is set, which defaults `HOST` to `0.0.0.0`) and there is no certificate, the server stops at startup with an explanation. HTTPS also gives full offline support (opening the app with no connection to the server).

There are two ways to get it:

- **[Tailscale](https://tailscale.com)** (easiest, and it also lets you use the app away from home): install it on the server and your phone. In `.env` set `HOST=127.0.0.1`, `APP_PASSWORD` and `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`. Run `tailscale serve --bg 8080` on the server, and use that `https://` address on the phone.
- **[mkcert](https://github.com/FiloSottile/mkcert)**: create a certificate for your server's IP, install mkcert's root CA on your phone, and set `TLS_CERT` / `TLS_KEY` in `.env`. This works in the phone's browser, but not in the Android app.

`ALLOW_INSECURE_HTTP=1` turns the check off and serves plain HTTP on the network. Don't, unless you understand the risk.

---

## 5. Run it in the cloud (no PC left on)

`deploy/setup-linux.sh` sets everything up on a small Linux server in one command: Node.js, the app, your data and bank key, Tailscale (a private HTTPS address; nothing is opened to the internet), a service that starts at boot, and automatic updates from GitHub every 10 minutes. It works on Oracle Cloud's and Google Cloud's free VMs and on any Debian/Ubuntu machine (e.g. a Raspberry Pi).

**Oracle Cloud Always Free (recommended — nothing to type on the server or the PC):**
1. Create an account at [cloud.oracle.com](https://cloud.oracle.com) (a card is asked for verification only; Always Free resources are not billed). Pick a home region close to you, e.g. *Germany Central (Frankfurt)* — it can't be changed later.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys) → *Settings → Keys → Generate auth key* (defaults are fine). Copy the `tskey-auth-…` key.
3. *Compute → Instances → Create instance*:
   - Image: **Canonical Ubuntu 24.04** (or 22.04).
   - Shape: **VM.Standard.A1.Flex** (Ampere, 1 OCPU / 6 GB) or, if Oracle says it is out of capacity, **VM.Standard.E2.1.Micro**. Both are *Always Free-eligible*.
   - Networking: leave as it is (a public IPv4 address is needed to reach your bank and GitHub; no ports have to be opened).
   - *Show advanced options → Management → Paste cloud-init script*: paste [`deploy/oracle-cloud-init.sh`](deploy/oracle-cloud-init.sh) with your key in place of `tskey-auth-PASTE-YOUR-KEY-HERE`.
   - *Create*. Setup takes about 5 minutes.
4. That's it. The VM joins your tailnet as `budget` and waits for data. Within ~10 minutes the PC's updater (`windows/auto-update.ps1`, already running every 10 minutes) sees it, stops its own server, sends it the `data` folder, `.env` settings and bank key over Tailscale (Taildrop — only between your own devices, encrypted) and, once the cloud server confirms, removes its own auto-start for good. The PC needs Tailscale on, logged in to the same account; `data\update.log` and `data\moved-to-cloud.txt` on the PC say what happened. If anything fails, the PC's server starts again and it retries 6 hours later.
5. In the phone app: *Settings → Server address → Change* → `https://budget.<tailnet>.ts.net`. Before you next re-link the bank, add `https://budget.<tailnet>.ts.net/bank/callback` as a redirect URL in the Enable Banking control panel.

Oracle may reclaim Always Free VMs that stay almost idle for 7 days; upgrading the account to *Pay As You Go* (Always Free resources stay free) avoids that. Setup log on the VM: `sudo cat /var/log/budget-setup.log`; handover log: `journalctl -u budget-planner-receive`.

**Google Cloud e2-micro (free tier):**
1. Create a project at [console.cloud.google.com](https://console.cloud.google.com) and add billing (a card is required). Under *Billing → Budgets & alerts*, add a 5 USD budget with e-mail alerts.
2. *Compute Engine → VM instances → Create instance*:
   - Region **us-central1** (Iowa), **us-west1** or **us-east1** — the free tier only covers these.
   - Machine type **e2-micro**.
   - Boot disk: **Debian**, disk type **Standard persistent disk**, **30 GB** (Balanced/SSD disks are billed).
   - Leave networking as it is (the VM needs its ephemeral external IP to reach your bank and GitHub; don't tick HTTP/HTTPS traffic). Google bills in-use external IPv4 addresses (about 3.6 USD/month at the time of writing), so check your billing report after the first days.
3. On the laptop, stop the server first (`windows\uninstall-autostart.bat`) so the data doesn't change after you copy it.
4. Click **SSH** next to the VM. In that window use **Upload file** to upload `data\budget.json`, `enablebanking.pem` and `.env` from the laptop.
5. Run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/nasteapaul/SDA/claude/budget-planner-bank-sync-03ykf8/budget-planner/deploy/setup-linux.sh | sudo bash
   ```
   Open the Tailscale link it prints and log in with the same account as your phone.
6. In the phone app: *Settings → Server address → Change* → the `https://budget.<tailnet>.ts.net` address it shows. In the Enable Banking control panel, add `https://budget.<tailnet>.ts.net/bank/callback` as a redirect URL (needed when you re-link the bank).

Logs: `journalctl -u budget-planner -f`. Update log: `journalctl -u budget-planner-update`. Your data is in `/opt/budget/SDA/budget-planner/data` (daily backups in `data/backups`); also keep a copy elsewhere now and then (*Settings → Export all data*).

---

## Ask Claude about your budget (read-only)

`mcp.js` is a small [MCP](https://modelcontextprotocol.io) server, so your own Claude can read the budget and give advice ("can I afford 1,500 RON for a phone?", "where can I save?"). It uses your Claude plan: no API key, nothing to pay. It is **read-only**: it can't change anything, and it never shares IBANs, tokens, bank session ids or the trash (accounts appear as their last 4 digits). Tools: overview, transactions, spending by category, pay-period history, bills and subscriptions, goals and budgets, net worth (and payday odds). Prompts: *monthly_review*, *can_i_afford*, *find_savings*.

It reads `data/budget.json` on the computer it runs on, so use it where the server runs (e.g. the laptop).

**Claude Desktop:** *Settings → Developer → Edit Config* opens `claude_desktop_config.json` (on Windows `%APPDATA%\Claude\claude_desktop_config.json`). Add:

```json
{
  "mcpServers": {
    "budget": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\SDA\\budget-planner\\mcp.js"]
    }
  }
}
```

Restart Claude Desktop, then ask about your budget, or pick a prompt from the **+** menu → *budget*.

**Claude Code:**

```bash
claude mcp add -s user budget -- node C:\Users\<you>\SDA\budget-planner\mcp.js   # or ~/SDA/budget-planner/mcp.js
```

**Phone / claude.ai (optional, off by default):** claude.ai and the Claude phone app reach MCP servers from Anthropic's cloud, so they need a public HTTPS address. The server answers on `/mcp` only with a separate read-only key (never your password):

1. `node mcp.js --new-key` prints the key (shown once; a new one replaces the old one).
2. Turn on Tailscale Funnel for the HTTPS address: `tailscale funnel --bg 8080` (a cloud server set up with `deploy/setup-linux.sh` does this by itself while a key exists). claude.ai only reaches port 443. Requests from the internet carry Tailscale's `Tailscale-Funnel-Request` header, and the server answers them only on `/mcp`: the app itself stays private.
3. In claude.ai: *Settings → Connectors → Add custom connector*, URL `https://<machine>.<tailnet>.ts.net/mcp/<key>`. It then works on the phone app too.

Trade-off: this puts a read-only door to your budget on the internet. Anyone who has that URL can read your figures, and what Claude reads goes through Anthropic like any chat. Keep the URL private. To turn it off: `node mcp.js --revoke-key` and `tailscale funnel --https=443 off`, then `tailscale serve --bg 8080`.

---

## Security

- Set `APP_PASSWORD`. Without it, the server only listens on `localhost`, so your phone can't reach it.
- On the network the server only runs over HTTPS (see above).
- Each login gets its own token. It expires after `SESSION_DAYS` (default 30) and **Sign out** revokes it on the server. To sign out every device, stop the server and delete `data/.sessions.json`.
- Logins are rate-limited (10 tries per 15 minutes).
- Requests from other websites are blocked (Origin and Content-Type checks). Without a password, only `localhost` is accepted as the Host, which blocks DNS-rebinding attacks.
- Don't forward the port on your router to the internet. If you want access from outside, use Tailscale.
- Bank data goes only between your server, Enable Banking and your bank. Transactions in other currencies are converted to RON with the National Bank of Romania's daily rate (fetched from bnr.ro).
- `data/`, `.env`, `*.pem`, CSV statements and `Extrases/` are git-ignored. Keep the Enable Banking key (`.pem`) outside any folder you share.
- **Back up** `data/budget.json`, or use Settings → Export.

## Development

```bash
npm test        # unit + HTTP tests: categoriser, planner, CSV parser, bank sync, validation, auth
npm run dev     # restart on file changes
```

```
server.js                 HTTP server, REST API, live updates (SSE), scheduler
lib/store.js              JSON file store with atomic writes and rollback on errors
lib/auth.js               login sessions (expiring, revocable tokens), live-update tickets, rate limit
lib/validate.js           input validation for the API
lib/migrations.js         one-time fixes for data from earlier versions
lib/fx.js                 BNR exchange rates for non-RON transactions
lib/enablebanking.js      Enable Banking client (RS256 JWT, accounts, balances, transactions)
lib/sync.js               bank → transaction mapping, categorisation, de-duplication
lib/mcp.js, lib/mcpkey.js read-only MCP server for Claude (tools, prompts, HTTP transport) and its key
mcp.js                    the MCP server over stdio (Claude Desktop / Claude Code)
public/                   the app (no build step)
  js/app.js               views, forms, routing
  js/data.js              offline cache, change queue, live sync
  js/charts.js            category bars + trend chart
  js/shared/*.js          money/date helpers, categories & rules, planner, CSV parser
                          (shared by browser and server, and unit-tested)
```

Set `EB_API_URL` to point the bank client at a mock server for testing.
