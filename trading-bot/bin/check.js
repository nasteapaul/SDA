#!/usr/bin/env node
// Checks the IG demo connection without trading: logs in, shows the account, finds the
// markets and prints their dealing rules.
//   node --env-file=.env bin/check.js ["Germany 40" "EUR/USD" ...]
import { IgClient } from '../lib/ig.js';

const env = process.env;
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
try {
  const session = await client.login();
  console.log(`✓ Conectat la IG DEMO, cont ${session.currentAccountId} (${session.currencyIsoCode ?? '?'}).`);
  console.log(`✓ Sold + profit deschis: ${await client.equity()}`);
  const terms = process.argv.length > 2 ? process.argv.slice(2) : ['Germany 40', 'EUR/USD', 'GBP/USD', 'Australia 200'];
  for (const term of terms) {
    console.log(`\nPiețe găsite pentru "${term}":`);
    for (const m of (await client.searchMarkets(term)).slice(0, 10)) {
      console.log(`  ${m.epic.padEnd(22)} ${m.name} (${m.type}, ${m.expiry}, ${m.status})`);
      if (m.expiry !== 'DFB') continue;
      const { data } = await client.request('GET', `/markets/${encodeURIComponent(m.epic)}`, { version: 3 });
      const s = data.snapshot ?? {};
      const r = data.dealingRules ?? {};
      console.log(`    preț ${s.bid}/${s.offer}, scalare ${s.scalingFactor}, zecimale ${s.decimalPlacesFactor}, mărime minimă ${r.minDealSize?.value}, stop minim ${r.minNormalStopOrLimitDistance?.value} ${r.minNormalStopOrLimitDistance?.unit}, ore ${JSON.stringify(data.instrument?.openingHours?.marketTimes ?? null)}`);
    }
  }
  const epic = env.BOT_EPIC ?? 'IX.D.DAX.DAILY.IP';
  const m = await client.market(epic);
  console.log(`\nPiața din .env, ${epic}:`);
  console.log(`  preț ${m.bid} / ${m.offer} (spread ${(m.offer - m.bid).toFixed(1)}), stare ${m.status}, monedă ${m.currency}`);
  console.log(`  mărime minimă ${m.minSize}, stop minim ${m.minStop} ${m.minStopUnit}`);
  const { data } = await client.request('GET', `/markets/${encodeURIComponent(epic)}`, { version: 3 });
  console.log(`  snapshot IG: ${JSON.stringify(data.snapshot)}`);
  const open = await client.openPositions(epic);
  console.log(`  poziții deschise: ${open.length}`);
  console.log('\nTotul e în regulă. Poți porni bot-ul.');
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (e.fatal) console.error('  Verifică IG_USERNAME și IG_PASSWORD: trebuie să fie cele ale contului DEMO.');
  else if (/api-key/i.test(e.code ?? '')) console.error('  Cheia API e greșită sau nu e activată pentru contul demo.');
  process.exit(1);
}
