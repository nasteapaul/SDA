import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgClient, DEMO_URL } from '../lib/ig.js';

const creds = { apiKey: 'k', identifier: 'u', password: 'p' };

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const key = `${init.method} ${url.replace(DEMO_URL, '').split('?')[0]}`;
    const r = typeof routes[key] === 'function' ? routes[key](calls.length) : routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: new Headers(r.headers ?? {}),
      text: async () => JSON.stringify(r.body ?? {}),
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
    'GET /confirms/R1': { body: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } },
  });
  const c = new IgClient({ ...creds, fetchImpl: f });
  await assert.rejects(c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 0 }), /stop/);
  await assert.rejects(c.openMarket({ epic: 'E', direction: 'BUY', size: 1, stopDistance: 10 }), /MARKET_CLOSED/);
  assert.equal(f.calls[0].body.stopDistance, 10);
  assert.equal(f.calls[0].body.orderType, 'MARKET');
});

test('closePosition sends the opposite direction through the DELETE override', async () => {
  const f = fakeFetch({
    'POST /positions/otc': { body: { dealReference: 'R2' } },
    'GET /confirms/R2': { body: { dealStatus: 'ACCEPTED' } },
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
