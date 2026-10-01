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

// Resolves 'auto' into 'available' or 'owed' for a credit card.
export function balanceMeaning(a) {
  if (a.balanceMeaning && a.balanceMeaning !== 'auto') return a.balanceMeaning;
  if (a.balance?.creditLimitIncluded) return 'available';
  return 'owed';
}

/**
 * { kind, cash, owed, available, limit }
 * cash: money that is really yours (0 for a credit card)
 * owed: credit-card debt (0 for other accounts)
 */
export function accountView(a) {
  const kind = accountKind(a);
  const raw = a.balance ? Number(a.balance.amount) : null;
  if (raw == null || Number.isNaN(raw)) return { kind, cash: 0, owed: 0, available: null, limit: null, known: false };
  if (kind !== 'credit') return { kind, cash: raw, owed: 0, available: null, limit: null, known: true };

  const limit = Number(a.creditLimit) > 0 ? Number(a.creditLimit) : null;
  let owed;
  if (raw < 0) owed = -raw; // reported as a negative balance: that's always debt
  else if (balanceMeaning(a) === 'available') owed = limit != null ? Math.max(limit - raw, 0) : 0;
  else owed = raw;
  owed = round2(owed);
  return { kind, cash: 0, owed, available: limit != null ? round2(Math.max(limit - owed, 0)) : null, limit, known: true };
}

export function bankTotals(accounts) {
  let cash = 0; let owed = 0;
  for (const a of accounts) {
    const v = accountView(a);
    cash += v.cash; owed += v.owed;
  }
  return { cash: round2(cash), owed: round2(owed), net: round2(cash - owed) };
}
