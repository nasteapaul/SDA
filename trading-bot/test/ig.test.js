import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgClient, DEMO_URL } from '../lib/ig.js';

const creds = { apiKey: 'k', identifier: 'u', password: 'p', wait: async () => {} };

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const path = url.replace(DEMO_URL, '').split('?')[0].replace(/^\/confirms\/.+/, '/confirms/*');
    const key = `${init.method} ${path}`;
    const r = typeof routes[key] === 'function' ? routes[key](calls.length) : routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    if (r.throws) throw r.throws;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: new Headers(r.headers ?? {}),
      text: async () => r.raw ?? JSON.stringify(r.body ?? {}),
    };
  };
  fn.calls = calls;
  return fn;
}

const login = { headers: { CST: 'c', 'X-SECURITY-TOKEN': 'x' }, body: { currentAccountId: 'A1' } };

test('refuses any endpoint other than demo', () => {
  assert.throws(() => new IgClient({ ...creds, baseUrl: 'https://api.ig.com/gateway/deal' }), /demo/);
});

test('login stores tokens and sends them afterwards', async () => {
  const f = fakeFetch({ 'POST /session': login, 'GET /accounts': { body: { accounts: [{ accountId: 'A1', balance: { balance: 1000, profitLoss: -25 } }] } } });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await c.login();
  assert.equal(await c.equity(), 975);
  assert.equal(f.calls[1].headers.CST, 'c');
  assert.equal(f.calls[0].headers.Version, '2');
});

test('openMarket requires a stop and checks the confirmation', async () => {
  const f = fakeFetch({
    'POST /positions/otc': { body: { dealReference: 'R1' } },
    'GET /confirms/*': { body: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await assert.rejects(c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 0 }), /stop/);
  await assert.rejects(c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 10 }), /MARKET_CLOSED/);
  assert.equal(f.calls[0].body.stopDistance, 10);
  assert.equal(f.calls[0].body.orderType, 'MARKET');
  assert.match(f.calls[0].body.dealReference, /^bot-[a-f0-9]{24}$/);
  assert.ok(f.calls[1].url.endsWith(f.calls[0].body.dealReference));
});

test('closePosition sends the opposite direction through the DELETE override', async () => {
  const f = fakeFetch({
    'POST /positions/otc': { body: { dealReference: 'R2' } },
    'GET /confirms/*': { body: { dealStatus: 'ACCEPTED' } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await c.closePosition({ dealId: 'D', direction: 'BUY', size: 2 });
  assert.equal(f.calls[0].headers._method, 'DELETE');
  assert.equal(f.calls[0].body.direction, 'SELL');
});

test('logs in again once when the session expires', async () => {
  const f = fakeFetch({
    'POST /session': login,
    'GET /positions': (n) => (n === 1 ? { status: 401, body: { errorCode: 'expired' } } : { body: { positions: [] } }),
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  assert.deepEqual(await c.openPositions(), []);
  assert.equal(f.calls.length, 3);
});

test('a lost order response is resolved through our own deal reference, never re-sent', async () => {
  const f = fakeFetch({
    'POST /positions/otc': { throws: new Error('socket hang up') },
    'GET /confirms/*': { body: { dealStatus: 'ACCEPTED', level: 100 } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  const res = await c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 10 });
  assert.equal(res.level, 100);
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 1);
});

test('unknown order state is reported when the deal cannot be found', async () => {
  const f = fakeFetch({
    'POST /positions/otc': { status: 503, raw: '<html>Service Unavailable</html>' },
    'GET /confirms/*': { status: 404, body: { errorCode: 'error.confirms.deal-not-found' } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await assert.rejects(c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 10 }), (e) => e.code === 'UNKNOWN_ORDER_STATE');
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 1);
});

test('bad credentials lock the client so it stops retrying logins', async () => {
  const f = fakeFetch({ 'POST /session': { status: 401, body: { errorCode: 'error.security.invalid-details' } } });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await assert.rejects(c.login(), (e) => e.fatal);
  await assert.rejects(c.openPositions(), (e) => e.fatal);
  assert.equal(f.calls.length, 1);
});

test('candles skip bars without prices and accept IG time formats', async () => {
  const bar = (t, v) => ({ snapshotTimeUTC: t, openPrice: { bid: v, ask: v }, highPrice: { bid: v, ask: v }, lowPrice: { bid: v, ask: v }, closePrice: { bid: v, ask: v } });
  const f = fakeFetch({
    'GET /prices/E': { body: { prices: [bar('2026-10-07T09:00:00', 10), { snapshotTimeUTC: '2026-10-07T09:05:00', openPrice: {} }, bar('2026-10-07T09:10:00Z', 11)] } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  const out = await c.candles('E', 'MINUTE_5', 3);
  assert.deepEqual(out.map((x) => x.time), [Date.parse('2026-10-07T09:00:00Z'), Date.parse('2026-10-07T09:10:00Z')]);
});
