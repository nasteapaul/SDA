// Data safety: backups, durable writes, recovery from a corrupt file, the trash,
// tombstones / optimistic concurrency for offline edits, and money validation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsCallback from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Store, pushTrash, addTombstones, removeTransactions, mergeDuplicatesToTrash, restoreFromTrash, TRASH_MAX, TOMBSTONES_MAX } from '../lib/store.js';
import { backupName, createBackup, pruneBackups, dailyBackup } from '../lib/backup.js';
import { runMigrations } from '../lib/migrations.js';
import { cleanTransaction, cleanGoal, cleanBudgets, requireObject, findConflicts, MAX_AMOUNT } from '../lib/validate.js';
import { Data } from '../public/js/data.js';

const fsp = fsCallback.promises;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const tx = (id, extra = {}) => ({
  id, type: 'expense', amount: 10, date: '2026-09-14', description: `Shop ${id}`, category: 'Other',
  source: 'manual', createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z', ...extra,
});

// ---------- backups ----------

test('backupName: date and optional reason', () => {
  const d = new Date(2026, 9, 6, 12, 0, 0);
  assert.equal(backupName(d), 'budget-2026-10-06.json');
  assert.equal(backupName(d, 'pre-migration'), 'budget-2026-10-06-pre-migration.json');
});

test('createBackup copies budget.json; a reason backup never overwrites an earlier one', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  const backups = path.join(dir, 'backups');
  const now = new Date(2026, 9, 6, 9, 30, 0);
  assert.equal(await createBackup(file, { dir: backups, now }), null, 'nothing to back up yet');
  await writeFile(file, '{"v":1}');
  const a = await createBackup(file, { dir: backups, reason: 'pre-delete', now });
  assert.equal(path.basename(a), 'budget-2026-10-06-pre-delete.json');
  await writeFile(file, '{"v":2}');
  const b = await createBackup(file, { dir: backups, reason: 'pre-delete', now: new Date(2026, 9, 6, 10, 0, 0) });
  assert.notEqual(a, b);
  assert.equal(await readFile(a, 'utf8'), '{"v":1}', 'the first backup is kept');
  assert.equal(await readFile(b, 'utf8'), '{"v":2}');
});

test('dailyBackup makes one backup a day', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  const backups = path.join(dir, 'backups');
  await writeFile(file, '{"v":1}');
  const now = new Date(2026, 9, 6, 9, 0, 0);
  assert.ok(await dailyBackup(file, { dir: backups, now }));
  await writeFile(file, '{"v":2}');
  assert.equal(await dailyBackup(file, { dir: backups, now: new Date(2026, 9, 6, 20, 0, 0) }), null, 'already done today');
  assert.equal(await readFile(path.join(backups, 'budget-2026-10-06.json'), 'utf8'), '{"v":1}');
  assert.ok(await dailyBackup(file, { dir: backups, now: new Date(2026, 9, 7, 9, 0, 0) }));
});

test('pruneBackups keeps 14 daily backups and reason backups from the last 30 days', async (t) => {
  const dir = await tempDir(t);
  const now = new Date(2026, 9, 6, 12, 0, 0);
  const day = (n) => new Date(2026, 9, 6 - n, 12, 0, 0);
  for (let n = 0; n < 20; n += 1) await writeFile(path.join(dir, backupName(day(n))), '{}');
  await writeFile(path.join(dir, backupName(day(29), 'pre-migration')), '{}');
  await writeFile(path.join(dir, backupName(day(31), 'pre-migration')), '{}');
  await writeFile(path.join(dir, 'notes.txt'), 'not a backup');
  await pruneBackups(dir, { now });
  const left = (await readdir(dir)).sort();
  const daily = left.filter((n) => /^budget-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  assert.equal(daily.length, 14);
  assert.ok(daily.includes(backupName(day(0))) && daily.includes(backupName(day(13))));
  assert.ok(!daily.includes(backupName(day(14))));
  assert.ok(left.includes(backupName(day(29), 'pre-migration')));
  assert.ok(!left.includes(backupName(day(31), 'pre-migration')));
  assert.ok(left.includes('notes.txt'), 'other files are left alone');
});

// ---------- durable writes and recovery ----------

test('Store.persist writes a temp file, fsyncs it, then renames it into place', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  const store = await new Store(file).load();
  const calls = [];
  const realOpen = fsp.open.bind(fsp);
  t.mock.method(fsp, 'open', async (p, ...rest) => {
    const fh = await realOpen(p, ...rest);
    if (String(p).endsWith('.tmp')) {
      calls.push('open');
      const sync = fh.sync.bind(fh);
      const close = fh.close.bind(fh);
      fh.sync = async () => { calls.push('sync'); return sync(); };
      fh.close = async () => { calls.push('close'); return close(); };
    }
    return fh;
  });
  const realRename = fsp.rename.bind(fsp);
  t.mock.method(fsp, 'rename', async (from, to) => { calls.push('rename'); return realRename(from, to); });
  await store.mutate((s) => { s.budgets.Food = 100; });
  assert.deepEqual(calls, ['open', 'sync', 'close', 'rename']);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).budgets.Food, 100);
  assert.ok(!(await readdir(dir)).some((n) => n.endsWith('.tmp')), 'no temp file left behind');
});

test('Store.load: a corrupt budget.json falls back to the newest backup that parses', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  const backups = path.join(dir, 'backups');
  await mkdir(backups);
  const older = path.join(backups, 'budget-2026-10-04.json');
  const newer = path.join(backups, 'budget-2026-10-05.json');
  const newest = path.join(backups, 'budget-2026-10-06-pre-migration.json');
  await writeFile(older, JSON.stringify({ goals: [{ id: 'old' }] }));
  await writeFile(newer, JSON.stringify({ goals: [{ id: 'good' }] }));
  await writeFile(newest, '{"goals": [ trunc');
  await utimes(older, new Date('2026-10-04'), new Date('2026-10-04'));
  await utimes(newer, new Date('2026-10-05'), new Date('2026-10-05'));
  await utimes(newest, new Date('2026-10-06'), new Date('2026-10-06'));
  await writeFile(file, '{"transactions": [');
  const errors = [];
  t.mock.method(console, 'error', (...a) => { errors.push(a.join(' ')); });
  const store = await new Store(file).load();
  assert.deepEqual(store.get().goals.map((g) => g.id), ['good']);
  assert.ok(errors.some((e) => /corrupt|could not be read/i.test(e)), 'logged loudly');
  const kept = (await readdir(dir)).filter((n) => n.startsWith('budget.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(path.join(dir, kept[0]), 'utf8'), '{"transactions": [');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).goals.map((g) => g.id), ['good'], 'restored copy is on disk');
});

test('Store.load: a corrupt file with no usable backup is not replaced by an empty one', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  await writeFile(file, 'not json');
  t.mock.method(console, 'error', () => {});
  await assert.rejects(new Store(file).load(), /corrupt|backup/i);
  assert.equal(await readFile(file, 'utf8'), 'not json');
});

test('Store.backup copies the file into data/backups', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'budget.json');
  const store = await new Store(file).load();
  const p = await store.backup('pre-delete-imported');
  assert.equal(path.dirname(p), path.join(dir, 'backups'));
  assert.match(path.basename(p), /^budget-\d{4}-\d{2}-\d{2}-pre-delete-imported\.json$/);
});

// ---------- trash and tombstones ----------

test('pushTrash keeps the 500 newest entries and drops ones older than 60 days', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const s = { trash: [{ tx: tx('ancient'), reason: 'delete', removedAt: '2026-07-01T00:00:00.000Z' }] };
  pushTrash(s, Array.from({ length: TRASH_MAX + 5 }, (_, i) => tx(`t${i}`)), 'delete', now);
  assert.equal(s.trash.length, TRASH_MAX);
  assert.ok(!s.trash.some((e) => e.tx.id === 'ancient'));
  assert.ok(s.trash.some((e) => e.tx.id === `t${TRASH_MAX + 4}`), 'newest kept');
  assert.ok(!s.trash.some((e) => e.tx.id === 't0'), 'oldest dropped');
  assert.equal(s.trash.at(-1).reason, 'delete');
  assert.equal(s.trash.at(-1).removedAt, new Date(now).toISOString());
});

test('addTombstones caps the list at the newest 2000 ids', () => {
  const s = { deletedIds: [] };
  addTombstones(s, Array.from({ length: TOMBSTONES_MAX + 10 }, (_, i) => `id${i}`));
  assert.equal(s.deletedIds.length, TOMBSTONES_MAX);
  assert.equal(s.deletedIds.at(-1), `id${TOMBSTONES_MAX + 9}`);
  addTombstones(s, [`id${TOMBSTONES_MAX + 9}`]);
  assert.equal(s.deletedIds.length, TOMBSTONES_MAX, 'no duplicates');
});

test('removeTransactions moves removed rows to the trash, tombstones them and remembers bank refs', () => {
  const s = { transactions: [tx('a'), tx('b', { source: 'bank', bankRef: 'acc:1' }), tx('c')], trash: [], deletedIds: [], deletedBankRefs: [] };
  const removed = removeTransactions(s, (t) => t.id !== 'c', 'delete');
  assert.deepEqual(removed.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(s.transactions.map((t) => t.id), ['c']);
  assert.deepEqual(s.trash.map((e) => [e.tx.id, e.reason]), [['a', 'delete'], ['b', 'delete']]);
  assert.deepEqual(s.deletedIds, ['a', 'b']);
  assert.deepEqual(s.deletedBankRefs, ['acc:1']);
});

test('mergeDuplicatesToTrash puts merged-away duplicates in the trash', () => {
  const csv = tx('csv', { source: 'import', amount: 73.93, date: '2026-09-12', description: 'NETFLIX.COM', importHash: 'h1' });
  const bank = tx('bank', { source: 'bank', amount: 73.93, date: '2026-09-12', description: 'Netflix', bankRef: 'acc:1' });
  const s = { transactions: [csv, bank], trash: [], deletedIds: [], deletedBankRefs: [] };
  assert.equal(mergeDuplicatesToTrash(s), 1);
  assert.deepEqual(s.transactions.map((t) => t.id), ['bank']);
  assert.equal(s.trash.length, 1);
  assert.equal(s.trash[0].tx.id, 'csv');
  assert.equal(s.trash[0].reason, 'duplicate-merge');
  assert.equal(s.trash[0].tx.description, 'NETFLIX.COM', 'the original row is kept unchanged');
});

test('restoreFromTrash puts the original row back and forgets its tombstone and bank ref', () => {
  const s = { transactions: [tx('keep')], trash: [], deletedIds: [], deletedBankRefs: ['other'] };
  s.transactions.push(tx('b', { source: 'bank', bankRef: 'acc:9', note: 'n' }));
  removeTransactions(s, (t) => t.id === 'b', 'delete');
  const restored = restoreFromTrash(s, 'b');
  assert.deepEqual(restored, tx('b', { source: 'bank', bankRef: 'acc:9', note: 'n' }));
  assert.deepEqual(s.transactions.map((t) => t.id), ['keep', 'b']);
  assert.deepEqual(s.trash, []);
  assert.deepEqual(s.deletedIds, []);
  assert.deepEqual(s.deletedBankRefs, ['other']);
  assert.equal(restoreFromTrash(s, 'missing'), null);
});

// ---------- migrations ----------

function fakeStore(state) {
  const calls = [];
  return {
    calls,
    get: () => state,
    backup: async (reason) => { calls.push(`backup:${reason}`); },
    mutate: async (fn) => { calls.push('mutate'); return fn(state); },
  };
}

test('runMigrations backs up before the first migration, and not at all when none is needed', async () => {
  const state = {
    transactions: [], rules: [], categories: [], bank: { connections: [] }, trash: [], deletedIds: [], deletedBankRefs: [],
    settings: { ownTransfersFixed: true, importsDeduped: true, importAccountsAssigned: true },
  };
  const store = fakeStore(state);
  await runMigrations(store, () => {});
  assert.equal(store.calls[0], 'backup:pre-migration');
  assert.ok(store.calls.includes('mutate'));
  assert.equal(state.settings.duplicatesMerged, true, 'the duplicate merge is flagged as done');
  const again = fakeStore(state);
  await runMigrations(again, () => {});
  assert.deepEqual(again.calls, [], 'nothing runs (and no backup) once every migration is done');
});

test('the duplicate merge at startup runs once and sends merged rows to the trash', async () => {
  const csv = tx('csv', { source: 'import', amount: 73.93, date: '2026-09-12', description: 'NETFLIX.COM', importHash: 'h1' });
  const bank = tx('bank', { source: 'bank', amount: 73.93, date: '2026-09-12', description: 'Netflix', bankRef: 'acc:1' });
  const state = {
    transactions: [csv, bank], rules: [], categories: [], bank: { connections: [] }, trash: [], deletedIds: [], deletedBankRefs: [],
    settings: { ownTransfersFixed: true, importsDeduped: true, importAccountsAssigned: true },
  };
  await runMigrations(fakeStore(state), () => {});
  assert.deepEqual(state.transactions.map((t) => t.id), ['bank']);
  assert.deepEqual(state.trash.map((e) => [e.tx.id, e.reason]), [['csv', 'duplicate-merge']]);
  // A new duplicate later is not merged at startup again (sync/import handle those).
  state.transactions.push(tx('csv2', { source: 'import', amount: 73.93, date: '2026-09-12', description: 'NETFLIX.COM', importHash: 'h2' }));
  await runMigrations(fakeStore(state), () => {});
  assert.equal(state.transactions.length, 2);
});

// ---------- validation ----------

test('money amounts must be finite and at most 1e9', () => {
  const base = { type: 'expense', date: '2026-09-14' };
  assert.equal(MAX_AMOUNT, 1e9);
  assert.equal(cleanTransaction({ ...base, amount: 1e9 }).amount, 1e9);
  for (const amount of [1e9 + 1, Infinity, '99999999999', 1e300]) {
    assert.throws(() => cleanTransaction({ ...base, amount }), { status: 400 }, `rejects ${amount}`);
  }
  assert.throws(() => cleanGoal({ name: 'Car', target: 2e9 }), { status: 400 });
  assert.throws(() => cleanGoal({ name: 'Car', target: Infinity }), { status: 400 });
  assert.throws(() => cleanGoal({ name: 'Car', target: 100, initialSaved: -5 }), { status: 400 });
  assert.throws(() => cleanGoal({ name: 'Car', target: 100, initialSaved: 'abc' }), { status: 400 });
  assert.throws(() => cleanGoal({ name: 'Car', target: 100, initialSaved: 2e9 }), { status: 400 });
  assert.equal(cleanGoal({ name: 'Car', target: 100, initialSaved: '' }).initialSaved, 0);
  assert.equal(cleanGoal({ name: 'Car', target: 100, initialSaved: 25 }).initialSaved, 25);
});

test('cleanBudgets: positive limits are kept, zero clears, invalid ones are rejected', () => {
  assert.deepEqual(cleanBudgets({ Food: '1.000,50', Fun: 0, Rent: null }), { Food: 1000.5 });
  assert.deepEqual(cleanBudgets(undefined), {});
  assert.throws(() => cleanBudgets({ Food: 'lots' }), { status: 400 });
  assert.throws(() => cleanBudgets({ Food: 2e9 }), { status: 400 });
  assert.throws(() => cleanBudgets([1, 2]), { status: 400 });
  assert.throws(() => cleanBudgets('x'), { status: 400 });
});

test('requireObject rejects anything but a plain object', () => {
  for (const v of [null, [], 'x', 3, true]) assert.throws(() => requireObject(v), { status: 400 });
  assert.deepEqual(requireObject({ a: 1 }), { a: 1 });
  assert.throws(() => cleanTransaction(null), { status: 400 });
  assert.throws(() => cleanGoal([]), { status: 400 });
});

test('findConflicts: only fields changed on both sides conflict', () => {
  const stored = tx('a', { category: 'Groceries', note: 'server note', updatedAt: '2026-09-15T00:00:00.000Z' });
  // The client changed the note; the server meanwhile changed the category.
  assert.deepEqual(findConflicts(stored, { note: 'mine', base: { note: 'server note' }, baseUpdatedAt: '2026-09-14T10:00:00.000Z' }), []);
  assert.deepEqual(findConflicts(stored, { category: 'Fun', base: { category: 'Other' }, baseUpdatedAt: '2026-09-14T10:00:00.000Z' }), ['category']);
  // Not stale: never a conflict.
  assert.deepEqual(findConflicts(stored, { category: 'Fun', base: { category: 'Other' }, baseUpdatedAt: stored.updatedAt }), []);
  // No base values: every field that differs from the stored row conflicts.
  assert.deepEqual(findConflicts(stored, { category: 'Fun', amount: 10, baseUpdatedAt: '2026-09-14T10:00:00.000Z' }), ['category']);
  // Without baseUpdatedAt (older clients) there is nothing to compare against.
  assert.deepEqual(findConflicts(stored, { category: 'Fun' }), []);
  // Both made the same change: fine.
  assert.deepEqual(findConflicts(stored, { category: 'Groceries', base: { category: 'Other' }, baseUpdatedAt: '2026-09-14T10:00:00.000Z' }), []);
});

// ---------- client: conflicts in the offline outbox ----------

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('client: upsertTransaction sends only the changed fields with the version it last saw', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url === '/api/state') return fakeResponse(200, { transactions: [] });
    return fakeResponse(200, {});
  });
  const data = new Data();
  data.state = { transactions: [tx('a', { category: 'Other', note: '' })] };
  await data.upsertTransaction({ ...tx('a'), category: 'Groceries', note: '' });
  const put = requests.find((r) => r.method === 'PUT');
  assert.equal(put.url, '/api/transactions/a');
  assert.deepEqual(put.body, { category: 'Groceries', baseUpdatedAt: '2026-09-14T10:00:00.000Z', base: { category: 'Other' } });
  // A new transaction is sent whole, without a base.
  await data.upsertTransaction(tx('new'));
  const created = requests.filter((r) => r.method === 'PUT')[1];
  assert.equal(created.body.id, 'new');
  assert.equal(created.body.baseUpdatedAt, undefined);
});

test('client: a 409 drops the change, explains it and reloads', async (t) => {
  const order = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    order.push(`${init.method} ${url}`);
    if (init.method === 'PUT') return fakeResponse(409, { error: 'conflict', current: tx('a', { category: 'Fun' }) });
    if (init.method === 'DELETE') return fakeResponse(200, { ok: true });
    return fakeResponse(200, { transactions: [tx('a', { category: 'Fun' })] });
  });
  const data = new Data();
  data.state = { transactions: [tx('a')] };
  const errors = [];
  data.addEventListener('error', (e) => errors.push(e.detail));
  await data.upsertTransaction({ ...tx('a'), category: 'Groceries' });
  assert.equal(data.outbox.length, 0, 'the rejected change does not jam the queue');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /another device/i);
  assert.equal(order.at(-1), 'GET /api/state', 'reloads the server copy');
  assert.equal(data.state.transactions[0].category, 'Fun');
});

test('client: undo of a delete restores from the trash instead of re-creating', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(`${init.method} ${url}`);
    if (url === '/api/state') return fakeResponse(200, { transactions: [tx('a')] });
    return fakeResponse(200, { ok: true });
  });
  const data = new Data();
  const original = tx('a');
  data.state = { transactions: [original] };
  await data.deleteTransaction('a');
  await data.upsertTransaction(original);
  assert.deepEqual(requests.filter((r) => !r.startsWith('GET')), ['DELETE /api/transactions/a', 'POST /api/trash/a/restore']);
});

// ---------- server ----------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'safety-password-123';
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let dataDir;
let child;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-safety-server-'));
  // An older store: migrations are needed, so a pre-migration backup is taken.
  await writeFile(path.join(dataDir, 'budget.json'), JSON.stringify({
    transactions: [tx('bank1', { source: 'bank', bankRef: 'acc:1', description: 'Kaufland', category: 'Groceries' })],
    deletedBankRefs: [],
  }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir, TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '',
      ALLOW_INSECURE_HTTP: '', EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0', SESSION_DAYS: '', AUTO_SYNC_MIN_MINUTES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
async function call(method, p, body, { auth = true } = {}) {
  if (auth && !token) {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    ({ token } = await res.json());
  }
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('server: startup takes a pre-migration and a daily backup', async () => {
  const names = await readdir(path.join(dataDir, 'backups'));
  assert.ok(names.some((n) => /^budget-\d{4}-\d{2}-\d{2}-pre-migration\.json$/.test(n)), names.join());
  assert.ok(names.some((n) => /^budget-\d{4}-\d{2}-\d{2}\.json$/.test(n)), names.join());
});

test('server: trash endpoints need a login', async () => {
  assert.equal((await call('GET', '/api/trash', undefined, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/trash/x/restore', undefined, { auth: false })).status, 401);
});

test('server: a deleted transaction goes to the trash and a replayed edit cannot bring it back', async () => {
  const created = await call('PUT', '/api/transactions/del1', { type: 'expense', amount: 5, date: '2026-09-14', description: 'Coffee' });
  assert.equal(created.status, 200);
  assert.equal((await call('DELETE', '/api/transactions/del1')).status, 200);
  const replay = await call('PUT', '/api/transactions/del1', { type: 'expense', amount: 6, date: '2026-09-14' });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'deleted');
  const { body } = await call('GET', '/api/trash');
  const entry = body.trash.find((e) => e.tx.id === 'del1');
  assert.equal(entry.reason, 'delete');
  assert.ok(entry.removedAt);
  const state = (await call('GET', '/api/state')).body;
  assert.ok(!state.transactions.some((t) => t.id === 'del1'));
  assert.equal(state.trash, undefined, 'the trash is not sent with every state');
  assert.equal(state.deletedIds, undefined);
});

test('server: restore puts the original bank transaction back unchanged', async () => {
  const before = (await call('GET', '/api/state')).body.transactions.find((t) => t.id === 'bank1');
  assert.equal((await call('DELETE', '/api/transactions/bank1')).status, 200);
  const res = await call('POST', '/api/trash/bank1/restore');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, before);
  const after = (await call('GET', '/api/state')).body.transactions.find((t) => t.id === 'bank1');
  assert.deepEqual(after, before);
  const disk = JSON.parse(await readFile(path.join(dataDir, 'budget.json'), 'utf8'));
  assert.ok(!disk.deletedBankRefs.includes('acc:1'), 'the next sync may see it again');
  assert.ok(!disk.deletedIds.includes('bank1'));
  assert.equal((await call('POST', '/api/trash/bank1/restore')).status, 404, 'not in the trash any more');
  // Editable again after the restore.
  assert.equal((await call('PUT', '/api/transactions/bank1', { note: 'ok' })).status, 200);
});

test('server: a stale edit that overlaps a newer change is refused with the current copy', async () => {
  const first = await call('PUT', '/api/transactions/c1', { type: 'expense', amount: 5, date: '2026-09-14', description: 'Lunch', category: 'Other' });
  const seen = first.body.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const other = await call('PUT', '/api/transactions/c1', { category: 'Groceries', base: { category: 'Other' }, baseUpdatedAt: seen });
  assert.equal(other.status, 200);
  const stale = await call('PUT', '/api/transactions/c1', { category: 'Fun', base: { category: 'Other' }, baseUpdatedAt: seen });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'conflict');
  assert.equal(stale.body.current.category, 'Groceries');
  const disjoint = await call('PUT', '/api/transactions/c1', { note: 'with Ana', base: { note: undefined }, baseUpdatedAt: seen });
  assert.equal(disjoint.status, 200, 'a change to another field still applies');
  assert.equal(disjoint.body.category, 'Groceries');
  assert.equal(disjoint.body.note, 'with Ana');
});

test('server: "start over" backs up first and keeps the removed rows in the trash', async () => {
  const imported = await call('POST', '/api/transactions/import', { items: [{ type: 'expense', amount: 7, date: '2026-09-10', description: 'MEGA IMAGE 123' }] });
  assert.equal(imported.status, 200);
  const res = await call('DELETE', '/api/transactions/imported');
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 1);
  const names = await readdir(path.join(dataDir, 'backups'));
  const backup = names.find((n) => /-pre-delete-imported/.test(n));
  assert.ok(backup, names.join());
  const saved = JSON.parse(await readFile(path.join(dataDir, 'backups', backup), 'utf8'));
  assert.ok(saved.transactions.some((t) => t.source === 'import'), 'the backup still has the imported rows');
  const { body } = await call('GET', '/api/trash');
  assert.ok(body.trash.some((e) => e.tx.source === 'import' && e.reason === 'delete-imported'));
});

test('server: bodies that are not JSON objects get a 400, not a 500', async () => {
  for (const raw of ['null', '[1,2]', '"text"', '42']) {
    for (const [method, p] of [['PUT', '/api/transactions/x1'], ['PUT', '/api/goals/g1'], ['PUT', '/api/settings'], ['POST', '/api/transactions/import'], ['PUT', '/api/budgets']]) {
      const res = await call(method, p, raw);
      assert.equal(res.status, 400, `${method} ${p} ${raw}`);
    }
  }
  assert.equal((await call('PUT', '/api/budgets', { budgets: { Food: 'lots' } })).status, 400);
  assert.equal((await call('PUT', '/api/budgets', { budgets: { Food: 1e10 } })).status, 400);
  assert.equal((await call('PUT', '/api/transactions/x2', { type: 'expense', amount: 1e12, date: '2026-09-14' })).status, 400);
});
