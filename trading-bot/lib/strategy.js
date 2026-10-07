import { ema, rsi, atr } from './indicators.js';

export const DEFAULTS = Object.freeze({
  fast: 9,
  slow: 21,
  rsiPeriod: 14,
  rsiMaxLong: 70, // don't buy when already overbought
  rsiMinShort: 30, // don't sell when already oversold
  atrPeriod: 14,
  stopAtr: 1.5, // stop-loss distance in ATRs
  targetAtr: 3, // take-profit distance in ATRs (2:1 reward/risk)
});

// EMA crossover filtered by RSI. Returns one entry per candle:
// { side: 'BUY' | 'SELL' | null, stop, target, reason }.
// A signal on candle i is meant to be acted on at the open of candle i + 1.
export function emaCrossSignals(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.fast >= o.slow) throw new Error('fast period must be shorter than slow period');
  const closes = candles.map((c) => c.close);
  const f = ema(closes, o.fast);
  const s = ema(closes, o.slow);
  const r = rsi(closes, o.rsiPeriod);
  const a = atr(candles, o.atrPeriod);

  return candles.map((c, i) => {
    const none = { side: null };
    if (i === 0 || [f[i], s[i], f[i - 1], s[i - 1], r[i], a[i]].some((v) => v == null)) return none;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDown = f[i - 1] >= s[i - 1] && f[i] < s[i];
    if (crossUp && r[i] < o.rsiMaxLong) {
      return { side: 'BUY', stopDist: a[i] * o.stopAtr, targetDist: a[i] * o.targetAtr, reason: `EMA${o.fast} peste EMA${o.slow}, RSI ${r[i].toFixed(1)}` };
    }
    if (crossDown && r[i] > o.rsiMinShort) {
      return { side: 'SELL', stopDist: a[i] * o.stopAtr, targetDist: a[i] * o.targetAtr, reason: `EMA${o.fast} sub EMA${o.slow}, RSI ${r[i].toFixed(1)}` };
    }
    return none;
  });
}
