#!/usr/bin/env node
// Telegram trade reports from the IG DEMO account: every evening (after 17:00 Romania time)
// the day's closed trades and the day's total, and on Friday a summary of the week.
// Sent once a day (REPORT_STATE remembers it); REPORT_FORCE=1 sends both now.
// Usage: node --env-file=.env bin/report.js
import { IgClient } from '../lib/ig.js';
import { StateStore, tradingDay } from '../lib/state.js';
import { localClock } from '../lib/session.js';
import { TZ, closedTrades, dailyReport, weeklyReport, isFriday } from '../lib/report.js';
import { sendTelegram } from '../lib/notify.js';

const env = process.env;
const now = Date.now();
const force = env.REPORT_FORCE === '1';
const state = new StateStore(env.REPORT_STATE || null);
const sent = state.load();
const today = tradingDay(now, TZ);
const { mod } = localClock(now, TZ);
const weekday = !['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now));

if (!force && (!weekday || mod < 17 * 60 || sent.daily === today)) {
  console.log('Raport: nu e momentul (se trimite o dată, seara după ora 17 în zilele lucrătoare).');
  process.exit(0);
}

try {
  const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
  const session = await client.login();
  const ccy = session.currencyIsoCode ?? 'EUR';
  const trades = closedTrades(await client.transactions(now - 8 * 86400e3, now + 3600e3));
  const messages = [dailyReport(trades, now, ccy)];
  if (force || isFriday(now)) messages.push(weeklyReport(trades, now, ccy));
  for (const text of messages) {
    console.log(text);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  }
  state.save({ ...sent, daily: today });
} catch (e) {
  // A failed report must never fail the trading run.
  console.log(`Raport: eroare ${e.message}`);
}
