// CSV rows in another currency are converted to RON at the BNR rate of their date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.js';
import { convertPendingFx } from '../lib/fxconvert.js';

async function storeWith(transactions) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-fx-'));
  const store = await new Store(path.join(dir, 'budget.json')).load();
  await store.mutate((s) => { s.transactions = transactions; });
  return store;
}

const row = (id, extra) => ({ id, type: 'expense', date: '2026-09-15', description: 'Hotel', category: 'Travel', source: 'import', ...extra });

test('converts needsFx rows at the rate of their own date', async () => {
  const store = await storeWith([
    row('a', { amount: 50, needsFx: true, originalAmount: 50, originalCurrency: 'EUR' }),
    row('b', { amount: 20, needsFx: true, originalAmount: 20, originalCurrency: 'EUR', date: '2026-09-20' }),
    row('c', { amount: 100 }),
  ]);
  const asked = [];
  const n = await convertPendingFx(store, async (cur, date) => { asked.push(`${cur}|${date}`); return { rate: date === '2026-09-15' ? 4.97 : 5, date }; });
  assert.equal(n, 2);
  assert.deepEqual(asked, ['EUR|2026-09-15', 'EUR|2026-09-20']);
  const [a, b, c] = store.get().transactions;
  assert.equal(a.amount, 248.5);
  assert.equal(a.needsFx, undefined);
  assert.equal(a.rateDate, '2026-09-15');
  assert.equal(a.rateSource, 'bnr');
  assert.equal(a.originalAmount, 50);
  assert.equal(b.amount, 100);
  assert.equal(c.amount, 100);
});

test('rows stay marked when the rate is unavailable, and one rate is fetched once', async () => {
  const store = await storeWith([
    row('a', { amount: 50, needsFx: true, originalAmount: 50, originalCurrency: 'USD' }),
    row('b', { amount: 10, needsFx: true, originalAmount: 10, originalCurrency: 'USD' }),
  ]);
  let calls = 0;
  const n = await convertPendingFx(store, async () => { calls += 1; throw new Error('offline'); });
  assert.equal(n, 0);
  assert.equal(calls, 1);
  assert.ok(store.get().transactions.every((t) => t.needsFx && t.amount < 60));
});

test('accepts a plain number rate and does nothing when nothing is pending', async () => {
  const store = await storeWith([row('a', { amount: 7, needsFx: true, originalAmount: 7, originalCurrency: 'GBP' })]);
  assert.equal(await convertPendingFx(store, async () => 5.8), 1);
  assert.equal(store.get().transactions[0].amount, 40.6);
  assert.equal(await convertPendingFx(store, async () => { throw new Error('should not be called'); }), 0);
});

test('rows waiting for conversion are left out of the totals', async () => {
  const { makeLedger } = await import('../public/js/shared/ledger.js');
  const { emptyState } = await import('../lib/store.js');
  const state = { ...emptyState(), transactions: [
    row('a', { amount: 45, needsFx: true, originalAmount: 45, originalCurrency: 'EUR' }),
    row('b', { amount: 100 }),
  ] };
  const L = makeLedger(state);
  assert.equal(L.counts(state.transactions[0]), null);
  assert.equal(L.totals(state.transactions).spend, 100);
});
