#!/usr/bin/env node
// Prints the raw IG history of one DEMO account since REPLAY_SINCE (default 2026-10-12):
// closed deals (/history/transactions) and order activity with stop levels (/history/activity),
// one JSON line each, for replaying the demo on another account size. Log only, no Telegram.
// Usage: node --env-file=.env bin/replay.js
import { IgClient } from '../lib/ig.js';

const env = process.env;
const since = Date.parse(`${env.REPLAY_SINCE || '2026-10-12'}T00:00:00Z`);
const fmt = (t) => new Date(t).toISOString().slice(0, 19);
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
await client.login();
console.log(`CONT ${client.accountId}`);
for (const t of await client.transactions(since, Date.now() + 3600e3)) console.log(`TX ${JSON.stringify(t)}`);
let path = `/history/activity?${new URLSearchParams({ from: fmt(since), to: fmt(Date.now() + 3600e3), detailed: 'true', pageSize: '500' })}`;
for (let page = 0; path && page < 20; page++) {
  const { data } = await client.request('GET', path, { version: 3 });
  for (const a of data.activities ?? []) console.log(`ACT ${JSON.stringify(a)}`);
  path = data.metadata?.paging?.next ?? null;
}
