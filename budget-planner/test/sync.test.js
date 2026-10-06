import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.js';
import { syncBank, mapBankTransaction, bankRef } from '../lib/sync.js';
import { pickBalance } from '../lib/enablebanking.js';
import { parseBnrRates } from '../lib/fx.js';
import { DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';

const cats = DEFAULT_CATEGORIES;
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const noRates = async (c) => { throw new Error(`unexpected rate lookup for ${c}`); };

function tx(overrides = {}) {
  return {
    transaction_amount: { amount: '25.00', currency: 'RON' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-14',
    creditor: { name: 'KAUFLAND' },
    remittance_information: ['Plata POS KAUFLAND'],
    ...overrides,
  };
}

// A real Store in a temp folder with linked accounts; `t.after` removes the folder.
async function setup(t, accounts = [{ uid: 'a1', name: 'Current' }]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(path.join(dir, 'budget.json')).load();
  await store.mutate((s) => {
    s.bank.connections.push({
      sessionId: 's1', bank: 'Test Bank', validUntil: FUTURE,
      accounts: accounts.map((a) => ({ currency: 'RON', detailsFetched: true, lastSyncDate: null, balance: null, ...a })),
    });
  });
  return store;
}

// Fake Enable Banking client: `txs` maps account uid → transactions (or an Error).
function client(txs, extra = {}) {
  const calls = [];
  return {
    calls,
    balances: async () => [{ balance_type: 'CLBD', balance_amount: { amount: '1000.00', currency: 'RON' } }],
    transactions: async (uid, since) => {
      calls.push({ uid, since });
      const list = txs[uid];
      if (list instanceof Error) throw list;
      return typeof list === 'function' ? list() : list || [];
    },
    accountDetails: async () => ({}),
    ...extra,
  };
}

const bankTxs = (store) => store.get().transactions.filter((t) => t.source === 'bank');

test('syncBank: syncing again does not create duplicates', async (t) => {
  const store = await setup(t);
  const fake = client({ a1: [tx({ entry_reference: 'r1' }), tx({ entry_reference: 'r2', transaction_amount: { amount: '10', currency: 'RON' } })] });
  const first = await syncBank(store, fake, { rate: noRates });
  assert.equal(first.added, 2);
  assert.deepEqual(first.errors, []);
  const second = await syncBank(store, fake, { rate: noRates });
  assert.equal(second.added, 0);
  assert.equal(bankTxs(store).length, 2);
  assert.equal(store.get().bank.connections[0].accounts[0].balance.amount, 1000);
});

test('syncBank: a deleted transaction is not imported again', async (t) => {
  const store = await setup(t);
  const fake = client({ a1: [tx({ entry_reference: 'r1' })] });
  await syncBank(store, fake, { rate: noRates });
  await store.mutate((s) => {
    s.deletedBankRefs.push(s.transactions[0].bankRef);
    s.transactions = [];
  });
  const again = await syncBank(store, fake, { rate: noRates });
  assert.equal(again.added, 0);
  assert.equal(bankTxs(store).length, 0);
});

test('syncBank: identical payments without a bank id are both kept', async (t) => {
  const store = await setup(t);
  const parking = () => tx({ transaction_amount: { amount: '5.00', currency: 'RON' }, creditor: { name: 'PARCARE' }, remittance_information: ['PARCARE'] });
  const fake = client({ a1: () => [parking(), parking()] });
  assert.equal((await syncBank(store, fake, { rate: noRates })).added, 2);
  assert.equal((await syncBank(store, fake, { rate: noRates })).added, 0, 're-sync matches row by row');
  const [first, second] = bankTxs(store);
  assert.notEqual(first.bankRef, second.bankRef);
  assert.equal(first.bankRef, bankRef('a1', parking()), 'first keeps the ref earlier versions stored');
  // Deleting one of them must not hide the other.
  await store.mutate((s) => {
    s.deletedBankRefs.push(second.bankRef);
    s.transactions = s.transactions.filter((x) => x.id !== second.id);
  });
  await syncBank(store, fake, { rate: noRates });
  assert.deepEqual(bankTxs(store).map((x) => x.id), [first.id]);
});

test('syncBank: one failing account does not lose the others', async (t) => {
  const store = await setup(t, [{ uid: 'a1', name: 'Current' }, { uid: 'a2', name: 'Card' }]);
  const fake = client({ a1: new Error('Bank API 500: boom'), a2: [tx({ entry_reference: 'c1' })] });
  const result = await syncBank(store, fake, { rate: noRates });
  assert.equal(result.added, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Current: Bank API 500/);
  assert.match(store.get().bank.lastError, /Current/);
  const [current, card] = store.get().bank.connections[0].accounts;
  assert.equal(current.lastSyncDate, null, 'failed account keeps its old date');
  assert.ok(card.lastSyncDate);
});

test('syncBank: throws when every account fails, and changes nothing', async (t) => {
  const store = await setup(t);
  const before = store.get().updatedAt;
  await assert.rejects(syncBank(store, client({ a1: new Error('Bank API 503: down') }), { rate: noRates }), /down/);
  assert.equal(store.get().updatedAt, before);
});

test('syncBank: an incomplete fetch does not move the sync date forward', async (t) => {
  const store = await setup(t);
  const fake = client({ a1: () => Object.assign([tx({ entry_reference: 'r1' })], { truncated: true }) });
  const result = await syncBank(store, fake, { rate: noRates });
  assert.equal(result.added, 1, 'what was fetched is kept');
  assert.match(result.errors[0], /only part/);
  assert.equal(store.get().bank.connections[0].accounts[0].lastSyncDate, null);
});

test('syncBank: re-fetches the last 30 days for late (backdated) bookings', async (t) => {
  const store = await setup(t, [{ uid: 'a1', name: 'Current', lastSyncDate: '2026-10-01' }]);
  const fake = client({ a1: [] });
  await syncBank(store, fake, { rate: noRates });
  assert.equal(fake.calls[0].since, '2026-09-01');
});

test('syncBank: transactions of an account unlinked mid-sync are dropped', async (t) => {
  const store = await setup(t);
  const fake = client({
    a1: async () => {
      await store.mutate((s) => { s.bank.connections = []; });
      return [tx({ entry_reference: 'r1' })];
    },
  });
  await syncBank(store, fake, { rate: noRates });
  assert.equal(bankTxs(store).length, 0);
});

test('syncBank: a failing account-details call is tolerated', async (t) => {
  const store = await setup(t, [{ uid: 'a1', name: 'Current', detailsFetched: false }]);
  const fake = client({ a1: [tx({ entry_reference: 'r1' })] }, { accountDetails: async () => { throw new Error('nope'); } });
  const result = await syncBank(store, fake, { rate: noRates });
  assert.equal(result.added, 1);
  assert.deepEqual(result.errors, []);
});

test('syncBank: foreign-currency transactions are converted to RON', async (t) => {
  const store = await setup(t, [{ uid: 'a1', name: 'Revolut EUR', currency: 'EUR' }]);
  const fake = client({ a1: [tx({ entry_reference: 'e1', transaction_amount: { amount: '50.00', currency: 'EUR' } })] });
  await syncBank(store, fake, { rate: async (c) => (c === 'EUR' ? 4.9771 : 1) });
  const [t1] = bankTxs(store);
  assert.equal(t1.amount, 248.86);
  assert.equal(t1.currency, 'RON');
  assert.equal(t1.originalAmount, 50);
  assert.equal(t1.originalCurrency, 'EUR');
});

test('syncBank: an unknown exchange rate fails that account instead of counting EUR as RON', async (t) => {
  const store = await setup(t, [{ uid: 'a1', name: 'Revolut' }, { uid: 'a2', name: 'Current' }]);
  const fake = client({ a1: [tx({ entry_reference: 'x1', transaction_amount: { amount: '9', currency: 'XYZ' } })], a2: [tx({ entry_reference: 'r1' })] });
  const result = await syncBank(store, fake, { rate: async (c) => { throw new Error(`No BNR exchange rate for ${c}`); } });
  assert.equal(result.added, 1);
  assert.match(result.errors[0], /Revolut: No BNR exchange rate for XYZ/);
});

test('mapBankTransaction: direction from the indicator, else from the sign', () => {
  const s = { rules: [], categories: cats };
  const salary = { entry_reference: 's', transaction_amount: { amount: '5000', currency: 'RON' }, booking_date: '2026-09-10', debtor: { name: 'EMPLOYER SRL' } };
  assert.equal(mapBankTransaction('a', { ...salary, credit_debit_indicator: 'CRDT' }, s).type, 'income');
  assert.equal(mapBankTransaction('a', { ...salary, credit_debit_indicator: 'DBIT' }, s).type, 'expense');
  assert.equal(mapBankTransaction('a', salary, s).type, 'income', 'positive, no indicator → income');
  const negative = mapBankTransaction('a', { ...salary, transaction_amount: { amount: '-42.10', currency: 'RON' } }, s);
  assert.equal(negative.type, 'expense');
  assert.equal(negative.amount, 42.1);
});

test('mapBankTransaction: edge cases of amounts and dates', () => {
  const s = { rules: [], categories: cats };
  assert.equal(mapBankTransaction('a', tx({ transaction_amount: { amount: '0.00', currency: 'RON' } }), s), null);
  assert.equal(mapBankTransaction('a', tx({ transaction_amount: { amount: '1234.5', currency: 'RON' } }), s).amount, 1234.5);
  const noBooking = mapBankTransaction('a', tx({ booking_date: undefined, value_date: '2026-09-02' }), s);
  assert.equal(noBooking.date, '2026-09-02');
});

test('pickBalance: prefers booked balances and skips unusable ones', () => {
  assert.equal(pickBalance([]), null);
  const b = pickBalance([
    { balance_type: 'ITAV', balance_amount: { amount: '90.005', currency: 'RON' } },
    { balance_type: 'CLBD', balance_amount: { currency: 'RON' } },
    { balance_type: 'XPCD', balance_amount: { amount: '80.104', currency: 'RON' } },
  ]);
  assert.equal(b.type, 'XPCD', 'CLBD has no amount, so XPCD wins over ITAV');
  assert.equal(b.amount, 80.1);
});

test('parseBnrRates reads rates and multipliers', () => {
  const rates = parseBnrRates('<Cube date="2026-10-06"><Rate currency="EUR">4.9771</Rate><Rate currency="HUF" multiplier="100">1.2500</Rate></Cube>');
  assert.equal(rates.EUR, 4.9771);
  assert.equal(rates.HUF, 0.0125);
  assert.equal(rates.RON, 1);
});
