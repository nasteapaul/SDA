#!/usr/bin/env node
// Multi-day trend following across markets (Donchian channel breakout, the classic "turtle"
// rules with fixed, textbook parameters, so nothing is fitted to this data). For one market:
// buy a close above the highest high of the last `entry` days, sell a close below the lowest
// low; initial stop 2 ATR(20); exit on a close beyond the opposite `exit`-day channel.
// Costs: IG spread + half a spread of slippage on stops + overnight funding on the position's
// value for every calendar night held.
//
//   node bin/trend-research.js <MARKET_KEY> <financial-data/pyfinancialdata/data> [--split 2013]
// Prints one JSON object; results are in R (multiples of the risk taken per trade).
import { parseArgs } from 'node:util';
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { marketByKey } from '../lib/markets.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { split: { type: 'string', default: '2013' }, funding: { type: 'string' } },
});
const [key, root] = positionals;
const m = marketByKey(key);
if (!m || !root) {
  console.error('Usage: node bin/trend-research.js <MARKET_KEY> <data folder> [--split 2013]');
  process.exit(1);
}
const split = Number(values.split);
const isFx = /\//.test(m.name);
// Yearly funding as a fraction of the position's value: IG charges about 2.5% over the
// benchmark rate on index and commodity bets, much less on FX.
const funding = Number(values.funding ?? (isFx ? 0.01 : 0.03));

// Daily candles: open = first bar of the local day, close = last bar before the session close.
const daily = [];
for (const d of groupDays(loadMarketBars(m, root), m.tz)) {
  const inDay = d.bars.filter((b) => b.mod < m.close);
  if (inDay.length < 30) continue;
  daily.push({
    day: d.day,
    t: Date.parse(d.day),
    open: inDay[0].open,
    high: Math.max(...inDay.map((b) => b.high)),
    low: Math.min(...inDay.map((b) => b.low)),
    close: inDay.at(-1).close,
  });
}

function atr(i, n = 20) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const p = daily[k - 1].close;
    s += Math.max(daily[k].high - daily[k].low, Math.abs(daily[k].high - p), Math.abs(daily[k].low - p));
  }
  return s / n;
}

function donchian(entryN, exitN) {
  const trades = [];
  let pos = null;
  const closeAt = (i, price, why, slip = 0) => {
    const nights = Math.max(0, Math.round((daily[i].t - pos.t) / 864e5));
    const fund = pos.entry * funding * nights / 365;
    const points = (price - pos.entry) * pos.dir - m.spread - slip - fund;
    trades.push({ year: +daily[i].day.slice(0, 4), day: pos.day, dir: pos.dir, nights, why, r: points / pos.risk });
    pos = null;
  };
  for (let i = Math.max(entryN, 21); i < daily.length - 1; i++) {
    const c = daily[i];
    if (pos) {
      const hit = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop;
      if (hit) {
        closeAt(i, pos.dir > 0 ? Math.min(c.open, pos.stop) : Math.max(c.open, pos.stop), 'stop', m.spread / 2);
      } else {
        const lo = Math.min(...daily.slice(i - exitN, i).map((x) => x.low));
        const hi = Math.max(...daily.slice(i - exitN, i).map((x) => x.high));
        if ((pos.dir > 0 && c.close < lo) || (pos.dir < 0 && c.close > hi)) closeAt(i + 1, daily[i + 1].open, 'channel');
      }
      if (pos) continue;
    }
    const hi = Math.max(...daily.slice(i - entryN, i).map((x) => x.high));
    const lo = Math.min(...daily.slice(i - entryN, i).map((x) => x.low));
    const dir = c.close > hi ? 1 : c.close < lo ? -1 : 0;
    if (!dir) continue;
    const n = daily[i + 1];
    const risk = 2 * atr(i);
    pos = { dir, entry: n.open, t: n.t, day: n.day, risk, stop: n.open - dir * risk };
    i++; // entered at the next day's open; its own bar is checked from the next loop
    const hit = dir > 0 ? n.low <= pos.stop : n.high >= pos.stop;
    if (hit) closeAt(i, pos.stop, 'stop', m.spread / 2);
  }
  return trades;
}

const st = (tr) => {
  const n = tr.length;
  if (!n) return { n: 0, avgR: 0, t: 0, winRate: 0, totalR: 0 };
  const avg = tr.reduce((a, t) => a + t.r, 0) / n;
  const sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - avg) ** 2, 0) / Math.max(1, n - 1));
  return { n, avgR: avg, t: sd ? (avg / sd) * Math.sqrt(n) : 0, winRate: (tr.filter((t) => t.r > 0).length / n) * 100, totalR: avg * n };
};

const out = [];
for (const [entryN, exitN] of [[20, 10], [55, 20], [100, 50]]) {
  const tr = donchian(entryN, exitN);
  const byYear = {};
  for (const t of tr) byYear[t.year] = +((byYear[t.year] ?? 0) + t.r).toFixed(1);
  out.push({
    entryN, exitN,
    is: st(tr.filter((t) => t.year < split)),
    oos: st(tr.filter((t) => t.year >= split)),
    avgNights: tr.reduce((a, t) => a + t.nights, 0) / (tr.length || 1),
    byYear,
    trades: tr.map((t) => [t.day, t.dir, +t.r.toFixed(3)]),
  });
}
console.log(JSON.stringify({ key: m.key, name: m.name, first: daily[0]?.day, last: daily.at(-1)?.day, funding, results: out }));
