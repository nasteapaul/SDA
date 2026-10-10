// Input validation for everything the API accepts. Anything that doesn't fit
// is rejected with a 400 instead of being stored as-is.

import { round2, parseAmount } from '../public/js/shared/money.js';
import { INTENSITY } from '../public/js/shared/planner.js';
import { COUNT_MODES } from '../public/js/shared/ledger.js';

export class HttpError extends Error {
  // details: extra fields for the JSON error body (e.g. { current } on a 409).
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}

// Largest amount accepted anywhere (RON). Guards against typos and overflow.
export const MAX_AMOUNT = 1e9;

/** Request bodies must be plain JSON objects; anything else is a 400. */
export function requireObject(value, name = 'request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} must be a JSON object`);
  return value;
}

// A money amount: finite and at most MAX_AMOUNT. Sign checks are the caller's.
function money(value, name) {
  const n = round2(toNumber(value));
  if (!Number.isFinite(n) || Math.abs(n) > MAX_AMOUNT) throw new HttpError(400, `${name} must be a number up to ${MAX_AMOUNT.toLocaleString('en')}`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const ROLES = ['repayment', 'savings', 'transfer'];

// A real calendar date in YYYY-MM-DD (not 2026-02-31).
export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const toNumber = (v) => (typeof v === 'string' ? parseAmount(v) : Number(v));

function optionalId(value, name, max = 200) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${name} must be a string`);
  return value;
}

export function cleanTransaction(input, existing = {}) {
  requireObject(input, 'transaction');
  const t = { ...existing };
  if (input.type !== undefined) {
    if (!['income', 'expense'].includes(input.type)) throw new HttpError(400, 'type must be income or expense');
    t.type = input.type;
  }
  if (input.amount !== undefined) {
    const amount = round2(Math.abs(toNumber(input.amount)));
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');
    t.amount = money(amount, 'amount');
  }
  if (input.date !== undefined) {
    if (!isDate(input.date)) throw new HttpError(400, 'date must be a valid YYYY-MM-DD date');
    t.date = input.date;
  }
  for (const key of ['category', 'description', 'note']) {
    if (input[key] !== undefined) t[key] = String(input[key]).slice(0, key === 'note' ? 280 : 140);
  }
  if (input.goalId !== undefined) t.goalId = optionalId(input.goalId, 'goalId', 64);
  if (input.manualCategory !== undefined) t.manualCategory = Boolean(input.manualCategory);
  if (input.accountId !== undefined && existing.source !== 'bank') t.accountId = optionalId(input.accountId, 'accountId');
  if (input.accountManual !== undefined) t.accountManual = Boolean(input.accountManual);
  if (input.reviewed !== undefined) t.reviewed = Boolean(input.reviewed);
  if (input.refundDue !== undefined) {
    const due = input.refundDue === '' ? null : input.refundDue;
    if (due !== null && !isDate(due)) throw new HttpError(400, 'refundDue must be a valid YYYY-MM-DD date');
    t.refundDue = due;
  }
  if (input.pocket !== undefined) {
    const pocket = input.pocket === '' ? null : input.pocket;
    if (pocket !== null && pocket !== 'vouchers') throw new HttpError(400, 'pocket must be "vouchers" or null');
    // Meal-voucher spending is entered by hand; a bank row is always real account money.
    if (pocket && existing.source === 'bank') throw new HttpError(400, 'Bank transactions can\'t be moved to the meal-voucher pocket');
    t.pocket = pocket;
  }
  if (input.splits !== undefined) t.splits = input.splits === null ? null : cleanSplits(input.splits);
  if (!t.type || !t.amount || !t.date) throw new HttpError(400, 'type, amount and date are required');
  if (t.splits) {
    const sum = round2(t.splits.reduce((x, p) => x + p.amount, 0));
    const fits = t.type === 'expense' && Math.abs(sum - t.amount) <= 0.01 + 1e-9;
    if (!fits && input.splits !== undefined) {
      throw new HttpError(400, t.type !== 'expense' ? 'Only expenses can be split' : `The split parts add up to ${sum}, not ${t.amount}`);
    }
    if (!fits) t.splits = null; // amount or type changed since: the old split no longer adds up
  }
  t.category ||= t.type === 'income' ? 'Other income' : 'Other';
  t.description ||= t.category;
  return t;
}

// An expense split across categories: 2..10 parts, each a category and a positive amount.
function cleanSplits(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) throw new HttpError(400, 'splits must be a list of 2 to 10 parts');
  return value.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, `split part ${i + 1} must be an object`);
    const category = typeof p.category === 'string' ? p.category.trim() : '';
    if (!category || category.length > 40) throw new HttpError(400, `split part ${i + 1} needs a category (up to 40 characters)`);
    const amount = money(p.amount, `split part ${i + 1} amount`);
    if (!(amount > 0)) throw new HttpError(400, `split part ${i + 1} amount must be positive`);
    return { category, amount };
  });
}

export function cleanGoal(input, existing = {}) {
  requireObject(input, 'goal');
  const g = { ...existing };
  if (input.name !== undefined) g.name = String(input.name).trim().slice(0, 80);
  if (input.target !== undefined) g.target = money(input.target, 'target');
  if (input.initialSaved !== undefined) {
    const blank = input.initialSaved === null || input.initialSaved === '';
    g.initialSaved = blank ? 0 : money(input.initialSaved, 'initialSaved');
    if (g.initialSaved < 0) throw new HttpError(400, 'initialSaved can\'t be negative');
  }
  if (input.deadline !== undefined) {
    if (input.deadline && !isDate(input.deadline)) throw new HttpError(400, 'deadline must be a valid YYYY-MM-DD date');
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

/**
 * Only the settings the app itself changes are accepted; internal flags
 * (which migrations already ran) can't be set from outside.
 */
export function cleanSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'settings must be an object');
  const out = {};
  if (input.planIntensity !== undefined) {
    if (!Object.hasOwn(INTENSITY, input.planIntensity)) throw new HttpError(400, 'Unknown plan intensity');
    out.planIntensity = input.planIntensity;
  }
  if (input.countMode !== undefined) {
    if (!Object.hasOwn(COUNT_MODES, input.countMode)) throw new HttpError(400, 'Unknown count mode');
    out.countMode = input.countMode;
  }
  if (input.payday !== undefined) {
    const day = input.payday === null ? null : Number(input.payday);
    if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 28)) throw new HttpError(400, 'payday must be a day between 1 and 28');
    out.payday = day;
  }
  if (input.paydays !== undefined) {
    if (!input.paydays || typeof input.paydays !== 'object' || Array.isArray(input.paydays)) throw new HttpError(400, 'paydays must be an object');
    const entries = Object.entries(input.paydays);
    if (entries.length > 240) throw new HttpError(400, 'Too many salary dates');
    for (const [month, date] of entries) {
      if (!MONTH_RE.test(month) || (date !== '' && date !== null && !isDate(date))) throw new HttpError(400, 'Salary dates must be YYYY-MM-DD');
    }
    out.paydays = Object.fromEntries(entries);
  }
  if (input.mainAccountId !== undefined) {
    // The current account that counts as "your money" (ledger.js mainAccountOf); '' / null = automatic.
    const id = input.mainAccountId;
    if (id !== null && typeof id !== 'string') throw new HttpError(400, 'mainAccountId must be a string');
    if (id && (id.length > 64 || /[\u0000-\u001f]/.test(id))) throw new HttpError(400, 'mainAccountId is too long or invalid');
    out.mainAccountId = id || null;
  }
  if (input.recurring !== undefined) {
    // { seriesKey: 'confirmed' | 'ignored' } — the client always sends the whole map.
    const map = requireObject(input.recurring, 'recurring');
    const entries = Object.entries(map);
    if (entries.length > 500) throw new HttpError(400, 'Too many recurring payments');
    for (const [key, value] of entries) {
      if (!key || key.length > 80 || CONTROL_RE.test(key)) throw new HttpError(400, 'Invalid recurring payment key');
      if (!RECURRING_STATUS.includes(value)) throw new HttpError(400, 'A recurring payment is confirmed or ignored');
    }
    out.recurring = Object.fromEntries(entries);
  }
  if (input.mealVouchers !== undefined) {
    const mv = requireObject(input.mealVouchers, 'mealVouchers');
    if (typeof mv.enabled !== 'boolean') throw new HttpError(400, 'mealVouchers.enabled must be true or false');
    const perDay = mv.perDay === undefined || mv.perDay === null || mv.perDay === '' ? 0 : round2(toNumber(mv.perDay));
    if (!Number.isFinite(perDay) || perDay < 0 || perDay > 1000) throw new HttpError(400, 'mealVouchers.perDay must be between 0 and 1000');
    out.mealVouchers = { enabled: mv.enabled, perDay };
  }
  if (input.spendBuffer !== undefined) {
    const buffer = input.spendBuffer === null || input.spendBuffer === '' ? 0 : money(input.spendBuffer, 'spendBuffer');
    if (buffer < 0) throw new HttpError(400, 'spendBuffer can\'t be negative');
    out.spendBuffer = buffer;
  }
  if (input.alerts !== undefined) {
    // Unknown kinds (e.g. from a newer or older client) are dropped; a missing kind means on.
    const alerts = requireObject(input.alerts, 'alerts');
    out.alerts = {};
    for (const kind of ALERT_KINDS) {
      if (alerts[kind] === undefined) continue;
      if (typeof alerts[kind] !== 'boolean') throw new HttpError(400, `alerts.${kind} must be true or false`);
      out.alerts[kind] = alerts[kind];
    }
  }
  return out;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const RECURRING_STATUS = ['confirmed', 'ignored'];
export const ALERT_KINDS = ['consent', 'sync', 'bill', 'price', 'renewal', 'refund', 'card', 'low', 'summary', 'assets'];
export const ASSET_KINDS = ['pension', 'investment', 'cash', 'property', 'loan', 'other'];

/**
 * A manual asset or debt for the net worth: { name, kind, amount }. For a
 * 'loan' the amount is what you still owe. The server sets id and updatedAt.
 */
export function cleanAsset(input, existing = {}) {
  requireObject(input, 'asset');
  const name = String(input.name ?? existing.name ?? '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'An asset needs a name');
  const kind = input.kind !== undefined ? input.kind : existing.kind;
  const rawAmount = input.amount !== undefined ? input.amount : existing.amount;
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') throw new HttpError(400, 'An asset needs an amount');
  const amount = money(rawAmount, 'amount');
  if (amount < 0) throw new HttpError(400, 'amount can\'t be negative (enter a debt as kind "loan")');
  return { name, kind: ASSET_KINDS.includes(kind) ? kind : 'other', amount };
}

export function cleanCategories(categories) {
  if (!Array.isArray(categories)) throw new HttpError(400, 'categories must be an array');
  return categories
    .filter((c) => c?.name)
    .slice(0, 200)
    .map((c) => ({
      name: String(c.name).slice(0, 40),
      kind: ['income', 'expense', 'both'].includes(c.kind) ? c.kind : 'expense',
      icon: String(c.icon || '•').slice(0, 8),
      essential: Boolean(c.essential),
      ...(ROLES.includes(c.role) ? { role: c.role } : {}),
    }));
}

/**
 * Monthly budgets: { category: limit }. A limit of 0 (or empty) removes the
 * budget; anything that isn't a number, or is above MAX_AMOUNT, is a 400.
 */
export function cleanBudgets(budgets) {
  if (budgets === undefined || budgets === null) return {};
  requireObject(budgets, 'budgets');
  const out = {};
  for (const [k, v] of Object.entries(budgets).slice(0, 200)) {
    const limit = v === null || v === '' ? 0 : money(v, `budget for ${String(k).slice(0, 40)}`);
    if (limit > 0) out[String(k).slice(0, 40)] = limit;
  }
  return out;
}

// ---------- offline edits: optimistic concurrency ----------

const META = new Set(['id', 'base', 'baseUpdatedAt', 'createdAt', 'updatedAt', 'source']);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  || ((a ?? '') === '' && (b ?? '') === '');

/**
 * Fields of a transaction edit that clash with a newer change on the server.
 * `body.baseUpdatedAt` is the version the client last saw; `body.base` holds
 * the values it saw for the fields it changed. A field conflicts when the
 * stored row changed after that version, the server's value is no longer the
 * one the client saw, and the client wants something else. Without `base`
 * every field that differs from the stored value counts. No baseUpdatedAt
 * (older clients) or a row that hasn't changed since: no conflicts.
 */
export function findConflicts(stored, body) {
  if (!stored || !body?.baseUpdatedAt) return [];
  const seen = Date.parse(body.baseUpdatedAt);
  const current = Date.parse(stored.updatedAt || stored.createdAt || '');
  if (!Number.isFinite(seen) || !Number.isFinite(current) || current <= seen) return [];
  const base = body.base && typeof body.base === 'object' && !Array.isArray(body.base) ? body.base : null;
  const out = [];
  for (const key of Object.keys(body)) {
    if (META.has(key) || same(body[key], stored[key])) continue;
    if (base && same(base[key], stored[key])) continue; // only this client changed it
    out.push(key);
  }
  return out;
}
