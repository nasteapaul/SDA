// The same purchase can arrive twice from different sources: a CSV statement
// import (Romanian text, settlement date) and the bank API (English text,
// booking date). Two entries are the same transaction when they have the same
// direction and amount, dates at most a few days apart, and share a merchant
// word (e.g. "NETFLIX").

import { normalize } from './categories.js';

const MAX_DAYS = 3;
const STOP = new Set(`
  card number numar transaction transactions tranzactie tranzactia autorizare authorization authorisation date data
  finalizarii decontarii decontare cumparare plata plati payment comerciant merchant suma amount valoare value
  referinta reference detalii details debit credit pos online with from catre pentru the and
`.trim().split(/\s+/));

export function merchantTokens(t) {
  const words = normalize(`${t.description || ''} ${t.note || ''}`).split(/[^a-z]+/);
  return new Set(words.filter((w) => w.length >= 4 && !STOP.has(w)));
}

function dayDiff(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
}

export function isSameTransaction(a, b) {
  if (a.type !== b.type || Math.abs(a.amount - b.amount) > 0.005) return false;
  if (dayDiff(a.date, b.date) > MAX_DAYS) return false;
  const ta = merchantTokens(a);
  for (const w of merchantTokens(b)) if (ta.has(w)) return true;
  return false;
}

/**
 * Merge non-bank entries (CSV import, manual) into the matching bank entry.
 * The bank entry is kept (so future syncs recognise it); anything you set by
 * hand on the other one (category, note) is carried over. Mutates `state`.
 * Returns the number of duplicates removed.
 */
export function mergeDuplicates(state) {
  const bank = state.transactions.filter((t) => t.source === 'bank');
  if (!bank.length) return 0;
  const used = new Set();
  const remove = new Set();
  for (const x of state.transactions) {
    if (x.source === 'bank' || x.goalId) continue;
    let best = null;
    for (const y of bank) {
      if (used.has(y.id) || !isSameTransaction(x, y)) continue;
      if (!best || dayDiff(x.date, y.date) < dayDiff(x.date, best.date)) best = y;
    }
    if (!best) continue;
    used.add(best.id);
    remove.add(x.id);
    const editedByYou = x.source === 'manual' || x.updatedAt !== x.createdAt;
    if (editedByYou && x.category) best.category = x.category;
    if (x.note && !best.note) best.note = x.note;
    if (x.importHash) best.importHash = x.importHash; // re-importing the same CSV stays a no-op
  }
  if (remove.size) state.transactions = state.transactions.filter((t) => !remove.has(t.id));
  return remove.size;
}
