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
    const manual = x.source === 'manual';
    let best = null;
    for (const y of bank) {
      if (used.has(y.id) || !isSameTransaction(x, y)) continue;
      if (xAccount && y.accountId && xAccount !== y.accountId) continue;
      // Something you typed in (cash at Kaufland) is only the bank's copy when it is
      // the same day, amount and account; otherwise keep both, never delete it.
      if (manual && (x.date !== y.date || !y.accountId || (x.accountId || xAccount) !== y.accountId)) continue;
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

// ---------------------------------------------------------------- CSV imports
// An imported row's fingerprint (importHash) is `${accountId}|${bare}[#n]`:
// the account picked in the import screen, the row's text (`bare`) and its
// occurrence number within the statement. Older versions stored `bare` alone.
// The account *picked* must not matter (the same file imported as "Current
// account" and then as "auto" is still the same file), but the account the
// row really belongs to does (identical rows on the current account and on
// the card statement are two transactions).

const LEGACY = /^\d{4}-\d{2}-\d{2}\|/; // a bare fingerprint starts with the date

function splitHash(hash) {
  if (LEGACY.test(hash)) return { account: '', rest: hash };
  const i = hash.indexOf('|');
  return { account: hash.slice(0, i), rest: hash.slice(i + 1) };
}

function resolver(state) {
  const L = state.categories ? makeLedger(state) : null;
  return (t) => (L ? L.accountOf(t)?.uid : null) || t.accountId || '';
}

/**
 * Which incoming rows were imported (or deleted) before. `candidates` are the
 * new rows, already shaped like stored transactions (source 'import', batchId,
 * accountId, importHash), so they are resolved to an account together, as one
 * statement. has(t, bare) is true when t was seen; add(t) marks it as seen.
 */
export function importSeen(state, candidates = []) {
  const resolve = resolver({ ...state, transactions: [...(state.transactions || []), ...candidates] });
  const keys = new Set();
  const anyAccount = new Set(); // fingerprints whose account is unknown
  const legacy = new Set();
  for (const t of state.transactions || []) {
    if (typeof t.importHash !== 'string' || !t.importHash) continue;
    if (LEGACY.test(t.importHash)) { legacy.add(t.importHash); continue; }
    keys.add(`${resolve(t)}|${splitHash(t.importHash).rest}`);
  }
  for (const h of state.deletedImportHashes || []) {
    if (typeof h !== 'string' || !h) continue;
    const { account, rest } = splitHash(h);
    if (account) keys.add(`${account}|${rest}`); else anyAccount.add(rest);
  }
  const keyOf = (t) => `${resolve(t)}|${splitHash(t.importHash).rest}`;
  return {
    has: (t, bare) => keys.has(keyOf(t)) || anyAccount.has(splitHash(t.importHash).rest) || legacy.has(bare),
    add: (t) => { keys.add(keyOf(t)); },
  };
}

const MAX_DELETED = 20000;

/**
 * Call when a transaction is deleted, BEFORE removing it from
 * state.transactions: if it came from a CSV import (or is a bank entry that
 * absorbed one), its fingerprint, keyed by the account it really belongs to,
 * goes to state.deletedImportHashes so re-importing the statement doesn't
 * bring it back. Mutates `state`; returns true when something was recorded.
 */
export function rememberDeletedImport(state, tx) {
  if (typeof tx?.importHash !== 'string' || !tx.importHash) return false;
  const key = LEGACY.test(tx.importHash) ? tx.importHash : `${resolver(state)(tx)}|${splitHash(tx.importHash).rest}`;
  const list = Array.isArray(state.deletedImportHashes) ? state.deletedImportHashes : [];
  if (!list.includes(key)) list.push(key);
  state.deletedImportHashes = list.slice(-MAX_DELETED);
  return true;
}
