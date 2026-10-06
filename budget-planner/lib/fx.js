// Exchange rates to RON from the National Bank of Romania's daily reference
// rates, used to convert bank transactions in other currencies (e.g. a EUR
// Revolut account) so totals and budgets add up in RON.

const BNR_URL = 'https://www.bnr.ro/nbrfxrates.xml';
const CACHE_MS = 6 * 3600 * 1000;

// "<Rate currency="EUR">4.9771</Rate>", "<Rate currency="HUF" multiplier="100">1.2345</Rate>"
export function parseBnrRates(xml) {
  const rates = { RON: 1 };
  const re = /<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>([\d.]+)<\/Rate>/g;
  for (const [, currency, multiplier, value] of String(xml).matchAll(re)) {
    const rate = Number(value) / Number(multiplier || 1);
    if (rate > 0) rates[currency] = rate;
  }
  return rates;
}

let cached = null;

// Returns RON per 1 unit of `currency`; throws when the rate is unknown.
export async function bnrRate(currency) {
  if (!currency || currency === 'RON') return 1;
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const res = await fetch(BNR_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`BNR exchange rates unavailable (${res.status})`);
    cached = { at: Date.now(), rates: parseBnrRates(await res.text()) };
  }
  const rate = cached.rates[currency];
  if (!rate) throw new Error(`No BNR exchange rate for ${currency}`);
  return rate;
}
