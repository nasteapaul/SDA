// Totals accuracy: pay-period boundaries, the main current account,
// credit-card balance meaning, foreign-currency balances, refunds and card pace.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATEGORIES as cats } from '../public/js/shared/categories.js';
import { makePeriods } from '../public/js/shared/periods.js';
import { makeLedger, mainAccountOf } from '../public/js/shared/ledger.js';
import { accountView, bankTotals, balanceMeaning } from '../public/js/shared/accounts.js';
import { isRefund, makeRefunds } from '../public/js/shared/refunds.js';
import { cardPeriod, cardPace, analyzeHistory } from '../public/js/shared/planner.js';

// ---------------------------------------------------------------- 1. periods

const salary = (date, amount = 8000) => ({ type: 'income', category: 'Salary', date, amount });

test('keyOf: late salary after the month boundary (payday 31, paid 2 Nov)', () => {
  // 31 Oct 2026 is a Saturday → expected Fri 30 Oct, the salary really came on Mon 2 Nov.
  const p = makePeriods({ payday: 31, transactions: [salary('2026-09-30'), salary('2026-11-02'), salary('2026-11-30')] });
  assert.equal(p.start('2026-10'), '2026-11-02');
  assert.equal(p.keyOf('2026-11-01'), '2026-09', 'still waiting for the October salary');
  assert.equal(p.keyOf('2026-10-31'), '2026-09');
  assert.equal(p.keyOf('2026-11-02'), '2026-10');
  assert.equal(p.keyOf('2026-11-29'), '2026-10');
  assert.equal(p.keyOf('2026-11-30'), '2026-11');
  assert.equal(p.end('2026-09'), '2026-11-01');
});

test('keyOf: early salary before the month boundary', () => {
  // payday 1: November salary paid on 29 Oct.
  const p = makePeriods({ payday: 1, transactions: [salary('2026-10-01'), salary('2026-10-29')] });
  assert.equal(p.start('2026-11'), '2026-10-29');
  assert.equal(p.keyOf('2026-10-28'), '2026-10');
  assert.equal(p.keyOf('2026-10-29'), '2026-11');
  assert.equal(p.keyOf('2026-10-31'), '2026-11');
  assert.equal(p.keyOf('2026-11-15'), '2026-11');
});

test('keyOf: weekend shifts without salary data', () => {
  // payday 10: 10 Oct 2026 is a Saturday → Fri 9 Oct; 10 Jan 2027 is a Sunday → Mon 11 Jan.
  const p = makePeriods({ payday: 10 });
  assert.equal(p.start('2026-10'), '2026-10-09');
  assert.equal(p.keyOf('2026-10-08'), '2026-09');
  assert.equal(p.keyOf('2026-10-09'), '2026-10');
  assert.equal(p.start('2027-01'), '2027-01-11');
  assert.equal(p.keyOf('2027-01-10'), '2026-12');
  assert.equal(p.keyOf('2027-01-11'), '2027-01');
  // payday 31 in a 30-day month and February
  const q = makePeriods({ payday: 31 });
  // February 2027: 31 → 28 Feb, a Sunday → Mon 1 March.
  assert.equal(q.start('2027-02'), '2027-03-01');
  assert.equal(q.keyOf('2027-02-28'), '2027-01');
  assert.equal(q.keyOf('2027-03-01'), '2027-02');
  assert.equal(q.keyOf('2027-03-30'), '2027-02');
  assert.equal(q.keyOf('2027-03-31'), '2027-03');
});

test('keyOf: per-month overrides, late and early', () => {
  const p = makePeriods({ payday: 25, overrides: { '2026-10': '2026-11-03', '2026-12': '2026-12-18' } });
  assert.equal(p.keyOf('2026-11-02'), '2026-09', 'October salary set to 3 Nov');
  assert.equal(p.keyOf('2026-11-03'), '2026-10');
  assert.equal(p.keyOf('2026-12-17'), '2026-11');
  assert.equal(p.keyOf('2026-12-18'), '2026-12', 'December salary paid before Christmas');
  // Every day maps to the period whose range contains it.
  for (let d = new Date(2026, 8, 1); d < new Date(2027, 1, 1); d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const k = p.keyOf(iso);
    assert.ok(p.start(k) <= iso && iso <= p.end(k), `${iso} in ${k}`);
  }
});

// ------------------------------------------------------- 2. main current account

const accountsState = (extra = [], settings = {}) => ({
  bank: { connections: [{ accounts: [
    { uid: 'ing', iban: 'RO34INGB0000999908415340', name: 'Dan Paul Nastea', kind: 'current', cardDigits: ['7204'] },
    { uid: 'card', iban: 'RO31INGB0000999918061462', kind: 'credit', creditLimit: 9900 },
    ...extra,
  ] }] },
  categories: cats,
  settings,
  transactions: [],
});
const revolut = { uid: 'rev', iban: 'LT123250012345678901', name: 'Revolut', kind: 'current' };

test('cashflow: only the main current account counts (ING 7204 + Revolut)', () => {
  const s = accountsState([revolut]);
  const L = makeLedger(s);
  assert.equal(L.mainAccount.uid, 'ing');
  assert.equal(L.counts({ accountId: 'ing', source: 'bank', type: 'expense', category: 'Transfers', amount: 200 }), 'expense', 'money leaving ING to Revolut is out');
  assert.equal(L.counts({ accountId: 'rev', source: 'bank', type: 'income', category: 'Transfers', amount: 200 }), null, 'arriving on Revolut is not income');
  assert.equal(L.counts({ accountId: 'rev', source: 'bank', type: 'expense', category: 'Eating out', amount: 50 }), null, 'Revolut spending is paid via the top-up');
  assert.equal(L.counts({ type: 'expense', category: 'Groceries' }), 'expense', 'manual entries → main account');
  assert.equal(L.isMain({ accountId: 'rev', source: 'bank' }), false);
});

test('main account: setting wins, then 7204, then most transactions', () => {
  assert.equal(makeLedger(accountsState([revolut], { mainAccountId: 'rev' })).mainAccount.uid, 'rev');
  assert.equal(makeLedger(accountsState([revolut], { mainAccountId: 'gone' })).mainAccount.uid, 'ing', 'unknown id ignored');
  const ibanEnds = { bank: { connections: [{ accounts: [revolut, { uid: 'x', kind: 'current', iban: 'RO00BANK0000000000007204' }] }] }, categories: cats, settings: {}, transactions: [] };
  assert.equal(mainAccountOf(ibanEnds).uid, 'x');
  const busy = {
    bank: { connections: [{ accounts: [{ uid: 'a', kind: 'current' }, { uid: 'b', kind: 'current' }] }] },
    categories: cats,
    settings: {},
    transactions: [{ accountId: 'b', source: 'bank' }, { accountId: 'b', source: 'bank' }, { accountId: 'a', source: 'bank' }],
  };
  assert.equal(mainAccountOf(busy).uid, 'b');
  assert.equal(mainAccountOf({ bank: { connections: [] }, transactions: [] }), null);
});

test('single current account: behaviour unchanged', () => {
  const L = makeLedger(accountsState());
  assert.equal(L.counts({ accountId: 'ing', source: 'bank', type: 'income', category: 'Transfers' }), 'income');
  assert.equal(L.counts({ accountId: 'card', source: 'bank', type: 'expense', category: 'Groceries' }), null);
});

// ------------------------------------------------------ 3. credit card balance

test('available-type balances (ITAV, CLAV) mean available credit', () => {
  const v = accountView({ kind: 'credit', creditLimit: 5000, balance: { amount: 4200, type: 'ITAV' } });
  assert.equal(v.owed, 800);
  assert.equal(v.available, 4200);
  assert.equal(balanceMeaning({ balance: { type: 'CLAV' } }), 'available');
  assert.equal(balanceMeaning({ balance: { type: 'CLBD' } }), 'owed');
  assert.equal(v.balanceUncertain, false);
});

test('a positive balance that looks like available credit is flagged uncertain', () => {
  const v = accountView({ kind: 'credit', creditLimit: 5000, balance: { amount: 4200 } });
  assert.equal(v.balanceUncertain, true);
  assert.equal(accountView({ kind: 'credit', creditLimit: 5000, balance: { amount: 1000 } }).balanceUncertain, false);
  assert.equal(accountView({ kind: 'credit', creditLimit: 5000, balanceMeaning: 'owed', balance: { amount: 4200 } }).balanceUncertain, false, 'you said what it is');
});

test('owed is clamped to 0..limit and flagged', () => {
  const over = accountView({ kind: 'credit', creditLimit: 5000, balanceMeaning: 'owed', balance: { amount: 6000 } });
  assert.equal(over.owed, 5000);
  assert.equal(over.balanceUncertain, true);
  assert.equal(over.clamped, true);
  const avail = accountView({ kind: 'credit', creditLimit: 5000, balanceMeaning: 'available', balance: { amount: 7000 } });
  assert.equal(avail.owed, 0);
  assert.equal(avail.clamped, true);
});

// --------------------------------------------------------- 4. foreign balances

test('non-RON balances are converted with amountRON or excluded', () => {
  const t = bankTotals([
    { name: 'ING', balance: { amount: 1000, currency: 'RON' } },
    { name: 'Revolut EUR', balance: { amount: 100, currency: 'EUR', amountRON: 497.71 } },
    { name: 'Revolut USD', balance: { amount: 50, currency: 'USD' } },
  ]);
  assert.equal(t.cash, 1497.71);
  assert.deepEqual(t.excludedForeign, [{ name: 'Revolut USD', amount: 50, currency: 'USD' }]);
  const v = accountView({ name: 'Revolut USD', balance: { amount: 50, currency: 'USD' } });
  assert.equal(v.cash, 0);
  assert.equal(v.excludedForeign, true);
  assert.deepEqual(bankTotals([{ balance: { amount: 5 } }]), { cash: 5, owed: 0, net: 5 }, 'no currency = RON');
});

// ---------------------------------------------------------------- 5. refunds

const refundState = () => {
  const s = accountsState();
  s.transactions = [
    { id: 'e1', accountId: 'ing', source: 'bank', type: 'expense', amount: 300, date: '2026-09-05', category: 'Shopping', description: 'EMAG.RO' },
    { id: 'r1', accountId: 'ing', source: 'bank', type: 'income', amount: 120, date: '2026-09-20', category: 'Other income', description: 'EMAG.RO' },
    { id: 'r2', accountId: 'ing', source: 'bank', type: 'income', amount: 40, date: '2026-09-21', category: 'Other income', description: 'Retur marfa ZARA' },
    { id: 'big', accountId: 'ing', source: 'bank', type: 'income', amount: 500, date: '2026-09-22', category: 'Other income', description: 'EMAG.RO' },
    { id: 'old', accountId: 'ing', source: 'bank', type: 'income', amount: 50, date: '2026-12-20', category: 'Other income', description: 'EMAG.RO' },
    { id: 'sal', accountId: 'ing', source: 'bank', type: 'income', amount: 8000, date: '2026-09-10', category: 'Salary', description: 'H Essers SRL' },
    { id: 'rep', accountId: 'card', source: 'bank', type: 'income', amount: 1000, date: '2026-09-11', category: 'Transfers', description: 'Rambursare rata card credit' },
    { id: 'ce', accountId: 'card', source: 'bank', type: 'expense', amount: 200, date: '2026-09-02', category: 'Travel', description: 'BOOKING.COM' },
    { id: 'cr', accountId: 'card', source: 'bank', type: 'income', amount: 200, date: '2026-09-15', category: 'Other income', description: 'Stornare BOOKING.COM' },
  ];
  return s;
};
const byId = (s, id) => s.transactions.find((t) => t.id === id);

test('isRefund: text and same-merchant matches', () => {
  const s = refundState();
  assert.equal(isRefund(byId(s, 'r1'), s), true, 'same merchant, smaller, within 60 days');
  assert.equal(isRefund(byId(s, 'r2'), s), true, 'retur in the text');
  assert.equal(isRefund(byId(s, 'cr'), s), true, 'stornare');
  assert.equal(isRefund(byId(s, 'big'), s), false, 'more than was spent');
  assert.equal(isRefund(byId(s, 'old'), s), false, 'more than 60 days later');
  assert.equal(isRefund(byId(s, 'sal'), s), false);
  assert.equal(isRefund(byId(s, 'rep'), s), false, 'card repayment is not a refund');
  assert.equal(isRefund(byId(s, 'e1'), s), false, 'expenses never are');
  assert.equal(isRefund({ type: 'income', amount: 10, date: '2026-09-01', description: 'x', category: 'Refunds' }, s), true);
  assert.equal(makeRefunds(s).categoryOf(byId(s, 'r1')), 'Shopping', "the purchase's category");
  assert.equal(makeRefunds(s).categoryOf(byId(s, 'cr')), 'Travel');
});

test('refunds reduce category spending instead of counting as income', () => {
  const s = refundState();
  const L = makeLedger(s);
  assert.equal(L.counts(byId(s, 'r1')), 'refund');
  assert.deepEqual(L.effect(byId(s, 'r1')), { as: 'expense', amount: -120, category: 'Shopping' });
  assert.deepEqual(L.effect(byId(s, 'sal')), { as: 'income', amount: 8000, category: 'Salary' });
  assert.equal(L.effect(byId(s, 'cr')).as, null, 'card refunds are outside cash-flow totals');
  const t = L.totals(s.transactions.filter((x) => x.date < '2026-10-01'));
  assert.equal(t.income, 8500, 'salary + the 500 that is not a refund');
  assert.equal(t.spend, 300 - 120 - 40);
  assert.equal(t.byCategory.Shopping, 180);
  assert.equal(t.left, 8500 - 140);
  const all = makeLedger({ ...s, settings: { countMode: 'all' } });
  assert.equal(all.totals([byId(s, 'ce'), byId(s, 'cr')]).spend, 0, 'card purchase fully refunded');
});

test('card: a refund is not "repaid"', () => {
  const s = refundState();
  const onCard = s.transactions.filter((t) => t.accountId === 'card');
  const r = makeRefunds(s);
  const p = cardPeriod(onCard, { isRefund: r.isRefund, refundCategory: r.categoryOf });
  assert.equal(cardPeriod(onCard).repaid, 1200, 'without refund detection everything in is "repaid"');
  assert.equal(p.repaid, 1000);
  assert.equal(p.spent, 0, '200 spent − 200 refunded');
  assert.equal(p.refunded, 200);
  assert.deepEqual(p.cats, { Travel: 0 });
  assert.equal(p.count, 3);
});

// -------------------------------------------------------------- 6. card pace

test('card pace divides by the periods actually present', () => {
  const pace = cardPace([{ spent: 600, repaid: 900, count: 4 }, { spent: 0, repaid: 0, count: 0 }, { spent: 0, repaid: 0, count: 0 }]);
  assert.equal(pace.periods, 1);
  assert.equal(pace.avgSpent, 600);
  assert.equal(pace.avgRepaid, 900);
  assert.equal(pace.net, 300);
  const firstKnown = cardPace([{ key: '2026-09', spent: 300, repaid: 300, count: 2 }, { key: '2026-08', spent: 0, repaid: 0, count: 0 }, { key: '2026-07', spent: 0, repaid: 0, count: 0 }], { firstKey: '2026-07' });
  assert.equal(firstKnown.periods, 3, 'quiet months after data started still count');
  assert.equal(cardPace([]).periods, 1, 'min 1');
});

test('analyzeHistory: a refund passed as a negative expense lowers the category', () => {
  const a = analyzeHistory([
    { type: 'expense', amount: 300, date: '2026-08-05', category: 'Shopping', description: 'EMAG' },
    { type: 'expense', amount: -100, date: '2026-08-20', category: 'Shopping', description: 'EMAG' },
  ], cats, { today: '2026-09-15', months: 1 });
  const shop = a.categories.find((c) => c.name === 'Shopping');
  assert.equal(shop.avg, 200);
  assert.equal(shop.perMonthCount, 1);
  assert.equal(shop.smallPerMonth, 0);
});
