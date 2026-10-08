import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berlinClock, hhmm } from '../lib/session.js';
import { parseHistData, groupDays, resample } from '../lib/history.js';
import { simulate, runDays, stats } from '../lib/daytrade.js';
import { orb, orbLive } from '../lib/strategies.js';

test('berlinClock follows daylight saving time', () => {
  assert.equal(berlinClock(Date.parse('2026-01-15T08:00:00Z')).mod, hhmm('09:00'));
  assert.equal(berlinClock(Date.parse('2026-07-15T07:00:00Z')).mod, hhmm('09:00'));
  assert.equal(berlinClock(Date.parse('2026-07-15T23:30:00Z')).day, '2026-07-16');
  assert.throws(() => hhmm('25:00'));
});

test('parseHistData reads EST timestamps as UTC-5', () => {
  const [bar] = parseHistData('20180102 030000;100;101;99;100.5;0\nnot a bar\n');
  assert.equal(bar.time, Date.parse('2018-01-02T08:00:00Z'));
  assert.equal(bar.close, 100.5);
});

// A day of 1-minute bars from 09:00 Frankfurt (winter) with the given closes.
function day(closes, date = '2026-01-15') {
  const t0 = Date.parse(`${date}T08:00:00Z`);
  const bars = closes.map((c, i) => ({ time: t0 + i * 6e4, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c), low: Math.min(c, i ? closes[i - 1] : c), close: c }));
  return groupDays(bars)[0];
}

test('resample builds 5-minute candles on the local clock', () => {
  const d = day([1, 2, 3, 4, 5, 6, 7]);
  const c5 = resample(d.bars, 5);
  assert.equal(c5.length, 2);
  assert.deepEqual([c5[0].open, c5[0].high, c5[0].low, c5[0].close, c5[0].mod], [1, 5, 1, 5, 540]);
});

test('simulate charges spread, checks the stop first and fills gaps at the open', () => {
  const bars = [
    { mod: 600, open: 100, high: 100, low: 100, close: 100 },
    { mod: 601, open: 100, high: 110, low: 95, close: 100 },
  ];
  const t = simulate(bars, { dir: 1, entryIdx: 0, stop: 97, target: 105, exitMod: 1050 });
  assert.equal(t.why, 'stop');
  assert.equal(t.points, -3 - 0.5 - 1.2);
  const gap = [bars[0], { mod: 601, open: 90, high: 91, low: 89, close: 90 }];
  assert.equal(simulate(gap, { dir: 1, entryIdx: 0, stop: 97, exitMod: 1050 }).exit, 89.5);
  const timed = simulate([bars[0], { mod: 1050, open: 102, high: 102, low: 102, close: 102 }], { dir: 1, entryIdx: 0, stop: 90, exitMod: 1050 });
  assert.equal(timed.why, 'time');
  assert.equal(timed.points, 2 - 1.2);
});

test('orb trades the first breakout of the opening range once a day', () => {
  // 15 minutes ranging 100-106, then a rally.
  const closes = [...Array.from({ length: 15 }, (_, i) => 100 + (i % 7)), ...Array.from({ length: 60 }, (_, i) => 107 + i)];
  const d = day(closes);
  const trades = runDays([d], orb({ rangeMin: 15, targetR: 2 }), { sessionSpread: 0, offSpread: 0, slippage: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].dir, 1);
  assert.equal(trades[0].why, 'target');
  assert.ok(stats(trades).avg > 0);
});

test('orbLive signals only on the candle that first closes outside the range', () => {
  const closes = [...Array.from({ length: 15 }, (_, i) => 100 + (i % 7)), 105, 108, 110, 104, 111];
  const bars = day(closes).bars;
  const sig = orbLive({ rangeMin: 15, targetR: 2 });
  assert.equal(sig(bars.slice(0, 16)), null); // still inside
  const s = sig(bars.slice(0, 17));
  assert.equal(s.side, 'BUY');
  assert.equal(s.stopLevel, 100); // other side of the range
  assert.equal(sig(bars.slice(0, 18)), null); // not the first breakout any more
  assert.equal(sig(bars.slice(0, 10)), null); // range not finished
});

test('loadBars reads a folder of CSVs and skips empty downloads', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadBars } = await import('../lib/history.js');
  const dir = mkdtempSync(join(tmpdir(), 'bars-'));
  writeFileSync(join(dir, 'a.csv'), 'timestamp,open,high,low,close\n1704096000000,1,2,0.5,1.5\n');
  writeFileSync(join(dir, 'empty.csv'), '');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const warnings = [];
  const bars = loadBars([dir], (m) => warnings.push(m));
  assert.equal(bars.length, 1);
  assert.equal(warnings.length, 1);
  assert.throws(() => loadBars([join(dir, 'empty.csv')], () => {}), /every input file is empty/);
});
