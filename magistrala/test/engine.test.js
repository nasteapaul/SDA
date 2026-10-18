import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/js/engine/engine.js';
import { botAction } from '../public/js/engine/bot.js';

const opts = { seed: 42 };
const start = () => {
  let s = E.createGame(opts);
  s = E.applyAction(s, 0, { type: 'keepTickets', keep: s.players[0].pending.slice(0, 2) }).state;
  s = E.applyAction(s, 1, { type: 'keepTickets', keep: s.players[1].pending.slice(0, 3) }).state;
  return s;
};
const give = (s, p, hand) => { const c = JSON.parse(JSON.stringify(s)); Object.assign(c.players[p].hand, hand); return c; };

test('setup deals 4 cards, 3 tickets to choose, a 5-card market', () => {
  const s = E.createGame(opts);
  assert.deepEqual(E.createGame(opts), s);
  for (const p of s.players) {
    assert.equal(E.handSize(p.hand), 4);
    assert.equal(p.pending.length, 3);
    assert.equal(p.trains, E.TRAINS);
  }
  assert.equal(s.market.length, 5);
  assert.equal(s.phase, 'setup');
});

test('both players must keep at least two tickets before play starts', () => {
  let s = E.createGame(opts);
  assert.throws(() => E.applyAction(s, 0, { type: 'keepTickets', keep: [s.players[0].pending[0]] }), /cel puțin 2/);
  assert.throws(() => E.applyAction(s, 0, { type: 'drawCard', slot: 'deck' }), /biletele/);
  s = start();
  assert.equal(s.phase, 'turn');
  assert.equal(s.players[0].tickets.length, 2);
  assert.equal(s.players[1].tickets.length, 3);
});

test('drawing two cards ends the turn; a face-up locomotive ends it at once', () => {
  let s = start();
  const p = s.active;
  s.market = ['rosu', 'loco', 'verde', 'alb', 'negru'];
  let r = E.applyAction(s, p, { type: 'drawCard', slot: 0 });
  assert.equal(r.state.active, p);
  assert.throws(() => E.applyAction(r.state, p, { type: 'drawCard', slot: r.state.market.indexOf('loco') }), /locomotivă/);
  r = E.applyAction(r.state, p, { type: 'drawCard', slot: 'deck' });
  assert.equal(r.state.active, 1 - p);
  s.market = ['loco', 'rosu', 'verde', 'alb', 'negru'];
  r = E.applyAction(s, p, { type: 'drawCard', slot: 0 });
  assert.equal(r.state.active, 1 - p);
  assert.equal(r.state.players[p].hand.loco, s.players[p].hand.loco + 1);
});

test('claiming a route pays matching cards (locos fill in) and scores', () => {
  let s = start();
  const p = s.active;
  const route = E.ROUTES.find((r) => r.a === 'OR' && r.b === 'CJ'); // 3 galben
  s = give(s, p, { galben: 2, loco: 1, rosu: 0 });
  const before = s.players[p];
  const { state, events } = E.applyAction(s, p, { type: 'claim', route: route.id });
  assert.equal(state.routes[route.id], p);
  assert.equal(state.players[p].hand.galben, before.hand.galben - 2);
  assert.equal(state.players[p].hand.loco, before.hand.loco - 1);
  assert.equal(state.players[p].trains, E.TRAINS - 3);
  assert.equal(state.players[p].routePoints, 4);
  assert.ok(events.some((e) => e.k === 'claim'));
  assert.throws(() => E.applyAction(state, 1 - p, { type: 'claim', route: route.id }), /deja/);
});

test('grey routes take any single color, and you cannot pay with the wrong cards', () => {
  let s = start();
  const p = s.active;
  const grey = E.ROUTES.find((r) => r.color === 'gri' && r.len === 3);
  s = give(s, p, { rosu: 0, albastru: 0, verde: 0, galben: 0, negru: 0, alb: 0, loco: 0 });
  assert.throws(() => E.applyAction(s, p, { type: 'claim', route: grey.id }), /cărțile/);
  s = give(s, p, { albastru: 3 });
  const { state } = E.applyAction(s, p, { type: 'claim', route: grey.id, color: 'albastru' });
  assert.equal(state.players[p].hand.albastru, 0);
});

test('a station collects a toll when the opponent builds into its city', () => {
  let s = start();
  const p = s.active, o = 1 - p;
  s = give(s, p, { negru: 3 });
  s = E.applyAction(s, p, { type: 'station', city: 'PH', color: 'negru' }).state;
  assert.equal(s.stations.PH, p);
  assert.throws(() => E.applyAction(s, o, { type: 'station', city: 'PH' }), /gară/);
  const route = E.ROUTES.find((r) => (r.a === 'PH' && r.b === 'B'));
  s = give(s, o, { rosu: 1 });
  const { state, events } = E.applyAction(s, o, { type: 'claim', route: route.id });
  assert.equal(state.players[p].toll, E.STATION_TOLL);
  assert.ok(events.some((e) => e.k === 'toll' && e.to === p));
});

test('hidden information: hands, tickets and the deck stay private', () => {
  const s = start();
  const v0 = E.viewFor(s, 0);
  assert.ok(v0.players[0].hand);
  assert.equal(v0.players[1].hand, null);
  assert.equal(v0.players[1].tickets, null);
  assert.equal(v0.players[1].ticketCount, 3);
  const json = JSON.stringify(v0);
  assert.ok(!json.includes('"deck"') && !json.includes('ticketDeck"') && !json.includes('"rng"'));
  const ev = E.eventsFor([{ k: 'draw', player: 1, from: 'deck', card: 'rosu' }, { k: 'ticketDone', player: 1, id: 3, secret: true }], 0);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].card, null);
});

test('an auction runs after six turns; the higher sealed bid wins and pays', () => {
  let s = start();
  for (let k = 0; k < E.AUCTION_EVERY; k++) s = E.applyAction(E.applyAction(s, s.active, { type: 'drawCard', slot: 'deck' }).state, s.active, { type: 'drawCard', slot: 'deck' }).state;
  assert.equal(s.phase, 'auction');
  assert.throws(() => E.applyAction(s, s.active, { type: 'drawCard', slot: 'deck' }), /licitația/);
  const c0 = E.COLORS.find((c) => s.players[0].hand[c] >= 2);
  s = E.applyAction(s, 0, { type: 'bid', cards: { [c0]: 2 } }).state;
  assert.equal(E.viewFor(s, 1).auction.placed[0], true);
  assert.throws(() => E.applyAction(s, 1, { type: 'bid', cards: { rosu: 99 } }), /cărțile/);
  const { state, events } = E.applyAction(s, 1, { type: 'bid', cards: {} });
  const res = events.find((e) => e.k === 'auctionResult');
  assert.equal(res.winner, 0);
  assert.equal(state.players[0].contracts.length, 1);
  assert.equal(state.players[0].hand[c0], s.players[0].hand[c0] - 2);
  assert.equal(state.phase, 'turn');
});

test('bots finish whole games without illegal moves, and replays are exact', () => {
  for (let seed = 1; seed <= 15; seed++) {
    let s = E.createGame({ seed });
    const actions = [];
    while (s.phase !== 'over') {
      const p = s.phase === 'setup' ? (s.players[0].pending.length ? 0 : 1) : s.phase === 'auction' ? (s.auction.bids[0] ? 1 : 0) : s.active;
      const a = botAction(s, p);
      actions.push([p, a]);
      s = E.applyAction(s, p, a).state;
      assert.ok(actions.length < 1000);
    }
    assert.ok(s.result.scores.every((x) => Number.isFinite(x.total)));
    assert.deepEqual(E.replay({ seed }, actions), s);
  }
});

test('longest path ignores branches and counts each route once', () => {
  const s = start();
  const ids = (pairs) => pairs.map(([a, b]) => E.ROUTES.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)).id);
  for (const id of ids([['TM', 'AR'], ['AR', 'OR'], ['OR', 'CJ'], ['AR', 'DV']])) s.routes[id] = 0;
  assert.equal(E.longestPath(s, 0), 7); // Deva–Arad–Oradea–Cluj; the Timișoara spur is a branch
});
