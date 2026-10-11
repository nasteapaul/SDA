// Server hardening: clean shutdown, friendly bank-link errors, import limits,
// bad URLs, login limits behind a proxy, gzip + ETags, password change sign-out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Sessions } from '../lib/auth.js';

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

function start(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { output += d; if (output.includes('running on')) resolve(); });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${output}`)));
  });
  return { child, ready, exited, output: () => output };
}

// Raw HTTP, so compressed bodies and odd paths arrive exactly as sent.
function raw(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (token, init = {}) => ({ ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });

let dataDir;
let server;
let token;
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bp-hard-'));
  server = start({ APP_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: dataDir });
  await server.ready;
  ({ token } = await (await fetch(`${BASE}/api/login`, json({ password: PASSWORD }))).json());
});
after(async () => {
  server?.child.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('a bad percent-escape or malformed path is a 400, not a 500', async () => {
  for (const p of ['/%', '/js/%E0%A4%A', '//[', '/api/rules/%E0%A4%A']) {
    const r = await raw(PORT, p, { method: p.startsWith('/api/') ? 'DELETE' : 'GET', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 400, p);
    assert.doesNotMatch(r.body.toString(), /at |Error:/, 'no stack trace');
  }
  assert.doesNotMatch(server.output(), /URIError|ERR_INVALID_URL/, 'not logged as a server error');
});

test('a failed bank link goes back to Settings with a reason', async () => {
  const res = await fetch(`${BASE}/bank/callback?code=abc&state=nope`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/#settings\?bank=error&reason=/);
  assert.match(decodeURIComponent(location.split('reason=')[1]), /Unknown or expired bank link request/);
});

test('an import over 5000 rows reports the cut-off rows separately', async () => {
  const items = Array.from({ length: 5003 }, (_, i) => ({ date: '2026-09-01', type: 'expense', amount: 1 + i, description: `Shop ${i}` }));
  const res = await fetch(`${BASE}/api/transactions/import`, auth(token, json({ items })));
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.truncated, 3);
  assert.equal(r.added, 5000);
  assert.equal(r.skipped, 0, 'cut-off rows are not counted as skipped');
  const small = await (await fetch(`${BASE}/api/transactions/import`, auth(token, json({ items: items.slice(0, 2) })))).json();
  assert.equal(small.truncated, undefined);
  assert.equal(small.skipped, 2, 'already imported');
});

test('login refuses a large body', async () => {
  const res = await fetch(`${BASE}/api/login`, json({ password: 'x'.repeat(5000) }));
  assert.equal(res.status, 413);
});

test('behind a local proxy, failed logins are counted per forwarded client', async () => {
  const attacker = { 'X-Forwarded-For': '203.0.113.9' };
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${BASE}/api/login`, json({ password: 'wrong' }, attacker))).status, 401);
  assert.equal((await fetch(`${BASE}/api/login`, json({ password: 'wrong' }, attacker))).status, 429);
  // A made-up first entry doesn't get around it: the proxy's own (last) entry counts.
  assert.equal((await fetch(`${BASE}/api/login`, json({ password: PASSWORD }, { 'X-Forwarded-For': '1.1.1.1, 203.0.113.9' }))).status, 429);
  assert.equal((await fetch(`${BASE}/api/login`, json({ password: PASSWORD }, { 'X-Forwarded-For': '198.51.100.7' }))).status, 200, 'the owner can still log in');
});

test('JSON and static files are gzipped when accepted, with ETags and 304s', async () => {
  const state = await raw(PORT, '/api/state', { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip, deflate' } });
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-encoding'], 'gzip');
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.ok(JSON.parse(gunzipSync(state.body)).transactions.length >= 5000);
  const etag = state.headers.etag;
  assert.ok(etag);
  const again = await raw(PORT, '/api/state', { headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const plain = await raw(PORT, '/js/app.js');
  assert.equal(plain.headers['content-encoding'], undefined, 'not gzipped unless asked');
  const js = await raw(PORT, '/js/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(js.headers['content-encoding'], 'gzip');
  assert.equal(js.headers.vary, 'Accept-Encoding');
  assert.ok(gunzipSync(js.body).equals(plain.body));
  assert.equal(js.headers.etag, plain.headers.etag);
  const cached = await raw(PORT, '/js/app.js', { headers: { 'If-None-Match': js.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers['x-content-type-options'], 'nosniff');

  const small = await raw(PORT, '/api/health', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(small.headers['content-encoding'], undefined, 'tiny bodies are sent as they are');
  const png = (await raw(PORT, '/icons/icon-192.png', { headers: { 'Accept-Encoding': 'gzip' } }));
  if (png.status === 200) assert.equal(png.headers['content-encoding'], undefined, 'images are not re-compressed');
});

test('SIGTERM ends live-update streams and exits promptly', async (t) => {
  const port = PORT + 1;
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-sig-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = start({ HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir });
  t.after(() => s.child.kill('SIGKILL'));
  await s.ready;
  const streamEnded = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      res.once('data', () => s.child.kill('SIGTERM'));
      res.on('end', resolve);
      res.on('error', resolve);
      res.on('close', resolve);
    }).on('error', reject);
  });
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
  assert.equal(code, 0, 'exited cleanly within 4 s');
  await streamEnded;
});

test('Sessions: a changed password signs every device out', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-pw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.sessions.json');
  // A file from before the check: the hash is recorded, nobody is signed out.
  await writeFile(file, JSON.stringify({ ['a'.repeat(64)]: { createdAt: Date.now(), expiresAt: Date.now() + 86400000 } }));
  let s = new Sessions(file);
  assert.equal(s.sessions.size, 1, 'old file format still loads');
  assert.equal(await s.usePassword('first-pass'), false);
  assert.equal(s.sessions.size, 1);
  const { token: tok } = await s.create();
  assert.doesNotMatch(await readFile(file, 'utf8'), /first-pass/, 'only a salted hash is stored');

  s = new Sessions(file);
  assert.equal(await s.usePassword('first-pass'), false, 'same password: sessions kept');
  assert.ok(s.valid(tok));

  s = new Sessions(file);
  assert.equal(await s.usePassword('second-pass'), true);
  assert.ok(!s.valid(tok), 'old sessions revoked');
  assert.equal(new Sessions(file).sessions.size, 0, 'and that is saved');
});
