#!/usr/bin/env node
// Runs the strategy live on the IG DEMO account and places orders with a stop.
// Usage: node --env-file=.env bin/bot.js
import { fileURLToPath } from 'node:url';
import { IgClient } from '../lib/ig.js';
import { Bot } from '../lib/bot.js';
import { StateStore } from '../lib/state.js';

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
const bot = new Bot({
  client,
  epic: env.BOT_EPIC ?? 'IX.D.DAX.IFMM.IP',
  resolution: env.BOT_RESOLUTION ?? 'MINUTE_5',
  size: num('BOT_SIZE', 1),
  maxDailyLoss: num('BOT_MAX_DAILY_LOSS', 100),
  strategy: { fast: num('BOT_FAST', 9), slow: num('BOT_SLOW', 21) },
  state: new StateStore(fileURLToPath(new URL('../data/state.json', import.meta.url))),
  log,
});

// Each poll makes 2 non-trading requests; IG allows about 60 per minute.
const pollMs = Math.max(5000, num('BOT_POLL_MS', 5000));
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log('Oprire. Pozițiile deschise rămân în cont cu stop-ul lor.'); });
}

// Wait time after an error: stop for good on bad credentials, back off on everything else.
function backoff(e, failures) {
  if (e.fatal) {
    log(`Eroare de autentificare (${e.code}). Mă opresc ca să nu-ți blochez contul.`);
    process.exit(1);
  }
  if (e.status === 403 && /allowance/i.test(e.code ?? '')) return 15 * 60e3;
  return Math.min(5 * 60e3, 5000 * 2 ** (failures - 1));
}

let failures = 0;
while (!stopping) {
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

while (!stopping) {
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
