#!/usr/bin/env node
// Every closed trade on one IG DEMO account since PNL_SINCE (default 2026-10-01) and the
// totals: the bot's markets and everything else apart. Prints to the log only, no Telegram.
// Usage: node --env-file=.env bin/pnl.js
import { IgClient } from '../lib/ig.js';
import { TZ, closedTrades } from '../lib/report.js';
import { tradingDay } from '../lib/state.js';
import { botMarketNames } from '../lib/markets.js';

const env = process.env;
const since = Date.parse(`${env.PNL_SINCE || '2026-10-01'}T00:00:00Z`);
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
const session = await client.login();
const account = (await client.accounts()).find((a) => a.id === client.accountId);
const ccy = account?.currency ?? session.currencyIsoCode ?? '';
const all = closedTrades(await client.transactions(since, Date.now() + 3600e3));
const bot = botMarketNames();
const isBot = (t) => bot.some((m) => t.name.startsWith(m));
const sum = (ts) => ts.reduce((s, t) => s + t.pnl, 0).toFixed(2);
console.log(`Cont ${client.accountId} (${ccy}), sold ${JSON.stringify(account?.balance ?? {})}`);
for (const t of all) console.log(`${tradingDay(t.time, TZ)} ${isBot(t) ? 'BOT ' : 'MAN '} ${t.name}: ${t.pnl.toFixed(2)}`);
const b = all.filter(isBot), m = all.filter((t) => !isBot(t));
console.log(`TOTAL bot: ${b.length} tranzacții, ${b.filter((t) => t.pnl > 0).length} câștigătoare, ${sum(b)} ${ccy}`);
console.log(`TOTAL manual: ${m.length} tranzacții, ${sum(m)} ${ccy}`);
