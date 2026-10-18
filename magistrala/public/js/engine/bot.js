// A simple training opponent: plans shortest paths for its tickets, collects the colors
// it needs, claims routes on its plan, and bids modestly in auctions.
import { ROUTES, COLORS, WILD, CITIES, ticketById, payment, connected, STATION_COST, MAX_STATIONS, handSize } from './engine.js';

function planRoutes(state, p, tickets) {
  // Dijkstra per ticket where own routes cost 0 and the opponent's are blocked.
  const need = new Map();
  for (const id of tickets) {
    const t = ticketById(id);
    if (connected(state, p, t.a, t.b)) continue;
    const dist = { [t.a]: 0 };
    const via = {};
    const todo = new Set(Object.keys(CITIES));
    while (todo.size) {
      let cur = null;
      for (const c of todo) if (dist[c] !== undefined && (cur === null || dist[c] < dist[cur])) cur = c;
      if (cur === null) break;
      todo.delete(cur);
      if (cur === t.b) break;
      for (const r of ROUTES) {
        const owner = state.routes[r.id];
        if (owner !== null && owner !== p) continue;
        const nxt = r.a === cur ? r.b : r.b === cur ? r.a : null;
        if (!nxt) continue;
        const d = dist[cur] + (owner === p ? 0 : r.len);
        if (dist[nxt] === undefined || d < dist[nxt]) { dist[nxt] = d; via[nxt] = r; }
      }
    }
    if (dist[t.b] === undefined) continue;
    let cur = t.b;
    while (cur !== t.a) {
      const r = via[cur];
      if (state.routes[r.id] === null) need.set(r.id, (need.get(r.id) || 0) + t.value);
      cur = r.a === cur ? r.b : r.a;
    }
  }
  return need;
}

export function botAction(state, p) {
  const me = state.players[p];
  if (me.pending.length) {
    const sorted = [...me.pending].sort((a, b) => ticketById(a).value - ticketById(b).value);
    const min = state.phase === 'setup' ? 2 : 1;
    const keep = sorted.filter((id, k) => k < min || ticketById(id).value <= 7);
    return { type: 'keepTickets', keep };
  }
  if (state.phase === 'auction') {
    const value = ticketById(state.auction.contract).value;
    const budget = Math.min(Math.floor(value / 4), handSize(me.hand) - 2);
    const cards = {};
    let left = Math.max(0, budget);
    for (const c of [...COLORS].sort((a, b) => me.hand[a] - me.hand[b])) {
      const n = Math.min(me.hand[c], left);
      if (n) { cards[c] = n; left -= n; }
      if (!left) break;
    }
    return { type: 'bid', cards };
  }
  if (state.drawn) return drawSomething(state, p, new Map(), true);

  const plan = planRoutes(state, p, [...me.tickets, ...me.contracts]);
  // claim the most valuable affordable route on the plan
  const affordable = (r) => state.routes[r.id] === null && me.trains >= r.len && payment(me.hand, r.color, r.len);
  const onPlan = ROUTES.filter((r) => plan.has(r.id) && affordable(r)).sort((a, b) => b.len - a.len || plan.get(b.id) - plan.get(a.id));
  if (onPlan.length) return { type: 'claim', route: onPlan[0].id };

  const late = state.finalTurns !== null || me.trains <= 6 || state.deck.length + state.discard.length < 10;
  if (!plan.size && !late && state.ticketDeck.length && me.trains > 12) return { type: 'drawTickets' };
  if (!plan.size || late) {
    const best = ROUTES.filter(affordable).sort((a, b) => b.len - a.len)[0];
    if (best && (late || best.len >= 3)) return { type: 'claim', route: best.id };
  }
  // speculative station where the opponent is heading
  if (me.stations.length < MAX_STATIONS && handSize(me.hand) >= 9) {
    const opp = 1 - p;
    const counts = {};
    for (const r of ROUTES) {
      if (state.routes[r.id] !== opp) continue;
      for (const c of [r.a, r.b]) if (state.stations[c] === undefined) counts[c] = (counts[c] || 0) + 1;
    }
    const city = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const free = city && ROUTES.some((r) => (r.a === city || r.b === city) && state.routes[r.id] === null);
    if (free && payment(me.hand, null, STATION_COST)) return { type: 'station', city };
  }
  return drawSomething(state, p, plan, false);
}

function drawSomething(state, p, plan, second) {
  const me = state.players[p];
  const wanted = {};
  for (const r of ROUTES) {
    if (!plan.has(r.id)) continue;
    if (r.color === 'gri') continue;
    wanted[r.color] = (wanted[r.color] || 0) + Math.max(0, r.len - me.hand[r.color]);
  }
  let slot = -1;
  let bestScore = 0;
  state.market.forEach((c, i) => {
    if (c === WILD) {
      if (!second && bestScore < 2.5) { bestScore = 2.5; slot = i; }
      return;
    }
    const s = (wanted[c] || 0) > 0 ? 3 + wanted[c] * 0.1 : 0;
    if (s > bestScore) { bestScore = s; slot = i; }
  });
  if (slot >= 0) return { type: 'drawCard', slot };
  if (state.deck.length || state.discard.length) return { type: 'drawCard', slot: 'deck' };
  const nonWild = state.market.findIndex((c) => c !== WILD);
  if (nonWild >= 0) return { type: 'drawCard', slot: nonWild };
  if (!second && state.market.length) return { type: 'drawCard', slot: 0 };
  const any = ROUTES.find((r) => state.routes[r.id] === null && me.trains >= r.len && payment(me.hand, r.color, r.len));
  if (any) return { type: 'claim', route: any.id };
  return { type: 'drawTickets' };
}
