import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest } from '../lib/backtest.js';
import { emaCrossSignals } from '../lib/strategy.js';

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

test('long trade hits take-profit and risks riskPct of equity', () => {
  const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 106, 99, 105)];
  const signals = [{ side: 'BUY', stopDist: 2, targetDist: 4 }, { side: null }];
  const r = backtest(candles, signals, { capital: 1000, riskPct: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.trades[0].why, 'take-profit');
  assert.equal(r.net, 20); // size 5 (10 risk / 2 pts) * 4 pts
});

test('stop is checked before target when both are hit in one candle', () => {
  const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 110, 90, 100)];
  const signals = [{ side: 'BUY', stopDist: 2, targetDist: 4 }, { side: null }];
  const r = backtest(candles, signals, { capital: 1000, riskPct: 1 });
  assert.equal(r.trades[0].why, 'stop-loss');
  assert.equal(r.net, -10);
});

test('spread is paid on entry and exit', () => {
  const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
  const signals = [{ side: 'SELL', stopDist: 5, targetDist: 5 }, { side: null }];
  const r = backtest(candles, signals, { capital: 1000, riskPct: 1, spread: 1 });
  assert.equal(r.trades[0].why, 'final date');
  assert.equal(r.net, -2); // size 2 * 1 point of spread
});

test('rejects invalid options', () => {
  assert.throws(() => backtest([], [], { riskPct: 0 }), /Invalid/);
});

test('emaCrossSignals emits BUY after a downtrend turns up', () => {
  const closes = [...Array.from({ length: 40 }, (_, i) => 200 - i), ...Array.from({ length: 30 }, (_, i) => 161 + i * 2)];
  const candles = closes.map((c, i) => candle(i, c, c + 1, c - 1, c));
  const sig = emaCrossSignals(candles);
  const first = sig.findIndex((s) => s.side);
  assert.ok(first > 40);
  assert.equal(sig[first].side, 'BUY');
  assert.ok(sig[first].stopDist > 0 && sig[first].targetDist > sig[first].stopDist);
});
