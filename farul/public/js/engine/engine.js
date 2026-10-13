// Farul — pure, deterministic game engine shared by the server and the browser.
// Roles: 'A' = Paznicul farului (sees the storm forecast), 'B' = Căpitanul portului
// (sees what the ports demand). 'both' is the single-phone training view.
import { Rng } from './rng.js';
import { neighbors, distance, reach, pathTo } from './hex.js';

export const COLS = 7;
export const ROWS = 11;
export const GOODS = ['peste', 'sare', 'lemn'];
export const CARGO = [...GOODS, 'ulei'];
export const MAX_LIGHT = 3;
export const MAX_HULL = 2;
export const HAND_SIZE = 3;
export const PLAYS_PER_NIGHT = 2;

export const DIFFICULTIES = {
  usor: { label: 'Ușor', target: 6, nights: 10, cells: [2, 2, 2], cellSize: 2, window: 4, maxDemands: 3, burnEvery: 4 },
  normal: { label: 'Normal', target: 7, nights: 10, cells: [2, 2, 3], cellSize: 3, window: 3, maxDemands: 3, burnEvery: 4 },
  furtuna: { label: 'Furtună', target: 8, nights: 10, cells: [2, 3, 3], cellSize: 3, window: 3, maxDemands: 3, burnEvery: 3 },
};
export const RELICS = {
  none: { label: 'Fără relicvă' },
  lamp: { label: 'Felinarul bunicului', desc: 'Primul far care s-ar stinge rămâne aprins cu o flacără.' },
  map: { label: 'Harta veche', desc: 'Paznicul vede furtunile cu încă o noapte înainte.' },
  compass: { label: 'Busola', desc: 'Prima carte „Navighează” a fiecăruia, în fiecare noapte, are +1 rază.' },
};
export const MODES = { silent: 'Liniște radio', talk: 'Vorbit liber' };

export const CARDS = {
  sail2: { name: 'Navighează 3', icon: '⛵', desc: 'Mută orice navă până la 3 hexuri.', count: 8 },
  sail3: { name: 'Navighează 4', icon: '🌊', desc: 'Mută orice navă până la 4 hexuri.', count: 6 },
  tailwind: { name: 'Vânt din pupa', icon: '💨', desc: 'Mută două nave diferite, câte până la 3 hexuri.', count: 3 },
  tug: { name: 'Remorcher', icon: '⚓', desc: 'Mută o navă până la 5 hexuri și repar-o cu 1.', count: 2 },
  oil: { name: 'Ulei de rezervă', icon: '🕯️', desc: '+1 lumină la un far care are o navă în port sau lângă el.', count: 3 },
  anchor: { name: 'Adăpost', icon: '🛡️', desc: 'O navă nu poate fi lovită de furtună în noaptea asta.', count: 3 },
  radio: { name: 'Radio', icon: '📻', desc: '+1 semnal pentru amândoi. Paznicul vede o noapte în plus; Căpitanul vede următoarea cerere.', count: 3 },
};
export const SAIL_RANGE = { sail2: 3, sail3: 4, tug: 5, tailwind: 3 };

export const ITEMS = {
  barrel: { name: 'Butoi de ulei', icon: '🛢️' },
  bottle: { name: 'Sticlă cu mesaj', icon: '🍾' },
  ring: { name: 'Colac de salvare', icon: '🛟' },
  shell: { name: 'Scoică de aur', icon: '🐚' },
};

const PORT_NAMES = ['Sulina', 'Mangalia', 'Vama Veche', 'Tuzla', 'Midia', 'Jurilovca', 'Portița', 'Sf. Gheorghe', 'Năvodari', 'Eforie', 'Periboina', 'Chituc'];
const SHIP_NAMES = { A: ['Aurora', 'Bora'], B: ['Cleo', 'Delta'] };

export const other = (role) => (role === 'A' ? 'B' : 'A');
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- map

function generateMap(rng) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const n = COLS * ROWS;
    let noise = Array.from({ length: n }, () => rng.next());
    for (let k = 0; k < 2; k++) {
      noise = noise.map((v, i) => {
        const nb = neighbors(i, COLS, ROWS);
        return (v + nb.reduce((s, j) => s + noise[j], 0)) / (nb.length + 1);
      });
    }
    const score = noise.map((v, i) => {
      const c = i % COLS, r = (i / COLS) | 0;
      const edge = Math.min(c, COLS - 1 - c, r, ROWS - 1 - r);
      return v + (edge === 0 ? 0.32 : edge === 1 ? 0.08 : 0);
    });
    const sorted = [...score].sort((a, b) => b - a);
    const cut = sorted[Math.round(n * 0.3)];
    const tiles = score.map((s) => (s > cut ? 'land' : 'sea'));

    // keep only the largest sea basin
    const seen = new Set();
    let best = [];
    for (let i = 0; i < n; i++) {
      if (tiles[i] !== 'sea' || seen.has(i)) continue;
      const comp = [i];
      seen.add(i);
      for (let q = 0; q < comp.length; q++) {
        for (const j of neighbors(comp[q], COLS, ROWS)) {
          if (tiles[j] === 'sea' && !seen.has(j)) { seen.add(j); comp.push(j); }
        }
      }
      if (comp.length > best.length) best = comp;
    }
    const basin = new Set(best);
    for (let i = 0; i < n; i++) if (tiles[i] === 'sea' && !basin.has(i)) tiles[i] = 'land';
    if (basin.size < 42) continue;

    const coastal = [];
    for (let i = 0; i < n; i++) {
      if (tiles[i] === 'land' && neighbors(i, COLS, ROWS).some((j) => tiles[j] === 'sea')) coastal.push(i);
    }
    if (coastal.length < 8) continue;

    const center = Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2);
    coastal.sort((a, b) => distance(a, center, COLS) - distance(b, center, COLS) || a - b);
    const chosen = [coastal[0]];
    while (chosen.length < 6) {
      let pick = -1, pickD = -1;
      for (const h of coastal) {
        if (chosen.includes(h)) continue;
        const d = Math.min(...chosen.map((x) => distance(x, h, COLS)));
        if (d > pickD) { pickD = d; pick = h; }
      }
      if (pickD < 3) break;
      chosen.push(pick);
    }
    if (chosen.length < 6) continue;

    const names = rng.shuffle([...PORT_NAMES]);
    const products = rng.shuffle(['peste', 'sare', 'lemn', ...rng.shuffle([...GOODS]).slice(0, 2)]);
    const ports = chosen.map((hex, id) =>
      id === 0
        ? { id, hex, kind: 'depot', name: 'Depozitul', product: 'ulei', light: MAX_LIGHT }
        : { id, hex, kind: 'port', name: names[id - 1], product: products[id - 1], light: MAX_LIGHT },
    );
    return { tiles, ports };
  }
  throw new Error('map generation failed');
}

function seaHexes(state) {
  const out = [];
  state.tiles.forEach((t, i) => { if (t === 'sea') out.push(i); });
  return out;
}

function stormCellsFor(diff, night) {
  return diff.cells[night <= 3 ? 0 : night <= 6 ? 1 : 2];
}

function generateStorms(rng, tiles, diff, nights) {
  const sea = [];
  tiles.forEach((t, i) => { if (t === 'sea') sea.push(i); });
  const queue = [];
  const eyes = [];
  for (let night = 1; night <= nights + 3; night++) {
    const hexes = new Set();
    const nightEyes = [];
    const cells = stormCellsFor(diff, night);
    for (let k = 0; k < cells; k++) {
      const center = rng.pick(sea);
      nightEyes.push(center);
      hexes.add(center);
      const nb = rng.shuffle(neighbors(center, COLS, ROWS));
      for (let j = 0; j < diff.cellSize - 1 && j < nb.length; j++) hexes.add(nb[j]);
    }
    queue.push([...hexes].sort((a, b) => a - b));
    eyes.push(nightEyes);
  }
  return { queue, eyes };
}

function generateDemandQueue(rng, ports) {
  const trade = ports.filter((p) => p.kind === 'port');
  return Array.from({ length: 60 }, () => {
    const port = rng.pick(trade);
    const good = rng.pick(GOODS.filter((g) => g !== port.product));
    return { port: port.id, good };
  });
}

// ---------------------------------------------------------------- setup

export function validateOptions(opts = {}) {
  const difficulty = Object.hasOwn(DIFFICULTIES, opts.difficulty) ? opts.difficulty : 'normal';
  const relic = Object.hasOwn(RELICS, opts.relic) ? opts.relic : 'none';
  const mode = Object.hasOwn(MODES, opts.mode) ? opts.mode : 'silent';
  const seed = Number.isInteger(opts.seed) ? opts.seed >>> 0 : Math.floor(Math.random() * 2 ** 32);
  const names = { A: cleanName(opts.names?.A, 'Paznicul'), B: cleanName(opts.names?.B, 'Căpitanul') };
  return { difficulty, relic, mode, seed, names };
}

function cleanName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || fallback;
}

export function createGame(options) {
  const opts = validateOptions(options);
  const diff = DIFFICULTIES[opts.difficulty];
  const rng = new Rng(opts.seed);
  const { tiles, ports } = generateMap(rng);
  const depot = ports[0].hex;
  const ships = [];
  for (const owner of ['A', 'B']) {
    SHIP_NAMES[owner].forEach((name) => {
      ships.push({ id: ships.length, owner, name, hex: depot, hull: MAX_HULL, cargo: [], anchored: 0 });
    });
  }
  const storms = generateStorms(rng, tiles, diff, diff.nights);
  const deck = [];
  let cid = 0;
  for (const [type, def] of Object.entries(CARDS)) {
    for (let k = 0; k < def.count; k++) deck.push({ id: cid++, type });
  }
  rng.shuffle(deck);
  const state = {
    v: 1,
    opts,
    target: diff.target + (opts.mode === 'talk' ? 2 : 0),
    maxNights: diff.nights,
    night: 1,
    phase: 'play',
    tiles,
    ports,
    ships,
    deck,
    discard: [],
    hands: { A: [], B: [] },
    starter: 'A',
    turn: 0,
    signals: [],
    signalsUsed: { A: 0, B: 0 },
    signalCap: 2,
    storms: storms.queue,
    stormEyes: storms.eyes,
    demandQueue: generateDemandQueue(rng, ports),
    demands: [],
    demandSeq: 0,
    items: [],
    itemSeq: 0,
    delivered: 0,
    sunk: 0,
    shells: 0,
    radio: { A: 0, B: 0 },
    compass: { A: 0, B: 0 },
    lampUsed: false,
    result: null,
    seq: 0,
    rng: 0,
  };
  const events = [];
  dawn(state, rng, events, true);
  state.rng = rng.s;
  return state;
}

// ---------------------------------------------------------------- helpers

export function activeRole(state) {
  if (state.phase !== 'play') return null;
  return state.turn % 2 === 0 ? state.starter : other(state.starter);
}

export function portAt(state, hex) {
  return state.ports.find((p) => p.hex === hex) || null;
}

export function isPassable(state, hex) {
  return state.tiles[hex] === 'sea' || state.ports.some((p) => p.hex === hex);
}

function portOpen(port) {
  return port.kind === 'depot' || port.light > 0;
}

export function sailRange(state, role, cardType) {
  let range = SAIL_RANGE[cardType] || 0;
  if (state.opts.relic === 'compass' && (cardType === 'sail2' || cardType === 'sail3') && state.compass[role] !== state.night) range += 1;
  return range;
}

export function reachable(state, shipId, range) {
  const ship = state.ships[shipId];
  if (!ship) return new Map();
  return reach(ship.hex, range, (h) => isPassable(state, h), COLS, ROWS).dist;
}

function drawCard(state, rng) {
  if (!state.deck.length) {
    if (!state.discard.length) return null;
    state.deck = rng.shuffle(state.discard);
    state.discard = [];
  }
  return state.deck.pop();
}

function setLight(state, port, value, why, events) {
  let to = Math.max(0, Math.min(MAX_LIGHT, value));
  if (to === 0 && port.light > 0 && state.opts.relic === 'lamp' && !state.lampUsed) {
    state.lampUsed = true;
    to = 1;
    events.push({ k: 'relic', relic: 'lamp', port: port.id });
  }
  if (to === port.light) return;
  events.push({ k: 'light', port: port.id, from: port.light, to, why });
  port.light = to;
}

function darkCount(state) {
  return state.ports.filter((p) => p.kind === 'port' && p.light === 0).length;
}

// ---------------------------------------------------------------- night cycle

function dawn(state, rng, events, first = false) {
  const diff = DIFFICULTIES[state.opts.difficulty];
  if (!first) {
    state.night += 1;
    state.starter = other(state.starter);
    state.turn = 0;
  }
  state.signals = [];
  state.signalsUsed = { A: 0, B: 0 };
  state.signalCap = 2;
  events.push({ k: 'dawn', night: state.night, starter: state.starter });

  const wanted = first ? 2 : 1;
  for (let added = 0; added < wanted && state.demands.length < diff.maxDemands; ) {
    const next = state.demandQueue.shift();
    if (!next) break;
    const port = state.ports[next.port];
    if (!portOpen(port) || state.demands.some((d) => d.port === next.port)) continue;
    const demand = { id: state.demandSeq++, port: next.port, good: next.good, due: state.night + diff.window - 1 };
    state.demands.push(demand);
    events.push({ k: 'demand', ...demand });
    added++;
  }

  if (state.night % 2 === 1) {
    const taken = new Set([...state.items.map((it) => it.hex), ...state.ships.map((s) => s.hex)]);
    const free = seaHexes(state).filter((h) => !taken.has(h));
    if (free.length) {
      const r = rng.next();
      const kind = r < 0.35 ? 'barrel' : r < 0.6 ? 'bottle' : r < 0.8 ? 'ring' : 'shell';
      const item = { id: state.itemSeq++, hex: rng.pick(free), kind };
      state.items.push(item);
      events.push({ k: 'item', ...item });
    }
  }

  for (const role of ['A', 'B']) {
    while (state.hands[role].length < HAND_SIZE) {
      const card = drawCard(state, rng);
      if (!card) break;
      state.hands[role].push(card);
    }
  }
}

function resolveNight(state, rng, events) {
  const diff = DIFFICULTIES[state.opts.difficulty];
  const storm = new Set(state.storms[state.night - 1] || []);
  events.push({ k: 'storm', night: state.night, hexes: [...storm], eyes: state.stormEyes[state.night - 1] || [] });

  const depot = state.ports[0];
  for (const ship of state.ships) {
    if (!storm.has(ship.hex)) continue;
    const port = portAt(state, ship.hex);
    if (port && portOpen(port)) { events.push({ k: 'shelter', ship: ship.id }); continue; }
    if (ship.anchored === state.night) { events.push({ k: 'shelter', ship: ship.id }); continue; }
    ship.hull -= 1;
    events.push({ k: 'hit', ship: ship.id, hull: ship.hull });
    if (ship.hull <= 0) {
      const lost = ship.cargo;
      ship.cargo = [];
      ship.hull = MAX_HULL;
      const from = ship.hex;
      ship.hex = depot.hex;
      state.sunk += 1;
      events.push({ k: 'sink', ship: ship.id, from, to: depot.hex, lost });
    }
  }

  // a lighthouse is struck when the eye of a storm passes next to it
  const eyes = state.stormEyes[state.night - 1] || [];
  for (const port of state.ports) {
    if (port.kind !== 'port' || port.light === 0) continue;
    if (eyes.some((e) => distance(e, port.hex, COLS) <= 1)) setLight(state, port, port.light - 1, 'storm', events);
  }

  if (state.night % diff.burnEvery === 0) {
    events.push({ k: 'burn' });
    for (const port of state.ports) {
      if (port.kind === 'port' && port.light > 0) setLight(state, port, port.light - 1, 'burn', events);
    }
  }

  for (const d of [...state.demands]) {
    if (d.due > state.night) continue;
    state.demands = state.demands.filter((x) => x !== d);
    events.push({ k: 'expire', id: d.id, port: d.port, good: d.good });
    const port = state.ports[d.port];
    if (port.light > 0) setLight(state, port, port.light - 1, 'expire', events);
  }
  // a dark port cannot hold a demand
  for (const d of [...state.demands]) {
    if (state.ports[d.port].light === 0) {
      state.demands = state.demands.filter((x) => x !== d);
      events.push({ k: 'expire', id: d.id, port: d.port, good: d.good });
    }
  }

  for (const ship of state.ships) {
    const port = portAt(state, ship.hex);
    if (port && portOpen(port) && ship.hull < MAX_HULL) {
      ship.hull += 1;
      events.push({ k: 'repair', ship: ship.id, hull: ship.hull });
    }
  }

  if (darkCount(state) >= 3) return finish(state, false, 'dark', events);
  if (state.delivered >= state.target) return finish(state, true, 'target', events);
  if (state.night >= state.maxNights) return finish(state, false, 'time', events);
  dawn(state, rng, events);
}

function finish(state, win, reason, events) {
  state.phase = 'over';
  const lit = state.ports.filter((p) => p.kind === 'port' && p.light > 0).length;
  const lightSum = state.ports.reduce((s, p) => s + (p.kind === 'port' ? p.light : 0), 0);
  let stars = 0;
  if (win) {
    stars = 1;
    if (state.sunk === 0) stars++;
    if (lit === 5) stars++;
  }
  const score = state.delivered * 100 + lightSum * 20 + (win ? (state.maxNights - state.night) * 60 : 0) + state.shells * 50;
  const shells = Math.max(1, stars * 3 + state.delivered + state.shells * 2);
  state.result = { win, reason, stars, score, shells, nights: state.night, lit };
  events.push({ k: 'over', ...state.result });
}

// ---------------------------------------------------------------- arrival

function arrive(state, ship, load, events) {
  const item = state.items.find((it) => it.hex === ship.hex);
  if (item) {
    let taken = true;
    if (item.kind === 'barrel') {
      if (ship.cargo.length < 2) ship.cargo.push('ulei');
      else taken = false;
    } else if (item.kind === 'bottle') state.signalCap += 1;
    else if (item.kind === 'ring') ship.hull = MAX_HULL;
    else if (item.kind === 'shell') state.shells += 1;
    if (taken) {
      state.items = state.items.filter((it) => it !== item);
      events.push({ k: 'pickup', ship: ship.id, item: item.kind, hex: item.hex });
    }
  }

  const port = portAt(state, ship.hex);
  if (!port) return;

  if (port.kind === 'port' && port.light < MAX_LIGHT && ship.cargo.includes('ulei')) {
    ship.cargo.splice(ship.cargo.indexOf('ulei'), 1);
    events.push({ k: 'unload', ship: ship.id, port: port.id, good: 'ulei' });
    setLight(state, port, port.light + 2, 'oil', events);
  }
  if (!portOpen(port)) return;

  for (const d of [...state.demands]) {
    if (d.port !== port.id) continue;
    const at = ship.cargo.indexOf(d.good);
    if (at < 0) continue;
    ship.cargo.splice(at, 1);
    state.demands = state.demands.filter((x) => x !== d);
    state.delivered += 1;
    events.push({ k: 'deliver', ship: ship.id, port: port.id, good: d.good, id: d.id, delivered: state.delivered });
    setLight(state, port, port.light + 1, 'deliver', events);
  }

  if (load) {
    let dropped = null;
    if (ship.cargo.length >= 2) dropped = ship.cargo.shift();
    ship.cargo.push(port.product);
    events.push({ k: 'load', ship: ship.id, port: port.id, good: port.product, dropped });
  }
}

function moveShip(state, role, shipId, to, range, load, events) {
  const ship = state.ships[shipId];
  if (!ship) throw new GameError('Navă necunoscută.');
  if (!Number.isInteger(to) || to < 0 || to >= state.tiles.length) throw new GameError('Destinație invalidă.');
  const { dist, prev } = reach(ship.hex, range, (h) => isPassable(state, h), COLS, ROWS);
  if (!dist.has(to)) throw new GameError('Nava nu ajunge acolo.');
  const path = pathTo(prev, ship.hex, to);
  ship.hex = to;
  events.push({ k: 'move', ship: shipId, path, by: role });
  arrive(state, ship, load === true, events);
}

// ---------------------------------------------------------------- actions

export class GameError extends Error {}

/**
 * Applies an action for a role. Mutates a copy and returns { state, events }.
 * Throws GameError for illegal actions (the original state is untouched).
 */
export function applyAction(prevState, role, action) {
  if (role !== 'A' && role !== 'B') throw new GameError('Rol invalid.');
  if (!action || typeof action !== 'object') throw new GameError('Acțiune invalidă.');
  if (prevState.phase !== 'play') throw new GameError('Partida s-a încheiat.');
  const state = clone(prevState);
  const rng = new Rng(state.rng);
  const events = [];

  if (action.type === 'signal') {
    if (state.signalsUsed[role] >= state.signalCap) throw new GameError('Nu mai ai semnale în noaptea asta.');
    const hex = action.hex;
    if (!Number.isInteger(hex) || hex < 0 || hex >= state.tiles.length) throw new GameError('Hex invalid.');
    const kind = action.kind === 'want' ? 'want' : 'danger';
    let good = null;
    if (kind === 'want') {
      if (!portAt(state, hex)) throw new GameError('Cererile se semnalează pe porturi.');
      if (!CARGO.includes(action.good)) throw new GameError('Marfă invalidă.');
      good = action.good;
    }
    const signal = { by: role, hex, kind, good };
    state.signals.push(signal);
    state.signalsUsed[role] += 1;
    events.push({ k: 'signal', ...signal });
    state.seq++;
    state.rng = rng.s;
    return { state, events };
  }

  if (activeRole(state) !== role) throw new GameError('Nu e rândul tău.');
  const hand = state.hands[role];
  const at = hand.findIndex((c) => c.id === action.card);
  if (at < 0) throw new GameError('Cartea nu e în mâna ta.');
  const card = hand[at];

  if (action.type === 'discard') {
    events.push({ k: 'discard', by: role, card });
  } else if (action.type === 'play') {
    events.push({ k: 'play', by: role, card });
    const t = card.type;
    if (t === 'sail2' || t === 'sail3' || t === 'tug') {
      const range = sailRange(state, role, t);
      if (t !== 'tug' && state.opts.relic === 'compass') state.compass[role] = state.night;
      moveShip(state, role, action.ship, action.to, range, action.load, events);
      if (t === 'tug') {
        const ship = state.ships[action.ship];
        if (ship.hull < MAX_HULL) {
          ship.hull += 1;
          events.push({ k: 'repair', ship: ship.id, hull: ship.hull });
        }
      }
    } else if (t === 'tailwind') {
      const moves = Array.isArray(action.moves) ? action.moves.slice(0, 2) : [];
      if (!moves.length) throw new GameError('Alege cel puțin o navă.');
      if (moves.length === 2 && moves[0]?.ship === moves[1]?.ship) throw new GameError('Alege două nave diferite.');
      for (const m of moves) moveShip(state, role, m?.ship, m?.to, SAIL_RANGE.tailwind, m?.load, events);
    } else if (t === 'oil') {
      const port = state.ports[action.port];
      if (!port || port.kind !== 'port') throw new GameError('Alege un far.');
      const near = state.ships.some((s) => s.hex === port.hex || neighbors(port.hex, COLS, ROWS).includes(s.hex));
      if (!near) throw new GameError('Ai nevoie de o navă în port sau lângă far.');
      if (port.light >= MAX_LIGHT) throw new GameError('Farul arde deja la maxim.');
      setLight(state, port, port.light + 1, 'card', events);
    } else if (t === 'anchor') {
      const ship = state.ships[action.ship];
      if (!ship) throw new GameError('Alege o navă.');
      ship.anchored = state.night;
      events.push({ k: 'anchor', ship: ship.id });
    } else if (t === 'radio') {
      state.signalCap += 1;
      state.radio[role] = state.night;
      events.push({ k: 'radio', by: role });
    } else {
      throw new GameError('Carte necunoscută.');
    }
  } else {
    throw new GameError('Acțiune necunoscută.');
  }

  hand.splice(at, 1);
  state.discard.push(card);
  state.turn += 1;
  if (state.turn >= PLAYS_PER_NIGHT * 2) resolveNight(state, rng, events);
  else events.push({ k: 'turn', active: activeRole(state) });
  state.seq++;
  state.rng = rng.s;
  return { state, events };
}

// ---------------------------------------------------------------- hidden information

function forecastNights(state, role) {
  if (role === 'B') return 0;
  let n = 2;
  if (state.opts.relic === 'map') n++;
  if (state.radio.A === state.night) n++;
  return n;
}

/** What a role is allowed to see. Never send the raw state to a client. */
export function viewFor(state, role) {
  const seesStorms = role === 'A' || role === 'both';
  const seesDemands = role === 'B' || role === 'both';
  const forecast = [];
  if (seesStorms && state.phase === 'play') {
    const n = role === 'both' ? Math.max(forecastNights(state, 'A'), 2) : forecastNights(state, 'A');
    for (let k = 0; k < n; k++) {
      const hexes = state.storms[state.night - 1 + k];
      if (hexes) forecast.push({ night: state.night + k, hexes, eyes: state.stormEyes[state.night - 1 + k] || [] });
    }
  }
  let nextDemand = null;
  if (seesDemands && (state.radio.B === state.night || role === 'both')) {
    const next = state.demandQueue.find((d) => portOpen(state.ports[d.port]) && !state.demands.some((x) => x.port === d.port));
    if (next) nextDemand = next;
  }
  const hand = (r) => (role === r || role === 'both' ? clone(state.hands[r]) : state.hands[r].length);
  return {
    role,
    opts: clone(state.opts),
    target: state.target,
    maxNights: state.maxNights,
    night: state.night,
    phase: state.phase,
    active: activeRole(state),
    turn: state.turn,
    starter: state.starter,
    tiles: state.tiles,
    ports: clone(state.ports),
    ships: clone(state.ships),
    hands: { A: hand('A'), B: hand('B') },
    deckCount: state.deck.length,
    signals: clone(state.signals),
    signalsUsed: clone(state.signalsUsed),
    signalCap: state.signalCap,
    demands: state.demands.map((d) => (seesDemands ? clone(d) : { id: d.id, port: d.port, due: d.due, good: null })),
    nextDemand,
    forecast,
    items: clone(state.items),
    delivered: state.delivered,
    sunk: state.sunk,
    shells: state.shells,
    compassReady: { A: state.compass.A !== state.night, B: state.compass.B !== state.night },
    result: state.result ? clone(state.result) : null,
    seq: state.seq,
  };
}

export function eventsFor(events, role) {
  if (role === 'B' || role === 'both') return events;
  return events.map((e) => (e.k === 'demand' ? { ...e, good: null } : e));
}

/** Rebuilds a game from its options and the ordered list of [role, action] pairs. */
export function replay(options, actions) {
  let state = createGame(options);
  for (const [role, action] of actions) state = applyAction(state, role, action).state;
  return state;
}
