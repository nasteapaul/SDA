#!/usr/bin/env node
// Which opening-range breakout works on US Tech 100 (Nasdaq 100, New York 09:30–16:00)?
// Grid: range 15/30/60 min × target none/2R × both directions or long only × stop for the day
// after 1 or 3 losses. A variant counts only if it is positive in every period.
//   node bin/tech-research.js <pyfinancialdata/data>               Oanda NAS100, 2005–2020
//   node bin/tech-research.js <histdata folder> NSXUSD             HistData, 2015–today
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';

const [root, pair] = process.argv.slice(2);
const m = { history: pair ? `histdata/${pair}` : 'oanda/NAS100_USD', tz: 'America/New_York', open: 570, close: 960, spread: 1.0 };
const PERIODS = pair ? [['2015', '2020'], ['2020', '2023'], ['2023', '2100']] : [['2005', '2013'], ['2013', '2020']];
const days = groupDays(loadMarketBars(m, root, pair ? 2015 : 2005), m.tz).filter((d) => d.bars.length > 60);

function dayR(bars, { rangeMin, targetR, longOnly, maxLosses }) {
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  if (!(hi - lo >= m.spread * 4)) return null;
  let total = 0, losses = 0, armed = true;
  for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    let dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (longOnly && dir < 0) dir = 0;
    if (!dir) continue;
    const entry = bars[i + 1].open, stop = dir > 0 ? lo : hi, risk = (entry - stop) * dir;
    if (!(risk > 0)) continue;
    const target = targetR ? entry + dir * risk * targetR : null;
    let exit = bars.at(-1).close, why = 'end', j = i + 1;
    for (; j < bars.length; j++) {
      const b = bars[j];
      if (j > i + 1 && b.mod >= m.close) { exit = b.open; why = 'time'; break; }
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * m.spread / 2; why = 'stop'; break; }
      if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); why = 'target'; break; }
    }
    const r = ((exit - entry) * dir - m.spread) / risk;
    total += r;
    if (r <= 0) losses++;
    if (losses >= maxLosses || why === 'time' || why === 'end') break;
    i = j;
    armed = false;
  }
  return total;
}

console.log(`\n=== US Tech 100 (${pair ? 'HistData' : 'Oanda'}) ===`);
for (const rangeMin of [15, 30, 60]) for (const targetR of [null, 2]) for (const longOnly of [false, true]) for (const maxLosses of [1, 3]) {
  const v = { rangeMin, targetR, longOnly, maxLosses };
  const parts = PERIODS.map(([a, b]) => {
    let eq = 0, peak = 0, dd = 0;
    for (const d of days) if (d.day >= a && d.day < b) { const r = dayR(d.bars, v); if (r != null) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); } }
    return { eq, dd };
  });
  const name = `${String(rangeMin).padStart(2)}m ${targetR ? '2R  ' : 'fără'} ${longOnly ? 'doar long' : 'ambele   '} ${maxLosses}p`;
  console.log(`${name}  ${parts.map((p, k) => `${PERIODS[k][0]}–${PERIODS[k][1] === '2100' ? 'azi' : +PERIODS[k][1] - 1}: ${p.eq >= 0 ? '+' : ''}${p.eq.toFixed(0).padStart(4)}R (DD ${p.dd.toFixed(0)})`).join(' | ')}${parts.every((p) => p.eq > 0) ? '  <-- pozitiv în toate' : ''}`);
}
// Benchmark: buy at the open, sell at the close, every day (R = move / 1% of price).
const bh = PERIODS.map(([a, b]) => days.filter((d) => d.day >= a && d.day < b).reduce((s, d) => {
  const o = d.bars.find((x) => x.mod >= m.open), c = d.bars.filter((x) => x.mod < m.close).at(-1);
  return o && c ? s + (c.close - o.open - m.spread) / (o.open * 0.01) : s;
}, 0));
console.log(`Cumpără la deschidere, vinde la închidere (în % din preț): ${bh.map((x, k) => `${PERIODS[k][0]}: ${x.toFixed(0)}%`).join(' | ')}`);
