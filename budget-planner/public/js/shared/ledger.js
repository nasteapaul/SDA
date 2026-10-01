// Decides how each transaction counts in the totals.
//
// "cashflow" (default) follows the money in your current account — exactly the
// rule "what comes into the current account is income, what leaves it is
// spending", whatever the category:
//   - income   = everything coming into the current account
//   - spending = everything leaving it (paying off the credit card included)
//   - only money put towards a goal (Goals → Add money) is shown as "saved"
//   Credit-card and savings-account transactions are listed and analysed
//   separately (card spending, amount owed) but not added to these totals, so
//   nothing is counted twice.
// "all" adds every account together instead: card purchases are spending,
//   transfers between your own accounts (incl. card repayments) don't count.

import { accountKind } from './accounts.js';

export const COUNT_MODES = {
  cashflow: 'Current account: money in = income, money out = spending',
  all: 'All accounts (card purchases count, repayments don’t)',
};

const CARD_NO = /\*{2,}\s*(\d{4})\b/;

export function cardDigitsOf(t) {
  const m = `${t.description || ''} ${t.note || ''}`.match(CARD_NO);
  return m ? m[1] : null;
}

export function makeLedger(state) {
  const list = (state.bank?.connections || []).flatMap((c) => c.accounts);
  const accounts = new Map(list.map((a) => [a.uid, a]));
  const roles = new Map(state.categories.map((c) => [c.name, c.role]));
  const mode = state.settings?.countMode === 'all' ? 'all' : 'cashflow';
  const current = list.find((a) => accountKind(a) === 'current');
  const card = list.find((a) => accountKind(a) === 'credit');

  // Which card number belongs to which account: set by you on the account,
  // otherwise learnt from bank-synced transactions ("Card number, **** 7204").
  const byDigits = new Map();
  for (const a of list) for (const d of a.cardDigits || []) byDigits.set(d, a);
  for (const t of state.transactions || []) {
    if (t.source !== 'bank' || !t.accountId) continue;
    const d = cardDigitsOf(t);
    if (d && !byDigits.has(d) && accounts.has(t.accountId)) byDigits.set(d, accounts.get(t.accountId));
  }

  function accountOf(t) {
    // Known for sure: from the bank, picked by you when importing, or set in the edit form.
    if (t.accountId && (t.source === 'bank' || t.accountManual || t.accountChosen)) return accounts.get(t.accountId) || null;
    // Otherwise the clues in the statement text beat any earlier guess.
    const d = cardDigitsOf(t);
    if (d && byDigits.has(d)) return byDigits.get(d); // the card number is the most reliable clue
    if (card && t.type === 'income' && /rambursare (rata )?card/i.test(`${t.description} ${t.note || ''}`)) return card;
    if (t.accountId && accounts.has(t.accountId)) return accounts.get(t.accountId);
    return current || null; // manual entries and unknown imports: your everyday account
  }

  function kindOf(t) {
    const acc = accountOf(t);
    return acc ? accountKind(acc) : 'current';
  }

  /** 'income' | 'expense' | 'saved' | null (not counted) */
  function counts(t) {
    const kind = kindOf(t);
    if (mode === 'cashflow') {
      if (kind !== 'current') return null;
      if (t.goalId) return 'saved';
      return t.type;
    }
    const role = roles.get(t.category);
    if (role === 'repayment' || role === 'transfer') return null;
    if (role === 'savings') return 'saved';
    return t.type;
  }

  return { mode, counts, accountOf, kindOf, byDigits };
}
