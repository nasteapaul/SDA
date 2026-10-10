// Can you trust the numbers? Per linked account: when it was last synced, how
// many new rows that brought, whether the app's transactions explain the bank
// balance (reconcile.js) and, when they don't, the likely reason. Plus how long
// the bank access (PSD2 consent) still lasts.
// Pure: no DOM, used by the browser and by Node.

import { round2 } from './money.js';
import { reconcile } from './reconcile.js';

const DAY = 86400000;
const HOUR = 3600000;
export const STALE_HOURS = 24;
export const CONSENT_SOON_DAYS = 14;
export const CONSENT_URGENT_DAYS = 3;

/**
 * Bank access per (non-archived) bank link, soonest first:
 * [{ bank, validUntil, daysLeft, level: 'ok'|'soon'|'urgent'|'expired' }].
 */
export function consentStatus(state, { now = Date.now() } = {}) {
  const out = [];
  for (const c of state?.bank?.connections || []) {
    if (c.archived || !c.validUntil) continue;
    const until = Date.parse(c.validUntil);
    if (Number.isNaN(until)) continue;
    const daysLeft = Math.ceil((until - now) / DAY);
    let level = 'ok';
    if (until <= now) level = 'expired';
    else if (daysLeft <= CONSENT_URGENT_DAYS) level = 'urgent';
    else if (daysLeft <= CONSENT_SOON_DAYS) level = 'soon';
    out.push({ bank: c.bank, validUntil: c.validUntil, daysLeft: Math.max(daysLeft, 0), level });
  }
  return out.sort((a, b) => Date.parse(a.validUntil) - Date.parse(b.validUntil));
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.01 + 1e-9;
const dayGap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;

/**
 * Why the app and the bank disagree (rec = reconcile() result that is not ok):
 * [{ kind: 'uncertain'|'duplicate'|'missing'|'import', text, txId?, amount? }].
 * (Pending card payments are already taken out by reconcile(), so they never explain a difference.)
 * diff = bank − app: an extra copy of a payment in the app makes the app poorer
 * (diff > 0), an extra copy of money in makes it richer (diff < 0).
 */
export function explainDifference(state, uid, rec, { accountOf } = {}) {
  if (!rec || rec.ok) return [];
  const hints = [];
  const diff = Number(rec.diff) || 0;
  const amount = round2(Math.abs(diff));
  const onAccount = (t) => (accountOf ? accountOf(t)?.uid : t.accountId) === uid;
  const inWindow = (state?.transactions || []).filter((t) => (t.source === 'bank' || t.source === 'import')
    && onAccount(t) && t.date >= rec.fromDay && t.date <= rec.toDay);
  // Older balance snapshots don't say how much was pending: the difference may be just that.
  if (rec.uncertain) {
    hints.push({ kind: 'uncertain', text: 'Card payments not booked yet are already in the bank’s balance. Checked again after the next sync.' });
    return hints;
  }
  if (amount > 0.01) {
    // A row of exactly the difference that has a twin (same amount, within 3 days): probably counted twice.
    const extraType = diff > 0 ? 'expense' : 'income';
    const dup = inWindow.find((t) => t.type === extraType && near(t.amount, amount)
      && inWindow.some((o) => o !== t && o.type === t.type && near(o.amount, t.amount) && dayGap(o.date, t.date) <= 3));
    if (dup) {
      hints.push({ kind: 'duplicate', text: `Counted twice? ${dup.description || dup.category} · ${amount.toLocaleString('ro-RO', { minimumFractionDigits: 2 })} RON`, txId: dup.id, amount });
    } else {
      const way = diff > 0 ? 'money in' : 'money out';
      hints.push({ kind: 'missing', text: `A ${way} of ${amount.toLocaleString('ro-RO', { minimumFractionDigits: 2 })} RON isn’t in the app yet (or a row has the wrong amount).`, amount });
    }
  }
  const imported = inWindow.filter((t) => t.source === 'import');
  if (imported.length) {
    hints.push({ kind: 'import', text: `${imported.length} imported CSV row${imported.length === 1 ? '' : 's'} in this window: check they don’t overlap with what the bank sent.` });
  }
  return hints;
}

/**
 * { uid, lastSyncAt, ageHours, stale, added, reconcile, hints } for one account.
 * lastSyncAt: the account's own last successful fetch (lib/sync.js).
 */
export function accountTrust(state, uid, { accountOf, now = Date.now() } = {}) {
  const acc = (state?.bank?.connections || []).flatMap((c) => c.accounts || []).find((a) => a.uid === uid);
  if (!acc) return null;
  const lastSyncAt = acc.lastSyncAt || null;
  const at = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  const ageHours = Number.isNaN(at) ? null : round2((now - at) / HOUR);
  const rec = reconcile(state, uid, { accountOf });
  return {
    uid,
    lastSyncAt,
    ageHours,
    stale: ageHours == null ? null : ageHours > STALE_HOURS,
    added: Number.isFinite(acc.lastAdded) ? acc.lastAdded : null,
    reconcile: rec,
    hints: explainDifference(state, uid, rec, { accountOf }),
  };
}
