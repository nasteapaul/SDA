// Decides how each transaction counts in the totals.
//
// "cashflow" (default) follows the money in your current account — exactly the
// rule "what comes into the current account is income, what leaves it is
// spending", whatever the category:
//   - income   = everything coming into the current account
//   - spending = everything leaving it (paying off the credit card included)
//   - only money put towards a goal (Goals → Add money) is shown as "saved"
//   Only the MAIN current account counts (settings.mainAccountId, else the one
//   ending in 7204, else the current account with most transactions). Other
//   current accounts (e.g. Revolut), credit-card and savings-account
//   transactions are listed and analysed separately (card spending, amount
//   owed) but not added to these totals, so nothing is counted twice: a top-up
//   from the main account is the money out, what is spent from Revolut is not.
//   Refunds from shops (see refunds.js) are not income: they lower the
//   spending of the purchase's category ("refund").
// "all" adds every account together instead: card purchases are spending,
//   transfers between your own accounts (incl. card repayments) don't count.

import { accountKind } from './accounts.js';
import { round2 } from './money.js';
import { makeRefunds } from './refunds.js';

export const COUNT_MODES = {
  cashflow: 'Current account: money in = income, money out = spending',
  all: 'All accounts (card purchases count, repayments don’t)',
};

const CARD_NO = /\*{2,}\s*(\d{4})\b/;

export function cardDigitsOf(t) {
  const m = `${t.description || ''} ${t.note || ''}`.match(CARD_NO);
  return m ? m[1] : null;
}

const MAIN_DIGITS = '7204'; // the everyday ING account

/**
 * The current account whose money in/out are income/spending: the one you
 * picked (settings.mainAccountId), else the one ending in 7204 (IBAN, account
 * number or its card number), else the current account with most transactions.
 */
export function mainAccountOf(state) {
  const list = (state.bank?.connections || []).flatMap((c) => c.accounts || []);
  const currents = list.filter((a) => accountKind(a) === 'current');
  if (!currents.length) return null;
  const chosen = state.settings?.mainAccountId && currents.find((a) => a.uid === state.settings.mainAccountId);
  if (chosen) return chosen;
  if (currents.length === 1) return currents[0];
  const endsWith = (v) => String(v || '').replace(/\s/g, '').endsWith(MAIN_DIGITS);
  const byNumber = currents.find((a) => [a.iban, a.number, a.accountNumber, a.bban].some(endsWith) || (a.cardDigits || []).includes(MAIN_DIGITS));
  if (byNumber) return byNumber;
  const txs = state.transactions || [];
  const byCard = txs.find((t) => t.source === 'bank' && cardDigitsOf(t) === MAIN_DIGITS && currents.some((a) => a.uid === t.accountId));
  if (byCard) return currents.find((a) => a.uid === byCard.accountId);
  const n = new Map(currents.map((a) => [a.uid, 0]));
  for (const t of txs) if (n.has(t.accountId)) n.set(t.accountId, n.get(t.accountId) + 1);
  return currents.reduce((best, a) => (n.get(a.uid) > n.get(best.uid) ? a : best), currents[0]);
}

/**
 * A usable split: 2+ parts, each with a category and an amount > 0, adding up
 * to the transaction's amount (±0.01). Anything else counts as not split.
 */
export function hasSplits(t) {
  const list = t?.splits;
  if (!Array.isArray(list) || list.length < 2) return false;
  let sum = 0;
  for (const p of list) {
    const n = Number(p?.amount);
    if (!p?.category || !Number.isFinite(n) || n <= 0) return false;
    sum += n;
  }
  return Math.abs(sum - (Number(t.amount) || 0)) <= 0.01 + 1e-9;
}

export function makeLedger(state) {
  const list = (state.bank?.connections || []).flatMap((c) => c.accounts);
  const accounts = new Map(list.map((a) => [a.uid, a]));
  const roles = new Map(state.categories.map((c) => [c.name, c.role]));
  const mode = state.settings?.countMode === 'all' ? 'all' : 'cashflow';
  const current = mainAccountOf(state);
  const refunds = makeRefunds(state);
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

  /** Counted as the main current account (manual entries included). */
  function isMain(t) {
    const acc = accountOf(t);
    return acc ? acc === current : true;
  }

  function kindOf(t) {
    const acc = accountOf(t);
    return acc ? accountKind(acc) : 'current';
  }

  /**
   * 'income' | 'expense' | 'saved' | 'refund' | null (not counted).
   * 'refund' is money in that cancels a purchase: subtract it from the
   * spending of effect(t).category — never add it to income (use effect()).
   */
  function counts(t) {
    // In another currency and not converted to RON yet: its amount isn't RON, so it
    // can't be added up until the conversion (lib/fxconvert.js) has run.
    if (t.needsFx) return null;
    // Meal-voucher card: its own pocket of money, never part of the cash flow.
    if (t.pocket === 'vouchers') return null;
    if (mode === 'cashflow') {
      if (!isMain(t)) return null;
      if (t.goalId) return 'saved';
      if (refunds.isRefund(t)) return 'refund';
      return t.type;
    }
    const role = roles.get(t.category);
    if (role === 'repayment' || role === 'transfer') return null;
    if (role === 'savings') return 'saved';
    if (refunds.isRefund(t)) return 'refund';
    return t.type;
  }

  /**
   * How a transaction moves the totals: { as, amount, category }.
   * as: 'income' | 'expense' | 'saved' | null; amount is signed (a refund is a
   * negative expense in the purchase's category; money taken back out of a
   * goal is negative 'saved').
   */
  function effect(t) {
    return effectFor(t, counts(t));
  }

  function effectFor(t, c) {
    const amount = Number(t.amount) || 0;
    if (!c) return { as: null, amount: 0, category: t.category };
    if (c === 'refund') return { as: 'expense', amount: -amount, category: refunds.categoryOf(t) };
    if (c === 'saved') return { as: 'saved', amount: t.type === 'expense' ? amount : -amount, category: t.category };
    return { as: c, amount, category: t.category };
  }

  // Parts of an effect already worked out (c = counts(t), e = effectFor(t, c)).
  function partsOf(t, c, e) {
    if (!e.as) return [];
    if (c === 'expense' && hasSplits(t)) {
      return t.splits.map((p) => ({ category: p.category, amount: round2(Number(p.amount)) }));
    }
    return [{ category: e.category, amount: e.amount }];
  }

  /**
   * effect(t) split by category: [{ category, amount }] (signed like effect;
   * [] when not counted). A purchase split across categories (t.splits) gives
   * one part per split; anything else a single part.
   */
  function parts(t) {
    const c = counts(t);
    return partsOf(t, c, effectFor(t, c));
  }

  /** Headline numbers for a list of transactions (e.g. one period). */
  function totals(transactions) {
    const sum = { income: 0, spend: 0, saved: 0 };
    const byCategory = {};
    let count = 0;
    for (const t of transactions) {
      const c = counts(t);
      const e = effectFor(t, c);
      if (!e.as) continue;
      count += 1;
      if (e.as === 'income') sum.income += e.amount;
      else if (e.as === 'saved') sum.saved += e.amount;
      else {
        sum.spend += e.amount;
        for (const p of partsOf(t, c, e)) byCategory[p.category] = round2((byCategory[p.category] || 0) + p.amount);
      }
    }
    const income = round2(sum.income); const spend = round2(sum.spend); const saved = round2(sum.saved);
    return { income, spend, saved, left: round2(income - spend - saved), count, byCategory };
  }

  return {
    mode, counts, effect, parts, totals, accountOf, kindOf, isMain, byDigits,
    mainAccount: current,
    isRefund: (t) => refunds.isRefund(t),
    refundCategory: (t) => refunds.categoryOf(t),
  };
}
