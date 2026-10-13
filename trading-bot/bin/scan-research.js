#!/usr/bin/env node
// Multi-market opening-range research. For one market it tests a small grid of opening
// range breakout (and fade) variants at the market's own session open, with IG-like costs.
// The variant is picked on the in-sample years only; the out-of-sample years are reported
// untouched, so a market is kept only if its edge also shows up on data it never saw.
//
//   node bin/scan-research.js <MARKET_KEY> <financial-data/pyfinancialdata/data> [--split 2017] [--from 2013]
// Prints one JSON object. Results are in R (multiples of the risk taken per trade).
import { parseArgs } from 'node:util';
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { runDays, stats } from '../lib/daytrade.js';
import { orb } from '../lib/strategies.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { split: { type: 'string', default: '2017' }, from: { type: 'string', default: '2013' } },
});
const [key, root] = positionals;
const m = marketByKey(key);
if (!m || !root) {
  console.error('Usage: node bin/scan-research.js <MARKET_KEY> <data folder> [--split 2017] [--from 2013]');
  process.exit(1);
}
const split = Number(values.split);
const from = Number(values.from);

// The opposite trade of a breakout: sell the break of the high, buy the break of the low,
// stop one range width away, target `targetR` (1 if unset).
function fade(opts) {
  const base = orb(opts);
  return (day, days, d) => base(day, days, d).map((s) => {
    const entry = day.bars[s.entryIdx].open;
    const risk = Math.abs(entry - s.stop);
    const dir = -s.dir;
    return { ...s, dir, stop: entry - dir * risk, target: entry + dir * risk * (opts.targetR ?? 1) };
  });
}

// Intraday momentum (Gao et al. 2018): the move from yesterday's close to `open + early`
// minutes predicts the direction of the last `lastMin` minutes before the close. Stop at
// `stopFrac` of the early session's range.
function momentum({ early = 30, lastMin = 30, stopFrac = 0.5, open, close, minRange }) {
  return (day, days, d) => {
    const prev = days[d - 1]?.bars.filter((b) => b.mod < close);
    if (!prev?.length) return [];
    const bars = day.bars;
    const firstSession = bars.findIndex((b) => b.mod >= open);
    const i = bars.findIndex((b) => b.mod >= open + early);
    const entryIdx = bars.findIndex((b) => b.mod >= close - lastMin);
    if (firstSession < 0 || i <= firstSession || entryIdx < 0 || bars[entryIdx].mod >= close) return [];
    const early_ = bars.slice(firstSession, i);
    const range = Math.max(...early_.map((b) => b.high)) - Math.min(...early_.map((b) => b.low));
    if (!(range * stopFrac >= minRange)) return [];
    const move = bars[i - 1].close - prev.at(-1).close;
    if (!move) return [];
    const dir = Math.sign(move);
    return [{ dir, entryIdx, stop: bars[entryIdx].open - dir * range * stopFrac, target: null, exitMod: close }];
  };
}

const variants = [];
for (const early of [30, 60]) for (const lastMin of [30, 60]) variants.push({ kind: 'momentum', early, lastMin });
for (const rangeMin of [5, 15, 30, 60]) {
  for (const targetR of [null, 1, 2]) {
    for (const trend of [false, true]) variants.push({ kind: 'breakout', rangeMin, targetR, trend });
  }
  for (const targetR of [1, 2]) variants.push({ kind: 'fade', rangeMin, targetR, trend: false });
}

const days = groupDays(loadMarketBars(m, root, from), m.tz).filter((d) => d.bars.length > 60);
const costs = costsFor(m);
const IS = days.filter((d) => +d.day.slice(0, 4) < split);
const OOS = days.filter((d) => +d.day.slice(0, 4) >= split);
const rStats = (trades) => {
  const s = stats(trades.map((t) => ({ ...t, points: t.r })));
  return { n: s.n, avgR: s.avg, t: s.t, winRate: s.winRate, pf: s.pf, maxDD: s.maxDD };
};
const byYear = (trades) => {
  const y = {};
  for (const t of trades) y[t.year] = (y[t.year] ?? 0) + t.r;
  return Object.fromEntries(Object.entries(y).map(([k, v]) => [k, +v.toFixed(1)]));
};

const results = variants.map((v) => {
  const opts = {
    rangeMin: v.rangeMin, targetR: v.targetR, trend: v.trend,
    open: m.open, close: m.close, exit: m.close, lastEntry: m.open + 180,
    minRange: m.spread * 4, maxRange: Infinity,
  };
  const strat = v.kind === 'fade' ? fade(opts)
    : v.kind === 'momentum' ? momentum({ early: v.early, lastMin: v.lastMin, open: m.open, close: m.close, minRange: m.spread * 4 })
      : orb(opts);
  const is = runDays(IS, strat, costs);
  const oos = runDays(OOS, strat, costs);
  return { ...v, is: rStats(is), oos: rStats(oos), years: byYear([...is, ...oos]) };
});

const eligible = results.filter((r) => r.is.n >= 100);
const best = eligible.sort((a, b) => b.is.t - a.is.t)[0] ?? null;
console.log(JSON.stringify({
  key: m.key,
  name: m.name,
  days: days.length,
  first: days[0]?.day,
  last: days.at(-1)?.day,
  split,
  best,
  oosPositiveShare: results.filter((r) => r.oos.avgR > 0).length / results.length,
  all: results,
}));
