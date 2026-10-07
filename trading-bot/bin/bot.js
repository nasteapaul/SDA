#!/usr/bin/env node
// Runs the strategy live on the IG DEMO account and places orders with a stop.
// Usage: node --env-file=.env bin/bot.js
import { IgClient } from '../lib/ig.js';
import { Bot } from '../lib/bot.js';

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));

const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
const bot = new Bot({
  client,
  epic: env.BOT_EPIC ?? 'IX.D.DAX.IFMM.IP',
  resolution: env.BOT_RESOLUTION ?? 'MINUTE_5',
  size: num('BOT_SIZE', 1),
  maxDailyLoss: num('BOT_MAX_DAILY_LOSS', 100),
  strategy: { fast: num('BOT_FAST', 9), slow: num('BOT_SLOW', 21) },
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
});

const pollMs = Math.max(2000, num('BOT_POLL_MS', 5000)); // IG allows ~60 non-trading requests/min
await bot.start();
let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('Oprire. Pozițiile deschise rămân în cont cu stop-ul lor.'); });
while (!stopping) {
  try { await bot.tick(); } catch (e) { console.error(`Eroare: ${e.message}`); }
  await new Promise((r) => setTimeout(r, pollMs));
}
