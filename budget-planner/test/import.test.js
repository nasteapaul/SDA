// Import and duplicate correctness: amount parsing, CSV quirks (currency,
// status, fee, direction, US dates), merging manual entries into bank ones,
// and re-importing the same statement through the real HTTP handler.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAmount } from '../public/js/shared/money.js';
import { csvToTransactions } from '../public/js/shared/csv.js';
import { mergeDuplicates, rememberDeletedImport, importSeen } from '../public/js/shared/dedupe.js';
import { emptyState } from '../lib/store.js';

// ---------------------------------------------------------------- parseAmount

test('parseAmount: dot thousands without decimals', () => {
  assert.equal(parseAmount('2.500'), 2500);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseAmount('1.234.567,89'), 1234567.89);
  assert.equal(parseAmount('12.50'), 12.5);
  assert.equal(parseAmount('2.5'), 2.5);
  assert.equal(parseAmount('0.500'), 0.5, 'a leading zero is a decimal');
  assert.equal(parseAmount('1,234,567'), 1234567);
});

test('parseAmount: trailing minus and DR / CR suffixes', () => {
  assert.equal(parseAmount('12-'), -12);
  assert.equal(parseAmount('12,50 DR'), -12.5);
  assert.equal(parseAmount('12 DR'), -12);
  assert.equal(parseAmount('12 CR'), 12);
  assert.equal(parseAmount('12.345,00 lei-'), -12345);
  assert.equal(parseAmount('+7,5'), 7.5);
  assert.ok(Number.isNaN(parseAmount('CR')));
});

// ---------------------------------------------------------------------- CSV

test('CSV: foreign-currency rows keep the original amount and are flagged', () => {
  const csv = 'Data;Descriere;Suma;Valuta\n01.09.2026;Lidl;-56,20;RON\n02.09.2026;Amazon DE;-20,00;EUR\n03.09.2026;Fara valuta;-5,00;';
  const { items, needsFx } = csvToTransactions(csv);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { date: '2026-09-01', type: 'expense', amount: 56.2, description: 'Lidl', note: '' });
  assert.equal(items[1].needsFx, true);
  assert.equal(items[1].originalCurrency, 'EUR');
  assert.equal(items[1].originalAmount, 20);
  assert.equal(items[1].amount, 20, 'not converted: the UI must warn');
  assert.equal(items[2].needsFx, undefined, 'empty currency = RON');
  assert.equal(needsFx, 1);
});

test('CSV: "Data valuta" is a date column, not a currency column', () => {
  const csv = 'Data tranzactie;Data valuta;Descriere;Debit;Credit\n01.09.2026;01.09.2026;POS KAUFLAND;123,45;';
  const { items } = csvToTransactions(csv);
  assert.equal(items[0].needsFx, undefined);
});

test('CSV: rows that did not complete are skipped and counted', () => {
  const csv = [
    'Type,Started Date,Completed Date,Description,Amount,Fee,Currency,State',
    'CARD_PAYMENT,2026-09-03 10:00,2026-09-04 10:00,Lidl,-56.20,0.00,RON,COMPLETED',
    'CARD_PAYMENT,2026-09-03 11:00,2026-09-04 11:00,Emag,-99.00,0.00,RON,REVERTED',
    'CARD_PAYMENT,2026-09-03 12:00,2026-09-04 12:00,Bolt,-15.00,0.00,RON,DECLINED',
    'CARD_PAYMENT,2026-09-03 13:00,2026-09-04 13:00,Uber,-15.00,0.00,RON,PENDING',
    'CARD_PAYMENT,2026-09-03 14:00,2026-09-04 14:00,Glovo,-15.00,0.00,RON,FAILED',
  ].join('\n');
  const { items, skipped } = csvToTransactions(csv);
  assert.deepEqual(items.map((i) => i.description), ['Lidl']);
  assert.equal(skipped, 4);
  const ro = 'Data;Descriere;Suma;Stare\n01.09.2026;A;-1,00;Finalizata\n02.09.2026;B;-2,00;Anulata';
  assert.deepEqual(csvToTransactions(ro).items.map((i) => i.description), ['A']);
});

test('CSV: the fee is part of what you paid', () => {
  const csv = 'Type,Completed Date,Description,Amount,Fee,Currency\nTRANSFER,2026-09-04,To Ana,-100.00,1.50,RON\nATM,2026-09-05,ATM fee only,0.00,2.00,RON\nTOPUP,2026-09-06,Top-up,50.00,0.50,RON';
  const { items } = csvToTransactions(csv);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => [i.type, i.amount]), [['expense', 101.5], ['expense', 2], ['income', 49.5]]);
});

test('CSV: unsigned amount + direction column', () => {
  const csv = 'Data;Descriere;Suma;Tip\n01.09.2026;Kaufland;45,50;Debit\n02.09.2026;Salariu;7.500,00;Credit\n03.09.2026;Lidl;10,00;D\n04.09.2026;Retur;5,00;CR\n05.09.2026;Bolt;12,00;out';
  const { items } = csvToTransactions(csv);
  assert.deepEqual(items.map((i) => [i.type, i.amount]), [['expense', 45.5], ['income', 7500], ['expense', 10], ['income', 5], ['expense', 12]]);
  const dc = 'Date,Description,Amount,Debit/Credit\n2026-09-01,Shop,12.00,DB\n2026-09-02,Pay,30.00,CR';
  assert.deepEqual(csvToTransactions(dc).items.map((i) => i.type), ['expense', 'income']);
});

test('CSV: Revolut "Type" values are not a direction', () => {
  const csv = 'Type,Product,Completed Date,Description,Amount,Currency\nCARD_PAYMENT,Current,2026-09-04,Lidl,-56.20,RON\nTOPUP,Current,2026-09-05,Top-up,500.00,RON';
  assert.deepEqual(csvToTransactions(csv).items.map((i) => i.type), ['expense', 'income']);
});

test('CSV: the date order is decided per file', () => {
  const us = 'Date,Description,Amount\n09/03/2026,A,-1.00\n09/25/2026,B,-2.00';
  assert.deepEqual(csvToTransactions(us).items.map((i) => i.date), ['2026-09-03', '2026-09-25']);
  const ro = 'Data;Descriere;Suma\n09/03/2026;A;-1,00\n25/09/2026;B;-2,00';
  assert.deepEqual(csvToTransactions(ro).items.map((i) => i.date), ['2026-03-09', '2026-09-25']);
  const ambiguous = 'Data;Descriere;Suma\n09/03/2026;A;-1,00';
  assert.deepEqual(csvToTransactions(ambiguous).items.map((i) => i.date), ['2026-03-09'], 'Romanian by default');
});

// ------------------------------------------------------------ manual vs bank

const accounts = () => ({ connections: [{ accounts: [{ uid: 'cur', kind: 'current' }, { uid: 'card', kind: 'credit' }] }] });
const withCats = (transactions) => ({ categories: emptyState().categories, bank: accounts(), transactions });

test('a cash entry is not swallowed by a card purchase days later', () => {
  const state = withCats([
    { id: 'm', source: 'manual', type: 'expense', amount: 45.5, date: '2026-09-01', description: 'Kaufland', createdAt: 'a', updatedAt: 'a' },
    { id: 'b', source: 'bank', accountId: 'card', type: 'expense', amount: 45.5, date: '2026-09-03', description: 'KAUFLAND 1270 ORADEA', createdAt: 'b', updatedAt: 'b' },
  ]);
  assert.equal(mergeDuplicates(state), 0);
  assert.equal(state.transactions.length, 2);
});

test('a manual entry merges only on the same day, amount and account', () => {
  const m = { id: 'm', source: 'manual', type: 'expense', amount: 45.5, date: '2026-09-03', description: 'Kaufland', category: 'Groceries', createdAt: 'a', updatedAt: 'a' };
  const b = { id: 'b', source: 'bank', type: 'expense', amount: 45.5, date: '2026-09-03', description: 'KAUFLAND 1270', createdAt: 'b', updatedAt: 'b' };
  const onCard = withCats([{ ...m }, { ...b, accountId: 'card' }]);
  assert.equal(mergeDuplicates(onCard), 0, 'manual entry (current account) vs card purchase');
  const sameAcc = withCats([{ ...m }, { ...b, accountId: 'cur' }]);
  assert.equal(mergeDuplicates(sameAcc), 1);
  assert.equal(sameAcc.transactions[0].category, 'Groceries');
  const cardManual = withCats([{ ...m, accountId: 'card' }, { ...b, accountId: 'card' }]);
  assert.equal(mergeDuplicates(cardManual), 1, 'manual entry marked as card');
});

test('CSV imports still merge into the bank copy a few days apart', () => {
  const state = withCats([
    { id: 'c', source: 'import', batchId: 'x', type: 'expense', amount: 45.5, date: '2026-09-01', description: 'POS KAUFLAND', createdAt: 'a', updatedAt: 'a' },
    { id: 'b', source: 'bank', accountId: 'cur', type: 'expense', amount: 45.5, date: '2026-09-03', description: 'Kaufland 1234', createdAt: 'b', updatedAt: 'b' },
  ]);
  assert.equal(mergeDuplicates(state), 1);
});

// ---------------------------------------------------------- import fingerprints

test('importSeen ignores the account choice but not the real account', () => {
  const bare = '2026-09-01|expense|10|x|';
  const old = { id: 'o', source: 'import', batchId: 'A', type: 'expense', amount: 10, date: '2026-09-01', description: 'x', accountId: 'cur', accountChosen: true, importHash: `cur|${bare}` };
  const state = withCats([old]);
  const autoRow = { source: 'import', batchId: 'B', type: 'expense', amount: 10, date: '2026-09-01', description: 'x', importHash: `|${bare}` };
  assert.ok(importSeen(state, [autoRow]).has(autoRow, bare), 'auto resolves to the current account');
  const cardRow = { ...autoRow, accountId: 'card', accountChosen: true, importHash: `card|${bare}` };
  assert.ok(!importSeen(state, [cardRow]).has(cardRow, bare), 'a card statement with the same row is different');
});

test('rememberDeletedImport records the fingerprint once', () => {
  const tx = { id: 't', source: 'import', type: 'expense', amount: 10, date: '2026-09-01', description: 'x', importHash: '|2026-09-01|expense|10|x|' };
  const state = withCats([tx]);
  assert.equal(rememberDeletedImport(state, tx), true);
  assert.equal(rememberDeletedImport(state, tx), true);
  assert.deepEqual(state.deletedImportHashes, ['cur|2026-09-01|expense|10|x|']);
  assert.equal(rememberDeletedImport(state, { id: 'm', source: 'manual' }), false);
  const fresh = { source: 'import', batchId: 'Z', type: 'expense', amount: 10, date: '2026-09-01', description: 'x', importHash: 'cur|2026-09-01|expense|10|x|' };
  state.transactions = [];
  assert.ok(importSeen(state, [fresh]).has(fresh, '2026-09-01|expense|10|x|'));
});

// ------------------------------------------------------------ HTTP handler

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-123';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let dataDir; let child; let token;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-import-'));
  const state = { ...emptyState(), bank: { ...emptyState().bank, connections: [{ id: 'c1', accounts: [{ uid: 'cur', kind: 'current', name: 'Current' }, { uid: 'card', kind: 'credit', name: 'Card' }] }] } };
  await writeFile(path.join(dataDir, 'budget.json'), JSON.stringify(state));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: '', EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('running on')) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  ({ token } = await res.json());
});
after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

const api = async (p, method = 'GET', body) => {
  const res = await fetch(`${BASE}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(res.status, 200, `${method} ${p}`);
  return res.json();
};
const count = async () => (await api('/api/state')).transactions.length;
const rows = (prefix) => [
  { date: '2026-08-01', type: 'expense', amount: 10, description: `${prefix} Shop`, note: '' },
  { date: '2026-08-01', type: 'expense', amount: 10, description: `${prefix} Shop`, note: '' }, // genuine twin
  { date: '2026-08-02', type: 'income', amount: 500, description: `${prefix} Pay`, note: '' },
];

test('HTTP: the same file imported as "Current account" then "auto" adds nothing', async () => {
  const before = await count();
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('A'), accountId: 'cur' })).added, 3);
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('A') })).added, 0);
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('A'), accountId: 'cur' })).added, 0);
  assert.equal(await count(), before + 3);
});

test('HTTP: identical rows on two different statements both import', async () => {
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('B'), accountId: 'cur' })).added, 3);
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('B'), accountId: 'card' })).added, 3);
});

test('HTTP: a row deleted after import stays deleted on re-import', async () => {
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('C') })).added, 3);
  // The delete handler is owned elsewhere; emulate what it will do via the shared helper's contract.
  const state = await api('/api/state');
  const victim = state.transactions.find((t) => t.description === 'C Pay');
  const { readFile } = await import('node:fs/promises');
  child.kill();
  await new Promise((r) => child.once('exit', r));
  const file = path.join(dataDir, 'budget.json');
  const disk = JSON.parse(await readFile(file, 'utf8'));
  rememberDeletedImport(disk, disk.transactions.find((t) => t.id === victim.id));
  disk.transactions = disk.transactions.filter((t) => t.id !== victim.id);
  await writeFile(file, JSON.stringify(disk));
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: '', EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => { let out = ''; child.stdout.on('data', (d) => { out += d; if (out.includes('running on')) resolve(); }); });
  token = (await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
  assert.equal((await api('/api/transactions/import', 'POST', { items: rows('C') })).added, 0);
});

test('HTTP: foreign-currency rows keep their flags', async () => {
  const items = [{ date: '2026-08-05', type: 'expense', amount: 20, description: 'Amazon DE', note: '', needsFx: true, originalCurrency: 'EUR', originalAmount: 20 }];
  assert.equal((await api('/api/transactions/import', 'POST', { items })).added, 1);
  const t = (await api('/api/state')).transactions.find((x) => x.description === 'Amazon DE');
  assert.equal(t.needsFx, true);
  assert.equal(t.originalCurrency, 'EUR');
  assert.equal(t.originalAmount, 20);
  const bad = [{ date: '2026-08-06', type: 'expense', amount: 5, description: 'Bad fx', note: '', needsFx: true, originalCurrency: '<script>', originalAmount: 'x' }];
  await api('/api/transactions/import', 'POST', { items: bad });
  const b = (await api('/api/state')).transactions.find((x) => x.description === 'Bad fx');
  assert.equal(b.originalCurrency, undefined);
});
