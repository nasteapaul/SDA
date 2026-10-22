#!/usr/bin/env node
// Does a bot that re-tunes itself beat the fixed live rules? Each month it picks, from 36
// variants of the live ORB (range 15/30/60 min × target none/1.5/2/3R × stop after 1/2/3
// losses), the one with the best result over the previous W months (past data only), and
// trades it that month. Compared with the fixed live settings on the same months, IG costs included.
//
//   node bin/wf-research.js <MARKET_KEY> <pyfinancialdata/data> [HistData pair] [from year]
// Same data options as bin/exit-research.js.
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { spreadAt } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const [key, root, pair, fromYear] = process.argv.slice(2);
const m = pair ? { ...marketByKey(key), history: `histdata/${pair}` } : marketByKey(key);
const FROM = pair ? +(fromYear ?? 2015) : 2005;
const PERIODS = pair ? [[String(FROM + 3), '2020'], ['2020', '2023'], ['2023', '2100']] : [['2008', '2013'], ['2013', '2021']];
if (!m?.live || !root) {
  console.error('Usage: node bin/wf-research.js <MARKET_KEY> <data folder>');
  process.exit(1);
}
const costs = costsFor(m);

// One trade; same fills as bin/exit-research.js.
function sim(bars, { dir, entryIdx, stop, target }) {
  const entry = bars[entryIdx].open;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return null;
  let exit = bars.at(-1).close, exitIdx = bars.length - 1, why = 'end of data';
  for (let j = entryIdx; j < bars.length; j++) {
    const b = bars[j];
    if (j > entryIdx && b.mod >= m.close) { exit = b.open; exitIdx = j; why = 'time'; break; }
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage;
      exitIdx = j; why = 'stop'; break;
    }
    if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) {
      exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target);
      exitIdx = j; why = 'target'; break;
    }
  }
  return { exitIdx, why, r: ((exit - entry) * dir - spreadAt(bars[entryIdx].mod, costs)) / risk };
}

function dayR(dd, { rangeMin, targetR, maxLosses }) {
  const bars = dd.bars;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  if (!(hi - lo >= m.spread * 4)) return null;
  let total = 0, losses = 0, armed = true;
  for (; i < bars.length - 1 && bars[i].mod < Math.min(m.open + 180, m.close); i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    const dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (!dir) continue;
    const entry = bars[i + 1].open;
    const stop = dir > 0 ? lo : hi;
    const target = targetR ? entry + dir * (entry - stop) * dir * targetR : null;
    const t = sim(bars, { dir, entryIdx: i + 1, stop, target });
    if (!t) continue;
    total += t.r;
    i = t.exitIdx;
    if (t.r <= 0) losses++;
    if (losses >= maxLosses || t.why === 'time' || t.why === 'end of data') break;
    armed = false;
  }
  return total;
}

const VARIANTS = [];
for (const rangeMin of [15, 30, 60]) for (const targetR of [null, 1.5, 2, 3]) for (const maxLosses of [1, 2, 3]) VARIANTS.push({ rangeMin, targetR, maxLosses });
const live = VARIANTS.findIndex((v) => v.rangeMin === m.live.rangeMin && v.targetR === m.live.targetR && v.maxLosses === 3);
const label = (v) => `${v.rangeMin}m/${v.targetR ? v.targetR + 'R' : 'fără țintă'}/${v.maxLosses}p`;

const days = groupDays(loadMarketBars(m, root, FROM), m.tz).filter((d) => d.bars.length > 60);
// R per month per variant.
const months = [], monthIdx = {};
for (const d of days) {
  const mo = d.day.slice(0, 7);
  if (!(mo in monthIdx)) { monthIdx[mo] = months.length; months.push({ mo, r: VARIANTS.map(() => 0) }); }
  VARIANTS.forEach((v, k) => { const r = dayR(d, v); if (r != null) months[monthIdx[mo]].r[k] += r; });
}

// Walk-forward: month i trades the variant with the best sum over months i-W..i-1.
function walk(W) {
  return months.map((x, i) => {
    if (i < W) return null;
    let best = live, bestR = -Infinity;
    VARIANTS.forEach((_, k) => { const s = months.slice(i - W, i).reduce((a, p) => a + p.r[k], 0); if (s > bestR) { bestR = s; best = k; } });
    return { mo: x.mo, k: best, r: x.r[best] };
  });
}
const fixed = months.map((x) => ({ mo: x.mo, k: live, r: x.r[live] }));

function stats(seq, a, b) {
  const s = seq.filter((x) => x && x.mo >= a && x.mo < b);
  let eq = 0, peak = 0, dd = 0, changes = 0;
  s.forEach((x, i) => { eq += x.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (i && x.k !== s[i - 1].k) changes++; });
  return { txt: `${eq >= 0 ? '+' : ''}${eq.toFixed(0).padStart(4)}R (DD ${dd.toFixed(0)}R)`, changes, n: s.length };
}
const line = (name, seq) => console.log(`${name.padEnd(30)} ${PERIODS.map(([a, b]) => `${a}–${b === '2100' ? 'azi' : +b - 1}: ${stats(seq, a, b).txt}`).join(' | ')}`);

console.log(`\n=== ${m.name}: reglaj automat lunar vs reguli fixe (${label(VARIANTS[live])}) ===`);
line('Fix (botul de acum)', fixed);
for (const W of [6, 12, 24, 36]) {
  const seq = walk(W);
  line(`Se reglează singur, ${W} luni`, seq);
  const used = {};
  for (const x of seq) if (x) used[x.k] = (used[x.k] ?? 0) + 1;
  const top = Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${label(VARIANTS[k])} ${n} luni`).join(', ');
  const ch = PERIODS.reduce((s, [a, b]) => s + stats(seq, a, b).changes, 0);
  console.log(`  schimbări de setări: ${ch}; cele mai folosite: ${top}`);
}
