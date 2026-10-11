// The browser data layer (public/js/data.js): offline outbox, retries, login, batches.
// Runs in Node with a fake localStorage / fetch / EventSource.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= globalThis;
const { Data } = await import('../public/js/data.js');

const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newData(t, state) {
  store.clear();
  const data = new Data();
  data.state = state;
  t.after(() => data.stopRetry());
  return data;
}

test('an edit made while the post-save refresh is in flight is still sent', async (t) => {
  const sent = [];
  let releaseState;
  let gets = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/state') {
      if (++gets === 1) await new Promise((r) => { releaseState = r; }); // only the first refresh hangs
      return res(200, { updatedAt: 'x', settings: {}, transactions: [] });
    }
    sent.push(`${init.method} ${url}`);
    return res(200, { ok: true });
  });
  const data = newData(t, { updatedAt: 'x', settings: {}, transactions: [] });
  const first = data.setSettings({ spendBuffer: 111 });
  await sleep(20); // PUT done, GET /api/state in flight
  data.setSettings({ spendBuffer: 222 });
  releaseState();
  await first;
  assert.equal(sent.filter((s) => s.startsWith('PUT')).length, 2, 'both edits reach the server');
  assert.equal(data.outbox.length, 0);
});

test('pending edits are flushed when the live connection comes back with an unchanged version', async (t) => {
  let up = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (!up) throw new TypeError('Failed to fetch');
    if (url === '/api/events/ticket') return res(200, { ticket: 'tk' });
    if (url === '/api/state') return res(200, { updatedAt: 'v1', settings: {}, transactions: [] });
    return res(200, { ok: true });
  });
  let es;
  const saved = globalThis.EventSource;
  globalThis.EventSource = class { constructor() { es = this; this.listeners = {}; } addEventListener(n, f) { this.listeners[n] = f; } close() {} };
  t.after(() => { globalThis.EventSource = saved; });
  const data = newData(t, { updatedAt: 'v1', settings: {}, transactions: [] });
  data.token = 't';
  await data.setSettings({ spendBuffer: 5 }); // server down: stays in the outbox
  assert.equal(data.outbox.length, 1);
  assert.equal(data.online, false);
  up = true; // server is back; SSE reconnects and says "version v1"
  await data.connectLive();
  es.listeners.change({ data: JSON.stringify({ updatedAt: 'v1' }) });
  await sleep(50);
  assert.equal(data.outbox.length, 0, 'the queued edit is sent once the server is reachable again');
});

test('after a 401 and a new login the queued edits are sent', async (t) => {
  let authed = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/login') { authed = true; return res(200, { token: 'new' }); }
    if (!authed) return res(401, { error: 'Login required' });
    if (url === '/api/state') return res(200, { updatedAt: 'v1', settings: {}, transactions: [] });
    return res(200, { ok: true });
  });
  const data = newData(t, { updatedAt: 'v1', settings: {}, transactions: [] });
  let authEvents = 0;
  data.addEventListener('auth', () => { authEvents++; });
  await data.setSettings({ spendBuffer: 9 });
  assert.equal(authEvents, 1);
  assert.equal(data.outbox.length, 1);
  await data.login('pw');
  assert.equal(data.outbox.length, 0, 'edits made before the session expired are not left pending');
  assert.equal(data.retryTimer, null, 'a 401 does not start offline retries');
});

test('review of more than 500 transactions is split into batches the server accepts', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url !== '/api/state') bodies.push(JSON.parse(init.body));
    return res(200, url === '/api/state' ? { updatedAt: 'v', transactions: [] } : { updated: 1 });
  });
  const data = newData(t, { updatedAt: 'v', transactions: Array.from({ length: 1100 }, (_, i) => ({ id: `t${i}` })) });
  let changes = 0;
  data.addEventListener('change', () => { changes++; });
  const ids = data.state.transactions.map((x) => x.id);
  const done = data.reviewTransactions([...ids, 't1']); // duplicates are sent once
  assert.equal(changes, 1, 'applied locally in one go');
  assert.ok(data.state.transactions.every((x) => x.reviewed));
  await done;
  assert.deepEqual(bodies.map((b) => b.ids.length), [500, 500, 100]);
  assert.deepEqual(bodies.flatMap((b) => b.ids), ids);
});

test('a network failure becomes a friendly offline error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  const data = newData(t, null);
  await assert.rejects(data.fetch('/api/state'), (err) => err.offline === true && /Can’t reach your budget server/.test(err.message));
});

test('queued edits are retried on a timer while offline, backing off to 2 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let up = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (!up) return res(503, { error: 'restarting' });
    if (url === '/api/state') return res(200, { updatedAt: 'v1', settings: {}, transactions: [] });
    return res(200, { ok: true });
  });
  const data = newData(t, { updatedAt: 'v1', settings: {}, transactions: [] });
  const tick = async (ms) => { t.mock.timers.tick(ms); for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await data.setSettings({ spendBuffer: 1 });
  assert.equal(data.outbox.length, 1);
  assert.equal(data.retryDelay, 15_000);
  await tick(15_000);
  assert.equal(calls, 2, 'retried after 15 s');
  assert.equal(data.retryDelay, 30_000);
  await tick(30_000);
  await tick(60_000);
  assert.equal(data.retryDelay, 120_000);
  await tick(120_000);
  assert.equal(data.retryDelay, 120_000, 'never waits longer than 2 minutes');
  up = true;
  await tick(120_000);
  assert.equal(data.outbox.length, 0, 'sent once the server answers');
  assert.equal(data.retryTimer, null, 'no more retries once the outbox is empty');
  assert.equal(data.online, true);
});

test('coming back online (any successful request) sends the queue', async (t) => {
  let up = false;
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!up) throw new TypeError('Failed to fetch');
    if (url === '/api/state') return res(200, { updatedAt: 'v1', settings: {}, transactions: [] });
    sent.push(`${init.method} ${url}`);
    return res(200, { ok: true });
  });
  const data = newData(t, { updatedAt: 'v1', settings: {}, transactions: [] });
  await data.setSettings({ spendBuffer: 2 });
  assert.equal(data.outbox.length, 1);
  up = true;
  await data.refresh(); // e.g. the periodic refresh
  await sleep(20);
  assert.deepEqual(sent, ['PUT /api/settings']);
  assert.equal(data.outbox.length, 0);
});
