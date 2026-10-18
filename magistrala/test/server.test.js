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
  try {
    await fn(server.address().port);
  } finally {
    await shutdown();
  }
}

test('serves the app shell and the vendored 3D engine', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/vendor/three.module.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const bad = await fetch(`http://127.0.0.1:${port}/%2e%2e/server.js`);
    assert.ok([403, 404].includes(bad.status));
  });
});

test('two players join, keep tickets in secret and take turns', async () => {
  await withServer(async (port) => {
    const a = client(port);
    const b = client(port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'create', role: 'A', name: 'Paul', options: { seed: 9 } });
    const ja = await a.next((m) => m.t === 'joined');
    const sa = await a.next((m) => m.t === 'state');
    assert.equal(sa.view.me, 0);
    assert.equal(sa.view.players[0].pending.length, 3);
    assert.equal(sa.view.players[1].pending, null);
    b.send({ t: 'join', code: ja.code, name: 'Ioana' });
    const jb = await b.next((m) => m.t === 'joined');
    assert.equal(jb.role, 'B');
    const sb = await b.next((m) => m.t === 'state');
    assert.equal(sb.view.me, 1);
    assert.equal(sb.players.A.name, 'Paul');

    a.send({ t: 'act', action: { type: 'keepTickets', keep: sa.view.players[0].pending.slice(0, 2).map((t) => t.id) } });
    await a.next((m) => m.t === 'state' && m.view.players[0].ticketCount === 2);
    const seenByB = await b.next((m) => m.t === 'state' && m.view.players[0].ticketCount === 2);
    assert.equal(seenByB.view.players[0].tickets, null);
    assert.ok(seenByB.events.find((e) => e.k === 'ticketsKept').ids === null);

    b.send({ t: 'act', action: { type: 'keepTickets', keep: sb.view.players[1].pending.map((t) => t.id) } });
    const started = await a.next((m) => m.t === 'state' && m.view.phase === 'turn');
    const active = started.view.active;
    const mover = active === 0 ? a : b;
    const waiter = active === 0 ? b : a;
    mover.send({ t: 'act', action: { type: 'drawCard', slot: 'deck' } });
    const ev = await waiter.next((m) => m.t === 'state' && m.events.some((e) => e.k === 'draw'));
    assert.equal(ev.events.find((e) => e.k === 'draw').card, null);
    waiter.send({ t: 'act', action: { type: 'drawCard', slot: 'deck' } });
    assert.match((await waiter.next((m) => m.t === 'error')).msg, /rândul/);
    a.ws.close();
    b.ws.close();
  });
});

test('a lost room is rebuilt from the replay a player kept', async () => {
  let replay, token, code;
  await withServer(async (port) => {
    const a = client(port);
    await a.open();
    a.send({ t: 'create', role: 'B', name: 'Ana', options: { seed: 3 } });
    ({ token, code } = await a.next((m) => m.t === 'joined'));
    replay = (await a.next((m) => m.t === 'state')).replay;
    a.ws.close();
  });
  await withServer(async (port) => {
    const a = client(port);
    await a.open();
    a.send({ t: 'rejoin', code, role: 'B', token, replay });
    assert.equal((await a.next((m) => m.t === 'joined')).role, 'B');
    assert.equal((await a.next((m) => m.t === 'state')).view.me, 1);
    a.ws.close();
  });
});

test('sanitizeAction keeps only known fields', () => {
  assert.deepEqual(sanitizeAction({ type: 'drawCard', slot: 'deck', x: 1 }), { type: 'drawCard', slot: 'deck' });
  assert.deepEqual(sanitizeAction({ type: 'bid', cards: { rosu: 2, 'bad key': 1, alb: 'x' } }), { type: 'bid', cards: { rosu: 2 } });
  assert.deepEqual(sanitizeAction({ type: 'keepTickets', keep: [1, '2', 3, 4, 5] }), { type: 'keepTickets', keep: [1, 3, 4] });
});
