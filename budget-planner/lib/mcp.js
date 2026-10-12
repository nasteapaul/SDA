// "Ask Claude about your budget": a read-only Model Context Protocol (MCP)
// server, so your own Claude (Desktop, Claude Code, or claude.ai / the phone app
// through a remote connector) can read the budget and give advice — on your
// existing Claude plan, no API key. JSON-RPC 2.0, no dependencies.
// Nothing here can change the data: every tool reads a snapshot and returns
// whitelisted fields only (no IBANs, tokens, bank session/consent ids or trash).
// Transports: stdio (../mcp.js) and Streamable HTTP (httpMcp below).

import { readFileSync } from 'node:fs';
import { emptyState } from './store.js';
import { makeLedger, hasSplits } from '../public/js/shared/ledger.js';
import { makePeriods } from '../public/js/shared/periods.js';
import { accountView, accountKind } from '../public/js/shared/accounts.js';
import { safeToSpend } from '../public/js/shared/safespend.js';
import { detectSeries, upcoming } from '../public/js/shared/recurring.js';
import { cardDue } from '../public/js/shared/cardpay.js';
import { netWorth } from '../public/js/shared/networth.js';
import { buildAlerts } from '../public/js/shared/alerts.js';
import { goalSaved } from '../public/js/shared/planner.js';
import { ownContext, isOwnTransfer } from '../public/js/shared/own.js';
import { DEFAULT_CATEGORIES, normalize } from '../public/js/shared/categories.js';
import { round2, todayISO, addMonths, monthsBetween, parseAmount } from '../public/js/shared/money.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// A mistake in a tool's arguments: returned as a tool result with isError, so the model can correct itself.
class ToolError extends Error {}

// ---------- state & privacy helpers ----------

/** A budget.json as read from disk, with the defaults Store.load() would add (read-only: nothing is written). */
export function normalizeState(raw) {
  const base = emptyState();
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const state = { ...base, ...s, bank: { ...base.bank, ...(s.bank || {}) }, settings: { ...base.settings, ...(s.settings || {}) } };
  for (const key of ['transactions', 'goals', 'categories', 'assets']) if (!Array.isArray(state[key])) state[key] = base[key];
  if (!Array.isArray(state.bank.connections)) state.bank.connections = [];
  if (!state.budgets || typeof state.budgets !== 'object') state.budgets = {};
  const missing = DEFAULT_CATEGORIES.filter((c) => !state.categories.some((x) => x.name === c.name));
  if (missing.length) state.categories = [...state.categories, ...missing.map((c) => ({ ...c }))];
  return state;
}

// IBANs (compact or in groups of 4) and long card/account numbers in free text → "…1234".
const IBAN_TEXT = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){3,7}(?: [A-Z0-9]{1,4})?)\b/gi;
const LONG_NUMBER = /\b\d(?: ?\d){11,}\b/g;
const tail = (s) => `…${s.replace(/\s/g, '').slice(-4)}`;
function clean(text, max = 140) {
  const s = String(text ?? '').replace(IBAN_TEXT, tail).replace(LONG_NUMBER, tail).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last 4 digits of an account, never the full number. */
function last4(a) {
  if (!a) return null;
  for (const v of [a.iban, a.number, a.accountNumber, a.bban]) {
    const d = String(v || '').replace(/\s/g, '');
    if (d.length >= 4) return d.slice(-4);
  }
  return a.cardDigits?.[0] ? String(a.cardDigits[0]).slice(-4) : null;
}

// Every number in a reply is rounded to 2 decimals (RON, percentages, odds).
const replacer = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? round2(v) : v);

// Derived data for one state snapshot and day; rebuilt only when either changes.
function makeContext(state, today) {
  const ledger = makeLedger(state);
  const periods = makePeriods({ payday: state.settings?.payday, transactions: state.transactions, overrides: state.settings?.paydays || {} });
  const roles = new Map(state.categories.map((c) => [c.name, c.role]));
  const accounts = (state.bank.connections || []).filter((c) => !c.archived).flatMap((c) => c.accounts || []);
  const byUid = new Map((state.bank.connections || []).flatMap((c) => c.accounts || []).map((a) => [a.uid, a]));
  const byKey = new Map();
  for (const t of state.transactions) {
    if (!t || !ISO_RE.test(t.date || '')) continue;
    const k = periods.keyOf(t.date);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const own = ownContext(state);
  const totalsMemo = new Map();
  let series;
  const c = {
    state, today, ledger, periods, roles, accounts, byUid,
    current: periods.current(today),
    txsIn: (k) => byKey.get(k) || [],
    get series() { return (series ??= detectSeries(state, { today, accountOf: (t) => ledger.accountOf(t) })); },
    // Counted totals of a period, plus the money in that came from your own accounts or cash deposits.
    totals(k) {
      if (!totalsMemo.has(k)) {
        const list = c.txsIn(k);
        const tot = ledger.totals(list);
        let ownIn = 0;
        for (const t of list) {
          const e = ledger.effect(t);
          if (e.as === 'income' && (isOwnTransfer(t, own) || /depunere numerar|cash deposit/i.test(`${t.description} ${t.note || ''}`))) ownIn += e.amount;
        }
        totalsMemo.set(k, { ...tot, ownIn: round2(ownIn) });
      }
      return totalsMemo.get(k);
    },
  };
  return c;
}

function periodInfo(c, key) {
  const { periods, today } = c;
  const start = periods.start(key);
  const end = periods.end(key);
  const info = { key, start, end, days: periods.length(key) };
  if (start <= today && today <= end) {
    info.daysLeft = periods.daysLeft(key, today);
    info.inProgress = true;
  }
  return info;
}

// Card purchases (analysis only: in cash flow they are paid through the card repayment).
function cardSpending(c, list) {
  const byCategory = {};
  let total = 0;
  const add = (cat, n) => { total += n; byCategory[cat] = round2((byCategory[cat] || 0) + n); };
  for (const t of list) {
    if (t.needsFx || t.goalId || t.pocket || c.ledger.kindOf(t) !== 'credit') continue;
    const role = c.roles.get(t.category);
    if (role === 'repayment' || role === 'transfer' || role === 'savings') continue;
    const amount = Number(t.amount) || 0;
    if (t.type === 'expense') {
      if (hasSplits(t)) for (const p of t.splits) add(p.category, Number(p.amount));
      else add(t.category, amount);
    } else if (c.ledger.isRefund(t)) add(c.ledger.refundCategory(t), -amount);
  }
  return { total: round2(total), byCategory };
}

// ---------- argument checks ----------

function checkKeys(args, allowed) {
  for (const k of Object.keys(args)) {
    if (!allowed.includes(k)) throw new ToolError(`Unknown argument "${k}". Allowed: ${allowed.join(', ') || 'none'}.`);
  }
}

function optDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !ISO_RE.test(v)) throw new ToolError(`${name} must be a date as YYYY-MM-DD`);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new ToolError(`${name} is not a real date: ${v}`);
  return v;
}

function optText(v, name, max) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ToolError(`${name} must be text`);
  if (v.length > max) throw new ToolError(`${name} is too long (max ${max} characters)`);
  return v.trim() || null;
}

function optEnum(v, name, values, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!values.includes(v)) throw new ToolError(`${name} must be one of: ${values.join(', ')}`);
  return v;
}

function clampInt(v, name, min, max, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${name} must be a number`);
  return Math.min(Math.max(Math.floor(n), min), max);
}

function periodKey(c, v) {
  if (v === undefined || v === null || v === '' || v === 'current') return c.current;
  if (v === 'previous') return addMonths(c.current, -1);
  if (typeof v === 'string' && KEY_RE.test(v)) return v;
  throw new ToolError('period must be "current", "previous" or a period key YYYY-MM (the month the pay period starts in)');
}

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

// Still to come out of the main current account until payday, as the app's Overview works it out.
function ahead(c) {
  if (c.aheadMemo) return c.aheadMemo;
  const { state, today, ledger, periods } = c;
  const end = periods.end(c.current);
  const main = ledger.mainAccount;
  const v = main?.balance ? accountView(main) : null;
  const bills = upcoming(c.series, today, end).filter((u) => !main || !u.accountId || u.accountId === main.uid);
  const due = cardDue(state, ledger, periods, today);
  const buffer = Number(state.settings?.spendBuffer) || 0;
  const safe = v?.known ? safeToSpend({ balance: v.cash, today, periodEnd: end, upcoming: bills, cardDue: due, buffer }) : null;
  return (c.aheadMemo = { main, v, bills, due, buffer, safe });
}

function overview(c) {
  const { state, today, ledger, periods } = c;
  const key = c.current;
  const tot = c.totals(key);
  const { main, v, bills, due, safe } = ahead(c);
  const cards = c.accounts.filter((a) => accountKind(a) === 'credit');
  const cardViews = cards.map((a) => ({ a, v: accountView(a) }));
  const alerts = buildAlerts(state, { today, ledger, periods, series: c.series }).slice(0, 5)
    .map((a) => ({ level: a.level, title: clean(a.title, 160), text: clean(a.text, 240) }));
  return {
    today,
    countMode: ledger.mode,
    period: { ...periodInfo(c, key), nextPayday: periods.payday ? periods.start(addMonths(key, 1)) : null, basis: periods.payday ? 'salary to salary' : 'calendar month' },
    mainAccount: main ? { account: last4(main), balance: v?.known ? v.cash : null, balanceDate: String(main.lastSyncAt || state.bank.lastSync || '').slice(0, 10) || null } : null,
    thisPeriod: { income: tot.income, incomeFromOwnAccounts: tot.ownIn, spent: tot.spend, saved: tot.saved, left: tot.left, countedTransactions: tot.count },
    safeToSpend: safe && {
      low: safe.low, high: safe.high, perDayLow: safe.perDayLow, perDayHigh: safe.perDayHigh, daysLeft: safe.daysLeft,
      setAside: safe.items.map((i) => ({ label: clean(i.label), kind: i.kind, date: i.date, min: i.min, max: i.max })),
    },
    card: cards.length ? {
      owed: round2(cardViews.reduce((n, x) => n + x.v.owed, 0)),
      accounts: cardViews.map(({ a, v: cv }) => ({ account: last4(a), owed: cv.owed, limit: cv.limit, available: cv.available, ...(cv.balanceUncertain ? { balanceUncertain: true } : {}) })),
      repaymentDue: due ? { date: due.date, min: due.min, max: due.max } : null,
      spentThisPeriod: cardSpending(c, c.txsIn(key)).total,
    } : null,
    billsBeforePayday: bills.map((b) => ({ date: b.date, label: clean(b.label), category: b.category, min: b.min, max: b.max, ...(b.late ? { late: true } : {}) })),
    alerts,
  };
}

function txOut(c, t, goals) {
  const e = c.ledger.effect(t);
  const o = {
    date: t.date,
    amount: round2(t.amount),
    type: t.type,
    category: t.category || null,
    description: clean(t.description || t.note || ''),
    account: t.pocket === 'vouchers' ? 'meal vouchers' : last4(c.ledger.accountOf(t)),
    counted: Boolean(e.as),
  };
  if (t.needsFx) o.currency = t.originalCurrency ? String(t.originalCurrency).slice(0, 3) : 'not RON';
  if (e.as === 'saved') o.countedAs = 'saved';
  else if (e.as === 'expense' && t.type === 'income') o.countedAs = 'refund';
  if (t.note && t.description) o.note = clean(t.note, 80);
  if (t.goalId && goals.has(t.goalId)) o.goal = clean(goals.get(t.goalId), 60);
  if (hasSplits(t)) o.splits = t.splits.map((p) => ({ category: p.category, amount: round2(p.amount) }));
  return o;
}

function listTransactions(c, a) {
  checkKeys(a, ['from', 'to', 'category', 'search', 'type', 'account', 'limit']);
  const from = optDate(a.from, 'from');
  const to = optDate(a.to, 'to');
  if (from && to && from > to) throw new ToolError('from must be on or before to');
  const category = optText(a.category, 'category', 60);
  const search = optText(a.search, 'search', 100);
  const type = optEnum(a.type, 'type', ['income', 'expense'], null);
  const account = optEnum(a.account, 'account', ['main', 'card', 'all'], 'all');
  const limit = clampInt(a.limit, 'limit', 1, 200, 50);
  const cat = category && normalize(category);
  const q = search && normalize(search);
  const list = c.state.transactions.filter((t) => {
    if (!t || !ISO_RE.test(t.date || '')) return false;
    if ((from && t.date < from) || (to && t.date > to)) return false;
    if (type && t.type !== type) return false;
    if (cat && normalize(t.category) !== cat && !(hasSplits(t) && t.splits.some((p) => normalize(p.category) === cat))) return false;
    if (q && !normalize(`${t.description || ''} ${t.note || ''} ${t.category || ''}`).includes(q)) return false;
    if (account === 'main' && !c.ledger.isMain(t)) return false;
    if (account === 'card' && c.ledger.kindOf(t) !== 'credit') return false;
    return true;
  }).sort((x, y) => y.date.localeCompare(x.date) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  const goals = new Map(c.state.goals.map((g) => [g.id, g.name]));
  return { matched: list.length, returned: Math.min(limit, list.length), truncated: list.length > limit, transactions: list.slice(0, limit).map((t) => txOut(c, t, goals)) };
}

function spendingByCategory(c, a) {
  checkKeys(a, ['period']);
  const key = periodKey(c, a.period);
  const tot = c.totals(key);
  const prev = [1, 2, 3].map((i) => c.totals(addMonths(key, -i))).filter((t) => t.count > 0);
  const budgets = c.state.budgets || {};
  const essential = new Map(c.state.categories.map((x) => [x.name, Boolean(x.essential)]));
  const names = new Set([...Object.keys(tot.byCategory), ...Object.keys(budgets), ...prev.flatMap((p) => Object.keys(p.byCategory))]);
  const rows = [...names].map((name) => {
    const spent = round2(tot.byCategory[name] || 0);
    const budget = Number(budgets[name]) > 0 ? round2(budgets[name]) : null;
    const avg = prev.length ? round2(prev.reduce((n, p) => n + (p.byCategory[name] || 0), 0) / prev.length) : null;
    const row = { category: name, spent, budget, avgPrev3: avg, essential: essential.get(name) ?? false };
    if (budget != null) { row.overBudget = round2(spent - budget); row.pctOfBudget = Math.round((spent / budget) * 100); }
    if (avg != null) row.vsAverage = round2(spent - avg);
    return row;
  }).filter((r) => r.spent || r.budget != null || r.avgPrev3).sort((x, y) => y.spent - x.spent || (y.avgPrev3 || 0) - (x.avgPrev3 || 0));
  const out = {
    period: periodInfo(c, key),
    totals: { income: tot.income, spent: tot.spend, saved: tot.saved, left: tot.left, budgeted: round2(rows.reduce((n, r) => n + (r.budget || 0), 0)) },
    averageBasedOnPeriods: prev.length,
    categories: rows,
  };
  if (c.ledger.mode === 'cashflow' && c.accounts.some((x) => accountKind(x) === 'credit')) {
    const card = cardSpending(c, c.txsIn(key));
    out.cardPurchases = { note: 'analysis only, already inside "Credit card repayment" when you pay the card', total: card.total, byCategory: card.byCategory };
  }
  return out;
}

function periodHistory(c, a) {
  checkKeys(a, ['count']);
  const count = clampInt(a.count, 'count', 1, 24, 6);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const key = addMonths(c.current, -i);
    const t = c.totals(key);
    rows.push({ key, start: c.periods.start(key), end: c.periods.end(key), income: t.income, incomeFromOwnAccounts: t.ownIn, spent: t.spend, saved: t.saved, left: t.left, countedTransactions: t.count, ...(i === 0 ? { inProgress: true } : {}) });
  }
  const full = rows.slice(1).filter((r) => r.countedTransactions > 0);
  const avg = (f) => (full.length ? round2(full.reduce((n, r) => n + r[f], 0) / full.length) : null);
  return {
    basis: c.periods.payday ? 'salary to salary' : 'calendar month',
    periods: rows,
    averageOfCompletedPeriods: { periods: full.length, income: avg('income'), spent: avg('spent'), saved: avg('saved'), left: avg('left') },
  };
}

const PER_MONTH = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
function recurringPayments(c, a) {
  checkKeys(a, []);
  const list = c.series.map((s) => ({
    label: clean(s.label),
    category: s.category,
    cadence: s.cadence,
    ...(s.variable ? { min: s.min, max: s.max } : { amount: s.amount }),
    nextDate: s.nextDate,
    lastDate: s.lastDate,
    status: s.status,
    timesSeen: s.count,
    account: last4(c.byUid.get(s.accountId)),
    ...(s.priceChange ? { priceChange: s.priceChange } : {}),
  }));
  const active = c.series.filter((s) => s.status !== 'ignored');
  return {
    monthlyEquivalent: round2(active.reduce((n, s) => n + (s.variable ? s.avg : s.amount) * PER_MONTH[s.cadence], 0)),
    payments: list,
  };
}

function goalsAndBudgets(c, a) {
  checkKeys(a, []);
  const { state, today } = c;
  const goals = state.goals.filter((g) => g && !g.archived).map((g) => {
    const target = round2(g.target);
    const saved = goalSaved(g, state.transactions);
    const remaining = Math.max(round2(target - saved), 0);
    const out = { name: clean(g.name, 80), target, saved, remaining, progressPct: target > 0 ? Math.round((saved / target) * 100) : null, deadline: g.deadline || null, priority: g.priority || 'medium' };
    if (g.deadline && remaining > 0) {
      out.monthlyNeeded = round2(remaining / Math.max(monthsBetween(today, g.deadline), 1));
      if (g.deadline < today) out.overdue = true;
    }
    return out;
  });
  const tot = c.totals(c.current);
  const budgets = Object.entries(state.budgets || {}).filter(([, v]) => Number(v) > 0).map(([category, limit]) => {
    const spent = round2(tot.byCategory[category] || 0);
    const max = round2(Number(limit));
    return { category, limit: max, spentThisPeriod: spent, left: round2(max - spent), pctUsed: Math.round((spent / max) * 100) };
  }).sort((x, y) => y.pctUsed - x.pctUsed);
  return { period: periodInfo(c, c.current), goals, archivedGoals: state.goals.filter((g) => g?.archived).length, budgets };
}

function netWorthTool(c, a) {
  checkKeys(a, []);
  const nw = netWorth(c.state);
  return {
    total: nw.total, bankCash: nw.bankCash, cardOwed: nw.cardOwed, otherAssets: nw.assets, loans: nw.debts,
    items: nw.items.map((i) => ({ name: clean(i.name, 80), kind: i.kind, amount: i.amount, source: i.source })),
    staleManualValues: nw.stale.map((x) => clean(x.name, 80)),
  };
}

// odds.js may not be there (older checkout): the tool is then left out.
let oddsModule;
async function loadOdds() {
  if (oddsModule === undefined) {
    try {
      const m = await import('../public/js/shared/odds.js');
      oddsModule = typeof m.paydayOdds === 'function' ? m : null;
    } catch { oddsModule = null; }
  }
  return oddsModule;
}

// Only plain values from the odds result: no transaction objects can slip through.
function plain(v, depth = 0) {
  if (typeof v === 'string') return clean(v, 300);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (depth > 2) return undefined;
  if (Array.isArray(v)) return v.slice(-24).map((x) => plain(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/iban|token|session|consent|secret/i.test(k) || /^ids?$|[a-z]Ids?$/.test(k)) continue;
      const p = plain(x, depth + 1);
      if (p !== undefined) o[k] = p;
    }
    return o;
  }
  return undefined;
}

async function paydayOddsTool(c, a) {
  checkKeys(a, ['extra_spend']);
  let extra = 0;
  if (a.extra_spend !== undefined && a.extra_spend !== null) {
    extra = typeof a.extra_spend === 'string' ? parseAmount(a.extra_spend) : a.extra_spend;
    if (typeof extra !== 'number' || !Number.isFinite(extra) || extra < 0 || extra > 10_000_000) throw new ToolError('extra_spend must be an amount in RON between 0 and 10,000,000');
  }
  const odds = await loadOdds();
  if (!odds) throw new ToolError('Payday odds are not available in this version');
  const m = ahead(c);
  const r = await odds.paydayOdds(c.state, {
    ledger: c.ledger, periods: c.periods, today: c.today, balance: m.safe?.balance, upcoming: m.bills, cardDue: m.due,
    threshold: m.buffer, extraSpend: extra, series: c.series,
  });
  const p = plain(r);
  const out = { extraSpend: round2(extra), ...(p && typeof p === 'object' && !Array.isArray(p) ? p : { result: p ?? null }) };
  if (typeof odds.oddsText === 'function') out.summary = clean(odds.oddsText(r), 400);
  return out;
}

const TOOLS = [
  {
    name: 'get_overview',
    title: 'Budget overview',
    description: 'Start here. The current pay period (salary to salary: key, start, end, days left, next payday), the main current account balance, this period\'s income / spent / saved / left (only the main current account counts), safe to spend until payday (balance minus bills, card repayment and reserve still due, as a low–high range and per day), credit-card amount owed and repayment due, bills and subscriptions due before payday, and the top alerts. RON.',
    inputSchema: schema(),
    run: (c, a) => { checkKeys(a, []); return overview(c); },
  },
  {
    name: 'list_transactions',
    title: 'Transactions',
    description: 'Transactions, newest first. Filters: from/to (YYYY-MM-DD, inclusive), category (exact name), search (text in description or note), type (income|expense), account (main = the counted current account, card = credit card, all). counted=true when the row counts in the cash-flow totals; countedAs shows "saved" (goal money) or "refund" (lowers spending). account = last 4 digits. RON unless currency is set.',
    inputSchema: schema({
      from: { ...DATE, description: 'First date, YYYY-MM-DD' },
      to: { ...DATE, description: 'Last date, YYYY-MM-DD' },
      category: { type: 'string', maxLength: 60, description: 'Category name, e.g. Groceries' },
      search: { type: 'string', maxLength: 100, description: 'Text to find in the description or note' },
      type: { type: 'string', enum: ['income', 'expense'] },
      account: { type: 'string', enum: ['main', 'card', 'all'], default: 'all' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    run: listTransactions,
  },
  {
    name: 'spending_by_category',
    title: 'Spending by category',
    description: 'Counted spending per category in one pay period, against the category budget and the average of the 3 periods before (vsAverage > 0 = more than usual). essential=false marks flexible categories. For the credit card, cardPurchases shows what was bought (analysis only: in cash flow the card is paid through "Credit card repayment").',
    inputSchema: schema({ period: { type: 'string', pattern: '^(current|previous|\\d{4}-(0[1-9]|1[0-2]))$', default: 'current', description: '"current", "previous" or a period key YYYY-MM (the month the pay period starts in)' } }),
    run: spendingByCategory,
  },
  {
    name: 'period_history',
    title: 'Pay period history',
    description: 'Income, spent, saved and left per pay period, newest first (the first one is in progress), plus the average of the completed periods. incomeFromOwnAccounts is money moved in from your own accounts or cash deposits (included in income, but not earned).',
    inputSchema: schema({ count: { type: 'integer', minimum: 1, maximum: 24, default: 6, description: 'How many periods' } }),
    run: periodHistory,
  },
  {
    name: 'recurring_payments',
    title: 'Bills and subscriptions',
    description: 'Bills and subscriptions found from repeating payments: label, amount (or min–max for variable bills), cadence, next and last date, price change, and status (confirmed by the user, suggested = detected automatically, ignored = the user said it is not recurring). monthlyEquivalent adds up the ones not ignored.',
    inputSchema: schema(),
    run: recurringPayments,
  },
  {
    name: 'goals_and_budgets',
    title: 'Goals and budgets',
    description: 'Savings goals (target, saved, remaining, deadline, monthly amount needed to reach it on time) and the monthly category budgets with what was spent this period.',
    inputSchema: schema(),
    run: goalsAndBudgets,
  },
  {
    name: 'net_worth',
    title: 'Net worth',
    description: 'Net worth: money in the linked bank accounts minus credit-card debt, plus assets added by hand (pension, investments, cash, property) minus loans. staleManualValues were not updated for 100+ days.',
    inputSchema: schema(),
    run: netWorthTool,
  },
  {
    name: 'payday_odds',
    title: 'Payday odds',
    description: 'How likely the main current account lasts until the next salary, from past pay periods (probability and p10/p50/p90 of the balance on payday). extra_spend simulates an extra purchase now, in RON.',
    inputSchema: schema({ extra_spend: { type: 'number', minimum: 0, maximum: 10000000, description: 'Extra amount spent now, in RON' } }),
    run: paydayOddsTool,
    optional: loadOdds,
  },
];

// ---------- prompts ----------

const RULES = 'Use only numbers the budget-planner tools return; never invent or estimate data they do not give, and say so when something is missing. '
  + 'Amounts are RON. Pay periods run from salary to salary. Only the main current account counts (money in = income, money out = spending); the credit card is analysis only, and money moved between own accounts is not real income. '
  + 'Answer in the language I write in, concretely, with the numbers.';

const PROMPTS = [
  {
    name: 'monthly_review',
    title: 'Review my pay period',
    description: 'A review of the current pay period against the previous ones, with concrete next steps.',
    arguments: [],
    text: () => 'Review my budget for the current pay period. First call get_overview, then spending_by_category for "current" and "previous", period_history and goals_and_budgets. '
      + 'Tell me: how this period compares with my usual periods, which categories are over budget or above average (with amounts), what is still due before payday and what is safe to spend, how my goals are doing, and 3 specific actions for the rest of the period. '
      + RULES,
  },
  {
    name: 'can_i_afford',
    title: 'Can I afford it?',
    description: 'Whether a purchase fits before the next payday without hurting bills or goals.',
    arguments: [
      { name: 'amount', description: 'Price in RON', required: true },
      { name: 'what', description: 'What you want to buy', required: false },
    ],
    text: ({ amount, what }) => `Can I afford to spend ${amount} RON${what ? ` on ${what}` : ''} now? `
      + 'First call get_overview (safe to spend, bills and card repayment before payday), then payday_odds with extra_spend set to that amount if the tool exists, and goals_and_budgets. '
      + 'Give a clear yes / not now / no, what would be left per day until payday after it, which bill or goal it would put at risk, and a safer alternative (wait until payday, a smaller amount) if needed. '
      + RULES,
  },
  {
    name: 'find_savings',
    title: 'Find savings',
    description: 'Realistic places to save, from subscriptions, price rises and categories above average.',
    arguments: [],
    text: () => 'Find realistic savings in my budget. First call spending_by_category (current and previous period), recurring_payments and period_history; use list_transactions to look at the biggest categories if needed. '
      + 'Look at subscriptions and price rises, flexible categories above my average, card purchases and small frequent spending. List the top 5 savings with the RON per month each would save, starting with the easiest. '
      + RULES,
  },
];

function promptArgs(p, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
  for (const k of Object.keys(args)) if (!p.arguments.some((x) => x.name === k)) throw new RpcError(-32602, `Unknown argument "${k}" for prompt ${p.name}`);
  for (const x of p.arguments) if (x.required && (args[x.name] === undefined || args[x.name] === '')) throw new RpcError(-32602, `Missing required argument "${x.name}"`);
  if (p.name !== 'can_i_afford') return {};
  const amount = parseAmount(String(args.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new RpcError(-32602, 'amount must be a positive number of RON');
  if (args.what !== undefined && (typeof args.what !== 'string' || args.what.length > 120)) throw new RpcError(-32602, 'what must be text up to 120 characters');
  return { amount: round2(amount), what: args.what ? clean(args.what, 120) : '' };
}

// ---------- JSON-RPC ----------

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * createMcp({ getState, today }) → { handle(message) }. getState() returns the
 * budget state (or a promise of it); handle() takes one parsed JSON-RPC message
 * or a batch and resolves to the response (an array for a batch), or null when
 * nothing needs an answer (notifications, client responses).
 */
export function createMcp({ getState, today = () => todayISO(), log = (msg) => process.stderr.write(`[mcp] ${msg}\n`) } = {}) {
  if (typeof getState !== 'function') throw new TypeError('createMcp needs getState()');
  let memo = { state: null, today: '', ctx: null };

  async function context() {
    const raw = await getState();
    const ready = raw && Array.isArray(raw.transactions) && Array.isArray(raw.goals) && Array.isArray(raw.categories) && Array.isArray(raw.bank?.connections);
    const state = ready ? raw : normalizeState(raw);
    const day = today();
    if (memo.state !== state || memo.today !== day) memo = { state, today: day, ctx: makeContext(state, day) };
    return memo.ctx;
  }

  async function tools() {
    const list = [];
    for (const t of TOOLS) if (!t.optional || await t.optional()) list.push(t);
    return list;
  }

  async function instructions() {
    let main = '7204';
    let card = '8391';
    try {
      const c = await context();
      main = last4(c.ledger.mainAccount) || main;
      card = last4(c.accounts.find((a) => accountKind(a) === 'credit')) || card;
    } catch { /* the defaults describe the usual setup */ }
    return `Read-only budget data of one person, in RON (nothing can be changed through this server). Pay periods run from salary to salary; a period key YYYY-MM is the month it starts in. `
      + `Only the main current account (…${main}) counts in cash flow: money in = income, money out = spending (paying the credit card included). `
      + `The credit card (…${card}) is analysis only (purchases, amount owed, repayment) and is not added to the totals; money moved between own accounts is not real income. `
      + 'Start with get_overview. Use only the numbers the tools return.';
  }

  const methods = {
    async initialize(p) {
      const asked = p.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'budget-planner', title: 'Budget Planner', version: VERSION },
        instructions: await instructions(),
      };
    },
    ping: () => ({}),
    async 'tools/list'() {
      return { tools: (await tools()).map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { title, ...READ_ONLY } })) };
    },
    async 'tools/call'(p) {
      const tool = typeof p.name === 'string' && (await tools()).find((t) => t.name === p.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(p.name).slice(0, 60)}`);
      const args = p.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments must be an object');
      try {
        const result = await tool.run(await context(), args);
        return { content: [{ type: 'text', text: JSON.stringify(result, replacer) }] };
      } catch (err) {
        if (!(err instanceof ToolError)) log(`${tool.name} failed: ${err.message}`);
        const text = err instanceof ToolError ? err.message : 'The budget data could not be read. Is the budget planner set up on this computer?';
        return { content: [{ type: 'text', text }], isError: true };
      }
    },
    'prompts/list': () => ({ prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) }),
    'prompts/get'(p) {
      const prompt = PROMPTS.find((x) => x.name === p.name);
      if (!prompt) throw new RpcError(-32602, `Unknown prompt: ${String(p.name).slice(0, 60)}`);
      const values = promptArgs(prompt, p.arguments);
      return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(values) } }] };
    },
  };

  async function handleOne(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid Request');
    const isNotification = !('id' in msg);
    if (typeof msg.method !== 'string') return isNotification || 'result' in msg || 'error' in msg ? null : fail(null, -32600, 'Invalid Request');
    if (isNotification) return null; // notifications/initialized, cancelled, …: nothing to do
    const { id } = msg;
    if (msg.jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number')) return fail(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request');
    if (!Object.hasOwn(methods, msg.method)) return fail(id, -32601, `Method not found: ${msg.method.slice(0, 60)}`);
    const params = msg.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) return fail(id, -32602, 'params must be an object');
    try {
      return ok(id, await methods[msg.method](params));
    } catch (err) {
      if (err instanceof RpcError) return fail(id, err.code, err.message);
      log(`${msg.method} failed: ${err.message}`);
      return fail(id, -32603, 'Internal error');
    }
  }

  async function handle(message) {
    if (!Array.isArray(message)) return handleOne(message);
    if (!message.length) return fail(null, -32600, 'Invalid Request');
    const out = (await Promise.all(message.slice(0, 50).map(handleOne))).filter(Boolean);
    return out.length ? out : null;
  }

  return { handle };
}

// ---------- Streamable HTTP ----------

const BODY_LIMIT = 1024 * 1024;
const httpError = (status, message, rpcCode = -32600) => Object.assign(new Error(message), { status, rpcCode });

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw httpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Parse error', -32700); }
}

/** The key from "Authorization: Bearer <key>" or the path /mcp/<key> (for clients that can't send headers). */
function keyFrom(req) {
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (auth) return auth[1];
  const m = /^\/mcp\/([A-Za-z0-9_-]{16,128})\/?$/.exec(String(req.url || '').split('?')[0]);
  return m ? m[1] : null;
}

/**
 * Streamable HTTP transport (stateless, JSON replies, no SSE stream):
 * POST one JSON-RPC message or a batch → 200 application/json, or 202 when it
 * held only notifications; GET/DELETE/other → 405; missing or wrong key → 401;
 * an Origin from another host without a valid key → 403. readBody(req) must resolve to the parsed
 * JSON (arrays allowed); by default a 1 MB application/json reader is used.
 * allowedHosts: extra Origin hosts to accept (e.g. the public HTTPS host).
 */
export async function httpMcp(req, res, { mcp, keys, readBody = readJson, allowedHosts = [] } = {}) {
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const keyOk = Boolean(keys?.exists && keys.valid(keyFrom(req)));
  // Browsers on other sites (and DNS rebinding) send their own Origin: refuse it,
  // unless the request carries the secret key — web clients such as claude.ai
  // send their own Origin, and without the key nothing can be read anyway.
  const origin = req.headers.origin;
  if (origin !== undefined && !keyOk) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* "null" or junk */ }
    if (!host || (host !== req.headers.host && !allowedHosts.includes(host))) return reply(403, fail(null, -32600, 'Cross-site request blocked'));
  }
  if (!keyOk) {
    return reply(401, fail(null, -32600, keys?.exists ? 'Wrong or missing MCP key' : 'MCP access is off: create a key first'), { 'WWW-Authenticate': 'Bearer realm="budget-planner"' });
  }
  if (req.method !== 'POST') return reply(405, fail(null, -32600, 'Method not allowed: POST JSON-RPC messages here'), { Allow: 'POST' });
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const status = err.status || err.statusCode || 400;
    return reply(status, fail(null, err.rpcCode || (status === 400 ? -32700 : -32600), status === 400 ? 'Parse error' : err.message));
  }
  // A newer client may send its own (newer) version on initialize; the reply then
  // negotiates one this server knows. After that, an unknown version is refused.
  const version = req.headers['mcp-protocol-version'];
  const initializing = [body].flat().some((m) => m?.method === 'initialize');
  if (version !== undefined && !initializing && !PROTOCOL_VERSIONS.includes(version)) return reply(400, fail(null, -32600, `Unsupported MCP-Protocol-Version: ${String(version).slice(0, 20)}`));
  const result = await mcp.handle(body);
  if (result === null) return reply(202);
  return reply(200, result);
}
