// Starts the real server (temporary data folder, random port) and checks the
// HTTP layer: login, tokens, CSRF protection, input validation, headers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-123';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

// Values from a local .env must not leak into the test server.
const cleanEnv = (extra) => ({
  ...process.env,
  APP_PASSWORD: '', HOST: '', PORT: '', TLS_CERT: '', TLS_KEY: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: '',
  EB_APP_ID: '', EB_PRIVATE_KEY_PATH: '', SYNC_INTERVAL_HOURS: '0', SESSION_DAYS: '', AUTO_SYNC_MIN_MINUTES: '',
  ...extra,
});

function start(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => { output += d; if (output.includes('running on')) resolve(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => reject(Object.assign(new Error(`server exited (${code}): ${output}`), { code, output })));
  });
  return { child, ready, output: () => output };
}

let dataDir;
let server;
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-server-'));
  server = start({ APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir });
  await server.ready;
});
after(async () => {
  server?.child.kill();
  await rm(dataDir, { recursive: true, force: true });
});

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (token, init = {}) => ({ ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
async function login() {
  const res = await fetch(`${BASE}/api/login`, json({ password: PASSWORD }));
  assert.equal(res.status, 200);
  const { token, expiresAt } = await res.json();
  assert.ok(token && Date.parse(expiresAt) > Date.now());
  return token;
}

test('needs a login, and rejects a wrong password', async () => {
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/login`, json({ password: 'wrong' }))).status, 401);
  assert.equal((await fetch(`${BASE}/api/state`, auth('made-up'))).status, 401);
  const token = await login();
  assert.equal((await fetch(`${BASE}/api/state`, auth(token))).status, 200);
});

test('the token is not accepted in the URL', async () => {
  const token = await login();
  assert.equal((await fetch(`${BASE}/api/state?token=${token}`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/events?token=${token}`)).status, 401);
});

test('live updates use a one-time ticket', async () => {
  const token = await login();
  const { ticket } = await (await fetch(`${BASE}/api/events/ticket`, auth(token, { method: 'POST' }))).json();
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?ticket=${ticket}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  ctrl.abort();
  assert.equal((await fetch(`${BASE}/api/events?ticket=${ticket}`)).status, 401, 'ticket used up');
});

test('signing out revokes the token', async () => {
  const token = await login();
  assert.equal((await fetch(`${BASE}/api/logout`, auth(token, { method: 'POST' }))).status, 200);
  assert.equal((await fetch(`${BASE}/api/state`, auth(token))).status, 401);
});

test('blocks cross-site requests', async () => {
  const token = await login();
  const body = JSON.stringify({ planIntensity: 'gentle' });
  const plain = await fetch(`${BASE}/api/settings`, auth(token, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body }));
  assert.equal(plain.status, 415);
  const evil = await fetch(`${BASE}/api/settings`, auth(token, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body }));
  assert.equal(evil.status, 403);
  const same = await fetch(`${BASE}/api/settings`, auth(token, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: BASE }, body }));
  assert.equal(same.status, 200);
});

test('settings ignore internal flags', async () => {
  const token = await login();
  const res = await fetch(`${BASE}/api/settings`, auth(token, { ...json({ importsDeduped: false, planIntensity: 'gentle' }), method: 'PUT' }));
  assert.equal(res.status, 200);
  const { settings } = await (await fetch(`${BASE}/api/state`, auth(token))).json();
  assert.equal(settings.planIntensity, 'gentle');
  assert.equal(settings.importsDeduped, true);
  const bad = await fetch(`${BASE}/api/settings`, auth(token, { ...json({ payday: 99 }), method: 'PUT' }));
  assert.equal(bad.status, 400);
});

test('rule deletion never compiles a regex from the request', async () => {
  const token = await login();
  const started = Date.now();
  const res = await fetch(`${BASE}/api/rules/${encodeURIComponent('(a+)+$')}`, auth(token, { method: 'DELETE' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, updated: 0 });
  assert.ok(Date.now() - started < 2000);
});

test('transactions are validated', async () => {
  const token = await login();
  const put = (body) => fetch(`${BASE}/api/transactions/t1`, auth(token, { ...json(body), method: 'PUT' }));
  assert.equal((await put({ type: 'expense', amount: -5, date: '2026-02-31' })).status, 400);
  const ok = await put({ type: 'expense', amount: '12,50', date: '2026-09-14', description: 'Coffee' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).amount, 12.5);
});

test('bank link completion needs the state it was started with', async () => {
  const token = await login();
  const res = await fetch(`${BASE}/api/bank/complete`, auth(token, json({ url: 'https://example.com/cb?code=abc' })));
  assert.equal(res.status, 400);
});

test('pages are served with security headers', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('refuses to serve the network over plain HTTP', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-server-'));
  try {
    const s = start({ APP_PASSWORD: PASSWORD, HOST: '0.0.0.0', PORT: String(PORT + 1), DATA_DIR: dir });
    const err = await s.ready.then(() => { s.child.kill(); return null; }, (e) => e);
    assert.ok(err, 'server must not start');
    assert.equal(err.code, 1);
    assert.match(err.output, /without HTTPS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses an invalid number in the config', async () => {
  const s = start({ HOST: '127.0.0.1', PORT: String(PORT + 2), SYNC_INTERVAL_HOURS: 'six', DATA_DIR: dataDir });
  const err = await s.ready.then(() => { s.child.kill(); return null; }, (e) => e);
  assert.ok(err);
  assert.match(err.output, /SYNC_INTERVAL_HOURS must be a number/);
});
