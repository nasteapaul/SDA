import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePnl, closedTrades, dailyReport, weeklyReport, weekDays, isFriday } from '../lib/report.js';

const FRI = Date.parse('2026-10-16T15:05:00Z'); // Friday 18:05 in Romania

const tx = (dateUtc, pnl, name = 'EUR/USD Mini', type = 'DEAL') => ({ dateUtc, profitAndLoss: pnl, instrumentName: name, transactionType: type, openLevel: 1.125, closeLevel: 1.127 });

test('parsePnl reads IG amounts with currency prefixes', () => {
  assert.equal(parsePnl('E-53.87'), -53.87);
  assert.equal(parsePnl('£1,234.50'), 1234.5);
  assert.equal(parsePnl('A$12.3'), 12.3);
  assert.ok(Number.isNaN(parsePnl('')));
});

test('closedTrades keeps deals only, oldest first', () => {
  const t = closedTrades([tx('2026-10-16T15:05:25', 'E10'), tx('2026-10-16T08:39:00', 'E-5'), tx('2026-10-16T09:00:00', 'E3', 'Funding', 'WITH')]);
  assert.deepEqual(t.map((x) => x.pnl), [-5, 10]);
});

test('daily report lists each trade of the Romanian day and the total', () => {
  const trades = closedTrades([
    tx('2026-10-15T15:05:00', 'E99'), // yesterday
    tx('2026-10-16T08:39:00', 'E-165.76', 'GBP/USD Mini'),
    tx('2026-10-16T15:05:25', 'E170.10'),
    tx('2026-10-16T15:05:26', 'E134.68', 'GBP/USD Mini'),
  ]);
  const r = dailyReport(trades, FRI);
  assert.match(r, /2026-10-16: 3 tranzacții/);
  assert.match(r, /1\. GBP\/USD Mini: -165\.76 EUR/);
  assert.match(r, /3\. GBP\/USD Mini: \+134\.68 EUR/);
  assert.match(r, /Total zi: \+139\.02 EUR/);
  assert.doesNotMatch(r, /99/);
});

test('daily report says so when there was no trade', () => {
  assert.match(dailyReport([], FRI), /nicio tranzacție azi/);
});

test('weekly report counts trades from Monday, win rate and net total', () => {
  const trades = closedTrades([
    tx('2026-10-11T10:00:00', 'E500'), // last Sunday, outside the week
    tx('2026-10-14T15:00:00', 'E450'),
    tx('2026-10-15T15:00:00', 'E-100'),
    tx('2026-10-16T08:39:00', 'E-150'),
    tx('2026-10-16T15:05:00', 'E200'),
  ]);
  const r = weeklyReport(trades, FRI);
  assert.match(r, /2026-10-12 – 2026-10-16/);
  assert.match(r, /Tranzacții: 4/);
  assert.match(r, /Câștigătoare: 2 \(50%\), pierzătoare: 2 \(50%\)/);
  assert.match(r, /Total net: \+400\.00 EUR/);
});

test('week days run Monday to today in Romanian time', () => {
  assert.deepEqual(weekDays(FRI), ['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);
  assert.deepEqual(weekDays(Date.parse('2026-10-12T05:00:00Z')), ['2026-10-12']);
  // Sunday 23:30 UTC is already Monday in Romania.
  assert.deepEqual(weekDays(Date.parse('2026-10-18T23:30:00Z')), ['2026-10-19']);
  assert.ok(isFriday(FRI));
  assert.ok(!isFriday(Date.parse('2026-10-15T15:00:00Z')));
});
