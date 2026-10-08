#!/usr/bin/env node
// Runs the strategy live on the IG DEMO account and places orders with a stop.
// Usage: node --env-file=.env bin/bot.js
import { fileURLToPath } from 'node:url';
import { IgClient } from '../lib/ig.js';
import { Bot } from '../lib/bot.js';
import { StateStore } from '../lib/state.js';
import { orbLive } from '../lib/strategies.js';
import { berlinClock, hhmm } from '../lib/session.js';
import { telegramNotifier } from '../lib/notify.js';

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
const pendingNotes = [];
const log = (m) => {
  console.log(`${new Date().toISOString()} ${m}`);
  if (notify) pendingNotes.push(notify(m));
};
// BOT_EXIT_AT=HH:MM (Frankfurt) ends the run cleanly, e.g. when a scheduled cloud job
// has to finish. Open positions keep their stop and target at IG.
const exitAt = env.BOT_EXIT_AT ? hhmm(env.BOT_EXIT_AT) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// orb: opening range breakout, 1 trade/day (the least bad in the 2011-2018 research).
// ema: the original EMA 9/21 cross, kept for comparison; it lost money in the research.
const strategy = env.BOT_STRATEGY ?? 'orb';
const presets = {
  orb: {
    resolution: 'MINUTE',
    maxTradesPerDay: 1,
    tradeUntil: '12:00', // orbLive takes no entries after noon either
    signal: orbLive({ rangeMin: num('ORB_RANGE_MIN', 15), targetR: num('ORB_TARGET_R', 2), stopFrac: num('ORB_STOP_FRAC', 1) }),
  },
  ema: {
    resolution: 'MINUTE_5',
    maxTradesPerDay: num('BOT_MAX_TRADES', 6),
    strategy: { fast: num('BOT_FAST', 9), slow: num('BOT_SLOW', 21) },
  },
};
if (!presets[strategy]) throw new Error(`BOT_STRATEGY must be one of: ${Object.keys(presets).join(', ')}`);

const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
const bot = new Bot({
  client,
  epic: env.BOT_EPIC ?? 'IX.D.DAX.IFMM.IP',
  ...presets[strategy],
  ...(env.BOT_RESOLUTION ? { resolution: env.BOT_RESOLUTION } : {}),
  size: num('BOT_SIZE', 1),
  maxDailyLoss: num('BOT_MAX_DAILY_LOSS', 100),
  state: new StateStore(env.BOT_STATE ?? fileURLToPath(new URL('../data/state.json', import.meta.url))),
  log,
});

// Each poll makes 2 non-trading requests; IG allows about 60 per minute.
const pollMs = Math.max(5000, num('BOT_POLL_MS', 5000));
let stopping = false;
let fatal = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log('Oprire. Pozițiile deschise rămân în cont cu stop-ul lor.'); });
}

// Wait time after an error: stop for good on bad credentials, back off on everything else.
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
while (!stopping) {
  try {
    await bot.start();
    log(`Strategie: ${strategy}.`);
    failures = 0;
    break;
  } catch (e) {
    failures++;
    const wait = backoff(e, failures);
    log(`Nu pot porni: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
    await sleep(wait);
  }
}

while (!stopping) {
  if (exitAt != null && berlinClock(Date.now()).mod >= exitAt) {
    log(`Program încheiat (${env.BOT_EXIT_AT} ora Frankfurt). Pozițiile deschise rămân cu stop și țintă la IG.`);
    break;
  }
  let wait = pollMs;
  try {
    await bot.tick();
    failures = 0;
  } catch (e) {
    failures++;
    wait = Math.max(pollMs, backoff(e, failures));
    log(`Eroare: ${e.message}. Reîncerc în ${Math.round(wait / 1000)} s.`);
  }
  await sleep(wait);
}

await Promise.all(pendingNotes);
if (fatal) process.exitCode = 1;
