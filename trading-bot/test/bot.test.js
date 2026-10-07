import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../lib/bot.js';
import { StateStore } from '../lib/state.js';

const MIN = 60e3;
const T0 = Date.parse('2026-10-07T08:00:00Z'); // 10:00 in Frankfurt

// 40 falling candles, plus the one still in progress that IG also returns.
const history = Array.from({ length: 41 }, (_, i) => {
  const p = 200 - i;
  return { time: T0 + i * MIN, open: p, high: p + 1, low: p - 1, close: p };
});

function fakeClient() {
  const c = {
    orders: [],
    closed: [],
    positions: [],
    equityValue: 1000,
    price: 161,
    status: 'TRADEABLE',
    login: async () => {},
    market: async () => ({ bid: c.price - 0.5, offer: c.price + 0.5, status: c.status, currency: 'EUR', minSize: 0.5, minStop: 5, minStopUnit: 'POINTS', decimals: 1 }),
    candles: async () => history.map((h) => ({ ...h })),
    equity: async () => c.equityValue,
    openPositions: async () => c.positions,
    openMarket: async (o) => { c.orders.push(o); c.positions = [{ dealId: 'D', direction: o.direction, size: o.size }]; return { level: c.price }; },
    closePosition: async (p) => { c.closed.push(p); c.positions = []; },
  };
  return c;
}

function makeBot(client, opts = {}) {
  const bot = new Bot({ client, epic: 'E', resolution: 'MINUTE', size: 1, maxDailyLoss: 100, log: () => {}, ...opts });
  bot.clock = T0 + 40 * MIN + 30e3; // half way through the in-progress candle
  bot.now = () => bot.clock;
  return bot;
}

// One poll at the start of each minute, price rising 2 per minute.
async function runUp(bot, client, minutes) {
  for (let i = 0; i < minutes; i++) {
    bot.clock = T0 + (41 + i) * MIN;
    client.price = 161 + i * 2;
    await bot.tick();
  }
}

test('drops the in-progress history candle and skips the first partial live one', async () => {
  const client = fakeClient();
  const bot = makeBot(client);
  await bot.start();
  assert.equal(bot.candles.length, 40);
  bot.clock = T0 + 40 * MIN + 40e3; // a tick inside the partial minute 40
  await bot.tick();
  await runUp(bot, client, 3);
  // Minute 40 (seen only from mid-way) is skipped; 41 and 42 are complete.
  assert.deepEqual(bot.candles.slice(-3).map((c) => (c.time - T0) / MIN), [39, 41, 42]);
});

test('opens one BUY with a stop at least the market minimum', async () => {
  const client = fakeClient();
  const bot = makeBot(client);
  await bot.start();
  await runUp(bot, client, 30);
  assert.equal(client.orders.length, 1);
  assert.equal(client.orders[0].direction, 'BUY');
  assert.ok(client.orders[0].stopDistance >= 5);
});

test('daily loss limit closes positions, halts, and survives a restart', async () => {
  const client = fakeClient();
  const state = new StateStore(null);
  const bot = makeBot(client, { state });
  await bot.start();
  await runUp(bot, client, 30);
  assert.equal(client.orders.length, 1);
  client.equityValue = 850;
  await bot.tick();
  assert.equal(bot.risk.halted, true);
  assert.equal(client.closed.length, 1);

  const again = makeBot(client, { state });
  await again.start();
  assert.equal(again.risk.halted, true);
  client.equityValue = 850;
  await runUp(again, client, 30);
  assert.equal(client.orders.length, 1);
});

test('a candle closed while the market was shut does not trigger a trade later', async () => {
  const client = fakeClient();
  const bot = makeBot(client);
  await bot.start();
  await runUp(bot, client, 20);
  const before = client.orders.length;
  client.status = 'CLOSED';
  bot.clock += 3 * 24 * 60 * MIN; // weekend
  await bot.tick();
  assert.equal(client.orders.length, before);
});

test('stops trading after an order whose outcome is unknown', async () => {
  const client = fakeClient();
  client.openMarket = async () => { throw Object.assign(new Error('lost'), { code: 'UNKNOWN_ORDER_STATE' }); };
  const bot = makeBot(client);
  await bot.start();
  await runUp(bot, client, 30);
  assert.equal(bot.stopped, true);
});

test('rejects a size below the IG minimum and non-point stop units', async () => {
  await assert.rejects(makeBot(fakeClient(), { size: 0.1 }).start(), /minimum/);
  const client = fakeClient();
  const m = client.market;
  client.market = async () => ({ ...(await m()), minStopUnit: 'PERCENTAGE' });
  await assert.rejects(makeBot(client).start(), /PERCENTAGE/);
});

test('closes positions at the end of the session and caps trades per day', async () => {
  const client = fakeClient();
  const bot = makeBot(client, { maxTradesPerDay: 1 });
  await bot.start();
  await runUp(bot, client, 30);
  assert.equal(client.orders.length, 1);
  bot.clock = Date.parse('2026-10-07T15:31:00Z'); // 17:31 in Frankfurt
  await bot.tick();
  assert.equal(client.closed.length, 1);
  assert.equal(bot.risk.trades, 1);
});

test('level-based signals become distances from the live price', async () => {
  const client = fakeClient();
  let fired = false;
  const signal = () => (fired ? null : ((fired = true), { side: 'BUY', stopLevel: 150, targetR: 2, reason: 'test' }));
  const bot = makeBot(client, { signal });
  await bot.start();
  await runUp(bot, client, 3);
  assert.equal(client.orders.length, 1);
  const o = client.orders[0];
  // offer = price + 0.5 at the time of the order
  assert.ok(o.stopDistance > 10 && Math.abs(o.limitDistance - 2 * o.stopDistance) < 0.2);
});

test('no new trades outside the trading window', async () => {
  const client = fakeClient();
  const bot = makeBot(client, { tradeFrom: '18:00', tradeUntil: '19:00' });
  await bot.start();
  await runUp(bot, client, 30);
  assert.equal(client.orders.length, 0);
});
