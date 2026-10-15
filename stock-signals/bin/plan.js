#!/usr/bin/env node
// Sends the buy / target / stop-loss levels for one stock to Telegram, on request.
//   PLAN_SYMBOL   Yahoo symbol, e.g. SRTA (US) or SAP.DE
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID; DRY_RUN=1 prints instead
import { chart, summarize } from '../lib/market.js';
import { send, esc, formatPlan } from '../lib/telegram.js';

const env = process.env;
const symbol = (env.PLAN_SYMBOL ?? '').trim().toUpperCase();
if (!/^[A-Z0-9.\-^=]{1,20}$/.test(symbol)) throw new Error('Set PLAN_SYMBOL to a Yahoo symbol, e.g. SRTA');
const html = `📋 <b>Plan pentru ${esc(symbol)}</b>\n\n${formatPlan(summarize(await chart(symbol)))}\n\n<i>Doar informație, nu sfat de investiții.</i>`;
if (env.DRY_RUN === '1') console.log(html);
else await send({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, html);
console.log(`Trimis planul pentru ${symbol}.`);
