#!/usr/bin/env node
// Multi-market opening range breakout on the IG DEMO account (markets with `live` settings
// in lib/markets.js). Runs while a session still has an entry window in the next hours,
// then exits; open positions keep their stop and target at IG and are closed by the first
// run after their session ends.
// Usage: node --env-file=.env bin/multibot.js
import { fileURLToPath } from 'node:url';
import { IgClient } from '../lib/ig.js';
import { MultiBot } from '../lib/multibot.js';
import { StateStore } from '../lib/state.js';
import { liveMarkets } from '../lib/markets.js';
import { telegramNotifier } from '../lib/notify.js';

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
// IG_ACCOUNT_ID may list several accounts of the same login ("default" = its preferred one).
// They must share one process: switching account in one run logs the other run's session out.
const accountIds = [...new Set((env.IG_ACCOUNT_ID ?? '').split(',').map((s) => s.trim()).map((s) => (s === 'default' ? '' : s)))];
const several = accountIds.length > 1;
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, label: `Bot multi-piață demo${!several && accountIds[0] ? ` ${accountIds[0]}` : ''}` });
const pendingNotes = [];
const log = (m) => {
  console.log(`${new Date().toISOString()} ${m}`);
  if (notify) pendingNotes.push(notify(m));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keys = env.BOT_MARKETS ? env.BOT_MARKETS.split(',').map((s) => s.trim()) : null;
const markets = liveMarkets().filter((m) => !keys || keys.includes(m.key));
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
// One state file per account: each has its own day start equity and trades.
const statePath = env.BOT_STATE ?? fileURLToPath(new URL('../data/multi-state.json', import.meta.url));
const runs = accountIds.map((id) => ({
  id,
  bot: new MultiBot({
    client,
    markets,
    riskPerTrade: num('BOT_RISK_PER_TRADE', 50),
    maxDailyLoss: num('BOT_MAX_DAILY_LOSS', 150),
    // Percentages of the account win over the fixed amounts when set.
    riskPct: num('BOT_RISK_PCT', undefined),
    maxDailyLossPct: num('BOT_MAX_DAILY_LOSS_PCT', undefined),
    state: new StateStore(id ? statePath.replace(/\.json$/, `-${id}.json`) : statePath),
    log: several ? (m) => log(`[${id || 'cont implicit'}] ${m}`) : log,
  }),
}));

// Each poll makes 2 requests plus 1 per market in its entry window, plus an account switch
// when several accounts share the run; IG allows about 60 per minute.
const pollMs = Math.max(5000, num('BOT_POLL_MS', 10000 * runs.length));
const deadline = Date.now() + num('BOT_MAX_MINUTES', 340) * 60e3;
let stopping = false;
let fatal = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log('Oprire. Pozițiile deschise rămân în cont cu stop-ul lor.'); });
}

function backoff(e, failures) {
  if (e.fatal) {
    log(`Eroare de autentificare (${e.code}). Mă opresc ca să nu-ți blochez contul.`);
    fatal = true;
    stopping = true;
    return 0;
  }
  if (e.status === 403 && /allowance/i.test(e.code ?? '')) return 15 * 60e3;
  return Math.min(5 * 60e3, 5000 * 2 ** (failures - 1));
}

for (const run of runs) {
  let failures = 0;
  while (!stopping && Date.now() < deadline) {
    try {
      await client.use(run.id);
      await run.bot.start();
      run.started = true;
      break;
    } catch (e) {
      failures++;
      const wait = backoff(e, failures);
      run.bot.log(`Nu pot porni: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
      await sleep(wait);
    }
  }
}

const active = runs.filter((r) => r.started);
let first = true;
let failures = 0;
while (!stopping && (first || active.some((r) => r.bot.hasWork()))) {
  if (Date.now() >= deadline) {
    log('Program încheiat (limita de timp a rulării). Pozițiile deschise rămân cu stop și țintă la IG.');
    break;
  }
  let wait = pollMs;
  for (const run of active) {
    if (stopping || (!first && !run.bot.hasWork())) continue;
    try {
      await client.use(run.id);
      await run.bot.tick();
      failures = 0;
    } catch (e) {
      failures++;
      wait = Math.max(wait, backoff(e, failures));
      run.bot.log(`Eroare: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
    }
  }
  first = false;
  if (!stopping && active.some((r) => r.bot.hasWork())) await sleep(wait);
}
console.log(`${new Date().toISOString()} Nimic de făcut în următoarele ore; ies.`);

await Promise.all(pendingNotes);
if (fatal) process.exitCode = 1;
