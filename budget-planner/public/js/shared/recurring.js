// Recurring payments (subscriptions, bills, yearly renewals) detected from the
// transaction history, and the charges they will make next.
// Pure: no DOM, used by the browser and by Node.

import { round2, todayISO } from './money.js';
import { merchantKey, normalize, DEFAULT_CATEGORIES } from './categories.js';

const DAY = 86400000;
const CADENCE_DAYS = { weekly: 7, monthly: 30, yearly: 365 };
const FIXED_SPREAD = 0.10; // last 3 charges within 10% = a fixed price
const VARIABLE_SPREAD = 0.60; // within 60% = a variable bill (electricity, gas)
const LATE_DAYS = 5; // a charge due this recently and not seen yet is "late", not skipped
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Taking cash out is not a bill, however regular it is.
const CASH_CATEGORY = 'Cash';
const CASH_RE = /retragere numerar|cash withdrawal|\batm\b|bancomat/;
const PENDING_MATCH = 0.05; // a pending payment within 5% of a bill's amount is that bill

// Day number in UTC, so DST changes never shift a gap by one.
function dayNum(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function isoOf(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(isoDate, n) {
  const d = new Date((dayNum(isoDate) + n) * DAY);
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// n months later on the same day of month, clamped (31 Jan + 1 month = 28/29 Feb).
function addMonthsClamped(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return isoOf(ny, nm, Math.min(d, last));
}

// The k-th due date after `lastDate` (k = 1 is the next one). Always counted
// from the last charge, so a clamped month never makes later dates drift.
function dueDate(lastDate, cadence, k) {
  if (cadence === 'weekly') return addDays(lastDate, 7 * k);
  if (cadence === 'yearly') return addMonthsClamped(lastDate, 12 * k);
  return addMonthsClamped(lastDate, k);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function spreadOf(amounts) {
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  return { avg, spread: avg > 0 ? (Math.max(...amounts) - Math.min(...amounts)) / avg : Infinity };
}

function cadenceOf(list) {
  const gaps = [];
  for (let i = 1; i < list.length; i++) gaps.push(dayNum(list[i].date) - dayNum(list[i - 1].date));
  const gap = median(gaps);
  if (gap >= 6 && gap <= 8) {
    // Weekly needs a steady price, so weekly grocery runs never qualify.
    if (list.length < 4 || spreadOf(list.slice(-4).map((t) => t.amount)).spread > FIXED_SPREAD) return null;
    return 'weekly';
  }
  if (gap >= 25 && gap <= 35) {
    const [fy, fm] = list[0].date.split('-').map(Number);
    const [ly, lm] = list[list.length - 1].date.split('-').map(Number);
    const months = (ly - fy) * 12 + (lm - fm) + 1;
    return list.length > months + 1 ? null : 'monthly'; // more visits than months: a shop, not a bill
  }
  if (gap >= 350 && gap <= 380) return 'yearly';
  return null;
}

function mostCommon(values) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    if (v == null) continue;
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c >= bestCount) { best = v; bestCount = c; } // ties go to the most recent
  }
  return best;
}

/**
 * Series = { key, label, category, cadence, amount, avg, min, max, variable,
 * count, lastDate, nextDate, accountId, status, priceChange, txIds }, sorted by
 * amount (largest first). Only plain expenses count: no goal transfers,
 * unconverted foreign rows, voucher-pocket rows, transfer/savings/repayment
 * categories or cash withdrawals.
 */
export function detectSeries(state, { today = todayISO(), accountOf } = {}) {
  const categories = Array.isArray(state?.categories) ? state.categories : DEFAULT_CATEGORIES;
  const roles = new Map(categories.map((c) => [c.name, c.role]));
  const groups = new Map();
  for (const t of state?.transactions || []) {
    if (t?.type !== 'expense' || t.goalId || t.needsFx || t.pocket || roles.get(t.category)) continue;
    if (t.category === CASH_CATEGORY || CASH_RE.test(normalize(`${t.description || ''} ${t.note || ''}`))) continue;
    if (!ISO_RE.test(t.date || '') || t.date > today) continue;
    if (!(Number.isFinite(t.amount) && t.amount > 0)) continue;
    const key = merchantKey(t.description) || merchantKey(t.note);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const chosen = state?.settings?.recurring || {};
  const out = [];
  for (const [key, raw] of groups) {
    if (raw.length < 2) continue;
    const list = [...raw].sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const cadence = cadenceOf(list);
    if (!cadence) continue;
    const latest = list[list.length - 1];
    const lastDate = latest.date;
    // Not charged for 1.5 cadences (+10 days of slack): treat it as cancelled.
    if (dayNum(today) - dayNum(lastDate) > 1.5 * CADENCE_DAYS[cadence] + 10) continue;

    const last3 = list.slice(-3).map((t) => t.amount);
    const { avg, spread } = spreadOf(last3);
    if (spread > VARIABLE_SPREAD) continue;
    // A steady price that just went up (or down) is still a fixed price, not a variable bill.
    const before = list.slice(-4, -1).map((t) => t.amount);
    const stepped = before.length >= 2 && spreadOf(before).spread <= FIXED_SPREAD;
    const variable = spread > FIXED_SPREAD && !stepped;

    let priceChange = null;
    if (!variable) {
      const from = list[list.length - 2].amount;
      const to = latest.amount;
      const diff = round2(to - from); // 24.99 - 23.99 is 0.99999… in floating point
      if (diff >= 1 && diff / from >= 0.02) {
        priceChange = { from: round2(from), to: round2(to), pct: Math.round((diff / from) * 1000) / 10, date: lastDate };
      }
    }

    const status = chosen[key] === 'confirmed' || chosen[key] === 'ignored' ? chosen[key] : 'suggested';
    out.push({
      key,
      label: latest.description || latest.note || key,
      category: latest.category,
      cadence,
      amount: round2(latest.amount),
      avg: round2(avg),
      min: round2(Math.min(...last3)),
      max: round2(Math.max(...last3)),
      variable,
      count: list.length,
      lastDate,
      nextDate: dueDate(lastDate, cadence, 1),
      accountId: mostCommon(list.map((t) => accountOf?.(t)?.uid ?? t.accountId ?? null)),
      status,
      priceChange,
      txIds: list.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * Charges due in [fromISO, toISO] → [{ key, label, date, due, min, max,
 * category, accountId, late }], sorted by date. `due` is the real due date. A
 * charge that was due in the last LATE_DAYS days (before fromISO) and has not
 * shown up yet is listed on fromISO (date) with late: true and its real `due`
 * (so it keeps one identity from day to day); one due on fromISO isn't late.
 * Ignored series are skipped; suggested (not yet confirmed) ones count.
 */
export function upcoming(seriesList, fromISO, toISO) {
  if (!ISO_RE.test(fromISO || '') || !ISO_RE.test(toISO || '')) return [];
  const from = dayNum(fromISO);
  const out = [];
  for (const s of seriesList || []) {
    if (!s || s.status === 'ignored' || !CADENCE_DAYS[s.cadence] || !ISO_RE.test(s.lastDate || '')) continue;
    const min = s.variable ? s.min : s.amount;
    const max = s.variable ? s.max : s.amount;
    const base = { key: s.key, label: s.label, min, max, category: s.category, accountId: s.accountId ?? null };
    for (let k = 1; k < 1000; k++) {
      const due = dueDate(s.lastDate, s.cadence, k);
      if (due > toISO) break;
      if (due >= fromISO) {
        out.push({ ...base, date: due, due, late: false });
      } else if (from - dayNum(due) < LATE_DAYS && s.lastDate < due) {
        out.push({ ...base, date: fromISO, due, late: true });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.max - a.max);
}

/**
 * upcomingList without the late or due-today bills already paid but still
 * pending at the bank. pendingItems: [{ amount, description, date, currency? }]
 * (an account's pendingItems, see lib/sync.js) — the bank has already taken
 * them off the balance, so the bill would otherwise be counted twice. A
 * pending payment matches the bill with the same merchant key, else one whose
 * amount is within 5%; each pending payment cancels one bill, and only when it
 * was made no more than LATE_DAYS before the bill's due date.
 */
export function dropPending(upcomingList, pendingItems, today = todayISO()) {
  const list = Array.isArray(upcomingList) ? upcomingList : [];
  const pending = (Array.isArray(pendingItems) ? pendingItems : [])
    .filter((p) => p && Number.isFinite(Number(p.amount)) && Number(p.amount) > 0)
    .map((p) => ({ amount: Number(p.amount), key: merchantKey(p.description), date: ISO_RE.test(p.date || '') ? p.date : null, ron: !p.currency || p.currency === 'RON' }));
  if (!pending.length || !list.length) return list;
  const dueNow = (u) => u && (u.late || String(u.due || u.date || '') <= today);
  const near = (u, p) => !p.date || !ISO_RE.test(u.due || '') || dayNum(p.date) >= dayNum(u.due) - LATE_DAYS;
  const sameMerchant = (u, p) => Boolean(p.key) && p.key === u.key;
  const sameAmount = (u, p) => p.ron && p.amount >= (Number(u.min) || 0) * (1 - PENDING_MATCH) && p.amount <= (Number(u.max) || 0) * (1 + PENDING_MATCH);
  const dropped = new Set();
  const used = new Set();
  // The merchant first, so a payment never takes, by its amount, the bill another payment names.
  for (const match of [sameMerchant, sameAmount]) {
    for (const p of pending) {
      if (used.has(p)) continue;
      const u = list.find((x) => !dropped.has(x) && dueNow(x) && near(x, p) && match(x, p));
      if (u) { dropped.add(u); used.add(p); }
    }
  }
  return dropped.size ? list.filter((u) => !dropped.has(u)) : list;
}
