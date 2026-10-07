import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, CandleBuilder, validateCandle } from '../lib/candles.js';

test('parseCsv reads columns by header and sorts by time', () => {
  const csv = 'Time,Open,High,Low,Close,Volume\n2026-01-02T00:00:00Z,2,3,1,2,9\n1767225600,1,2,0.5,1.5,9\n';
  const c = parseCsv(csv);
  assert.equal(c.length, 2);
  assert.equal(c[0].time, 1767225600000);
  assert.equal(c[1].close, 2);
});

test('parseCsv rejects missing columns and impossible candles', () => {
  assert.throws(() => parseCsv('time,open,high,close\n1,1,1,1'), /low/);
  assert.throws(() => parseCsv('time,open,high,low,close\n1,5,4,3,4'), /line 2/);
  assert.equal(validateCandle({ time: 1, open: 1, high: 1, low: 1, close: NaN }), false);
});

test('CandleBuilder closes a candle when a new period starts', () => {
  const closed = [];
  const b = new CandleBuilder(60_000, (c) => closed.push(c));
  b.push({ time: 0, price: 10 });
  b.push({ time: 10_000, price: 12 });
  b.push({ time: 20_000, price: 9 });
  b.push({ time: 30_000, price: 11 });
  assert.equal(closed.length, 0);
  b.push({ time: 61_000, price: 11.5 });
  assert.deepEqual(closed[0], { time: 0, open: 10, high: 12, low: 9, close: 11 });
  assert.equal(b.current.open, 11.5);
});
