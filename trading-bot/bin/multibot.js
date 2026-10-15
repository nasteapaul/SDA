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
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, label: 'Bot multi-piață demo' });
const pendingNotes = [];
const log = (m) => {
  console.log(`${new Date().toISOString()} ${m}`);
  if (notify) pendingNotes.push(notify(m));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keys = env.BOT_MARKETS ? env.BOT_MARKETS.split(',').map((s) => s.trim()) : null;
const markets = liveMarkets().filter((m) => !keys || keys.includes(m.key));
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
const bot = new MultiBot({
  client,
  markets,
  riskPerTrade: num('BOT_RISK_PER_TRADE', 50),
  maxDailyLoss: num('BOT_MAX_DAILY_LOSS', 150),
  // Percentages of the account win over the fixed amounts when set.
  riskPct: num('BOT_RISK_PCT', undefined),
  maxDailyLossPct: num('BOT_MAX_DAILY_LOSS_PCT', undefined),
  state: new StateStore(env.BOT_STATE ?? fileURLToPath(new URL('../data/multi-state.json', import.meta.url))),
  log,
});

// Each poll makes 2 requests plus 1 per market in its entry window; IG allows about 60 per minute.
const pollMs = Math.max(5000, num('BOT_POLL_MS', 10000));
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

let failures = 0;
while (!stopping && Date.now() < deadline) {
  try {
    await bot.start();
    failures = 0;
    break;
  } catch (e) {
    failures++;
    const wait = backoff(e, failures);
    log(`Nu pot porni: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
    await sleep(wait);
  }
}

let first = true;
while (!stopping && (first || bot.hasWork())) {
  if (Date.now() >= deadline) {
    log('Program încheiat (limita de timp a rulării). Pozițiile deschise rămân cu stop și țintă la IG.');
    break;
  }
  let wait = pollMs;
  try {
    await bot.tick();
    first = false;
    failures = 0;
  } catch (e) {
    failures++;
    wait = Math.max(pollMs, backoff(e, failures));
    log(`Eroare: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
  }
  if (!stopping && bot.hasWork()) await sleep(wait);
}
console.log(`${new Date().toISOString()} Nimic de făcut în următoarele ore; ies.`);

await Promise.all(pendingNotes);
if (fatal) process.exitCode = 1;
