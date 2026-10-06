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

// ---------- historical rates (the rate of the transaction's own date) ----------

const BNR_YEAR_URL = (year) => `https://www.bnr.ro/files/xml/years/nbrfxrates${year}.xml`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Yearly file: one <Cube date="YYYY-MM-DD"> per business day. Returns [{ date, rates }] sorted by date.
export function parseBnrYear(xml) {
  const days = [];
  for (const [, date, body] of String(xml).matchAll(/<Cube\s+date="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g)) {
    days.push({ date, rates: parseBnrRates(body) });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

// year → { at, days }. Past years never change; the current year grows every business day.
const years = new Map();

export function clearFxCache() {
  years.clear();
  cached = null;
}

async function yearRates(year) {
  const hit = years.get(year);
  const final = year < new Date().getUTCFullYear();
  if (hit && (final || Date.now() - hit.at < CACHE_MS)) return hit.days;
  const res = await fetch(BNR_YEAR_URL(year), { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) { // e.g. a year with no rates published yet
    years.set(year, { at: Date.now(), days: [] });
    return [];
  }
  if (!res.ok) throw new Error(`BNR exchange rates for ${year} unavailable (${res.status})`);
  const days = parseBnrYear(await res.text());
  years.set(year, { at: Date.now(), days });
  return days;
}

/**
 * RON per 1 unit of `currency` on `date` (YYYY-MM-DD): BNR's rate of that day,
 * or of the previous business day when there is none (weekends, holidays,
 * today before publication, 1–2 January). Returns { rate, date } where `date`
 * is the day of the rate actually used. Throws when the rate is unknown.
 */
export async function bnrRateOn(currency, date) {
  const day = ISO_DATE.test(String(date)) ? String(date) : new Date().toISOString().slice(0, 10);
  if (!currency || currency === 'RON') return { rate: 1, date: day };
  const year = Number(day.slice(0, 4));
  for (const y of [year, year - 1]) {
    const days = await yearRates(y);
    for (let i = days.length - 1; i >= 0; i -= 1) {
      if (days[i].date > day) continue;
      const rate = days[i].rates[currency];
      if (!rate) throw new Error(`No BNR exchange rate for ${currency}`);
      return { rate, date: days[i].date };
    }
  }
  throw new Error(`No BNR exchange rate for ${currency} on ${day}`);
}
