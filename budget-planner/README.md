# Budget Planner (RON)

A self-hosted budget app for your phone and laptop:

- **Income and expenses in RON**: add, edit and delete them, with a live "left to spend this month" balance
- **Category breakdown**: a chart of spending by category, monthly budgets, and income vs. spending over 6 months
- **Bank sync**: links your main bank account through PSD2 open banking (BT, BCR, BRD, ING, Raiffeisen, CEC, Revolut and others). New transactions come in automatically and are sorted into categories.
- **Multiple savings goals**: each has a target, a deadline (optional) and a priority. You record money added to or taken out of a goal.
- **Savings plan**: learns your spending habits from your history and builds a monthly plan to reach your goals. It covers how much to save, which flexible categories to trim, realistic dates, recurring payments and categories that are rising.
- **One app on phone and laptop**: it installs on the phone's home screen and runs in any browser on the laptop. Both devices update live.

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

The terminal prints two addresses:

```
  Budget planner running on http://localhost:8080
  On your Wi-Fi:  http://192.168.1.50:8080
```

- **Laptop:** open the first address, or the Wi-Fi address if the server runs on another machine.
- **Phone:** connect to the home Wi-Fi and open the Wi-Fi address. Then add it to your home screen so it opens like an app:
  - **iPhone (Safari):** Share → *Add to Home Screen*
  - **Android (Chrome):** ⋮ → *Add to Home screen* / *Install app*

> Tip: in your router, give the server a fixed IP (a "DHCP reservation") so the address never changes.

**Try it with demo data first:** `npm run demo` loads 4 months of realistic transactions and 3 goals into a separate `demo-data/` folder. Your real data is not touched.

### Keep it running

On a Raspberry Pi or any Linux box, edit the paths and user in `budget-planner.service`, then run:

```bash
sudo cp budget-planner.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now budget-planner
```

On Windows/macOS you can use `npx pm2 start server.js --name budget`, or just leave a terminal open.

---

## 2. Link your bank account

Bank sync uses **[Enable Banking](https://enablebanking.com)**, a licensed PSD2 provider. Individuals can link their **own** accounts with it for free. Check their current terms when you sign up.

1. Create an account at **enablebanking.com** and open the **Control Panel → Applications → Add application**.
2. Choose the **Production** environment and give it a name, e.g. "My budget".
3. Under **Redirect URLs**, add `http://<your-server-ip>:8080/bank/callback`. This must exactly match `PUBLIC_URL` + `/bank/callback` in your `.env`.
4. Let the panel **generate the private key**. Save the downloaded `.pem` file into the `budget-planner` folder as `enablebanking.pem`. Keep it secret.
5. Copy the **Application ID** into `.env`:
   ```ini
   EB_APP_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
   EB_PRIVATE_KEY_PATH=./enablebanking.pem
   PUBLIC_URL=http://192.168.1.50:8080
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

## 4. Offline mode & HTTPS (optional)

Browsers only allow full offline support (opening the app with no connection to the server) over **HTTPS**. Over plain `http://192.168.x.x`:

- the app still works normally at home and can be added to the home screen;
- data is cached on the phone, and edits queue up if the connection drops;
- but opening the app from scratch away from home needs the server.

There are two ways to get HTTPS:

- **[Tailscale](https://tailscale.com)** (easiest, and it also lets you use the app away from home): install it on the server and your phone, run `tailscale serve --bg 8080` on the server, and use the `https://<machine>.<tailnet>.ts.net` address. Set `PUBLIC_URL` to it.
- **[mkcert](https://github.com/FiloSottile/mkcert)**: create a certificate for your server's IP, install mkcert's root CA on your phone, and set `TLS_CERT` / `TLS_KEY` in `.env`.

---

## Security

- Set `APP_PASSWORD`. Without it, the server only listens on `localhost`, so your phone can't reach it.
- Logins are rate-limited (10 tries per 15 minutes).
- Don't forward the port on your router to the internet. If you want access from outside, use Tailscale.
- Bank data goes only between your server, Enable Banking and your bank. `data/` and `.env` are git-ignored.
- **Back up** `data/budget.json`, or use Settings → Export.

## Development

```bash
npm test        # unit tests: categoriser, planner, CSV parser, bank mapping
npm run dev     # restart on file changes
```

```
server.js                 HTTP server, REST API, auth, live updates (SSE), scheduler
lib/store.js              JSON file store with atomic writes
lib/enablebanking.js      Enable Banking client (RS256 JWT, accounts, balances, transactions)
lib/sync.js               bank → transaction mapping, categorisation, de-duplication
public/                   the app (no build step)
  js/app.js               views, forms, routing
  js/data.js              offline cache, change queue, live sync
  js/charts.js            category bars + trend chart
  js/shared/*.js          money/date helpers, categories & rules, planner, CSV parser
                          (shared by browser and server, and unit-tested)
```

Set `EB_API_URL` to point the bank client at a mock server for testing.
