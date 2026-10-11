import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paydayOdds, oddsText } from '../public/js/shared/odds.js';
import { DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';
import { expectedPayday } from '../public/js/shared/periods.js';
import { round2, addMonths } from '../public/js/shared/money.js';
import { makeLedger } from '../public/js/shared/ledger.js';
import { detectSeries } from '../public/js/shared/recurring.js';

const TODAY = '2026-10-15'; // current pay period: 9 Oct (the 10th is a Saturday) → 9 Nov

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A steady history on one current account (…7204): salary on payday, rent two
 * days later, Netflix on the 20th, groceries and food most days.
 * → { state, balance } with balance = 1000 + every money in − out.
 */
function build({ months = 12, today = TODAY, seed = 7, extraPerDay = 0, repayments = false } = {}) {
  const rnd = lcg(seed);
  const txs = [];
  let n = 0;
  let balance = 1000;
  const add = (date, type, amount, description, category) => {
    const a = round2(amount);
    txs.push({ id: `t${++n}`, date, type, amount: a, description, category, source: 'bank', accountId: 'main', createdAt: `${date}T10:00:00.000Z` });
    balance += type === 'income' ? a : -a;
  };
  const firstKey = addMonths(today.slice(0, 7), -months);
  const paydays = new Set();
  for (let k = firstKey; k <= addMonths(today.slice(0, 7), 1); k = addMonths(k, 1)) paydays.add(expectedPayday(k, 10));
  const rentDays = new Set([...paydays].map((d) => nextDay(nextDay(d))));
  for (let d = expectedPayday(firstKey, 10); d <= today; d = nextDay(d)) {
    if (paydays.has(d)) add(d, 'income', 6000, 'SALARIU ACME SRL', 'Salary');
    if (rentDays.has(d)) add(d, 'expense', 2000, 'CHIRIE LANDLORD', 'Housing');
    if (repayments && rentDays.has(d)) add(d, 'expense', 900, 'ALIMENTARE CARD CREDIT', 'Credit card repayment');
    if (d.endsWith('-20')) add(d, 'expense', 49.99, 'NETFLIX COM', 'Subscriptions');
    if (rnd() < 0.6) add(d, 'expense', 30 + rnd() * 150, 'KAUFLAND 1234 BUCURESTI', 'Groceries');
    if (rnd() < 0.3) add(d, 'expense', 20 + rnd() * 70, 'GLOVO ORDER', 'Eating out');
    for (let i = 0; i < extraPerDay; i++) add(d, 'expense', 5 + rnd() * 20, `SHOP ${i} SRL`, 'Shopping');
  }
  const state = {
    settings: { payday: 10 },
    categories: DEFAULT_CATEGORIES,
    goals: [],
    transactions: txs,
    bank: {
      connections: [{ accounts: [{ uid: 'main', kind: 'current', iban: 'RO49INGB0000999900007204', currency: 'RON', balance: { amount: round2(balance), currency: 'RON', type: 'CLBD' } }] }],
      balanceHistory: {},
    },
  };
  return { state, balance: round2(balance) };
}

const base = build();

test('paydayOdds: same data and seed give the same answer; shape and status ok', () => {
  const a = paydayOdds(base.state, { today: TODAY, balance: base.balance, threshold: 300 });
  const b = paydayOdds(base.state, { today: TODAY, balance: base.balance, threshold: 300 });
  assert.deepEqual(a, b);
  assert.equal(a.status, 'ok');
  assert.equal(a.daysLeft, 26); // 15 Oct … 9 Nov
  assert.equal(a.threshold, 300);
  assert.ok(a.probability >= 0 && a.probability <= 1);
  assert.ok(Number.isInteger(a.p10) && Number.isInteger(a.p50) && Number.isInteger(a.p90));
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.ok(a.p90 < base.balance, 'everyday spending comes off the balance');
  assert.match(a.reason, /last 12 pay periods/);
  // The app's cached ledger and recurring series give the same answer.
  const ledger = makeLedger(base.state);
  const series = detectSeries(base.state, { today: TODAY, accountOf: ledger.accountOf });
  assert.deepEqual(paydayOdds(base.state, { ledger, series, today: TODAY, balance: base.balance, threshold: 300 }), a);
  // Another seed: a different sample, about the same answer.
  const c = paydayOdds(base.state, { today: TODAY, balance: base.balance, threshold: 300, seed: 99 });
  assert.ok(Math.abs(c.p50 - a.p50) < 0.05 * Math.abs(a.p50) + 50);
});

test('paydayOdds: more bills and a card payment lower the odds; bills after payday are ignored', () => {
  const ref = paydayOdds(base.state, { today: TODAY, balance: base.balance });
  const threshold = ref.p50; // about a coin flip
  const at = (o) => paydayOdds(base.state, { today: TODAY, balance: base.balance, threshold, ...o });
  const none = at({});
  assert.ok(none.probability > 0.3 && none.probability < 0.7, `probability ${none.probability}`);
  const bills = at({ upcoming: [{ label: 'Electricity', date: '2026-10-20', min: 150, max: 400 }] });
  assert.ok(bills.probability < none.probability);
  assert.ok(bills.p50 < none.p50);
  const more = at({ upcoming: [{ date: '2026-10-20', min: 150, max: 400 }, { date: '2026-11-01', min: 300, max: 300 }] });
  assert.ok(more.probability < bills.probability);
  const card = at({ cardDue: { min: 500, max: 900, date: '2026-10-25' } });
  assert.ok(card.probability < none.probability);
  const later = at({ upcoming: [{ date: '2026-11-20', min: 5000, max: 5000 }] });
  assert.equal(later.probability, none.probability, 'due after payday: not this period');
});

test('paydayOdds: a purchase being considered (extraSpend) lowers the odds by exactly its cost', () => {
  const ref = paydayOdds(base.state, { today: TODAY, balance: base.balance });
  const o = { today: TODAY, balance: base.balance, threshold: ref.p50 };
  const before = paydayOdds(base.state, o);
  const after = paydayOdds(base.state, { ...o, extraSpend: 400 });
  assert.ok(after.probability < before.probability);
  assert.ok(Math.abs(before.p50 - 400 - after.p50) <= 1);
  assert.ok(Math.abs(before.p10 - 400 - after.p10) <= 1);
  const ignored = paydayOdds(base.state, { ...o, extraSpend: -400 });
  assert.equal(ignored.probability, before.probability, 'negative extraSpend is ignored');
});

test('paydayOdds: card repayments and recurring bills are not everyday spending', () => {
  const withRepay = build({ repayments: true });
  const a = paydayOdds(base.state, { today: TODAY, balance: 3000 });
  const b = paydayOdds(withRepay.state, { today: TODAY, balance: 3000 });
  assert.deepEqual([b.p10, b.p50, b.p90, b.probability], [a.p10, a.p50, a.p90, a.probability]);
  // Rent (2000/month) is a detected recurring bill: 26 days of food only (~87/day), not rent on top.
  const spent = 3000 - a.p50;
  assert.ok(spent > 1800 && spent < 2800, `simulated spending ${spent}`);
});

test('paydayOdds: learning with fewer than 3 complete periods or no balance', () => {
  const young = build({ months: 2 });
  const r = paydayOdds(young.state, { today: TODAY, balance: young.balance, threshold: 300 });
  assert.equal(r.status, 'learning');
  assert.equal(r.probability, null);
  assert.equal(r.p50, null);
  assert.equal(r.history, null);
  assert.equal(r.daysLeft, 26);
  assert.match(r.reason, /2 of 3/);
  assert.equal(oddsText(r), r.reason);
  const empty = paydayOdds({ settings: {}, categories: DEFAULT_CATEGORIES, transactions: [] }, { today: TODAY, balance: 100 });
  assert.equal(empty.status, 'learning');
  const noBalance = paydayOdds(base.state, { today: TODAY });
  assert.equal(noBalance.status, 'learning');
  assert.match(noBalance.reason, /balance/);
  assert.equal(paydayOdds(undefined, { today: TODAY, balance: 10 }).status, 'learning');
});

test('paydayOdds: unsure when the main account does not match the bank (numbers still given)', () => {
  const { state, balance } = build();
  // Snapshot on 13 Oct + rows of 14–15 Oct should give today's balance; the bank has 212 RON less.
  const later = state.transactions.filter((t) => t.date > '2026-10-13');
  const flows = later.reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0);
  state.bank.balanceHistory = {
    main: [
      { date: '2026-10-13T20:00:00.000Z', amount: round2(balance - flows), pending: 0 },
      { date: '2026-10-15T20:00:00.000Z', amount: round2(balance - 212), pending: 0 },
    ],
  };
  const r = paydayOdds(state, { today: TODAY, balance: balance - 212, threshold: 300 });
  assert.equal(r.status, 'unsure');
  assert.equal(r.reason, "212 RON the app can't explain");
  assert.equal(typeof r.probability, 'number');
  assert.ok(Number.isInteger(r.p50));
  assert.match(oddsText(r), /unsure: 212 RON the app can't explain$/);
  // When it matches: ok.
  state.bank.balanceHistory.main[1].amount = balance;
  assert.equal(paydayOdds(state, { today: TODAY, balance, threshold: 300 }).status, 'ok');
});

test('paydayOdds: track record on a steady history — past ranges were mostly right', () => {
  const r = paydayOdds(base.state, { today: TODAY, balance: base.balance, threshold: 300 });
  assert.ok(r.history, 'history');
  assert.equal(r.history.periods, 6);
  assert.ok(r.history.hits >= 4, `hits ${r.history.hits}/6`);
  // Too little history to test 3 periods: null.
  const short = build({ months: 4 });
  assert.equal(paydayOdds(short.state, { today: TODAY, balance: short.balance }).history, null);
});

test('oddsText: one short line', () => {
  const ok = { status: 'ok', probability: 0.874, p10: 410, p50: 700, p90: 920, daysLeft: 10, threshold: 300, history: null, reason: '' };
  assert.equal(oddsText(ok), '87% chance to reach payday with at least 300 RON · likely 410–920 RON');
  assert.equal(oddsText({ ...ok, threshold: 0 }), '87% chance to reach payday without running out · likely 410–920 RON');
  assert.equal(oddsText({ ...ok, p10: -120 }), '87% chance to reach payday with at least 300 RON · likely −120 to 920 RON');
  assert.equal(oddsText({ ...ok, probability: 0.998 }).slice(0, 3), '99%');
  assert.equal(oddsText({ ...ok, probability: 0.002 }).slice(0, 2), '1%');
  assert.equal(oddsText(null), '');
});

test('paydayOdds: fast enough — 3,000 transactions at 2,000 runs', () => {
  const big = build({ months: 14, extraPerDay: 6, seed: 3 });
  assert.ok(big.state.transactions.length >= 3000, `${big.state.transactions.length} transactions`);
  const o = { today: TODAY, balance: big.balance, threshold: 300, runs: 2000 };
  paydayOdds(big.state, o); // warm-up (JIT)
  const t0 = performance.now();
  const r = paydayOdds(big.state, o);
  const ms = performance.now() - t0;
  assert.equal(r.status, 'ok');
  assert.ok(ms < 300, `${ms.toFixed(1)} ms`);
});
