import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrendBot, coinbaseDays } from '../lib/papertrend.js';
import { StateStore } from '../lib/state.js';

const DAY = 86400e3;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const MKT = [{ key: 'BTC', name: 'Bitcoin', product: 'BTC-USD', fundingYr: 0 }];

// `n` quiet days around 100 (high 101, low 99, ATR 2), then days given as [open, high, low, close].
function days(n, bars = []) {
  const out = [];
  const push = (open, high, low, close) => {
    const time = T0 + out.length * DAY;
    out.push({ time, day: new Date(time).toISOString().slice(0, 10), open, high, low, close });
  };
  for (let i = 0; i < n; i++) push(100, 101, 99, 100);
  for (const b of bars) push(...b);
  return out;
}

function bot(history, extra = {}) {
  const msgs = [];
  const state = new StateStore(null);
  const b = new PaperTrendBot({ markets: MKT, state, log: (m) => msgs.push(m), getDays: async () => history, ...extra });
  return { b, msgs, state };
}

test('opens a paper buy on a breakout close, with a 3 × ATR stop', async () => {
  const h = days(55, [[100, 106, 100, 105]]);
  const { b, msgs } = bot(h);
  await b.run();
  const pos = b.data.markets.BTC.pos;
  assert.equal(pos.side, 'BUY');
  assert.equal(pos.entry, 105);
  assert.equal(pos.stop, 99);
  assert.match(msgs[0], /Pe hârtie: cumpăr Bitcoin la 105/);
});

test('a hit stop closes at the stop (minus slippage) and no new trade that day', async () => {
  const h = days(55, [[100, 106, 100, 105], [104, 104, 90, 92]]);
  const { b, msgs } = bot(h, { startDay: h[55].day });
  await b.run();
  const st = b.data.markets.BTC;
  assert.equal(st.pos, null);
  assert.equal(st.trades.length, 1);
  // exit 99 × 0.9995 = 98.9505; pnl = -6.0495 - 0.105 spread; risk 6
  assert.equal(st.trades[0].r, -1.03);
  assert.match(msgs[1], /stop atins.*-1\.03R/);
  assert.equal(msgs.length, 2, 'the close below the 50-day range is not taken on the exit day');
});

test('a run with no new completed day does nothing; a later run catches up missed days', async () => {
  const h = days(55, [[100, 106, 100, 105]]);
  const { b, msgs } = bot(h);
  await b.run();
  await b.run();
  assert.equal(msgs.length, 1);
  h.push({ time: h.at(-1).time + DAY, day: '2026-09-26', open: 105, high: 110, low: 104, close: 109 });
  h.push({ time: h.at(-1).time + DAY, day: '2026-09-27', open: 109, high: 109, low: 96, close: 97 });
  await b.run();
  assert.equal(b.data.markets.BTC.lastDay, '2026-09-27');
  assert.equal(b.data.markets.BTC.trades.length, 1);
});

test('exits a buy at the close when the trend turns', async () => {
  const h = days(55, [[100, 106, 100, 105], [104, 104, 100, 98.5]]);
  const { b } = bot(h, { startDay: h[55].day });
  // stop is 99 and the low of 100 stays above it; the close 98.5 breaks the 20-day low (99)
  await b.run();
  const t = b.data.markets.BTC.trades[0];
  assert.equal(t.exit, 98.5);
  assert.equal(t.r, Math.round(((98.5 - 105 - 0.105) / 6) * 100) / 100);
});

test('Coinbase candles: newest first in, completed days oldest first out', async () => {
  const now = Date.parse('2026-10-25T03:00:00Z');
  const t = (s) => Date.parse(s) / 1000;
  const fakeFetch = async () => ({ ok: true, json: async () => [[t('2026-10-25'), 1, 3, 2, 2.5, 0], [t('2026-10-24'), 4, 6, 5, 5.5, 0], [t('2026-10-23'), 7, 9, 8, 8.5, 0]] });
  const d = await coinbaseDays('BTC-USD', now, fakeFetch);
  assert.deepEqual(d.map((x) => [x.day, x.open, x.high, x.low, x.close]), [['2026-10-23', 8, 9, 7, 8.5], ['2026-10-24', 5, 6, 4, 5.5]]);
});
