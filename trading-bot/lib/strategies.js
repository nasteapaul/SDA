// Intraday strategies for the research runner and the live bot. Each takes the day's
// 1-minute bars (with local minute of day `mod`) and returns trade specs for lib/daytrade.js.
import { ema, atr } from './indicators.js';
import { resample } from './history.js';
import { berlinClock } from './session.js';

const firstIdxAt = (bars, mod) => bars.findIndex((b) => b.mod >= mod);
const XETRA_OPEN = 540; // 09:00
const XETRA_CLOSE = 1050; // 17:30

// Previous trading day's cash-session close (last bar before 17:30).
function prevClose(days, d) {
  const prev = days[d - 1];
  if (!prev) return null;
  const s = prev.bars.filter((b) => b.mod < XETRA_CLOSE);
  return s.length ? s.at(-1).close : null;
}

// Opening range breakout: high/low of the first `rangeMin` minutes after 09:00. First close
// beyond it before `lastEntry` enters on the next bar; stop at the other side of the range
// (or `stopFrac` of it), optional target in R, flat at `exit`.
// `trend`: only trade in the direction of yesterday's close vs its 20-day average.
// `open`: start of the range (default 09:00; 930 = 15:30 for the US open).
export function orb({ rangeMin = 15, targetR = null, stopFrac = 1, open = XETRA_OPEN, lastEntry = 720, exit = XETRA_CLOSE, minRange = 5, maxRange = 150, trend = false } = {}) {
  return (day, days, d) => {
    const bars = day.bars;
    const start = firstIdxAt(bars, open);
    if (start < 0 || bars[start].mod > open + 5) return [];
    const bias = trend ? trendBias(days, d) : 0;
    if (trend && !bias) return [];
    let hi = -Infinity, lo = Infinity, i = start;
    for (; i < bars.length && bars[i].mod < open + rangeMin; i++) {
      hi = Math.max(hi, bars[i].high);
      lo = Math.min(lo, bars[i].low);
    }
    const width = hi - lo;
    if (!(width >= minRange && width <= maxRange)) return [];
    for (; i < bars.length - 1 && bars[i].mod < lastEntry; i++) {
      const c = bars[i].close;
      const dir = c > hi ? 1 : c < lo ? -1 : 0;
      if (!dir) continue;
      if (bias && dir !== bias) return [];
      const entryRef = bars[i + 1].open;
      const stop = dir > 0 ? hi - width * stopFrac : lo + width * stopFrac;
      const risk = (entryRef - stop) * dir;
      return [{ dir, entryIdx: i + 1, stop, target: targetR ? entryRef + dir * risk * targetR : null, exitMod: exit }];
    }
    return [];
  };
}

// +1 if yesterday's cash close is above the average of the 20 closes before it, else -1.
function trendBias(days, d, n = 20) {
  const closes = [];
  for (let k = d - 1; k >= 0 && closes.length < n + 1; k--) {
    const c = prevClose(days, k + 1);
    if (c != null) closes.push(c);
  }
  if (closes.length < n + 1) return 0;
  const avg = closes.slice(1).reduce((a, b) => a + b, 0) / n;
  return closes[0] > avg ? 1 : -1;
}

// Breakout of yesterday's cash-session high/low between 09:00 and `lastEntry`;
// stop `stopFrac` of yesterday's range back inside, flat at `exit`.
export function prevDayBreakout({ stopFrac = 0.5, lastEntry = 720, exit = XETRA_CLOSE } = {}) {
  return (day, days, d) => {
    const prev = days[d - 1]?.bars.filter((b) => b.mod >= XETRA_OPEN && b.mod < XETRA_CLOSE);
    if (!prev?.length) return [];
    const hi = Math.max(...prev.map((b) => b.high)), lo = Math.min(...prev.map((b) => b.low));
    const range = hi - lo;
    const bars = day.bars;
    for (let i = firstIdxAt(bars, XETRA_OPEN + 1); i >= 0 && i < bars.length - 1 && bars[i].mod < lastEntry; i++) {
      const c = bars[i].close;
      const dir = c > hi ? 1 : c < lo ? -1 : 0;
      if (!dir) continue;
      const level = dir > 0 ? hi : lo;
      return [{ dir, entryIdx: i + 1, stop: level - dir * range * stopFrac, exitMod: exit }];
    }
    return [];
  };
}

// Intraday momentum (Gao, Han, Li, Zhou 2018): the return from the previous close to
// 09:30 predicts 17:00-17:30. Trade the last half hour in that direction.
export function lastHalfHour({ minMove = 0, stop = 40 } = {}) {
  return (day, days, d) => {
    const pc = prevClose(days, d);
    const i930 = firstIdxAt(day.bars, 570);
    const i1700 = firstIdxAt(day.bars, 1020);
    if (pc == null || i930 < 1 || i1700 < 0) return [];
    const move = day.bars[i930 - 1].close - pc;
    if (Math.abs(move) <= minMove) return [];
    const dir = Math.sign(move);
    return [{ dir, entryIdx: i1700, stop: day.bars[i1700].open - dir * stop, exitMod: XETRA_CLOSE }];
  };
}

// Gap fade: if 09:00 opens more than `minGap` points away from yesterday's close, trade
// back toward it; target the previous close, stop `stopMult` gaps further out.
export function gapFade({ minGap = 30, maxGap = 200, stopMult = 1, exit = 720 } = {}) {
  return (day, days, d) => {
    const pc = prevClose(days, d);
    const i = firstIdxAt(day.bars, XETRA_OPEN);
    if (pc == null || i < 0 || day.bars[i].mod > XETRA_OPEN + 5) return [];
    const open = day.bars[i].open;
    const gap = open - pc;
    if (Math.abs(gap) < minGap || Math.abs(gap) > maxGap) return [];
    const dir = -Math.sign(gap);
    return [{ dir, entryIdx: i, stop: open - dir * Math.abs(gap) * stopMult, target: pc, exitMod: exit }];
  };
}

// The bot's original EMA cross + ATR stop on 5-minute candles, optionally limited to hours.
export function emaCross({ fast = 9, slow = 21, stopAtr = 1.5, targetAtr = 3, from = 0, until = 1440, exit = 1440 } = {}) {
  return (day) => {
    const c5 = resample(day.bars, 5);
    const closes = c5.map((c) => c.close);
    const f = ema(closes, fast), s = ema(closes, slow), a = atr(c5, 14);
    const specs = [];
    for (let k = 1; k < c5.length - 1; k++) {
      if ([f[k], s[k], f[k - 1], s[k - 1], a[k]].some((v) => v == null)) continue;
      const up = f[k - 1] <= s[k - 1] && f[k] > s[k];
      const down = f[k - 1] >= s[k - 1] && f[k] < s[k];
      if (!up && !down) continue;
      const entryMod = c5[k + 1].mod;
      if (entryMod < from || entryMod >= until) continue;
      const entryIdx = firstIdxAt(day.bars, entryMod);
      const ref = day.bars[entryIdx].open;
      const dir = up ? 1 : -1;
      specs.push({ dir, entryIdx, stop: ref - dir * a[k] * stopAtr, target: ref + dir * a[k] * targetAtr, exitMod: exit });
    }
    return specs;
  };
}

// Live version of orb() for the bot. Takes the closed candles so far (any resolution) and
// returns a signal only on the candle that makes the day's first close beyond the range.
// The stop is a price level; the bot turns it into a distance from the live price.
export function orbLive({ rangeMin = 15, targetR = 2, stopFrac = 1, open = XETRA_OPEN, lastEntry = 720, minRange = 5, maxRange = 150 } = {}) {
  return (candles) => {
    const last = candles.at(-1);
    if (!last) return null;
    const { day, mod } = berlinClock(last.time);
    if (mod < open + rangeMin || mod >= lastEntry) return null;
    const today = [];
    for (let k = candles.length - 1; k >= 0; k--) {
      const clock = berlinClock(candles[k].time);
      if (clock.day !== day) break;
      today.unshift({ ...candles[k], mod: clock.mod });
    }
    const range = today.filter((c) => c.mod >= open && c.mod < open + rangeMin);
    if (!range.length || range[0].mod > open) return null; // range not fully seen
    const hi = Math.max(...range.map((c) => c.high));
    const lo = Math.min(...range.map((c) => c.low));
    const width = hi - lo;
    if (!(width >= minRange && width <= maxRange)) return null;
    const first = today.find((c) => c.mod >= open + rangeMin && (c.close > hi || c.close < lo));
    if (!first || first.time !== last.time) return null;
    const dir = first.close > hi ? 1 : -1;
    return {
      side: dir > 0 ? 'BUY' : 'SELL',
      stopLevel: dir > 0 ? hi - width * stopFrac : lo + width * stopFrac,
      targetR,
      reason: `Spargere ${dir > 0 ? 'în sus' : 'în jos'} a intervalului de deschidere ${lo.toFixed(1)}–${hi.toFixed(1)}`,
    };
  };
}
