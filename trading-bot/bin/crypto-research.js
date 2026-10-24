#!/usr/bin/env node
// Would the bot make money on Bitcoin / Ethereum CFDs? Binance hourly bars (UTC) from 2018,
// IG-like costs (two scenarios), results in R (multiples of the amount risked; 1R = 1% of the
// account at the bot's risk). Compared with buy-and-hold.
//   1. Daily trend: Donchian 50-day breakout, exit on a 20-day opposite breakout, stop 3 × ATR(20);
//      both directions and buys only. Overnight funding charged every night held.
//   2. Opening-range breakout like the live bot: range = first hour of the UTC day, or the hour
//      after the New York open (14:00 UTC); stop at the other side, flat at 23:00 UTC.
//   node bin/crypto-research.js <folder with SYMBOL-1h-YYYY-MM.csv files> BTCUSDT,ETHUSDT
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, syms = 'BTCUSDT,ETHUSDT'] = process.argv.slice(2);
const PERIODS = [['2018', '2020'], ['2020', '2023'], ['2023', '2100']];
const COSTS = [
  { name: 'costuri mici', spread: 0.001, slip: 0.0005, fundingYr: 0.08 },
  { name: 'costuri mari', spread: 0.002, slip: 0.001, fundingYr: 0.15 },
];

function load(sym) {
  const bars = [];
  for (const f of readdirSync(dir).filter((f) => f.startsWith(`${sym}-1h-`) && f.endsWith('.csv')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const c = line.split(',');
      let t = +c[0];
      if (!(t > 0)) continue;
      if (t > 1e14) t = Math.floor(t / 1000); // microseconds from 2025
      bars.push({ t, open: +c[1], high: +c[2], low: +c[3], close: +c[4] });
    }
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
function daily(bars) {
  const out = [];
  for (const b of bars) {
    const d = dayOf(b.t), last = out.at(-1);
    if (last?.day === d) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; }
    else out.push({ day: d, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out;
}

function trend(days, c, longOnly) {
  const trades = [];
  let pos = null;
  for (let i = 51; i < days.length; i++) {
    const d = days[i], prev = days.slice(i - 50, i), last20 = days.slice(i - 20, i);
    const atr = last20.reduce((s, x, k) => s + Math.max(x.high - x.low, Math.abs(x.high - (k ? last20[k - 1].close : x.open)), Math.abs(x.low - (k ? last20[k - 1].close : x.open))), 0) / 20;
    if (pos) {
      const hitStop = pos.dir > 0 ? d.low <= pos.stop : d.high >= pos.stop;
      const exitSig = pos.dir > 0 ? d.close < Math.min(...last20.map((x) => x.low)) : d.close > Math.max(...last20.map((x) => x.high));
      if (hitStop || exitSig) {
        const exit = hitStop ? (pos.dir > 0 ? Math.min(d.open, pos.stop) : Math.max(d.open, pos.stop)) * (1 - pos.dir * c.slip) : d.close;
        const nights = i - pos.i;
        const pnl = (exit - pos.entry) * pos.dir - pos.entry * (c.spread + nights * c.fundingYr / 365);
        trades.push({ day: d.day, r: pnl / pos.risk });
        pos = null;
      }
      continue;
    }
    const hi = Math.max(...prev.map((x) => x.close)), lo = Math.min(...prev.map((x) => x.close));
    const dir = d.close > hi ? 1 : d.close < lo && !longOnly ? -1 : 0;
    if (dir) pos = { dir, i, entry: d.close, stop: d.close - dir * 3 * atr, risk: 3 * atr };
  }
  return trades;
}

function orb(bars, c, startHour) {
  const byDay = new Map();
  for (const b of bars) { const d = dayOf(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const trades = [];
  for (const [day, bs] of byDay) {
    const h = (b) => new Date(b.t).getUTCHours();
    const r0 = bs.find((b) => h(b) === startHour);
    if (!r0) continue;
    const hi = r0.high, lo = r0.low;
    if (!(hi > lo)) continue;
    const rest = bs.filter((b) => h(b) > startHour);
    for (let k = 0; k < rest.length - 1; k++) {
      const dir = rest[k].close > hi ? 1 : rest[k].close < lo ? -1 : 0;
      if (!dir) continue;
      const entry = rest[k + 1].open, stop = dir > 0 ? lo : hi, risk = (entry - stop) * dir;
      if (!(risk > 0)) break;
      let exit = rest.at(-1).close;
      for (let j = k + 1; j < rest.length; j++) {
        const b = rest[j];
        if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) * (1 - dir * c.slip); break; }
      }
      trades.push({ day, r: ((exit - entry) * dir - entry * c.spread) / risk });
      break; // one trade a day
    }
  }
  return trades;
}

const fmt = (trades) => PERIODS.map(([a, b]) => {
  const t = trades.filter((x) => x.day >= a && x.day < b);
  let eq = 0, peak = 0, dd = 0;
  for (const x of t) { eq += x.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return `${a}–${b === '2100' ? 'azi' : +b - 1}: ${eq >= 0 ? '+' : ''}${eq.toFixed(0).padStart(4)}R (${t.length} tr, DD ${dd.toFixed(0)}R)`;
}).join(' | ');

for (const sym of syms.split(',')) {
  const bars = load(sym);
  if (!bars.length) { console.log(`${sym}: fără date`); continue; }
  const days = daily(bars);
  console.log(`\n=== ${sym}: ${days[0].day} – ${days.at(-1).day} ===`);
  console.log(`Cumpără și ține: ${PERIODS.map(([a, b]) => {
    const s = days.filter((d) => d.day >= a && d.day < b);
    return s.length ? `${a}: ${((s.at(-1).close / s[0].open - 1) * 100).toFixed(0)}%` : '';
  }).join(' | ')}`);
  for (const c of COSTS) {
    console.log(`-- ${c.name} (spread ${c.spread * 100}%, dobândă ${c.fundingYr * 100}%/an)`);
    console.log(`Trend 50/20 zile, ambele      ${fmt(trend(days, c, false))}`);
    console.log(`Trend 50/20 zile, doar long   ${fmt(trend(days, c, true))}`);
    console.log(`Interval prima oră (00 UTC)   ${fmt(orb(bars, c, 0))}`);
    console.log(`Interval după NY (14 UTC)     ${fmt(orb(bars, c, 14))}`);
  }
}
