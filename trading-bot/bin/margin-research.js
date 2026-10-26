#!/usr/bin/env node
// Does the live ORB still work on a small account once IG's margin and smallest deal sizes
// count? Earlier research added up R per market as if every trade could be opened at exactly
// 1 % risk. Here the four live markets run as one account in EUR (Paul's live IG Europe
// account), in time order: a trade is skipped when the free funds don't cover its margin
// (as bin/multibot.js does), sized up to IG's smallest size when 1 % is below it (never over
// 2 × the planned risk, else skipped), risk 1 % of the day's starting balance, 3 % daily stop.
// HistData 1-minute bars from 2015, the same trade rules and costs as bin/news-dir-research.js.
//   node bin/margin-research.js <data folder from bin/histdata-download.js>
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';
import { spreadAt } from '../lib/daytrade.js';
import { marketByKey, costsFor } from '../lib/markets.js';

const root = process.argv[2];
const RON_PER_EUR = 5.09;
// EUR per unit of the quote currency, at October 2026 rates (fixed over the whole test).
const EUR = { USD: 1 / 1.118, AUD: 0.628, EUR: 1 };
// IG CFD contracts (checked on the demo on 2026-10-26; US Tech 100 as the €1 contract with the
// £1 contract's smallest size): contract size, quote currency, smallest size, margin %.
const SPECS = {
  EURUSD: { pair: 'EURUSD', contract: 10000, ccy: 'USD', min: 0.1, margin: 3.33 },
  GBPUSD: { pair: 'GBPUSD', contract: 10000, ccy: 'USD', min: 0.04, margin: 3.33 },
  AU200: { pair: 'AUXAUD', contract: 1, ccy: 'AUD', min: 1, margin: 5 },
  USTECH: { pair: 'NSXUSD', contract: 1, ccy: 'EUR', min: 0.5, margin: 5 },
};
const PERIODS = [['2015', '2020'], ['2020', '2023'], ['2023', '2100']];

// Every trade of the live rules on one market: times, result in R after costs, stop distance.
function marketTrades(key) {
  const spec = SPECS[key];
  const m = { ...marketByKey(key), history: `histdata/${spec.pair}` };
  const costs = costsFor(m);
  const { rangeMin, targetR } = m.live;
  const out = [];
  for (const d of groupDays(loadMarketBars(m, root, 2015), m.tz)) {
    const bars = d.bars;
    if (bars.length <= 60) continue;
    const start = bars.findIndex((b) => b.mod >= m.open);
    if (start < 0 || bars[start].mod > m.open + 5) continue;
    let hi = -Infinity, lo = Infinity, i = start;
    for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
    if (!(hi - lo >= m.spread * 4)) continue;
    let losses = 0, armed = true;
    for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
      const c = bars[i].close;
      if (!armed && c <= hi && c >= lo) armed = true;
      let dir = armed ? (c > hi ? 1 : c < lo ? -1 : 0) : 0;
      if (dir < 0 && m.live.longOnly) dir = 0;
      if (!dir) continue;
      const entry = bars[i + 1].open, stop = dir > 0 ? lo : hi, risk = (entry - stop) * dir;
      if (!(risk > 0)) continue;
      const target = targetR ? entry + dir * risk * targetR : null;
      let exit = bars.at(-1).close, exitTime = bars.at(-1).time, why = 'end', j = i + 1;
      for (; j < bars.length; j++) {
        const b = bars[j];
        exitTime = b.time;
        if (j > i + 1 && b.mod >= m.close) { exit = b.open; why = 'time'; break; }
        if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage; why = 'stop'; break; }
        if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); why = 'target'; break; }
      }
      const r = ((exit - entry) * dir - spreadAt(bars[i + 1].mod, costs)) / risk;
      out.push({ key, day: d.day, time: bars[i + 1].time, exitTime, entry, stopDist: risk, r });
      if (r <= 0) losses++;
      if (losses >= 3 || why === 'time' || why === 'end') break;
      i = j;
      armed = false;
    }
  }
  return out;
}

const trades = Object.keys(SPECS).flatMap(marketTrades).sort((a, b) => a.time - b.time);

// One account through one period. opts: start (EUR), margin and minSize on/off.
function account(from, to, { start, margin, minSize }) {
  let bal = start, peak = start, dd = 0, day = '', dayStart = start, dayPnl = 0;
  const open = []; // { exitTime, pnl, margin }
  const n = { taken: 0, noMargin: 0, tooSmall: 0, raised: 0, dayStop: 0, maxUse: 0, highUse: 0 };
  const settle = (t) => {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].exitTime > t) continue;
      bal += open[k].pnl;
      dayPnl += open[k].pnl;
      open.splice(k, 1);
      peak = Math.max(peak, bal);
      dd = Math.max(dd, (peak - bal) / peak);
    }
  };
  for (const t of trades) {
    if (t.day < from || t.day >= to) continue;
    settle(t.time);
    const today = new Date(t.time).toISOString().slice(0, 10);
    if (today !== day) { day = today; dayStart = bal; dayPnl = 0; }
    if (dayPnl <= -0.03 * dayStart) { n.dayStop++; continue; }
    const spec = SPECS[t.key];
    const perUnit = spec.contract * EUR[spec.ccy]; // EUR per 1.0 price move per contract
    const plannedRisk = 0.01 * dayStart;
    let size = margin || minSize ? Math.floor((plannedRisk / (t.stopDist * perUnit)) * 100) / 100 : plannedRisk / (t.stopDist * perUnit);
    if (minSize && size < spec.min) {
      if (spec.min * t.stopDist * perUnit > 2 * plannedRisk) { n.tooSmall++; continue; }
      size = spec.min;
      n.raised++;
    }
    const need = size * spec.contract * t.entry * EUR[spec.ccy] * spec.margin / 100;
    const used = open.reduce((s, p) => s + p.margin, 0);
    if (margin && need > bal - used) { n.noMargin++; continue; }
    const use = (used + need) / bal;
    n.maxUse = Math.max(n.maxUse, use);
    if (use > 0.8) n.highUse++;
    open.push({ exitTime: t.exitTime, pnl: t.r * size * t.stopDist * perUnit, margin: need });
    n.taken++;
  }
  settle(Infinity);
  return { end: bal, dd, ...n };
}

const ron = (eur) => Math.round(eur * RON_PER_EUR).toLocaleString('ro-RO');
const SCEN = [
  ['Ca în calculele de până acum (fără marjă)', { start: 10000 / RON_PER_EUR, margin: false, minSize: false }],
  ['10.000 lei, cu marjă și mărimi minime IG', { start: 10000 / RON_PER_EUR, margin: true, minSize: true }],
  ['10.000 lei, doar marja', { start: 10000 / RON_PER_EUR, margin: true, minSize: false }],
  ['50.000 lei, cu marjă și mărimi minime IG', { start: 50000 / RON_PER_EUR, margin: true, minSize: true }],
];
console.log(`Tranzacții după reguli (toate piețele): ${trades.length}`);
for (const k of Object.keys(SPECS)) console.log(`  ${k}: ${trades.filter((t) => t.key === k).length}`);
for (const [a, b] of PERIODS) {
  console.log(`\n=== ${a}–${b === '2100' ? 'azi' : +b - 1} (fiecare perioadă pornește de la suma inițială) ===`);
  for (const [label, o] of SCEN) {
    const r = account(a, b, o);
    console.log(`${label.padEnd(44)} ${ron(o.start)} → ${ron(r.end)} lei (${((r.end / o.start - 1) * 100).toFixed(0)}%), DD ${(r.dd * 100).toFixed(0)}%, ` +
      `făcute ${r.taken}, sărite marjă ${r.noMargin}, sărite mărime ${r.tooSmall}, mărite la minim ${r.raised}, limită zi ${r.dayStop}, ` +
      `marjă max ${(r.maxUse * 100).toFixed(0)}%, >80% de ${r.highUse} ori`);
  }
}
