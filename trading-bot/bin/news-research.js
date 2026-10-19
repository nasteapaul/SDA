#!/usr/bin/env node
// Does the live London ORB (re-entry until 3 losses, as the bot trades it) do better or worse
// on days with big scheduled news? Days are tagged from the WhatMovesMarkets event database
// (github.com/MarkKersen/WhatMovesMarkets, 2002–Aug 2020) and the R of each day is compared,
// for 2005–2012 and 2013–2020 separately.
//
//   node bin/news-research.js <MARKET_KEY> <pyfinancialdata/data> <WhatMovesMarkets_eventdatabase.csv>
import { readFileSync } from 'node:fs';
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { simulate } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const [key, root, eventsPath] = process.argv.slice(2);
const m = marketByKey(key);
if (!m?.live || !root || !eventsPath) {
  console.error('Usage: node bin/news-research.js <MARKET_KEY> <data folder> <events csv>');
  process.exit(1);
}
const costs = costsFor(m);
const { rangeMin, targetR } = m.live;

const GROUPS = {
  'Raport locuri de muncă SUA': ['US Employment Report'],
  'Inflație SUA (CPI)': ['US CPI and Earnings Data'],
  'Decizie dobândă ECB': ['ECB: Press Release'],
  'Decizie dobândă BoE': ['BoE: Press Release'],
  'Vânzări retail / PIB SUA': ['US Retail Sales', 'US GDP, GDP Price Index, PCE'],
};

// Day (YYYY-MM-DD, CET date) -> set of group names.
const tags = new Map();
const rows = readFileSync(eventsPath, 'utf8').split('\n').slice(1);
for (const line of rows) {
  const cols = line.match(/"([^"]*)"|[^,]+/g)?.map((c) => c.replace(/^"|"$/g, ''));
  if (!cols || cols.length < 11) continue;
  const name = cols[2].trim();
  const group = Object.entries(GROUPS).find(([, names]) => names.includes(name))?.[0];
  if (!group) continue;
  const [d, mo, y] = cols[9].slice(0, 10).split('.');
  const day = `${y}-${mo}-${d}`;
  if (!tags.has(day)) tags.set(day, new Set());
  tags.get(day).add(group);
}

// One day of the live strategy: first breakout of the opening range, then after each closed
// trade the next breakout once the price is back inside the range, until 3 losses.
function dayTrades(dd) {
  const bars = dd.bars;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  const width = hi - lo;
  if (!(width >= m.spread * 4)) return null;
  const out = [];
  let losses = 0, armed = true;
  for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    const dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (!dir) continue;
    const entry = bars[i + 1].open;
    const stop = dir > 0 ? lo : hi;
    const risk = (entry - stop) * dir;
    const t = simulate(bars, { dir, entryIdx: i + 1, stop, target: targetR ? entry + dir * risk * targetR : null, exitMod: m.close }, costs);
    if (!t) continue;
    out.push(t.r);
    i = t.exitIdx;
    if (t.r <= 0) losses++;
    if (losses >= 3 || t.why === 'time' || t.why === 'end of data') break;
    armed = false;
  }
  return out;
}

const days = groupDays(loadMarketBars(m, root, 2005), m.tz)
  .filter((d) => d.bars.length > 60 && d.day <= '2020-08-31')
  .map((d) => ({ day: d.day, r: dayTrades(d) }))
  .filter((d) => d.r)
  .map((d) => ({ ...d, total: d.r.reduce((s, x) => s + x, 0), tags: tags.get(d.day) ?? new Set() }));

function line(label, sel) {
  const part = (a, b) => {
    const ds = sel.filter((d) => d.day >= a && d.day < b);
    const sum = ds.reduce((s, d) => s + d.total, 0);
    return `${String(ds.length).padStart(4)} zile, ${sum >= 0 ? '+' : ''}${sum.toFixed(0)}R (${(sum / (ds.length || 1)).toFixed(3)} R/zi)`;
  };
  console.log(`${label.padEnd(30)} 2005–12: ${part('2005', '2013')} | 2013–20: ${part('2013', '2021')}`);
}

console.log(`\n=== ${m.name}: ORB cu reintrare, rezultat pe zi după știri (${days.length} zile) ===`);
line('Toate zilele', days);
line('Zile fără știri mari', days.filter((d) => !d.tags.size));
line('Zile cu știri mari', days.filter((d) => d.tags.size));
for (const g of Object.keys(GROUPS)) line(`  ${g}`, days.filter((d) => d.tags.has(g)));
