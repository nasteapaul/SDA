// Budget periods. By default a period is a calendar month. With a payday set
// (e.g. the 10th), a period runs from one salary to the next:
//   - the expected payday moves to Friday when it falls on a Saturday and to
//     Monday when it falls on a Sunday (10th on Sat → 9th, on Sun → 11th);
//   - when the salary has actually arrived, its real date is used (so a
//     holiday or an early payment is handled automatically).
// A period is named after the month it starts in: "2026-09" = 10 Sep → 9 Oct.

import { monthKey, addMonths, todayISO } from './money.js';

const DAY = 86400000;
const SEARCH_DAYS = 5; // how far from the expected payday a salary still counts

function iso(d) {
  return todayISO(d);
}

function parse(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function expectedPayday(key, day) {
  const [y, m] = key.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  const d = new Date(y, m - 1, Math.min(day, dim));
  if (d.getDay() === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday → Monday
  return iso(d);
}

export function makePeriods({ payday = null, transactions = [], salaryCategory = 'Salary', overrides = {} } = {}) {
  const day = Number(payday) || 0;
  const salaries = day
    ? transactions.filter((t) => t.type === 'income' && t.category === salaryCategory)
    : [];
  const startCache = new Map();

  function start(key) {
    if (!day) return `${key}-01`;
    if (overrides[key]) return overrides[key]; // salary date you set for that month
    if (startCache.has(key)) return startCache.get(key);
    const expected = expectedPayday(key, day);
    const e = parse(expected).getTime();
    // The biggest salary payment near the expected date marks the real payday.
    let best = null;
    for (const t of salaries) {
      const diff = Math.abs(parse(t.date).getTime() - e) / DAY;
      if (diff <= SEARCH_DAYS && (!best || t.amount > best.amount)) best = t;
    }
    const s = best ? best.date : expected;
    startCache.set(key, s);
    return s;
  }

  // The period whose range [start(k), start(k + 1)) contains the date. A salary
  // can come early (next month's period already started) or late (this
  // month's — or, for a payday at the end of the month, even last month's —
  // period hasn't started yet), so look at k − 2 … k + 1.
  function keyOf(date) {
    const k = monthKey(date);
    if (!day) return k;
    for (let i = 1; i >= -2; i -= 1) {
      const c = addMonths(k, i);
      if (start(c) <= date && date < start(addMonths(c, 1))) return c;
    }
    // Overlapping overrides (a salary date set out of order): latest start wins.
    for (let i = 1; i >= -2; i -= 1) {
      const c = addMonths(k, i);
      if (start(c) <= date) return c;
    }
    return addMonths(k, -1);
  }

  function end(key) {
    return iso(new Date(parse(start(addMonths(key, 1))).getTime() - DAY));
  }

  function length(key) {
    return Math.round((parse(end(key)).getTime() - parse(start(key)).getTime()) / DAY) + 1;
  }

  function fmt(date, opts) {
    return parse(date).toLocaleDateString('en-GB', opts);
  }

  return {
    payday: day || null,
    keyOf,
    start,
    end,
    length,
    current: (today = todayISO()) => keyOf(today),
    // Days left including today.
    daysLeft: (key, today = todayISO()) => Math.max(Math.round((parse(end(key)).getTime() - parse(today).getTime()) / DAY) + 1, 0),
    label: (key, opts = { month: 'long', year: 'numeric' }) => fmt(`${key}-01`, opts),
    rangeLabel: (key) => `${fmt(start(key), { day: 'numeric', month: 'short' })} – ${fmt(end(key), { day: 'numeric', month: 'short' })}`,
    // Maps a date onto a calendar-like date inside its period ("2026-09-DD",
    // DD = day of the period) so month-based analysis works on pay periods.
    pseudoDate(date) {
      const key = keyOf(date);
      const n = Math.round((parse(date).getTime() - parse(start(key)).getTime()) / DAY) + 1;
      return `${key}-${String(Math.min(Math.max(n, 1), 28)).padStart(2, '0')}`;
    },
  };
}
