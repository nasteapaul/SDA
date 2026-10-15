import { get } from './http.js';

// Daily prices from Yahoo's public chart endpoint (no key; unofficial, so failures are
// tolerated and the alert simply goes out without price context).
export async function chart(symbol, { range = '3mo', fetchImpl } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const json = await get(url, { json: true, headers: { 'User-Agent': 'Mozilla/5.0' }, fetchImpl });
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(`No price data for ${symbol}`);
  const q = r.indicators.quote[0];
  const bars = r.timestamp
    .map((t, i) => ({ time: t * 1000, high: q.high?.[i], low: q.low?.[i], close: q.close[i], volume: q.volume[i] }))
    .filter((b) => Number.isFinite(b.close));
  return { currency: r.meta.currency, price: r.meta.regularMarketPrice ?? bars.at(-1)?.close, bars };
}

// Rough conversion so one liquidity floor works across exchanges.
const TO_USD = { USD: 1, EUR: 1.1, GBP: 1.3, GBp: 0.013, CHF: 1.15, SEK: 0.1, NOK: 0.1, DKK: 0.15, PLN: 0.27 };

export function summarize({ currency, price, bars }) {
  const last = bars.at(-1);
  const prev = bars.slice(-21, -1);
  const avgVol = prev.length ? prev.reduce((s, b) => s + (b.volume ?? 0), 0) / prev.length : 0;
  const rate = TO_USD[currency] ?? 1;
  return {
    price,
    currency,
    priceUsd: price * rate,
    dollarVolume: avgVol * price * rate,
    volumeRatio: avgVol > 0 ? (last?.volume ?? 0) / avgVol : null,
    change1d: bars.length >= 2 ? price / bars.at(-2).close - 1 : null,
    plan: tradePlan(price, bars),
  };
}

// Average true range over the last `n` days: how much the stock normally moves in a day.
export function atr(bars, n = 14) {
  const ranges = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prev = bars[i - 1].close;
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    ranges.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const last = ranges.slice(-n);
  return last.length >= 5 ? last.reduce((s, r) => s + r, 0) / last.length : null;
}

// Levels sized to the stock's normal daily move: stop 2 ATR below, target 4 ATR above
// (2:1 reward to risk), and no buying more than half an ATR above the alert price.
export function tradePlan(price, bars) {
  const a = atr(bars);
  if (!a || !(price > 0)) return null;
  const stop = price - 2 * a;
  if (stop <= 0) return null;
  const prevClose = bars.at(-2)?.close;
  return {
    atr: a,
    buyUpTo: price + 0.5 * a,
    stop,
    target: price + 4 * a,
    // Already up more than 3 normal days' moves today: much of the news is in the price.
    stretched: Number.isFinite(prevClose) && price - prevClose > 3 * a,
  };
}
