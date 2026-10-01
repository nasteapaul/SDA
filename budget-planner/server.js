// Budget planner server: serves the app (phone + laptop), stores data in one
// JSON file and syncs your bank account through Enable Banking (PSD2).
// Zero dependencies — just `node server.js`.

import http from 'node:http';
import https from 'node:https';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

import { Store } from './lib/store.js';
import { EnableBanking } from './lib/enablebanking.js';
import { syncBank, accountInfo, recategorize, assignImportAccounts } from './lib/sync.js';
import { mergeDuplicates } from './public/js/shared/dedupe.js';
import { ownContext, ownTransferCategory } from './public/js/shared/own.js';
import { categorize, escapeForRule, merchantKey, extractMerchant, isUselessKeyword, ruleMatches } from './public/js/shared/categories.js';
import { round2, uid } from './public/js/shared/money.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }

const env = process.env;
const PASSWORD = env.APP_PASSWORD || '';
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || (PASSWORD ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
const SYNC_INTERVAL_HOURS = Number(env.SYNC_INTERVAL_HOURS || 6);
const AUTO_SYNC_MIN_MINUTES = Number(env.AUTO_SYNC_MIN_MINUTES || 120);
const PUBLIC_DIR = path.join(ROOT, 'public');
const TLS = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null;
const PUBLIC_URL = (env.PUBLIC_URL || `${TLS ? 'https' : 'http'}://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URL = env.EB_REDIRECT_URL || `${PUBLIC_URL}/bank/callback`;

const store = await new Store(path.join(DATA_DIR, 'budget.json')).load();
// Earlier versions could learn rules from bank boilerplate (e.g. "number transaction"),
// which matched almost every card payment. Drop them and redo the categories.
if (store.get().rules.some((r) => isUselessKeyword(r.keyword || r.pattern))) {
  await store.mutate((s) => {
    const before = s.rules.length;
    s.rules = s.rules.filter((r) => !isUselessKeyword(r.keyword || r.pattern));
    // Cleaner descriptions for card payments: "CARREFOUR EXPRESS" instead of "Card number, **** …".
    for (const t of s.transactions) {
      if (t.source === 'bank' && /^(card number|cumparare pos)/i.test(t.description)) {
        if (!t.note) t.note = t.description;
        t.description = extractMerchant(t.description) || t.description;
      }
    }
    const changed = recategorize(s);
    console.log(`  Removed ${before - s.rules.length} rule(s) that matched too much; re-categorised ${changed} transaction(s)`);
  });
}

// v3: recognise transfers between your own accounts (card repayments, Revolut,
// cash deposits) and use the cleaner merchant names. Runs once.
if (!store.get().settings?.ownTransfersFixed) {
  await store.mutate((s) => {
    for (const t of s.transactions) {
      if (t.source === 'bank' && /^ordering party|^beneficiary/i.test(t.description)) {
        if (!t.note) t.note = t.description;
        t.description = extractMerchant(t.description) || t.description;
      }
    }
    const changed = recategorize(s);
    s.settings = { ...s.settings, ownTransfersFixed: true };
    if (changed) console.log(`  Re-categorised ${changed} transaction(s) (transfers between your own accounts are no longer income/spending)`);
  });
}

// v4: after removing statements imported twice, redo automatic categories once.
if (!store.get().settings?.importsDeduped) {
  await store.mutate((s) => {
    const merged = mergeDuplicates(s);
    const changed = recategorize(s);
    s.settings = { ...s.settings, importsDeduped: true };
    if (merged || changed) console.log(`  Removed ${merged} duplicate(s) from repeated imports; re-categorised ${changed} transaction(s)`);
  });
}

// v5: imported transactions get the account they belong to (card vs current), then
// money between own accounts is re-categorised (current → card = card repayment).
if (!store.get().settings?.importAccountsAssigned) {
  await store.mutate((s) => {
    const assigned = assignImportAccounts(s);
    const changed = recategorize(s);
    s.settings = { ...s.settings, importAccountsAssigned: true, countMode: s.settings?.countMode || 'cashflow' };
    if (assigned || changed) console.log(`  Linked ${assigned} imported transaction(s) to their account; re-categorised ${changed}`);
  });
}

// Clean up duplicates left by earlier versions (CSV import + bank sync of the same purchase).
const existingDuplicates = mergeDuplicates(structuredClone({ transactions: store.get().transactions }));
if (existingDuplicates) {
  await store.mutate((s) => mergeDuplicates(s));
  console.log(`  Merged ${existingDuplicates} duplicate transaction(s)`);
}

const bank = new EnableBanking({
  appId: env.EB_APP_ID,
  privateKeyPath: env.EB_PRIVATE_KEY_PATH && path.resolve(ROOT, env.EB_PRIVATE_KEY_PATH),
  apiBase: env.EB_API_URL || undefined,
});

// ---------- auth ----------
const secretFile = path.join(DATA_DIR, '.secret');
if (!existsSync(secretFile)) await fs.writeFile(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = readFileSync(secretFile, 'utf8').trim();
const TOKEN = createHmac('sha256', SECRET).update(`token:${PASSWORD}`).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorized(req, url) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  return token ? safeEqual(token, TOKEN) : false;
}

const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  loginAttempts.set(ip, list);
  return list.length >= 10;
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanTransaction(input, existing = {}) {
  const t = { ...existing };
  if (input.type !== undefined) {
    if (!['income', 'expense'].includes(input.type)) throw new HttpError(400, 'type must be income or expense');
    t.type = input.type;
  }
  if (input.amount !== undefined) {
    const amount = round2(Math.abs(Number(input.amount)));
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');
    t.amount = amount;
  }
  if (input.date !== undefined) {
    if (!DATE_RE.test(input.date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    t.date = input.date;
  }
  for (const key of ['category', 'description', 'note']) {
    if (input[key] !== undefined) t[key] = String(input[key]).slice(0, key === 'note' ? 280 : 140);
  }
  if (input.goalId !== undefined) t.goalId = input.goalId || null;
  if (input.manualCategory !== undefined) t.manualCategory = Boolean(input.manualCategory);
  if (input.accountId !== undefined && existing.source !== 'bank') t.accountId = input.accountId || null;
  if (!t.type || !t.amount || !t.date) throw new HttpError(400, 'type, amount and date are required');
  t.category ||= t.type === 'income' ? 'Other income' : 'Other';
  t.description ||= t.category;
  return t;
}

function cleanGoal(input, existing = {}) {
  const g = { ...existing };
  if (input.name !== undefined) g.name = String(input.name).trim().slice(0, 80);
  if (input.target !== undefined) g.target = round2(Number(input.target));
  if (input.initialSaved !== undefined) g.initialSaved = round2(Number(input.initialSaved) || 0);
  if (input.deadline !== undefined) {
    if (input.deadline && !DATE_RE.test(input.deadline)) throw new HttpError(400, 'deadline must be YYYY-MM-DD');
    g.deadline = input.deadline || null;
  }
  if (input.priority !== undefined) g.priority = ['high', 'medium', 'low'].includes(input.priority) ? input.priority : 'medium';
  if (input.icon !== undefined) g.icon = String(input.icon).slice(0, 8);
  if (input.archived !== undefined) g.archived = Boolean(input.archived);
  if (!g.name || !(g.target > 0)) throw new HttpError(400, 'A goal needs a name and a positive target');
  g.priority ||= 'medium';
  g.initialSaved ||= 0;
  return g;
}

function publicState(s) {
  return {
    ...s,
    deletedBankRefs: undefined,
    bank: {
      configured: bank.configured,
      redirectUrl: REDIRECT_URL,
      lastSync: s.bank.lastSync,
      lastError: s.bank.lastError,
      syncing,
      connections: s.bank.connections.map((c) => ({
        sessionId: c.sessionId,
        bank: c.bank,
        validUntil: c.validUntil,
        accounts: c.accounts.map((a) => ({
          uid: a.uid, name: a.name, nickname: a.nickname, iban: a.iban, currency: a.currency, balance: a.balance, lastSyncDate: a.lastSyncDate,
          kind: a.kind, cashAccountType: a.cashAccountType, creditLimit: a.creditLimit, balanceMeaning: a.balanceMeaning, product: a.product,
        })),
      })),
    },
  };
}

// ---------- bank sync ----------
let syncing = false;
async function runSync({ force = false } = {}) {
  const s = store.get();
  if (syncing) return { skipped: 'already running' };
  if (!s.bank.connections.length) return { skipped: 'no bank linked' };
  const last = s.bank.lastSync ? Date.parse(s.bank.lastSync) : 0;
  const minGap = (force ? 10 : AUTO_SYNC_MIN_MINUTES) * 60 * 1000;
  if (Date.now() - last < minGap) return { skipped: 'synced recently', lastSync: s.bank.lastSync };
  syncing = true;
  try {
    const result = await syncBank(store, bank);
    console.log(`[sync] ${result.added} new transaction(s) from ${result.accounts} account(s)`);
    return result;
  } catch (err) {
    console.error('[sync] failed:', err.message);
    await store.mutate((st) => { st.bank.lastError = err.message; st.bank.lastSync = new Date().toISOString(); });
    throw new HttpError(502, err.message);
  } finally {
    syncing = false;
  }
}

async function completeBankLink(code, state) {
  const pending = store.get().bank.pendingAuth;
  if (!pending || (state && !safeEqual(state, pending.state))) throw new HttpError(400, 'Unknown or expired bank link request. Start again from Settings.');
  const session = await bank.createSession(code);
  const accounts = (session.accounts || []).map((a) => (typeof a === 'string' ? { uid: a } : a));
  await store.mutate((s) => {
    s.bank.connections = s.bank.connections.filter((c) => c.bank !== pending.bank);
    s.bank.connections.push({
      sessionId: session.session_id,
      bank: pending.bank,
      validUntil: session.access?.valid_until || pending.validUntil,
      accounts: accounts.map((a) => ({
        uid: a.uid,
        name: a.name || a.product || a.details || 'Account',
        iban: a.account_id?.iban || null,
        currency: a.currency || 'RON',
        ...accountInfo(a),
        detailsFetched: Boolean(a.cash_account_type),
        balance: null,
        lastSyncDate: null,
      })),
    });
    s.bank.pendingAuth = null;
    s.bank.lastSync = null;
  });
  runSync({ force: true }).catch(() => {});
}

// ---------- live updates (server-sent events) ----------
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
    if (tooManyAttempts(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { password } = await readBody(req);
    if (PASSWORD && !safeEqual(password || '', PASSWORD)) {
      loginAttempts.get(ip).push(Date.now());
      throw new HttpError(401, 'Wrong password');
    }
    return send(res, 200, { token: TOKEN });
  }
  if (pathname === '/api/health') return send(res, 200, { ok: true, auth: Boolean(PASSWORD) });

  if (!authorized(req, url)) throw new HttpError(401, 'Login required');

  if (pathname === '/api/events' && method === 'GET') {
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
      const result = await store.mutate((s) => {
        const seen = new Set(s.transactions.map((t) => t.importHash).filter(Boolean));
        const own = ownContext(s);
        const batchId = uid();
        const occurrences = new Map();
        const account = accountId ? s.bank.connections.flatMap((c) => c.accounts).find((a) => a.uid === accountId) : null;
        if (accountId && !account) throw new HttpError(400, 'Unknown account');
        let added = 0;
        for (const raw of items.slice(0, 5000)) {
          let t;
          try { t = cleanTransaction(raw); } catch { continue; }
          if (account) t.accountId = account.uid;
          // The note holds the bank's details (authorisation no., reference), so two genuine
          // identical-looking payments on the same day keep different fingerprints.
          const bare = `${t.date}|${t.type}|${t.amount}|${(raw.description || '').toLowerCase()}|${(raw.note || '').toLowerCase()}`;
          // Identical rows inside one statement are real (two equal transfers on the same day):
          // number them, so a re-import of the same file still matches row by row.
          const nth = (occurrences.get(bare) || 0) + 1;
          occurrences.set(bare, nth);
          t.importHash = `${t.accountId || ''}|${bare}${nth > 1 ? `#${nth}` : ''}`;
          if (seen.has(t.importHash) || seen.has(bare)) continue; // `bare`: imported by the previous version
          seen.add(t.importHash);
          if (!raw.category) {
            t.category = ownTransferCategory(t, own) || categorize({ description: `${t.description} ${t.note || ''}`, type: t.type }, s.rules, s.categories);
          }
          const now = new Date().toISOString();
          s.transactions.push({ ...t, id: uid(), source: 'import', batchId, createdAt: now, updatedAt: now });
          added += 1;
        }
        const merged = mergeDuplicates(s); // already came in from the bank
        return { added: added - merged, skipped: items.length - added + merged };
      });
      return send(res, 200, result);
    }
    // "Start over": remove every transaction that came from a CSV import.
    if (id === 'imported' && method === 'DELETE') {
      const removed = await store.mutate((s) => {
        const before = s.transactions.length;
        s.transactions = s.transactions.filter((t) => t.source !== 'import');
        return before - s.transactions.length;
      });
      return send(res, 200, { removed });
    }
    if (id && method === 'PUT') {
      const body = await readBody(req);
      const saved = await store.mutate((s) => {
        const idx = s.transactions.findIndex((t) => t.id === id);
        const now = new Date().toISOString();
        if (idx === -1) {
          const t = { ...cleanTransaction(body), id, source: 'manual', createdAt: now, updatedAt: now };
          s.transactions.push(t);
          return t;
        }
        const t = { ...cleanTransaction(body, s.transactions[idx]), updatedAt: now };
        s.transactions[idx] = t;
        return t;
      });
      return send(res, 200, saved);
    }
    if (id && method === 'DELETE') {
      await store.mutate((s) => {
        const t = s.transactions.find((x) => x.id === id);
        if (t?.bankRef) s.deletedBankRefs.push(t.bankRef); // don't re-import on next sync
        s.transactions = s.transactions.filter((x) => x.id !== id);
      });
      return send(res, 200, { ok: true });
    }
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
  if (pathname === '/api/rules' && method === 'POST') {
    const { keyword: rawKeyword, description, category, apply = true, replace } = await readBody(req);
    const keyword = String(rawKeyword || merchantKey(description) || '').trim().toLowerCase().slice(0, 60);
    if (!keyword || !category) throw new HttpError(400, 'keyword and category are required');
    if (keyword.length < 3 || isUselessKeyword(keyword)) throw new HttpError(400, `“${keyword}” is too generic — use the shop's name, e.g. “carrefour”.`);
    const pattern = escapeForRule(keyword);
    const result = await store.mutate((s) => {
      if (replace) s.rules = s.rules.filter((r) => r.pattern !== replace);
      s.rules = s.rules.filter((r) => r.pattern !== pattern);
      const rule = { pattern, keyword, category, createdAt: new Date().toISOString() };
      s.rules.unshift(rule);
      // Transactions the old rule had changed get re-evaluated too.
      let updated = replace ? recategorize(s, (t) => ruleMatches({ pattern: replace }, t)) : 0;
      if (apply) updated += recategorize(s, (t) => ruleMatches(rule, t));
      return { pattern, updated };
    });
    return send(res, 200, result);
  }
  if (parts[0] === 'rules' && parts[1] && method === 'DELETE') {
    const pattern = decodeURIComponent(parts[1]);
    const updated = await store.mutate((s) => {
      s.rules = s.rules.filter((r) => r.pattern !== pattern);
      return recategorize(s, (t) => ruleMatches({ pattern }, t)); // undo what the rule did
    });
    return send(res, 200, { ok: true, updated });
  }
  if (pathname === '/api/recategorize' && method === 'POST') {
    const updated = await store.mutate((s) => recategorize(s));
    return send(res, 200, { updated });
  }

  if (pathname === '/api/categories' && method === 'PUT') {
    const { categories } = await readBody(req);
    if (!Array.isArray(categories)) throw new HttpError(400, 'categories must be an array');
    await store.mutate((s) => {
      s.categories = categories
        .filter((c) => c?.name)
        .map((c) => ({
          name: String(c.name).slice(0, 40),
          kind: ['income', 'expense', 'both'].includes(c.kind) ? c.kind : 'expense',
          icon: String(c.icon || '•').slice(0, 8),
          essential: Boolean(c.essential),
          ...(c.role ? { role: c.role } : {}),
        }));
    });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/budgets' && method === 'PUT') {
    const { budgets } = await readBody(req);
    await store.mutate((s) => {
      s.budgets = Object.fromEntries(Object.entries(budgets || {})
        .map(([k, v]) => [k, round2(Number(v))])
        .filter(([, v]) => v > 0));
    });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    await store.mutate((s) => { s.settings = { ...s.settings, ...body }; });
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
    const auth = await bank.startAuth({ bank: bankName, country, redirectUrl: REDIRECT_URL, state, days: consentDays });
    await store.mutate((s) => {
      s.bank.pendingAuth = { state, bank: bankName, country, validUntil: new Date(Date.now() + consentDays * 86400000).toISOString() };
    });
    return send(res, 200, { url: auth.url });
  }
  // Fallback when the bank redirects somewhere this server can't receive:
  // paste the full URL you landed on (it contains ?code=...).
  if (pathname === '/api/bank/complete' && method === 'POST') {
    const { url: landed, code } = await readBody(req);
    let c = code; let st = null;
    if (landed) {
      try { const u = new URL(landed); c = u.searchParams.get('code'); st = u.searchParams.get('state'); } catch { throw new HttpError(400, 'That does not look like a URL'); }
    }
    if (!c) throw new HttpError(400, 'No authorisation code found');
    await completeBankLink(c, st);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/bank/sync' && method === 'POST') {
    const { force = true } = await readBody(req);
    return send(res, 200, await runSync({ force }));
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
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  try {
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
    if (!res.headersSent) send(res, status, { error: err.message || 'Server error' });
    else res.end();
  }
  return undefined;
}

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => {
  const proto = TLS ? 'https' : 'http';
  console.log(`\n  Budget planner running on ${proto}://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  On your Wi-Fi:  ${proto}://${a.address}:${PORT}`);
    }
  } else {
    console.log('  Only reachable from this computer. Set APP_PASSWORD in .env to open it to your phone on the home Wi-Fi.');
  }
  console.log(`  Bank sync: ${bank.configured ? `enabled (every ${SYNC_INTERVAL_HOURS}h)` : 'not configured — see README'}\n`);
});

if (SYNC_INTERVAL_HOURS > 0) {
  setInterval(() => runSync().catch(() => {}), SYNC_INTERVAL_HOURS * 3600 * 1000).unref();
  setTimeout(() => runSync().catch(() => {}), 10_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
