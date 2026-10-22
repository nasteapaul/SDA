#!/usr/bin/env node
// The live ORB (re-entry until 3 losses, flat at the close) on other IG markets, on HistData
// 1-minute bars from 2015: does any market hold up in 2015–2019, 2020–2022 and 2023–today?
// IG-like spreads, half a spread of slippage on stops.
//   node bin/scan-recent.js <data folder from bin/histdata-download.js> [PAIR,PAIR,...]
import { groupDays } from '../lib/history.js';
import { loadMarketBars } from '../lib/marketdata.js';

// pair, name, session time zone, open/close (minutes after local midnight), typical IG spread.
const LDN = ['Europe/London', 480, 960], NY = ['America/New_York', 570, 960];
const SCAN = [
  ['EURUSD', 'EUR/USD', ...LDN, 0.00006], ['GBPUSD', 'GBP/USD', ...LDN, 0.00009],
  ['USDCHF', 'USD/CHF', ...LDN, 0.00015], ['EURCHF', 'EUR/CHF', ...LDN, 0.0002],
  ['EURGBP', 'EUR/GBP', ...LDN, 0.0001], ['USDJPY', 'USD/JPY', ...LDN, 0.007],
  ['EURJPY', 'EUR/JPY', ...LDN, 0.015], ['GBPJPY', 'GBP/JPY', ...LDN, 0.025],
  ['USDCAD', 'USD/CAD', ...NY, 0.00013], ['AUDUSD', 'AUD/USD', 'Asia/Tokyo', 540, 900, 0.00006],
  ['NZDUSD', 'NZD/USD', 'Asia/Tokyo', 540, 900, 0.0001], ['EURSEK', 'EUR/SEK', ...LDN, 0.003],
  ['EURNOK', 'EUR/NOK', ...LDN, 0.003], ['USDSEK', 'USD/SEK', ...LDN, 0.003],
  ['XAUUSD', 'Aur', 'America/New_York', 500, 960, 0.3], ['WTIUSD', 'Petrol WTI', 'America/New_York', 540, 870, 0.028],
  ['BCOUSD', 'Petrol Brent', 'Europe/London', 480, 960, 0.028], ['SPXUSD', 'US 500', ...NY, 0.4],
  ['NSXUSD', 'US Tech 100', ...NY, 1.0], ['UDXUSD', 'Dolar index', ...NY, 0.03],
  ['UKXGBP', 'FTSE 100', 'Europe/London', 480, 990, 1.0], ['FRXEUR', 'France 40', 'Europe/Paris', 540, 1050, 1.0],
  ['GRXEUR', 'Germania 40', 'Europe/Berlin', 540, 1050, 1.2], ['JPXJPY', 'Japonia 225', 'Asia/Tokyo', 540, 900, 7],
  ['AUXAUD', 'Australia 200', 'Australia/Sydney', 600, 960, 1.0], ['HKXHKD', 'Hong Kong 50', 'Asia/Hong_Kong', 570, 960, 6],
  ['ETXEUR', 'Euro Stoxx 50', 'Europe/Berlin', 540, 1050, 1.0],
];
const PERIODS = [['2015', '2020'], ['2020', '2023'], ['2023', '2100']];
const VARIANTS = [{ rangeMin: 30, targetR: null }, { rangeMin: 60, targetR: null }, { rangeMin: 60, targetR: 2 }];

function dayR(m, bars, { rangeMin, targetR }) {
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
    if (losses >= 3 || why === 'time' || why === 'end') break;
    i = j;
    armed = false;
  }
  return total;
}

const [root, only] = process.argv.slice(2);
for (const [pair, name, tz, open, close, spread] of SCAN.filter((s) => !only || only.split(',').includes(s[0]))) {
  const m = { history: `histdata/${pair}`, tz, open, close, spread };
  let days;
  try { days = groupDays(loadMarketBars(m, root, 2015), tz).filter((d) => d.bars.length > 60); } catch { console.log(`${name}: fără date`); continue; }
  if (!days.length) { console.log(`${name}: fără date`); continue; }
  for (const v of VARIANTS) {
    const parts = PERIODS.map(([a, b]) => {
      let eq = 0, n = 0;
      for (const d of days) if (d.day >= a && d.day < b) { const r = dayR(m, d.bars, v); if (r != null) { eq += r; n++; } }
      return { eq, n };
    });
    const ok = parts.every((p) => p.eq > 0) ? '  <-- pozitiv în toate' : '';
    console.log(`${name.padEnd(14)} ${String(v.rangeMin).padStart(2)}m ${v.targetR ? '2R  ' : 'fără'}  ${parts.map((p, k) => `${PERIODS[k][0]}–${PERIODS[k][1] === '2100' ? 'azi' : +PERIODS[k][1] - 1}: ${p.eq >= 0 ? '+' : ''}${p.eq.toFixed(0).padStart(4)}R`).join(' | ')}${ok}`);
  }
}
