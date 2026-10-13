import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/js/engine/engine.js';

const opts = { seed: 12345, difficulty: 'normal' };

test('createGame is deterministic for a seed', () => {
  assert.deepEqual(E.createGame(opts), E.createGame(opts));
  assert.notDeepEqual(E.createGame(opts).tiles, E.createGame({ ...opts, seed: 99 }).tiles);
});

test('map has a depot, five lighthouses and four ships in port', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const s = E.createGame({ seed });
    assert.equal(s.ports.length, 6);
    assert.equal(s.ports.filter((p) => p.kind === 'depot').length, 1);
    for (const p of s.ports) assert.equal(s.tiles[p.hex], 'land');
    assert.equal(s.ships.length, 4);
    assert.ok(s.ships.every((sh) => sh.hex === s.ports[0].hex));
    assert.equal(s.hands.A.length, 3);
    assert.equal(s.hands.B.length, 3);
    assert.equal(s.demands.length, 2);
  }
});

test('hidden information: A never sees goods of demands, B never sees forecast', () => {
  const s = E.createGame(opts);
  const a = E.viewFor(s, 'A');
  const b = E.viewFor(s, 'B');
  assert.ok(a.demands.every((d) => d.good === null));
  assert.ok(b.demands.every((d) => E.GOODS.includes(d.good)));
  assert.equal(b.forecast.length, 0);
  assert.equal(a.forecast.length, 2);
  assert.equal(typeof a.hands.B, 'number');
  assert.ok(Array.isArray(a.hands.A));
  for (const v of [a, b]) {
    const json = JSON.stringify(v);
    assert.ok(!json.includes('demandQueue') && !json.includes('stormEyes') && !json.includes('"rng"'));
  }
  const ev = E.eventsFor([{ k: 'demand', port: 1, good: 'sare' }], 'A');
  assert.equal(ev[0].good, null);
});

test('only the active player may play, and the original state is not mutated', () => {
  const s = E.createGame(opts);
  const before = JSON.stringify(s);
  assert.equal(E.activeRole(s), 'A');
  assert.throws(() => E.applyAction(s, 'B', { type: 'discard', card: s.hands.B[0].id }), E.GameError);
  assert.throws(() => E.applyAction(s, 'A', { type: 'discard', card: 9999 }), E.GameError);
  const { state } = E.applyAction(s, 'A', { type: 'discard', card: s.hands.A[0].id });
  assert.equal(JSON.stringify(s), before);
  assert.equal(E.activeRole(state), 'B');
  assert.equal(state.hands.A.length, 2);
});

test('signals are limited per night and can be placed out of turn', () => {
  let s = E.createGame(opts);
  s = E.applyAction(s, 'B', { type: 'signal', hex: 10, kind: 'danger' }).state;
  s = E.applyAction(s, 'B', { type: 'signal', hex: 11, kind: 'danger' }).state;
  assert.throws(() => E.applyAction(s, 'B', { type: 'signal', hex: 12, kind: 'danger' }), /semnale/);
  assert.throws(() => E.applyAction(s, 'A', { type: 'signal', hex: 10, kind: 'want', good: 'sare' }), /porturi/);
  assert.throws(() => E.applyAction(s, 'A', { type: 'signal', hex: -1 }), E.GameError);
});

function forceCard(state, role, type) {
  const s = JSON.parse(JSON.stringify(state));
  s.hands[role][0] = { id: 900 + s.seq, type };
  return s;
}

test('sailing moves a ship along a valid path, loads and delivers', () => {
  let s = E.createGame(opts);
  const demand = s.demands[0];
  const producer = s.ports.find((p) => p.product === demand.good && p.kind === 'port');
  // teleport ship 0 next to the producer, then sail into it and load
  s.ships[0].hex = producer.hex;
  s = forceCard(s, 'A', 'sail2');
  let r = E.applyAction(s, 'A', { type: 'play', card: s.hands.A[0].id, ship: 0, to: producer.hex, load: true });
  assert.deepEqual(r.state.ships[0].cargo, [demand.good]);
  assert.ok(r.events.some((e) => e.k === 'load'));
  s = r.state;
  s.ships[0].hex = s.ports[demand.port].hex;
  s = forceCard(s, 'B', 'sail2');
  r = E.applyAction(s, 'B', { type: 'play', card: s.hands.B[0].id, ship: 0, to: s.ports[demand.port].hex });
  assert.equal(r.state.delivered, 1);
  assert.ok(r.events.some((e) => e.k === 'deliver'));
  assert.ok(!r.state.demands.some((d) => d.id === demand.id));
});

test('ships cannot sail over land or beyond range', () => {
  let s = E.createGame(opts);
  s = forceCard(s, 'A', 'sail2');
  const land = s.tiles.findIndex((t, i) => t === 'land' && !s.ports.some((p) => p.hex === i));
  assert.throws(() => E.applyAction(s, 'A', { type: 'play', card: s.hands.A[0].id, ship: 0, to: land }), /ajunge/);
  const reach = E.reachable(s, 0, 3);
  const far = s.tiles.findIndex((t, i) => t === 'sea' && !reach.has(i));
  if (far >= 0) assert.throws(() => E.applyAction(s, 'A', { type: 'play', card: s.hands.A[0].id, ship: 0, to: far }), /ajunge/);
});

test('oil cargo relights a lighthouse', () => {
  let s = E.createGame(opts);
  const port = s.ports[1];
  port.light = 0;
  s.ships[1].cargo = ['ulei'];
  s.ships[1].hex = port.hex;
  s = forceCard(s, 'A', 'sail2');
  const r = E.applyAction(s, 'A', { type: 'play', card: s.hands.A[0].id, ship: 1, to: port.hex });
  assert.equal(r.state.ports[1].light, 2);
  assert.deepEqual(r.state.ships[1].cargo, []);
});

test('a full night resolves storms, advances and alternates the starter', () => {
  let s = E.createGame(opts);
  const all = [];
  for (let k = 0; k < 4; k++) {
    const role = E.activeRole(s);
    const r = E.applyAction(s, role, { type: 'discard', card: s.hands[role][0].id });
    s = r.state;
    all.push(...r.events);
  }
  assert.ok(all.some((e) => e.k === 'storm'));
  assert.equal(s.night, 2);
  assert.equal(s.starter, 'B');
  assert.equal(s.hands.A.length, 3);
  assert.equal(s.signalsUsed.A, 0);
});

test('a ship in the storm without shelter loses hull and sinks back to the depot', () => {
  let s = E.createGame(opts);
  const stormHex = s.storms[0].find((h) => s.tiles[h] === 'sea');
  s.ships[2].hex = stormHex;
  s.ships[2].hull = 1;
  s.ships[2].cargo = ['sare'];
  for (let k = 0; k < 4; k++) {
    const role = E.activeRole(s);
    s = E.applyAction(s, role, { type: 'discard', card: s.hands[role][0].id }).state;
  }
  assert.equal(s.ships[2].hex, s.ports[0].hex);
  assert.deepEqual(s.ships[2].cargo, []);
  assert.equal(s.sunk, 1);
});

test('three dark lighthouses lose the game; the lamp relic saves one', () => {
  const run = (relic) => {
    let s = E.createGame({ ...opts, relic });
    for (const p of s.ports.slice(1, 4)) p.light = 1;
    s.night = 4; // burn night on normal
    for (let k = 0; k < 4; k++) {
      const role = E.activeRole(s);
      s = E.applyAction(s, role, { type: 'discard', card: s.hands[role][0].id }).state;
    }
    return s;
  };
  const plain = run('none');
  assert.equal(plain.phase, 'over');
  assert.equal(plain.result.win, false);
  assert.equal(plain.result.reason, 'dark');
  const lamp = run('lamp');
  assert.ok(lamp.lampUsed);
});

test('reaching the target wins at the end of the night with stars', () => {
  let s = E.createGame(opts);
  s.delivered = s.target;
  for (let k = 0; k < 4; k++) {
    const role = E.activeRole(s);
    s = E.applyAction(s, role, { type: 'discard', card: s.hands[role][0].id }).state;
  }
  assert.equal(s.phase, 'over');
  assert.equal(s.result.win, true);
  assert.ok(s.result.stars >= 1);
  assert.throws(() => E.applyAction(s, 'A', { type: 'signal', hex: 1 }), /încheiat/);
});

test('replay rebuilds the same state from options and actions', () => {
  let s = E.createGame(opts);
  const actions = [];
  for (let k = 0; k < 9; k++) {
    const role = E.activeRole(s);
    const action = { type: 'discard', card: s.hands[role][0].id };
    actions.push([role, action]);
    s = E.applyAction(s, role, action).state;
  }
  assert.deepEqual(E.replay(opts, actions), s);
});

test('option validation falls back to safe defaults', () => {
  const o = E.validateOptions({ difficulty: 'x', relic: '__proto__', mode: 1, names: { A: '<b>Ana</b>', B: '' } });
  assert.equal(o.difficulty, 'normal');
  assert.equal(o.relic, 'none');
  assert.equal(o.mode, 'silent');
  assert.equal(o.names.A, 'bAna/b');
  assert.equal(o.names.B, 'Căpitanul');
  assert.equal(E.createGame({ seed: 1, mode: 'talk' }).target, E.DIFFICULTIES.normal.target + 2);
});
