#!/usr/bin/env node
// When should the live London ORB (re-entry until 3 losses) take its profit? Compares the
// current exit (stop or session close) with (a) an earlier fixed close time and (b) a
// trailing stop that starts once the trade is `start` R in profit and then follows the best
// price at `gap` R, (c) a target where the day's move (from its low for a long, its high for
// a short) reaches `k` times the average daily range of the previous 20 days. 2005–2012 and 2013–2020 separately, IG costs included.
//
//   node bin/exit-research.js <MARKET_KEY> <pyfinancialdata/data> [HistData pair] [from year]
// With a HistData pair (e.g. EURUSD, AUXAUD; see bin/histdata-download.js) the market's
// history comes from that folder instead, and the periods are <from>–2022 and 2023–now.
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { spreadAt } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const [key, root, pair, fromYear] = process.argv.slice(2);
const m = pair ? { ...marketByKey(key), history: `histdata/${pair}` } : marketByKey(key);
const FROM = pair ? +(fromYear ?? 2020) : 2005;
const PERIODS = pair ? [[String(FROM), '2023'], ['2023', '2100']] : [['2005', '2013'], ['2013', '2021']];
if (!m?.live || !root) {
  console.error('Usage: node bin/exit-research.js <MARKET_KEY> <data folder>');
  process.exit(1);
}
const costs = costsFor(m);
const { rangeMin, targetR } = m.live;

// One trade with an optional trailing stop; same fills as lib/daytrade.js simulate().
function sim(bars, { dir, entryIdx, stop, target, exitMod, trail }) {
  const entry = bars[entryIdx].open;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return null;
  let best = entry, cur = stop, exit = bars.at(-1).close, exitIdx = bars.length - 1, why = 'end of data';
  for (let j = entryIdx; j < bars.length; j++) {
    const b = bars[j];
    if (j > entryIdx && b.mod >= exitMod) { exit = b.open; exitIdx = j; why = 'time'; break; }
    if (dir > 0 ? b.low <= cur : b.high >= cur) {
      exit = (dir > 0 ? Math.min(b.open, cur) : Math.max(b.open, cur)) - dir * costs.slippage;
      exitIdx = j; why = 'stop'; break;
    }
    if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) {
      exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target);
      exitIdx = j; why = 'target'; break;
    }
    // The stop moves after the bar closes, so the bar that made the new best can't hit it.
    best = dir > 0 ? Math.max(best, b.high) : Math.min(best, b.low);
    if (trail && (best - entry) * dir >= trail.start * risk) {
      const s = best - dir * trail.gap * risk;
      cur = dir > 0 ? Math.max(cur, s) : Math.min(cur, s);
    }
  }
  return { exitIdx, why, r: ((exit - entry) * dir - spreadAt(bars[entryIdx].mod, costs)) / risk };
}

function dayR(dd, exitMod, trail, adrK) {
  const bars = dd.bars;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return null;
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  if (!(hi - lo >= m.spread * 4)) return null;
  let total = 0, losses = 0, armed = true;
  for (; i < bars.length - 1 && bars[i].mod < Math.min(m.open + 180, exitMod); i++) {
    const c = bars[i].close;
    if (!armed && c <= hi && c >= lo) armed = true;
    const dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
    if (!dir) continue;
    const entry = bars[i + 1].open;
    const stop = dir > 0 ? lo : hi;
    let target = targetR ? entry + dir * (entry - stop) * dir * targetR : null;
    if (adrK && dd.adr) {
      let dayHi = -Infinity, dayLo = Infinity;
      for (let j = 0; j <= i; j++) { dayHi = Math.max(dayHi, bars[j].high); dayLo = Math.min(dayLo, bars[j].low); }
      const t2 = dir > 0 ? dayLo + adrK * dd.adr : dayHi - adrK * dd.adr;
      // Already beyond the typical move: take a small fixed target of 0.5R instead.
      target = (t2 - entry) * dir > 0 ? t2 : entry + dir * 0.5 * (entry - stop) * dir;
    }
    const t = sim(bars, { dir, entryIdx: i + 1, stop, target, exitMod, trail });
    if (!t) continue;
    total += t.r;
    i = t.exitIdx;
    if (t.r <= 0) losses++;
    if (losses >= 3 || t.why === 'time' || t.why === 'end of data') break;
    armed = false;
  }
  return total;
}

const days = groupDays(loadMarketBars(m, root, FROM), m.tz).filter((d) => d.bars.length > 60);
// Average high–low range of the previous 20 days, known before the day starts.
days.forEach((d, i) => {
  const prev = days.slice(Math.max(0, i - 20), i).map((p) => Math.max(...p.bars.map((b) => b.high)) - Math.min(...p.bars.map((b) => b.low)));
  d.adr = prev.length >= 10 ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
});
function line(label, exitMod, trail, adrK) {
  const part = (a, b) => {
    const rs = days.filter((d) => d.day >= a && d.day < b).map((d) => dayR(d, exitMod, trail, adrK)).filter((x) => x != null);
    let eq = 0, peak = 0, dd = 0;
    for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    return `${eq >= 0 ? '+' : ''}${eq.toFixed(0).padStart(4)}R (DD ${dd.toFixed(0)}R)`;
  };
  console.log(`${label.padEnd(34)} ${PERIODS.map(([a, b]) => `${a}–${b === '2100' ? 'azi' : +b - 1}: ${part(a, b)}`).join(' | ')}`);
}

const hhmm = (mod) => `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;
console.log(`\n=== ${m.name}: ieșire (ore ${m.tz}) ===`);
line(`Acum: stop sau închidere ${hhmm(m.close)}`, m.close);
for (const t of [600, 660, 720, 780, 840, 900]) line(`Închidere la ${hhmm(t)}`, t);
for (const start of [1, 1.5, 2, 3]) for (const gap of [0.5, 1, 1.5]) {
  if (gap >= start) continue;
  line(`Stop urmăritor: de la +${start}R, la ${gap}R`, m.close, { start, gap });
}
for (const k of [0.6, 0.8, 1, 1.2, 1.5]) line(`Țintă la ${k}× mișcarea medie zilnică`, m.close, null, k);
