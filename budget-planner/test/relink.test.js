// Bank re-link (new consent → new account uids), sync overlap, and exchange rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store, emptyState } from '../lib/store.js';
import { syncBank, relinkAccounts, accountFromSession, dedupeBankTransactions, bankRateRON } from '../lib/sync.js';
import { bnrRateOn, parseBnrYear, clearFxCache } from '../lib/fx.js';
import { accountIdentity } from '../lib/enablebanking.js';

const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();
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

function client(txs, extra = {}) {
  const calls = [];
  return {
    calls,
    balances: async () => [{ balance_type: 'CLBD', balance_amount: { amount: '1000.00', currency: 'RON' } }],
    transactions: async (uid, since) => {
      calls.push({ uid, since });
      return txs[uid] || [];
    },
    accountDetails: async () => ({}),
    ...extra,
  };
}

async function tempStore(t, mutate) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-relink-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new Store(path.join(dir, 'budget.json')).load();
  if (mutate) await store.mutate(mutate);
  return store;
}

// State with the old link: a current account and a credit card, both customised.
function oldState() {
  const s = emptyState();
  s.bank.connections.push({
    sessionId: 'old-session', bank: 'Banca Transilvania', validUntil: PAST,
    accounts: [
      { uid: 'old-cur', name: 'Cont curent', iban: 'RO49BTRL0000000000007204', currency: 'RON', detailsFetched: true, balance: { amount: 500, currency: 'RON' }, lastSyncDate: '2026-09-20', nickname: 'Salary' },
      { uid: 'old-card', name: 'Card de credit', iban: 'RO49BTRL0000000000008391', currency: 'RON', kind: 'credit', creditLimit: 5000, balanceMeaning: 'available', cardDigits: ['8391'], detailsFetched: true, balance: { amount: 4000, currency: 'RON' }, lastSyncDate: '2026-09-20' },
      { uid: 'old-gone', name: 'Closed savings', iban: 'RO49BTRL0000000000001111', currency: 'RON', kind: 'savings', detailsFetched: true, balance: null, lastSyncDate: '2026-09-20' },
      { uid: 'old-empty', name: 'Never used', iban: 'RO49BTRL0000000000002222', currency: 'RON', detailsFetched: true, balance: null, lastSyncDate: null },
    ],
  });
  s.transactions.push(
    { id: 't1', source: 'bank', accountId: 'old-card', bankRef: 'old-card:E1', amount: 100, type: 'expense', date: '2026-09-18', createdAt: '2026-09-18T10:00:00Z' },
    { id: 't2', source: 'bank', accountId: 'old-cur', bankRef: 'old-cur:E2', amount: 20, type: 'expense', date: '2026-09-19', createdAt: '2026-09-19T10:00:00Z' },
    { id: 't3', source: 'bank', accountId: 'old-gone', bankRef: 'old-gone:E3', amount: 7, type: 'expense', date: '2026-09-01', createdAt: '2026-09-01T10:00:00Z' },
    { id: 't4', source: 'import', accountId: 'old-card', importHash: 'old-card|2026-08-01|9|x', amount: 9, type: 'expense', date: '2026-08-01' },
    { id: 't5', source: 'manual', amount: 3, type: 'expense', date: '2026-09-02' },
  );
  s.deletedBankRefs.push('old-card:DEL1', 'old-cur:hdeadbeef');
  return s;
}

const newSessionAccounts = () => [
  { uid: 'new-cur', name: 'Cont curent', account_id: { iban: 'RO49 BTRL 0000 0000 0000 7204' }, currency: 'RON' },
  { uid: 'new-card', name: 'Card de credit', account_id: { iban: 'RO49BTRL0000000000008391' }, currency: 'RON', cash_account_type: 'CARD' },
].map(accountFromSession);

// ---------- matching + migration ----------

test('relinkAccounts: matches by IBAN and moves transactions, refs and deleted refs to the new uids', () => {
  const s = oldState();
  const conn = { sessionId: 'new-session', bank: 'Banca Transilvania', validUntil: FUTURE, accounts: newSessionAccounts() };
  const result = relinkAccounts(s, conn, s.bank.connections);
  assert.deepEqual(result.matched, { 'old-cur': 'new-cur', 'old-card': 'new-card' });

  const byId = Object.fromEntries(s.transactions.map((t) => [t.id, t]));
  assert.equal(byId.t1.accountId, 'new-card');
  assert.equal(byId.t1.bankRef, 'new-card:E1');
  assert.equal(byId.t2.accountId, 'new-cur');
  assert.equal(byId.t2.bankRef, 'new-cur:E2');
  assert.equal(byId.t4.accountId, 'new-card');
  assert.equal(byId.t4.importHash, 'new-card|2026-08-01|9|x');
  assert.equal(byId.t3.accountId, 'old-gone', 'unmatched accounts keep their transactions');
  assert.equal(byId.t5.accountId, undefined);
  assert.deepEqual([...s.deletedBankRefs].sort(), ['new-card:DEL1', 'new-cur:hdeadbeef']);
});

test('relinkAccounts: carries per-account settings over to the new account', () => {
  const s = oldState();
  const conn = { sessionId: 'new-session', bank: 'Banca Transilvania', validUntil: FUTURE, accounts: newSessionAccounts() };
  relinkAccounts(s, conn, s.bank.connections);
  const [cur, card] = conn.accounts;
  assert.equal(card.uid, 'new-card');
  assert.equal(card.kind, 'credit');
  assert.equal(card.creditLimit, 5000);
  assert.equal(card.balanceMeaning, 'available');
  assert.deepEqual(card.cardDigits, ['8391']);
  assert.equal(card.lastSyncDate, '2026-09-20');
  assert.deepEqual(card.balance, { amount: 4000, currency: 'RON' });
  assert.equal(card.cashAccountType, 'CARD', 'fresh bank data wins');
  assert.equal(cur.nickname, 'Salary');
  assert.equal(cur.iban, 'RO49BTRL0000000000007204');
  assert.equal(cur.lastSyncDate, '2026-09-20');
});

test('relinkAccounts: unmatched old accounts with transactions stay in an archived connection; empty ones go', () => {
  const s = oldState();
  const conn = { sessionId: 'new-session', bank: 'Banca Transilvania', validUntil: FUTURE, accounts: newSessionAccounts() };
  const { archived } = relinkAccounts(s, conn, s.bank.connections);
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.accounts.map((a) => a.uid), ['old-gone']);
  assert.equal(archived.accounts[0].kind, 'savings');
});

test('relinkAccounts: falls back to identification hash, then masked card number', () => {
  const s = emptyState();
  s.bank.connections.push({
    sessionId: 'old', bank: 'Revolut', validUntil: PAST,
    accounts: [
      { uid: 'o1', name: 'EUR', iban: null, identificationHash: 'HASH-A', currency: 'EUR' },
      { uid: 'o2', name: 'Card', iban: null, cardDigits: ['4321'], kind: 'credit', currency: 'RON' },
    ],
  });
  s.transactions.push({ id: 'x', source: 'bank', accountId: 'o2', bankRef: 'o2:R1' });
  const accounts = [
    { uid: 'n2', name: 'Card', account_id: { other: { identification: '5555 **** **** 4321', scheme_name: 'MPAN' } }, currency: 'RON' },
    { uid: 'n1', name: 'EUR', identification_hashes: ['HASH-Z', 'HASH-A'], currency: 'EUR' },
  ].map(accountFromSession);
  const { matched } = relinkAccounts(s, { sessionId: 'new', bank: 'Revolut', validUntil: FUTURE, accounts }, s.bank.connections);
  assert.deepEqual(matched, { o1: 'n1', o2: 'n2' });
  assert.equal(s.transactions[0].bankRef, 'n2:R1');
  assert.equal(accounts[0].kind, 'credit');
});

test('relinkAccounts: an IBAN in a different currency is not the same account', () => {
  const s = emptyState();
  s.bank.connections.push({ sessionId: 'old', bank: 'B', validUntil: PAST, accounts: [{ uid: 'o1', iban: 'RO1', currency: 'EUR' }] });
  const accounts = [accountFromSession({ uid: 'n1', account_id: { iban: 'RO1' }, currency: 'RON' })];
  assert.deepEqual(relinkAccounts(s, { sessionId: 'n', bank: 'B', validUntil: FUTURE, accounts }, s.bank.connections).matched, {});
});

test('accountIdentity: normalises IBAN, hashes and masked PAN', () => {
  assert.deepEqual(accountIdentity({ iban: 'ro49 btrl 1', identificationHash: 'h1', identificationHashes: ['h2'], maskedPan: '**** 8391' }),
    { iban: 'RO49BTRL1', hashes: ['h1', 'h2'], panLast4: '8391' });
  assert.deepEqual(accountIdentity({}), { iban: null, hashes: [], panLast4: null });
});

// ---------- sync after a re-link ----------

test('syncBank after relink: the overlap window is not imported twice and old card spending stays on the card', async (t) => {
  const s0 = oldState();
  const conn = { sessionId: 'new-session', bank: 'Banca Transilvania', validUntil: FUTURE, accounts: newSessionAccounts() };
  const store = await tempStore(t, (s) => {
    Object.assign(s, s0);
    const { archived } = relinkAccounts(s, conn, s.bank.connections);
    s.bank.connections = [conn, archived];
  });
  const fake = client({
    'new-card': [tx({ entry_reference: 'E1', amount: '100' }), tx({ entry_reference: 'E9', booking_date: '2026-10-01' }), tx({ entry_reference: 'DEL1' })],
    'new-cur': [tx({ entry_reference: 'E2' })],
  });
  const result = await syncBank(store, fake, { rate: noRates });
  assert.equal(result.added, 1);
  assert.deepEqual(fake.calls.map((c) => c.uid).sort(), ['new-card', 'new-cur'], 'the archived connection is not synced');
  const card = store.get().transactions.filter((x) => x.accountId === 'new-card' && x.source === 'bank');
  assert.deepEqual(card.map((x) => x.bankRef).sort(), ['new-card:E1', 'new-card:E9']);
  assert.equal(fake.calls.find((c) => c.uid === 'new-card').since, '2026-08-21', '30 days before the carried-over sync date');
});

test('syncBank: transactions already imported twice by an earlier re-link are repaired', async (t) => {
  // Before the fix: old connection removed, its transactions orphaned and duplicated.
  const store = await tempStore(t, (s) => {
    s.bank.connections.push({ sessionId: 'n', bank: 'B', validUntil: FUTURE, accounts: [{ uid: 'new-card', kind: 'credit', currency: 'RON', detailsFetched: true, lastSyncDate: '2026-10-01', balance: null }] });
    s.transactions.push(
      { id: 'a', source: 'bank', accountId: 'old-card', bankRef: 'old-card:E1', manualCategory: true, category: 'Food', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'b', source: 'bank', accountId: 'new-card', bankRef: 'new-card:E1', category: 'Other', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'c', source: 'bank', accountId: 'old-card', bankRef: 'old-card:E0', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'd', source: 'bank', accountId: 'other-orphan', bankRef: 'other-orphan:Z1', createdAt: '2026-08-01T00:00:00Z' },
    );
    s.deletedBankRefs.push('old-card:D1');
  });
  await syncBank(store, client({ 'new-card': [tx({ entry_reference: 'D1' })] }), { rate: noRates });
  const txs = store.get().transactions;
  assert.deepEqual(txs.map((x) => x.id).sort(), ['a', 'c', 'd'], 'the hand-categorised copy is kept');
  const byId = Object.fromEntries(txs.map((x) => [x.id, x]));
  assert.equal(byId.a.accountId, 'new-card');
  assert.equal(byId.a.bankRef, 'new-card:E1');
  assert.equal(byId.c.accountId, 'new-card', 'all of the orphan account follows');
  assert.equal(byId.d.accountId, 'other-orphan', 'no evidence → left alone');
  assert.ok(store.get().deletedBankRefs.includes('new-card:D1'));
});

test('dedupeBankTransactions: same entry id on the same account is one transaction', () => {
  const s = emptyState();
  s.transactions.push(
    { id: '1', source: 'bank', accountId: 'A', bankRef: 'A:X', createdAt: '2026-01-02' },
    { id: '2', source: 'bank', accountId: 'A', bankRef: 'A:X', createdAt: '2026-01-01' },
    { id: '3', source: 'bank', accountId: 'B', bankRef: 'B:X', createdAt: '2026-01-01' },
  );
  assert.equal(dedupeBankTransactions(s), 1);
  assert.deepEqual(s.transactions.map((t) => t.id).sort(), ['2', '3']);
});

test('syncBank: re-fetches the last 30 days for late bookings', async (t) => {
  const store = await tempStore(t, (s) => {
    s.bank.connections.push({ sessionId: 's', bank: 'B', validUntil: FUTURE, accounts: [{ uid: 'a1', currency: 'RON', detailsFetched: true, lastSyncDate: '2026-10-01', balance: null }] });
  });
  const fake = client({ a1: [] });
  await syncBank(store, fake, { rate: noRates });
  assert.equal(fake.calls[0].since, '2026-09-01');
});

// ---------- exchange rates ----------

const YEAR_2026 = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-01-05"><Rate currency="EUR">5.0100</Rate><Rate currency="HUF" multiplier="100">1.3000</Rate></Cube>
<Cube date="2026-09-11"><Rate currency="EUR">5.0500</Rate><Rate currency="USD">4.3000</Rate></Cube>
<Cube date="2026-09-14"><Rate currency="EUR">5.0700</Rate><Rate currency="USD">4.3100</Rate></Cube>
</Body></DataSet>`;
const YEAR_2025 = `<DataSet><Body><Cube date="2025-12-31"><Rate currency="EUR">4.9900</Rate></Cube><Cube date="2025-12-30"><Rate currency="EUR">4.9800</Rate></Cube></Body></DataSet>`;

function mockFetch(t, files) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const year = String(url).match(/nbrfxrates(\d{4})\.xml$/)?.[1];
    if (!year || !files[year]) return new Response('missing', { status: 404 });
    return new Response(files[year], { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; clearFxCache(); });
  clearFxCache();
  return calls;
}

test('parseBnrYear: one entry per day, sorted', () => {
  const days = parseBnrYear(YEAR_2026);
  assert.deepEqual(days.map((d) => d.date), ['2026-01-05', '2026-09-11', '2026-09-14']);
  assert.ok(Math.abs(days[0].rates.HUF - 0.013) < 1e-12);
});

test('bnrRateOn: rate of the booking date, previous business day when missing, cached per year', async (t) => {
  const calls = mockFetch(t, { 2026: YEAR_2026, 2025: YEAR_2025 });
  assert.deepEqual(await bnrRateOn('EUR', '2026-09-14'), { rate: 5.07, date: '2026-09-14' });
  assert.deepEqual(await bnrRateOn('EUR', '2026-09-13'), { rate: 5.05, date: '2026-09-11' }, 'Sunday → Friday');
  assert.deepEqual(await bnrRateOn('USD', '2026-09-12'), { rate: 4.3, date: '2026-09-11' });
  assert.equal(calls.length, 1, 'one download for the year');
  assert.deepEqual(await bnrRateOn('EUR', '2026-01-01'), { rate: 4.99, date: '2025-12-31' }, 'new year → last rate of the previous year');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/www\.bnr\.ro\/files\/xml\/years\/nbrfxrates2026\.xml$/);
  assert.deepEqual(await bnrRateOn('RON', '2026-09-14'), { rate: 1, date: '2026-09-14' });
  await assert.rejects(bnrRateOn('XYZ', '2026-09-14'), /No BNR exchange rate for XYZ/);
});

test('bankRateRON: uses the bank exchange rate when it converts to RON', () => {
  // EUR account, bank says 50 EUR was 252.50 RON.
  assert.equal(bankRateRON(tx({ transaction_amount: { amount: '50', currency: 'EUR' }, exchange_rate: { unit_currency: 'EUR', exchange_rate: '5.05', instructed_amount: { amount: '252.50', currency: 'RON' } } }), 'EUR'), 5.05);
  assert.equal(bankRateRON(tx({ transaction_amount: { amount: '50', currency: 'EUR' }, exchange_rate: { unit_currency: 'EUR', exchange_rate: '5.04' } }), 'EUR'), 5.04);
  assert.equal(bankRateRON(tx({ transaction_amount: { amount: '50', currency: 'EUR' }, exchange_rate: { unit_currency: 'RON', exchange_rate: '0.2' } }), 'EUR'), 5);
  assert.equal(bankRateRON(tx({ transaction_amount: { amount: '50', currency: 'EUR' }, exchange_rate: { unit_currency: 'EUR', exchange_rate: '1.08', instructed_amount: { amount: '54', currency: 'USD' } } }), 'EUR'), null, 'EUR→USD is not a RON rate');
  assert.equal(bankRateRON(tx({ transaction_amount: { amount: '50', currency: 'EUR' } }), 'EUR'), null);
});

test('syncBank: foreign transactions use the bank rate, else BNR of the booking date; rows carry rateDate', async (t) => {
  const store = await tempStore(t, (s) => {
    s.bank.connections.push({ sessionId: 's', bank: 'Revolut', validUntil: FUTURE, accounts: [{ uid: 'eur', currency: 'EUR', detailsFetched: true, lastSyncDate: null, balance: null }] });
  });
  const asked = [];
  const rate = async (c, date) => { asked.push(`${c}@${date}`); return { rate: 5.05, date: '2026-09-11' }; };
  const fake = client({
    eur: [
      tx({ entry_reference: 'b1', booking_date: '2026-09-13', transaction_amount: { amount: '10', currency: 'EUR' } }),
      tx({ entry_reference: 'b2', booking_date: '2026-09-14', transaction_amount: { amount: '10', currency: 'EUR' }, exchange_rate: { unit_currency: 'EUR', exchange_rate: '5.1' } }),
    ],
  }, { balances: async () => [{ balance_type: 'CLBD', balance_amount: { amount: '100.00', currency: 'EUR' } }] });
  await syncBank(store, fake, { rate });
  const rows = Object.fromEntries(store.get().transactions.map((x) => [x.bankRef, x]));
  assert.equal(rows['eur:b1'].amount, 50.5);
  assert.equal(rows['eur:b1'].exchangeRate, 5.05);
  assert.equal(rows['eur:b1'].rateDate, '2026-09-11');
  assert.equal(rows['eur:b1'].rateSource, 'bnr');
  assert.equal(rows['eur:b2'].amount, 51);
  assert.equal(rows['eur:b2'].rateDate, '2026-09-14');
  assert.equal(rows['eur:b2'].rateSource, 'bank');
  assert.ok(asked.includes('EUR@2026-09-13'));
  // The bank's rate converts the row; BNR's rate of the day is kept beside it to show the bank's markup.
  assert.equal(rows['eur:b2'].exchangeRate, 5.1);
  assert.equal(rows['eur:b2'].bnrRate, 5.05);
  assert.equal(rows['eur:b1'].bnrRate, undefined, 'a row converted at BNR doesn’t need it twice');
  assert.equal(asked.filter((x) => x === 'EUR@2026-09-14').length, 1, 'one BNR lookup per currency and day');

  const acc = store.get().bank.connections[0].accounts[0];
  assert.equal(acc.balance.amount, 100);
  assert.equal(acc.balance.currency, 'EUR');
  assert.equal(acc.balance.amountRON, 505);
});

test('syncBank: a RON balance gets amountRON equal to amount; an unknown balance rate does not fail the sync', async (t) => {
  const store = await tempStore(t, (s) => {
    s.bank.connections.push({ sessionId: 's', bank: 'B', validUntil: FUTURE, accounts: [
      { uid: 'ron', currency: 'RON', detailsFetched: true, lastSyncDate: null, balance: null },
      { uid: 'xyz', currency: 'XYZ', detailsFetched: true, lastSyncDate: null, balance: null },
    ] });
  });
  const fake = client({}, {
    balances: async (u) => [{ balance_type: 'CLBD', balance_amount: { amount: '7.00', currency: u === 'ron' ? 'RON' : 'XYZ' } }],
  });
  const result = await syncBank(store, fake, { rate: noRates });
  assert.deepEqual(result.errors, []);
  const [ron, xyz] = store.get().bank.connections[0].accounts;
  assert.equal(ron.balance.amountRON, 7);
  assert.equal(xyz.balance.amount, 7);
  assert.equal(xyz.balance.amountRON, undefined);
});
