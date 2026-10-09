// Does the app's list of transactions explain the bank balance?
// The sync keeps a short history of balances per account
// (state.bank.balanceHistory[uid] = [{ date: ISO datetime, amount }], amount
// as the bank reported it). Between two snapshots:
//   previous balance + money in − money out (on that account) ≈ latest balance.
// A difference means a missing or duplicate transaction.
//
// Pending card payments: some banks (ING sends balance type XPCD, "expected")
// report a balance that already has card payments taken off that are not
// booked yet. The app only adds a payment once it is booked — often the next
// day — so the same payment would count once in the balance and again as a
// transaction. Each snapshot therefore stores `pending` (the signed total of
// pending payments in that balance) and the check works on booked money:
//   (balance − pending) at the earlier snapshot + transactions ≈ (balance − pending) now.

import { round2 } from './money.js';
import { accountKind, balanceMeaning } from './accounts.js';

export const HISTORY_CAP = 400;
export const TOLERANCE = 0.01;
// Balance types that contain only booked money (no pending payments in them).
export const BOOKED_BALANCE_TYPES = new Set(['CLBD', 'ITBD', 'OPBD', 'PRCD']);

const dayOf = (iso) => String(iso).slice(0, 10);

/** history + one snapshot (new array); skips an unchanged balance on the same day. */
export function appendSnapshot(history, { date, amount, pending } = {}, cap = HISTORY_CAP) {
  const list = Array.isArray(history) ? history : [];
  const n = Number(amount);
  if (Number.isNaN(Date.parse(date)) || !Number.isFinite(n)) return list;
  const entry = { date: new Date(date).toISOString(), amount: round2(n) };
  if (pending != null && Number.isFinite(Number(pending))) entry.pending = round2(Number(pending));
  const last = list[list.length - 1];
  if (last && dayOf(last.date) === dayOf(entry.date) && last.amount === entry.amount && last.pending === entry.pending) return list;
  return [...list, entry].slice(-cap);
}

/** { prev, last }: the latest snapshot and the latest one from an earlier day (else the one before). */
export function snapshotPair(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const last = history[history.length - 1];
  const earlier = [...history].reverse().find((h) => dayOf(h.date) < dayOf(last.date));
  return { prev: earlier || history[history.length - 2], last };
}

/** Per account, only the two snapshots reconcile() needs (what the server sends to the browser). */
export function lastSnapshots(balanceHistory) {
  const out = {};
  for (const [uid, list] of Object.entries(balanceHistory || {})) {
    const pair = snapshotPair(list);
    out[uid] = pair ? [pair.prev, pair.last] : (Array.isArray(list) ? list.slice(-1) : []);
  }
  return out;
}

// The balance as "money you have" (debt negative), so money in adds and money out subtracts.
function signed(acc, raw) {
  if (accountKind(acc) !== 'credit') return raw;
  if (raw < 0) return raw; // a negative card balance is debt
  if (balanceMeaning(acc) === 'available') {
    const limit = Number(acc.creditLimit);
    return limit > 0 ? raw - limit : null; // can't tell the debt without the limit
  }
  return -raw;
}

/**
 * Compares the previous snapshot + transactions booked after it up to the
 * latest snapshot with the latest balance. `accountOf(t)` (the ledger's)
 * decides which account a row belongs to; default t.accountId.
 * Returns null when it can't be checked, else
 * { ok, diff, from, to, fromDay, toDay, txCount, expected, actual, pendingPossible }
 * diff = bank − app (negative: the bank has less money than the app explains).
 */
export function reconcile(state, accountUid, { accountOf } = {}) {
  const acc = (state?.bank?.connections || []).flatMap((c) => c.accounts || []).find((a) => a.uid === accountUid);
  if (!acc) return null;
  const pair = snapshotPair(state.bank.balanceHistory?.[accountUid]);
  if (!pair) return null;
  const { prev, last } = pair;
  const bookedOnly = BOOKED_BALANCE_TYPES.has(String(acc.balance?.type || '').toUpperCase());
  // Pending payments inside the balances (0 for a booked-only balance).
  const pendingOf = (snap) => (bookedOnly ? 0 : Number(snap.pending) || 0);
  // Snapshots from before pending totals were recorded: can't tell pending from missing.
  const uncertain = !bookedOnly && (prev.pending === undefined || last.pending === undefined);
  const signedBefore = signed(acc, Number(prev.amount));
  const signedAfter = signed(acc, Number(last.amount));
  if (signedBefore == null || signedAfter == null) return null;
  const before = round2(signedBefore - pendingOf(prev));
  const after = round2(signedAfter - pendingOf(last));
  const currency = String(acc.balance?.currency || acc.currency || 'RON').toUpperCase();
  const fromDay = dayOf(prev.date);
  const toDay = dayOf(last.date);
  const onAccount = (t) => (t.source === 'bank' || t.source === 'import')
    && (accountOf ? accountOf(t)?.uid : t.accountId) === accountUid;
  const value = (t) => {
    const n = currency !== 'RON' && t.originalCurrency === currency ? Number(t.originalAmount) : Number(t.amount);
    return (t.type === 'income' ? 1 : -1) * (Number.isFinite(n) ? n : 0);
  };
  const check = (rows) => {
    const expected = round2(before + rows.reduce((s, t) => s + value(t), 0));
    const diff = round2(after - expected);
    return { ok: Math.abs(diff) <= TOLERANCE + 1e-9, diff, expected, txCount: rows.length };
  };
  const mine = (state.transactions || []).filter((t) => onAccount(t) && t.date <= toDay);
  let result = check(mine.filter((t) => t.date > fromDay));
  // Rows booked on the day of the earlier snapshot may have come after it.
  if (!result.ok && fromDay !== toDay) {
    const wider = check(mine.filter((t) => t.date >= fromDay));
    if (wider.ok) result = wider;
  }
  return {
    ...result,
    from: prev.date,
    to: last.date,
    fromDay,
    toDay,
    actual: round2(after),
    pending: pendingOf(last), // pending payments in the latest balance (signed, 0 if none/unknown)
    uncertain: !result.ok && uncertain,
    pendingPossible: !result.ok,
  };
}
