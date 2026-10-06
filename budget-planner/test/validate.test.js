import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanTransaction, cleanGoal, cleanSettings, cleanCategories, isDate } from '../lib/validate.js';
import { round2, addMonths, daysInMonth, monthKey } from '../public/js/shared/money.js';
import { parseDate } from '../public/js/shared/csv.js';

const base = { type: 'expense', amount: 10, date: '2026-09-14' };

test('cleanTransaction: amounts are positive, rounded and parsed', () => {
  assert.equal(cleanTransaction({ ...base, amount: 0.1 + 0.2 }).amount, 0.3);
  assert.equal(cleanTransaction({ ...base, amount: -12.345 }).amount, 12.35);
  assert.equal(cleanTransaction({ ...base, amount: '12,50' }).amount, 12.5);
  for (const amount of [0, 'abc', NaN, null]) {
    assert.throws(() => cleanTransaction({ ...base, amount }), { status: 400 }, `rejects ${amount}`);
  }
});

test('cleanTransaction: dates must be real calendar dates', () => {
  assert.throws(() => cleanTransaction({ ...base, date: '2026-02-31' }), { status: 400 });
  assert.throws(() => cleanTransaction({ ...base, date: '14.09.2026' }), { status: 400 });
  assert.equal(cleanTransaction({ ...base, date: '2028-02-29' }).date, '2028-02-29');
});

test('cleanTransaction: text is truncated and ids type-checked', () => {
  const t = cleanTransaction({ ...base, description: 'x'.repeat(500), note: 'y'.repeat(500) });
  assert.equal(t.description.length, 140);
  assert.equal(t.note.length, 280);
  assert.throws(() => cleanTransaction({ ...base, goalId: { $ne: 1 } }), { status: 400 });
  assert.equal(cleanTransaction({ ...base, goalId: '' }).goalId, null);
});

test('cleanTransaction: a bank transaction keeps its account', () => {
  const existing = { ...base, source: 'bank', accountId: 'bank-acc' };
  assert.equal(cleanTransaction({ accountId: 'other' }, existing).accountId, 'bank-acc');
  assert.equal(cleanTransaction({ ...base, accountId: 'manual-acc' }).accountId, 'manual-acc');
});

test('cleanGoal: needs a name and a positive target', () => {
  assert.throws(() => cleanGoal({ name: 'Car', target: 0 }), { status: 400 });
  assert.throws(() => cleanGoal({ name: '', target: 100 }), { status: 400 });
  assert.throws(() => cleanGoal({ name: 'Car', target: 100, deadline: '2026-13-01' }), { status: 400 });
  const g = cleanGoal({ name: ' Car ', target: '1.000,50', priority: 'urgent' });
  assert.deepEqual([g.name, g.target, g.priority, g.initialSaved], ['Car', 1000.5, 'medium', 0]);
});

test('cleanSettings: only known settings, with valid values', () => {
  assert.deepEqual(cleanSettings({ planIntensity: 'gentle', countMode: 'all', payday: 10 }), { planIntensity: 'gentle', countMode: 'all', payday: 10 });
  assert.deepEqual(cleanSettings({ payday: null }), { payday: null });
  assert.deepEqual(cleanSettings({ ownTransfersFixed: false, importsDeduped: false, junk: 'x'.repeat(1000) }), {}, 'internal flags are ignored');
  assert.throws(() => cleanSettings({ planIntensity: 'extreme' }), { status: 400 });
  assert.throws(() => cleanSettings({ payday: 31 }), { status: 400 });
  assert.throws(() => cleanSettings({ paydays: { '2026-09': '2026-09-31' } }), { status: 400 });
  assert.throws(() => cleanSettings([]), { status: 400 });
  assert.deepEqual(cleanSettings({ paydays: { '2026-09': '2026-09-12' } }).paydays, { '2026-09': '2026-09-12' });
});

test('cleanCategories: unknown roles are dropped', () => {
  const [c] = cleanCategories([{ name: 'Savings', kind: 'both', role: 'savings' }]);
  assert.equal(c.role, 'savings');
  const [d] = cleanCategories([{ name: 'X', kind: 'weird', role: { evil: true } }]);
  assert.equal(d.role, undefined);
  assert.equal(d.kind, 'expense');
  assert.throws(() => cleanCategories('nope'), { status: 400 });
});

test('isDate', () => {
  assert.ok(isDate('2026-10-06'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate(20261006));
});

test('money and date helpers', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-2.675), -2.67);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(monthKey('2026-10-06'), '2026-10');
});

test('parseDate rejects impossible dates', () => {
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseDate('05.03.2026'), '2026-03-05', 'dd.mm.yyyy');
});
