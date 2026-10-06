// How to read a bank balance. Current and savings accounts are simple: the
// balance is your money. Credit cards are not. Depending on the bank, the
// number reported is either the credit still available (limit − spent) or
// the amount owed, so the account settings let you say which one it is.

import { round2 } from './money.js';

export const ACCOUNT_KINDS = {
  current: 'Current account',
  savings: 'Savings account',
  credit: 'Credit card',
};

export function accountKind(a) {
  if (a.kind) return a.kind;
  if (a.cashAccountType === 'CARD' || Number(a.creditLimit) > 0) return 'credit';
  if (a.cashAccountType === 'SVGS') return 'savings';
  return 'current';
}

// Balance types that report the credit still available (Enable Banking /
// Berlin Group: ITAV interim available, CLAV closing available, …AV).
export const AVAILABLE_TYPES = /AV$/i;
const LOOKS_AVAILABLE = 0.5; // a "debt" above half the limit is suspicious

// Resolves 'auto' into 'available' or 'owed' for a credit card.
export function balanceMeaning(a) {
  if (a.balanceMeaning && a.balanceMeaning !== 'auto') return a.balanceMeaning;
  if (a.balance?.creditLimitIncluded) return 'available';
  if (a.balance?.type && AVAILABLE_TYPES.test(a.balance.type)) return 'available';
  return 'owed';
}

const nameOf = (a) => a.nickname || a.name || (a.iban ? `…${String(a.iban).slice(-4)}` : '');

/**
 * { kind, cash, owed, available, limit, known, balanceUncertain, clamped?, excludedForeign? }
 * cash: money that is really yours, in RON (0 for a credit card)
 * owed: credit-card debt in RON (0 for other accounts), always 0 … limit
 * balanceUncertain: the card balance may be read the wrong way (or was
 *   clamped) — ask whether it is the amount owed or the credit available
 * excludedForeign: non-RON balance without a RON value; left out of totals
 */
export function accountView(a) {
  const kind = accountKind(a);
  const none = { kind, cash: 0, owed: 0, available: null, limit: null, known: false, balanceUncertain: false };
  const original = a.balance ? Number(a.balance.amount) : null;
  if (original == null || Number.isNaN(original)) return none;
  const currency = String(a.balance.currency || a.currency || 'RON').toUpperCase();
  let raw = original;
  if (currency !== 'RON') {
    const ron = a.balance.amountRON == null ? NaN : Number(a.balance.amountRON);
    if (!Number.isFinite(ron)) return { ...none, excludedForeign: true, amount: original, currency };
    raw = ron;
  }
  if (kind !== 'credit') return { kind, cash: round2(raw), owed: 0, available: null, limit: null, known: true, balanceUncertain: false };

  const limit = Number(a.creditLimit) > 0 ? Number(a.creditLimit) : null;
  const explicit = Boolean(a.balanceMeaning && a.balanceMeaning !== 'auto');
  const meaning = balanceMeaning(a);
  let owed;
  let uncertain = false;
  if (raw < 0) owed = -raw; // reported as a negative balance: that's always debt
  else if (meaning === 'available') {
    owed = limit != null ? limit - raw : 0;
    if (limit == null) uncertain = true; // can't work out the debt without the limit
  } else {
    owed = raw;
    // Positive, no balance type, and most of the limit: probably the credit available.
    if (!explicit && !a.balance.type && limit != null && raw > limit * LOOKS_AVAILABLE) uncertain = true;
  }
  let clamped = false;
  if (owed < 0) { owed = 0; clamped = true; }
  if (limit != null && owed > limit) { owed = limit; clamped = true; }
  owed = round2(owed);
  return {
    kind, cash: 0, owed, available: limit != null ? round2(limit - owed) : null, limit, known: true,
    balanceUncertain: uncertain || clamped, clamped,
  };
}

/**
 * { cash, owed, net } in RON, plus — only when there are any —
 * excludedForeign: [{ name, amount, currency }] balances left out (no RON value)
 * uncertain: [name] credit cards whose balance may be read the wrong way
 */
export function bankTotals(accounts) {
  let cash = 0; let owed = 0;
  const excludedForeign = []; const uncertain = [];
  for (const a of accounts) {
    const v = accountView(a);
    cash += v.cash; owed += v.owed;
    if (v.excludedForeign) excludedForeign.push({ name: nameOf(a), amount: v.amount, currency: v.currency });
    if (v.balanceUncertain) uncertain.push(nameOf(a));
  }
  const out = { cash: round2(cash), owed: round2(owed), net: round2(cash - owed) };
  if (excludedForeign.length) out.excludedForeign = excludedForeign;
  if (uncertain.length) out.uncertain = uncertain;
  return out;
}
