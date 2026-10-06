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
  if (!t.type || !t.amount || !t.date) throw new HttpError(400, 'type, amount and date are required');
  t.category ||= t.type === 'income' ? 'Other income' : 'Other';
  t.description ||= t.category;
  return t;
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
  return out;
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
