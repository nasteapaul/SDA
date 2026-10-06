import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.js';
import { syncBank, recordBalance, moveAccount } from '../lib/sync.js';
import {
  appendSnapshot, snapshotPair, reconcile, lastSnapshots, HISTORY_CAP,
} from '../public/js/shared/reconcile.js';

// ---------------------------------------------------------------- snapshots

test('appendSnapshot: adds a snapshot, skips an unchanged balance on the same day', () => {
  let h = appendSnapshot([], { date: '2026-10-01T08:00:00.000Z', amount: 100 });
  assert.deepEqual(h, [{ date: '2026-10-01T08:00:00.000Z', amount: 100 }]);
  h = appendSnapshot(h, { date: '2026-10-01T18:00:00.000Z', amount: 100 });
  assert.equal(h.length, 1, 'same day, same amount: skipped');
  h = appendSnapshot(h, { date: '2026-10-01T19:00:00.000Z', amount: 90 });
  assert.equal(h.length, 2, 'same day, changed: kept');
  h = appendSnapshot(h, { date: '2026-10-02T08:00:00.000Z', amount: 90 });
  assert.equal(h.length, 3, 'next day, unchanged: kept (one per day at least)');
});

test('appendSnapshot: ignores invalid input and does not mutate the history', () => {
  const h = [{ date: '2026-10-01T08:00:00.000Z', amount: 1 }];
  assert.equal(appendSnapshot(h, { date: 'x', amount: 5 }), h);
  assert.equal(appendSnapshot(h, { date: '2026-10-02T08:00:00.000Z', amount: Number.NaN }), h);
  const next = appendSnapshot(h, { date: '2026-10-02T08:00:00.000Z', amount: '7.555' });
  assert.notEqual(next, h);
  assert.equal(h.length, 1);
  assert.equal(next[1].amount, 7.56, 'rounded to 2 decimals');
  assert.deepEqual(appendSnapshot(undefined, { date: '2026-10-02T08:00:00.000Z', amount: 1 }).length, 1);
});

test('appendSnapshot: keeps at most HISTORY_CAP (400) entries, newest last', () => {
  let h = [];
  const start = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < HISTORY_CAP + 25; i += 1) h = appendSnapshot(h, { date: new Date(start + i * 86400000).toISOString(), amount: i });
  assert.equal(HISTORY_CAP, 400);
  assert.equal(h.length, 400);
  assert.equal(h[399].amount, HISTORY_CAP + 24);
  assert.equal(h[0].amount, 25);
});

test('snapshotPair: latest snapshot and the latest one from an earlier day', () => {
  const h = [
    { date: '2026-10-01T08:00:00.000Z', amount: 1 },
    { date: '2026-10-02T08:00:00.000Z', amount: 2 },
    { date: '2026-10-03T08:00:00.000Z', amount: 3 },
    { date: '2026-10-03T19:00:00.000Z', amount: 4 },
  ];
  const { prev, last } = snapshotPair(h);
  assert.equal(prev.amount, 2);
  assert.equal(last.amount, 4);
  assert.equal(snapshotPair([h[0]]), null);
  assert.equal(snapshotPair([]), null);
  assert.equal(snapshotPair(undefined), null);
  // Only same-day snapshots: fall back to the one before the last.
  assert.equal(snapshotPair(h.slice(2)).prev.amount, 3);
});

test('lastSnapshots: the pair reconcile needs, per account (for the browser)', () => {
  const h = { a1: [{ date: '2026-10-01T08:00:00.000Z', amount: 1 }, { date: '2026-10-02T08:00:00.000Z', amount: 2 }, { date: '2026-10-03T08:00:00.000Z', amount: 3 }], a2: [{ date: '2026-10-03T08:00:00.000Z', amount: 9 }] };
  assert.deepEqual(lastSnapshots(h), { a1: [h.a1[1], h.a1[2]], a2: [h.a2[0]] });
  assert.deepEqual(lastSnapshots(undefined), {});
});

// ---------------------------------------------------------------- reconcile

function state({ history, transactions = [], account = {} } = {}) {
  return {
    bank: {
      connections: [{ sessionId: 's', accounts: [{ uid: 'cur', name: 'Current', currency: 'RON', balance: { amount: 0, currency: 'RON' }, ...account }] }],
      balanceHistory: { cur: history },
    },
    transactions,
  };
}
const t = (o) => ({ source: 'bank', accountId: 'cur', type: 'expense', amount: 10, date: '2026-10-02', ...o });
const H = [{ date: '2026-10-01T08:00:00.000Z', amount: 1000 }, { date: '2026-10-03T08:00:00.000Z', amount: 1170 }];

test('reconcile: previous balance + money in − money out = latest balance → ok', () => {
  const r = reconcile(state({
    history: H,
    transactions: [t({ type: 'income', amount: 300 }), t({ amount: 100, date: '2026-10-03' }), t({ amount: 30, source: 'import' })],
  }), 'cur');
  assert.equal(r.ok, true);
  assert.equal(r.diff, 0);
  assert.equal(r.txCount, 3);
  assert.equal(r.from, H[0].date);
  assert.equal(r.to, H[1].date);
  assert.equal(r.fromDay, '2026-10-01');
  assert.equal(r.toDay, '2026-10-03');
});

test('reconcile: a missing transaction shows up as a difference', () => {
  const r = reconcile(state({ history: H, transactions: [t({ type: 'income', amount: 300 }), t({ amount: 100 })] }), 'cur');
  assert.equal(r.ok, false);
  assert.equal(r.diff, -30, 'the bank has 30 RON less than the app explains');
  assert.equal(r.pendingPossible, true);
});

test('reconcile: only bank/import rows on that account, in the window, count', () => {
  const r = reconcile(state({
    history: H,
    transactions: [
      t({ type: 'income', amount: 300 }), t({ amount: 130 }),
      t({ amount: 999, source: 'manual' }), // cash, not on the bank account
      t({ amount: 999, accountId: 'card' }), // another account
      t({ amount: 999, date: '2026-09-30' }), // before the window
      t({ amount: 999, date: '2026-10-04' }), // after the window
    ],
  }), 'cur');
  assert.equal(r.ok, true);
  assert.equal(r.txCount, 2);
});

test('reconcile: own-account transfers still move the balance', () => {
  const r = reconcile(state({ history: H, transactions: [t({ type: 'income', amount: 300 }), t({ amount: 130, category: 'Transfers' })] }), 'cur');
  assert.equal(r.ok, true);
});

test('reconcile: tolerance of one ban', () => {
  const ok = reconcile(state({ history: H, transactions: [t({ type: 'income', amount: 300 }), t({ amount: 130.01 })] }), 'cur');
  assert.equal(ok.ok, true);
  const off = reconcile(state({ history: H, transactions: [t({ type: 'income', amount: 300 }), t({ amount: 130.02 })] }), 'cur');
  assert.equal(off.ok, false);
});

test('reconcile: rows booked on the day of the earlier snapshot are tried when needed', () => {
  // Booked later on 1 Oct, after the morning snapshot.
  const r = reconcile(state({ history: H, transactions: [t({ type: 'income', amount: 300, date: '2026-10-01' }), t({ amount: 130 })] }), 'cur');
  assert.equal(r.ok, true);
  assert.equal(r.txCount, 2);
});

test('reconcile: uses an account-of function when given (imports matched by card number)', () => {
  const rows = [t({ type: 'income', amount: 300 }), t({ amount: 130, source: 'import', accountId: undefined })];
  assert.equal(reconcile(state({ history: H, transactions: rows }), 'cur').ok, false);
  const accountOf = (x) => ({ uid: x.accountId || 'cur' });
  assert.equal(reconcile(state({ history: H, transactions: rows }), 'cur', { accountOf }).ok, true);
});

test('reconcile: credit card owed balance — spending raises the debt', () => {
  const r = reconcile(state({
    account: { kind: 'credit', creditLimit: 5000, balance: { amount: 600, currency: 'RON', type: 'CLBD' } },
    history: [{ date: '2026-10-01T08:00:00.000Z', amount: 500 }, { date: '2026-10-03T08:00:00.000Z', amount: 600 }],
    transactions: [t({ amount: 150 }), t({ type: 'income', amount: 50 })],
  }), 'cur');
  assert.equal(r.ok, true);
});

test('reconcile: credit card reporting the credit available', () => {
  const r = reconcile(state({
    account: { kind: 'credit', creditLimit: 5000, balanceMeaning: 'available', balance: { amount: 4400, currency: 'RON' } },
    history: [{ date: '2026-10-01T08:00:00.000Z', amount: 4500 }, { date: '2026-10-03T08:00:00.000Z', amount: 4400 }],
    transactions: [t({ amount: 100 })],
  }), 'cur');
  assert.equal(r.ok, true);
});

test('reconcile: foreign-currency account compares in its own currency', () => {
  const r = reconcile(state({
    account: { currency: 'EUR', balance: { amount: 80, currency: 'EUR' } },
    history: [{ date: '2026-10-01T08:00:00.000Z', amount: 100 }, { date: '2026-10-03T08:00:00.000Z', amount: 80 }],
    transactions: [t({ amount: 99.5, originalAmount: 20, originalCurrency: 'EUR' })],
  }), 'cur');
  assert.equal(r.ok, true);
});

test('reconcile: null without two snapshots or for an unknown account', () => {
  assert.equal(reconcile(state({ history: [H[0]] }), 'cur'), null);
  assert.equal(reconcile(state({ history: undefined }), 'cur'), null);
  assert.equal(reconcile(state({ history: H }), 'nope'), null);
  assert.equal(reconcile({ bank: {}, transactions: [] }, 'cur'), null);
});

// ---------------------------------------------------------------- sync stores the history

test('recordBalance: stores a snapshot per account in bank.balanceHistory', () => {
  const s = { bank: {} };
  recordBalance(s, 'a1', { amount: 1000, currency: 'RON' }, new Date('2026-10-01T08:00:00Z'));
  recordBalance(s, 'a1', { amount: 1000, currency: 'RON' }, new Date('2026-10-01T09:00:00Z'));
  recordBalance(s, 'a1', { amount: 900, currency: 'RON' }, new Date('2026-10-02T09:00:00Z'));
  recordBalance(s, 'a2', null, new Date('2026-10-02T09:00:00Z'));
  assert.deepEqual(s.bank.balanceHistory, { a1: [{ date: '2026-10-01T08:00:00.000Z', amount: 1000 }, { date: '2026-10-02T09:00:00.000Z', amount: 900 }] });
});

test('moveAccount: a re-link moves the balance history to the new uid', () => {
  const s = { transactions: [], deletedBankRefs: [], bank: { balanceHistory: { old: [{ date: '2026-10-01T08:00:00.000Z', amount: 1 }], neu: [{ date: '2026-10-02T08:00:00.000Z', amount: 2 }] } } };
  moveAccount(s, 'old', 'neu');
  assert.deepEqual(s.bank.balanceHistory, { neu: [{ date: '2026-10-01T08:00:00.000Z', amount: 1 }, { date: '2026-10-02T08:00:00.000Z', amount: 2 }] });
});

test('syncBank: each successful balance fetch is recorded; failed accounts are not', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-rec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(path.join(dir, 'budget.json')).load();
  await store.mutate((s) => {
    s.bank.connections.push({
      sessionId: 's1', bank: 'Test', validUntil: new Date(Date.now() + 86400000 * 30).toISOString(),
      accounts: [{ uid: 'a1', currency: 'RON', detailsFetched: true }, { uid: 'a2', currency: 'RON', detailsFetched: true }],
    });
  });
  const client = {
    balances: async (uid) => {
      if (uid === 'a2') throw new Error('down');
      return [{ balance_type: 'CLBD', balance_amount: { amount: '1234.50', currency: 'RON' } }];
    },
    transactions: async () => [],
    accountDetails: async () => ({}),
  };
  await syncBank(store, client, { rate: async () => 1 });
  const h = store.get().bank.balanceHistory;
  assert.equal(h.a1.length, 1);
  assert.equal(h.a1[0].amount, 1234.5);
  assert.ok(!Number.isNaN(Date.parse(h.a1[0].date)) && h.a1[0].date.includes('T'), 'ISO datetime');
  assert.equal(h.a2, undefined);
  await syncBank(store, client, { rate: async () => 1 });
  assert.equal(store.get().bank.balanceHistory.a1.length, 1, 'unchanged on the same day: not stored twice');
});
