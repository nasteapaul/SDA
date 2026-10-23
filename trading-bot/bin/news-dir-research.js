#!/usr/bin/env node
// Would knowing the pre-open "news" direction help? Reuters' "shares set to open lower" headlines
// come from the overnight move (futures / the market trading before the open). Here: price just
// before the open vs the previous session's close. The live ORB (re-entry until 3 losses) then
// trades only breakouts in that direction ("with"), only against it ("against"), or both (now).
// A variant also requires the pre-open move to be larger than 0.25 × the average daily range.
//   node bin/news-dir-research.js <MARKET_KEY> <pyfinancialdata/data> [HistData pair] [from year]
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { spreadAt } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const [key, root, pair, fromYear] = process.argv.slice(2);
const m = pair ? { ...marketByKey(key), history: `histdata/${pair}` } : marketByKey(key);
const FROM = pair ? +(fromYear ?? 2015) : 2005;
const PERIODS = pair ? [[String(FROM), '2020'], ['2020', '2023'], ['2023', '2100']] : [['2005', '2013'], ['2013', '2021']];
const costs = costsFor(m);
const { rangeMin, targetR } = m.live;
const days = groupDays(loadMarketBars(m, root, FROM), m.tz).filter((d) => d.bars.length > 60);

// Pre-open move and its size relative to the average range of the previous 20 sessions.
const info = days.map((d, k) => {
  if (!k) return null;
  const prev = days[k - 1].bars.filter((b) => b.mod < m.close).at(-1);
  const pre = d.bars.filter((b) => b.mod < m.open).at(-1);
  if (!prev || !pre) return null;
  const ranges = days.slice(Math.max(0, k - 20), k).map((x) => {
    const s = x.bars.filter((b) => b.mod >= m.open && b.mod < m.close);
    return s.length ? Math.max(...s.map((b) => b.high)) - Math.min(...s.map((b) => b.low)) : 0;
  }).filter(Boolean);
  const avg = ranges.reduce((a, b) => a + b, 0) / (ranges.length || 1);
  const move = pre.close - prev.close;
  return { dir: Math.sign(move), strong: Math.abs(move) > 0.25 * avg };
});

function dayR(k, mode, strongOnly) {
  const bars = days[k].bars, inf = info[k];
  if (mode !== 'all' && (!inf || (strongOnly && !inf.strong))) return mode === 'all' ? null : 0;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  if (!(hi - lo >= m.spread * 4)) return null;
  let total = 0, losses = 0, armed = true, n = 0;
  for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    let dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (dir < 0 && m.live.longOnly && !process.env.BOTH) dir = 0; // as live (US Tech 100 buys only)
    if (dir && mode === 'with' && dir !== inf.dir) dir = 0;
    if (dir && mode === 'against' && dir !== -inf.dir) dir = 0;
    if (!dir) continue;
    const entry = bars[i + 1].open, stop = dir > 0 ? lo : hi, risk = (entry - stop) * dir;
    if (!(risk > 0)) continue;
    const target = targetR ? entry + dir * risk * targetR : null;
    let exit = bars.at(-1).close, why = 'end', j = i + 1;
    for (; j < bars.length; j++) {
      const b = bars[j];
      if (j > i + 1 && b.mod >= m.close) { exit = b.open; why = 'time'; break; }
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage; why = 'stop'; break; }
      if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); why = 'target'; break; }
    }
    const r = ((exit - entry) * dir - spreadAt(bars[i + 1].mod, costs)) / risk;
    total += r; n++;
    if (r <= 0) losses++;
    if (losses >= 3 || why === 'time' || why === 'end') break;
    i = j;
    armed = false;
  }
  return total;
}

function line(label, mode, strongOnly) {
  const part = ([a, b]) => {
    let eq = 0, peak = 0, dd = 0;
    days.forEach((d, k) => {
      if (d.day < a || d.day >= b) return;
      const r = dayR(k, mode, strongOnly);
      if (r == null) return;
      eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    });
    return `${a}–${b === '2100' ? 'azi' : +b - 1}: ${eq >= 0 ? '+' : ''}${eq.toFixed(0).padStart(4)}R (DD ${dd.toFixed(0)}R)`;
  };
  console.log(`${label.padEnd(44)} ${PERIODS.map(part).join(' | ')}`);
}

console.log(`\n=== ${m.name}: direcția mișcării dinainte de deschidere ===`);
line('Acum (ca botul)', 'all');
line('Doar în direcția mișcării de peste noapte', 'with', false);
line('Doar contra mișcării de peste noapte', 'against', false);
line('Doar în direcție, mișcare mare', 'with', true);
line('Doar contra, mișcare mare', 'against', true);
