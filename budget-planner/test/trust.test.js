// Can the numbers be trusted? Bank access countdown and reconciliation hints
// (trust.js), card repayments counted once + the cost of credit (cardpay.js),
// why a category was chosen and the review queue (review.js), net worth
// (networth.js), refunds you wait for (refunds.js), splits and the meal-voucher
// pocket in the ledger, and the new "Interest & fees" rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../lib/store.js';
import { consentStatus, explainDifference, accountTrust } from '../public/js/shared/trust.js';
import { pairRepayments, repaidInPeriod, creditCost, cardDue } from '../public/js/shared/cardpay.js';
import { categoryReason, reviewQueue, suggestRules } from '../public/js/shared/review.js';
import { netWorth } from '../public/js/shared/networth.js';
import { expectedRefunds } from '../public/js/shared/refunds.js';
import { makeLedger } from '../public/js/shared/ledger.js';
import { makePeriods } from '../public/js/shared/periods.js';
import { categorize, matchRule } from '../public/js/shared/categories.js';

let n = 0;
const tx = (o) => ({ id: `t${++n}`, source: 'bank', accountId: 'cur', type: 'expense', category: 'Other', description: 'x', createdAt: '2026-01-01T00:00:00Z', ...o });
function linked(extra = {}) {
  const s = emptyState();
  s.bank.connections = [{ sessionId: 's', bank: 'ING', validUntil: '2026-12-30T10:00:00Z', accounts: [
    { uid: 'cur', iban: 'RO00INGB0000999900005340', currency: 'RON', kind: 'current', balance: { amount: 1000, currency: 'RON', type: 'CLBD' }, lastSyncAt: '2026-10-10T08:00:00Z', lastAdded: 3 },
    { uid: 'card', iban: 'RO00INGB0000999900008391', currency: 'RON', kind: 'credit', creditLimit: 5000, balanceMeaning: 'owed', balance: { amount: 1200, currency: 'RON' } },
  ] }];
  return Object.assign(s, extra);
}

test('consent: ok, soon (≤14 days), urgent (≤3), expired; archived links ignored', () => {
  const s = linked();
  s.bank.connections.push({ sessionId: 'old', bank: 'BT', archived: true, validUntil: '2020-01-01T00:00:00Z', accounts: [] });
  const at = (iso) => consentStatus(s, { now: Date.parse(iso) })[0];
  assert.equal(at('2026-10-10T10:00:00Z').level, 'ok');
  assert.equal(at('2026-12-20T10:00:00Z').level, 'soon');
  assert.equal(at('2026-12-20T10:00:00Z').daysLeft, 10);
  assert.equal(at('2026-12-28T10:00:00Z').level, 'urgent');
  assert.equal(at('2026-12-31T10:00:00Z').level, 'expired');
  assert.equal(consentStatus(s).length, 1);
});

test('difference hints: a payment counted twice, or one missing', () => {
  const s = linked();
  s.transactions = [tx({ date: '2026-10-05', amount: 45 }), tx({ date: '2026-10-06', amount: 45 }), tx({ date: '2026-10-06', amount: 12, source: 'import' })];
  const rec = { ok: false, diff: 45, fromDay: '2026-10-01', toDay: '2026-10-09' };
  const hints = explainDifference(s, 'cur', rec);
  assert.equal(hints[0].kind, 'duplicate');
  assert.ok(['t1', 't2'].includes(hints[0].txId));
  assert.ok(hints.some((h) => h.kind === 'import'));
  const missing = explainDifference(s, 'cur', { ok: false, diff: -30, fromDay: '2026-10-01', toDay: '2026-10-09' });
  assert.equal(missing[0].kind, 'missing');
  assert.match(missing[0].text, /money out of 30/);
  assert.deepEqual(explainDifference(s, 'cur', { ok: true }), []);
  assert.equal(explainDifference(s, 'cur', { ok: false, diff: 5, uncertain: true, fromDay: '2026-10-01', toDay: '2026-10-09' })[0].kind, 'uncertain');
});

test('accountTrust: last sync, new rows, staleness', () => {
  const t = accountTrust(linked(), 'cur', { now: Date.parse('2026-10-10T20:00:00Z') });
  assert.equal(t.added, 3);
  assert.equal(t.ageHours, 12);
  assert.equal(t.stale, false);
  assert.equal(accountTrust(linked(), 'cur', { now: Date.parse('2026-10-12T20:00:00Z') }).stale, true);
  assert.equal(accountTrust(linked(), 'card').lastSyncAt, null);
  assert.equal(accountTrust(linked(), 'nope'), null);
});

function cardState() {
  const s = linked();
  s.transactions = [
    tx({ date: '2026-08-13', amount: 500, description: 'Plata card credit', category: 'Credit card repayment' }),
    tx({ date: '2026-08-14', amount: 500, accountId: 'card', type: 'income', description: 'Rambursare rata card', category: 'Transfers' }),
    tx({ date: '2026-09-14', amount: 400, description: 'Plata card credit', category: 'Credit card repayment' }), // card side missing
    tx({ date: '2026-09-20', amount: 23.5, accountId: 'card', description: 'Dobanda debitoare', category: 'Interest & fees' }),
    tx({ date: '2026-09-22', amount: 9, accountId: 'card', description: 'Comision administrare card', category: 'Other' }),
  ];
  return s;
}

test('card repayments: paired once, counted even when the card side is missing', () => {
  const s = cardState();
  const L = makeLedger(s);
  const { pairs, unpairedIn } = pairRepayments(s, L);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].in.date, '2026-08-14');
  assert.equal(pairs[1].in, null);
  assert.equal(unpairedIn.length, 0);
  const keyOf = (d) => d.slice(0, 7);
  assert.equal(repaidInPeriod(s, L, keyOf, '2026-08').total, 500, 'not 1000');
  assert.equal(repaidInPeriod(s, L, keyOf, '2026-09').total, 400);
});

test('cost of credit: interest and fees on the card, with the 3-period average', () => {
  const s = cardState();
  const L = makeLedger(s);
  const keyOf = (d) => d.slice(0, 7);
  assert.equal(creditCost(s, L, keyOf, '2026-09').total, 32.5);
  assert.equal(creditCost(s, L, keyOf, '2026-10').avg3, round(32.5 / 3));
});
const round = (x) => Math.round(x * 100) / 100;

test('card due: expected when you repaid in 2 of the last 3 periods and not yet now', () => {
  const s = cardState();
  const L = makeLedger(s);
  const P = makePeriods({});
  const due = cardDue(s, L, P, '2026-10-03');
  assert.deepEqual(due, { min: 400, max: 500, date: '2026-10-14' }, 'usually 12–13 days after the period starts');
  s.transactions.push(tx({ date: '2026-10-02', amount: 450, description: 'Plata card credit', category: 'Credit card repayment' }));
  assert.equal(cardDue(s, makeLedger(s), P, '2026-10-03'), null, 'already paid this period');
});

test('category reasons, review queue and rule suggestions', () => {
  const s = linked();
  s.rules = [{ pattern: 'carrefour', keyword: 'carrefour', category: 'Groceries' }];
  const mine = tx({ date: '2026-10-05', description: 'CARREFOUR EXPRESS', category: 'Groceries' });
  const guessed = tx({ date: '2026-10-06', description: 'LIDL 123', category: 'Groceries' });
  const unknown = tx({ date: '2026-10-07', description: 'SOME SHOP SRL', category: 'Other' });
  const picked = tx({ date: '2026-10-07', description: 'ABC MARKET', category: 'Shopping', manualCategory: true });
  const old = tx({ date: '2026-06-01', description: 'LIDL 9', category: 'Groceries' });
  const repayment = tx({ date: '2026-10-07', description: 'Plata card credit', category: 'Credit card repayment' });
  s.transactions = [mine, guessed, unknown, picked, old, repayment];
  assert.deepEqual(categoryReason(mine, s), { kind: 'rule', keyword: 'carrefour', pattern: 'carrefour' });
  assert.equal(categoryReason(guessed, s).kind, 'builtin');
  assert.equal(categoryReason(unknown, s).kind, 'fallback');
  assert.equal(categoryReason(picked, s).kind, 'manual');
  assert.equal(categoryReason({ ...mine, source: 'manual' }, s).kind, 'manual-entry');
  assert.deepEqual(reviewQueue(s, { today: '2026-10-10' }).map((t) => t.id), [unknown.id, guessed.id], 'newest first; rule, manual, old and repayment rows left out');
  guessed.reviewed = true;
  assert.deepEqual(reviewQueue(s, { today: '2026-10-10' }).map((t) => t.id), [unknown.id]);

  s.transactions.push(
    tx({ date: '2026-09-01', description: 'MEGA IMAGE 0012', category: 'Eating out', manualCategory: true }),
    tx({ date: '2026-09-15', description: 'MEGA IMAGE 0012', category: 'Eating out', manualCategory: true }),
    tx({ date: '2026-10-01', description: 'MEGA IMAGE 0012', category: 'Groceries' }),
  );
  const [sug] = suggestRules(s);
  assert.equal(sug.keyword, 'mega image');
  assert.equal(sug.category, 'Eating out');
  assert.equal(sug.count, 2);
  s.rules.push({ pattern: 'mega image', keyword: 'mega image', category: 'Eating out' });
  assert.deepEqual(suggestRules(s), [], 'already a rule');
});

test('net worth: bank money − card debt + assets − loans; stale manual values', () => {
  const s = linked({ assets: [
    { id: 'a', name: 'Pilon II', kind: 'pension', amount: 15000, updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'b', name: 'Car loan', kind: 'loan', amount: 8000, updatedAt: '2026-01-01T00:00:00Z' },
  ] });
  const nw = netWorth(s, { now: Date.parse('2026-10-10T00:00:00Z') });
  assert.equal(nw.bankCash, 1000);
  assert.equal(nw.cardOwed, 1200);
  assert.equal(nw.total, 1000 - 1200 + 15000 - 8000);
  assert.deepEqual(nw.stale.map((a) => a.id), ['b']);
  assert.deepEqual(nw.items.map((i) => i.kind), ['bank', 'card', 'pension', 'loan']);
});

test('expected refunds: waiting, overdue, received', () => {
  const s = linked();
  const buy = tx({ date: '2026-10-01', amount: 120, description: 'EMAG ORDER 1', category: 'Shopping', refundDue: '2026-10-15' });
  const late = tx({ date: '2026-09-01', amount: 80, description: 'ZARA ONLINE', category: 'Shopping', refundDue: '2026-09-20' });
  s.transactions = [buy, late];
  let list = expectedRefunds(s, { today: '2026-10-10' });
  assert.deepEqual(list.map((r) => [r.tx.id, r.status]), [[late.id, 'overdue'], [buy.id, 'waiting']]);
  s.transactions.push(tx({ date: '2026-10-08', amount: 120, type: 'income', description: 'EMAG ORDER 1 retur', category: 'Refunds' }));
  list = expectedRefunds(s, { today: '2026-10-10' });
  assert.equal(list.find((r) => r.tx.id === buy.id).status, 'received');
});

test('ledger: a split purchase spreads over its categories; voucher-pocket rows never count', () => {
  const s = linked();
  const split = tx({ date: '2026-10-05', amount: 100, category: 'Groceries', splits: [{ category: 'Groceries', amount: 70 }, { category: 'Shopping', amount: 30 }] });
  const bad = tx({ date: '2026-10-05', amount: 50, category: 'Health', splits: [{ category: 'Health', amount: 10 }, { category: 'Other', amount: 10 }] });
  const voucher = tx({ source: 'manual', accountId: null, date: '2026-10-05', amount: 40, category: 'Eating out', pocket: 'vouchers' });
  s.transactions = [split, bad, voucher];
  const L = makeLedger(s);
  const t = L.totals(s.transactions);
  assert.equal(t.spend, 150);
  assert.deepEqual(t.byCategory, { Groceries: 70, Shopping: 30, Health: 50 }, 'a split that doesn’t add up is ignored');
  assert.deepEqual(L.parts(split), [{ category: 'Groceries', amount: 70 }, { category: 'Shopping', amount: 30 }]);
  assert.equal(L.counts(voucher), null);
});

test('Interest & fees: bank charges get their own category; interest received stays income', () => {
  assert.equal(categorize({ description: 'Dobanda debitoare card credit', type: 'expense' }), 'Interest & fees');
  assert.equal(categorize({ description: 'Comision administrare cont', type: 'expense' }), 'Interest & fees');
  assert.equal(categorize({ description: 'Dobanda bonificata', type: 'income' }), 'Extra income');
  assert.deepEqual(matchRule({ description: 'zzz', type: 'expense' }), { category: 'Other', rule: null, source: 'fallback' });
  assert.equal(matchRule({ description: 'kaufland', type: 'expense' }, [{ pattern: 'kaufland', category: 'Eating out' }]).source, 'user');
});
