#!/usr/bin/env node
// Daily trend bot on Bitcoin and Ether (lib/trendbot.js), IG DEMO CFD account only.
// Run once a day, after the UTC day has closed.
// Usage: node --env-file=.env bin/trendbot.js
import { fileURLToPath } from 'node:url';
import { IgClient } from '../lib/ig.js';
import { TrendBot } from '../lib/trendbot.js';
import { StateStore } from '../lib/state.js';
import { TREND_MARKETS } from '../lib/markets.js';
import { telegramNotifier } from '../lib/notify.js';

const env = process.env;
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, label: `Bot trend cripto demo${env.IG_ACCOUNT_ID ? ` ${env.IG_ACCOUNT_ID}` : ''}` });
const pending = [];
const log = (m) => {
  console.log(`${new Date().toISOString()} ${m}`);
  if (notify) pending.push(notify(m));
};

const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
const bot = new TrendBot({
  client,
  markets: TREND_MARKETS,
  riskPct: Number(env.BOT_RISK_PCT ?? 1),
  state: new StateStore(env.BOT_STATE ?? fileURLToPath(new URL('../data/trend-state.json', import.meta.url))),
  log,
});
try {
  await bot.run();
  console.log(`${new Date().toISOString()} Gata pe azi.`);
} catch (e) {
  log(`Nu pot porni: ${e.message}`);
  process.exitCode = 1;
}
await Promise.all(pending);
