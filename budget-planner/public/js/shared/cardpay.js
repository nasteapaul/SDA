// Credit card: pays the card from the current account are matched with the
// money arriving on the card, so a repayment is counted once even when only
// one side is in the app (e.g. the card's CSV statement is missing). Interest
// and fees are shown apart as the cost of the credit.
// Pure: no DOM, used by the browser and by Node.

import { round2 } from './money.js';

const DAY = 86400000;
const FEES_RE = /dobanda|dobanzi|dobânda|dobânzi|interest|comision|fee\b|taxa (anuala|administrare|lunara)/i;
export const FEES_CATEGORY = 'Interest & fees';

const gap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const median = (nums) => { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function roleOf(state, name) {
  return (state.categories || []).find((c) => c.name === name)?.role;
}

/** Repayments leaving the main current account (category with role 'repayment'). */
function outsOf(state, ledger) {
  return (state.transactions || []).filter((t) => t.type === 'expense' && !t.goalId && !t.needsFx
    && roleOf(state, t.category) === 'repayment' && ledger.isMain(t) && ledger.kindOf(t) === 'current');
}

/** Money arriving on the credit card that isn't a shop refund. */
function insOf(state, ledger) {
  return (state.transactions || []).filter((t) => t.type === 'income' && !t.goalId && !t.needsFx
    && ledger.kindOf(t) === 'credit' && !ledger.isRefund(t));
}

/**
 * { pairs: [{ out, in }], unpairedIn: [tx] }. Each repayment from the current
 * account (out) gets the card-side entry of the same amount within windowDays
 * (closest date first), or in: null when the card side isn't in the app.
 */
export function pairRepayments(state, ledger, { windowDays = 5 } = {}) {
  const outs = outsOf(state, ledger).sort((a, b) => a.date.localeCompare(b.date));
  const ins = insOf(state, ledger);
  const taken = new Set();
  const pairs = outs.map((out) => {
    const match = ins.filter((i) => !taken.has(i.id) && Math.abs(Number(i.amount) - Number(out.amount)) <= 0.01 + 1e-9 && gap(i.date, out.date) <= windowDays)
      .sort((a, b) => gap(a.date, out.date) - gap(b.date, out.date))[0] || null;
    if (match) taken.add(match.id);
    return { out, in: match };
  });
  return { pairs, unpairedIn: ins.filter((i) => !taken.has(i.id)) };
}

/**
 * Paid towards the card in period `key`, each repayment once:
 * { total, items: [{ date, amount, out, in }] }. A pair counts on the day it left the current account.
 */
export function repaidInPeriod(state, ledger, keyOf, key) {
  const { pairs, unpairedIn } = pairRepayments(state, ledger);
  const items = [];
  for (const p of pairs) if (keyOf(p.out.date) === key) items.push({ date: p.out.date, amount: Number(p.out.amount), out: p.out, in: p.in });
  for (const i of unpairedIn) if (keyOf(i.date) === key) items.push({ date: i.date, amount: Number(i.amount), out: null, in: i });
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { total: round2(items.reduce((n, x) => n + x.amount, 0)), items };
}

const isFee = (t) => t.category === FEES_CATEGORY || FEES_RE.test(`${t.description || ''} ${t.note || ''}`);

/** Interest and fees charged on the card: { total, items, avg3 } (avg3 = the 3 periods before). */
export function creditCost(state, ledger, keyOf, key) {
  const fees = (state.transactions || []).filter((t) => t.type === 'expense' && !t.needsFx && ledger.kindOf(t) === 'credit' && isFee(t));
  const sumIn = (k) => round2(fees.filter((t) => keyOf(t.date) === k).reduce((n, t) => n + Number(t.amount), 0));
  const items = fees.filter((t) => keyOf(t.date) === key);
  const [y, m] = key.split('-').map(Number);
  const prev = [1, 2, 3].map((i) => { const d = new Date(y, m - 1 - i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  return { total: sumIn(key), items, avg3: round2(prev.reduce((n, k) => n + sumIn(k), 0) / 3) };
}

/**
 * The card repayment still expected from the current account this period:
 * { min, max, date } when you repaid in at least 2 of the last 3 periods and not
 * yet in this one (date = this period's start + your usual number of days), else null.
 */
export function cardDue(state, ledger, periods, today) {
  const key = periods.keyOf(today);
  const outs = outsOf(state, ledger);
  if (outs.some((t) => periods.keyOf(t.date) === key)) return null;
  const [y, m] = key.split('-').map(Number);
  const prevKeys = [1, 2, 3].map((i) => { const d = new Date(y, m - 1 - i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const perPeriod = prevKeys.map((k) => outs.filter((t) => periods.keyOf(t.date) === k)).filter((list) => list.length);
  if (perPeriod.length < 2) return null;
  const totals = perPeriod.map((list) => round2(list.reduce((n, t) => n + Number(t.amount), 0)));
  const offsets = perPeriod.map((list) => {
    const k = periods.keyOf(list[0].date);
    return Math.round((Date.parse(list[0].date) - Date.parse(periods.start(k))) / DAY);
  });
  const start = periods.start(key);
  const [sy, sm, sd] = start.split('-').map(Number);
  const d = new Date(sy, sm - 1, sd + Math.max(0, Math.round(median(offsets))));
  let date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = periods.end(key);
  if (date > end) date = end;
  if (date < today) date = today;
  return { min: Math.min(...totals), max: Math.max(...totals), date };
}
