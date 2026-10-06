// Budget planner server: serves the app (phone + laptop), stores data in one
// JSON file and syncs your bank account through Enable Banking (PSD2).
// Zero dependencies — just `node server.js`.

import http from 'node:http';
import https from 'node:https';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

import { Store, removeTransactions, restoreFromTrash, addTombstones, mergeDuplicatesToTrash, TRASH_DAYS } from './lib/store.js';
import { dailyBackup } from './lib/backup.js';
import { EnableBanking } from './lib/enablebanking.js';
import { syncBank, recategorize, accountFromSession, relinkAccounts } from './lib/sync.js';
import { runMigrations } from './lib/migrations.js';
import { Sessions, LoginLimiter } from './lib/auth.js';
import { HttpError, cleanTransaction, cleanGoal, cleanSettings, cleanCategories, cleanBudgets, requireObject, findConflicts } from './lib/validate.js';
import { importSeen, rememberDeletedImport } from './public/js/shared/dedupe.js';
import { ownContext, ownTransferCategory } from './public/js/shared/own.js';
import { categorize, escapeForRule, merchantKey, isUselessKeyword, ruleMatches } from './public/js/shared/categories.js';
import { round2, uid } from './public/js/shared/money.js';
import { lastSnapshots } from './public/js/shared/reconcile.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }

// ---------- config ----------
const env = process.env;
const configErrors = [];
function numberSetting(name, fallback, { min = 0, max = Infinity } = {}) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const n = Number(env[name]);
  if (!Number.isFinite(n) || n < min || n > max) configErrors.push(`${name} must be a number between ${min} and ${max} (got "${env[name]}")`);
  return n;
}

const PASSWORD = env.APP_PASSWORD || '';
const PORT = numberSetting('PORT', 8080, { min: 1, max: 65535 });
const HOST = env.HOST || (PASSWORD ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
const SYNC_INTERVAL_HOURS = numberSetting('SYNC_INTERVAL_HOURS', 6, { max: 24 * 30 });
const AUTO_SYNC_MIN_MINUTES = numberSetting('AUTO_SYNC_MIN_MINUTES', 120, { max: 24 * 60 * 30 });
const SESSION_DAYS = numberSetting('SESSION_DAYS', 30, { min: 1, max: 365 });
const PUBLIC_DIR = path.join(ROOT, 'public');
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (env.TLS_CERT && !env.TLS_KEY) configErrors.push('TLS_CERT is set but TLS_KEY is not');
if (!PASSWORD && !LOOPBACK) configErrors.push(`HOST=${HOST} opens the app to the network: set APP_PASSWORD too`);

// Your password and bank data must not cross the network unencrypted. On the
// network (HOST other than localhost) the server needs HTTPS: TLS_CERT/TLS_KEY
// here, or keep it on localhost behind an HTTPS proxy such as `tailscale serve`.
const TLS = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null;
if (!TLS && !LOOPBACK && env.ALLOW_INSECURE_HTTP !== '1') {
  configErrors.push(`HOST=${HOST} without HTTPS would send your password and bank data unencrypted over the network.\n`
    + '    Set TLS_CERT and TLS_KEY, or use HOST=127.0.0.1 behind an HTTPS proxy (e.g. `tailscale serve`).\n'
    + '    See "Use it from your phone" in README.md. (ALLOW_INSECURE_HTTP=1 overrides this — not recommended.)');
}
if (configErrors.length) {
  console.error(`\n  Can't start — fix .env:\n${configErrors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

const PUBLIC_URL = (env.PUBLIC_URL || `${TLS ? 'https' : 'http'}://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URL = env.EB_REDIRECT_URL || `${PUBLIC_URL}/bank/callback`;

const store = await new Store(path.join(DATA_DIR, 'budget.json')).load();
await runMigrations(store); // backs up first when a migration is needed

// One backup a day (data/backups), checked hourly so a server left running for
// weeks still makes them.
async function backupDaily() {
  try { await store.queue; await dailyBackup(store.file, { dir: store.backupDir }); } catch (err) { console.error('[backup] failed:', err.message); }
}
await backupDaily();
setInterval(backupDaily, 3600 * 1000).unref();

const bank = new EnableBanking({
  appId: env.EB_APP_ID,
  privateKeyPath: env.EB_PRIVATE_KEY_PATH && path.resolve(ROOT, env.EB_PRIVATE_KEY_PATH),
  apiBase: env.EB_API_URL || undefined,
});

// ---------- auth ----------
const sessions = new Sessions(path.join(DATA_DIR, '.sessions.json'), { days: SESSION_DAYS });
const logins = new LoginLimiter();

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function authorized(req, url) {
  if (!PASSWORD) return true;
  // EventSource can't send headers: live updates use a one-time ticket instead.
  if (url.pathname === '/api/events') return sessions.useTicket(url.searchParams.get('ticket'));
  return sessions.valid(bearer(req));
}

// Requests must come from this app, not from another website open in the same
// browser (CSRF), and the Host must be ours when there is no password (DNS rebinding).
const PUBLIC_HOST = new URL(PUBLIC_URL).host;
function checkOrigin(req) {
  const host = req.headers.host || '';
  if (!PASSWORD) {
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname) && host !== PUBLIC_HOST) throw new HttpError(403, 'Forbidden host');
  }
  if (['GET', 'HEAD'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = ''; }
    if (originHost !== host && originHost !== PUBLIC_HOST) throw new HttpError(403, 'Cross-site request blocked');
  } else if (origin === 'null') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
}

// ---------- helpers ----------
function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  // A plain HTML form or a text/plain fetch from another site can't send this type
  // without a CORS preflight, which this server never approves.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  return requireObject(body);
}

const APP_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function publicState(s) {
  return {
    ...s,
    appVersion: APP_VERSION,
    deletedBankRefs: undefined,
    deletedIds: undefined, // internal; the trash has its own endpoint
    trash: undefined,
    bank: {
      configured: bank.configured,
      redirectUrl: REDIRECT_URL,
      lastSync: s.bank.lastSync,
      lastError: s.bank.lastError,
      balanceHistory: lastSnapshots(s.bank.balanceHistory), // the two snapshots per account the "matches the bank" check needs
      syncing,
      connections: s.bank.connections.map((c) => ({
        sessionId: c.sessionId,
        bank: c.bank,
        validUntil: c.validUntil,
        accounts: c.accounts.map((a) => ({
          uid: a.uid, name: a.name, nickname: a.nickname, iban: a.iban, currency: a.currency, balance: a.balance, lastSyncDate: a.lastSyncDate,
          kind: a.kind, cashAccountType: a.cashAccountType, creditLimit: a.creditLimit, balanceMeaning: a.balanceMeaning, product: a.product, cardDigits: a.cardDigits,
        })),
      })),
    },
  };
}

// ---------- bank sync ----------
let syncing = false;
let syncAgain = false; // a forced sync was asked for while one was running
async function runSync({ force = false } = {}) {
  const s = store.get();
  if (syncing) {
    if (force) syncAgain = true;
    return { skipped: 'already running' };
  }
  if (!s.bank.connections.length) return { skipped: 'no bank linked' };
  const last = s.bank.lastSync ? Date.parse(s.bank.lastSync) : 0;
  const minGap = (force ? 10 : AUTO_SYNC_MIN_MINUTES) * 60 * 1000;
  if (Date.now() - last < minGap) return { skipped: 'synced recently', lastSync: s.bank.lastSync };
  syncing = true;
  try {
    const result = await syncBank(store, bank);
    console.log(`[sync] ${result.added} new transaction(s) from ${result.accounts} account(s)${result.errors.length ? `; ${result.errors.length} account(s) failed` : ''}`);
    return result;
  } catch (err) {
    console.error('[sync] failed:', err.message);
    // lastSync stays as it was, so the next scheduled run retries.
    await store.mutate((st) => { st.bank.lastError = err.message; });
    throw new HttpError(502, err.message);
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      runSync({ force: true }).catch(() => {});
    }
  }
}

async function completeBankLink(code, state) {
  const pending = store.get().bank.pendingAuth;
  if (!pending || !state || !safeEqual(state, pending.state)) throw new HttpError(400, 'Unknown or expired bank link request. Start again from Settings.');
  const session = await bank.createSession(code);
  const accounts = (session.accounts || []).map(accountFromSession).filter((a) => typeof a.uid === 'string' && a.uid);
  await store.mutate((s) => {
    const connection = {
      sessionId: session.session_id,
      bank: pending.bank,
      validUntil: session.access?.valid_until || pending.validUntil,
      accounts,
    };
    // A renewed consent gives the same accounts new uids: carry settings and
    // history over to them (unmatched old accounts stay, archived).
    const previous = s.bank.connections.filter((c) => c.bank === pending.bank);
    const { archived } = previous.length ? relinkAccounts(s, connection, previous) : { archived: null };
    s.bank.connections = [...s.bank.connections.filter((c) => c.bank !== pending.bank), connection, ...(archived ? [archived] : [])];
    s.bank.pendingAuth = null;
    s.bank.lastSync = null;
  });
  runSync({ force: true }).catch(() => {});
}

// ---------- live updates (server-sent events) ----------
const MAX_LIVE_CLIENTS = 50;
const clients = new Set();
store.onChange((s) => {
  for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ updatedAt: s.updatedAt })}\n\n`);
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- API routes ----------
async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"

  if (pathname === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    if (logins.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { password } = await readBody(req);
    if (PASSWORD && !safeEqual(password || '', PASSWORD)) {
      logins.fail(ip);
      throw new HttpError(401, 'Wrong password');
    }
    if (!PASSWORD) return send(res, 200, { token: '' });
    return send(res, 200, await sessions.create());
  }
  if (pathname === '/api/health') return send(res, 200, { ok: true, auth: Boolean(PASSWORD) });

  if (!authorized(req, url)) throw new HttpError(401, 'Login required');

  if (pathname === '/api/logout' && method === 'POST') {
    await sessions.revoke(bearer(req));
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/events/ticket' && method === 'POST') {
    return send(res, 200, { ticket: PASSWORD ? sessions.ticket() : '' });
  }

  if (pathname === '/api/events' && method === 'GET') {
    if (clients.size >= MAX_LIVE_CLIENTS) throw new HttpError(503, 'Too many live connections');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: change\ndata: ${JSON.stringify({ updatedAt: store.get().updatedAt })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }

  if (pathname === '/api/state' && method === 'GET') return send(res, 200, publicState(store.get()));

  // Transactions — PUT is an idempotent upsert so offline edits can be replayed safely.
  if (parts[0] === 'transactions') {
    const id = parts[1];
    if (id === 'import' && method === 'POST') {
      const { items = [], accountId } = await readBody(req);
      if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array');
      const result = await store.mutate((s) => {
        const own = ownContext(s);
        const batchId = uid();
        const occurrences = new Map();
        const account = accountId ? s.bank.connections.flatMap((c) => c.accounts).find((a) => a.uid === accountId) : null;
        if (accountId && !account) throw new HttpError(400, 'Unknown account');
        const now = new Date().toISOString();
        const rows = [];
        for (const raw of items.slice(0, 5000)) {
          let t;
          try { t = cleanTransaction(raw); } catch { continue; }
          if (account) { t.accountId = account.uid; t.accountChosen = true; }
          // Rows in another currency (csv.js): amount is NOT in RON yet; keep what the bank said.
          const fxAmount = round2(Number(raw.originalAmount));
          if (raw.needsFx === true && /^[A-Z]{3}$/.test(String(raw.originalCurrency)) && Number.isFinite(fxAmount) && fxAmount > 0) {
            Object.assign(t, { needsFx: true, originalCurrency: raw.originalCurrency, originalAmount: fxAmount });
          }
          // The note holds the bank's details (authorisation no., reference), so two genuine
          // identical-looking payments on the same day keep different fingerprints.
          const bare = `${t.date}|${t.type}|${t.amount}|${String(raw.description || '').toLowerCase()}|${String(raw.note || '').toLowerCase()}`;
          // Identical rows inside one statement are real (two equal transfers on the same day):
          // number them, so a re-import of the same file still matches row by row.
          const nth = (occurrences.get(bare) || 0) + 1;
          occurrences.set(bare, nth);
          t.importHash = `${t.accountId || ''}|${bare}${nth > 1 ? `#${nth}` : ''}`;
          rows.push({ raw, bare, t: { ...t, id: uid(), source: 'import', batchId, createdAt: now, updatedAt: now } });
        }
        // Seen = imported before into the account the row really belongs to (whatever was
        // picked in the import screen), or deleted by you after an earlier import.
        const seen = importSeen(s, rows.map((r) => r.t));
        let added = 0;
        for (const { raw, bare, t } of rows) {
          if (seen.has(t, bare)) continue;
          seen.add(t);
          if (!raw.category) {
            t.category = ownTransferCategory(t, own) || categorize({ description: `${t.description} ${t.note || ''}`, type: t.type }, s.rules, s.categories);
          }
          s.transactions.push(t);
          added += 1;
        }
        const merged = mergeDuplicatesToTrash(s); // already came in from the bank
        return { added: Math.max(0, added - merged), skipped: items.length - added + merged };
      });
      return send(res, 200, result);
    }
    // "Start over": remove every transaction that came from a CSV import.
    // A backup is taken first, and the rows stay in the trash.
    if (id === 'imported' && method === 'DELETE') {
      await store.backup('pre-delete-imported');
      const removed = await store.mutate((s) => removeTransactions(s, (t) => t.source === 'import', 'delete-imported').length);
      return send(res, 200, { removed });
    }
    // Offline edits are replayed later, so: a deleted transaction is never
    // re-created (409 deleted), and an edit made on an older copy that clashes
    // with a newer change from another device is refused (409 conflict).
    if (id && method === 'PUT') {
      const body = await readBody(req);
      try {
        const saved = await store.mutate((s) => {
          const idx = s.transactions.findIndex((t) => t.id === id);
          const now = new Date().toISOString();
          if (idx === -1) {
            if (s.deletedIds?.includes(id)) throw new HttpError(409, 'deleted');
            const t = { ...cleanTransaction(body), id, source: 'manual', createdAt: now, updatedAt: now };
            s.transactions.push(t);
            return t;
          }
          if (findConflicts(s.transactions[idx], body).length) throw new HttpError(409, 'conflict', { current: s.transactions[idx] });
          const t = { ...cleanTransaction(body, s.transactions[idx]), updatedAt: now };
          s.transactions[idx] = t;
          return t;
        });
        return send(res, 200, saved);
      } catch (err) {
        if (err.status === 409) return send(res, 409, { error: err.message, ...err.details });
        throw err;
      }
    }
    if (id && method === 'DELETE') {
      await store.mutate((s) => {
        // To the trash; a bank row is remembered so the next sync doesn't re-import it.
        // A deleted CSV row must not come back when the same statement is imported again.
        rememberDeletedImport(s, s.transactions.find((x) => x.id === id));
        if (!removeTransactions(s, (x) => x.id === id, 'delete').length) addTombstones(s, [id]);
      });
      return send(res, 200, { ok: true });
    }
  }

  // Trash: transactions removed by you or merged as duplicates, newest first.
  if (pathname === '/api/trash' && method === 'GET') {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    const trash = (store.get().trash || []).filter((e) => Date.parse(e.removedAt) >= cutoff).reverse();
    return send(res, 200, { trash });
  }
  if (parts[0] === 'trash' && parts[1] && parts[2] === 'restore' && method === 'POST') {
    const id = decodeURIComponent(parts[1]);
    const restored = await store.mutate((s) => {
      const t = restoreFromTrash(s, id);
      if (!t) throw new HttpError(404, 'Not in the trash (or already back)');
      return t;
    });
    return send(res, 200, restored);
  }

  if (parts[0] === 'goals' && parts[1]) {
    const id = parts[1];
    if (method === 'PUT') {
      const body = await readBody(req);
      const goal = await store.mutate((s) => {
        const idx = s.goals.findIndex((g) => g.id === id);
        const now = new Date().toISOString();
        if (idx === -1) {
          const g = { ...cleanGoal(body), id, createdAt: now, updatedAt: now };
          s.goals.push(g);
          return g;
        }
        s.goals[idx] = { ...cleanGoal(body, s.goals[idx]), updatedAt: now };
        return s.goals[idx];
      });
      return send(res, 200, goal);
    }
    if (method === 'DELETE') {
      await store.mutate((s) => {
        s.goals = s.goals.filter((g) => g.id !== id);
        // Contributions stay as Savings transactions but are no longer linked.
        for (const t of s.transactions) if (t.goalId === id) t.goalId = null;
      });
      return send(res, 200, { ok: true });
    }
  }

  // Learn a rule from an edit: "always put <merchant> in <category>".
  // Patterns are only ever built here (escaped) or taken from stored rules, never
  // straight from the request, so a request can't run an arbitrary regex.
  if (pathname === '/api/rules' && method === 'POST') {
    const { keyword: rawKeyword, description, category, apply = true, replace } = await readBody(req);
    const keyword = String(rawKeyword || merchantKey(description) || '').trim().toLowerCase().slice(0, 60);
    if (!keyword || !category) throw new HttpError(400, 'keyword and category are required');
    if (keyword.length < 3 || isUselessKeyword(keyword)) throw new HttpError(400, `“${keyword}” is too generic — use the shop's name, e.g. “carrefour”.`);
    const pattern = escapeForRule(keyword);
    const result = await store.mutate((s) => {
      const replaced = replace ? s.rules.find((r) => r.pattern === replace) : null;
      if (replaced) s.rules = s.rules.filter((r) => r !== replaced);
      s.rules = s.rules.filter((r) => r.pattern !== pattern);
      const rule = { pattern, keyword, category: String(category).slice(0, 40), createdAt: new Date().toISOString() };
      s.rules.unshift(rule);
      // Transactions the old rule had changed get re-evaluated too.
      let updated = replaced ? recategorize(s, (t) => ruleMatches(replaced, t)) : 0;
      if (apply) updated += recategorize(s, (t) => ruleMatches(rule, t));
      return { pattern, updated };
    });
    return send(res, 200, result);
  }
  if (parts[0] === 'rules' && parts[1] && method === 'DELETE') {
    const pattern = decodeURIComponent(parts[1]);
    const updated = await store.mutate((s) => {
      const rule = s.rules.find((r) => r.pattern === pattern);
      if (!rule) return 0;
      s.rules = s.rules.filter((r) => r !== rule);
      return recategorize(s, (t) => ruleMatches(rule, t)); // undo what the rule did
    });
    return send(res, 200, { ok: true, updated });
  }
  if (pathname === '/api/recategorize' && method === 'POST') {
    const updated = await store.mutate((s) => recategorize(s));
    return send(res, 200, { updated });
  }

  if (pathname === '/api/categories' && method === 'PUT') {
    const categories = cleanCategories((await readBody(req)).categories);
    await store.mutate((s) => { s.categories = categories; });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/budgets' && method === 'PUT') {
    const budgets = cleanBudgets((await readBody(req)).budgets);
    await store.mutate((s) => { s.budgets = budgets; });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const changes = cleanSettings(await readBody(req));
    await store.mutate((s) => { s.settings = { ...s.settings, ...changes }; });
    return send(res, 200, { ok: true });
  }

  // ----- bank -----
  if (pathname === '/api/bank/banks' && method === 'GET') {
    return send(res, 200, { banks: await bank.listBanks(url.searchParams.get('country') || 'RO') });
  }
  if (pathname === '/api/bank/link' && method === 'POST') {
    const { bank: bankName, country = 'RO', days } = await readBody(req);
    if (!bankName) throw new HttpError(400, 'Pick a bank');
    const state = randomBytes(16).toString('hex');
    const consentDays = Math.min(Number(days) || 90, 180);
    const auth = await bank.startAuth({ bank: String(bankName), country: String(country), redirectUrl: REDIRECT_URL, state, days: consentDays });
    await store.mutate((s) => {
      s.bank.pendingAuth = { state, bank: String(bankName), country: String(country), validUntil: new Date(Date.now() + consentDays * 86400000).toISOString() };
    });
    return send(res, 200, { url: auth.url });
  }
  // Fallback when the bank redirects somewhere this server can't receive:
  // paste the full URL you landed on (it contains ?code=...&state=...).
  if (pathname === '/api/bank/complete' && method === 'POST') {
    const { url: landed } = await readBody(req);
    let code; let state;
    try { const u = new URL(landed); code = u.searchParams.get('code'); state = u.searchParams.get('state'); } catch { throw new HttpError(400, 'That does not look like a URL'); }
    if (!code) throw new HttpError(400, 'No authorisation code found');
    await completeBankLink(code, state);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/bank/sync' && method === 'POST') {
    const { force = true } = await readBody(req);
    return send(res, 200, await runSync({ force: Boolean(force) }));
  }
  // Your own settings for a linked account: type, credit limit, how to read the balance.
  if (parts[0] === 'bank' && parts[1] === 'accounts' && parts[2] && method === 'PUT') {
    const accUid = decodeURIComponent(parts[2]);
    const body = await readBody(req);
    const updated = await store.mutate((s) => {
      const acc = s.bank.connections.flatMap((c) => c.accounts).find((a) => a.uid === accUid);
      if (!acc) throw new HttpError(404, 'Account not found');
      if (body.kind !== undefined) acc.kind = ['current', 'savings', 'credit'].includes(body.kind) ? body.kind : undefined;
      if (body.creditLimit !== undefined) acc.creditLimit = Number(body.creditLimit) > 0 ? round2(Number(body.creditLimit)) : undefined;
      if (body.balanceMeaning !== undefined) acc.balanceMeaning = ['available', 'owed'].includes(body.balanceMeaning) ? body.balanceMeaning : undefined;
      if (body.nickname !== undefined) acc.nickname = String(body.nickname).trim().slice(0, 40) || undefined;
      if (Array.isArray(body.cardDigits)) acc.cardDigits = body.cardDigits.map(String).filter((d) => /^\d{4}$/.test(d)).slice(0, 6);
      return acc;
    });
    return send(res, 200, { ok: true, uid: updated.uid });
  }
  if (parts[0] === 'bank' && parts[1] === 'connections' && parts[2] && method === 'DELETE') {
    const sessionId = decodeURIComponent(parts[2]);
    try { await bank.deleteSession(sessionId); } catch { /* already gone at the bank */ }
    await store.mutate((s) => { s.bank.connections = s.bank.connections.filter((c) => c.sessionId !== sessionId); });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // Inline style attributes are used by the views; scripts only from this server.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  let data;
  let target = file;
  try {
    data = await fs.readFile(target);
  } catch {
    if (path.extname(rel)) throw new HttpError(404, 'Not found');
    target = path.join(PUBLIC_DIR, 'index.html');
    data = await fs.readFile(target);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(data);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  try {
    checkOrigin(req);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/bank/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err || !code) {
        res.writeHead(302, { Location: `/#settings?bank=error&reason=${encodeURIComponent(url.searchParams.get('error_description') || err || 'cancelled')}` });
        return res.end();
      }
      await completeBankLink(code, url.searchParams.get('state'));
      res.writeHead(302, { Location: '/#settings?bank=linked' });
      return res.end();
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500 && status !== 502) console.error(err);
    // Unexpected errors stay in the server log; the client gets a generic message.
    const message = status === 500 ? 'Server error' : err.message;
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  }
  return undefined;
}

// windows/restart-server.bat stops exactly this process, not every Node app.
const PID_FILE = path.join(DATA_DIR, 'server.pid');

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => {
  fs.writeFile(PID_FILE, String(process.pid)).catch(() => {});
  const proto = TLS ? 'https' : 'http';
  console.log(`\n  Budget planner running on ${proto}://localhost:${PORT}`);
  if (!LOOPBACK) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  On your Wi-Fi:  ${proto}://${a.address}:${PORT}`);
    }
    if (!TLS) console.warn('  WARNING: ALLOW_INSECURE_HTTP=1 — your password and data travel unencrypted on the network.');
  } else {
    console.log('  Only reachable from this computer. To use it from your phone, see "Use it from your phone" in README.md.');
  }
  const schedule = SYNC_INTERVAL_HOURS > 0 ? `every ${SYNC_INTERVAL_HOURS}h` : 'only when you press Sync';
  console.log(`  Bank sync: ${bank.configured ? `enabled (${schedule})` : 'not configured — see README'}\n`);
});

if (SYNC_INTERVAL_HOURS > 0) {
  setInterval(() => runSync().catch(() => {}), SYNC_INTERVAL_HOURS * 3600 * 1000).unref();
  setTimeout(() => runSync().catch(() => {}), 10_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => fs.rm(PID_FILE, { force: true }).finally(() => process.exit(0))));
}
