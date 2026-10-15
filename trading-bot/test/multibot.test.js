import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiBot } from '../lib/multibot.js';

const MIN = 60e3;
const OPEN = Date.parse('2026-10-13T07:00:00Z'); // 08:00 in London (BST)
const GBP = { key: 'GBPUSD', name: 'GBP/USD', tz: 'Europe/London', open: 480, close: 960, live: { epic: 'GBP', rangeMin: 60, targetR: 2 } };

// 60 range minutes between 100 and 120, then quiet minutes at 110 until `upTo`.
function rangeCandles(upTo, extra = []) {
  const out = [];
  for (let t = OPEN; t < upTo; t += MIN) {
    const inRange = t < OPEN + 60 * MIN;
    out.push({ time: t, open: 110, high: inRange && t === OPEN ? 120 : 111, low: inRange && t === OPEN + MIN ? 100 : 109, close: 110 });
  }
  return [...out, ...extra];
}

function fakeClient() {
  const c = {
    orders: [],
    closed: [],
    positions: [],
    equityValue: 10000,
    price: 110,
    history: [],
    candleCalls: 0,
    login: async () => {},
    market: async () => ({ bid: c.price - 0.5, offer: c.price + 0.5, status: 'TRADEABLE', currency: 'GBP', minSize: 0.03, minStop: 4, minStopUnit: 'POINTS', decimals: 1, expiry: 'DFB' }),
    candles: async () => { c.candleCalls++; return c.history.map((h) => ({ ...h })); },
    equity: async () => c.equityValue,
    openPositions: async () => c.positions,
    openMarket: async (o) => { c.orders.push(o); c.positions = [{ dealId: 'D', direction: o.direction, size: o.size, epic: o.epic }]; return { level: c.price }; },
    closePosition: async (p) => { c.closed.push(p); c.positions = c.positions.filter((x) => x !== p); },
  };
  return c;
}

function makeBot(client, start, opts = {}) {
  const bot = new MultiBot({ client, markets: [GBP], riskPerTrade: 50, maxDailyLoss: 150, log: () => {}, ...opts });
  bot.clock = start;
  bot.now = () => bot.clock;
  return bot;
}

// Ticks every 10 s from the bot's clock for `minutes`, with the price from priceAt(t).
async function run(bot, client, minutes, priceAt) {
  const end = bot.clock + minutes * MIN;
  for (; bot.clock < end; bot.clock += 10e3) {
    client.price = priceAt(bot.clock);
    await bot.tick();
  }
}

test('buys the first close above the opening range with stop at its low and a 2R target', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN - 20 * MIN);
  await bot.start();
  assert.equal(bot.hasWork(), true);
  client.history = rangeCandles(OPEN + 60 * MIN);
  const breakAt = OPEN + 63 * MIN;
  await run(bot, client, 90, (t) => (t >= breakAt ? 125 : 110));
  assert.equal(client.candleCalls, 1);
  assert.equal(client.orders.length, 1, 'one trade only');
  const o = client.orders[0];
  assert.equal(o.direction, 'BUY');
  assert.equal(o.epic, 'GBP');
  assert.equal(o.expiry, 'DFB'); // spread-bet accounts reject '-'
  assert.equal(o.stopDistance, 25.5); // offer 125.5 - range low 100
  assert.equal(o.limitDistance, 51);
  assert.equal(o.size, 1.96); // 50 / 25.5, rounded down
  assert.equal(bot.risk.markets.GBPUSD.traded, true);
});

test('skips the day when the breakout happened before the bot started', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN + 90 * MIN);
  await bot.start();
  client.history = rangeCandles(OPEN + 90 * MIN, [{ time: OPEN + 70 * MIN, open: 110, high: 126, low: 110, close: 125 }]).sort((a, b) => a.time - b.time);
  await run(bot, client, 5, () => 130);
  assert.equal(client.orders.length, 0);
  assert.equal(bot.risk.markets.GBPUSD.done, true);
});

test('skips a range that is too small for the spread', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN + 60 * MIN);
  await bot.start();
  client.history = Array.from({ length: 60 }, (_, i) => ({ time: OPEN + i * MIN, open: 110, high: 110.5, low: 109.5, close: 110 }));
  await run(bot, client, 5, () => 115);
  assert.equal(client.orders.length, 0);
  assert.equal(bot.risk.markets.GBPUSD.done, true);
});

test('closes positions once the session is over and has no work left', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN + 8 * 60 * MIN + 5 * MIN); // 16:05 London
  client.positions = [{ dealId: 'X', direction: 'BUY', size: 1, epic: 'GBP' }, { dealId: 'Y', direction: 'SELL', size: 1, epic: 'OTHER' }];
  await bot.start();
  await bot.tick();
  assert.deepEqual(client.closed.map((p) => p.dealId), ['X']);
  assert.equal(bot.hasWork(), false);
});

test('ends the entry window three hours after the open without a signal', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN + 60 * MIN);
  await bot.start();
  client.history = rangeCandles(OPEN + 60 * MIN);
  await run(bot, client, 125, () => 110);
  assert.equal(client.orders.length, 0);
  assert.equal(bot.hasWork(), false);
});

test('daily loss limit stops trading and closes the bot positions', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN + 60 * MIN);
  await bot.start();
  client.positions = [{ dealId: 'X', direction: 'BUY', size: 1, epic: 'GBP' }];
  client.equityValue = 9800;
  await bot.tick();
  assert.equal(bot.risk.halted, true);
  assert.deepEqual(client.closed.map((p) => p.dealId), ['X']);
  assert.equal(bot.hasWork(), false);
});

test('sizes from a percentage of the day start equity', async () => {
  const client = fakeClient();
  const bot = makeBot(client, OPEN - 20 * MIN, { riskPct: 1, maxDailyLossPct: 3 });
  await bot.start();
  assert.equal(bot.tradeRisk(), 100); // 1% of 10000
  assert.equal(bot.dailyLimit(), 300);
  client.history = rangeCandles(OPEN + 60 * MIN);
  await run(bot, client, 90, (t) => (t >= OPEN + 63 * MIN ? 125 : 110));
  assert.equal(client.orders[0].size, 3.92); // 100 / 25.5, rounded down
});

test('skips a spread bet whose margin the account cannot cover', async () => {
  const client = fakeClient();
  const market = client.market;
  client.market = async () => ({ ...(await market()), marginPct: 3.33 });
  client.available = async () => 5; // 1.96 × 125.5 × 3.33% ≈ 8.2 needed
  const notes = [];
  const bot = makeBot(client, OPEN - 20 * MIN, { log: (m) => notes.push(m) });
  await bot.start();
  client.history = rangeCandles(OPEN + 60 * MIN);
  await run(bot, client, 90, (t) => (t >= OPEN + 63 * MIN ? 125 : 110));
  assert.equal(client.orders.length, 0);
  assert.equal(bot.risk.markets.GBPUSD.done, true);
  assert.ok(notes.some((n) => /marjă insuficientă/.test(n)));
});

test('a refusal for insufficient funds ends the day for that market', async () => {
  const client = fakeClient();
  client.openMarket = async () => { throw new Error('Order rejected: INSUFFICIENT_FUNDS'); };
  const notes = [];
  const bot = makeBot(client, OPEN - 20 * MIN, { log: (m) => notes.push(m) });
  await bot.start();
  client.history = rangeCandles(OPEN + 60 * MIN);
  await run(bot, client, 90, (t) => (t >= OPEN + 63 * MIN ? 125 : 110));
  assert.equal(bot.risk.markets.GBPUSD.done, true);
  assert.ok(notes.some((n) => /fonduri insuficiente/.test(n)));
});

test('refuses a risk percentage above 2', () => {
  assert.throws(() => new MultiBot({ client: fakeClient(), markets: [GBP], riskPct: 5, maxDailyLoss: 150 }), /BOT_RISK_PCT/);
});

test('on a CFD account sizes in contracts from the point value in account currency', async () => {
  const client = fakeClient();
  client.accountType = 'CFD';
  const market = client.market;
  client.market = async (epic) => ({
    ...(await market()), expiry: '-', currency: 'USD', scaling: 1, pointValue: 10, toAccount: 0.5, contractSize: 10, marginPct: 5,
    ...(epic === 'NOPRICE' ? { bid: null, offer: null } : {}),
  });
  client.available = async () => 1000;
  const cfdMarket = { ...GBP, live: { ...GBP.live, cfdEpics: ['NOPRICE', 'GBP-CFD'] } };
  const bot = new MultiBot({ client, markets: [cfdMarket], riskPerTrade: 50, maxDailyLoss: 150, log: () => {} });
  bot.clock = OPEN - 20 * MIN;
  bot.now = () => bot.clock;
  await bot.start();
  client.history = rangeCandles(OPEN + 60 * MIN);
  await run(bot, client, 90, (t) => (t >= OPEN + 63 * MIN ? 125 : 110));
  const o = client.orders[0];
  assert.equal(o.epic, 'GBP-CFD'); // the first epic had no prices
  assert.equal(o.expiry, '-');
  assert.equal(o.currency, 'USD');
  assert.equal(o.stopDistance, 25.5);
  assert.equal(o.size, 0.39); // 50 / (25.5 points × 10 × 0.5)
});
