#!/usr/bin/env node
// Every closed deal of one IG DEMO account since REPLAY_SINCE (default 2026-10-12), joined
// with its opening order (/history/activity) to get the stop distance: one compact JSON line
// per trade, for replaying the demo on another account size. Log only, no Telegram.
// Usage: node --env-file=.env bin/replay.js
import { IgClient } from '../lib/ig.js';
import { parsePnl } from '../lib/report.js';

const env = process.env;
const since = Date.parse(`${env.REPLAY_SINCE || '2026-10-12'}T00:00:00Z`);
const fmt = (t) => new Date(t).toISOString().slice(0, 19);
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
await client.login();
const acts = [];
let path = `/history/activity?${new URLSearchParams({ from: fmt(since), to: fmt(Date.now() + 3600e3), detailed: 'true', pageSize: '500' })}`;
for (let page = 0; path && page < 20; page++) {
  const { data } = await client.request('GET', path, { version: 3 });
  acts.push(...(data.activities ?? []));
  path = data.metadata?.paging?.next ?? null;
}
const byDeal = new Map(acts.map((a) => [a.dealId, a]));
console.log(`CONT ${client.accountId}, ${acts.length} activități`);
for (const t of (await client.transactions(since, Date.now() + 3600e3)).reverse()) {
  if (t.transactionType !== 'DEAL') continue;
  const close = byDeal.get(t.reference);
  const openId = close?.details?.actions?.find((x) => x.actionType === 'POSITION_CLOSED' || x.actionType === 'POSITION_PARTIALLY_CLOSED')?.affectedDealId;
  const open = byDeal.get(openId);
  console.log(`T ${JSON.stringify({
    name: t.instrumentName, epic: open?.epic ?? close?.epic, open: t.openDateUtc, close: t.dateUtc, size: t.size, openLevel: t.openLevel, closeLevel: t.closeLevel,
    pnl: parsePnl(t.profitAndLoss), stopDist: open?.details?.stopDistance ?? null, bot: /^bot-/.test(open?.details?.dealReference ?? ''), by: close?.channel ?? null,
  })}`);
}
