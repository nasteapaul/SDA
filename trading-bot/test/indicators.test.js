import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr } from '../lib/indicators.js';

test('sma averages the last N values', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test('ema seeds with sma and then smooths', () => {
  const out = ema([1, 2, 3, 4], 3);
  assert.equal(out[1], null);
  assert.equal(out[2], 2);
  assert.equal(out[3], 3); // 4*0.5 + 2*0.5
});

test('rsi is 100 for a steady rise and 0 for a steady fall', () => {
  const up = Array.from({ length: 20 }, (_, i) => i);
  assert.equal(rsi(up, 14).at(-1), 100);
  assert.equal(rsi(up.toReversed(), 14).at(-1), 0);
  assert.equal(rsi(up, 14)[13], null);
});

test('atr equals the constant range of identical candles', () => {
  const c = Array.from({ length: 20 }, (_, i) => ({ time: i, open: 10, high: 11, low: 9, close: 10 }));
  assert.equal(atr(c, 14).at(-1), 2);
});
