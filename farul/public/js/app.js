// Farul — screens, input and game flow on top of the engine and the board renderer.
import * as E from './engine/engine.js';
import { reach, pathTo, neighbors } from './engine/hex.js';
import { hashSeed } from './engine/rng.js';
import { Board, GOOD_ICON, GOOD_NAME } from './render.js';
import { sfx, haptic, unlockAudio, setMuted, isMuted } from './fx.js';
import { OnlineGame, loadSession, saveSession } from './net.js';
import { LocalGame } from './local.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ROLE_NAME = { A: 'Paznicul', B: 'Căpitanul' };
const ROLE_ICON = { A: '🔭', B: '⚓' };

// ------------------------------------------------------------ profile & shop

const SHOP = [
  { id: 'beam:amber', cat: 'beam', v: 'amber', name: 'Chihlimbar', cost: 0, desc: 'Lumina caldă, clasică.', color: '#ffd680' },
  { id: 'beam:emerald', cat: 'beam', v: 'emerald', name: 'Smarald', cost: 15, desc: 'Un far verde, ca în porturile nordice.', color: '#78ffbe' },
  { id: 'beam:ice', cat: 'beam', v: 'ice', name: 'Gheață', cost: 25, desc: 'Lumină rece, de iarnă.', color: '#aae1ff' },
  { id: 'beam:amethyst', cat: 'beam', v: 'amethyst', name: 'Ametist', cost: 40, desc: 'Pentru nopțile cu aurora.', color: '#cda0ff' },
  { id: 'boat:velier', cat: 'boat', v: 'velier', name: 'Velier', cost: 0, desc: 'Două pânze, rapid și elegant.', icon: '⛵' },
  { id: 'boat:barca', cat: 'boat', v: 'barca', name: 'Barcă pescărească', cost: 10, desc: 'Mică, cu o singură pânză.', icon: '🛶' },
  { id: 'boat:galion', cat: 'boat', v: 'galion', name: 'Galion', cost: 35, desc: 'Două catarge și pânze pătrate.', icon: '🏴‍☠️' },
  { id: 'relic:lamp', cat: 'relic', v: 'lamp', name: E.RELICS.lamp.label, cost: 20, desc: E.RELICS.lamp.desc, icon: '🏮' },
  { id: 'relic:compass', cat: 'relic', v: 'compass', name: E.RELICS.compass.label, cost: 30, desc: E.RELICS.compass.desc, icon: '🧭' },
  { id: 'relic:map', cat: 'relic', v: 'map', name: E.RELICS.map.label, cost: 45, desc: E.RELICS.map.desc, icon: '🗺️' },
];
const RELIC_ICON = { none: '—', lamp: '🏮', compass: '🧭', map: '🗺️' };

function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('farul.profile') || '{}') || {}; } catch { /* ignore */ }
  return {
    name: typeof p.name === 'string' ? p.name : '',
    shells: Number.isFinite(p.shells) ? p.shells : 0,
    owned: Array.isArray(p.owned) ? p.owned : ['beam:amber', 'boat:velier'],
    beam: p.beam || 'amber',
    boat: p.boat || 'velier',
    claimed: Array.isArray(p.claimed) ? p.claimed.slice(-50) : [],
    best: p.best && typeof p.best === 'object' ? p.best : {},
    seenRules: Boolean(p.seenRules),
  };
}
const profile = loadProfile();
function saveProfile() {
  try { localStorage.setItem('farul.profile', JSON.stringify(profile)); } catch { /* ignore */ }
}

// ------------------------------------------------------------ screens

let screen = 'home';
function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id !== 'result' && screen !== 'result') { /* keep */ }
  screen = id;
  if (id === 'home') refreshHome();
  if (id === 'shop') renderShop();
  if (id === 'create') renderCreate();
}

function toast(text, { kind = '', life = 2.4, html = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.style.setProperty('--life', `${life}s`);
  if (html) el.innerHTML = text;
  else el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), (life + 0.5) * 1000);
}

function modal(html, binds = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-card">${html}</div>`;
  m.classList.remove('hidden');
  m.onclick = (e) => {
    if (e.target === m) closeModal();
    const b = e.target.closest('[data-act]');
    if (b && binds[b.dataset.act]) binds[b.dataset.act]();
  };
}
function closeModal() { $('#modal').classList.add('hidden'); }

// ------------------------------------------------------------ home

function refreshHome() {
  $('#nameInput').value = profile.name;
  $('#shellCount').textContent = profile.shells;
  $('#btnSound').textContent = isMuted() ? '🔇' : '🔊';
  const s = loadSession();
  $('#btnContinue').classList.toggle('hidden', !((s && !s.over) || LocalGame.hasSaved()));
}

$('#nameInput').addEventListener('input', (e) => {
  profile.name = e.target.value.trim().slice(0, 16);
  saveProfile();
});
document.addEventListener('pointerdown', () => unlockAudio(), { capture: true });
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { sfx.tap(); show(go.dataset.go); }
});
$('#btnCreate').onclick = () => { sfx.tap(); show('create'); };
$('#btnJoin').onclick = () => { sfx.tap(); show('join'); setTimeout(() => $('#codeInput').focus(), 300); };
$('#btnLocal').onclick = () => {
  sfx.tap();
  startLocal();
};
$('#btnShop').onclick = () => { sfx.tap(); show('shop'); };
let rulesReturn = 'home';
$('#btnRules').onclick = () => { sfx.tap(); rulesReturn = 'home'; show('rules'); };
$('#rulesBack').onclick = () => show(rulesReturn);
$('#btnSound').onclick = () => {
  setMuted(!isMuted());
  $('#btnSound').textContent = isMuted() ? '🔇' : '🔊';
};
$('#btnContinue').onclick = () => {
  sfx.tap();
  if (ctl && view && view.phase === 'play') {
    enterGame();
    return;
  }
  const s = loadSession();
  if (s && !s.over) {
    isLocal = false;
    me = s.role;
    ctl = new OnlineGame(handlers);
    ctl.resume(s);
    toast('Mă reconectez…');
  } else if (LocalGame.hasSaved()) {
    isLocal = true;
    me = 'both';
    ctl = new LocalGame(handlers);
    resetGameUi();
    if (!ctl.resume()) toast('Nu am putut relua partida.', { kind: 'err' });
  }
};

// ------------------------------------------------------------ create / join / lobby

const createOpts = { role: 'A', difficulty: 'normal', mode: 'silent', relic: 'none' };

function renderCreate() {
  $$('#rolePick .role-card').forEach((b) => b.classList.toggle('selected', b.dataset.role === createOpts.role));
  $$('#diffPick button').forEach((b) => b.classList.toggle('selected', b.dataset.v === createOpts.difficulty));
  $$('#modePick button').forEach((b) => b.classList.toggle('selected', b.dataset.v === createOpts.mode));
  $('#modeHint').textContent = createOpts.mode === 'silent'
    ? 'Nu aveți voie să vă spuneți ce vedeți doar voi — doar prin semnale. Varianta recomandată.'
    : 'Puteți vorbi liber, dar ținta de livrări crește cu 2.';
  const relics = ['none', 'lamp', 'compass', 'map'];
  $('#relicPick').innerHTML = relics.map((r) => {
    const owned = r === 'none' || profile.owned.includes(`relic:${r}`);
    const info = E.RELICS[r];
    return `<button class="relic ${createOpts.relic === r ? 'selected' : ''} ${owned ? '' : 'locked'}" data-relic="${r}" ${owned ? '' : 'disabled'}>
      <span class="ri">${RELIC_ICON[r]}</span><span><b>${esc(info.label)}</b><small>${owned ? esc(info.desc || 'Fără ajutor suplimentar.') : 'Se deblochează din Atelier 🐚'}</small></span></button>`;
  }).join('');
}
$('#rolePick').onclick = (e) => {
  const b = e.target.closest('[data-role]');
  if (!b) return;
  sfx.tap();
  createOpts.role = b.dataset.role;
  renderCreate();
};
$('#diffPick').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { sfx.tap(); createOpts.difficulty = b.dataset.v; renderCreate(); } };
$('#modePick').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { sfx.tap(); createOpts.mode = b.dataset.v; renderCreate(); } };
$('#relicPick').onclick = (e) => { const b = e.target.closest('[data-relic]'); if (b && !b.disabled) { sfx.tap(); createOpts.relic = b.dataset.relic; renderCreate(); } };

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

$('#btnDoCreate').onclick = () => {
  sfx.tap();
  const options = { difficulty: createOpts.difficulty, mode: createOpts.mode, relic: createOpts.relic };
  if ($('#dailyToggle').checked) options.seed = hashSeed(`farul:${todayKey()}`);
  startOnline({ t: 'create', role: createOpts.role, name: profile.name, options });
  $('#lobbyCode').textContent = '····';
  $('#lobbyStatus').textContent = 'Se creează camera…';
  $('#lobbyRole').innerHTML = '';
  show('lobby');
};

$('#codeInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});
$('#btnDoJoin').onclick = () => {
  const code = $('#codeInput').value;
  if (code.length !== 4) {
    toast('Codul are 4 litere.');
    return;
  }
  sfx.tap();
  startOnline({ t: 'join', code, name: profile.name });
  toast('Intru în cameră…');
};
$('#lobbyBack').onclick = () => {
  ctl?.leave();
  ctl = null;
  show('home');
};
$('#btnShare').onclick = async () => {
  const code = $('#lobbyCode').textContent;
  const url = `${location.origin}${location.pathname}?join=${code}`;
  const text = `Hai la o partidă de Farul! Codul camerei: ${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Farul', text, url });
    else {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Link copiat!');
    }
  } catch { /* cancelled */ }
};

// ------------------------------------------------------------ game controller wiring

let ctl = null;
let me = null; // 'A' | 'B' | 'both'
let isLocal = false;
let view = null;
let players = null;
let lastActive = null;
let sel = null;
let signalMode = false;
let busy = false;

const handlers = {
  joined(msg) {
    const roleChanged = me && me !== msg.role;
    me = msg.role;
    board.setRole(me);
    if (screen === 'lobby') {
      $('#lobbyCode').textContent = msg.code;
      $('#lobbyStatus').textContent = 'Aștept partenerul…';
      $('#lobbyRole').innerHTML = `Tu ești <b>${ROLE_ICON[me]} ${ROLE_NAME[me]} ${me === 'A' ? 'farului' : 'portului'}</b>. ${me === 'A' ? 'Vei vedea furtunile.' : 'Vei vedea cererile porturilor.'}`;
    }
    if (roleChanged) toast(`Roluri schimbate: acum ești ${ROLE_ICON[me]} ${ROLE_NAME[me]}`, { life: 3 });
  },
  state(v, events, pl) { onState(v, events, pl); },
  presence(pl) {
    const before = players;
    players = pl;
    const o = E.other(me);
    if (before && before[o].online !== pl[o].online && screen === 'game') {
      toast(pl[o].online ? `${partnerName()} e din nou aici 👋` : `${partnerName()} s-a deconectat`, { kind: pl[o].online ? '' : 'err' });
    }
    maybeLeaveLobby();
    renderTurn();
  },
  error(msg, fatal) {
    busy = false;
    toast(msg, { kind: 'err', life: 3 });
    if (fatal) {
      ctl = null;
      show('home');
    }
    renderAll();
  },
  react(emoji, from) {
    if (from !== me) floater(emoji);
  },
  status(s) {
    if (s === 'offline' && screen === 'game') toast('Conexiune pierdută — reconectez…', { kind: 'err' });
  },
};

function startOnline(first) {
  ctl?.leave();
  isLocal = false;
  me = null;
  view = null;
  players = null;
  resetGameUi();
  ctl = new OnlineGame(handlers);
  ctl.connect(first);
}

function startLocal() {
  ctl?.leave?.();
  isLocal = true;
  me = 'both';
  view = null;
  resetGameUi();
  ctl = new LocalGame(handlers);
  ctl.start({ difficulty: createOpts.difficulty, mode: 'silent', relic: createOpts.relic });
}

function resetGameUi() {
  sel = null;
  signalMode = false;
  busy = false;
  lastActive = null;
  closeSheet();
}

function partnerName() {
  if (isLocal) return '';
  const o = E.other(me);
  return players?.[o]?.name || ROLE_NAME[o];
}

function maybeLeaveLobby() {
  if (screen !== 'lobby' || !view || !players) return;
  if (players[E.other(me)].joined) {
    sfx.chime();
    enterGame();
  }
}

function enterGame() {
  board.setRole(me === 'both' ? 'both' : me);
  board.setCosmetics({ beam: profile.beam, boat: profile.boat });
  show('game');
  requestWakeLock();
  renderAll();
  if (view?.night === 1 && view.turn === 0 && !isLocal && view.opts.mode === 'silent') {
    setTimeout(() => toast('🤫 Liniște radio: spuneți doar prin semnale ce vedeți. Sfat: carte → navă → destinație.', { life: 5 }), 600);
  }
  if (!profile.seenRules && isLocal) {
    profile.seenRules = true;
    saveProfile();
    setTimeout(() => toast('Sfat: atinge o carte, apoi o navă, apoi destinația.', { life: 4.5 }), 2200);
  }
}

function onState(v, events, pl) {
  if (pl) players = pl;
  const isNewGame = !view || events.some((e) => e.k === 'rematch') || (v.seq === 0 && view.seq > 0) || v.tiles.join() !== view.tiles.join();
  busy = false;
  if (isNewGame) {
    view = v;
    sel = null;
    signalMode = false;
    lastActive = v.active;
    board.setView(v);
    if (screen === 'lobby' && !(players && players[E.other(me)]?.joined)) return;
    if (v.phase === 'over') {
      enterGame();
      showResult();
      return;
    }
    if (screen === 'result') $('#result').classList.remove('active');
    enterGame();
    return;
  }
  view = v;
  if (sel && !stillValid()) {
    sel = null;
    closeSheet();
  }
  renderTools();
  updateHighlights();
  board.play(events, v, animHooks()).then(() => {
    renderAll();
    if (v.phase === 'over') {
      setTimeout(showResult, 400);
      return;
    }
    const nowMine = isMyTurn();
    if (v.active !== lastActive) {
      if (nowMine && !isLocal) {
        sfx.horn();
        haptic([20, 60, 20]);
        toast('⚓ Rândul tău!');
      } else if (isLocal) {
        toast(`${ROLE_ICON[v.active]} Rândul ${v.active === 'A' ? 'Paznicului' : 'Căpitanului'}`);
      }
    }
    lastActive = v.active;
  });
}

function animHooks() {
  return {
    me: me === 'both' ? null : me,
    card(e) {
      if (isLocal || e.by === me) return;
      const def = E.CARDS[e.card.type];
      const verb = e.k === 'discard' ? 'a aruncat' : 'a jucat';
      sfx.card();
      toast(`<span class="mini">${def.icon}</span><span>${esc(partnerName())} ${verb} <b>${esc(def.name)}</b></span>`, { kind: 'card-toast', html: true, life: 2.2 });
    },
    deliver() {
      const el = $('#hudGoal');
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    },
    other(e) {
      if (e.k === 'radio') toast(`📻 Radio: +1 semnal${e.by === 'A' ? ', prognoză extinsă' : ', următoarea cerere vizibilă'}`);
    },
  };
}

function stillValid() {
  if (!sel) return true;
  const hand = myHand();
  return isMyTurn() && Array.isArray(hand) && hand.some((c) => c.id === sel.card.id);
}

// ------------------------------------------------------------ derived

function actingRole() {
  if (me === 'both') return view?.active || 'A';
  return me;
}
function isMyTurn() {
  return Boolean(view && view.phase === 'play' && (me === 'both' || view.active === me));
}
function myHand() {
  return view?.hands?.[actingRole()];
}
function signalsLeft() {
  const r = actingRole();
  return Math.max(0, view.signalCap - view.signalsUsed[r]);
}
function playIndex() {
  const r = view.active;
  let done = 0;
  for (let t = 0; t < view.turn; t++) if ((t % 2 === 0 ? view.starter : E.other(view.starter)) === r) done++;
  return done + 1;
}

// ------------------------------------------------------------ rendering of DOM parts

function renderAll() {
  if (!view) return;
  renderSecret();
  renderTurn();
  renderHand();
  renderTools();
  updateHighlights();
}

function renderHud(sh) {
  if (!sh) return;
  $('#hudNight b').textContent = sh.night;
  $('#hudNight small').textContent = `/${sh.maxNights}`;
  $('#hudGoal b').textContent = sh.delivered;
  $('#hudGoal small').textContent = `/${sh.target}`;
  $('#hudGoal .bar-fill').style.width = `${Math.min(100, (sh.delivered / sh.target) * 100)}%`;
  $('#hudLights').innerHTML = sh.ports.filter((p) => p.kind === 'port').map((p) => `<i class="l${p.light}" title="${esc(p.name)}"></i>`).join('');
  const r = actingRole();
  $('#hudSignals b').textContent = Math.max(0, sh.signalCap - (sh.signalsUsed?.[r] ?? 0));
}

function renderSecret() {
  const chips = [];
  if (me === 'both') chips.push('<span class="chip">🎓 Antrenament — vezi tot</span>');
  else chips.push(`<span class="chip role-${me}">${ROLE_ICON[me]} ${ROLE_NAME[me]}</span>`);
  const portName = (id) => view.ports[id].name;
  if (view.forecast.length) {
    const tonight = view.forecast[0];
    const threatened = view.ports.filter((p) => p.kind === 'port' && p.light > 0 && tonight.eyes.some((e) => neighbors(e, E.COLS, E.ROWS).includes(p.hex) || e === p.hex));
    chips.push(`<span class="chip warn">⛈ Diseară: ${tonight.eyes.length} furtuni</span>`);
    if (threatened.length) chips.push(`<span class="chip warn">🌀 În pericol: ${threatened.map((p) => esc(p.name)).join(', ')}</span>`);
    if (view.forecast[1]) chips.push(`<span class="chip">🔮 Mâine: ${view.forecast[1].eyes.length} furtuni</span>`);
  }
  const known = view.demands.filter((d) => d.good);
  if (known.length) {
    for (const d of [...known].sort((a, b) => a.due - b.due)) {
      const left = d.due - view.night + 1;
      chips.push(`<span class="chip">${GOOD_ICON[d.good]} → ${esc(portName(d.port))} <span class="due d${Math.min(3, left)}">${left}n</span></span>`);
    }
  } else if (view.demands.length) {
    chips.push(`<span class="chip">❓ ${view.demands.length} cereri active</span>`);
  }
  if (view.nextDemand && me !== 'both') chips.push(`<span class="chip">📻 Urmează: ${GOOD_ICON[view.nextDemand.good]} → ${esc(portName(view.nextDemand.port))}</span>`);
  if (view.opts.relic !== 'none') chips.push(`<span class="chip">${RELIC_ICON[view.opts.relic]} ${esc(E.RELICS[view.opts.relic].label)}</span>`);
  $('#secret').innerHTML = chips.join('');
}

function renderTurn() {
  const el = $('#turnbar');
  if (!view) return;
  if (view.phase === 'over') {
    el.className = 'turnbar';
    el.textContent = 'Partida s-a încheiat';
    return;
  }
  if (signalMode) {
    el.className = 'turnbar mine';
    el.textContent = '📡 Atinge un hex (⚠) sau un port (marfă dorită)';
    return;
  }
  if (isMyTurn()) {
    el.className = 'turnbar mine';
    const who = me === 'both' ? `${ROLE_ICON[view.active]} ${view.active === 'A' ? 'Paznicul' : 'Căpitanul'} · ` : 'Rândul tău · ';
    const step = sel ? stepHint() : `carte ${playIndex()}/2 — alege o carte`;
    el.textContent = who + step;
  } else {
    const o = E.other(me);
    const online = players?.[o]?.online;
    el.className = 'turnbar';
    el.innerHTML = `<span class="dot ${online ? '' : 'off'}"></span>${esc(partnerName())} ${online ? 'se gândește' : 'e offline'} <span class="typing"><span></span><span></span><span></span></span>`;
  }
}

function stepHint() {
  const t = sel.card.type;
  if (sel.step === 'ship') return sel.moves?.length ? 'alege a doua navă' : t === 'anchor' ? 'alege nava de adăpostit' : 'alege o navă';
  if (sel.step === 'dest') return 'alege destinația';
  if (sel.step === 'port') return 'alege farul';
  return 'confirmă';
}

function renderHand() {
  const hand = myHand();
  const el = $('#hand');
  if (!Array.isArray(hand) || !hand.length) {
    el.innerHTML = '<span class="empty">Fără cărți</span>';
    return;
  }
  const key = hand.map((c) => c.id).join(',') + (isMyTurn() ? 'm' : 'w') + (sel?.card.id ?? '');
  if (el.dataset.key === key) return;
  const prevIds = new Set((el.dataset.ids || '').split(',').filter(Boolean).map(Number));
  el.dataset.key = key;
  el.dataset.ids = hand.map((c) => c.id).join(',');
  el.innerHTML = hand.map((c, k) => {
    const def = E.CARDS[c.type];
    const fresh = !prevIds.has(c.id);
    return `<button class="card t-${c.type} ${sel?.card.id === c.id ? 'selected' : ''} ${isMyTurn() ? '' : 'waiting'}" data-card="${c.id}" style="animation-delay:${fresh ? k * 0.08 : 0}s;${fresh ? '' : 'animation:none'}">
      <span class="ci">${def.icon}</span><b>${esc(def.name)}</b><small>${esc(cardDesc(c.type))}</small></button>`;
  }).join('');
}

function cardDesc(type) {
  if ((type === 'sail2' || type === 'sail3') && view.opts.relic === 'compass' && view.compassReady?.[actingRole()]) {
    return `${E.CARDS[type].desc} 🧭 +1`;
  }
  return E.CARDS[type].desc;
}

function renderTools() {
  if (!view) return;
  const left = signalsLeft();
  const sig = $('#btnSignal');
  sig.querySelector('span').textContent = `Semnal (${left})`;
  sig.disabled = view.phase !== 'play' || (left === 0 && !signalMode);
  sig.classList.toggle('on', signalMode);
  $('#btnDiscard').disabled = !isMyTurn() || !sel;
  $('#btnReact').classList.toggle('hidden', isLocal);
}

// ------------------------------------------------------------ selection / highlights

function updateHighlights() {
  const hl = {};
  if (signalMode) hl.signal = true;
  if (sel) {
    const ships = sel.ships || view.ships;
    if (sel.step === 'ship') {
      hl.ships = new Set(ships.map((s) => s.id).filter((id) => !sel.moves?.some((m) => m.ship === id)));
    }
    if (sel.step === 'dest' || sel.step === 'confirm') {
      hl.selectedShip = sel.ship;
      if (sel.reach) {
        hl.reach = sel.reach.dist;
        hl.from = ships[sel.ship].hex;
      }
      if (sel.dest !== undefined) {
        hl.target = sel.dest;
        hl.path = pathTo(sel.reach.prev, ships[sel.ship].hex, sel.dest);
      }
    }
    if (sel.moves?.length) hl.selectedShips = sel.moves.map((m) => m.ship);
    if (sel.step === 'port' || (sel.step === 'confirm' && sel.card.type === 'oil')) hl.ports = new Set(sel.ports || []);
    if (sel.card.type === 'anchor' && sel.step === 'confirm') hl.selectedShip = sel.ship;
  }
  board.setHighlight(hl);
}

function rangeFor(type) {
  let r = E.SAIL_RANGE[type] || 0;
  if ((type === 'sail2' || type === 'sail3') && view.opts.relic === 'compass' && view.compassReady?.[actingRole()]) r += 1;
  return r;
}

function reachFor(ships, shipId, range) {
  const v = { ...view, ships };
  return reach(ships[shipId].hex, range, (h) => E.isPassable(v, h), E.COLS, E.ROWS);
}

function selectCard(card) {
  if (!isMyTurn()) {
    toast(`Așteaptă rândul tău — acum joacă ${partnerName()}.`);
    return;
  }
  if (board.animating || busy) return;
  signalMode = false;
  sfx.card();
  haptic(8);
  if (sel?.card.id === card.id) {
    sel = null;
    closeSheet();
    renderAll();
    return;
  }
  sel = { card, step: 'ship', moves: [] };
  closeSheet();
  if (card.type === 'oil') {
    const ports = view.ports.filter((p) => p.kind === 'port' && p.light < E.MAX_LIGHT
      && view.ships.some((s) => s.hex === p.hex || neighbors(p.hex, E.COLS, E.ROWS).includes(s.hex))).map((p) => p.id);
    sel.step = 'port';
    sel.ports = ports;
    if (!ports.length) toast('Nicio navă nu e lângă un far care are nevoie de ulei. Poți arunca cartea.', { life: 3 });
  } else if (card.type === 'radio') {
    sel.step = 'confirm';
    openSheet({
      title: '📻 Radio',
      text: `+1 semnal pentru amândoi în noaptea asta. ${actingRole() === 'A' ? 'Vei vedea furtunile cu încă o noapte înainte.' : 'Vei vedea următoarea cerere care apare.'}`,
      buttons: [{ label: 'Joacă', primary: true, act: () => send({ type: 'play', card: card.id }) }],
    });
  }
  renderAll();
}

function onBoardTap({ hex, ship }) {
  if (!view || hex === null) return;
  if (board.animating) return;
  if (signalMode) return signalAt(hex);
  if (!sel) return inspect(hex, ship);
  const ships = sel.ships || view.ships;
  const t = sel.card.type;

  if (sel.step === 'port') {
    const port = view.ports.find((p) => p.hex === hex);
    if (port && sel.ports.includes(port.id)) {
      sfx.tap();
      sel.step = 'confirm';
      sel.port = port.id;
      openSheet({
        title: `🕯️ Ulei de rezervă — ${port.name}`,
        text: `Farul trece de la ${port.light} la ${port.light + 1} 🔥.`,
        buttons: [{ label: 'Aprinde', primary: true, act: () => send({ type: 'play', card: sel.card.id, port: port.id }) }],
      });
      renderAll();
    }
    return;
  }

  const tapShip = ship !== null && ship !== undefined ? ship : ships.find((s) => s.hex === hex && sel.step === 'ship')?.id;
  if ((sel.step === 'ship' || (sel.step === 'dest' && tapShip !== undefined && tapShip !== sel.ship && sel.dest === undefined && !sel.reach?.dist.has(hex)))
      && tapShip !== undefined && tapShip !== null) {
    if (sel.moves.some((m) => m.ship === tapShip)) {
      toast('Alege o navă diferită.');
      return;
    }
    sfx.tap();
    haptic(6);
    sel.ship = tapShip;
    if (t === 'anchor') {
      sel.step = 'confirm';
      openSheet({
        title: `🛡️ Adăpost — ${ships[tapShip].name}`,
        text: 'Nava nu poate fi lovită de furtună în noaptea asta.',
        buttons: [{ label: 'Adăpostește', primary: true, act: () => send({ type: 'play', card: sel.card.id, ship: tapShip }) }],
      });
    } else {
      sel.step = 'dest';
      sel.dest = undefined;
      sel.reach = reachFor(ships, tapShip, rangeFor(t));
      closeSheet();
    }
    renderAll();
    return;
  }

  if ((sel.step === 'dest' || sel.step === 'confirm') && sel.reach && sel.reach.dist.has(hex) && t !== 'anchor') {
    sfx.tap();
    sel.dest = hex;
    sel.step = 'confirm';
    openMoveSheet();
    renderAll();
    return;
  }
  if (sel.step === 'dest' && tapShip !== undefined && tapShip !== null && tapShip !== sel.ship) {
    sel.ship = tapShip;
    sel.reach = reachFor(ships, tapShip, rangeFor(t));
    renderAll();
  }
}

function openMoveSheet() {
  const ships = sel.ships || view.ships;
  const ship = ships[sel.ship];
  const port = view.ports.find((p) => p.hex === sel.dest);
  const t = sel.card.type;
  const steps = sel.reach.dist.get(sel.dest);
  const lines = [];
  let canLoad = false;
  if (port) {
    const open = port.kind === 'depot' || port.light > 0;
    if (!open) lines.push(`🌑 ${port.name} e stins — primește doar ulei.`);
    if (ship.cargo.includes('ulei') && port.kind === 'port' && port.light < E.MAX_LIGHT) lines.push('🛢️ Descarcă ulei: +2 lumină.');
    if (open) {
      const known = view.demands.filter((d) => d.port === port.id && d.good && ship.cargo.includes(d.good));
      for (const d of known) lines.push(`✅ Livrează ${GOOD_ICON[d.good]} aici!`);
      canLoad = true;
    }
  }
  const item = view.items.find((it) => it.hex === sel.dest);
  if (item) lines.push(`🎁 Ridică ${E.ITEMS[item.kind].icon} ${E.ITEMS[item.kind].name}.`);
  const tonight = view.forecast[0];
  if (tonight?.hexes.includes(sel.dest) && !(port && (port.kind === 'depot' || port.light > 0))) lines.push('⚠️ Aici lovește furtuna diseară!');
  if (view.signals.some((s) => s.hex === sel.dest && s.kind === 'danger')) lines.push('⚠️ Partenerul a semnalat pericol aici.');
  if (sel.load === undefined) sel.load = canLoad && ship.cargo.length < 2 && !ship.cargo.includes(port.product);
  const drop = ship.cargo.length >= 2 ? ` (aruncă ${GOOD_ICON[ship.cargo[0]]})` : '';
  const options = canLoad ? [{ label: `Încarcă ${GOOD_ICON[port.product]} ${GOOD_NAME[port.product]}${drop}`, on: sel.load, toggle: () => { sel.load = !sel.load; openMoveSheet(); } }] : [];
  const move = { ship: sel.ship, to: sel.dest, load: Boolean(canLoad && sel.load) };
  const buttons = [];
  if (t === 'tailwind' && sel.moves.length === 0) {
    buttons.push({ label: 'A doua navă →', act: () => {
      sel.moves.push(move);
      sel.ships = ships.map((s) => (s.id === move.ship ? { ...s, hex: move.to } : s));
      sel.step = 'ship';
      sel.ship = undefined;
      sel.dest = undefined;
      sel.reach = null;
      sel.load = undefined;
      closeSheet();
      renderAll();
    } });
    buttons.push({ label: 'Doar una ✓', primary: true, act: () => send({ type: 'play', card: sel.card.id, moves: [move] }) });
  } else if (t === 'tailwind') {
    buttons.push({ label: 'Navighează ✓', primary: true, act: () => send({ type: 'play', card: sel.card.id, moves: [...sel.moves, move] }) });
  } else {
    buttons.push({ label: steps === 0 ? 'Rămâi aici ✓' : 'Navighează ✓', primary: true, act: () => send({ type: 'play', card: sel.card.id, ...move }) });
  }
  const dest = port ? port.name : 'larg';
  openSheet({
    title: `${E.CARDS[t].icon} ${ship.name} → ${dest}${steps ? ` · ${steps} hex` : ''}`,
    text: lines.join(' ') || 'Mare liberă.',
    options,
    buttons,
  });
}

function inspect(hex, shipId) {
  const ships = view.ships;
  if (shipId !== null && shipId !== undefined) {
    const s = ships[shipId];
    const cargo = s.cargo.length ? s.cargo.map((g) => GOOD_ICON[g]).join(' ') : 'gol';
    toast(`${s.owner === 'A' ? '🟠' : '🔵'} ${s.name} · corp ${'❤️'.repeat(s.hull)}${'🖤'.repeat(E.MAX_HULL - s.hull)} · marfă: ${cargo}`);
    return;
  }
  const port = view.ports.find((p) => p.hex === hex);
  if (port) {
    const dem = view.demands.find((d) => d.port === port.id);
    const demText = dem ? ` · cere ${dem.good ? GOOD_ICON[dem.good] : '❓'} (${dem.due - view.night + 1} nopți)` : '';
    if (port.kind === 'depot') toast('🏚 Depozitul — încarcă ulei 🛢️ aici. Navele sunt la adăpost.');
    else toast(`🗼 ${port.name} · produce ${GOOD_ICON[port.product]} · lumină ${port.light}/3${demText}`);
  }
}

// ------------------------------------------------------------ signals

$('#btnSignal').onclick = () => {
  if (!view || view.phase !== 'play') return;
  sfx.tap();
  if (signalMode) {
    signalMode = false;
  } else {
    if (signalsLeft() <= 0) {
      toast('Nu mai ai semnale în noaptea asta.');
      return;
    }
    sel = null;
    closeSheet();
    signalMode = true;
  }
  renderAll();
};

function signalAt(hex) {
  const port = view.ports.find((p) => p.hex === hex);
  const sendSignal = (kind, good) => {
    signalMode = false;
    closeSheet();
    send({ type: 'signal', hex, kind, good }, false);
  };
  if (port) {
    openSheet({
      title: `📡 Semnal pe ${port.name}`,
      text: 'Ce vrei să-i transmiți partenerului?',
      options: [
        { label: '⚠️ Pericol', act: () => sendSignal('danger') },
        ...E.CARGO.map((g) => ({ label: `${GOOD_ICON[g]} vreau ${GOOD_NAME[g]}`, act: () => sendSignal('want', g) })),
      ],
      buttons: [],
    });
  } else {
    openSheet({
      title: '📡 Semnal de pericol',
      text: 'Pui ⚠️ pe hexul ăsta?',
      buttons: [{ label: '⚠️ Pune semnalul', primary: true, act: () => sendSignal('danger') }],
    });
  }
}

// ------------------------------------------------------------ actions

function send(action, isPlay = true) {
  if (busy) return;
  closeSheet();
  if (isPlay) {
    const el = document.querySelector(`.card[data-card="${action.card}"]`);
    el?.classList.add('flying');
    sfx.card();
    haptic(15);
    busy = true;
    setTimeout(() => { busy = false; }, 6000);
  }
  sel = null;
  ctl.act(action);
  renderAll();
}

$('#hand').onclick = (e) => {
  const b = e.target.closest('[data-card]');
  if (!b) return;
  const card = myHand()?.find((c) => c.id === Number(b.dataset.card));
  if (card) selectCard(card);
};

$('#btnDiscard').onclick = () => {
  if (!sel || !isMyTurn()) {
    toast('Alege întâi cartea pe care vrei s-o arunci.');
    return;
  }
  const card = sel.card;
  openSheet({
    title: `🗑 Arunci ${E.CARDS[card.type].name}?`,
    text: 'Îți folosești tura fără efect. Primești cărți noi dimineața.',
    buttons: [{ label: 'Aruncă', primary: true, act: () => send({ type: 'discard', card: card.id }) }],
  });
};

$('#btnReact').onclick = () => {
  const pop = $('#reactPop');
  if (!pop.classList.contains('hidden')) {
    pop.classList.add('hidden');
    return;
  }
  pop.innerHTML = ['❤️', '👏', '😱', '😂', '🔥', '🙏'].map((e) => `<button data-emoji="${e}">${e}</button>`).join('');
  pop.classList.remove('hidden');
};
$('#reactPop').onclick = (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b) return;
  ctl?.react(b.dataset.emoji);
  floater(b.dataset.emoji);
  $('#reactPop').classList.add('hidden');
};

function floater(emoji) {
  const el = document.createElement('div');
  el.className = 'floater';
  el.textContent = emoji;
  el.style.left = `${20 + Math.random() * 60}%`;
  $('#floaters').appendChild(el);
  haptic(10);
  setTimeout(() => el.remove(), 2500);
}

// ------------------------------------------------------------ sheet

let sheetCancel = true;
function openSheet({ title, text, options = [], buttons = [] }) {
  const el = $('#sheet');
  el.innerHTML = `<h4>${esc(title)}</h4><p>${esc(text)}</p>
    ${options.length ? `<div class="opts">${options.map((o, k) => `<button class="opt ${o.on ? 'on' : ''}" data-opt="${k}">${o.toggle ? (o.on ? '☑ ' : '☐ ') : ''}${esc(o.label)}</button>`).join('')}</div>` : ''}
    <div class="btns"><button class="btn ghost" data-cancel>Anulează</button>${buttons.map((b, k) => `<button class="btn ${b.primary ? 'primary' : ''}" data-btn="${k}">${esc(b.label)}</button>`).join('')}</div>`;
  el.onclick = (e) => {
    const o = e.target.closest('[data-opt]');
    if (o) {
      sfx.tap();
      const opt = options[Number(o.dataset.opt)];
      (opt.toggle || opt.act)();
      return;
    }
    const b = e.target.closest('[data-btn]');
    if (b) {
      buttons[Number(b.dataset.btn)].act();
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      sfx.tap();
      closeSheet();
      if (signalMode) signalMode = false;
      else if (sel) {
        if (sel.step === 'confirm' && sel.reach) {
          sel.step = 'dest';
          sel.dest = undefined;
          sel.load = undefined;
        } else sel = null;
      }
      renderAll();
    }
  };
  el.classList.add('open');
}
function closeSheet() {
  $('#sheet').classList.remove('open');
}

// ------------------------------------------------------------ menu

$('#btnMenu').onclick = () => {
  sfx.tap();
  const code = loadSession()?.code;
  modal(`<h3>Meniu</h3>
    ${!isLocal && code ? `<p>Camera: <b style="color:var(--gold);letter-spacing:3px">${esc(code)}</b></p>` : ''}
    <button class="btn" data-act="rules">📜 Reguli</button>
    <button class="btn" data-act="sound">${isMuted() ? '🔊 Pornește sunetul' : '🔇 Oprește sunetul'}</button>
    <button class="btn" data-act="home">🏠 Ieși (partida rămâne salvată)</button>
    <button class="btn ghost" data-act="quit">🚪 Abandonează partida</button>
    <button class="btn primary" data-act="close">Înapoi la joc</button>`, {
    rules: () => { closeModal(); rulesReturn = 'game'; show('rules'); },
    sound: () => { setMuted(!isMuted()); closeModal(); },
    home: () => { closeModal(); show('home'); },
    quit: () => {
      closeModal();
      ctl?.leave();
      ctl = null;
      view = null;
      show('home');
    },
    close: closeModal,
  });
};

// ------------------------------------------------------------ result

function showResult() {
  const r = view.result;
  if (!r) return;
  const title = r.win ? 'Coasta e în siguranță!' : r.reason === 'dark' ? 'Coasta s-a stins…' : 'S-a făcut ziuă…';
  const sub = r.win
    ? `Ați reușit în ${r.nights} nopți. Echipă bună!`
    : r.reason === 'dark' ? 'Trei faruri s-au stins. Mai încercați o dată?' : `Ați livrat ${view.delivered} din ${view.target}. Aproape!`;
  $('#resIcon').textContent = r.win ? '🏆' : r.reason === 'dark' ? '🌑' : '🌅';
  $('#resTitle').textContent = title;
  $('#resSub').textContent = sub;
  $('#resStars').innerHTML = [0, 1, 2].map(() => '<span>⭐</span>').join('');
  $('#resGrid').innerHTML = `
    <div><b>${view.delivered}/${view.target}</b>livrări</div>
    <div><b>${r.lit}/5</b>faruri aprinse</div>
    <div><b>${view.sunk}</b>nave scufundate</div>
    <div><b>${r.score}</b>scor</div>`;
  const key = `${view.opts.seed}:${loadSession()?.code || 'local'}:${r.score}`;
  let gained = 0;
  if (!profile.claimed.includes(key)) {
    profile.claimed.push(key);
    profile.shells += r.shells;
    gained = r.shells;
    const day = todayKey();
    if (view.opts.seed === hashSeed(`farul:${day}`)) profile.best[day] = Math.max(profile.best[day] || 0, r.score);
    saveProfile();
  }
  $('#resShells').textContent = '';
  $('#btnRematch').textContent = isLocal ? '🔄 Încă o partidă' : '🔄 Revanșă (schimbați rolurile)';
  $('#result').classList.add('active');
  screen = 'result';
  if (r.win) {
    sfx.win();
    confetti();
  } else sfx.lose();
  $$('#resStars span').forEach((s, k) => {
    if (k < r.stars) setTimeout(() => { s.classList.add('on'); sfx.chime(); haptic(15); }, 500 + k * 350);
  });
  if (gained) {
    let n = 0;
    const tick = setInterval(() => {
      n = Math.min(gained, n + 1);
      $('#resShells').textContent = `+${n} 🐚 pentru Atelier`;
      if (n >= gained) clearInterval(tick);
    }, 60);
  }
  const best = profile.best[todayKey()];
  if (best && view.opts.seed === hashSeed(`farul:${todayKey()}`)) $('#resSub').textContent += ` Recordul zilei: ${best}.`;
}

function confetti() {
  const box = $('#confetti');
  box.innerHTML = '';
  const colors = ['#ffd36e', '#ff9f43', '#45d9e8', '#ff5a6e', '#9b7bff', '#3cd68f'];
  for (let k = 0; k < 80; k++) {
    const i = document.createElement('i');
    i.style.left = `${Math.random() * 100}%`;
    i.style.background = colors[k % colors.length];
    i.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    i.style.animationDelay = `${Math.random() * 0.8}s`;
    i.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(i);
  }
  setTimeout(() => { box.innerHTML = ''; }, 6000);
}

$('#btnRematch').onclick = () => {
  sfx.tap();
  $('#result').classList.remove('active');
  screen = 'game';
  if (isLocal) {
    view = null;
    ctl.rematch({});
  } else {
    ctl.rematch({});
    toast('Revanșă! Rolurile se schimbă…');
  }
};
$('#btnHome').onclick = () => {
  $('#result').classList.remove('active');
  ctl?.leave();
  ctl = null;
  view = null;
  show('home');
};

// ------------------------------------------------------------ shop

function renderShop() {
  $('#shopShells').textContent = profile.shells;
  const groups = [['beam', '🔦 Lumina farului'], ['boat', '⛵ Nave'], ['relic', '🗝️ Relicve (aleg la crearea partidei)']];
  $('#shopList').innerHTML = groups.map(([cat, title]) => `<h3>${title}</h3><div class="shop-grid">${SHOP.filter((i) => i.cat === cat).map((it) => {
    const owned = it.cost === 0 || profile.owned.includes(it.id);
    const equipped = (cat === 'beam' && profile.beam === it.v) || (cat === 'boat' && profile.boat === it.v);
    const preview = cat === 'beam'
      ? `<span class="beam-dot" style="background:radial-gradient(circle, ${it.color} 0%, ${it.color}55 40%, transparent 70%)"></span>`
      : it.icon;
    let btn;
    if (cat === 'relic') btn = owned ? '<button class="btn" disabled>Deținută</button>' : `<button class="btn primary" data-buy="${it.id}">${it.cost} 🐚</button>`;
    else if (equipped) btn = '<button class="btn" disabled>Echipat ✓</button>';
    else if (owned) btn = `<button class="btn" data-equip="${it.id}">Echipează</button>`;
    else btn = `<button class="btn primary" data-buy="${it.id}">${it.cost} 🐚</button>`;
    return `<div class="item ${equipped ? 'equipped' : ''}"><div class="preview">${preview}</div><b>${esc(it.name)}</b><small>${esc(it.desc)}</small>${btn}</div>`;
  }).join('')}</div>`).join('')
    + '<p class="hint">Câștigați 🐚 la fiecare partidă: stele, livrări și scoici de aur găsite pe mare.</p>';
}
$('#shopList').onclick = (e) => {
  const buy = e.target.closest('[data-buy]');
  const equip = e.target.closest('[data-equip]');
  const it = SHOP.find((x) => x.id === (buy?.dataset.buy || equip?.dataset.equip));
  if (!it) return;
  if (buy) {
    if (profile.shells < it.cost) {
      toast(`Îți mai trebuie ${it.cost - profile.shells} 🐚`);
      haptic(30);
      return;
    }
    profile.shells -= it.cost;
    profile.owned.push(it.id);
    sfx.chime();
    haptic([15, 30, 15]);
  }
  if (it.cat === 'beam') profile.beam = it.v;
  if (it.cat === 'boat') profile.boat = it.v;
  saveProfile();
  renderShop();
};

// ------------------------------------------------------------ home scene

function homeScene(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.55, r: Math.random() * 1.4 + 0.3, p: Math.random() * 6 }));
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
  const draw = (ms) => {
    requestAnimationFrame(draw);
    if (screen !== 'home' || !w) return;
    const t = ms / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#030714');
    sky.addColorStop(0.5, '#0d1d40');
    sky.addColorStop(0.62, '#1a2b55');
    sky.addColorStop(1, '#050b1a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      ctx.fillStyle = `rgba(230,236,255,${0.35 + 0.35 * Math.sin(t * 1.3 + s.p)})`;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // moon
    const mx = w * 0.2, my = h * 0.13;
    const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 90);
    mg.addColorStop(0, 'rgba(255,248,220,0.9)');
    mg.addColorStop(0.18, 'rgba(255,248,220,0.85)');
    mg.addColorStop(0.2, 'rgba(200,210,255,0.18)');
    mg.addColorStop(1, 'rgba(200,210,255,0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(mx, my, 90, 0, Math.PI * 2);
    ctx.fill();
    const horizon = h * 0.58;
    // sea
    const sea = ctx.createLinearGradient(0, horizon, 0, h);
    sea.addColorStop(0, '#11264d');
    sea.addColorStop(1, '#040915');
    ctx.fillStyle = sea;
    ctx.fillRect(0, horizon, w, h - horizon);
    for (let k = 0; k < 26; k++) {
      const y = horizon + (k / 26) ** 1.6 * (h - horizon);
      ctx.strokeStyle = `rgba(150,190,255,${0.05 + 0.06 * Math.sin(t + k)})`;
      ctx.lineWidth = 1 + k * 0.05;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 12) {
        const yy = y + Math.sin(x * 0.03 + t * 1.2 + k) * (1 + k * 0.15);
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // moon reflection
    for (let k = 0; k < 14; k++) {
      const y = horizon + 8 + k * 9;
      const ww = 14 + k * 4 + Math.sin(t * 2 + k) * 6;
      ctx.fillStyle = `rgba(255,240,200,${0.18 - k * 0.011})`;
      ctx.fillRect(mx - ww / 2 + Math.sin(t + k) * 4, y, ww, 2);
    }
    // cliff and lighthouse
    const lx = w * 0.76, ly = horizon - 6;
    ctx.fillStyle = '#060c18';
    ctx.beginPath();
    ctx.moveTo(w * 0.55, horizon + 30);
    ctx.quadraticCurveTo(w * 0.62, horizon - 30, lx - 30, ly);
    ctx.lineTo(lx + 40, ly - 6);
    ctx.quadraticCurveTo(w * 0.95, horizon - 20, w, horizon - 10);
    ctx.lineTo(w, horizon + 40);
    ctx.closePath();
    ctx.fill();
    const th = Math.min(150, h * 0.2);
    ctx.fillStyle = '#0a1222';
    ctx.beginPath();
    ctx.moveTo(lx - 16, ly);
    ctx.lineTo(lx - 9, ly - th);
    ctx.lineTo(lx + 9, ly - th);
    ctx.lineTo(lx + 16, ly);
    ctx.fill();
    const lampY = ly - th - 12;
    // beam
    const a = t * 0.7;
    const len = Math.max(w, h) * 1.2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const aa of [a, a + Math.PI]) {
      const dir = Math.cos(aa);
      const spread = 0.09 + 0.05 * Math.abs(Math.sin(aa));
      const g = ctx.createLinearGradient(lx, lampY, lx + dir * len, lampY);
      g.addColorStop(0, `rgba(255,220,140,${0.38 * Math.abs(dir) + 0.05})`);
      g.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(lx, lampY);
      ctx.lineTo(lx + dir * len, lampY - len * spread);
      ctx.lineTo(lx + dir * len, lampY + len * spread * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    const glow = ctx.createRadialGradient(lx, lampY, 0, lx, lampY, 60);
    glow.addColorStop(0, 'rgba(255,236,180,1)');
    glow.addColorStop(0.15, 'rgba(255,210,120,0.8)');
    glow.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(lx, lampY, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#0a1222';
    ctx.beginPath();
    ctx.moveTo(lx - 12, lampY - 8);
    ctx.lineTo(lx, lampY - 22);
    ctx.lineTo(lx + 12, lampY - 8);
    ctx.fill();
    // a small boat crossing
    const bx = ((t * 14) % (w + 120)) - 60, by = horizon + 26 + Math.sin(t * 2) * 2;
    ctx.fillStyle = '#0a1222';
    ctx.beginPath();
    ctx.moveTo(bx - 16, by);
    ctx.lineTo(bx + 18, by);
    ctx.lineTo(bx + 11, by + 7);
    ctx.lineTo(bx - 11, by + 7);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx + 1, by - 26);
    ctx.lineTo(bx + 1, by - 2);
    ctx.lineTo(bx + 15, by - 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,200,120,0.9)';
    ctx.fillRect(bx - 6, by + 1, 2, 2);
  };
  requestAnimationFrame(draw);
}

// ------------------------------------------------------------ wake lock & PWA

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && screen === 'game') requestWakeLock();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ------------------------------------------------------------ boot

const board = new Board($('#board'), { onTap: onBoardTap, onShown: renderHud });
window.farulDebug = { board, view: () => view };
homeScene($('#homeCanvas'));
const params = new URLSearchParams(location.search);
const joinCode = (params.get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (joinCode.length === 4) {
  $('#codeInput').value = joinCode;
  history.replaceState(null, '', location.pathname);
  show('join');
} else show('home');
if (window.FARUL_STATIC) {
  // static preview build: online play needs the server, only training mode works
  $('#btnCreate').classList.add('hidden');
  $('#btnJoin').classList.add('hidden');
  $('#btnLocal').classList.replace('ghost', 'primary');
}
