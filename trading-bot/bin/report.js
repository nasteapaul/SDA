#!/usr/bin/env node
// Telegram trade reports from the IG DEMO account: every evening (after 22:00 Romania time, the US Tech 100 close run)
// the day's closed trades and the day's total, and on Friday a summary of the week.
// Sent once a day (REPORT_STATE remembers it); REPORT_FORCE=1 sends the daily one now.
// Usage: node --env-file=.env bin/report.js
import { IgClient } from '../lib/ig.js';
import { StateStore, tradingDay } from '../lib/state.js';
import { localClock } from '../lib/session.js';
import { TZ, closedTrades, dailyReport, weeklyReport, isFriday } from '../lib/report.js';
import { sendTelegram } from '../lib/notify.js';
import { liveMarkets } from '../lib/markets.js';

const env = process.env;
const now = Date.now();
const force = env.REPORT_FORCE === '1';
const state = new StateStore(env.REPORT_STATE || null);
const sent = state.load();
const today = tradingDay(now, TZ);
const { mod } = localClock(now, TZ);
const weekday = !['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now));

if (!force && (!weekday || mod < 22 * 60 || sent.daily === today)) {
  console.log('Raport: nu e momentul (se trimite o dată, seara după ora 22 în zilele lucrătoare).');
  process.exit(0);
}

// Right after the trading run, IG can reject the account switch of a fresh login (401
// account-token-invalid) for a few seconds, so log in again after a pause.
async function login(attempts = 4) {
  for (let i = 1; ; i++) {
    const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
    try {
      return { client, session: await client.login() };
    } catch (e) {
      if (i >= attempts || e.fatal || e.status !== 401) throw e;
      console.log(`Raport: login respins (${e.message}), reîncerc.`);
      await new Promise((r) => setTimeout(r, 15000 * i));
    }
  }
}

try {
  const { client, session } = await login();
  const ccy = (await client.accounts()).find((a) => a.id === client.accountId)?.currency ?? session.currencyIsoCode ?? '';
  // Only the bot's markets: the account may also hold trades made by hand.
  const markets = liveMarkets().map((m) => m.name);
  const trades = closedTrades(await client.transactions(now - 8 * 86400e3, now + 3600e3), markets);
  // On a weekend, a forced report covers the last weekday.
  let at = now;
  while (['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(at))) at -= 86400e3;
  const messages = [dailyReport(trades, at, ccy)];
  if (isFriday(at)) messages.push(weeklyReport(trades, at, ccy));
  for (const text of messages) {
    console.log(text);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  }
  state.save({ ...sent, daily: today });
} catch (e) {
  // A failed report must never fail the trading run.
  console.log(`Raport: eroare ${e.message}`);
}
