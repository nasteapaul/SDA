// "Safe to spend" until the next salary: the balance minus the bills, card
// payment, planned saving and buffer still due this period, as a low..high
// range (variable bills give a range), plus a calendar of the period's events.
// Pure: no DOM, used by the browser and by Node.

import { round2 } from './money.js';

const DAY = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNum(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function money(n) {
  return Number.isFinite(n) ? n : 0;
}

function positive(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Items without a date are kept (they are due "sometime this period").
function inPeriod(date, periodEnd) {
  return !date || !periodEnd || date <= periodEnd;
}

/**
 * → { balance, low, high, perDayLow, perDayHigh, daysLeft, items } or null
 * when the balance is unknown. low assumes every bill at its maximum, high at
 * its minimum. The totals may be negative (overcommitted); per day never is.
 * items: [{ label, date, min, max, kind: 'bill'|'card'|'saving'|'buffer' }].
 */
export function safeToSpend({ balance, today, periodEnd, upcoming = [], cardDue = null, plannedSaving = 0, buffer = 0 } = {}) {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return null;
  const items = [];
  for (const u of upcoming || []) {
    if (!u || !inPeriod(u.date, periodEnd)) continue;
    items.push({ label: u.label, date: u.date ?? null, min: round2(money(u.min)), max: round2(money(u.max)), kind: 'bill' });
  }
  if (cardDue && inPeriod(cardDue.date, periodEnd)) {
    items.push({ label: 'Credit card', date: cardDue.date ?? null, min: round2(money(cardDue.min)), max: round2(money(cardDue.max)), kind: 'card' });
  }
  const saving = round2(positive(plannedSaving));
  if (saving) items.push({ label: 'Planned saving', date: null, min: saving, max: saving, kind: 'saving' });
  const buf = round2(positive(buffer));
  if (buf) items.push({ label: 'Buffer', date: null, min: buf, max: buf, kind: 'buffer' });

  const sumMax = items.reduce((s, i) => s + i.max, 0);
  const sumMin = items.reduce((s, i) => s + i.min, 0);
  const low = round2(balance - sumMax);
  const high = round2(balance - sumMin);
  const span = ISO_RE.test(today || '') && ISO_RE.test(periodEnd || '') ? dayNum(periodEnd) - dayNum(today) + 1 : 1;
  const daysLeft = Math.max(1, span);
  return {
    balance: round2(balance),
    low,
    high,
    perDayLow: round2(Math.max(0, low / daysLeft)),
    perDayHigh: round2(Math.max(0, high / daysLeft)),
    daysLeft,
    items,
  };
}

const KIND_ORDER = { salary: 0, refund: 1, bill: 2, card: 3 };

/**
 * The period's money events, sorted by date:
 * [{ date, label, min, max, kind: 'salary'|'bill'|'card'|'refund' }].
 * Events after periodEnd are dropped, except the salary at nextPayday (which
 * starts the next period). The salary's amount is unknown here: min/max null.
 * refunds: [{ date, label, amount }].
 */
export function periodCalendar({ today, periodEnd, nextPayday, upcoming = [], cardDue = null, refunds = [] } = {}) {
  const events = [];
  for (const u of upcoming || []) {
    if (!u || !ISO_RE.test(u.date || '') || !inPeriod(u.date, periodEnd)) continue;
    const e = { date: u.date, label: u.label, min: round2(money(u.min)), max: round2(money(u.max)), kind: 'bill' };
    if (u.key) e.key = u.key;
    if (u.late) e.late = true;
    events.push(e);
  }
  if (cardDue && ISO_RE.test(cardDue.date || '') && inPeriod(cardDue.date, periodEnd)) {
    events.push({ date: cardDue.date, label: 'Credit card', min: round2(money(cardDue.min)), max: round2(money(cardDue.max)), kind: 'card' });
  }
  for (const r of refunds || []) {
    if (!r || !ISO_RE.test(r.date || '') || !inPeriod(r.date, periodEnd)) continue;
    const amount = round2(money(r.amount));
    events.push({ date: r.date, label: r.label, min: amount, max: amount, kind: 'refund' });
  }
  if (ISO_RE.test(nextPayday || '')) {
    events.push({ date: nextPayday, label: 'Salary', min: null, max: null, kind: 'salary' });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || String(a.label).localeCompare(String(b.label)));
}
