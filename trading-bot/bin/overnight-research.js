#!/usr/bin/env node
// What if the live ORB (re-entry until 3 losses) kept the trade still open at the session close
// overnight, for N more trading days, with the same stop? Overnight funding is charged per
// calendar night (FX ~1%/yr, indices ~3%/yr of the price, IG's admin fee plus a typical rate gap).
// Variants: hold every open trade, or only one already in profit at the close.
//
//   node bin/overnight-research.js <MARKET_KEY> <pyfinancialdata/data> [HistData pair] [from year]
// Same data options as bin/exit-research.js.
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { spreadAt } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const [key, root, pair, fromYear] = process.argv.slice(2);
const m = pair ? { ...marketByKey(key), history: `histdata/${pair}` } : marketByKey(key);
const FROM = pair ? +(fromYear ?? 2015) : 2005;
const PERIODS = pair ? [[String(FROM), '2020'], ['2020', '2023'], ['2023', '2100']] : [['2005', '2013'], ['2013', '2021']];
if (!m?.live || !root) {
  console.error('Usage: node bin/overnight-research.js <MARKET_KEY> <data folder>');
  process.exit(1);
}
const costs = costsFor(m);
const FUNDING = (m.key === 'AU200' ? 0.03 : 0.01) / 365;
const { rangeMin, targetR } = m.live;
const days = groupDays(loadMarketBars(m, root, FROM), m.tz).filter((d) => d.bars.length > 60);
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Carries a trade open at the close of days[k] through the next `hold` days (stop and target
// still active, gaps filled at the open), then closes it at the last bar.
function carry(k, hold, { dir, entry, stop, target, risk }) {
  let exit = null, last = days[k].day;
  for (let n = 1; n <= hold && k + n < days.length && exit == null; n++) {
    const d = days[k + n];
    last = d.day;
    for (const b of d.bars) {
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage; break; }
      if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); break; }
    }
    if (exit == null && n === hold) exit = d.bars.at(-1).close;
  }
  exit ??= days[k].bars.at(-1).close;
  const funding = nights(days[k].day, last) * FUNDING * entry;
  return ((exit - entry) * dir - spreadAt(m.open + rangeMin, costs) - funding) / risk;
}

function dayR(k, hold, onlyWinners) {
  const bars = days[k].bars;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  if (!(hi - lo >= m.spread * 4)) return null;
  let total = 0, losses = 0, armed = true;
  for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    const dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (!dir) continue;
    const entry = bars[i + 1].open, stop = dir > 0 ? lo : hi, risk = (entry - stop) * dir;
    if (!(risk > 0)) continue;
    const target = targetR ? entry + dir * risk * targetR : null;
    let exit = null, why = 'time', j = i + 1;
    for (; j < bars.length; j++) {
      const b = bars[j];
      if (j > i + 1 && b.mod >= m.close) { exit = b.open; break; }
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage; why = 'stop'; break; }
      if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); why = 'target'; break; }
    }
    if (exit == null) exit = bars.at(-1).close;
    const r = ((exit - entry) * dir - spreadAt(bars[i + 1].mod, costs)) / risk;
    if (why === 'time') {
      if (hold && (!onlyWinners || r > 0)) return total + carry(k, hold, { dir, entry, stop, target, risk });
      return total + r;
    }
    total += r;
    i = j;
    if (r <= 0) losses++;
    if (losses >= 3) break;
    armed = false;
  }
  return total;
}

function line(label, hold, onlyWinners) {
  const part = (a, b) => {
    let eq = 0, peak = 0, dd = 0;
    days.forEach((d, k) => {
      if (d.day < a || d.day >= b) return;
      const r = dayR(k, hold, onlyWinners);
      if (r == null) return;
      eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    });
    return `${eq >= 0 ? '+' : ''}${eq.toFixed(0).padStart(4)}R (DD ${dd.toFixed(0)}R)`;
  };
  console.log(`${label.padEnd(36)} ${PERIODS.map(([a, b]) => `${a}–${b === '2100' ? 'azi' : +b - 1}: ${part(a, b)}`).join(' | ')}`);
}

console.log(`\n=== ${m.name}: poziția rămasă deschisă la închidere, ținută peste noapte ===`);
line('Acum: închide la finalul sesiunii', 0);
for (const hold of [1, 2, 5]) {
  line(`Ține ${hold} zile în plus, toate`, hold, false);
  line(`Ține ${hold} zile în plus, doar pe profit`, hold, true);
}
