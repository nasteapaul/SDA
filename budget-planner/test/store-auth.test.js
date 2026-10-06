import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.js';
import { Sessions, LoginLimiter } from '../lib/auth.js';
import { DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Store: a mutation that throws changes nothing', async (t) => {
  const file = path.join(await tempDir(t), 'budget.json');
  const store = await new Store(file).load();
  await store.mutate((s) => { s.goals.push({ id: 'g1' }); });
  await assert.rejects(store.mutate((s) => {
    s.goals.push({ id: 'half' });
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(store.get().goals.map((g) => g.id), ['g1'], 'memory rolled back');
  await store.mutate((s) => { s.budgets.Food = 100; });
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(disk.goals.map((g) => g.id), ['g1'], 'the half change never reaches disk');
});

test('Store: concurrent mutations run one after another', async (t) => {
  const store = await new Store(path.join(await tempDir(t), 'budget.json')).load();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate(async (s) => {
    const n = s.transactions.length;
    await new Promise((r) => setTimeout(r, 1));
    s.transactions.push({ id: `t${n}`, i });
  })));
  assert.deepEqual(store.get().transactions.map((x) => x.id), Array.from({ length: 20 }, (_, i) => `t${i}`));
});

test('Store: load adds categories from newer versions without touching edits', async (t) => {
  const file = path.join(await tempDir(t), 'budget.json');
  await writeFile(file, JSON.stringify({ categories: [{ name: 'Groceries', icon: '🥕', kind: 'expense' }] }));
  const store = await new Store(file).load();
  const names = store.get().categories.map((c) => c.name);
  assert.equal(store.get().categories.find((c) => c.name === 'Groceries').icon, '🥕');
  for (const c of DEFAULT_CATEGORIES) assert.ok(names.includes(c.name), c.name);
});

test('Sessions: tokens work until they expire or are revoked', async (t) => {
  const file = path.join(await tempDir(t), '.sessions.json');
  let now = Date.parse('2026-10-01T00:00:00Z');
  const sessions = new Sessions(file, { days: 30, now: () => now });
  const a = await sessions.create();
  const b = await sessions.create();
  assert.notEqual(a.token, b.token);
  assert.ok(sessions.valid(a.token));
  assert.ok(!sessions.valid('forged'));
  assert.ok(!sessions.valid(''));

  assert.ok(!(await readFile(file, 'utf8')).includes(a.token), 'only hashes are stored');
  const reloaded = new Sessions(file, { days: 30, now: () => now });
  assert.ok(reloaded.valid(a.token), 'survives a restart');

  await sessions.revoke(a.token);
  assert.ok(!sessions.valid(a.token));
  assert.ok(sessions.valid(b.token));

  now += 31 * 86400000;
  assert.ok(!sessions.valid(b.token), 'expired');
});

test('Sessions: live-update tickets are single-use and short-lived', async (t) => {
  let now = 0;
  const sessions = new Sessions(path.join(await tempDir(t), '.sessions.json'), { now: () => now });
  const ticket = sessions.ticket();
  assert.ok(sessions.useTicket(ticket));
  assert.ok(!sessions.useTicket(ticket), 'used up');
  const late = sessions.ticket();
  now += 61_000;
  assert.ok(!sessions.useTicket(late), 'expired');
  assert.ok(!sessions.useTicket(null));
});

test('LoginLimiter: blocks after 10 failures for 15 minutes, per IP', () => {
  let now = 0;
  const limiter = new LoginLimiter({ now: () => now });
  for (let i = 0; i < 10; i += 1) limiter.fail('1.1.1.1');
  assert.ok(limiter.blocked('1.1.1.1'));
  assert.ok(!limiter.blocked('2.2.2.2'));
  now += 15 * 60 * 1000;
  assert.ok(!limiter.blocked('1.1.1.1'));
  assert.equal(limiter.attempts.size, 0, 'old entries are dropped');
});

test('LoginLimiter: memory stays bounded', () => {
  const limiter = new LoginLimiter({ maxIps: 100 });
  for (let i = 0; i < 1000; i += 1) limiter.fail(`10.0.${i >> 8}.${i & 255}`);
  assert.ok(limiter.attempts.size <= 100);
});
