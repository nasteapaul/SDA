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
    .map((t, i) => ({ time: t * 1000, close: q.close[i], volume: q.volume[i] }))
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
  };
}
