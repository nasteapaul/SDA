#!/usr/bin/env node
// Daily Bitcoin/Ether trend on paper (lib/papertrend.js): no IG login, no orders.
// Run once a day, after the UTC day has closed. Entries and exits go to Telegram.
// Usage: node --env-file=.env bin/papertrend.js
import { fileURLToPath } from 'node:url';
import { PaperTrendBot } from '../lib/papertrend.js';
import { StateStore } from '../lib/state.js';
import { telegramNotifier } from '../lib/notify.js';

const env = process.env;
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, label: 'Trend cripto pe hârtie' });
const pending = [];
const log = (m) => {
  console.log(`${new Date().toISOString()} ${m}`);
  if (notify) pending.push(notify(m));
};

const bot = new PaperTrendBot({
  state: new StateStore(env.BOT_STATE ?? fileURLToPath(new URL('../data/trend-paper.json', import.meta.url))),
  log,
  // Paul agreed to the trend on 24 Oct 2026: signals count from that day.
  startDay: env.PAPER_START ?? '2026-10-24',
});
await bot.run();
console.log(`${new Date().toISOString()} Gata pe azi.`);
await Promise.all(pending);
