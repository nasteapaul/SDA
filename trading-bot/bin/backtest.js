#!/usr/bin/env node
// Backtests the EMA/RSI strategy.
//   node bin/backtest.js data/dax-5m.csv [--spread 1.2] [--risk 1] [--capital 10000] [--fast 9 --slow 21]
//   node --env-file=.env bin/backtest.js --ig IX.D.DAX.IFMM.IP --resolution MINUTE_5 --max 1000
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCsv } from '../lib/candles.js';
import { emaCrossSignals } from '../lib/strategy.js';
import { backtest } from '../lib/backtest.js';
import { IgClient } from '../lib/ig.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ig: { type: 'string' },
    resolution: { type: 'string', default: 'MINUTE_5' },
    max: { type: 'string', default: '1000' },
    spread: { type: 'string', default: '1.2' }, // DAX in session; never test without costs
    risk: { type: 'string', default: '1' },
    capital: { type: 'string', default: '10000' },
    fast: { type: 'string', default: '9' },
    slow: { type: 'string', default: '21' },
  },
});

let candles;
if (values.ig) {
  const env = process.env;
  const client = new IgClient({ apiKey: env.IG_API_KEY, identifier: env.IG_USERNAME, password: env.IG_PASSWORD });
  await client.login();
  candles = await client.candles(values.ig, values.resolution, Number(values.max));
} else if (positionals[0]) {
  candles = parseCsv(await readFile(positionals[0], 'utf8'));
} else {
  console.error('Dă un fișier CSV (time,open,high,low,close) sau --ig <EPIC>.');
  process.exit(1);
}

const signals = emaCrossSignals(candles, { fast: Number(values.fast), slow: Number(values.slow) });
const r = backtest(candles, signals, {
  capital: Number(values.capital),
  riskPct: Number(values.risk),
  spread: Number(values.spread),
});

const f = (n) => n.toFixed(2);
console.log(`Lumânări:        ${candles.length}`);
console.log(`Tranzacții:      ${r.count}`);
console.log(`Câștigătoare:    ${f(r.winRate)}%`);
console.log(`Profit factor:   ${Number.isFinite(r.profitFactor) ? f(r.profitFactor) : '∞'}  (peste 1,3 e interesant)`);
console.log(`Rezultat net:    ${f(r.net)} (${f(r.returnPct)}%)`);
console.log(`Scădere maximă:  ${f(r.maxDrawdownPct)}%`);
