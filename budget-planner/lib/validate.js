// Input validation for everything the API accepts. Anything that doesn't fit
// is rejected with a 400 instead of being stored as-is.

import { round2, parseAmount } from '../public/js/shared/money.js';
import { INTENSITY } from '../public/js/shared/planner.js';
import { COUNT_MODES } from '../public/js/shared/ledger.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
  const t = { ...existing };
  if (input.type !== undefined) {
    if (!['income', 'expense'].includes(input.type)) throw new HttpError(400, 'type must be income or expense');
    t.type = input.type;
  }
  if (input.amount !== undefined) {
    const amount = round2(Math.abs(toNumber(input.amount)));
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');
    t.amount = amount;
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
  const g = { ...existing };
  if (input.name !== undefined) g.name = String(input.name).trim().slice(0, 80);
  if (input.target !== undefined) g.target = round2(toNumber(input.target));
  if (input.initialSaved !== undefined) g.initialSaved = round2(toNumber(input.initialSaved) || 0);
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
