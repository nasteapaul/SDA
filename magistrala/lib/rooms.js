// Game rooms: one authoritative engine state per room, each player gets only their own view.
import crypto from 'node:crypto';
import * as E from '../public/js/engine/engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_ROOMS = 500;
const MAX_ACTIONS = 600;
const ROOM_TTL_MS = 3 * 24 * 3600 * 1000;
const REACTIONS = ['❤️', '👏', '😱', '😂', '🔥', '🙏'];

const isRole = (r) => r === 'A' || r === 'B';
const seat = (role) => (role === 'A' ? 0 : 1);
const isCode = (c) => typeof c === 'string' && /^[A-Z]{4}$/.test(c);
const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

export class Rooms {
  constructor({ onChange } = {}) {
    this.rooms = new Map();
    this.onChange = onChange || (() => {});
  }

  newCode() {
    for (let i = 0; i < 1000; i++) {
      let code = '';
      for (let k = 0; k < 4; k++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('no free room code');
  }

  prune(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const online = room.conns.A.size + room.conns.B.size;
      if (!online && now - room.touched > ROOM_TTL_MS) this.rooms.delete(code);
    }
  }

  makeRoom(code, options, tokens, names, actions = []) {
    const state = E.replay(options, actions);
    const room = {
      code,
      options: state.opts,
      state,
      actions,
      tokens,
      names,
      conns: { A: new Set(), B: new Set() },
      touched: Date.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  /** Snapshot without sockets, for persistence. */
  serialize() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code, options: r.options, actions: r.actions, tokens: r.tokens, names: r.names, touched: r.touched,
    }));
  }

  restoreAll(list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      try {
        if (!isCode(r.code) || this.rooms.has(r.code)) continue;
        const room = this.makeRoom(r.code, r.options, r.tokens, r.names, r.actions);
        room.touched = r.touched || Date.now();
      } catch { /* skip corrupt rooms */ }
    }
  }

  replayFor(room) {
    return { code: room.code, options: room.options, actions: room.actions, tokens: room.tokens, names: room.names };
  }

  players(room) {
    return {
      A: { name: room.names.A || '', online: room.conns.A.size > 0, joined: Boolean(room.names.A || room.conns.A.size || room.joined?.A) },
      B: { name: room.names.B || '', online: room.conns.B.size > 0, joined: Boolean(room.names.B || room.conns.B.size || room.joined?.B) },
    };
  }

  send(conn, msg) {
    try { conn.send(JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  broadcastState(room, events = []) {
    for (const role of ['A', 'B']) {
      for (const conn of room.conns[role]) this.sendState(room, role, conn, events);
    }
  }

  sendState(room, role, conn, events = []) {
    this.send(conn, {
      t: 'state',
      view: E.viewFor(room.state, seat(role)),
      events: E.eventsFor(events, seat(role)),
      players: this.players(room),
      replay: this.replayFor(room),
    });
  }

  broadcastPresence(room) {
    const players = this.players(room);
    for (const role of ['A', 'B']) for (const conn of room.conns[role]) this.send(conn, { t: 'presence', players });
  }

  attach(room, role, conn) {
    if (conn.room) this.detach(conn);
    conn.room = room;
    conn.role = role;
    room.conns[role].add(conn);
    room.touched = Date.now();
    this.send(conn, { t: 'joined', code: room.code, role, token: room.tokens[role] });
    this.sendState(room, role, conn);
    this.broadcastPresence(room);
  }

  detach(conn) {
    const room = conn.room;
    if (!room) return;
    room.conns[conn.role].delete(conn);
    conn.room = null;
    this.broadcastPresence(room);
  }

  handle(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(conn, { t: 'error', msg: 'Mesaj invalid.' });
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.t) {
        case 'ping': return this.send(conn, { t: 'pong' });
        case 'create': return this.create(conn, msg);
        case 'join': return this.join(conn, msg);
        case 'rejoin': return this.rejoin(conn, msg);
        case 'act': return this.act(conn, msg);
        case 'rematch': return this.rematch(conn, msg);
        case 'react': return this.react(conn, msg);
        default: return this.send(conn, { t: 'error', msg: 'Comandă necunoscută.' });
      }
    } catch (err) {
      const text = err instanceof E.GameError ? err.message : 'Eroare pe server.';
      if (!(err instanceof E.GameError)) console.error(err);
      this.send(conn, { t: 'error', msg: text });
    }
  }

  create(conn, msg) {
    this.prune();
    if (this.rooms.size >= MAX_ROOMS) return this.send(conn, { t: 'error', msg: 'Serverul e plin, încearcă mai târziu.' });
    let role = msg.role;
    if (!isRole(role)) role = crypto.randomInt(2) ? 'A' : 'B';
    const o = msg.options || {};
    const options = { auctions: o.auctions !== false, seed: Number.isInteger(o.seed) ? o.seed : crypto.randomInt(2 ** 32) };
    const tokens = { A: crypto.randomBytes(16).toString('hex'), B: crypto.randomBytes(16).toString('hex') };
    const names = { A: '', B: '' };
    names[role] = cleanName(msg.name);
    const room = this.makeRoom(this.newCode(), options, tokens, names);
    room.joined = { A: role === 'A', B: role === 'B' };
    this.attach(room, role, conn);
    this.onChange();
  }

  join(conn, msg) {
    const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
    const room = isCode(code) && this.rooms.get(code);
    if (!room) return this.send(conn, { t: 'error', msg: 'Nu există o cameră cu acest cod.' });
    room.joined ||= { A: Boolean(room.names.A), B: Boolean(room.names.B) };
    const free = ['A', 'B'].find((r) => !room.joined[r]);
    if (!free) return this.send(conn, { t: 'error', msg: 'Camera e deja plină.' });
    room.joined[free] = true;
    room.names[free] = cleanName(msg.name) || room.names[free];
    this.attach(room, free, conn);
    this.onChange();
  }

  rejoin(conn, msg) {
    const { code, role, token } = msg;
    if (!isCode(code) || !isRole(role) || !isToken(token)) return this.send(conn, { t: 'error', msg: 'Date de reconectare invalide.', fatal: true });
    let room = this.rooms.get(code);
    if (!room) {
      // the server restarted: rebuild the room from the replay the client kept
      const rp = msg.replay;
      const ok = rp && rp.code === code && rp.tokens && rp.tokens[role] === token && isToken(rp.tokens.A) && isToken(rp.tokens.B)
        && Array.isArray(rp.actions) && rp.actions.length <= MAX_ACTIONS && rp.options && typeof rp.options === 'object';
      if (!ok) return this.send(conn, { t: 'error', msg: 'Camera nu mai există.', fatal: true });
      try {
        const names = { A: cleanName(rp.names?.A), B: cleanName(rp.names?.B) };
        room = this.makeRoom(code, rp.options, { A: rp.tokens.A, B: rp.tokens.B }, names, rp.actions);
        room.joined = { A: true, B: true };
      } catch {
        return this.send(conn, { t: 'error', msg: 'Camera nu a putut fi refăcută.', fatal: true });
      }
    }
    if (room.tokens[role] !== token) return this.send(conn, { t: 'error', msg: 'Cod de acces greșit.', fatal: true });
    if (typeof msg.name === 'string' && cleanName(msg.name)) room.names[role] = cleanName(msg.name);
    room.joined ||= {};
    room.joined[role] = true;
    this.attach(room, role, conn);
    this.onChange();
  }

  act(conn, msg) {
    const room = conn.room;
    if (!room) return this.send(conn, { t: 'error', msg: 'Nu ești într-o cameră.' });
    if (room.actions.length >= MAX_ACTIONS) return this.send(conn, { t: 'error', msg: 'Partida e prea lungă.' });
    const action = sanitizeAction(msg.action);
    const { state, events } = E.applyAction(room.state, seat(conn.role), action);
    room.state = state;
    room.actions.push([seat(conn.role), action]);
    room.touched = Date.now();
    this.broadcastState(room, events);
    this.onChange();
  }

  rematch(conn, msg) {
    const room = conn.room;
    if (!room) return;
    if (room.state.phase !== 'over') return this.send(conn, { t: 'error', msg: 'Partida nu s-a terminat.' });
    room.actions = [];
    room.state = E.createGame({ auctions: room.options.auctions, seed: crypto.randomInt(2 ** 32) });
    room.options = room.state.opts;
    this.broadcastState(room, [{ k: 'rematch' }]);
    this.onChange();
  }

  react(conn, msg) {
    const room = conn.room;
    if (!room || !REACTIONS.includes(msg.emoji)) return;
    const now = Date.now();
    if (conn.lastReact && now - conn.lastReact < 600) return;
    conn.lastReact = now;
    for (const r of ['A', 'B']) for (const c of room.conns[r]) this.send(c, { t: 'react', emoji: msg.emoji, from: conn.role });
  }
}

const int = (v) => (Number.isInteger(v) ? v : undefined);

/** Copy only known fields with primitive types; the engine validates the values. */
export function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return {};
  const out = { type: typeof a.type === 'string' ? a.type : '' };
  if (int(a.route) !== undefined) out.route = a.route;
  if (a.slot === 'deck' || int(a.slot) !== undefined) out.slot = a.slot;
  for (const k of ['city', 'color']) if (typeof a[k] === 'string' && a[k].length < 20) out[k] = a[k];
  if (Array.isArray(a.keep)) out.keep = a.keep.filter((x) => int(x) !== undefined).slice(0, 3);
  if (a.cards && typeof a.cards === 'object') {
    out.cards = {};
    for (const [k, v] of Object.entries(a.cards)) if (/^[a-z]{2,10}$/.test(k) && int(v) !== undefined) out.cards[k] = v;
  }
  return out;
}
