// Decides how each transaction counts in the totals.
//
// "cashflow" (default) follows the money in your current account:
//   income   = everything coming into the current account (salary, and money
//              you move in from Revolut / cash deposits — shown separately)
//   spending = everything going out of it, including paying off the credit card
//   so "left over" is exactly how much the current account balance changed.
//   Credit-card and savings-account transactions are listed but not added up
//   (card purchases are paid for by the repayment; counting both would double them).
// "all" adds every account together instead: card purchases are spending,
//   and transfers between your own accounts (incl. card repayments) don't count.

import { accountKind } from './accounts.js';

export const COUNT_MODES = {
  cashflow: 'Current account: money in = income, money out = spending',
  all: 'All accounts (card purchases count, repayments don’t)',
};

export function makeLedger(state) {
  const accounts = new Map((state.bank?.connections || []).flatMap((c) => c.accounts).map((a) => [a.uid, a]));
  const roles = new Map(state.categories.map((c) => [c.name, c.role]));
  const mode = state.settings?.countMode === 'all' ? 'all' : 'cashflow';

  function accountOf(t) {
    return t.accountId ? accounts.get(t.accountId) : null;
  }

  /** 'income' | 'expense' | 'saved' | null (not counted) */
  function counts(t) {
    const role = roles.get(t.category);
    const acc = accountOf(t);
    const kind = acc ? accountKind(acc) : 'current'; // manual entries: your everyday money
    if (mode === 'cashflow' && kind !== 'current') return null;
    if (mode === 'all' && (role === 'repayment' || role === 'transfer')) return null;
    if (role === 'savings') return 'saved';
    return t.type;
  }

  return { mode, counts, accountOf };
}
