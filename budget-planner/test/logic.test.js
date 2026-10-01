import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatRON, monthsBetween } from '../public/js/shared/money.js';
import { categorize, merchantKey, DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';
import { analyzeHistory, buildPlan, goalSaved } from '../public/js/shared/planner.js';
import { csvToTransactions, parseDate } from '../public/js/shared/csv.js';
import { mapBankTransaction, bankRef } from '../lib/sync.js';

const cats = DEFAULT_CATEGORIES;

test('parses Romanian and English amount formats', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('-45,5 lei'), -45.5);
  assert.equal(parseAmount('(12,00)'), -12);
  assert.equal(parseAmount('300'), 300);
  assert.ok(Number.isNaN(parseAmount('')));
});

test('formats RON', () => {
  assert.match(formatRON(1234.5), /1\.234,50\s?RON/);
  assert.match(formatRON(-10), /^−10,00\s?RON/);
});

test('categorises Romanian merchants', () => {
  const c = (description, type = 'expense') => categorize({ description, type }, [], cats);
  assert.equal(c('PLATA LA POS KAUFLAND 1234 BUCURESTI'), 'Groceries');
  assert.equal(c('Plata POS GLOVO*FOOD'), 'Eating out');
  assert.equal(c('BOLT.EU/O/2310'), 'Transport');
  assert.equal(c('METROREX SA'), 'Transport');
  assert.equal(c('METRO CASH & CARRY'), 'Groceries');
  assert.equal(c('ENEL ENERGIE MUNTENIA'), 'Utilities');
  assert.equal(c('Netflix.com'), 'Subscriptions');
  assert.equal(c('Farmacia Catena'), 'Health');
  assert.equal(c('Retragere numerar ATM BT'), 'Cash');
  assert.equal(c('Something unknown'), 'Other');
  assert.equal(c('SALARIU LUNA SEPTEMBRIE', 'income'), 'Salary');
  assert.equal(c('Transfer intre conturi proprii', 'income'), 'Transfers');
  assert.equal(c('Plata Primaria Sector 3'), 'Other'); // not "prima" (bonus)
});

test('user rules win over defaults', () => {
  const rules = [{ pattern: 'kaufland', category: 'Shopping' }];
  assert.equal(categorize({ description: 'KAUFLAND RO', type: 'expense' }, rules, cats), 'Shopping');
});

test('merchantKey strips noise', () => {
  assert.equal(merchantKey('PLATA LA POS KAUFLAND 1234 BUCURESTI RO'), 'kaufland');
  assert.equal(merchantKey('POS 12/09/2026 MEGA IMAGE 0412'), 'mega image');
});

function tx(date, type, amount, category, description = category, extra = {}) {
  return { id: `${date}-${category}-${amount}-${Math.random()}`, date, type, amount, category, description, ...extra };
}

function history() {
  const out = [];
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
    out.push(tx(`${m}-01`, 'income', 8000, 'Salary'));
    out.push(tx(`${m}-02`, 'expense', 2500, 'Housing', 'Chirie'));
    out.push(tx(`${m}-05`, 'expense', 1500, 'Groceries', 'Kaufland'));
    out.push(tx(`${m}-08`, 'expense', 400, 'Utilities', 'Enel'));
    out.push(tx(`${m}-10`, 'expense', 55.99, 'Subscriptions', 'Netflix'));
    for (let d = 10; d < 28; d += 2) out.push(tx(`${m}-${d}`, 'expense', 40, 'Eating out', 'Glovo'));
    out.push(tx(`${m}-15`, 'expense', 900, 'Shopping', `eMAG order ${m}`));
    out.push(tx(`${m}-20`, 'expense', 1000, 'Transfers', 'Transfer intre conturi proprii'));
  }
  return out;
}

test('analyzeHistory averages full months and ignores transfers', () => {
  const a = analyzeHistory(history(), cats, { today: '2026-10-01' });
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.monthKeys, ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(a.avgIncome, 8000);
  assert.equal(a.avgSpend, 2500 + 1500 + 400 + 55.99 + 9 * 40 + 900);
  assert.equal(a.categories[0].name, 'Housing');
  const eating = a.categories.find((c) => c.name === 'Eating out');
  assert.equal(eating.smallPerMonth, 9);
  assert.ok(a.recurring.some((r) => r.merchant === 'netflix'));
  assert.ok(!a.recurring.some((r) => r.merchant === 'glovo'), 'frequent shops are not subscriptions');
});

test('plan is on track when the surplus covers goals', () => {
  const a = analyzeHistory(history(), cats, { today: '2026-10-01' });
  const plan = buildPlan(a, [{ id: 'g1', name: 'Laptop', target: 6000, saved: 0, deadline: '2027-04-01', priority: 'high' }], { today: '2026-10-01' });
  assert.equal(plan.status, 'on-track');
  assert.equal(plan.cuts.length, 0);
  assert.equal(plan.goals[0].status, 'on-track');
  assert.ok(plan.goals[0].eta <= '2027-04-01');
});

test('plan proposes cuts only in flexible categories', () => {
  const a = analyzeHistory(history(), cats, { today: '2026-10-01' });
  // surplus ≈ 2284/month; the goal needs 2500/month
  const plan = buildPlan(a, [{ id: 'g1', name: 'Car', target: 15000, saved: 0, deadline: '2027-04-01', priority: 'high' }], { today: '2026-10-01', intensity: 'aggressive' });
  assert.equal(plan.status, 'needs-cuts');
  assert.ok(plan.cuts.length > 0);
  for (const c of plan.cuts) assert.ok(!['Housing', 'Groceries', 'Utilities'].includes(c.name), `${c.name} is essential`);
  assert.ok(plan.monthlySaving >= plan.totalRequired - 0.01);
  assert.equal(plan.goals[0].status, 'on-track');
  const housing = plan.budgets.find((b) => b.name === 'Housing');
  assert.equal(housing.limit, 2500);
});

test('plan flags a stretch goal and gives a realistic date', () => {
  const a = analyzeHistory(history(), cats, { today: '2026-10-01' });
  const plan = buildPlan(a, [{ id: 'g1', name: 'House', target: 100000, saved: 0, deadline: '2027-04-01', priority: 'high' }], { today: '2026-10-01', intensity: 'gentle' });
  assert.equal(plan.status, 'stretch');
  assert.equal(plan.goals[0].status, 'at-risk');
  assert.ok(plan.goals[0].eta > '2027-04-01');
  assert.ok(plan.tips.some((t) => t.text.includes('realistic date')));
});

test('multiple goals: dated goals get funded first, undated get the rest', () => {
  const a = analyzeHistory(history(), cats, { today: '2026-10-01' });
  const plan = buildPlan(a, [
    { id: 'a', name: 'Emergency fund', target: 10000, saved: 2000, priority: 'medium' },
    { id: 'b', name: 'Holiday', target: 4000, saved: 0, deadline: '2027-06-01', priority: 'high' },
  ], { today: '2026-10-01' });
  const holiday = plan.goals.find((g) => g.id === 'b');
  const fund = plan.goals.find((g) => g.id === 'a');
  assert.equal(holiday.status, 'on-track');
  assert.ok(fund.eta, 'undated goal gets a projected date');
});

test('overspending is surfaced first', () => {
  const t = [tx('2026-09-01', 'income', 3000, 'Salary'), tx('2026-09-03', 'expense', 2500, 'Housing'), tx('2026-09-05', 'expense', 1200, 'Shopping')];
  const a = analyzeHistory(t, cats, { today: '2026-10-01' });
  const plan = buildPlan(a, [], { today: '2026-10-01' });
  assert.equal(plan.surplus, -700);
  assert.equal(plan.tips[0].level, 'critical');
});

test('no history → no-data plan', () => {
  const a = analyzeHistory([], cats, { today: '2026-10-01' });
  assert.equal(buildPlan(a, [], {}).status, 'no-data');
});

test('current month only is extrapolated', () => {
  const t = [tx('2026-10-01', 'income', 5000, 'Salary'), tx('2026-10-05', 'expense', 500, 'Shopping')];
  const a = analyzeHistory(t, cats, { today: '2026-10-10' });
  assert.equal(a.extrapolated, true);
  assert.equal(a.confidence, 'low');
  assert.equal(a.avgSpend, 1550); // 500 * 31/10
});

test('goalSaved adds contributions and subtracts withdrawals', () => {
  const g = { id: 'g', initialSaved: 100 };
  const t = [tx('2026-09-01', 'expense', 300, 'Savings', 'x', { goalId: 'g' }), tx('2026-09-02', 'income', 50, 'Savings', 'x', { goalId: 'g' })];
  assert.equal(goalSaved(g, t), 350);
});

test('monthsBetween', () => {
  assert.ok(Math.abs(monthsBetween('2026-10-01', '2027-04-01') - 6) < 0.01);
});

test('CSV import: BT style with debit/credit columns and preamble', () => {
  const csv = [
    'Extras de cont;;;;',
    'Titular: Ion Popescu;;;;',
    'Data tranzactie;Data valuta;Descriere;Debit;Credit',
    '01.09.2026;01.09.2026;Plata la POS KAUFLAND;123,45;',
    '02.09.2026;02.09.2026;Incasare SALARIU;;7.500,00',
    ';;Ref 9988 continuare;;',
    'Sold final;;;;',
  ].join('\n');
  const { items } = csvToTransactions(csv);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { date: '2026-09-01', type: 'expense', amount: 123.45, description: 'Plata la POS KAUFLAND', note: '' });
  assert.equal(items[1].type, 'income');
  assert.equal(items[1].amount, 7500);
  assert.match(items[1].note, /continuare/);
});

test('CSV import: Revolut style with signed amount', () => {
  const csv = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency\nCARD_PAYMENT,Current,2026-09-03 10:00:00,2026-09-04 10:00:00,Lidl,-56.20,0.00,RON\nTOPUP,Current,2026-09-05 10:00:00,2026-09-05 10:00:00,Top-up,500.00,0.00,RON';
  const { items } = csvToTransactions(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].amount, 56.2);
  assert.equal(items[0].type, 'expense');
  assert.equal(items[1].type, 'income');
});

test('parseDate handles common formats', () => {
  assert.equal(parseDate('2026-09-03'), '2026-09-03');
  assert.equal(parseDate('3/9/2026'), '2026-09-03');
  assert.equal(parseDate('03-sep-2026'), '2026-09-03');
  assert.equal(parseDate('12 oct. 2026'), '2026-10-12');
  assert.equal(parseDate('Sold'), null);
});

test('maps Enable Banking transactions', () => {
  const raw = {
    entry_reference: 'abc123',
    transaction_amount: { amount: '89.90', currency: 'RON' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-14',
    creditor: { name: 'MEGA IMAGE 123' },
    remittance_information: ['Plata POS MEGA IMAGE 123 BUCURESTI'],
  };
  const t = mapBankTransaction('acc1', raw, { rules: [], categories: cats });
  assert.equal(t.type, 'expense');
  assert.equal(t.amount, 89.9);
  assert.equal(t.category, 'Groceries');
  assert.equal(t.date, '2026-09-14');
  assert.equal(t.bankRef, 'acc1:abc123');
  assert.equal(mapBankTransaction('acc1', { ...raw, status: 'PDNG' }, { rules: [], categories: cats }), null);
  const noId = { ...raw, entry_reference: undefined };
  assert.equal(bankRef('acc1', noId), bankRef('acc1', { ...noId }), 'fingerprint is stable');
});

import { accountView, bankTotals } from '../public/js/shared/accounts.js';

test('credit card balance reported as amount owed', () => {
  const card = { kind: 'credit', creditLimit: 9900, balanceMeaning: 'owed', balance: { amount: 9881.62 } };
  const v = accountView(card);
  assert.equal(v.owed, 9881.62);
  assert.equal(v.available, 18.38);
  assert.equal(v.cash, 0);
});

test('credit card balance reported as available credit', () => {
  const v = accountView({ kind: 'credit', creditLimit: 9900, balanceMeaning: 'available', balance: { amount: 9881.62 } });
  assert.equal(v.owed, 18.38);
  assert.equal(v.available, 9881.62);
});

test('auto: credit_limit_included means available; negative means owed', () => {
  assert.equal(accountView({ cashAccountType: 'CARD', creditLimit: 5000, balance: { amount: 4000, creditLimitIncluded: true } }).owed, 1000);
  assert.equal(accountView({ cashAccountType: 'CARD', creditLimit: 5000, balance: { amount: -1200 } }).owed, 1200);
});

test('bank totals never count card money as cash', () => {
  const t = bankTotals([
    { balance: { amount: 1214.43 } },
    { balance: { amount: 0 } },
    { kind: 'credit', creditLimit: 9900, balanceMeaning: 'owed', balance: { amount: 9881.62 } },
  ]);
  assert.deepEqual(t, { cash: 1214.43, owed: 9881.62, net: -8667.19 });
});

test('payments between your own accounts become transfers', () => {
  const own = { ibans: new Set(['RO31INGB0000999918061462']), names: new Set(), ibanOf: new Map([['acc', 'RO34INGB0000999908415340']]) };
  const raw = { entry_reference: 'r1', transaction_amount: { amount: '500', currency: 'RON' }, credit_debit_indicator: 'DBIT', booking_date: '2026-09-20', creditor: { name: 'Dan' }, creditor_account: { iban: 'RO31 INGB 0000 9999 1806 1462' } };
  assert.equal(mapBankTransaction('acc', raw, { rules: [], categories: cats }, own).category, 'Transfers');
  assert.notEqual(mapBankTransaction('acc', raw, { rules: [], categories: cats }).category, 'Transfers');
});

import { isSameTransaction, mergeDuplicates } from '../public/js/shared/dedupe.js';

test('CSV and bank copies of the same purchase are merged', () => {
  const csv = { id: 'c', source: 'import', type: 'expense', amount: 73.93, date: '2026-09-12', category: 'Subscriptions', importHash: 'h1', createdAt: 'x', updatedAt: 'x',
    description: 'Cumparare POS Data finalizarii (decontarii): 12-09-2026 Numar card:**** 8391 Tranzactie la:NETFLIX INTERNATIONAL B.V NL Amsterdam' };
  const bank = { id: 'b', source: 'bank', type: 'expense', amount: 73.93, date: '2026-09-12', category: 'Subscriptions', bankRef: 'acc:1', createdAt: 'y', updatedAt: 'y',
    description: 'Card number, **** 8391, Transaction at, NETFLIX INTERNATIONAL B.V NL Amsterdam, Authorization date, 10-09-2026' };
  assert.ok(isSameTransaction(csv, bank));
  const state = { transactions: [csv, bank] };
  assert.equal(mergeDuplicates(state), 1);
  assert.deepEqual(state.transactions.map((t) => t.id), ['b']);
  assert.equal(state.transactions[0].importHash, 'h1');
});

test('different purchases with the same amount are not merged', () => {
  const base = { type: 'expense', amount: 73.93, date: '2026-09-12' };
  assert.ok(!isSameTransaction({ ...base, description: 'NETFLIX' }, { ...base, description: 'SPOTIFY' }));
  assert.ok(!isSameTransaction({ ...base, description: 'NETFLIX' }, { ...base, date: '2026-10-12', description: 'NETFLIX' }), 'next month is a new charge');
  assert.ok(!isSameTransaction({ ...base, description: 'NETFLIX' }, { ...base, amount: 74, description: 'NETFLIX' }));
});

test('your category edit survives the merge', () => {
  const state = { transactions: [
    { id: 'c', source: 'import', type: 'expense', amount: 50, date: '2026-09-01', category: 'Entertainment', createdAt: 'a', updatedAt: 'b', description: 'POS KAUFLAND' },
    { id: 'b', source: 'bank', type: 'expense', amount: 50, date: '2026-09-02', category: 'Groceries', createdAt: 'c', updatedAt: 'c', description: 'Kaufland 1234' },
  ] };
  mergeDuplicates(state);
  assert.equal(state.transactions[0].category, 'Entertainment');
});

import { extractMerchant, isUselessKeyword } from '../public/js/shared/categories.js';
import { recategorize } from '../lib/sync.js';

test('merchant is extracted from ING card text', () => {
  const d = 'Card number, **** 7204, Transaction at, CARREFOUR EXPRESS BAILE, Authorization date, 27-09-2026';
  assert.equal(extractMerchant(d), 'CARREFOUR EXPRESS BAILE');
  assert.equal(merchantKey(d), 'carrefour express');
  assert.ok(isUselessKeyword('number transaction'));
  assert.ok(isUselessKeyword('card number'));
  assert.ok(!isUselessKeyword('carrefour'));
});

test('recategorize respects manual choices and own-account transfers', () => {
  const s = {
    rules: [{ pattern: 'carrefour', category: 'Eating out' }],
    categories: cats,
    bank: { connections: [{ accounts: [{ uid: 'acc0', iban: 'RO11' }] }] },
    transactions: [
      { id: 'a', source: 'bank', type: 'expense', category: 'Transport', description: 'CARREFOUR EXPRESS' },
      { id: 'b', source: 'bank', type: 'expense', category: 'Shopping', description: 'CARREFOUR MARKET', manualCategory: true },
      { id: 'c', source: 'bank', type: 'expense', category: 'Transfers', description: 'Dan', counterpartyIban: 'RO11' },
    ],
  };
  assert.equal(recategorize(s), 1);
  assert.deepEqual(s.transactions.map((t) => t.category), ['Eating out', 'Shopping', 'Transfers']);
});

import { ownContext, isOwnTransfer } from '../public/js/shared/own.js';

test('own transfers: card repayment, Revolut to yourself, cash deposit', () => {
  const state = { bank: { connections: [{ accounts: [
    { uid: 'cur', iban: 'RO34INGB0000999908415340', name: 'Dan Paul Nastea' },
    { uid: 'card', iban: 'RO31INGB0000999918061462', name: 'Dan Paul Nastea' },
  ] }] } };
  const own = ownContext(state);
  const tx = (accountId, description, note = '') => ({ accountId, description, note });
  assert.ok(isOwnTransfer(tx('card', 'Rambursare rata card credit', 'Din contul:RO34INGB0000999908415340'), own));
  assert.ok(isOwnTransfer(tx('cur', "Transfer Home'Bank", 'Beneficiar:Dan Paul Nastea In contul:RO31INGB0000999918061462'), own));
  assert.ok(isOwnTransfer(tx('cur', 'Ordering party, Dan Paul Nastea, From account, RO08REVO0000186228939087, Details, Trimis prin Revolut'), own));
  assert.ok(!isOwnTransfer(tx('cur', 'Ordering party, H Essers SRL, From account, RO66INGB0007008192218926'), own));
  assert.ok(!isOwnTransfer(tx('cur', 'KAUFLAND', 'RO34INGB0000999908415340'), own), "the account's own IBAN in its own text is not a transfer");
  const c = (d, type = 'expense') => categorize({ description: d, type }, [], cats);
  assert.equal(c('Depunere numerar', 'income'), 'Transfers');
  assert.equal(c('Card number, **** 8391, Transaction at, Revolut**1304* IE Dublin'), 'Transfers');
  assert.equal(c('Rambursare rata card credit', 'income'), 'Transfers');
});

import { makePeriods, expectedPayday } from '../public/js/shared/periods.js';

test('payday moves off weekends: Sat → Fri, Sun → Mon', () => {
  assert.equal(expectedPayday('2026-10', 10), '2026-10-09'); // 10 Oct 2026 is a Saturday
  assert.equal(expectedPayday('2027-01', 10), '2027-01-11'); // 10 Jan 2027 is a Sunday
  assert.equal(expectedPayday('2026-09', 10), '2026-09-10'); // Thursday
});

test('pay periods run from salary to salary, using the real salary date', () => {
  const tx = [
    { type: 'income', category: 'Salary', amount: 7334, date: '2026-09-10' },
    { type: 'income', category: 'Salary', amount: 7364, date: '2026-05-11' }, // paid a day late
    { type: 'income', category: 'Other income', amount: 194, date: '2026-09-18' },
  ];
  const p = makePeriods({ payday: 10, transactions: tx });
  assert.equal(p.start('2026-09'), '2026-09-10');
  assert.equal(p.end('2026-09'), '2026-10-08'); // next payday is Fri 9 Oct
  assert.equal(p.keyOf('2026-09-09'), '2026-08');
  assert.equal(p.keyOf('2026-09-10'), '2026-09');
  assert.equal(p.keyOf('2026-10-08'), '2026-09');
  assert.equal(p.keyOf('2026-10-09'), '2026-10');
  assert.equal(p.start('2026-05'), '2026-05-11');
  assert.equal(p.keyOf('2026-05-10'), '2026-04');
  assert.equal(p.daysLeft('2026-09', '2026-10-01'), 8);
  assert.equal(p.pseudoDate('2026-09-10'), '2026-09-01');
});

test('without a payday, periods are calendar months', () => {
  const p = makePeriods({});
  assert.equal(p.keyOf('2026-09-30'), '2026-09');
  assert.equal(p.start('2026-09'), '2026-09-01');
  assert.equal(p.end('2026-09'), '2026-09-30');
});

test('the same statement imported twice by different app versions is merged', () => {
  const old = (id, description, amount, type = 'expense') => ({ id, source: 'import', type, amount, date: '2026-09-12', description, category: 'Other', createdAt: '2026-10-01T18:00:00.000Z', updatedAt: '2026-10-01T18:00:00.000Z' });
  const neu = (id, description, amount, type = 'expense') => ({ ...old(id, description, amount, type), createdAt: '2026-10-01T20:00:00.000Z', updatedAt: '2026-10-01T20:00:00.000Z' });
  const state = { transactions: [
    old('o1', 'Cumparare POS Data finalizarii (decontarii): 12-09-2026 Numar card:**** 8391 Tranzactie la:Pago*Hidroelectrica RO VOLUNTARI', 479.02),
    old('o2', 'Cumparare POS Data finalizarii: 12-09-2026 Tranzactie la:PayU*portal.tpark.ro', 5),
    neu('n1', 'Pago*Hidroelectrica RO VOLUNTARI', 479.02),
    neu('n2', 'PayU*portal.tpark.ro RO ROMANIA', 5),
    neu('n3', 'PayU*portal.tpark.ro RO ROMANIA', 5), // genuine second parking ticket
  ] };
  assert.equal(mergeDuplicates(state), 2);
  assert.deepEqual(state.transactions.map((t) => t.id).sort(), ['n1', 'n2', 'n3']);
});
