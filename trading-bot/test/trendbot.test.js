import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrendBot, trendSignal, atrBefore } from '../lib/trendbot.js';
import { StateStore } from '../lib/state.js';

const DAY = 86400e3;
const T0 = Date.parse('2026-08-01T00:00:00Z');

// `n` quiet days around 100 (high 101, low 99), then the given closes.
function days(n, closes = []) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: T0 + i * DAY, open: 100, high: 101, low: 99, close: 100 });
  closes.forEach((c, k) => out.push({ time: T0 + (n + k) * DAY, open: 100, high: Math.max(c, 101), low: Math.min(c, 99), close: c }));
  return out;
}

test('signals a buy when a day closes above the last 50 closes, a sell below, nothing inside', () => {
  assert.equal(trendSignal(days(55, [105]), undefined).enter, 'BUY');
  assert.equal(trendSignal(days(55, [95]), undefined).enter, 'SELL');
  assert.equal(trendSignal(days(55, [100]), undefined), null);
  assert.equal(trendSignal(days(40, [105]), undefined), null, 'needs 50 days of history');
  assert.equal(atrBefore(days(55, [105]), 55), 2);
});

test('exits a buy when the close breaks the lowest low of the 20 days before it', () => {
  assert.deepEqual(trendSignal(days(55, [98]), 'BUY'), { exit: true });
  assert.equal(trendSignal(days(55, [99.5]), 'BUY'), null);
  assert.deepEqual(trendSignal(days(55, [102]), 'SELL'), { exit: true });
});

function fakeClient(history) {
  const c = {
    accountType: 'CFD', orders: [], closed: [], positions: [], history, price: 105,
    login: async () => {},
    equity: async () => 10000,
    available: async () => 10000,
    candles: async () => c.history.map((h) => ({ ...h })),
    openPositions: async () => c.positions,
    market: async () => ({ bid: c.price - 0.5, offer: c.price + 0.5, status: 'TRADEABLE', currency: 'USD', scaling: 1, pointValue: 1, toAccount: 0.8, contractSize: 1, minSize: 0.01, minStop: 1, minStopUnit: 'PERCENTAGE', marginPct: 100, expiry: '-' }),
    openMarket: async (o) => { c.orders.push(o); c.positions = [{ dealId: 'D', direction: o.direction, size: o.size, epic: o.epic }]; return { level: c.price + 0.5 }; },
    closePosition: async (p) => { c.closed.push(p); c.positions = []; },
  };
  return c;
}

const MARKET = { key: 'BTC', name: 'Bitcoin', epic: 'BTC' };
function makeBot(client, now, state = new StateStore(null)) {
  const logs = [];
  const bot = new TrendBot({ client, markets: [MARKET], riskPct: 1, state, log: (m) => logs.push(m), now: () => now });
  return { bot, logs, state };
}

test('enters on the last completed day with a 3 × ATR stop sized to 1% of the account, once', async () => {
  // 55 quiet days, a breakout close, and today's candle still forming (ignored).
  const client = fakeClient([...days(55, [105]), { time: T0 + 56 * DAY, open: 105, high: 106, low: 104, close: 90 }]);
  const now = T0 + 56 * DAY + 3600e3;
  const { bot, state } = makeBot(client, now);
  await bot.run();
  assert.equal(client.orders.length, 1);
  const o = client.orders[0];
  assert.equal(o.direction, 'BUY');
  assert.equal(o.stopDistance, 6); // 3 × ATR of 2
  // £100 risk / (6 points × $1 × 0.8 £/$) = 20.8333 contracts
  assert.equal(o.size, 20.8333);
  await makeBot(client, now, state).bot.run();
  assert.equal(client.orders.length, 1, 'the same day is not traded twice');
});

test('closes a buy on the exit signal and does not re-enter that day', async () => {
  const client = fakeClient(days(55, [105]));
  const state = new StateStore(null);
  await makeBot(client, T0 + 56 * DAY + 3600e3, state).bot.run();
  client.history = days(55, [105, 98]);
  await makeBot(client, T0 + 57 * DAY + 3600e3, state).bot.run();
  assert.equal(client.closed.length, 1);
  assert.equal(client.orders.length, 1);
  assert.equal(state.load().markets.BTC.pos, null);
});

test('a position stopped out at IG is forgotten without a new entry that day', async () => {
  const client = fakeClient(days(55, [105]));
  const state = new StateStore(null);
  await makeBot(client, T0 + 56 * DAY + 3600e3, state).bot.run();
  client.positions = []; // stop hit
  client.history = days(55, [105, 110]); // a new high, but the trade just ended
  const { bot, logs } = makeBot(client, T0 + 57 * DAY + 3600e3, state);
  await bot.run();
  assert.equal(client.orders.length, 1);
  assert.match(logs.join('\n'), /s-a închis/);
});

test('leaves a position it did not open alone', async () => {
  const client = fakeClient(days(55, [98]));
  client.positions = [{ dealId: 'X', direction: 'BUY', size: 1, epic: 'BTC' }];
  const { bot, logs } = makeBot(client, T0 + 56 * DAY + 3600e3);
  await bot.run();
  assert.equal(client.closed.length, 0);
  assert.equal(client.orders.length, 0);
  assert.match(logs.join('\n'), /nu am deschis-o eu/);
});

test('refuses a spread-bet account', async () => {
  const client = fakeClient(days(55, [105]));
  client.accountType = 'SPREADBET';
  await assert.rejects(makeBot(client, T0 + 56 * DAY).bot.run(), /CFD accounts only/);
});
