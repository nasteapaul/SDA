// Magistrala — screens, HUD, input and the event animation timeline on top of the 3D board.
import * as E from './engine/engine.js';
import { CITIES, ROUTES, COLORS, WILD } from './engine/map.js';
import { Board } from './scene.js';
import { sfx, haptic, unlockAudio, setMuted, isMuted } from './fx.js';
import { OnlineGame, loadSession, saveSession } from './net.js';
import { BotGame } from './local.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_TYPES = [...COLORS, WILD];
const city = (id) => CITIES[id].name;
const routeName = (r) => `${city(r.a)} – ${city(r.b)}`;

// ------------------------------------------------------------ card art

const CAR_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="9" width="24" height="12" rx="2.5" fill="currentColor"/><rect x="7" y="12" width="5" height="4" rx="1" fill="rgba(0,0,0,.35)"/><rect x="13.5" y="12" width="5" height="4" rx="1" fill="rgba(0,0,0,.35)"/><rect x="20" y="12" width="5" height="4" rx="1" fill="rgba(0,0,0,.35)"/><circle cx="10" cy="23.5" r="2.6" fill="currentColor"/><circle cx="22" cy="23.5" r="2.6" fill="currentColor"/></svg>';
const LOCO_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 22V13h12v-3h4v3h3l3 4v5z" fill="#fff"/><rect x="7" y="6" width="3" height="7" fill="#fff"/><circle cx="10" cy="24" r="2.6" fill="#fff"/><circle cx="21" cy="24" r="2.6" fill="#fff"/><rect x="19" y="14.5" width="4" height="3" fill="rgba(0,0,0,.35)"/></svg>';
const iconColor = (c) => (c === 'galben' || c === 'alb' ? '#3a2a10' : 'rgba(255,255,255,.92)');

function cardHtml(c, extra = '', inner = '') {
  if (c === null || c === 'back') return `<div class="card back ${extra}">${CAR_ICON.replace(/currentColor/g, '#d9b264')}${inner}</div>`;
  const icon = c === WILD ? LOCO_ICON : CAR_ICON.replace(/currentColor/g, iconColor(c));
  return `<div class="card c-${c} ${extra}">${icon}${inner}</div>`;
}

// ------------------------------------------------------------ profile

let profile = { name: '' };
try { profile = { ...profile, ...JSON.parse(localStorage.getItem('magistrala.profile') || '{}') }; } catch { /* ignore */ }
const saveProfile = () => { try { localStorage.setItem('magistrala.profile', JSON.stringify(profile)); } catch { /* ignore */ } };

// ------------------------------------------------------------ screens & toasts

let screen = 'home';
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  screen = id;
  if (id === 'home') refreshHome();
}

function toast(text, kind = '', life = 2.6) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.style.setProperty('--life', `${life}s`);
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), (life + 0.5) * 1000);
}

function banner(title, sub = '') {
  const b = $('#banner');
  b.innerHTML = `<b>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</b>`;
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
  return wait(1300);
}

function floatPts(pos, text, color) {
  const el = document.createElement('div');
  el.className = 'float-pts';
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y - 20}px`;
  if (color) el.style.color = color;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Fly an HTML snippet from one screen point to another. */
function fly(html, from, to, { dur = 520, delay = 0, endScale = 0.7 } = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'fly';
      el.innerHTML = html;
      el.style.transitionDuration = `${dur}ms`;
      el.style.transform = `translate(${from.x - 24}px, ${from.y - 33}px)`;
      $('#flyLayer').appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transform = `translate(${to.x - 24}px, ${to.y - 33}px) rotate(${(Math.random() - 0.5) * 30}deg) scale(${endScale})`;
        el.style.opacity = '0.2';
      }));
      setTimeout(() => { el.remove(); resolve(); }, dur + 30);
    }, delay);
  });
}

// ------------------------------------------------------------ sheets & modal

let sheetLocked = false;
let sheetKind = null;
function openSheet(html, { locked = false, kind = null, onClose } = {}) {
  const sh = $('#sheet');
  sh.innerHTML = html;
  sh.classList.add('open');
  $('#sheetBackdrop').classList.add('open');
  sheetLocked = locked;
  sheetKind = kind;
  sh._onClose = onClose;
  return sh;
}
function closeSheet() {
  const sh = $('#sheet');
  if (!sh.classList.contains('open')) return;
  sh.classList.remove('open');
  $('#sheetBackdrop').classList.remove('open');
  sheetLocked = false;
  sheetKind = null;
  const cb = sh._onClose;
  sh._onClose = null;
  cb?.();
}
$('#sheetBackdrop').addEventListener('click', () => { if (!sheetLocked) { closeSheet(); clearFocus(); } });

function modal(html, binds = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-card">${html}</div>`;
  m.classList.remove('hidden');
  m.onclick = (e) => {
    if (e.target === m) m.classList.add('hidden');
    const b = e.target.closest('[data-act]');
    if (b && binds[b.dataset.act]) binds[b.dataset.act]();
  };
}
const closeModal = () => $('#modal').classList.add('hidden');

// ------------------------------------------------------------ board

const board = new Board($('#stage'), { onTap: (hit) => onBoardTap(hit) });
window.magistrala = { board, view: () => view, ctl: () => ctl, busy: () => busy };

function clearFocus() {
  board.setHighlight({});
  board.setBeacons([]);
}

function layoutInsets() {
  if (screen !== 'game') {
    board.setInsets(0, 0);
    return;
  }
  const top = $('#hudTop').getBoundingClientRect().bottom + 4;
  const bottom = innerHeight - $('#hudBottom').getBoundingClientRect().top + 4;
  board.setInsets(top, bottom);
}
addEventListener('resize', () => setTimeout(layoutInsets, 50));

// ------------------------------------------------------------ home

function refreshHome() {
  $('#nameInput').value = profile.name || '';
  $('#btnSound').textContent = `Sunet: ${isMuted() ? 'oprit' : 'pornit'}`;
  const s = loadSession();
  $('#btnContinue').classList.toggle('hidden', !((s && !s.over) || BotGame.hasSaved()));
  if (window.MAGISTRALA_STATIC) {
    $('#btnCreate').classList.add('hidden');
    $('#btnJoin').classList.add('hidden');
    $('#btnBot').classList.replace('ghost', 'primary');
  }
}
$('#nameInput').addEventListener('input', (e) => { profile.name = e.target.value.trim().slice(0, 16); saveProfile(); });
document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { sfx.tap(); show(go.dataset.go); }
});
$('#btnSound').onclick = () => { setMuted(!isMuted()); refreshHome(); };
let rulesBack = 'home';
$('#btnRules').onclick = () => { rulesBack = 'home'; show('rules'); };
$('#rulesBack').onclick = () => { show(rulesBack); if (rulesBack === 'game') layoutInsets(); };
$('#btnCreate').onclick = () => {
  sfx.tap();
  startOnline({ t: 'create', role: 'A', name: profile.name, options: {} });
  $('#lobbyCode').textContent = '····';
  $('#lobbyStatus').textContent = 'Se creează camera…';
  show('lobby');
};
$('#btnJoin').onclick = () => { sfx.tap(); show('join'); setTimeout(() => $('#codeInput').focus(), 300); };
$('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
$('#btnDoJoin').onclick = () => {
  const code = $('#codeInput').value;
  if (code.length !== 4) return toast('Codul are 4 litere.');
  sfx.tap();
  startOnline({ t: 'join', code, name: profile.name });
};
$('#lobbyBack').onclick = () => { ctl?.leave(); ctl = null; show('home'); };
$('#btnShare').onclick = async () => {
  const code = $('#lobbyCode').textContent;
  const url = `${location.origin}${location.pathname}?join=${code}`;
  const text = `Hai la o partidă de Magistrala! Codul camerei: ${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Magistrala', text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Link copiat.'); }
  } catch { /* cancelled */ }
};
$('#btnBot').onclick = () => {
  sfx.tap();
  ctl?.leave?.();
  isBot = true;
  resetGame();
  ctl = new BotGame(handlers);
  ctl.start(profile.name || 'Tu');
};
$('#btnContinue').onclick = () => {
  sfx.tap();
  if (ctl && view && view.phase !== 'over') return enterGame();
  const s = loadSession();
  resetGame();
  if (s && !s.over) {
    isBot = false;
    ctl = new OnlineGame(handlers);
    ctl.resume(s);
  } else if (BotGame.hasSaved()) {
    isBot = true;
    ctl = new BotGame(handlers);
    if (!ctl.resume()) toast('Nu am putut relua partida.', 'bad');
  }
};

// ------------------------------------------------------------ controller wiring

let ctl = null;
let isBot = false;
let view = null;
let players = null;
let queue = Promise.resolve();
let busy = false;
let mode = null; // 'station' when picking a city for a station
let autoFocused = false;
let promptSentAt = -1; // view.seq when tickets/bid were sent, so the prompt is not reopened

const handlers = {
  joined(msg) {
    if (screen === 'lobby') {
      $('#lobbyCode').textContent = msg.code;
      $('#lobbyStatus').textContent = 'Aștept partenerul…';
    }
  },
  state(v, events, pl) { onState(v, events, pl); },
  presence(pl) {
    const before = players;
    players = pl;
    if (screen === 'lobby' && view && partnerJoined()) enterGame();
    if (before && view && screen === 'game') {
      const o = oppKey();
      if (before[o].online !== pl[o].online) toast(pl[o].online ? `${nameOf(1 - me())} e din nou aici` : `${nameOf(1 - me())} s-a deconectat`, pl[o].online ? '' : 'bad');
    }
    renderHud();
  },
  error(msg, fatal) {
    busy = false;
    toast(msg, 'bad', 3);
    if (fatal) { ctl = null; show('home'); }
    renderHud();
  },
  react() {},
  status(s) { if (s === 'offline' && screen === 'game') toast('Conexiune pierdută — reconectez…', 'bad'); },
};

function startOnline(first) {
  ctl?.leave?.();
  isBot = false;
  resetGame();
  ctl = new OnlineGame(handlers);
  ctl.connect(first);
}

function resetGame() {
  view = null;
  players = null;
  busy = false;
  mode = null;
  queue = Promise.resolve();
  closeSheet();
  clearFocus();
}

const me = () => (view ? view.me : 0);
const oppKey = () => (me() === 0 ? 'B' : 'A');
const partnerJoined = () => Boolean(players && players[oppKey()]?.joined);
function nameOf(p) {
  const key = p === 0 ? 'A' : 'B';
  return players?.[key]?.name || view?.names?.[p] || (p === me() ? 'Tu' : 'Partenerul');
}
const myTurn = () => view && view.phase === 'turn' && view.active === me() && !view.players[me()].pendingCount;

function enterGame() {
  show('game');
  renderHud();
  requestAnimationFrame(layoutInsets);
  requestWakeLock();
  maybeOpenPrompts();
}

function onState(v, events, pl) {
  if (pl) players = pl;
  const fresh = !view || events.some((e) => e.k === 'rematch') || v.seq < view.seq;
  if (fresh) {
    view = v;
    board.sync(v);
    clearFocus();
    closeSheet();
    if (screen === 'lobby' && !isBot && !partnerJoined()) return;
    enterGame();
    if (v.phase === 'over') showResult();
    else if (events.some((e) => e.k === 'rematch')) banner('Partidă nouă', 'Mult noroc!');
    ctl?.idle?.();
    return;
  }
  queue = queue.then(() => playEvents(events, v)).catch((e) => console.error(e));
}

async function playEvents(events, v) {
  busy = true;
  const prev = view;
  autoFocused = false;
  for (const e of events) await animate(e, prev, v);
  if (autoFocused) {
    await wait(700);
    board.resetView();
  }
  view = v;
  board.sync(v);
  busy = false;
  renderHud();
  if (v.phase === 'over') {
    await wait(600);
    showResult();
    return;
  }
  maybeOpenPrompts();
  ctl?.idle?.();
}

// ------------------------------------------------------------ event animations

function handChipPos(color) {
  const el = document.querySelector(`#hand [data-c="${color}"]`);
  return el ? centerOf(el) : { x: innerWidth / 2, y: innerHeight - 80 };
}
const panelPos = (p) => centerOf($(`#pl${p}`));

async function animate(e, prev, next) {
  const mine = e.player === me();
  switch (e.k) {
    case 'draw': {
      const fromEl = e.from === 'deck' ? $('#deckCard') : document.querySelector(`#market [data-slot="${e.from}"]`);
      const from = fromEl ? centerOf(fromEl) : { x: innerWidth / 2, y: innerHeight - 160 };
      sfx.card();
      if (mine) {
        await fly(cardHtml(e.card), from, handChipPos(e.card), { endScale: 0.85 });
        const chip = document.querySelector(`#hand [data-c="${e.card}"]`);
        if (chip) {
          const n = chip.querySelector('.n');
          if (n) n.textContent = Number(n.textContent) + 1;
          chip.classList.remove('zero', 'pulse');
          void chip.offsetWidth;
          chip.classList.add('pulse');
        }
      } else {
        await fly(cardHtml(e.card ?? 'back'), from, panelPos(e.player), { endScale: 0.4 });
      }
      if (e.from !== 'deck') {
        const m = view.market.slice();
        m.splice(e.from, 1);
        renderMarket(m);
      }
      break;
    }
    case 'marketReset':
      toast('Trei locomotive la vedere — piața se amestecă din nou.');
      break;
    case 'claim': {
      const r = ROUTES[e.route];
      if (!mine) {
        board.focusRoute(e.route);
        autoFocused = true;
        await wait(450);
      }
      const target = board.screenOfRoute(e.route);
      const flights = [];
      let k = 0;
      for (const [c, n] of Object.entries(e.spent)) {
        for (let i = 0; i < n; i++) {
          const from = mine ? handChipPos(c) : panelPos(e.player);
          flights.push(fly(cardHtml(c), from, target, { delay: k++ * 70, endScale: 0.3 }));
        }
      }
      await Promise.all(flights);
      board.setHighlight({});
      await board.placeTrains(e.route, e.player, true, (i) => { sfx.clack(0); if (i === 0) haptic(12); });
      sfx.whistle();
      floatPts(board.screenOfRoute(e.route), `+${e.points}`, e.player === 0 ? '#ffb27a' : '#7fe0e2');
      bumpScore(e.player, e.points);
      if (!mine) toast(`${nameOf(e.player)} a construit ${routeName(r)} (+${e.points})`);
      break;
    }
    case 'toll': {
      board.coins(e.city, e.to);
      sfx.coin();
      haptic([10, 30, 10]);
      floatPts(board.screenOf(e.city), `+${e.points} taxă`, '#f5c542');
      bumpScore(e.to, e.points);
      toast(e.to === me() ? `Gara ta din ${city(e.city)} a încasat ${e.points} puncte!` : `Ai plătit ${e.points} puncte taxă la gara din ${city(e.city)}.`, e.to === me() ? 'good' : 'bad');
      await wait(700);
      break;
    }
    case 'station': {
      if (!mine) {
        board.focus(CITIES[e.city].x, CITIES[e.city].z + 0.4, Math.min(board.cam.dist, 12));
        autoFocused = true;
      }
      const target = board.screenOf(e.city);
      let k = 0;
      const flights = [];
      for (const [c, n] of Object.entries(e.spent)) for (let i = 0; i < n; i++) flights.push(fly(cardHtml(c), mine ? handChipPos(c) : panelPos(e.player), target, { delay: k++ * 70, endScale: 0.3 }));
      await Promise.all(flights);
      sfx.build();
      await board.placeStation(e.city, e.player, true);
      toast(mine ? `Gara ta din ${city(e.city)} e gata. Adversarul plătește taxă când vine aici.` : `${nameOf(e.player)} a cumpărat o gară în ${city(e.city)}.`);
      break;
    }
    case 'ticketsDrawn':
      if (!mine) toast(`${nameOf(e.player)} trage bilete noi…`);
      break;
    case 'ticketsKept':
      if (!mine) toast(`${nameOf(e.player)} a păstrat ${e.count} ${e.count === 1 ? 'bilet' : 'bilete'}.`);
      break;
    case 'ticketDone': {
      if (!mine) break;
      const t = E.ticketById(e.id);
      sfx.ticket();
      haptic([15, 40, 15]);
      board.setBeacons([t.a, t.b]);
      toast(`${t.contract ? 'Contract' : 'Bilet'} completat: ${city(t.a)} → ${city(t.b)} (+${t.value})`, 'good', 3.2);
      await wait(1200);
      board.setBeacons([]);
      break;
    }
    case 'start':
      await banner('Plecarea!', e.active === me() ? 'Tu începi.' : `Începe ${nameOf(e.active)}.`);
      break;
    case 'turn':
      if (e.active === me()) { sfx.turn(); haptic(15); }
      break;
    case 'skip':
      toast(`${nameOf(e.player)} nu mai are mutări și pierde tura.`);
      break;
    case 'finalRound':
      await banner('Ultima tură!', `${nameOf(e.by)} a rămas aproape fără vagoane.`);
      break;
    case 'auction': {
      const t = E.ticketById(e.contract);
      sfx.gavel();
      await banner('Licitația CFR', `Contract: ${city(t.a)} → ${city(t.b)} · ${t.value} puncte`);
      break;
    }
    case 'bidPlaced':
      if (e.player !== me()) toast(`${nameOf(e.player)} și-a pus oferta în plic.`);
      break;
    case 'auctionResult':
      await showAuctionResult(e);
      break;
    default:
      break;
  }
}

function bumpScore(p, pts) {
  const el = $(`#pl${p}`);
  const sc = el.querySelector('.sc');
  if (sc) sc.textContent = Number(sc.textContent) + pts;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ------------------------------------------------------------ HUD rendering

function renderHud() {
  if (!view) return;
  for (const p of [0, 1]) {
    const pl = view.players[p];
    const el = $(`#pl${p}`);
    el.className = `pl p${p}${view.phase !== 'over' && (view.phase === 'turn' && view.active === p) ? ' active' : ''}`;
    const off = !isBot && players && !players[p === 0 ? 'A' : 'B']?.online && p !== me();
    el.innerHTML = `<span class="dot">${p === me() ? '★' : ''}</span><span class="nm">${esc(nameOf(p))}${p === me() ? ' (tu)' : ''}</span><span class="sc">${pl.score}</span>
      <span class="st"><span>🚃 ${pl.trains}</span><span>🃏 ${pl.handCount}</span><span>🎫 ${pl.ticketCount}</span>${pl.stations.length ? `<span>🏛 ${pl.stations.length}</span>` : ''}</span>${off ? '<span class="off">offline</span>' : ''}`;
  }
  renderStatus();
  renderMarket(view.market);
  renderHand();
  const mineT = view.players[me()];
  $('#ticketBadge').textContent = (mineT.tickets?.length || 0) + mineT.contracts.length || '';
  $('#btnStation').disabled = !myTurn() || view.drawn || mineT.stations.length >= E.MAX_STATIONS;
}

function renderStatus() {
  const st = $('#status');
  let text;
  let mine = false;
  const last = view.finalTurns !== null && view.phase === 'turn' ? 'Ultima tură · ' : '';
  if (view.phase === 'setup') {
    text = view.players[me()].pendingCount ? 'Alege-ți biletele de pornire' : `Aștept ca ${nameOf(1 - me())} să-și aleagă biletele…`;
    mine = Boolean(view.players[me()].pendingCount);
  } else if (view.phase === 'auction') {
    text = view.auction.placed[me()] ? `Licitație: aștept oferta lui ${nameOf(1 - me())}…` : 'Licitație CFR: pune-ți oferta';
    mine = !view.auction.placed[me()];
  } else if (view.phase === 'over') {
    text = 'Partida s-a încheiat';
  } else if (view.active === me()) {
    mine = true;
    text = view.players[me()].pendingCount ? 'Alege biletele noi' : view.drawn ? 'Mai trage o carte' : 'Rândul tău: cărți, rută sau gară';
  } else {
    text = `${nameOf(view.active)} se gândește…`;
  }
  st.className = `status${mine ? ' mine' : ''}`;
  st.textContent = last + text;
}

function renderMarket(market) {
  const can = myTurn();
  $('#market').innerHTML = market.map((c, i) => {
    const blocked = !can || (view.drawn && c === WILD);
    return `<button class="card c-${c}${blocked ? ' disabled' : ''}" data-slot="${i}" aria-label="Carte ${E.COLOR_NAMES[c]}">${c === WILD ? LOCO_ICON : CAR_ICON.replace(/currentColor/g, iconColor(c))}</button>`;
  }).join('') + `<button class="card back${can ? '' : ' disabled'}" id="deckCard" data-slot="deck" aria-label="Pachet">${CAR_ICON.replace(/currentColor/g, '#d9b264')}<b>${view.deckCount}</b></button>`;
}

function renderHand() {
  const hand = view.players[me()].hand || {};
  $('#hand').innerHTML = CARD_TYPES.map((c) => cardHtml(c, `mini${hand[c] ? '' : ' zero'}" data-c="${c}`, `<span class="n">${hand[c] || 0}</span>`)).join('');
}

// ------------------------------------------------------------ input

$('#market').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b || !view) return;
  if (busy) return;
  if (!myTurn()) return toast(view.phase === 'turn' ? `E rândul lui ${nameOf(view.active)}.` : 'Așteaptă.');
  const slot = b.dataset.slot === 'deck' ? 'deck' : Number(b.dataset.slot);
  if (slot !== 'deck' && view.market[slot] === WILD && view.drawn) return toast('A doua carte nu poate fi o locomotivă de la vedere.');
  closeSheet();
  send({ type: 'drawCard', slot });
});

$('#hand').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-c]');
  if (!chip || !view) return;
  const c = chip.dataset.c;
  const hand = view.players[me()].hand;
  const routes = ROUTES.filter((r) => view.routes[r.id] === null && (r.color === c || r.color === 'gri' || c === WILD) && E.payment(hand, r.color, r.len) && view.players[me()].trains >= r.len);
  board.setHighlight({ routes: routes.map((r) => r.id) });
  toast(routes.length ? `${routes.length} rute pe care le poți construi acum (luminate).` : `Ai ${hand[c]} × ${E.COLOR_NAMES[c]}. Încă nu ajunge pentru o rută.`);
});

$('#btnTickets').onclick = () => { sfx.tap(); openTickets(); };
$('#btnStation').onclick = () => {
  sfx.tap();
  if (!myTurn() || view.drawn) return toast('Poți cumpăra o gară doar la începutul turei tale.');
  mode = 'station';
  const free = Object.keys(CITIES).filter((id) => view.stations[id] === undefined);
  board.setHighlight({ cities: free });
  toast('Atinge orașul unde vrei gara.');
};
$('#btnView').onclick = () => { sfx.tap(); board.resetView(); clearFocus(); };
$('#btnMenu').onclick = () => {
  sfx.tap();
  const code = loadSession()?.code;
  modal(`<h3>Meniu</h3>${!isBot && code ? `<p>Camera: <b style="color:var(--brass);letter-spacing:3px">${esc(code)}</b></p>` : ''}
    <button class="btn" data-act="rules">Reguli</button>
    <button class="btn" data-act="sound">${isMuted() ? 'Pornește sunetul' : 'Oprește sunetul'}</button>
    <button class="btn" data-act="home">Ieși (partida rămâne salvată)</button>
    <button class="btn ghost" data-act="quit">Abandonează partida</button>
    <button class="btn primary" data-act="close">Înapoi la joc</button>`, {
    rules: () => { closeModal(); rulesBack = 'game'; show('rules'); },
    sound: () => { setMuted(!isMuted()); closeModal(); },
    home: () => { closeModal(); show('home'); },
    quit: () => { closeModal(); ctl?.leave(); ctl = null; resetGame(); show('home'); },
    close: closeModal,
  });
};

function send(action) {
  if (!ctl) return;
  busy = true;
  setTimeout(() => { busy = false; }, 5000);
  ctl.act(action);
}

function onBoardTap(hit) {
  if (screen !== 'game' || !view) return;
  if (hit.city) {
    if (mode === 'station') return openStation(hit.city);
    return openCity(hit.city);
  }
  if (hit.route !== undefined) return openRoute(hit.route);
  mode = null;
  closeSheet();
  clearFocus();
}

// ------------------------------------------------------------ route sheet

function openRoute(id, chosenColor) {
  const r = ROUTES[id];
  board.setHighlight({ routes: [id], cities: [r.a, r.b] });
  sfx.tap();
  const owner = view.routes[id];
  const pts = E.ROUTE_POINTS[r.len];
  const swatch = `<span class="route-swatch">${Array.from({ length: r.len }, () => `<i style="background:var(--c-${r.color})"></i>`).join('')}</span>`;
  const head = `<div class="route-head">${swatch}<h3>${esc(routeName(r))}</h3></div>`;
  if (owner !== null) {
    openSheet(`${head}<p>Construită de ${esc(nameOf(owner))}. ${r.len} vagoane · ${pts} puncte.</p><div class="btns"><button class="btn ghost" data-close>Închide</button></div>`, { onClose: clearFocus });
    $('#sheet').querySelector('[data-close]').onclick = () => { closeSheet(); };
    return;
  }
  const hand = view.players[me()].hand;
  const trains = view.players[me()].trains;
  let options = [];
  if (r.color === 'gri') options = [...COLORS, WILD].map((c) => ({ c, pay: c === WILD ? (hand[WILD] >= r.len ? { color: WILD, spent: { [WILD]: r.len } } : null) : E.payment(hand, c, r.len) })).filter((o) => o.pay && (o.c === WILD || o.pay.spent[o.c]));
  let pay = null;
  if (r.color === 'gri') {
    const pick = options.find((o) => o.c === chosenColor) || options[0];
    pay = pick?.pay || null;
    chosenColor = pick?.c;
  } else pay = E.payment(hand, r.color, r.len);
  const stationOwner = [r.a, r.b].map((c) => view.stations[c]).find((o) => o !== undefined && o !== me());
  let reason = '';
  if (!myTurn()) reason = view.phase === 'turn' ? `E rândul lui ${nameOf(view.active)}.` : 'Nu e momentul acum.';
  else if (view.drawn) reason = 'Ai tras deja o carte — trage-o și pe a doua.';
  else if (trains < r.len) reason = `Ai doar ${trains} vagoane.`;
  else if (!pay) reason = r.color === 'gri' ? `Îți trebuie ${r.len} cărți de aceeași culoare.` : `Îți trebuie ${r.len} × ${E.COLOR_NAMES[r.color]} (locomotivele țin loc).`;
  const payHtml = pay ? `<div class="pay">${Object.entries(pay.spent).flatMap(([c, n]) => Array.from({ length: n }, () => cardHtml(c, 'mini'))).join('')}<span style="color:var(--muted)">→ +${pts} puncte</span></div>` : '';
  const colorsHtml = r.color === 'gri' && options.length > 1 ? `<p>Plătești cu:</p><div class="colors">${options.map((o) => cardHtml(o.c, `${o.c === chosenColor ? 'on' : ''}" data-color="${o.c}`)).join('')}</div>` : '';
  const toll = stationOwner !== undefined ? `<p>⚠️ ${esc(nameOf(stationOwner))} are gară aici — plătești ${E.STATION_TOLL} puncte taxă.</p>` : '';
  openSheet(`${head}<p>${r.len} ${r.len === 1 ? 'vagon' : 'vagoane'} · ${r.color === 'gri' ? 'orice culoare' : E.COLOR_NAMES[r.color]} · ${pts} ${pts === 1 ? 'punct' : 'puncte'}</p>
    ${colorsHtml}${payHtml}${toll}${reason ? `<p style="color:#f0a49c">${esc(reason)}</p>` : ''}
    <div class="btns"><button class="btn ghost" data-close>Închide</button><button class="btn primary" data-build ${reason ? 'disabled' : ''}>Construiește</button></div>`, { onClose: clearFocus });
  const sh = $('#sheet');
  sh.querySelector('[data-close]').onclick = () => closeSheet();
  sh.querySelector('[data-build]').onclick = () => {
    closeSheet();
    send({ type: 'claim', route: id, color: r.color === 'gri' ? chosenColor : undefined });
  };
  sh.querySelectorAll('[data-color]').forEach((b) => { b.onclick = () => openRoute(id, b.dataset.color); });
}

// ------------------------------------------------------------ city & station sheets

function openCity(id) {
  sfx.tap();
  const routes = ROUTES.filter((r) => r.a === id || r.b === id);
  board.setHighlight({ routes: routes.filter((r) => view.routes[r.id] === null).map((r) => r.id), cities: [id] });
  const owner = view.stations[id];
  const items = routes.map((r) => {
    const o = view.routes[r.id];
    const other = r.a === id ? r.b : r.a;
    const sw = `<span class="route-swatch">${Array.from({ length: r.len }, () => `<i style="background:var(--c-${r.color})"></i>`).join('')}</span>`;
    return `<button class="li" data-route="${r.id}">${sw}<span class="grow">${esc(city(other))}<br><small>${o === null ? `${r.len} vagoane · liberă` : `a lui ${esc(nameOf(o))}`}</small></span><span class="val">${E.ROUTE_POINTS[r.len]}</span></button>`;
  }).join('');
  const st = owner !== undefined ? `<p>🏛 Gară: ${esc(nameOf(owner))}${owner !== me() ? ` — plătești ${E.STATION_TOLL} puncte dacă construiești aici.` : ' — încasezi taxă când adversarul vine aici.'}</p>` : '';
  const canStation = owner === undefined && myTurn() && !view.drawn && view.players[me()].stations.length < E.MAX_STATIONS;
  openSheet(`<h3>${esc(city(id))}</h3>${st}<div class="list">${items}</div>
    <div class="btns"><button class="btn ghost" data-close>Închide</button>${owner === undefined ? `<button class="btn" data-station ${canStation ? '' : 'disabled'}>🏛 Gară aici</button>` : ''}</div>`, { onClose: clearFocus });
  const sh = $('#sheet');
  sh.querySelector('[data-close]').onclick = () => closeSheet();
  sh.querySelectorAll('[data-route]').forEach((b) => { b.onclick = () => openRoute(Number(b.dataset.route)); });
  const sb = sh.querySelector('[data-station]');
  if (sb) sb.onclick = () => openStation(id);
}

function openStation(id, chosen) {
  mode = null;
  board.setHighlight({ cities: [id] });
  const hand = view.players[me()].hand;
  const options = COLORS.map((c) => ({ c, pay: E.payment(hand, c, E.STATION_COST) })).filter((o) => o.pay && o.pay.spent[o.c]);
  if (hand[WILD] >= E.STATION_COST) options.push({ c: WILD, pay: { color: WILD, spent: { [WILD]: E.STATION_COST } } });
  const pick = options.find((o) => o.c === chosen) || options[0];
  let reason = '';
  if (view.stations[id] !== undefined) reason = 'Orașul are deja o gară.';
  else if (!myTurn() || view.drawn) reason = 'Poți cumpăra o gară doar la începutul turei tale.';
  else if (view.players[me()].stations.length >= E.MAX_STATIONS) reason = `Ai deja ${E.MAX_STATIONS} gări.`;
  else if (!pick) reason = `Îți trebuie ${E.STATION_COST} cărți de aceeași culoare.`;
  const free = ROUTES.filter((r) => (r.a === id || r.b === id) && view.routes[r.id] === null).length;
  openSheet(`<h3>🏛 Gară în ${esc(city(id))}</h3>
    <p>Costă ${E.STATION_COST} cărți de aceeași culoare. De fiecare dată când ${esc(nameOf(1 - me()))} construiește o rută spre ${esc(city(id))}, primești ${E.STATION_TOLL} puncte. Rute libere aici: ${free}.</p>
    ${options.length > 1 ? `<div class="colors">${options.map((o) => cardHtml(o.c, `${o.c === pick?.c ? 'on' : ''}" data-color="${o.c}`)).join('')}</div>` : ''}
    ${pick ? `<div class="pay">${Object.entries(pick.pay.spent).flatMap(([c, n]) => Array.from({ length: n }, () => cardHtml(c, 'mini'))).join('')}</div>` : ''}
    ${reason ? `<p style="color:#f0a49c">${esc(reason)}</p>` : ''}
    <div class="btns"><button class="btn ghost" data-close>Închide</button><button class="btn primary" data-buy ${reason ? 'disabled' : ''}>Cumpără gara</button></div>`, { onClose: clearFocus });
  const sh = $('#sheet');
  sh.querySelector('[data-close]').onclick = () => closeSheet();
  sh.querySelectorAll('[data-color]').forEach((b) => { b.onclick = () => openStation(id, b.dataset.color); });
  sh.querySelector('[data-buy]').onclick = () => { closeSheet(); send({ type: 'station', city: id, color: pick.c === WILD ? undefined : pick.c }); };
}

// ------------------------------------------------------------ tickets

function ticketHtml(t, extra = '') {
  const done = t.done ? '<span class="stamp">LEGAT</span>' : '';
  return `<button class="ticket${t.contract ? ' contract' : ''}${t.done ? ' done' : ''} ${extra}" data-t="${t.id}">
    <span class="rt">${esc(city(t.a))} → ${esc(city(t.b))}</span><span class="val">${t.value}</span>
    <small>${t.contract ? 'Contract de stat · doar bonus' : t.done ? 'Legat! Puncte câștigate la final' : 'Nelegat încă · la final scade dacă rămâne așa'}</small>${done}</button>`;
}

function openTickets() {
  const pl = view.players[me()];
  const all = [...(pl.tickets || []), ...pl.contracts];
  const canDraw = myTurn() && !view.drawn && view.ticketDeckCount > 0;
  openSheet(`<h3>Biletele tale</h3><p>Atinge un bilet ca să vezi orașele pe hartă. Biletele sunt secrete.</p>
    <div class="list">${all.map((t) => ticketHtml(t)).join('') || '<p>Niciun bilet încă.</p>'}</div>
    <div class="btns"><button class="btn ghost" data-close>Închide</button><button class="btn" data-draw ${canDraw ? '' : 'disabled'}>Trage bilete (${view.ticketDeckCount})</button></div>`, { onClose: clearFocus });
  const sh = $('#sheet');
  sh.querySelector('[data-close]').onclick = () => closeSheet();
  sh.querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => {
      const t = E.ticketById(Number(b.dataset.t));
      sh.querySelectorAll('.ticket').forEach((x) => x.classList.toggle('on', x === b));
      board.setBeacons([t.a, t.b]);
      board.setHighlight({ cities: [t.a, t.b] });
      sfx.tap();
    };
  });
  sh.querySelector('[data-draw]').onclick = () => { closeSheet(); send({ type: 'drawTickets' }); };
}

function openTicketChoice() {
  const pl = view.players[me()];
  const pending = pl.pending || [];
  const min = view.phase === 'setup' ? 2 : 1;
  const keep = new Set(pending.map((t) => t.id));
  const render = () => {
    const sh = openSheet(`<h3>${view.phase === 'setup' ? 'Biletele de pornire' : 'Bilete noi'}</h3>
      <p>Păstrează cel puțin ${min}. La final, fiecare bilet legat aduce punctele lui; unul nelegat le scade.</p>
      <div class="list">${pending.map((t) => ticketHtml(t, keep.has(t.id) ? 'on' : 'off')).join('')}</div>
      <div class="btns"><button class="btn primary" data-keep ${keep.size >= min ? '' : 'disabled'}>Păstrează ${keep.size}</button></div>`, { locked: true, kind: 'tickets' });
    board.setBeacons([...new Set(pending.filter((t) => keep.has(t.id)).flatMap((t) => [t.a, t.b]))]);
    sh.querySelectorAll('[data-t]').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.t);
        if (keep.has(id)) keep.delete(id);
        else keep.add(id);
        sfx.tap();
        render();
      };
    });
    sh.querySelector('[data-keep]').onclick = () => {
      closeSheet();
      board.setBeacons([]);
      promptSentAt = view.seq;
      send({ type: 'keepTickets', keep: [...keep] });
    };
  };
  render();
}

// ------------------------------------------------------------ auction

function openBid() {
  const t = view.auction.contract;
  const hand = view.players[me()].hand;
  const bid = Object.fromEntries(CARD_TYPES.map((c) => [c, 0]));
  board.setBeacons([t.a, t.b]);
  const value = () => CARD_TYPES.reduce((s, c) => s + bid[c] * (c === WILD ? 2 : 1), 0);
  const render = () => {
    const sh = openSheet(`<h3>⚖️ Licitația CFR</h3>${ticketHtml({ ...t, done: false })}
      <p>Oferta e secretă. Câștigă cine oferă mai mult (o locomotivă valorează 2). Doar câștigătorul plătește; la egalitate nimeni nu ia contractul.</p>
      <div class="stepper">${CARD_TYPES.filter((c) => hand[c]).map((c) => `<div class="step">${cardHtml(c, 'mini', `<span class="n">${bid[c]}/${hand[c]}</span>`)}
        <div class="ctl"><button data-m="${c}">−</button><button data-p="${c}">+</button></div></div>`).join('') || '<p>Nu ai cărți — poți licita 0.</p>'}</div>
      <div class="bid-total">Oferta ta: ${value()}</div>
      <div class="btns"><button class="btn primary" data-bid>${value() ? 'Pune oferta în plic' : 'Nu licitez (0)'}</button></div>`, { locked: true, kind: 'bid' });
    sh.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { const c = b.dataset.p; if (bid[c] < hand[c]) { bid[c]++; sfx.tap(); render(); } }; });
    sh.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { const c = b.dataset.m; if (bid[c] > 0) { bid[c]--; sfx.tap(); render(); } }; });
    sh.querySelector('[data-bid]').onclick = () => {
      closeSheet();
      board.setBeacons([]);
      sfx.gavel();
      promptSentAt = view.seq;
      send({ type: 'bid', cards: Object.fromEntries(Object.entries(bid).filter(([, n]) => n)) });
    };
  };
  render();
}

async function showAuctionResult(e) {
  const t = E.ticketById(e.contract);
  sfx.gavel();
  const winText = e.winner === null ? 'Egalitate — contractul rămâne la stat.' : e.winner === me() ? 'Ai câștigat contractul!' : `${nameOf(e.winner)} a câștigat contractul.`;
  openSheet(`<h3>⚖️ Plicurile se deschid</h3><p>${esc(city(t.a))} → ${esc(city(t.b))} · ${t.value} puncte</p>
    <div class="reveal"><div><small>${esc(nameOf(0))}</small><div class="bidv p0">${e.values[0]}</div></div><b>vs</b><div><small>${esc(nameOf(1))}</small><div class="bidv p1" style="animation-delay:.35s">${e.values[1]}</div></div></div>
    <h3 style="text-align:center">${esc(winText)}</h3>`, { locked: true, kind: 'reveal' });
  if (e.winner === me()) { sfx.ticket(); haptic([20, 40, 20]); }
  await wait(2600);
  closeSheet();
}

function maybeOpenPrompts() {
  if (!view || screen !== 'game' || promptSentAt === view.seq) return;
  const pl = view.players[me()];
  if (pl.pendingCount && sheetKind !== 'tickets') openTicketChoice();
  else if (view.phase === 'auction' && !view.auction.placed[me()] && sheetKind !== 'bid') openBid();
}

// ------------------------------------------------------------ result

function showResult() {
  const r = view.result;
  if (!r) return;
  const [a, b] = r.scores;
  const iWon = r.winner === me();
  const title = r.winner === null ? 'Egalitate!' : iWon ? 'Ai câștigat!' : `A câștigat ${nameOf(r.winner)}`;
  const tsum = (s) => s.tickets.reduce((x, t) => x + t.points, 0);
  const csum = (s) => s.contracts.reduce((x, t) => x + t.points, 0);
  const row = (label, f) => `<tr><td>${label}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`;
  const tickets = (p) => view.players[p].tickets?.map((t) => `${t.done ? '✓' : '✗'} ${esc(city(t.a))} → ${esc(city(t.b))} (${t.done ? '+' : '−'}${t.value})`).join('<br>') || '—';
  openSheet(`<div class="trophy">${r.winner === null ? '🤝' : iWon ? '🏆' : '🚂'}</div><h3 style="text-align:center">${esc(title)}</h3>
    <table class="score-table"><tr><th></th><th style="color:var(--p0)">${esc(nameOf(0))}</th><th style="color:var(--p1)">${esc(nameOf(1))}</th></tr>
    ${row('Rute', (s) => s.routes)}${row('Taxe din gări', (s) => s.toll)}${row('Bilete', tsum)}${row('Contracte', csum)}
    ${row('Cel mai lung drum', (s) => `${s.longest}${s.longestBonus ? ` <b style="color:var(--brass)">+${s.longestBonus}</b>` : ''}`)}
    <tr class="total"><td>Total</td><td>${a.total}</td><td>${b.total}</td></tr></table>
    <p><b style="color:var(--p0)">${esc(nameOf(0))}:</b><br>${tickets(0)}</p><p><b style="color:var(--p1)">${esc(nameOf(1))}:</b><br>${tickets(1)}</p>
    <div class="btns"><button class="btn ghost" data-home>Acasă</button><button class="btn primary" data-again>Revanșă</button></div>`, { locked: true, kind: 'result' });
  if (iWon) { sfx.win(); confetti(); } else sfx.lose();
  const sh = $('#sheet');
  sh.querySelector('[data-home]').onclick = () => { closeSheet(); ctl?.leave(); ctl = null; resetGame(); show('home'); };
  sh.querySelector('[data-again]').onclick = () => { closeSheet(); ctl?.rematch({}); };
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#d9b264', '#e8742c', '#18a3a6', '#d8453f', '#3aa35a', '#f0bf2c'];
  for (let k = 0; k < 90; k++) {
    const i = document.createElement('i');
    i.style.left = `${Math.random() * 100}%`;
    i.style.background = colors[k % colors.length];
    i.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    i.style.animationDelay = `${Math.random() * 0.8}s`;
    box.appendChild(i);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 6000);
}

// ------------------------------------------------------------ wake lock, PWA, boot

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && screen === 'game') requestWakeLock(); });
if (!window.MAGISTRALA_STATIC && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const joinCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (joinCode.length === 4) {
  $('#codeInput').value = joinCode;
  history.replaceState(null, '', location.pathname);
  show('join');
} else show('home');
