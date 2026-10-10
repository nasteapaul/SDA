// Recognises refunds and chargebacks: money coming back from a shop is not
// earned income — it cancels (part of) an earlier purchase. In the totals a
// refund lowers the spending of the purchase's category instead.
//
// A transaction is a refund when it is money in and
//   - its category is "Refunds", or
//   - its text says so (retur, refund, rambursare comerciant, storno, chargeback…), or
//   - the same merchant took at least that much from the same account in the
//     60 days before.

import { merchantKey } from './categories.js';
import { todayISO } from './money.js';

export const REFUND_RE = /retur|refund|rambursare comerciant|stornare|storno|chargeback|reversal/i;
const NOT_REFUND_RE = /rambursare (rata )?card/i; // paying off the credit card
const WINDOW_DAYS = 60;
const DAY = 86400000;

const textOf = (t) => `${t.description || ''} ${t.note || ''}`;
const REFUND_G = new RegExp(REFUND_RE.source, 'gi');
const keyMemo = new WeakMap();
const keyOf = (t) => {
  let k = keyMemo.get(t);
  if (k === undefined) { REFUND_G.lastIndex = 0; k = merchantKey(textOf(t).replace(REFUND_G, ' ')); keyMemo.set(t, k); }
  return k;
};
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

function excluded(t, roles) {
  if (t.type !== 'income' || t.goalId) return true;
  if (t.category === 'Salary' || roles.get(t.category)) return true; // transfers, repayments, savings
  return NOT_REFUND_RE.test(textOf(t));
}

/** Builds the refund lookup for a state once ({ isRefund, categoryOf, purchaseOf }). */
export function makeRefunds(state) {
  const roles = new Map((state.categories || []).map((c) => [c.name, c.role]));
  const kinds = new Map((state.categories || []).map((c) => [c.name, c.kind]));
  const byMerchant = new Map();
  for (const t of state.transactions || []) {
    if (t.type !== 'expense' || t.goalId || !t.date || roles.get(t.category)) continue;
    const k = keyOf(t);
    if (!k) continue;
    if (!byMerchant.has(k)) byMerchant.set(k, []);
    byMerchant.get(k).push(t);
  }

  // The purchase a refund belongs to: same merchant (and account, when both
  // are known), up to 60 days before; one at least as big when there is one.
  const purchaseMemo = [new WeakMap(), new WeakMap()];
  function purchaseOf(t, opts = {}) {
    const memo = purchaseMemo[opts.needCover ? 1 : 0];
    if (memo.has(t)) return memo.get(t);
    const p = findPurchase(t, opts);
    memo.set(t, p);
    return p;
  }
  function findPurchase(t, { needCover = false } = {}) {
    const k = t.date && keyOf(t);
    if (!k || !byMerchant.has(k)) return null;
    const amount = Number(t.amount) || 0;
    const candidates = byMerchant.get(k).filter((e) => {
      const d = daysBetween(e.date, t.date);
      if (d < 0 || d > WINDOW_DAYS) return false;
      return !(t.accountId && e.accountId && t.accountId !== e.accountId);
    }).sort((a, b) => b.date.localeCompare(a.date));
    const covering = candidates.find((e) => Number(e.amount) + 0.005 >= amount);
    return covering || (needCover ? null : candidates[0] || null);
  }

  const isRefundMemo = new WeakMap();
  function isRefund(t) {
    if (!t || excluded(t, roles)) return false;
    if (typeof t === 'object' && isRefundMemo.has(t)) return isRefundMemo.get(t);
    const r = t.category === 'Refunds' || REFUND_RE.test(textOf(t)) || Boolean(purchaseOf(t, { needCover: true }));
    if (typeof t === 'object') isRefundMemo.set(t, r);
    return r;
  }

  // Category whose spending the refund lowers.
  const catMemo = new WeakMap();
  function categoryOf(t) {
    if (catMemo.has(t)) return catMemo.get(t);
    const p = purchaseOf(t);
    const c = p?.category ? p.category : (t.category && kinds.get(t.category) !== 'income' ? t.category : 'Other');
    catMemo.set(t, c);
    return c;
  }

  return { isRefund, categoryOf, purchaseOf };
}

const cache = new WeakMap();
function cached(state) {
  const key = state.transactions || state;
  const n = state.transactions?.length || 0;
  const hit = cache.get(key);
  if (!hit || hit.state !== state || hit.n !== n) cache.set(key, { state, n, r: makeRefunds(state) });
  return cache.get(key).r;
}

/** True when `t` is money back from a shop (see above), not earned income. */
export function isRefund(t, state) {
  return cached(state).isRefund(t);
}

/**
 * Purchases you marked "refund expected by" (t.refundDue) and whether the money
 * came back: [{ tx, due, status: 'waiting'|'overdue'|'received', refund }] by due date.
 * Received = a refund the app links to that purchase, or money back from the same
 * merchant after it (at most the purchase's amount).
 */
export function expectedRefunds(state, { today = todayISO() } = {}) {
  const r = cached(state);
  const marked = (state.transactions || []).filter((t) => t.type === 'expense' && typeof t.refundDue === 'string' && t.refundDue);
  if (!marked.length) return [];
  const backs = (state.transactions || []).filter((t) => t.type === 'income' && r.isRefund(t));
  const used = new Set();
  return marked.sort((a, b) => a.refundDue.localeCompare(b.refundDue)).map((tx) => {
    const k = keyOf(tx);
    const refund = backs.find((b) => !used.has(b.id) && r.purchaseOf(b) === tx)
      || backs.find((b) => !used.has(b.id) && k && keyOf(b) === k && b.date >= tx.date && Number(b.amount) <= Number(tx.amount) + 0.005)
      || null;
    if (refund) used.add(refund.id);
    const status = refund ? 'received' : today > tx.refundDue ? 'overdue' : 'waiting';
    return { tx, due: tx.refundDue, status, refund };
  });
}
