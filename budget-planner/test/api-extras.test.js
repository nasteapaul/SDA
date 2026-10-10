// New API pieces on the real server (temporary data folder, random port): input
// validation of the new transaction fields and settings, the net-worth assets,
// the review queue's bulk "these are right", and the alerts feed for the phone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTransaction, cleanSettings, cleanAsset } from '../lib/validate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-123';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

const cleanEnv = (extra) => ({
  ...process.env,
  APP_PASSWORD: '', HOST: '', PORT: '', TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: '',
  EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0', SESSION_DAYS: '', AUTO_SYNC_MIN_MINUTES: '',
  ...extra,
});

let dataDir;
let child;
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-extras-'));
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv({ APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir }), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { output += d; if (output.includes('running on')) resolve(); });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${output}`)));
  });
});
after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

let token;
async function call(method, p, body) {
  if (!token) {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    ({ token } = await res.json());
  }
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const expense = { type: 'expense', amount: 100, date: '2026-10-01', description: 'Hypermarket' };

test('splits: parts must add up to the amount, only on expenses', () => {
  const t = cleanTransaction({ ...expense, splits: [{ category: 'Groceries', amount: 70 }, { category: 'Shopping', amount: 30 }] });
  assert.deepEqual(t.splits, [{ category: 'Groceries', amount: 70 }, { category: 'Shopping', amount: 30 }]);
  assert.throws(() => cleanTransaction({ ...expense, splits: [{ category: 'Groceries', amount: 70 }, { category: 'Shopping', amount: 20 }] }), /add up/);
  assert.throws(() => cleanTransaction({ ...expense, type: 'income', splits: [{ category: 'Salary', amount: 70 }, { category: 'Other income', amount: 30 }] }), /Only expenses/);
  assert.throws(() => cleanTransaction({ ...expense, splits: [{ category: 'Groceries', amount: 100 }] }), /2 to 10/);
  assert.throws(() => cleanTransaction({ ...expense, splits: [{ category: '', amount: 50 }, { category: 'X', amount: 50 }] }), /category/);
  // The amount changes later: the old split no longer adds up, so it is dropped.
  assert.equal(cleanTransaction({ amount: 120 }, t).splits, null);
  assert.equal(cleanTransaction({ ...expense, splits: null }, t).splits, null);
});

test('refundDue, pocket and reviewed are validated', () => {
  assert.equal(cleanTransaction({ ...expense, refundDue: '2026-10-20' }).refundDue, '2026-10-20');
  assert.equal(cleanTransaction({ ...expense, refundDue: null }).refundDue, null);
  assert.throws(() => cleanTransaction({ ...expense, refundDue: '2026-02-31' }), /refundDue/);
  assert.equal(cleanTransaction({ ...expense, pocket: 'vouchers' }).pocket, 'vouchers');
  assert.throws(() => cleanTransaction({ ...expense, pocket: 'cash' }), /pocket/);
  assert.throws(() => cleanTransaction({ pocket: 'vouchers' }, { ...expense, source: 'bank' }), /Bank transactions/);
  assert.equal(cleanTransaction({ ...expense, reviewed: 1 }).reviewed, true);
});

test('new settings: recurring choices, meal vouchers, reserve, alert switches', () => {
  assert.deepEqual(cleanSettings({ recurring: { 'netflix com': 'confirmed', 'emag': 'ignored' } }).recurring, { 'netflix com': 'confirmed', emag: 'ignored' });
  assert.throws(() => cleanSettings({ recurring: { x: 'maybe' } }), /confirmed or ignored/);
  assert.deepEqual(cleanSettings({ mealVouchers: { enabled: true, perDay: '45' } }).mealVouchers, { enabled: true, perDay: 45 });
  assert.throws(() => cleanSettings({ mealVouchers: { enabled: true, perDay: 5000 } }), /perDay/);
  assert.equal(cleanSettings({ spendBuffer: '200' }).spendBuffer, 200);
  assert.throws(() => cleanSettings({ spendBuffer: -1 }), /negative/);
  assert.deepEqual(cleanSettings({ alerts: { bill: false, price: true, nonsense: false } }).alerts, { bill: false, price: true });
  assert.throws(() => cleanSettings({ alerts: { bill: 'no' } }), /true or false/);
});

test('cleanAsset: name and amount required, unknown kind becomes other', () => {
  assert.deepEqual(cleanAsset({ name: ' Pilon II ', kind: 'pension', amount: '15.000,50' }), { name: 'Pilon II', kind: 'pension', amount: 15000.5 });
  assert.equal(cleanAsset({ name: 'X', kind: 'yacht', amount: 1 }).kind, 'other');
  assert.throws(() => cleanAsset({ kind: 'cash', amount: 5 }), /name/);
  assert.throws(() => cleanAsset({ name: 'X' }), /amount/);
  assert.throws(() => cleanAsset({ name: 'X', amount: -5 }), /negative/);
});

test('assets: create, update, delete over the API; bad ids and amounts refused', async () => {
  let r = await call('PUT', '/api/assets/a1', { name: 'Pilon II', kind: 'pension', amount: 15000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'a1');
  assert.ok(Date.parse(r.body.updatedAt));
  r = await call('PUT', '/api/assets/a1', { amount: 16000 });
  assert.equal(r.body.amount, 16000);
  assert.equal(r.body.name, 'Pilon II', 'an update keeps the fields not sent');
  assert.equal((await call('PUT', '/api/assets/bad%20id', { name: 'X', amount: 1 })).status, 400);
  assert.equal((await call('PUT', '/api/assets/a2', { name: 'X', amount: 'lots' })).status, 400);
  let state = (await call('GET', '/api/state')).body;
  assert.equal(state.assets.length, 1);
  assert.equal((await call('DELETE', '/api/assets/a1')).status, 200);
  state = (await call('GET', '/api/state')).body;
  assert.equal(state.assets.length, 0);
});

test('review: marks several transactions as checked at once', async () => {
  await call('PUT', '/api/transactions/r1', { ...expense, id: 'r1' });
  await call('PUT', '/api/transactions/r2', { ...expense, id: 'r2' });
  const r = await call('POST', '/api/transactions/review', { ids: ['r1', 'r2', 'missing'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.updated, 2);
  const state = (await call('GET', '/api/state')).body;
  assert.ok(state.transactions.filter((t) => t.id === 'r1' || t.id === 'r2').every((t) => t.reviewed));
  assert.equal((await call('POST', '/api/transactions/review', { ids: 'r1' })).status, 400);
});

test('alerts feed: needs the login, returns a list', async () => {
  assert.equal((await fetch(`${BASE}/api/alerts`)).status, 401);
  const r = await call('GET', '/api/alerts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.alerts));
});
