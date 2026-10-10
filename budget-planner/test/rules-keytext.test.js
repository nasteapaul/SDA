// A rule made from a merchant key ("revolut dublin", the words the app keeps
// from "Revolut**1234* Dublin") must match the bank text it came from, so
// "Create rule" on a suggestion really categorises those transactions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../lib/store.js';
import { runMigrations } from '../lib/migrations.js';
import { categorize, merchantKey, escapeForRule, ruleMatches, keyText } from '../public/js/shared/categories.js';
import { suggestRules } from '../public/js/shared/review.js';

const rule = (keyword, category) => ({ pattern: escapeForRule(keyword), keyword, category });

test('a merchant-key rule matches text with card numbers and symbols between the words', () => {
  const t = { description: 'REVOLUT**1234* DUBLIN', note: 'Card number **** 7204', type: 'expense' };
  const key = merchantKey(`${t.description} ${t.note}`);
  assert.equal(key, 'revolut dublin');
  assert.equal(keyText(t.description), 'revolut dublin');
  assert.ok(ruleMatches(rule(key, 'Transfers'), t));
  assert.equal(categorize({ description: `${t.description} ${t.note}`, type: 'expense' }, [rule(key, 'Transfers')]), 'Transfers');
  const sandwich = { description: 'DRAGOSANDWICH 5 SANTANDREI', type: 'expense' };
  assert.ok(ruleMatches(rule(merchantKey(sandwich.description), 'Eating out'), sandwich));
  assert.ok(!ruleMatches(rule('revolut dublin', 'Transfers'), { description: 'KAUFLAND DUBLIN STREET' }));
});

test('built-in rules still match the plain text only', () => {
  assert.equal(categorize({ description: 'Plata booking.com Amsterdam', type: 'expense' }), 'Travel');
  assert.equal(categorize({ description: 'SOMETHING**1234* ELSE', type: 'expense' }), 'Other');
});

function stateWithCorrections() {
  const s = emptyState();
  const row = (id, date, category, manualCategory) => ({ id, date, category, manualCategory, type: 'expense', amount: 20, source: 'bank', description: 'DRAGOSANDWICH 5 SANTANDREI' });
  s.transactions = [row('a', '2026-09-01', 'Eating out', true), row('b', '2026-09-20', 'Eating out', true), row('c', '2026-10-05', 'Other', false)];
  return s;
}

test('after "Create rule" the suggestion is gone', () => {
  const s = stateWithCorrections();
  const [sug] = suggestRules(s);
  assert.equal(sug.keyword, 'dragosandwich santandrei');
  s.rules.push(rule(sug.keyword, sug.category));
  assert.deepEqual(suggestRules(s), []);
});

test('migration: rules created before this fix are applied again once', async () => {
  const s = stateWithCorrections();
  s.rules.push(rule('dragosandwich santandrei', 'Eating out'));
  s.settings = { ...s.settings, ownTransfersFixed: true, importsDeduped: true, importAccountsAssigned: true, duplicatesMerged: true };
  const store = { get: () => s, mutate: async (fn) => fn(s), backup: async () => null };
  const log = [];
  await runMigrations(store, (m) => log.push(m));
  assert.equal(s.transactions.find((t) => t.id === 'c').category, 'Eating out');
  assert.equal(s.settings.userRulesReapplied, true);
  assert.ok(log.some((m) => /1 transaction/.test(m)));
  log.length = 0;
  await runMigrations(store, (m) => log.push(m));
  assert.deepEqual(log, [], 'runs once');
});
