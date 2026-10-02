// The same purchase can arrive twice from different sources: a CSV statement
// import (Romanian text, settlement date) and the bank API (English text,
// booking date). Two entries are the same transaction when they have the same
// direction and amount, dates at most a few days apart, and share a merchant
// word (e.g. "NETFLIX").

import { normalize } from './categories.js';
import { makeLedger } from './ledger.js';

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
  return mergeRepeatedImports(state) + mergeIntoBank(state);
}

// The same CSV statement imported twice — e.g. before and after an update that
// changed how descriptions are read — must not double everything. Entries from
// different import batches with the same date, direction, amount and a shared
// merchant word are one transaction; the newest import (best description) wins.
// Within one batch identical rows are genuine (two 5 RON parking tickets).
function mergeRepeatedImports(state) {
  const imports = state.transactions.filter((t) => t.source === 'import');
  if (imports.length < 2) return 0;
  // Imports made before batch ids existed: one import call = one minute.
  const batchOf = (t) => t.batchId || `legacy:${(t.createdAt || '').slice(0, 16)}`;
  const newestFirst = [...imports].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const byKey = new Map();
  for (const t of newestFirst) {
    const k = `${t.date}|${t.type}|${t.amount.toFixed(2)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const remove = new Set();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const kept = [];
    for (const t of group) {
      // Only entries from older app versions (no batch id) are cleaned up this way;
      // newer imports are protected by their fingerprint, and two different
      // statements (current account vs card) must never be merged.
      const twin = !t.batchId && kept.find((k) => !k.claimed?.has(batchOf(t)) && batchOf(k) !== batchOf(t));
      if (!twin) { kept.push(t); continue; }
      (twin.claimed ||= new Set()).add(batchOf(t));
      if (t.manualCategory && !twin.manualCategory) { twin.category = t.category; twin.manualCategory = true; }
      if (t.goalId && !twin.goalId) twin.goalId = t.goalId;
      remove.add(t.id);
    }
    for (const k of kept) delete k.claimed;
  }
  if (remove.size) state.transactions = state.transactions.filter((t) => !remove.has(t.id));
  return remove.size;
}

function mergeIntoBank(state) {
  const bank = state.transactions.filter((t) => t.source === 'bank');
  if (!bank.length) return 0;
  const used = new Set();
  const remove = new Set();
  // The account a row really belongs to (card number etc.), not a wrong pick at import.
  const L = state.categories && state.bank ? makeLedger(state) : null;
  const accountOf = (t) => (L ? L.accountOf(t)?.uid : t.accountId);
  for (const x of state.transactions) {
    if (x.source === 'bank' || x.goalId) continue;
    const xAccount = accountOf(x);
    let best = null;
    for (const y of bank) {
      if (used.has(y.id) || !isSameTransaction(x, y)) continue;
      if (xAccount && y.accountId && xAccount !== y.accountId) continue;
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
