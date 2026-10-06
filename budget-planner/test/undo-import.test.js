// Undo a CSV import: DELETE /api/imports/:batchId moves exactly that batch's
// rows to the trash, leaves everything else alone, and the statement can be
// imported again afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyState } from '../lib/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-undo';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let dataDir; let child; let token;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-undo-import-'));
  const state = {
    ...emptyState(),
    transactions: [
      { id: 'manual-1', source: 'manual', type: 'expense', amount: 12, date: '2026-09-01', description: 'Cash coffee', category: 'Other', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
  };
  await writeFile(path.join(dataDir, 'budget.json'), JSON.stringify(state));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: '', EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('running on')) resolve(); });
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  token = (await res.json()).token;
});

after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

async function call(p, method = 'GET', body, auth = true) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const rows = (tag) => [
  { date: '2026-09-02', type: 'expense', amount: 10, description: `${tag} Lidl`, note: '' },
  { date: '2026-09-03', type: 'expense', amount: 20, description: `${tag} Netflix`, note: '' },
  { date: '2026-09-04', type: 'income', amount: 30, description: `${tag} Refund`, note: '' },
];
const imported = async () => (await call('/api/state')).body.transactions.filter((t) => t.source === 'import');

test('import response carries the batchId of the rows it added', async () => {
  const { status, body } = await call('/api/transactions/import', 'POST', { items: rows('A') });
  assert.equal(status, 200);
  assert.equal(body.added, 3);
  assert.match(body.batchId, /^[A-Za-z0-9_-]{1,64}$/);
  const mine = (await imported()).filter((t) => t.batchId === body.batchId);
  assert.equal(mine.length, 3);
});

test('DELETE /api/imports/:batchId removes only that batch, to the trash', async () => {
  const first = (await call('/api/transactions/import', 'POST', { items: rows('B') })).body;
  const second = (await call('/api/transactions/import', 'POST', { items: rows('C') })).body;
  const before = await imported();

  const { status, body } = await call(`/api/imports/${first.batchId}`, 'DELETE');
  assert.equal(status, 200);
  assert.deepEqual(body, { removed: 3 });

  const after = await imported();
  assert.equal(after.length, before.length - 3);
  assert.ok(!after.some((t) => t.batchId === first.batchId), 'undone batch is gone');
  assert.equal(after.filter((t) => t.batchId === second.batchId).length, 3, 'other batches stay');
  const state = (await call('/api/state')).body;
  assert.ok(state.transactions.some((t) => t.id === 'manual-1'), 'manual rows stay');

  const trash = (await call('/api/trash')).body.trash;
  const undone = trash.filter((e) => e.tx?.batchId === first.batchId);
  assert.equal(undone.length, 3, 'rows are in the trash, restorable');
  assert.ok(undone.every((e) => e.reason === 'undo-import'));
  const restored = await call(`/api/trash/${encodeURIComponent(undone[0].tx.id)}/restore`, 'POST');
  assert.equal(restored.status, 200, 'an undone row can be restored');
});

test('an undone statement can be imported again', async () => {
  const first = (await call('/api/transactions/import', 'POST', { items: rows('D') })).body;
  assert.equal(first.added, 3);
  assert.equal((await call(`/api/imports/${first.batchId}`, 'DELETE')).body.removed, 3);
  const again = (await call('/api/transactions/import', 'POST', { items: rows('D') })).body;
  assert.equal(again.added, 3, 'undo is not a "deleted forever" fingerprint');
  assert.notEqual(again.batchId, first.batchId);
});

test('undoing twice or an unknown batch is a harmless no-op', async () => {
  const { batchId } = (await call('/api/transactions/import', 'POST', { items: rows('E') })).body;
  assert.equal((await call(`/api/imports/${batchId}`, 'DELETE')).body.removed, 3);
  assert.deepEqual((await call(`/api/imports/${batchId}`, 'DELETE')).body, { removed: 0 });
  assert.deepEqual((await call('/api/imports/no-such-batch', 'DELETE')).body, { removed: 0 });
});

test('bad batch ids are rejected and the endpoint needs a login', async () => {
  assert.equal((await call('/api/imports/bad%20id', 'DELETE')).status, 400);
  assert.equal((await call(`/api/imports/${'x'.repeat(65)}`, 'DELETE')).status, 400);
  const { batchId } = (await call('/api/transactions/import', 'POST', { items: rows('F') })).body;
  assert.equal((await call(`/api/imports/${batchId}`, 'DELETE', undefined, false)).status, 401);
  assert.equal((await imported()).filter((t) => t.batchId === batchId).length, 3, 'nothing removed without auth');
});
