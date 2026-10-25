#!/usr/bin/env node
// Checks the IG demo connection without trading: logs in, shows the account, finds the
// markets and prints their dealing rules.
//   node --env-file=.env bin/check.js ["Germany 40" "EUR/USD" ...]
import { IgClient } from '../lib/ig.js';

const env = process.env;
// No Telegram test when only looking up markets.
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && !env.CHECK_EPICS && !env.CHECK_TERMS) {
  // Shows which Telegram bot the trading messages go to (bot name only, never the token).
  try {
    const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
    const me = await (await fetch(`${api}/getMe`, { signal: AbortSignal.timeout(10000) })).json();
    const text = '🤖 Test bot de trading: mesajele de trading vin pe acest bot.';
    const sent = await (await fetch(`${api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10000),
    })).json();
    console.log(`Telegram: @${me.result?.username ?? '?'} (secret ${env.TELEGRAM_SOURCE ?? '?'}), mesaj de test ${sent.ok ? 'trimis' : `refuzat: ${sent.description}`}`);
  } catch (e) {
    console.log(`Telegram: ${e.message}`);
  }
}
const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD, accountId: env.IG_ACCOUNT_ID });
if (env.IG_ACCOUNT_ID) {
  // Diagnostics for switching accounts: what the login offers before any switch.
  const probe = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
  try {
    const d = await probe.login();
    console.log(`Login: cont curent ${d.currentAccountId}, conturi ${JSON.stringify((d.accounts ?? []).map((a) => [a.accountId, a.accountType, a.preferred]))}`);
  } catch (e) {
    console.log(`Login de probă: ${e.message}`);
  }
}
try {
  const session = await client.login();
  console.log(`✓ Conectat la IG DEMO, cont ${session.currentAccountId} (${session.currencyIsoCode ?? '?'}).`);
  console.log(`✓ Sold + profit deschis: ${await client.equity()}`);
  for (const a of await client.accounts()) {
    console.log(`  cont ${a.id}: ${a.name}, ${a.type}, ${a.currency}, sold ${a.balance?.balance}, disponibil ${a.balance?.available}`);
  }
  const terms = env.CHECK_TERMS ? env.CHECK_TERMS.split(',').map((x) => x.trim()).filter(Boolean)
    : env.CHECK_EPICS ? [] : process.argv.length > 2 ? process.argv.slice(2) : ['Germany 40', 'EUR/USD', 'GBP/USD', 'Australia 200'];
  for (const term of terms) {
    console.log(`\nPiețe găsite pentru "${term}":`);
    for (const m of (await client.searchMarkets(term)).slice(0, 10)) {
      console.log(`  ${m.epic.padEnd(22)} ${m.name} (${m.type}, ${m.expiry}, ${m.status})`);
      if (m.expiry !== 'DFB' && m.expiry !== '-') continue;
      const { data } = await client.request('GET', `/markets/${encodeURIComponent(m.epic)}`, { version: 3 });
      const s = data.snapshot ?? {};
      const r = data.dealingRules ?? {};
      const i = data.instrument ?? {};
      console.log(`    preț ${s.bid}/${s.offer}, scalare ${s.scalingFactor}, zecimale ${s.decimalPlacesFactor}, mărime minimă ${r.minDealSize?.value}, stop minim ${r.minNormalStopOrLimitDistance?.value} ${r.minNormalStopOrLimitDistance?.unit}, ore ${JSON.stringify(i.openingHours?.marketTimes ?? null)}`);
      console.log(`    contract ${i.contractSize}, lot ${i.lotSize}, valoare pip ${i.valueOfOnePip}, pip = ${i.onePipMeans}, marjă ${i.marginFactor} ${i.marginFactorUnit}, monede ${JSON.stringify((i.currencies ?? []).map((c) => c.code))}`);
    }
  }
  // Exact epics (comma separated): raw instrument data, without the market search.
  for (const e of (env.CHECK_EPICS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const data = await client.request('GET', `/markets/${encodeURIComponent(e)}`, { version: 3 }).then((r) => r.data, (err) => {
      console.log(`\n${e}: ${err.message}`);
      return null;
    });
    if (!data) continue;
    const i = data.instrument ?? {};
    console.log(`\n${e}: ${i.name}, tip ${i.type}, expiry ${i.expiry}, preț ${data.snapshot?.bid}/${data.snapshot?.offer}, scalare ${data.snapshot?.scalingFactor}`);
    console.log(`  contract ${i.contractSize}, lot ${i.lotSize}, valoare pip ${i.valueOfOnePip}, pip = ${i.onePipMeans}, marjă ${i.marginFactor} ${i.marginFactorUnit}`);
    console.log(`  monede ${JSON.stringify(i.currencies)}`);
    console.log(`  reguli ${JSON.stringify(data.dealingRules)}`);
    if (env.CHECK_CANDLES) {
      // The last daily candles, to see where IG starts its day (counts against the data allowance).
      for (const c of await client.candles(e, 'DAY', 3)) console.log(`  zi ${new Date(c.time).toISOString()} o ${c.open} h ${c.high} l ${c.low} c ${c.close}`);
    }
  }
  if (env.CHECK_EPICS || env.CHECK_TERMS) process.exit(0);
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
