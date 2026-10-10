// Subscriptions and bills found from repeating payments (recurring.js), "safe to
// spend" until payday and the period calendar (safespend.js), and the alerts
// built from them (alerts.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../lib/store.js';
import { detectSeries, upcoming } from '../public/js/shared/recurring.js';
import { safeToSpend, periodCalendar } from '../public/js/shared/safespend.js';
import { buildAlerts } from '../public/js/shared/alerts.js';

let n = 0;
const tx = (o) => ({ id: `t${++n}`, source: 'bank', accountId: 'cur', type: 'expense', createdAt: '2026-01-01T00:00:00Z', ...o });
const charges = (description, category, rows) => rows.map(([date, amount]) => tx({ date, amount, description, category }));
function stateWith(transactions, extra = {}) {
  const s = emptyState();
  s.transactions = transactions;
  return Object.assign(s, extra);
}

test('a monthly subscription is found, with its next date', () => {
  const s = stateWith(charges('NETFLIX.COM', 'Subscriptions', [['2026-07-05', 49.99], ['2026-08-05', 49.99], ['2026-09-05', 49.99]]));
  const [x] = detectSeries(s, { today: '2026-09-20' });
  assert.equal(x.key, 'netflix com');
  assert.equal(x.cadence, 'monthly');
  assert.equal(x.amount, 49.99);
  assert.equal(x.variable, false);
  assert.equal(x.nextDate, '2026-10-05');
  assert.equal(x.status, 'suggested');
  assert.equal(x.priceChange, null);
});

test('a price rise is reported', () => {
  const s = stateWith(charges('SPOTIFY', 'Subscriptions', [['2026-07-03', 23.99], ['2026-08-03', 23.99], ['2026-09-03', 26.99]]));
  const [x] = detectSeries(s, { today: '2026-09-10' });
  assert.deepEqual(x.priceChange, { from: 23.99, to: 26.99, pct: 12.5, date: '2026-09-03' });
});

test('a variable bill (electricity) gives a min..max range', () => {
  const s = stateWith(charges('ENEL ENERGIE', 'Utilities', [['2026-06-20', 180], ['2026-07-21', 140], ['2026-08-20', 210], ['2026-09-19', 160]]));
  const [x] = detectSeries(s, { today: '2026-09-25' });
  assert.equal(x.variable, true);
  assert.equal(x.min, 140, 'over the last 3 bills');
  assert.equal(x.max, 210);
  assert.equal(x.priceChange, null, 'a varying bill has no "price rise"');
});

test('yearly renewals and weekly fixed payments; grocery runs are not subscriptions', () => {
  const yearly = stateWith(charges('ADOBE SYSTEMS', 'Subscriptions', [['2024-10-12', 600], ['2025-10-12', 620]]));
  assert.equal(detectSeries(yearly, { today: '2027-05-01' })[0]?.cadence, undefined, 'not renewed for 1.5 years + 10 days: cancelled');
  const renewed = stateWith(charges('ADOBE SYSTEMS', 'Subscriptions', [['2024-10-12', 600], ['2025-10-12', 600]]));
  assert.equal(detectSeries(renewed, { today: '2026-05-01' })[0].cadence, 'yearly');
  assert.equal(detectSeries(renewed, { today: '2026-05-01' })[0].nextDate, '2026-10-12');
  const weekly = stateWith(charges('GYM PASS', 'Personal care', [['2026-09-01', 30], ['2026-09-08', 30], ['2026-09-15', 30], ['2026-09-22', 30]]));
  assert.equal(detectSeries(weekly, { today: '2026-09-25' })[0].cadence, 'weekly');
  const shop = [];
  for (let d = 1; d <= 28; d += 3) shop.push([`2026-09-${String(d).padStart(2, '0')}`, 80 + d]);
  for (let d = 2; d <= 28; d += 3) shop.push([`2026-08-${String(d).padStart(2, '0')}`, 70 + d]);
  assert.deepEqual(detectSeries(stateWith(charges('KAUFLAND 1234', 'Groceries', shop)), { today: '2026-09-29' }), []);
});

test('transfers, goal money, voucher rows and unconverted rows are never subscriptions', () => {
  const rows = [
    ...charges('Rata card', 'Credit card repayment', [['2026-07-10', 500], ['2026-08-10', 500], ['2026-09-10', 500]]),
    ...charges('Savings', 'Savings', [['2026-07-10', 100], ['2026-08-10', 100], ['2026-09-10', 100]]).map((t) => ({ ...t, goalId: 'g' })),
    ...charges('Lunch place', 'Eating out', [['2026-07-10', 40], ['2026-08-10', 40], ['2026-09-10', 40]]).map((t) => ({ ...t, pocket: 'vouchers' })),
  ];
  assert.deepEqual(detectSeries(stateWith(rows), { today: '2026-09-20' }), []);
});

test('upcoming: due dates in the window, a late one, ignored series skipped', () => {
  const s = stateWith([
    ...charges('NETFLIX.COM', 'Subscriptions', [['2026-07-05', 49.99], ['2026-08-05', 49.99], ['2026-09-05', 49.99]]),
    ...charges('DIGI RCS', 'Utilities', [['2026-07-15', 60], ['2026-08-15', 60], ['2026-09-15', 60]]),
  ], { settings: { recurring: { 'digi rcs': 'ignored' } } });
  const series = detectSeries(s, { today: '2026-10-07' });
  const due = upcoming(series, '2026-10-07', '2026-11-09');
  assert.deepEqual(due.map((u) => [u.key, u.date, u.late]), [['netflix com', '2026-10-07', true], ['netflix com', '2026-11-05', false]]);
  assert.ok(!due.some((u) => u.key === 'digi rcs'), 'ignored');
});

test('safe to spend: balance minus what is still due, as a range and per day', () => {
  const r = safeToSpend({
    balance: 2000, today: '2026-10-01', periodEnd: '2026-10-10',
    upcoming: [{ label: 'Rent', date: '2026-10-05', min: 1000, max: 1000 }, { label: 'Electricity', date: '2026-10-08', min: 150, max: 250 }, { label: 'Later', date: '2026-10-20', min: 99, max: 99 }],
    cardDue: { min: 300, max: 400, date: '2026-10-09' }, plannedSaving: 100, buffer: 50,
  });
  assert.equal(r.low, 2000 - 1000 - 250 - 400 - 100 - 50);
  assert.equal(r.high, 2000 - 1000 - 150 - 300 - 100 - 50);
  assert.equal(r.daysLeft, 10);
  assert.equal(r.perDayLow, 20);
  assert.equal(r.perDayHigh, 40);
  assert.equal(r.items.length, 5, 'the bill after payday is left out');
  assert.equal(safeToSpend({ balance: null, today: '2026-10-01', periodEnd: '2026-10-10' }), null);
  const short = safeToSpend({ balance: 100, today: '2026-10-01', periodEnd: '2026-10-02', upcoming: [{ label: 'Rent', date: '2026-10-02', min: 500, max: 500 }] });
  assert.equal(short.low, -400);
  assert.equal(short.perDayLow, 0, 'per day never goes below zero');
});

test('period calendar: sorted, salary last on payday, refunds and card included', () => {
  const events = periodCalendar({
    today: '2026-10-01', periodEnd: '2026-10-09', nextPayday: '2026-10-10',
    upcoming: [{ label: 'Rent', date: '2026-10-05', min: 1000, max: 1000 }],
    cardDue: { min: 300, max: 300, date: '2026-10-03' },
    refunds: [{ date: '2026-10-04', label: 'Refund: eMAG', amount: 120 }],
  });
  assert.deepEqual(events.map((e) => [e.date, e.kind]), [['2026-10-03', 'card'], ['2026-10-04', 'refund'], ['2026-10-05', 'bill'], ['2026-10-10', 'salary']]);
});

function bankState() {
  const s = emptyState();
  s.settings.payday = 10;
  s.bank.lastSync = '2026-10-10T08:00:00Z';
  s.bank.connections = [{ sessionId: 'x', bank: 'ING', validUntil: '2026-10-20T10:00:00Z', accounts: [
    { uid: 'cur', iban: 'RO00INGB0000999900005340', currency: 'RON', kind: 'current', balance: { amount: 900, currency: 'RON', type: 'CLBD' } },
  ] }];
  return s;
}

test('alerts: consent running out, price rise, late refund, bills above the balance', () => {
  const s = bankState();
  s.transactions = [
    ...charges('NETFLIX.COM', 'Subscriptions', [['2026-07-05', 49.99], ['2026-08-05', 49.99], ['2026-09-05', 49.99], ['2026-10-05', 54.99]]),
    ...charges('LANDLORD SRL', 'Housing', [['2026-07-12', 1500], ['2026-08-12', 1500], ['2026-09-12', 1500]]),
    tx({ date: '2026-10-01', amount: 120, description: 'EMAG order', category: 'Shopping', refundDue: '2026-10-08' }),
  ];
  const alerts = buildAlerts(s, { today: '2026-10-10', now: Date.parse('2026-10-10T09:00:00Z') });
  const kinds = alerts.map((a) => a.kind);
  for (const k of ['consent', 'price', 'refund', 'low', 'bill']) assert.ok(kinds.includes(k), `has ${k}: ${kinds}`);
  assert.equal(alerts[0].level, 'critical', 'most urgent first');
  const low = alerts.find((a) => a.kind === 'low');
  assert.match(low.title, /more than your balance/);
  assert.equal(new Set(alerts.map((a) => a.id)).size, alerts.length, 'ids are unique');
  assert.ok(alerts.every((a) => a.link.startsWith('#')));
});

test('alerts: kinds switched off in settings are left out; nothing linked, nothing about the bank', () => {
  const s = bankState();
  s.settings.alerts = { consent: false };
  assert.ok(!buildAlerts(s, { today: '2026-10-10', now: Date.parse('2026-10-10T09:00:00Z') }).some((a) => a.kind === 'consent'));
  const empty = emptyState();
  assert.deepEqual(buildAlerts(empty, { today: '2026-10-10' }), []);
});
