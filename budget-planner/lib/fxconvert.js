// CSV rows in another currency (csv.js marks them needsFx) are converted to
// RON at the BNR rate of their own date, so they add up with everything else.
// Runs after each import and at every bank sync; rows stay marked (and shown
// as "needs conversion") while the rate can't be fetched, e.g. offline.

import { round2 } from '../public/js/shared/money.js';
import { bnrRateOn } from './fx.js';

const pending = (s) => s.transactions.filter((t) => t.needsFx && t.originalCurrency && Number(t.originalAmount) > 0);

/** Converts every pending row it can; returns how many were converted. */
export async function convertPendingFx(store, rateOn = bnrRateOn) {
  const todo = pending(store.get());
  if (!todo.length) return 0;
  // Fetch the rates first (outside the write queue), once per currency and day.
  const rates = new Map();
  for (const t of todo) {
    const key = `${t.originalCurrency}|${t.date}`;
    if (rates.has(key)) continue;
    rates.set(key, null); // asked once per run, even when it fails
    try {
      const r = await rateOn(t.originalCurrency, t.date);
      const rate = typeof r === 'number' ? r : r?.rate;
      if (rate > 0) rates.set(key, { rate, date: (typeof r === 'object' && r?.date) || t.date });
    } catch { /* offline or unknown currency: try again next time */ }
  }
  if (![...rates.values()].some(Boolean)) return 0;
  return store.mutate((s) => {
    let n = 0;
    for (const t of pending(s)) {
      const r = rates.get(`${t.originalCurrency}|${t.date}`);
      if (!r) continue;
      t.amount = round2(Number(t.originalAmount) * r.rate);
      t.exchangeRate = r.rate;
      t.rateDate = r.date;
      t.rateSource = 'bnr';
      delete t.needsFx;
      n += 1;
    }
    return n;
  });
}
