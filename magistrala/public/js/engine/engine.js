// Magistrala — pure, deterministic rules engine shared by the server and the browser.
// Two players (0 and 1). Ticket to Ride–style route building on a map of Romania, plus
// stations that collect a toll (Monopoly) and secret auctions for state contracts.
import { Rng } from './rng.js';
import { CITIES, ROUTES, COLORS, WILD, ROUTE_POINTS, TICKETS, CONTRACTS } from './map.js';

export { CITIES, ROUTES, COLORS, WILD, ROUTE_POINTS, TICKETS, CONTRACTS };

export const TRAINS = 26;
export const MARKET_SIZE = 5;
export const MAX_STATIONS = 3;
export const STATION_COST = 3;
export const STATION_TOLL = 2;
export const LONGEST_BONUS = 10;
export const AUCTION_EVERY = 6; // completed turns between auctions
export const MAX_AUCTIONS = 3;
export const CARD_COUNT = 12;
export const WILD_COUNT = 14;

export const COLOR_NAMES = { rosu: 'roșu', albastru: 'albastru', verde: 'verde', galben: 'galben', negru: 'negru', alb: 'alb', loco: 'locomotivă', gri: 'gri' };

export class GameError extends Error {}

const clone = (x) => JSON.parse(JSON.stringify(x));
const ALL_TICKETS = Object.fromEntries([...TICKETS, ...CONTRACTS].map((t) => [t.id, t]));
export const ticketById = (id) => ALL_TICKETS[id];
export const other = (p) => 1 - p;

function emptyHand() {
  return Object.fromEntries([...COLORS, WILD].map((c) => [c, 0]));
}
export const handSize = (hand) => Object.values(hand).reduce((s, n) => s + n, 0);

// ---------------------------------------------------------------- setup

export function validateOptions(o = {}) {
  const seed = Number.isInteger(o.seed) ? o.seed >>> 0 : Math.floor(Math.random() * 2 ** 32);
  const clean = (v, f) => (typeof v === 'string' && v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16)) || f;
  return { seed, names: [clean(o.names?.[0], 'Jucătorul 1'), clean(o.names?.[1], 'Jucătorul 2')], auctions: o.auctions !== false };
}

export function createGame(options) {
  const opts = validateOptions(options);
  const rng = new Rng(opts.seed);
  const deck = [];
  for (const c of COLORS) for (let k = 0; k < CARD_COUNT; k++) deck.push(c);
  for (let k = 0; k < WILD_COUNT; k++) deck.push(WILD);
  rng.shuffle(deck);
  const state = {
    v: 1,
    opts,
    phase: 'setup',
    active: rng.int(2),
    turnNo: 0,
    deck,
    discard: [],
    market: [],
    players: [0, 1].map(() => ({
      trains: TRAINS, hand: emptyHand(), tickets: [], pending: [], stations: [], routePoints: 0, toll: 0, contracts: [],
    })),
    routes: Object.fromEntries(ROUTES.map((r) => [r.id, null])),
    stations: {},
    ticketDeck: rng.shuffle(TICKETS.map((t) => t.id)),
    contractDeck: rng.shuffle(CONTRACTS.map((t) => t.id)),
    drawn: 0,
    auction: null,
    auctionsDone: 0,
    finalTurns: null,
    lastAction: null,
    result: null,
    seq: 0,
    rng: 0,
  };
  for (const p of state.players) {
    for (let k = 0; k < 4; k++) p.hand[drawFromDeck(state, rng)]++;
    p.pending = state.ticketDeck.splice(0, 3);
  }
  refillMarket(state, rng, []);
  state.rng = rng.s;
  return state;
}

// ---------------------------------------------------------------- cards

function drawFromDeck(state, rng) {
  if (!state.deck.length) {
    if (!state.discard.length) return null;
    state.deck = rng.shuffle(state.discard);
    state.discard = [];
  }
  return state.deck.pop();
}

function refillMarket(state, rng, events) {
  for (let tries = 0; tries < 4; tries++) {
    while (state.market.length < MARKET_SIZE) {
      const c = drawFromDeck(state, rng);
      if (c === null) break;
      state.market.push(c);
    }
    if (state.market.filter((c) => c === WILD).length < 3) break;
    events.push({ k: 'marketReset' });
    state.discard.push(...state.market);
    state.market = [];
  }
}

/**
 * How to pay `need` cards of `color` (null = any single color) from a hand.
 * Returns { color, spent: {c: n} } using colored cards before locomotives, or null.
 */
export function payment(hand, color, need) {
  const options = color && color !== 'gri' ? [color] : COLORS;
  let best = null;
  for (const c of options) {
    const own = Math.min(hand[c], need);
    const wild = need - own;
    if (wild > hand[WILD]) continue;
    if (!best || wild < best.wild || (wild === best.wild && hand[c] > hand[best.color])) best = { color: c, own, wild };
  }
  if (!best) {
    if (hand[WILD] >= need) return { color: WILD, spent: { [WILD]: need } };
    return null;
  }
  const spent = {};
  if (best.own) spent[best.color] = best.own;
  if (best.wild) spent[WILD] = best.wild;
  return { color: best.color, spent };
}

function spend(state, player, spent) {
  for (const [c, n] of Object.entries(spent)) {
    player.hand[c] -= n;
    for (let k = 0; k < n; k++) state.discard.push(c);
  }
}

// ---------------------------------------------------------------- networks

export function connected(state, p, a, b) {
  const seen = new Set([a]);
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === b) return true;
    for (const r of ROUTES) {
      if (state.routes[r.id] !== p) continue;
      const next = r.a === cur ? r.b : r.b === cur ? r.a : null;
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return false;
}

/** Longest trail (no route reused) in a player's network. */
export function longestPath(state, p) {
  const mine = ROUTES.filter((r) => state.routes[r.id] === p);
  let best = 0;
  const used = new Set();
  const walk = (city, len) => {
    best = Math.max(best, len);
    for (const r of mine) {
      if (used.has(r.id) || (r.a !== city && r.b !== city)) continue;
      used.add(r.id);
      walk(r.a === city ? r.b : r.a, len + r.len);
      used.delete(r.id);
    }
  };
  const cities = new Set(mine.flatMap((r) => [r.a, r.b]));
  for (const c of cities) walk(c, 0);
  return best;
}

// ---------------------------------------------------------------- turn flow

function endTurn(state, rng, events) {
  const p = state.players[state.active];
  state.drawn = 0;
  state.turnNo += 1;
  if (state.finalTurns !== null) {
    state.finalTurns -= 1;
    if (state.finalTurns <= 0) return finish(state, events);
  } else if (p.trains <= 2) {
    state.finalTurns = 2;
    events.push({ k: 'finalRound', by: state.active });
  }
  state.active = other(state.active);
  const auctionDue = state.opts.auctions && state.finalTurns === null && state.auctionsDone < MAX_AUCTIONS
    && state.turnNo % AUCTION_EVERY === 0 && state.contractDeck.length;
  if (auctionDue) {
    const contract = state.contractDeck.shift();
    state.auction = { contract, bids: [null, null] };
    state.phase = 'auction';
    events.push({ k: 'auction', contract });
  } else {
    events.push({ k: 'turn', active: state.active });
  }
  if (!canAct(state, state.active) && state.phase === 'turn') {
    events.push({ k: 'skip', player: state.active });
    endTurn(state, rng, events);
  }
}

function canAct(state, p) {
  if (state.deck.length || state.discard.length || state.market.length || state.ticketDeck.length) return true;
  const pl = state.players[p];
  return ROUTES.some((r) => state.routes[r.id] === null && pl.trains >= r.len && payment(pl.hand, r.color, r.len));
}

function resolveAuction(state, rng, events) {
  const [b0, b1] = state.auction.bids;
  const value = (bid) => Object.entries(bid).reduce((s, [c, n]) => s + n * (c === WILD ? 2 : 1), 0);
  const v = [value(b0), value(b1)];
  let winner = null;
  if (v[0] > v[1]) winner = 0;
  else if (v[1] > v[0]) winner = 1;
  const contract = state.auction.contract;
  if (winner !== null) {
    spend(state, state.players[winner], state.auction.bids[winner]);
    state.players[winner].contracts.push(contract);
  } else {
    state.contractDeck.push(contract);
  }
  events.push({ k: 'auctionResult', contract, bids: clone(state.auction.bids), values: v, winner });
  state.auctionsDone += 1;
  state.auction = null;
  state.phase = 'turn';
  events.push({ k: 'turn', active: state.active });
}

function finish(state, events) {
  state.phase = 'over';
  const longest = [longestPath(state, 0), longestPath(state, 1)];
  const top = Math.max(...longest);
  const scores = state.players.map((p, i) => {
    const tickets = p.tickets.map((id) => {
      const t = ticketById(id);
      const done = connected(state, i, t.a, t.b);
      return { id, done, points: done ? t.value : -t.value };
    });
    const contracts = p.contracts.map((id) => {
      const t = ticketById(id);
      const done = connected(state, i, t.a, t.b);
      return { id, done, points: done ? t.value : 0 };
    });
    const longestBonus = top > 0 && longest[i] === top ? LONGEST_BONUS : 0;
    const total = p.routePoints + p.toll + tickets.reduce((s, t) => s + t.points, 0) + contracts.reduce((s, t) => s + t.points, 0) + longestBonus;
    return { routes: p.routePoints, toll: p.toll, tickets, contracts, longest: longest[i], longestBonus, total };
  });
  const winner = scores[0].total === scores[1].total ? null : scores[0].total > scores[1].total ? 0 : 1;
  state.result = { scores, winner };
  events.push({ k: 'over', ...clone(state.result) });
}

// ---------------------------------------------------------------- actions

const isInt = (v) => Number.isInteger(v);

function readBid(hand, cards) {
  const bid = {};
  if (!cards || typeof cards !== 'object') return bid;
  for (const c of [...COLORS, WILD]) {
    const n = cards[c];
    if (n === undefined) continue;
    if (!isInt(n) || n < 0 || n > hand[c]) throw new GameError('Nu ai cărțile astea.');
    if (n) bid[c] = n;
  }
  return bid;
}

/** Applies an action for player p (0|1). Returns { state, events }; throws GameError when illegal. */
export function applyAction(prev, p, action) {
  if (p !== 0 && p !== 1) throw new GameError('Jucător invalid.');
  if (!action || typeof action !== 'object') throw new GameError('Acțiune invalidă.');
  if (prev.phase === 'over') throw new GameError('Partida s-a încheiat.');
  const state = clone(prev);
  const rng = new Rng(state.rng);
  const events = [];
  const me = state.players[p];
  const t = action.type;

  if (t === 'keepTickets') {
    if (!me.pending.length) throw new GameError('Nu ai bilete de ales.');
    const keep = Array.isArray(action.keep) ? [...new Set(action.keep)] : [];
    if (!keep.every((id) => me.pending.includes(id))) throw new GameError('Bilet invalid.');
    const min = state.phase === 'setup' ? 2 : 1;
    if (keep.length < min) throw new GameError(`Păstrează cel puțin ${min} ${min === 1 ? 'bilet' : 'bilete'}.`);
    me.tickets.push(...keep);
    state.ticketDeck.push(...me.pending.filter((id) => !keep.includes(id)));
    me.pending = [];
    events.push({ k: 'ticketsKept', player: p, count: keep.length, ids: keep });
    if (state.phase === 'setup') {
      if (state.players.every((x) => !x.pending.length)) {
        state.phase = 'turn';
        events.push({ k: 'start', active: state.active });
      }
    } else {
      endTurn(state, rng, events);
    }
    return done(state, rng, events, p, action);
  }

  if (t === 'bid') {
    if (state.phase !== 'auction') throw new GameError('Nu e nicio licitație acum.');
    if (state.auction.bids[p]) throw new GameError('Ai licitat deja.');
    state.auction.bids[p] = readBid(me.hand, action.cards);
    events.push({ k: 'bidPlaced', player: p });
    if (state.auction.bids.every(Boolean)) resolveAuction(state, rng, events);
    return done(state, rng, events, p, action);
  }

  if (state.phase !== 'turn') throw new GameError(state.phase === 'setup' ? 'Alegeți întâi biletele.' : 'Așteptăm licitația.');
  if (state.active !== p) throw new GameError('Nu e rândul tău.');
  if (me.pending.length) throw new GameError('Alege întâi biletele.');

  if (t === 'drawCard') {
    const fromDeck = action.slot === 'deck';
    if (!fromDeck && !(isInt(action.slot) && action.slot >= 0 && action.slot < state.market.length)) throw new GameError('Carte invalidă.');
    let card;
    if (fromDeck) {
      card = drawFromDeck(state, rng);
      if (card === null) throw new GameError('Pachetul e gol.');
    } else {
      card = state.market[action.slot];
      if (card === WILD && state.drawn === 1) throw new GameError('A doua carte nu poate fi o locomotivă de la vedere.');
      state.market.splice(action.slot, 1);
    }
    me.hand[card]++;
    events.push({ k: 'draw', player: p, from: fromDeck ? 'deck' : action.slot, card });
    refillMarket(state, rng, events);
    const turnOver = (!fromDeck && card === WILD) || state.drawn === 1
      || (!state.deck.length && !state.discard.length && !state.market.some((c) => c !== WILD));
    if (turnOver) endTurn(state, rng, events);
    else state.drawn = 1;
    return done(state, rng, events, p, action);
  }

  if (state.drawn) throw new GameError('Trage și a doua carte.');

  if (t === 'claim') {
    const route = ROUTES[action.route];
    if (!route || !isInt(action.route)) throw new GameError('Rută invalidă.');
    if (state.routes[route.id] !== null) throw new GameError('Ruta e deja luată.');
    if (me.trains < route.len) throw new GameError('Nu mai ai destule vagoane.');
    let pay;
    if (route.color === 'gri' && typeof action.color === 'string') {
      if (![...COLORS, WILD].includes(action.color)) throw new GameError('Culoare invalidă.');
      pay = action.color === WILD ? (me.hand[WILD] >= route.len ? { color: WILD, spent: { [WILD]: route.len } } : null) : payment(me.hand, action.color, route.len);
    } else pay = payment(me.hand, route.color, route.len);
    if (!pay) throw new GameError('Nu ai cărțile necesare.');
    spend(state, me, pay.spent);
    state.routes[route.id] = p;
    me.trains -= route.len;
    const pts = ROUTE_POINTS[route.len];
    me.routePoints += pts;
    events.push({ k: 'claim', player: p, route: route.id, spent: pay.spent, points: pts });
    for (const city of [route.a, route.b]) {
      const owner = state.stations[city];
      if (owner !== undefined && owner !== p) {
        state.players[owner].toll += STATION_TOLL;
        events.push({ k: 'toll', from: p, to: owner, city, points: STATION_TOLL });
      }
    }
    for (const id of [...me.tickets, ...me.contracts]) {
      const tk = ticketById(id);
      if (connected(state, p, tk.a, tk.b) && !connected(prev, p, tk.a, tk.b)) events.push({ k: 'ticketDone', player: p, id, secret: true });
    }
    endTurn(state, rng, events);
    return done(state, rng, events, p, action);
  }

  if (t === 'station') {
    const city = action.city;
    if (!CITIES[city]) throw new GameError('Oraș invalid.');
    if (state.stations[city] !== undefined) throw new GameError('Orașul are deja o gară.');
    if (me.stations.length >= MAX_STATIONS) throw new GameError(`Ai deja ${MAX_STATIONS} gări.`);
    const pay = payment(me.hand, typeof action.color === 'string' && COLORS.includes(action.color) ? action.color : null, STATION_COST);
    if (!pay) throw new GameError(`O gară costă ${STATION_COST} cărți de aceeași culoare.`);
    spend(state, me, pay.spent);
    state.stations[city] = p;
    me.stations.push(city);
    events.push({ k: 'station', player: p, city, spent: pay.spent });
    endTurn(state, rng, events);
    return done(state, rng, events, p, action);
  }

  if (t === 'drawTickets') {
    if (!state.ticketDeck.length) throw new GameError('Nu mai sunt bilete.');
    me.pending = state.ticketDeck.splice(0, 3);
    events.push({ k: 'ticketsDrawn', player: p, count: me.pending.length });
    return done(state, rng, events, p, action);
  }

  throw new GameError('Acțiune necunoscută.');
}

function done(state, rng, events, p, action) {
  state.seq += 1;
  state.rng = rng.s;
  state.lastAction = { player: p, type: action.type };
  return { state, events };
}

// ---------------------------------------------------------------- hidden information

/** What player `p` may see ('spectator' sees only public info, 'all' sees everything). */
export function viewFor(state, p) {
  const all = p === 'all';
  const players = state.players.map((pl, i) => {
    const mine = all || i === p;
    const over = state.phase === 'over';
    return {
      trains: pl.trains,
      handCount: handSize(pl.hand),
      hand: mine ? clone(pl.hand) : null,
      ticketCount: pl.tickets.length,
      tickets: mine || over ? pl.tickets.map((id) => ({ ...ticketById(id), done: connected(state, i, ticketById(id).a, ticketById(id).b) })) : null,
      pending: mine ? pl.pending.map((id) => ticketById(id)) : null,
      pendingCount: pl.pending.length,
      contracts: pl.contracts.map((id) => ({ ...ticketById(id), done: mine || over ? connected(state, i, ticketById(id).a, ticketById(id).b) : null })),
      stations: [...pl.stations],
      routePoints: pl.routePoints,
      toll: pl.toll,
      score: pl.routePoints + pl.toll,
    };
  });
  return {
    me: p,
    names: clone(state.opts.names),
    phase: state.phase,
    active: state.active,
    turnNo: state.turnNo,
    drawn: state.drawn,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    market: [...state.market],
    players,
    routes: clone(state.routes),
    stations: clone(state.stations),
    ticketDeckCount: state.ticketDeck.length,
    auction: state.auction ? { contract: ticketById(state.auction.contract), placed: state.auction.bids.map(Boolean) } : null,
    auctionsDone: state.auctionsDone,
    finalTurns: state.finalTurns,
    result: state.result ? clone(state.result) : null,
    seq: state.seq,
  };
}

/** Events with other players' secrets removed. */
export function eventsFor(events, p) {
  if (p === 'all') return events;
  return events.filter((e) => !(e.secret && e.player !== p)).map((e) => {
    if (e.k === 'draw' && e.player !== p && e.from === 'deck') return { ...e, card: null };
    if (e.k === 'ticketsKept' && e.player !== p) return { ...e, ids: null };
    return e;
  });
}

export function replay(options, actions) {
  let state = createGame(options);
  for (const [p, action] of actions) state = applyAction(state, p, action).state;
  return state;
}
