// Money-logic fixes: "Not linked" rows, card fees, late bills keeping their due
// date, pending payments not counted twice, a late salary, a partly repaid
// card, cash withdrawals, Banca Transilvania text, DST-safe period ends, bank
// rows keeping the bank's amount/date, and the period calendar's bill details.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../lib/store.js';
import { pendingItemsOf } from '../lib/sync.js';
import { cleanTransaction } from '../lib/validate.js';
import { makeLedger } from '../public/js/shared/ledger.js';
import { creditCost, cardDue } from '../public/js/shared/cardpay.js';
import { detectSeries, upcoming, dropPending } from '../public/js/shared/recurring.js';
import { buildAlerts } from '../public/js/shared/alerts.js';
import { makePeriods } from '../public/js/shared/periods.js';
import { merchantKey, categorize } from '../public/js/shared/categories.js';
import { periodCalendar } from '../public/js/shared/safespend.js';

let n = 0;
const tx = (o) => ({ id: `t${++n}`, source: 'bank', accountId: 'cur', type: 'expense', category: 'Other', description: 'x', createdAt: '2026-01-01T00:00:00Z', ...o });
const charges = (description, category, rows, extra = {}) => rows.map(([date, amount]) => tx({ date, amount, description, category, ...extra }));

function linked({ balance = { amount: 1000, currency: 'RON', type: 'CLBD' }, payday = null, pendingItems } = {}) {
  const s = emptyState();
  if (payday) s.settings.payday = payday;
  s.bank.lastSync = '2026-10-10T08:00:00Z';
  s.bank.connections = [{ sessionId: 's', bank: 'ING', validUntil: '2026-12-30T10:00:00Z', accounts: [
    { uid: 'cur', iban: 'RO00INGB0000999900007204', currency: 'RON', kind: 'current', balance, ...(pendingItems ? { pendingItems } : {}) },
    { uid: 'card', iban: 'RO00INGB0000999900008391', currency: 'RON', kind: 'credit', creditLimit: 5000, balanceMeaning: 'owed', balance: { amount: 1200, currency: 'RON' } },
  ] }];
  return s;
}
const NOW = Date.parse('2026-10-10T09:00:00Z');

test('ledger: "Not linked (cash / other)" is not the main account; plain manual rows still are', () => {
  const s = linked();
  const cash = tx({ source: 'manual', accountId: null, accountManual: true, amount: 400, date: '2026-10-02', category: 'Cash' });
  const plain = tx({ source: 'manual', accountId: undefined, amount: 50, date: '2026-10-02', category: 'Groceries' });
  s.transactions = [cash, plain];
  const L = makeLedger(s);
  assert.equal(L.isMain(cash), false);
  assert.equal(L.accountOf(cash), null);
  assert.equal(L.counts(cash), null, 'not in the cash flow');
  assert.equal(L.isMain(plain), true);
  assert.equal(L.accountOf(plain).uid, 'cur');
  assert.equal(L.totals(s.transactions).spend, 50);
});

test('cardpay: "COFFEE" is not a fee; interest, fees and commissions still are', () => {
  const s = linked();
  s.transactions = [
    tx({ accountId: 'card', amount: 18.5, date: '2026-09-12', description: 'STARBUCKS COFFEE', category: 'Eating out' }),
    tx({ accountId: 'card', amount: 9.3, date: '2026-09-20', description: 'Dobanda debitoare', category: 'Other' }),
    tx({ accountId: 'card', amount: 5, date: '2026-09-21', description: 'Comision administrare', category: 'Other' }),
    tx({ accountId: 'card', amount: 25, date: '2026-09-22', description: 'Annual fee', category: 'Other' }),
    tx({ accountId: 'card', amount: 10, date: '2026-09-23', description: 'Taxa anuala card', category: 'Other' }),
  ];
  const cost = creditCost(s, makeLedger(s), (d) => d.slice(0, 7), '2026-09');
  assert.deepEqual(cost.items.map((t) => t.description), ['Dobanda debitoare', 'Comision administrare', 'Annual fee', 'Taxa anuala card']);
  assert.equal(cost.total, 49.3);
});

const netflix = () => charges('NETFLIX.COM', 'Subscriptions', [['2026-07-05', 55.99], ['2026-08-05', 55.99], ['2026-09-05', 55.99]]);

test('upcoming: a late bill keeps its real due date; one due today is not late', () => {
  const series = detectSeries({ ...emptyState(), transactions: netflix() }, { today: '2026-10-07' });
  const [late] = upcoming(series, '2026-10-07', '2026-10-10');
  assert.deepEqual([late.date, late.due, late.late], ['2026-10-07', '2026-10-05', true]);
  const [today] = upcoming(series, '2026-10-05', '2026-10-10');
  assert.deepEqual([today.date, today.due, today.late], ['2026-10-05', '2026-10-05', false]);
  const [next] = upcoming(series, '2026-10-01', '2026-10-10');
  assert.deepEqual([next.date, next.due, next.late], ['2026-10-05', '2026-10-05', false]);
});

test('alerts: a late bill has one id from day to day and says when it was due', () => {
  const s = linked();
  s.transactions = netflix();
  const bills = (today) => buildAlerts(s, { today, now: Date.parse(`${today}T09:00:00Z`) }).filter((a) => a.kind === 'bill');
  const ids = new Set();
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
    const [a] = bills(day);
    ids.add(a.id);
    if (day === '2026-10-05') assert.match(a.title, /today$/, 'due today is not late');
    else assert.match(a.title, /was due on 5 Oct/);
  }
  assert.deepEqual([...ids], ['bill:netflix com:2026-10-05']);
});

test('dropPending: a late/today bill already pending at the bank is not due again', () => {
  const series = detectSeries({ ...emptyState(), transactions: [
    ...netflix(),
    ...charges('ENEL ENERGIE', 'Utilities', [['2026-07-06', 200], ['2026-08-06', 210], ['2026-09-06', 230]]),
  ] }, { today: '2026-10-07' });
  const list = upcoming(series, '2026-10-07', '2026-11-10');
  assert.deepEqual(list.map((u) => [u.key, u.due]), [['enel energie', '2026-10-06'], ['netflix com', '2026-10-05'], ['netflix com', '2026-11-05'], ['enel energie', '2026-11-06']]);
  // By merchant: the November Netflix stays.
  const byName = dropPending(list, [{ amount: 55.99, description: 'NETFLIX.COM', date: '2026-10-06' }], '2026-10-07');
  assert.deepEqual(byName.map((u) => [u.key, u.due]), [['enel energie', '2026-10-06'], ['netflix com', '2026-11-05'], ['enel energie', '2026-11-06']]);
  // By amount (within 5% of the bill's range), the merchant text unknown.
  const byAmount = dropPending(list, [{ amount: 240, description: 'PLATA FACTURA', date: '2026-10-07' }], '2026-10-07');
  assert.ok(!byAmount.some((u) => u.key === 'enel energie' && u.due === '2026-10-06'));
  assert.equal(byAmount.length, 3);
  // Too far off, too old, another currency or nothing pending: nothing dropped.
  assert.equal(dropPending(list, [{ amount: 300, description: 'X SHOP', date: '2026-10-07' }], '2026-10-07').length, 4);
  assert.equal(dropPending(list, [{ amount: 55.99, description: 'NETFLIX.COM', date: '2026-09-20' }], '2026-10-07').length, 4);
  assert.equal(dropPending(list, [{ amount: 55.99, description: 'X SHOP', date: '2026-10-07', currency: 'EUR' }], '2026-10-07').length, 4);
  assert.equal(dropPending(list, [], '2026-10-07'), list);
  assert.equal(dropPending(list, undefined, '2026-10-07'), list);
});

test('alerts: the pending payment of a late bill silences it and keeps it out of "low"', () => {
  const s = linked({ balance: { amount: 40, currency: 'RON', type: 'XPCD' }, pendingItems: [{ amount: 55.99, description: 'NETFLIX.COM', date: '2026-10-06' }] });
  s.transactions = netflix();
  const alerts = buildAlerts(s, { today: '2026-10-07', now: Date.parse('2026-10-07T09:00:00Z') });
  assert.ok(!alerts.some((a) => a.kind === 'bill'), alerts.map((a) => a.id).join());
  assert.ok(!alerts.some((a) => a.kind === 'low'), 'balance 40 covers what is still due');
  s.bank.connections[0].accounts[0].pendingItems = [];
  const again = buildAlerts(s, { today: '2026-10-07', now: Date.parse('2026-10-07T09:00:00Z') });
  assert.ok(again.some((a) => a.kind === 'bill'));
  assert.ok(again.some((a) => a.kind === 'low'));
});

test('sync: pendingItems = payments out still pending, only for a balance that has them taken off', () => {
  const raw = (o) => ({ transaction_amount: { amount: '55.99', currency: 'RON' }, credit_debit_indicator: 'DBIT', status: 'PDNG', transaction_date: '2026-10-06', creditor: { name: 'NETFLIX.COM' }, remittance_information: ['Plata POS NETFLIX.COM'], ...o });
  const txs = [
    raw(),
    raw({ status: 'HOLD', transaction_amount: { amount: '-20.00', currency: 'EUR' }, creditor: null, remittance_information: ['Tranzactie la: BOOKING.COM'], transaction_date: '2026-10-07' }),
    raw({ status: 'BOOK' }),
    raw({ credit_debit_indicator: 'CRDT', creditor: null, debtor: { name: 'ACME' } }),
  ];
  const items = pendingItemsOf(txs, { amount: 900, currency: 'RON', type: 'XPCD' });
  assert.deepEqual(items, [
    { amount: 20, description: 'BOOKING.COM', date: '2026-10-07', currency: 'EUR' },
    { amount: 55.99, description: 'NETFLIX.COM', date: '2026-10-06' },
  ]);
  assert.deepEqual(pendingItemsOf(txs, { amount: 900, currency: 'RON', type: 'CLBD' }), [], 'booked balance still holds that money');
  assert.deepEqual(pendingItemsOf([], { amount: 900, currency: 'RON', type: 'XPCD' }), []);
  assert.equal(pendingItemsOf(Array.from({ length: 40 }, () => raw()), { amount: 1, currency: 'RON', type: 'XPCD' }).length, 30);
});

test('periods: salaryArrived — found, late, set by hand, or no payday', () => {
  const salary = tx({ type: 'income', category: 'Salary', amount: 6000, date: '2026-09-10' });
  const P = makePeriods({ payday: 10, transactions: [salary], overrides: { '2026-11': '2026-11-12' } });
  assert.equal(P.salaryArrived('2026-09'), true);
  assert.equal(P.salaryArrived('2026-10'), false);
  assert.equal(P.salaryArrived('2026-11'), true, 'override');
  assert.equal(makePeriods({}).salaryArrived('2026-10'), true, 'calendar months');
});

test('alerts: no "money is tight" while this period\'s salary is a few days late', () => {
  const s = linked({ balance: { amount: 400, currency: 'RON', type: 'CLBD' }, payday: 10 });
  for (const m of ['07', '08', '09']) {
    s.transactions.push(tx({ type: 'income', amount: 6000, date: `2026-${m}-10`, description: 'SC ACME SRL', category: 'Salary' }));
    s.transactions.push(tx({ amount: 1500, date: `2026-${m}-15`, description: 'IONESCU MIHAI', category: 'Housing' }));
  }
  const low = (today) => buildAlerts(s, { today, now: Date.parse(`${today}T09:00:00Z`) }).some((a) => a.kind === 'low');
  // Payday 10 Oct 2026 is a Saturday: expected Friday 9 Oct, salary not in yet.
  assert.equal(low('2026-10-12'), false, 'salary late, within 5 days');
  assert.equal(low('2026-10-15'), true, 'more than 5 days late');
  s.transactions.push(tx({ type: 'income', amount: 6000, date: '2026-10-12', description: 'SC ACME SRL', category: 'Salary' }));
  assert.equal(low('2026-10-12'), true, 'salary in: the balance is what there is');
});

function cardHistory() {
  const s = linked();
  const repay = (date, amount) => tx({ date, amount, description: 'Plata card credit', category: 'Credit card repayment' });
  s.transactions = [repay('2026-07-14', 1900), repay('2026-08-14', 2100), repay('2026-09-14', 2000)];
  return s;
}

test('cardDue: after a partial repayment, what is left of the usual amount', () => {
  const s = cardHistory();
  const P = makePeriods({});
  assert.deepEqual(cardDue(s, makeLedger(s), P, '2026-10-03'), { min: 1900, max: 2100, date: '2026-10-14' });
  s.transactions.push(tx({ date: '2026-10-02', amount: 100, description: 'Plata card credit', category: 'Credit card repayment' }));
  assert.deepEqual(cardDue(s, makeLedger(s), P, '2026-10-03'), { min: 1800, max: 2000, date: '2026-10-14' });
  s.transactions.push(tx({ date: '2026-10-03', amount: 1960, description: 'Plata card credit', category: 'Credit card repayment' }));
  assert.equal(cardDue(s, makeLedger(s), P, '2026-10-03'), null, '40 RON left: done');
});

test('subscriptions: cash withdrawals are not bills; suggested series count, ignored ones do not', () => {
  const rows = [
    ...charges('ATM ING BUCURESTI', 'Other', [['2026-07-03', 300], ['2026-08-03', 250], ['2026-09-03', 400]]),
    ...charges('Retragere numerar', 'Other', [['2026-07-04', 500], ['2026-08-04', 500], ['2026-09-04', 500]]),
    ...charges('PAYPOINT', 'Cash', [['2026-07-06', 200], ['2026-08-06', 200], ['2026-09-06', 200]]),
    ...netflix(),
    ...charges('DIGI RCS', 'Utilities', [['2026-07-08', 60], ['2026-08-08', 60], ['2026-09-08', 60]]),
  ];
  const s = { ...emptyState(), transactions: rows };
  s.settings = { ...s.settings, recurring: { 'digi rcs': 'ignored' } };
  const series = detectSeries(s, { today: '2026-10-01' });
  assert.deepEqual(series.map((x) => [x.key, x.status]).sort(), [['digi rcs', 'ignored'], ['netflix com', 'suggested']]);
  assert.deepEqual(upcoming(series, '2026-10-01', '2026-10-31').map((u) => u.key), ['netflix com']);
});

test('merchantKey: Banca Transilvania card text gives the real merchant', () => {
  assert.equal(merchantKey('Plata la POS non-BT cu card VISA 4140XXXXXXXX1234 TID:12345678 NETFLIX.COM valoare 49,99 RON'), 'netflix com');
  assert.equal(merchantKey('Plata la POS non-BT cu card MASTERCARD 5123XXXXXXXX9876 TID: AB12 EMAG.RO valoare 100,00 RON RRN: 1234'), 'emag');
  assert.equal(merchantKey('Plata la POS cu card MAESTRO TID:A1 KAUFLAND 1234 BUCURESTI data 05/09/2026'), 'kaufland');
  assert.equal(merchantKey('Plata la POS non-BT cu card VISA 4140XXXXXXXX1234 NETFLIX.COM valoare 49,99 RON'), 'netflix com', 'without a TID');
  assert.equal(categorize({ description: 'Plata la POS non-BT cu card VISA 4140XXXXXXXX1234 TID:12345678 NETFLIX.COM valoare 49,99 RON', type: 'expense' }), 'Subscriptions');
  // ING text unchanged.
  assert.equal(merchantKey('Card number, **** 7204, Transaction at, CARREFOUR EXPRESS BAILE, Authorization date, 05-09-2026'), 'carrefour express');
});

test('periods: the end of a period is right across the spring DST change', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Bucharest';
  try {
    const P = makePeriods({ payday: 28 });
    assert.equal(P.start('2027-03'), '2027-03-29'); // 28 Mar 2027 is a Sunday
    assert.equal(P.end('2027-02'), '2027-03-28');
    assert.equal(P.keyOf('2027-03-28'), '2027-02');
    assert.equal(P.daysLeft('2027-02', '2027-03-28'), 1);
    assert.equal(makePeriods({}).end('2026-10'), '2026-10-31');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('cleanTransaction: a bank row keeps the bank\'s amount, type and date', () => {
  const existing = { id: 'b1', source: 'bank', accountId: 'cur', type: 'expense', amount: 55.99, date: '2026-10-05', category: 'Other', description: 'NETFLIX.COM' };
  const t = cleanTransaction({ amount: 1, type: 'income', date: '2026-01-01', category: 'Subscriptions' }, existing);
  assert.deepEqual([t.amount, t.type, t.date, t.category], [55.99, 'expense', '2026-10-05', 'Subscriptions']);
  const manual = cleanTransaction({ amount: 12, date: '2026-10-06' }, { ...existing, source: 'manual' });
  assert.deepEqual([manual.amount, manual.date], [12, '2026-10-06']);
});

test('periodCalendar: bills carry variable, late and the real due date', () => {
  const events = periodCalendar({
    today: '2026-10-07', periodEnd: '2026-10-31',
    upcoming: [
      { key: 'enel energie', label: 'ENEL', date: '2026-10-07', due: '2026-10-06', late: true, min: 200, max: 230 },
      { key: 'netflix com', label: 'Netflix', date: '2026-10-08', due: '2026-10-08', late: false, min: 55.99, max: 55.99 },
    ],
  });
  assert.deepEqual(events.map((e) => [e.key, e.variable, Boolean(e.late), e.due]), [['enel energie', true, true, '2026-10-06'], ['netflix com', false, false, '2026-10-08']]);
});
