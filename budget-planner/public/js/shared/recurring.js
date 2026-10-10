// Recurring payments (subscriptions, bills, yearly renewals) detected from the
// transaction history, and the charges they will make next.
// Pure: no DOM, used by the browser and by Node.

import { round2, todayISO } from './money.js';
import { merchantKey, DEFAULT_CATEGORIES } from './categories.js';

const DAY = 86400000;
const CADENCE_DAYS = { weekly: 7, monthly: 30, yearly: 365 };
const FIXED_SPREAD = 0.10; // last 3 charges within 10% = a fixed price
const VARIABLE_SPREAD = 0.60; // within 60% = a variable bill (electricity, gas)
const LATE_DAYS = 5; // a charge due this recently and not seen yet is "late", not skipped
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * unconverted foreign rows, voucher-pocket rows or transfer/savings/repayment
 * categories.
 */
export function detectSeries(state, { today = todayISO(), accountOf } = {}) {
  const categories = Array.isArray(state?.categories) ? state.categories : DEFAULT_CATEGORIES;
  const roles = new Map(categories.map((c) => [c.name, c.role]));
  const groups = new Map();
  for (const t of state?.transactions || []) {
    if (t?.type !== 'expense' || t.goalId || t.needsFx || t.pocket || roles.get(t.category)) continue;
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
 * Charges due in (fromISO, toISO] → [{ key, label, date, min, max, category,
 * accountId, late }], sorted by date. A charge that was due in the last
 * LATE_DAYS days (up to and including fromISO) and has not shown up yet is
 * listed on fromISO with late: true. Ignored series are skipped.
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
      const date = dueDate(s.lastDate, s.cadence, k);
      if (date > toISO) break;
      if (date > fromISO) {
        out.push({ ...base, date, late: false });
      } else if (from - dayNum(date) < LATE_DAYS && s.lastDate < date) {
        out.push({ ...base, date: fromISO, late: true });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.max - a.max);
}
