#!/usr/bin/env node
// Closes every open position on BOT_EPIC (IG DEMO). Used by the evening cloud job so
// nothing is held overnight; safe to run by hand too.
//   node --env-file=.env bin/flatten.js
import { IgClient } from '../lib/ig.js';
import { telegramNotifier } from '../lib/notify.js';

const env = process.env;
const epic = env.BOT_EPIC ?? 'IX.D.DAX.IFMM.IP';
const notify = telegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });

await client.login();
const open = await client.openPositions(epic);
for (const p of open) {
  await client.closePosition(p);
  const msg = `Închis ${p.direction} ${p.size} (sfârșitul zilei).`;
  console.log(msg);
  await notify?.(msg);
}
if (!open.length) console.log('Nicio poziție deschisă.');
