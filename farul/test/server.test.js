import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { sanitizeAction } from '../lib/rooms.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.addEventListener('open', r, { once: true })),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timeout')), 3000);
      });
    },
  };
}

async function withServer(fn) {
  const { server, shutdown } = createServer({ persist: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await shutdown();
  }
}

test('serves the app and blocks path traversal', async () => {
  await withServer(async (port) => {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(await ok.text(), 'ok');
    const bad = await fetch(`http://127.0.0.1:${port}/%2e%2e/server.js`);
    assert.ok([403, 404].includes(bad.status));
    const js = await fetch(`http://127.0.0.1:${port}/js/engine/engine.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('two players create, join, see only their own secrets and play', async () => {
  await withServer(async (port) => {
    const a = client(port);
    const b = client(port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'create', role: 'A', name: 'Paul', options: { difficulty: 'normal', seed: 7 } });
    const joinedA = await a.next((m) => m.t === 'joined');
    assert.equal(joinedA.role, 'A');
    assert.match(joinedA.code, /^[A-Z]{4}$/);
    const sa = await a.next((m) => m.t === 'state');

    b.send({ t: 'join', code: joinedA.code.toLowerCase(), name: 'Ioana' });
    const joinedB = await b.next((m) => m.t === 'joined');
    assert.equal(joinedB.role, 'B');
    const sb = await b.next((m) => m.t === 'state');
    assert.equal(sb.view.forecast.length, 0);
    assert.ok(sb.view.demands.every((d) => d.good));
    assert.equal(sb.players.A.name, 'Paul');
    const pres = await a.next((m) => m.t === 'presence' && m.players.B.online);
    assert.equal(pres.players.B.name, 'Ioana');

    const c = client(port);
    await c.open();
    c.send({ t: 'join', code: joinedA.code, name: 'X' });
    assert.match((await c.next((m) => m.t === 'error')).msg, /plină/);

    b.send({ t: 'act', action: { type: 'discard', card: sb.view.hands.B[0].id } });
    assert.match((await b.next((m) => m.t === 'error')).msg, /rândul/);

    a.send({ t: 'act', action: { type: 'discard', card: sa.view.hands.A[0].id, evil: { __proto__: 1 } } });
    const afterA = await a.next((m) => m.t === 'state' && m.view.turn === 1);
    assert.ok(afterA.view.demands.every((d) => d.good === null));
    const afterB = await b.next((m) => m.t === 'state' && m.view.turn === 1);
    assert.equal(afterB.view.active, 'B');
    assert.equal(afterB.replay.actions.length, 1);

    a.send({ t: 'react', emoji: '❤️' });
    assert.equal((await b.next((m) => m.t === 'react')).emoji, '❤️');
    for (const x of [a, b, c]) x.ws.close();
  });
});

test('a player can rejoin, and a lost room is rebuilt from the replay', async () => {
  let replay, token, code;
  await withServer(async (port) => {
    const a = client(port);
    await a.open();
    a.send({ t: 'create', role: 'B', name: 'Ana', options: { seed: 3 } });
    const j = await a.next((m) => m.t === 'joined');
    ({ token, code } = j);
    const s = await a.next((m) => m.t === 'state');
    replay = s.replay;
    a.ws.close();
  });
  await withServer(async (port) => {
    const a = client(port);
    await a.open();
    a.send({ t: 'rejoin', code, role: 'B', token: 'f'.repeat(32), replay });
    assert.equal((await a.next((m) => m.t === 'error')).fatal, true);
    a.send({ t: 'rejoin', code, role: 'B', token, replay });
    const j = await a.next((m) => m.t === 'joined');
    assert.equal(j.role, 'B');
    const s = await a.next((m) => m.t === 'state');
    assert.equal(s.view.role, 'B');
    a.ws.close();
  });
});

test('sanitizeAction keeps only known primitive fields', () => {
  const out = sanitizeAction({ type: 'play', card: 3, ship: '1', to: 4.5, load: 'yes', moves: [{ ship: 1, to: 2, load: true, x: 1 }], extra: 1 });
  assert.deepEqual(out, { type: 'play', card: 3, moves: [{ ship: 1, to: 2, load: true }] });
});
