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

  // A CSV statement belongs to one account. Each import (batch) goes to the
  // account most of its card numbers point to — whatever was picked in the
  // import screen (a wrong pick, e.g. the savings account, used to hide a
  // whole year of current-account transactions).
  const batchOf = (t) => t.batchId || `legacy:${(t.createdAt || '').slice(0, 16)}`;
  const isRepaymentIn = (t) => t.type === 'income' && /rambursare (rata )?card/i.test(`${t.description} ${t.note || ''}`);
  const imports = (state.transactions || []).filter((t) => t.source === 'import');
  // Card numbers not seen in bank data yet: the statement with card repayments
  // coming in is the credit card's; the other statement is the current account's.
  if (card || current) {
    const digitsByBatch = new Map();
    for (const t of imports) {
      const b = batchOf(t);
      if (!digitsByBatch.has(b)) digitsByBatch.set(b, { digits: new Map(), repayments: 0 });
      const e = digitsByBatch.get(b);
      const d = cardDigitsOf(t);
      if (d) e.digits.set(d, (e.digits.get(d) || 0) + 1);
      if (isRepaymentIn(t)) e.repayments += 1;
    }
    for (const e of digitsByBatch.values()) {
      const top = [...e.digits.entries()].sort((x, y) => y[1] - x[1])[0];
      if (!top || byDigits.has(top[0])) continue;
      const target = e.repayments ? card : current;
      if (target) byDigits.set(top[0], target);
    }
  }
  const batchAccount = new Map();
  {
    const votes = new Map();
    for (const t of imports) {
      const d = cardDigitsOf(t);
      const acc = d && byDigits.get(d);
      if (!acc) continue;
      const b = batchOf(t);
      if (!votes.has(b)) votes.set(b, new Map());
      votes.get(b).set(acc.uid, (votes.get(b).get(acc.uid) || 0) + 1);
    }
    for (const [b, v] of votes) {
      const sorted = [...v.entries()].sort((x, y) => y[1] - x[1]);
      const total = sorted.reduce((n, [, c]) => n + c, 0);
      if (sorted[0][1] >= 3 && sorted[0][1] / total >= 0.8) batchAccount.set(b, accounts.get(sorted[0][0]));
    }
  }

  function accountOf(t) {
    // From the bank, or set by you in the edit form: certain.
    if (t.accountId && (t.source === 'bank' || t.accountManual)) return accounts.get(t.accountId) || null;
    // Statement text: the card number on the row, then the account of the whole statement.
    const d = cardDigitsOf(t);
    if (d && byDigits.has(d)) return byDigits.get(d);
    if (card && isRepaymentIn(t)) return card;
    if (t.source === 'import' && batchAccount.has(batchOf(t))) return batchAccount.get(batchOf(t));
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
