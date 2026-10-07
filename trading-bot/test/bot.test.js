import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../lib/bot.js';

// History: a downtrend, so the next rising candles produce a BUY crossover.
const history = Array.from({ length: 40 }, (_, i) => {
  const p = 200 - i;
  return { time: i * 60e3, open: p, high: p + 1, low: p - 1, close: p };
});

function fakeClient({ equity = 1000 } = {}) {
  const c = {
    orders: [],
    closed: [],
    positions: [],
    equityValue: equity,
    price: 161,
    login: async () => {},
    market: async () => ({ bid: c.price - 0.5, offer: c.price + 0.5, status: 'TRADEABLE', currency: 'EUR', minSize: 0.5, minStop: 5 }),
    candles: async () => history.map((h) => ({ ...h })),
    equity: async () => c.equityValue,
    openPositions: async () => c.positions,
    openMarket: async (o) => { c.orders.push(o); c.positions = [{ dealId: 'D', direction: o.direction, size: o.size }]; return { level: c.price }; },
    closePosition: async (p) => { c.closed.push(p); c.positions = []; },
  };
  return c;
}

async function runUp(bot, client, start, candles) {
  for (let i = 0; i < candles; i++) {
    client.price = 161 + i * 2;
    bot.now = () => start + i * 60e3;
    await bot.tick();
  }
}

test('opens one BUY with a stop at least the market minimum', async () => {
  const client = fakeClient();
  const bot = new Bot({ client, epic: 'E', resolution: 'MINUTE', size: 1, maxDailyLoss: 100, log: () => {}, now: () => 0 });
  await bot.start();
  await runUp(bot, client, 40 * 60e3, 30);
  assert.equal(client.orders.length, 1);
  assert.equal(client.orders[0].direction, 'BUY');
  assert.ok(client.orders[0].stopDistance >= 5);
});

test('does not trade after the daily loss limit is hit', async () => {
  const client = fakeClient();
  const bot = new Bot({ client, epic: 'E', resolution: 'MINUTE', size: 1, maxDailyLoss: 100, log: () => {}, now: () => 0 });
  await bot.start();
  client.equityValue = 850;
  await runUp(bot, client, 40 * 60e3, 30);
  assert.equal(client.orders.length, 0);
  assert.equal(bot.halted, true);
});

test('rejects a size below the IG minimum', async () => {
  const bot = new Bot({ client: fakeClient(), epic: 'E', size: 0.1, maxDailyLoss: 100, log: () => {} });
  await assert.rejects(bot.start(), /minimum/);
});
