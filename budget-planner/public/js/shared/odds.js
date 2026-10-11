// "Payday odds": instead of one "safe to spend" number, the chance of reaching
// the next salary with at least a threshold left, the likely range of what is
// left (p10–p90) and how often such ranges were right in past periods.
//
// Model: everyday spending = what counted as spending on the main current
// account minus recurring bills and card repayments (those are known: they come
// in as `upcoming` and `cardDue`). The days left are simulated by resampling
// 7-day blocks of past complete pay periods (block bootstrap), each block taken
// from about the same place in a past period — the days after payday look
// different from the days before the next one. Money coming in before payday
// is not counted: the salary starts the next period.
// Pure: no DOM, used by the browser and by Node.

import { round2, todayISO, addMonths } from './money.js';
import { makeLedger } from './ledger.js';
import { makePeriods } from './periods.js';
import { detectSeries } from './recurring.js';
import { reconcile } from './reconcile.js';
import { DEFAULT_CATEGORIES } from './categories.js';

const DAY = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCK = 7; // days per block: keeps the weekly rhythm (weekend shopping)
const JITTER = 3; // a block may come from up to 3 days earlier/later in a past period
const MIN_PERIODS = 3; // fewer complete periods: still learning
const MAX_PERIODS = 12; // the last year is what your spending looks like now
const BACKTEST = 6; // periods checked for the track record
const COVER_SLACK = 3; // data starting up to 3 days into a period still covers it
const BACKTEST_RUNS = 1000;

// Day number in UTC, so DST changes never shift a day.
function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function addDays(iso, n) {
  return new Date((dayNum(iso) + n) * DAY).toISOString().slice(0, 10);
}

// Small seeded PRNG: the same data and seed always give the same odds.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function num(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

// { min, max } with 0 <= min <= max, or null when the amounts aren't numbers.
function range(item) {
  const a = Number(item?.min ?? item?.max);
  const b = Number(item?.max ?? item?.min);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.max(0, Math.min(a, b)), max: Math.max(0, a, b) };
}

const add = (map, key, n) => map.set(key, (map.get(key) || 0) + n);

/**
 * One pass over the main account's rows (up to today):
 * everyday: date → everyday spending, fixed: date → bills + card repayments,
 * net: date → money in − out that moved the bank balance, seen: dates with data.
 */
function collect(state, ledger, today, series) {
  const billIds = new Set();
  for (const s of series) if (s && s.status !== 'ignored' && Array.isArray(s.txIds)) for (const id of s.txIds) billIds.add(id);
  const roles = new Map(state.categories.map((c) => [c.name, c.role]));
  const hasMain = Boolean(ledger.mainAccount);
  const everyday = new Map();
  const fixed = new Map();
  const net = new Map();
  const seen = new Set();
  let first = null;
  for (const t of state.transactions) {
    if (!t || typeof t.date !== 'string' || !ISO_RE.test(t.date) || t.date > today) continue;
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || !ledger.isMain(t)) continue;
    seen.add(t.date);
    if (!first || t.date < first) first = t.date;
    const real = !t.needsFx && t.pocket !== 'vouchers';
    // Manual entries aren't in the bank balance.
    if (real && (!hasMain || t.source === 'bank' || t.source === 'import')) add(net, t.date, t.type === 'income' ? amount : -amount);
    if (real && t.type === 'expense' && !t.goalId && (billIds.has(t.id) || roles.get(t.category) === 'repayment')) {
      add(fixed, t.date, amount);
      continue;
    }
    const e = ledger.effect(t);
    if (e.as === 'expense') add(everyday, t.date, e.amount);
  }
  return { everyday, fixed, net: [...net.entries()], seen, first };
}

// Complete past periods with data: { key, start, end, len, pre } (pre = prefix sums of everyday spending).
function pastPeriods(periods, key, data) {
  const out = [];
  if (!data.first) return out;
  const firstDay = dayNum(data.first);
  for (let k = periods.keyOf(data.first); k < key; k = addMonths(k, 1)) {
    const start = periods.start(k);
    if (firstDay > dayNum(start) + COVER_SLACK) continue; // data starts mid-period
    const len = Math.max(1, periods.length(k));
    const pre = new Float64Array(len + 1);
    let any = false;
    let d = start;
    for (let i = 0; i < len; i++) {
      pre[i + 1] = pre[i] + (data.everyday.get(d) || 0);
      if (data.seen.has(d)) any = true;
      d = addDays(d, 1);
    }
    if (any) out.push({ key: k, start, end: periods.end(k), len, pre }); // no rows at all: a gap in the data
  }
  return out;
}

/**
 * End-of-period balances (sorted) for `runs` simulations of `days` days.
 * Day 1 is today: what was already spent today is in the balance, so it only
 * costs more when the simulated day ends up costing more.
 */
function simulate(hist, { days, start, spentToday, bills, card, runs, rng }) {
  const out = new Float64Array(runs);
  const n = hist.length;
  for (let r = 0; r < runs; r++) {
    let spend = 0;
    for (let b = 0; b < days; b += BLOCK) {
      const len = Math.min(BLOCK, days - b);
      const h = hist[Math.floor(rng() * n)];
      // The same distance from payday in that period, give or take JITTER days.
      let s = h.len - days + b + Math.floor(rng() * (2 * JITTER + 1)) - JITTER;
      if (s > h.len - len) s = h.len - len;
      if (s < 0) s = 0;
      spend += h.pre[Math.min(s + len, h.len)] - h.pre[s];
      if (b === 0) spend -= Math.min(h.pre[s + 1] - h.pre[s], spentToday);
    }
    let due = 0;
    for (const it of bills) due += it.min + rng() * (it.max - it.min);
    if (card) due += card.min + rng() * (card.max - card.min);
    out[r] = start - due - spend;
  }
  return out.sort();
}

// The bank balance at the end of `date`: today's balance minus the money that moved after it.
function balanceAt(net, balance, date) {
  let b = balance;
  for (const [d, v] of net) if (d > date) b -= v;
  return b;
}

/**
 * Track record: for each of the last BACKTEST complete periods, the model run at
 * the same number of days before payday as today, with only the periods before
 * it. A hit = the real end-of-period balance fell inside p10..p90. Bills and
 * card repayments of that stretch are taken as known (as `upcoming` is now).
 */
function backtest(hist, data, { balance, daysLeft, seed }) {
  let tested = 0;
  let hits = 0;
  const from = Math.max(0, hist.length - BACKTEST);
  for (let i = from; i < hist.length; i++) {
    const before = hist.slice(Math.max(0, i - MAX_PERIODS), i);
    if (before.length < MIN_PERIODS) continue;
    const h = hist[i];
    const days = Math.min(daysLeft, h.len);
    const day = addDays(h.end, -(days - 1));
    let known = 0;
    for (const [d, v] of data.fixed) if (d > day && d <= h.end) known += v;
    const sim = simulate(before, {
      days,
      start: balanceAt(data.net, balance, day) - known,
      spentToday: data.everyday.get(day) || 0,
      bills: [],
      card: null,
      runs: BACKTEST_RUNS,
      rng: mulberry32(seed + 7919 * (i + 1)),
    });
    const actual = balanceAt(data.net, balance, h.end);
    tested += 1;
    if (actual >= quantile(sim, 0.1) - 0.5 && actual <= quantile(sim, 0.9) + 0.5) hits += 1;
  }
  return tested >= MIN_PERIODS ? { periods: tested, hits } : null;
}

const amountText = (n) => (Math.abs(n) >= 1 ? Math.round(Math.abs(n)).toLocaleString('ro-RO') : round2(Math.abs(n)).toFixed(2));

/**
 * → { status: 'ok'|'learning'|'unsure', probability (0..1, chance the
 * end-of-period balance >= threshold), p10, p50, p90 (whole RON), daysLeft,
 * threshold, history: { periods, hits } | null, reason }.
 * 'learning': fewer than 3 complete periods of data (numbers are null);
 * 'unsure': the main account doesn't match the bank (numbers still given).
 * upcoming: bills still due ([{ min, max, date? }], e.g. recurring.upcoming);
 * cardDue: { min, max, date? } | null; extraSpend: a purchase being considered.
 * series (optional): recurring.detectSeries(state, { today, accountOf }) when
 * already worked out — detecting them is most of the cost.
 */
export function paydayOdds(state, {
  ledger, periods, today = todayISO(), balance, upcoming = [], cardDue = null,
  threshold = 0, extraSpend = 0, runs = 2000, seed = 1, series = null,
} = {}) {
  const st = {
    ...(state || {}),
    categories: Array.isArray(state?.categories) ? state.categories : DEFAULT_CATEGORIES,
    transactions: Array.isArray(state?.transactions) ? state.transactions : [],
  };
  const day = ISO_RE.test(today || '') ? today : todayISO();
  const led = ledger || makeLedger(st);
  const per = periods || makePeriods({ payday: st.settings?.payday, transactions: st.transactions, overrides: st.settings?.paydays || {} });
  const key = per.keyOf(day);
  const end = per.end(key);
  const daysLeft = Math.max(1, per.daysLeft(key, day));
  const limit = round2(num(threshold));
  const extra = Math.max(0, num(extraSpend));
  const n = Math.min(Math.max(Math.round(num(runs, 2000)), 100), 20000);
  const seedN = Math.round(num(seed, 1));
  const unit = per.payday ? 'pay periods' : 'months';
  const blank = { probability: null, p10: null, p50: null, p90: null, daysLeft, threshold: limit, history: null };

  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    return { status: 'learning', ...blank, reason: 'Waiting for the main account’s balance from the bank.' };
  }
  const seriesList = Array.isArray(series) ? series : detectSeries(st, { today: day, accountOf: led.accountOf });
  const data = collect(st, led, day, seriesList);
  const all = pastPeriods(per, key, data);
  if (all.length < MIN_PERIODS) {
    return { status: 'learning', ...blank, reason: `Still learning your spending: ${all.length} of ${MIN_PERIODS} full ${unit} so far.` };
  }

  const inPeriod = (date) => !date || !ISO_RE.test(date) || date <= end;
  const bills = (Array.isArray(upcoming) ? upcoming : []).filter((u) => u && inPeriod(u.date)).map(range).filter(Boolean);
  const card = cardDue && inPeriod(cardDue.date) ? range(cardDue) : null;
  const hist = all.slice(-MAX_PERIODS);
  const sim = simulate(hist, {
    days: daysLeft,
    start: balance - extra,
    spentToday: data.everyday.get(day) || 0,
    bills,
    card,
    runs: n,
    rng: mulberry32(seedN),
  });
  let above = 0;
  for (const v of sim) if (v >= limit) above += 1;

  let status = 'ok';
  let reason = `Based on your spending in the last ${hist.length} ${unit}.`;
  const mainUid = led.mainAccount?.uid;
  const rec = mainUid ? reconcile(st, mainUid, { accountOf: led.accountOf }) : null;
  if (rec && rec.ok === false && !rec.uncertain) {
    status = 'unsure';
    reason = `${amountText(rec.diff)} RON the app can't explain`;
  }
  return {
    status,
    probability: Math.round((above / n) * 1000) / 1000,
    p10: Math.round(quantile(sim, 0.1)),
    p50: Math.round(quantile(sim, 0.5)),
    p90: Math.round(quantile(sim, 0.9)),
    daysLeft,
    threshold: limit,
    history: backtest(all, data, { balance, daysLeft, seed: seedN }),
    reason,
  };
}

const lei = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('ro-RO')}`;

/** One short line: "87% chance to reach payday with at least 300 RON · likely 410–920 RON". */
export function oddsText(r) {
  if (!r) return '';
  if (r.status === 'learning' || typeof r.probability !== 'number') return r.reason || 'Still learning your spending.';
  let pct = Math.round(r.probability * 100);
  if (pct === 100 && r.probability < 1) pct = 99;
  if (pct === 0 && r.probability > 0) pct = 1;
  const goal = r.threshold ? `with at least ${lei(r.threshold)} RON` : 'without running out';
  let likely;
  if (Math.round(r.p10) === Math.round(r.p90)) likely = `${lei(r.p10)} RON`;
  else likely = r.p10 < 0 ? `${lei(r.p10)} to ${lei(r.p90)} RON` : `${lei(r.p10)}–${lei(r.p90)} RON`;
  const line = `${pct}% chance to reach payday ${goal} · likely ${likely}`;
  return r.status === 'unsure' ? `${line} · unsure: ${r.reason}` : line;
}
