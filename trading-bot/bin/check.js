#!/usr/bin/env node
// Checks the IG demo connection without trading: logs in, shows the account, finds the
// market and prints its dealing rules.
//   node --env-file=.env bin/check.js ["Germany 40"]
import { IgClient } from '../lib/ig.js';

const env = process.env;
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
try {
  const session = await client.login();
  console.log(`✓ Conectat la IG DEMO, cont ${session.currentAccountId} (${session.currencyIsoCode ?? '?'}).`);
  console.log(`✓ Sold + profit deschis: ${await client.equity()}`);
  const term = process.argv[2] ?? 'Germany 40';
  console.log(`\nPiețe găsite pentru "${term}":`);
  for (const m of (await client.searchMarkets(term)).slice(0, 10)) {
    console.log(`  ${m.epic.padEnd(22)} ${m.name} (${m.type}, ${m.expiry}, ${m.status})`);
  }
  const epic = env.BOT_EPIC ?? 'IX.D.DAX.IFMM.IP';
  const m = await client.market(epic);
  console.log(`\nPiața din .env, ${epic}:`);
  console.log(`  preț ${m.bid} / ${m.offer} (spread ${(m.offer - m.bid).toFixed(1)}), stare ${m.status}, monedă ${m.currency}`);
  console.log(`  mărime minimă ${m.minSize}, stop minim ${m.minStop} ${m.minStopUnit}`);
  const open = await client.openPositions(epic);
  console.log(`  poziții deschise: ${open.length}`);
  console.log('\nTotul e în regulă. Poți porni bot-ul.');
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (e.fatal) console.error('  Verifică IG_USERNAME și IG_PASSWORD: trebuie să fie cele ale contului DEMO.');
  else if (/api-key/i.test(e.code ?? '')) console.error('  Cheia API e greșită sau nu e activată pentru contul demo.');
  process.exit(1);
}
