// Canvas renderer for the board: night sea, lighthouses with rotating beams, ships,
// storms with lightning, particles, and the per-event animation timeline.
import { COLS, ROWS, MAX_HULL } from './engine/engine.js';
import { hexCenter, neighbors, distance } from './engine/hex.js';
import { sfx, haptic } from './fx.js';

const SQRT3 = Math.sqrt(3);
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
export const GOOD_ICON = { peste: '🐟', sare: '🧂', lemn: '🪵', ulei: '🛢️' };
export const GOOD_NAME = { peste: 'pește', sare: 'sare', lemn: 'lemn', ulei: 'ulei' };
export const GOOD_COLOR = { peste: '#5ab0ff', sare: '#eef2f7', lemn: '#c08552', ulei: '#ffcc4d' };
export const ROLE_COLOR = { A: '#ffb347', B: '#45d9e8' };
const BEAMS = { amber: '255,214,128', emerald: '120,255,190', amethyst: '205,160,255', ice: '170,225,255' };
const ITEM_ICON = { barrel: '🛢️', bottle: '🍾', ring: '🛟', shell: '🐚' };

const clone = (x) => JSON.parse(JSON.stringify(x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const rand = (a, b) => a + Math.random() * (b - a);

export class Board {
  constructor(canvas, { onTap, onShown } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTap = onTap || (() => {});
    this.onShown = onShown || (() => {});
    this.shown = null;
    this.role = 'A';
    this.cosmetics = { beam: 'amber', boat: 'velier' };
    this.disp = new Map();
    this.particles = [];
    this.tweens = [];
    this.texts = [];
    this.hl = {};
    this.storm = null;
    this.flash = 0;
    this.shake = 0;
    this.dark = 0;
    this.banner = null;
    this.animating = false;
    this.queue = Promise.resolve();
    this.last = performance.now();
    this.time = 0;
    this.running = true;

    const ro = new ResizeObserver(() => this.layout());
    ro.observe(canvas);
    this.bindInput();
    this.layout();
    requestAnimationFrame((t) => this.frame(t));
    document.addEventListener('visibilitychange', () => {
      this.last = performance.now();
    });
  }

  // ------------------------------------------------------------ layout

  layout() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    const s = Math.min(this.w / (SQRT3 * (COLS + 0.5)), this.h / (1.5 * (ROWS - 1) + 2)) * 0.985;
    this.s = s;
    this.ox = (this.w - SQRT3 * s * (COLS + 0.5)) / 2 + (SQRT3 * s) / 2;
    this.oy = (this.h - s * (1.5 * (ROWS - 1) + 2)) / 2 + s;
    this.centers = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const c = hexCenter(i, COLS, s);
      this.centers.push({ x: this.ox + c.x, y: this.oy + c.y });
    }
    this.buildStatic();
    if (this.shown) this.snapShips();
  }

  hexPath(ctx, i, scale = 1) {
    const { x, y } = this.centers[i];
    const r = this.s * scale;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (60 * k - 30);
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  corners(i) {
    const { x, y } = this.centers[i];
    return Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 180) * (60 * k - 30);
      return { x: x + this.s * Math.cos(a), y: y + this.s * Math.sin(a) };
    });
  }

  buildStatic() {
    if (!this.shown || !this.w) return;
    const tiles = this.shown.tiles;
    const off = document.createElement('canvas');
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const ctx = off.getContext('2d');
    ctx.scale(this.dpr, this.dpr);

    const bg = ctx.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, '#040a18');
    bg.addColorStop(1, '#0a1a33');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // depth: distance from the nearest land
    const land = [];
    tiles.forEach((t, i) => t === 'land' && land.push(i));
    this.coast = [];
    for (let i = 0; i < tiles.length; i++) {
      const { x, y } = this.centers[i];
      if (tiles[i] === 'sea') {
        const depth = Math.min(4, ...land.map((l) => distance(l, i, COLS)));
        const g = ctx.createRadialGradient(x, y - this.s * 0.4, 0, x, y, this.s * 1.2);
        const l1 = 26 - depth * 3, l2 = 18 - depth * 2.5;
        g.addColorStop(0, `hsl(208, 62%, ${l1}%)`);
        g.addColorStop(1, `hsl(214, 66%, ${l2}%)`);
        this.hexPath(ctx, i, 1.01);
        ctx.fillStyle = g;
        ctx.fill();
        this.hexPath(ctx, i, 0.97);
        ctx.strokeStyle = 'rgba(140,190,255,0.07)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        const g = ctx.createLinearGradient(x, y - this.s, x, y + this.s);
        g.addColorStop(0, '#2c4434');
        g.addColorStop(1, '#16261d');
        this.hexPath(ctx, i, 1.02);
        ctx.fillStyle = g;
        ctx.fill();
        // tufts and rocks, deterministic per tile
        let seed = i * 9301 + 49297;
        const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        for (let k = 0; k < 5; k++) {
          const px = x + (rnd() - 0.5) * this.s * 1.2, py = y + (rnd() - 0.5) * this.s * 1.1;
          ctx.fillStyle = rnd() > 0.5 ? 'rgba(90,130,90,0.35)' : 'rgba(20,30,25,0.5)';
          ctx.beginPath();
          ctx.arc(px, py, this.s * (0.05 + rnd() * 0.08), 0, Math.PI * 2);
          ctx.fill();
        }
        for (const n of neighbors(i, COLS, ROWS)) {
          if (tiles[n] !== 'sea') continue;
          const nc = this.centers[n];
          const cs = this.corners(i).sort((a, b) => Math.hypot(a.x - nc.x, a.y - nc.y) - Math.hypot(b.x - nc.x, b.y - nc.y));
          this.coast.push([cs[0], cs[1], nc]);
        }
      }
    }
    // sandy shoreline
    ctx.lineCap = 'round';
    for (const [a, b] of this.coast) {
      ctx.strokeStyle = 'rgba(214,190,140,0.55)';
      ctx.lineWidth = this.s * 0.12;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    this.staticLayer = off;
    this.waves = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== 'sea') continue;
      for (let k = 0; k < 2; k++) this.waves.push({ i, dx: rand(-0.45, 0.45), dy: rand(-0.4, 0.4), ph: rand(0, 6.28), w: rand(0.25, 0.4) });
    }
    this.stars = Array.from({ length: 40 }, () => ({ x: rand(0, this.w), y: rand(0, this.h), r: rand(0.4, 1.3), ph: rand(0, 6.28) }));
  }

  // ------------------------------------------------------------ state

  setRole(role) { this.role = role; }

  setCosmetics(c) { this.cosmetics = { ...this.cosmetics, ...c }; }

  setView(view) {
    const first = !this.shown || this.shown.tiles.join() !== view.tiles.join();
    this.target = view;
    if (first) {
      this.shown = clone(view);
      this.buildStatic();
      this.snapShips();
      this.onShown(this.shown);
    } else if (!this.animating) {
      this.shown = clone(view);
      this.onShown(this.shown);
    }
  }

  setHighlight(hl) { this.hl = hl || {}; }

  shipSlot(view, id) {
    const ship = view.ships[id];
    const here = view.ships.filter((s) => s.hex === ship.hex).map((s) => s.id);
    const k = here.indexOf(id);
    const n = here.length;
    const c = this.centers[ship.hex];
    const s = this.s;
    const isPort = view.ports.some((p) => p.hex === ship.hex);
    const baseY = isPort ? s * 0.42 : s * 0.08;
    const offs = n === 1 ? [[0, 0]] : n === 2 ? [[-0.36, 0], [0.36, 0]] : isPort
      ? [[-0.5, 0.05], [0.5, 0.05], [-0.22, 0.32], [0.22, 0.32]]
      : [[-0.36, -0.22], [0.36, -0.22], [-0.36, 0.28], [0.36, 0.28]];
    const [dx, dy] = offs[Math.min(k, offs.length - 1)];
    const scale = (n >= 3 ? 0.68 : n === 2 ? 0.8 : 1) * (isPort ? 0.9 : 1);
    return { x: c.x + dx * s, y: c.y + baseY + dy * s, scale };
  }

  snapShips() {
    if (!this.shown || !this.centers) return;
    for (const ship of this.shown.ships) {
      const slot = this.shipSlot(this.shown, ship.id);
      const d = this.disp.get(ship.id) || { face: 1, alpha: 1, tilt: 0 };
      Object.assign(d, slot);
      this.disp.set(ship.id, d);
    }
  }

  // ------------------------------------------------------------ input

  bindInput() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
      down = null;
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.onTap(this.hitTest(x, y));
    });
  }

  hitTest(x, y) {
    let ship = null, best = this.s * 0.5;
    if (this.shown) {
      for (const s of this.shown.ships) {
        const d = this.disp.get(s.id);
        if (!d) continue;
        const dist = Math.hypot(d.x - x, d.y - 4 - y);
        if (dist < best) { best = dist; ship = s.id; }
      }
    }
    let hex = null, hb = this.s;
    this.centers?.forEach((c, i) => {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < hb) { hb = d; hex = i; }
    });
    return { hex, ship, x, y };
  }

  screenPos(hex) {
    const c = this.centers[hex];
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + c.x, y: r.top + c.y };
  }

  // ------------------------------------------------------------ effects primitives

  tween(dur, fn) {
    return new Promise((resolve) => this.tweens.push({ t0: this.time, dur: dur / 1000, fn, resolve }));
  }

  wait(ms) {
    return this.tween(ms, () => {});
  }

  addText(x, y, text, color = '#fff', size = 1) {
    this.texts.push({ x, y, text, color, size, life: 0, max: 1.6 });
  }

  burst(x, y, kind, n, opts = {}) {
    for (let k = 0; k < n; k++) {
      const a = rand(0, Math.PI * 2), sp = rand(opts.minSpeed ?? 20, opts.speed ?? 90);
      this.particles.push({
        kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.lift ?? 0), life: 0,
        max: rand(0.5, opts.life ?? 1.1), size: rand(opts.minSize ?? 1, opts.size ?? 3), color: opts.color || '255,220,140', g: opts.gravity ?? 0,
      });
    }
  }

  ring(x, y, color = '255,255,255', max = 1) {
    this.particles.push({ kind: 'ring', x, y, life: 0, max, size: this.s * 0.2, grow: this.s * 1.6, color });
  }

  flyEmoji(from, to, emoji, dur = 650) {
    const p = { kind: 'fly', x: from.x, y: from.y, emoji, alpha: 1 };
    this.particles.push(p);
    return this.tween(dur, (k) => {
      const e = ease(k);
      p.x = lerp(from.x, to.x, e);
      p.y = lerp(from.y, to.y, e) - Math.sin(Math.PI * k) * this.s * 1.2;
      if (k >= 1) p.dead = true;
    });
  }

  showBanner(title, sub = '', ms = 1500) {
    this.banner = { title, sub, t0: this.time, dur: ms / 1000 };
    return this.wait(Math.min(ms, 1100));
  }

  // ------------------------------------------------------------ event timeline

  /** Animate a batch of events, then settle on the authoritative view. */
  play(events, view, hooks = {}) {
    this.queue = this.queue.then(() => this.runEvents(events, view, hooks)).catch((e) => console.error(e));
    return this.queue;
  }

  async runEvents(events, view, hooks) {
    this.animating = true;
    try {
      for (const e of events) {
        await this.animateEvent(e, hooks);
        this.onShown(this.shown);
      }
    } finally {
      this.shown = clone(view);
      this.animating = false;
      this.onShown(this.shown);
    }
  }

  portById(id) { return this.shown.ports.find((p) => p.id === id); }

  async animateEvent(e, hooks) {
    const sh = this.shown;
    const s = this.s;
    switch (e.k) {
      case 'move': {
        const d = this.disp.get(e.ship);
        d.goal = null;
        const path = e.path.map((h) => this.centers[h]);
        sfx.sail();
        const startSlot = { x: d.x, y: d.y };
        sh.ships[e.ship].hex = e.path[e.path.length - 1];
        const endSlot = this.shipSlot(sh, e.ship);
        const pts = [startSlot, ...path.slice(1, -1).map((p) => ({ x: p.x, y: p.y + s * 0.08 })), endSlot];
        if (pts.length === 1) pts.push(endSlot);
        const per = 260;
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          if (Math.abs(b.x - a.x) > 2) d.face = b.x > a.x ? 1 : -1;
          await this.tween(per, (p) => {
            const q = ease(p);
            d.x = lerp(a.x, b.x, q);
            d.y = lerp(a.y, b.y, q);
            d.tilt = Math.sin(p * Math.PI) * 0.08 * d.face;
            if (Math.random() < 0.5) this.particles.push({ kind: 'wake', x: d.x - d.face * s * 0.3, y: d.y + s * 0.18, life: 0, max: 0.9, size: s * 0.05, color: '220,240,255' });
          });
        }
        d.tilt = 0;
        d.scale = endSlot.scale;
        this.relaxShips(e.ship);
        break;
      }
      case 'pickup': {
        const c = this.centers[e.hex];
        sh.items = sh.items.filter((it) => it.hex !== e.hex);
        const ship = sh.ships[e.ship];
        if (e.item === 'barrel' && ship.cargo.length < 2) ship.cargo.push('ulei');
        if (e.item === 'ring') ship.hull = MAX_HULL;
        sfx.chime();
        haptic(20);
        this.burst(c.x, c.y, 'spark', 26, { color: '255,230,150', speed: 120 });
        this.ring(c.x, c.y, '255,230,150');
        const label = { barrel: 'Butoi de ulei!', bottle: '+1 semnal', ring: 'Navă reparată!', shell: 'Scoică de aur!' }[e.item];
        this.addText(c.x, c.y - s * 0.6, `${ITEM_ICON[e.item]} ${label}`, '#ffe9a8');
        await this.wait(500);
        break;
      }
      case 'load': {
        const port = this.portById(e.port);
        const ship = sh.ships[e.ship];
        if (e.dropped) ship.cargo.shift();
        ship.cargo.push(e.good);
        const d = this.disp.get(e.ship);
        sfx.card();
        await this.flyEmoji(this.centers[port.hex], { x: d.x, y: d.y - s * 0.2 }, GOOD_ICON[e.good], 520);
        this.addText(d.x, d.y - s * 0.7, `+${GOOD_ICON[e.good]}`, '#cfe8ff', 0.9);
        break;
      }
      case 'unload': {
        const port = this.portById(e.port);
        const ship = sh.ships[e.ship];
        ship.cargo.splice(ship.cargo.indexOf('ulei'), 1);
        const d = this.disp.get(e.ship);
        await this.flyEmoji({ x: d.x, y: d.y - s * 0.2 }, { x: this.centers[port.hex].x, y: this.centers[port.hex].y - s * 0.5 }, '🛢️', 520);
        break;
      }
      case 'deliver': {
        const port = this.portById(e.port);
        const ship = sh.ships[e.ship];
        const at = ship.cargo.indexOf(e.good);
        if (at >= 0) ship.cargo.splice(at, 1);
        sh.demands = sh.demands.filter((d) => d.id !== e.id);
        sh.delivered = e.delivered;
        const c = this.centers[port.hex];
        const d = this.disp.get(e.ship);
        await this.flyEmoji({ x: d.x, y: d.y - s * 0.2 }, { x: c.x, y: c.y - s * 0.3 }, GOOD_ICON[e.good], 520);
        sfx.bell();
        haptic([20, 40, 30]);
        this.burst(c.x, c.y - s * 0.3, 'spark', 46, { color: '255,214,110', speed: 160, life: 1.4 });
        this.ring(c.x, c.y, '255,214,110', 1.2);
        this.addText(c.x, c.y - s, '+1 livrare', '#ffd86e', 1.25);
        hooks.deliver?.(e);
        await this.wait(650);
        break;
      }
      case 'light': {
        const port = this.portById(e.port);
        const c = this.centers[port.hex];
        port.light = e.to;
        if (e.to > e.from) {
          sfx.light();
          this.ring(c.x, c.y - s * 0.5, '255,220,140', 1);
          this.burst(c.x, c.y - s * 0.55, 'spark', 18, { color: '255,220,140', speed: 70 });
          this.addText(c.x, c.y - s * 0.95, `+${e.to - e.from} 🔥`, '#ffe08a');
        } else {
          sfx.dim();
          this.burst(c.x, c.y - s * 0.55, 'smoke', 10, { color: '150,150,170', speed: 20, lift: 30, size: 6, life: 1.6 });
          const why = { storm: 'furtună', burn: 'fitil', expire: 'cerere ratată' }[e.why] || '';
          this.addText(c.x, c.y - s * 0.95, `−1 🔥 ${why}`, '#ff8a8a', 0.85);
          if (e.to === 0) {
            this.addText(c.x, c.y - s * 1.4, `${port.name} s-a stins!`, '#ff6b6b', 1.1);
            haptic([40, 60, 40]);
          }
        }
        await this.wait(e.why === 'burn' ? 160 : 420);
        break;
      }
      case 'storm': {
        await this.runStorm(e);
        break;
      }
      case 'hit': {
        const d = this.disp.get(e.ship);
        sh.ships[e.ship].hull = e.hull;
        sfx.hit();
        haptic([30, 30, 30]);
        this.shake = Math.max(this.shake, 8);
        this.burst(d.x, d.y, 'debris', 14, { color: '160,110,70', speed: 110, gravity: 260, size: 4 });
        this.addText(d.x, d.y - s * 0.7, '−1 corp', '#ff9a8a', 0.9);
        await this.tween(450, (p) => { d.tilt = Math.sin(p * 30) * 0.25 * (1 - p); });
        break;
      }
      case 'shelter': {
        const d = this.disp.get(e.ship);
        this.ring(d.x, d.y, '140,220,255', 0.9);
        this.addText(d.x, d.y - s * 0.7, '🛡️ la adăpost', '#bfe9ff', 0.8);
        await this.wait(200);
        break;
      }
      case 'sink': {
        const d = this.disp.get(e.ship);
        const ship = sh.ships[e.ship];
        sfx.sink();
        haptic([60, 40, 60]);
        this.addText(d.x, d.y - s * 0.8, `${ship.name} s-a scufundat!`, '#ff7b7b', 1.05);
        await this.tween(1100, (p) => {
          d.sink = p;
          d.tilt = p * 0.9 * d.face;
          if (Math.random() < 0.6) this.particles.push({ kind: 'bubble', x: d.x + rand(-8, 8), y: d.y, vx: 0, vy: -rand(10, 30), life: 0, max: 1, size: rand(1, 3), color: '220,240,255' });
        });
        ship.hex = e.to;
        ship.cargo = [];
        ship.hull = MAX_HULL;
        const slot = this.shipSlot(sh, e.ship);
        Object.assign(d, slot, { sink: 0, tilt: 0, alpha: 0 });
        await this.tween(500, (p) => { d.alpha = p; });
        this.relaxShips(e.ship);
        break;
      }
      case 'repair': {
        sh.ships[e.ship].hull = e.hull;
        const d = this.disp.get(e.ship);
        this.burst(d.x, d.y, 'spark', 10, { color: '140,255,170', speed: 50 });
        await this.wait(120);
        break;
      }
      case 'burn': {
        await this.showBanner('Fitilul arde', 'toate farurile −1', 1300);
        break;
      }
      case 'expire': {
        const port = this.portById(e.port);
        sh.demands = sh.demands.filter((d) => d.id !== e.id);
        const c = this.centers[port.hex];
        this.burst(c.x + s * 0.55, c.y - s * 0.75, 'debris', 12, { color: '240,240,255', speed: 80, gravity: 200 });
        this.addText(c.x, c.y - s * 1.2, 'Cerere ratată', '#ffb0b0', 0.85);
        await this.wait(380);
        break;
      }
      case 'dawn': {
        sh.night = e.night;
        sh.signals = [];
        if (e.night > 1) {
          sfx.chime();
          await this.showBanner(`Noaptea ${e.night}`, e.night === sh.maxNights ? 'ultima noapte!' : '', 1500);
        }
        break;
      }
      case 'demand': {
        sh.demands = sh.demands.filter((d) => d.id !== e.id).concat([{ id: e.id, port: e.port, good: e.good, due: e.due }]);
        const port = this.portById(e.port);
        const c = this.centers[port.hex];
        sfx.ping();
        this.ring(c.x + s * 0.55, c.y - s * 0.75, '255,255,255', 0.7);
        await this.wait(250);
        break;
      }
      case 'item': {
        sh.items = sh.items.concat([{ id: e.id, hex: e.hex, kind: e.kind }]);
        const c = this.centers[e.hex];
        this.ring(c.x, c.y, '255,240,180', 1);
        await this.wait(200);
        break;
      }
      case 'signal': {
        sh.signals = sh.signals.concat([{ by: e.by, hex: e.hex, kind: e.kind, good: e.good }]);
        const c = this.centers[e.hex];
        sfx.ping();
        haptic(15);
        this.ring(c.x, c.y, e.kind === 'danger' ? '255,90,110' : '120,220,255', 1);
        this.ring(c.x, c.y, e.kind === 'danger' ? '255,90,110' : '120,220,255', 1.4);
        break;
      }
      case 'anchor': {
        const d = this.disp.get(e.ship);
        sh.ships[e.ship].anchored = sh.night;
        this.ring(d.x, d.y, '140,220,255', 1);
        this.addText(d.x, d.y - s * 0.7, '🛡️ adăpost', '#bfe9ff', 0.85);
        await this.wait(300);
        break;
      }
      case 'relic': {
        const port = this.portById(e.port);
        const c = this.centers[port.hex];
        this.addText(c.x, c.y - s * 1.3, '🏮 Felinarul bunicului!', '#ffe7a3');
        this.burst(c.x, c.y - s * 0.5, 'spark', 30, { color: '255,200,120' });
        await this.wait(500);
        break;
      }
      case 'play':
      case 'discard':
        hooks.card?.(e);
        await this.wait(e.by === hooks.me ? 80 : 650);
        break;
      default:
        hooks.other?.(e);
    }
  }

  relaxShips(except) {
    for (const ship of this.shown.ships) {
      if (ship.id === except) continue;
      const d = this.disp.get(ship.id);
      const slot = this.shipSlot(this.shown, ship.id);
      d.goal = slot;
    }
    const d = this.disp.get(except);
    if (d) d.goal = this.shipSlot(this.shown, except);
  }

  async runStorm(e) {
    const s = this.s;
    const cells = e.hexes.map((h) => ({ h, blobs: Array.from({ length: 4 }, () => ({ dx: rand(-0.5, 0.5), dy: rand(-0.5, 0.3), r: rand(0.55, 0.9), ph: rand(0, 6) })) }));
    this.storm = { cells, eyes: e.eyes || [], t0: this.time, bolts: [] };
    sfx.thunder();
    await this.tween(2300, (p) => {
      this.dark = Math.sin(Math.min(1, p * 1.2) * Math.PI) * 0.45;
      this.storm.p = p;
      for (let k = 0; k < 4 && cells.length; k++) {
        const c = this.centers[cells[(Math.random() * cells.length) | 0].h];
        this.particles.push({ kind: 'rain', x: c.x + rand(-s, s), y: c.y + rand(-s * 1.4, -s * 0.2), vx: -40, vy: 420, life: 0, max: 0.25, size: s * 0.25, color: '190,210,255' });
      }
      const boltTimes = [0.18, 0.46, 0.7];
      for (const bt of boltTimes) {
        if (p >= bt && !this.storm.bolts.some((b) => b.at === bt)) {
          const eye = this.storm.eyes[(Math.random() * this.storm.eyes.length) | 0] ?? cells[0]?.h;
          if (eye === undefined) continue;
          const c = this.centers[eye];
          const pts = [{ x: c.x + rand(-s, s), y: -10 }];
          const steps = 9;
          for (let k = 1; k <= steps; k++) {
            const q = k / steps;
            pts.push({ x: lerp(pts[0].x, c.x, q) + (k < steps ? rand(-s * 0.5, s * 0.5) : 0), y: lerp(-10, c.y, q) });
          }
          this.storm.bolts.push({ at: bt, pts, t: this.time });
          this.flash = 0.7;
          this.shake = 10;
          haptic([25, 30, 50]);
          this.ring(c.x, c.y, '200,220,255', 0.8);
        }
      }
    });
    this.storm = null;
    this.dark = 0;
  }

  // ------------------------------------------------------------ main loop

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    for (const tw of [...this.tweens]) {
      const p = Math.min(1, (this.time - tw.t0) / tw.dur);
      tw.fn(p);
      if (p >= 1) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.resolve();
      }
    }
    if (this.shown && this.staticLayer) this.draw(dt);
    requestAnimationFrame((t) => this.frame(t));
  }

  draw(dt) {
    const ctx = this.ctx;
    const s = this.s;
    const t = this.time;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    if (this.shake > 0.1) {
      ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
      this.shake *= 0.88;
    }
    ctx.drawImage(this.staticLayer, 0, 0, this.w, this.h);

    // stars twinkling in the sky gaps and moon glow
    for (const st of this.stars) {
      ctx.fillStyle = `rgba(220,230,255,${0.25 + 0.25 * Math.sin(t * 1.5 + st.ph)})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    const mg = ctx.createRadialGradient(this.w * 0.82 + Math.sin(t * 0.05) * 20, this.h * 0.08, 0, this.w * 0.82, this.h * 0.08, this.w * 0.9);
    mg.addColorStop(0, 'rgba(150,180,255,0.13)');
    mg.addColorStop(1, 'rgba(150,180,255,0)');
    ctx.fillStyle = mg;
    ctx.fillRect(0, 0, this.w, this.h);

    // waves
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, s * 0.05);
    for (const wv of this.waves) {
      const c = this.centers[wv.i];
      const a = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(t * 1.2 + wv.ph));
      const x = c.x + wv.dx * s + Math.sin(t * 0.6 + wv.ph) * s * 0.08, y = c.y + wv.dy * s;
      ctx.strokeStyle = `rgba(170,215,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y + s * 0.15, s * wv.w, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    // foam along the coast
    for (const [a, b, n] of this.coast) {
      const al = 0.18 + 0.16 * Math.sin(t * 1.6 + a.x * 0.05 + a.y * 0.03);
      const k = 0.1 + 0.05 * Math.sin(t * 1.3 + a.y * 0.05);
      ctx.strokeStyle = `rgba(235,248,255,${al})`;
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.moveTo(lerp(a.x, n.x, k), lerp(a.y, n.y, k));
      ctx.lineTo(lerp(b.x, n.x, k), lerp(b.y, n.y, k));
      ctx.stroke();
    }

    this.drawForecast(ctx, t);
    this.drawHighlights(ctx, t);
    this.drawItems(ctx, t);
    this.drawSignals(ctx, t);
    this.drawPorts(ctx, t);
    this.drawShips(ctx, t, dt);
    this.drawStorm(ctx, t);
    this.drawParticles(ctx, dt);
    this.drawBeams(ctx, t);

    if (this.dark > 0.01) {
      ctx.fillStyle = `rgba(5,5,20,${this.dark})`;
      ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
    }
    if (this.storm) this.drawBolts(ctx);
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(225,235,255,${this.flash})`;
      ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
      this.flash *= 0.84;
    }
    this.drawTexts(ctx, dt);
    this.drawBanner(ctx, t);
    ctx.restore();
  }

  emoji(ctx, ch, x, y, size, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
    ctx.globalAlpha = 1;
  }

  drawForecast(ctx, t) {
    const fc = this.shown.forecast || [];
    const s = this.s;
    fc.forEach((f, k) => {
      const tonight = k === 0;
      for (const h of f.hexes) {
        this.hexPath(ctx, h, 0.94);
        ctx.fillStyle = tonight ? `rgba(255,70,110,${0.16 + 0.07 * Math.sin(t * 3)})` : `rgba(170,130,255,${0.13 - k * 0.03})`;
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = tonight ? 'rgba(255,120,150,0.25)' : 'rgba(190,160,255,0.16)';
        ctx.lineWidth = 1.2;
        const c = this.centers[h];
        const off = (t * (tonight ? 14 : 6)) % 8;
        for (let x = -s * 2; x < s * 2; x += 8) {
          ctx.beginPath();
          ctx.moveTo(c.x + x + off, c.y - s);
          ctx.lineTo(c.x + x + off - s, c.y + s);
          ctx.stroke();
        }
        ctx.restore();
        if (!tonight) {
          this.hexPath(ctx, h, 0.9);
          ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = -t * 10;
          ctx.strokeStyle = 'rgba(190,160,255,0.5)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      for (const eye of f.eyes || []) {
        const c = this.centers[eye];
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(-t * (tonight ? 2.2 : 1));
        this.emoji(ctx, '🌀', 0, 0, s * (tonight ? 0.75 : 0.55), tonight ? 0.95 : 0.55);
        ctx.restore();
        if (!tonight) {
          ctx.fillStyle = 'rgba(230,215,255,0.9)';
          ctx.font = `700 ${s * 0.32}px system-ui, sans-serif`;
          ctx.fillText(`+${k}`, c.x + s * 0.42, c.y - s * 0.42);
        }
        if (tonight) {
          for (const p of this.shown.ports) {
            if (p.kind === 'port' && p.light > 0 && distance(p.hex, eye, COLS) <= 1) {
              const pc = this.centers[p.hex];
              ctx.strokeStyle = `rgba(255,80,100,${0.5 + 0.4 * Math.sin(t * 6)})`;
              ctx.lineWidth = 2.5;
              ctx.beginPath();
              ctx.arc(pc.x, pc.y - s * 0.2, s * 0.78, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }
    });
  }

  drawHighlights(ctx, t) {
    const hl = this.hl;
    const s = this.s;
    if (hl.reach) {
      for (const [h] of hl.reach) {
        if (h === hl.from) continue;
        this.hexPath(ctx, h, 0.86);
        ctx.fillStyle = `rgba(70,235,210,${0.1 + 0.07 * Math.sin(t * 4 + h)})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,240,215,0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    if (hl.signal) {
      for (let i = 0; i < this.centers.length; i++) {
        this.hexPath(ctx, i, 0.88);
        ctx.strokeStyle = `rgba(255,255,255,${0.12 + 0.06 * Math.sin(t * 3 + i)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (hl.path && hl.path.length > 1) {
      ctx.save();
      ctx.setLineDash([2, 7]);
      ctx.lineDashOffset = -t * 30;
      ctx.lineCap = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      hl.path.forEach((h, k) => {
        const c = this.centers[h];
        if (k === 0) ctx.moveTo(c.x, c.y);
        else ctx.lineTo(c.x, c.y);
      });
      ctx.stroke();
      ctx.restore();
    }
    if (hl.target !== undefined && hl.target !== null) {
      this.hexPath(ctx, hl.target, 0.9);
      ctx.fillStyle = `rgba(120,255,220,${0.28 + 0.1 * Math.sin(t * 6)})`;
      ctx.fill();
      ctx.strokeStyle = '#a6fff0';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (hl.ports) {
      for (const pid of hl.ports) {
        const p = this.shown.ports.find((x) => x.id === pid);
        const c = this.centers[p.hex];
        ctx.strokeStyle = `rgba(255,214,110,${0.6 + 0.35 * Math.sin(t * 5)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(c.x, c.y - s * 0.2, s * 0.85, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  drawItems(ctx, t) {
    const s = this.s;
    for (const it of this.shown.items) {
      const c = this.centers[it.hex];
      const bob = Math.sin(t * 2 + it.id) * s * 0.06;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, s * 0.6);
      g.addColorStop(0, `rgba(255,235,160,${0.28 + 0.12 * Math.sin(t * 3 + it.id)})`);
      g.addColorStop(1, 'rgba(255,235,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, s * 0.6, 0, Math.PI * 2);
      ctx.fill();
      this.emoji(ctx, ITEM_ICON[it.kind], c.x, c.y + bob, s * 0.6);
      if (Math.random() < 0.03) this.burst(c.x + rand(-s * 0.3, s * 0.3), c.y + rand(-s * 0.3, s * 0.3), 'spark', 1, { color: '255,240,190', speed: 10, size: 2 });
    }
  }

  drawSignals(ctx, t) {
    const s = this.s;
    for (const sg of this.shown.signals || []) {
      const c = this.centers[sg.hex];
      const danger = sg.kind === 'danger';
      const col = danger ? '255,80,105' : '110,215,255';
      this.hexPath(ctx, sg.hex, 0.92);
      ctx.fillStyle = `rgba(${col},${0.12 + 0.08 * Math.sin(t * 4)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.9)`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      const r = ((t * 0.9 + sg.hex * 0.17) % 1) * s * 0.9;
      ctx.strokeStyle = `rgba(${col},${0.5 * (1 - r / (s * 0.9))})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      const icon = danger ? '⚠️' : GOOD_ICON[sg.good];
      const isPort = this.shown.ports.some((p) => p.hex === sg.hex);
      const ix = c.x - (isPort ? s * 0.55 : 0), iy = c.y - (isPort ? s * 0.7 : s * 0.05);
      ctx.fillStyle = 'rgba(10,16,30,0.75)';
      ctx.beginPath();
      ctx.arc(ix, iy, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ROLE_COLOR[sg.by];
      ctx.lineWidth = 2;
      ctx.stroke();
      this.emoji(ctx, icon, ix, iy + 1, s * 0.34);
    }
  }

  drawPorts(ctx, t) {
    const s = this.s;
    const night = this.shown.night;
    for (const p of this.shown.ports) {
      const c = this.centers[p.hex];
      if (p.kind === 'depot') {
        this.drawDepot(ctx, c.x, c.y, s);
      } else {
        this.drawLighthouse(ctx, c.x, c.y, s, p, t);
      }
      // name plate
      ctx.font = `700 ${Math.max(9, s * 0.3)}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = p.name;
      const tw = ctx.measureText(label).width + 10;
      const ly = c.y + s * 0.78;
      ctx.fillStyle = 'rgba(6,12,26,0.72)';
      roundRect(ctx, c.x - tw / 2, ly - s * 0.2, tw, s * 0.4, s * 0.2);
      ctx.fill();
      ctx.fillStyle = p.kind === 'port' && p.light === 0 ? '#8a93a8' : '#eaf2ff';
      ctx.fillText(label, c.x, ly + 0.5);
      // product badge
      this.emoji(ctx, GOOD_ICON[p.product], c.x - s * 0.6, c.y + s * 0.18, s * 0.38);
      // demand bubble
      const dem = this.shown.demands.find((d) => d.port === p.id);
      if (dem) {
        const bx = c.x + s * 0.58, by = Math.max(s * 0.42, c.y - s * 0.72) + Math.sin(t * 2.2 + p.id) * s * 0.05;
        const left = dem.due - night + 1;
        ctx.fillStyle = 'rgba(245,248,255,0.95)';
        roundRect(ctx, bx - s * 0.36, by - s * 0.3, s * 0.72, s * 0.6, s * 0.18);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bx - s * 0.2, by + s * 0.28);
        ctx.lineTo(bx - s * 0.36, by + s * 0.5);
        ctx.lineTo(bx - s * 0.02, by + s * 0.28);
        ctx.fill();
        this.emoji(ctx, dem.good ? GOOD_ICON[dem.good] : '❓', bx, by + 1, s * 0.4);
        ctx.fillStyle = left <= 1 ? '#ff4d5e' : left === 2 ? '#ffb020' : '#3cc98a';
        ctx.beginPath();
        ctx.arc(bx + s * 0.34, by - s * 0.26, s * 0.17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `800 ${s * 0.22}px system-ui, sans-serif`;
        ctx.fillText(String(left), bx + s * 0.34, by - s * 0.25);
      }
    }
  }

  drawDepot(ctx, x, y, s) {
    ctx.save();
    ctx.translate(x, y - s * 0.12);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.33, s * 0.55, s * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a5c3e';
    ctx.fillRect(-s * 0.42, -s * 0.12, s * 0.84, s * 0.44);
    ctx.fillStyle = '#a2412f';
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, -s * 0.1);
    ctx.lineTo(0, -s * 0.42);
    ctx.lineTo(s * 0.5, -s * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffd77a';
    ctx.fillRect(-s * 0.1, s * 0.05, s * 0.2, s * 0.27);
    const g = ctx.createRadialGradient(0, s * 0.15, 0, 0, s * 0.15, s * 0.6);
    g.addColorStop(0, 'rgba(255,210,120,0.35)');
    g.addColorStop(1, 'rgba(255,210,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, s * 0.15, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawLighthouse(ctx, x, y, s, p, t) {
    const lit = p.light > 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.36, s * 0.4, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5c6670';
    ctx.beginPath();
    ctx.ellipse(0, s * 0.33, s * 0.32, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    // tower with stripes
    const top = -s * 0.5, bot = s * 0.32, wb = s * 0.17, wt = s * 0.1;
    ctx.beginPath();
    ctx.moveTo(-wb, bot);
    ctx.lineTo(-wt, top);
    ctx.lineTo(wt, top);
    ctx.lineTo(wb, bot);
    ctx.closePath();
    ctx.fillStyle = lit ? '#f4f1ea' : '#8d929c';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = lit ? '#d6453d' : '#5d5f67';
    for (const yy of [-s * 0.3, -s * 0.02, s * 0.24]) ctx.fillRect(-s, yy, s * 2, s * 0.12);
    ctx.restore();
    // gallery and lamp room
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(-s * 0.16, top - s * 0.03, s * 0.32, s * 0.05);
    const flicker = p.light === 1 ? 0.65 + 0.35 * Math.sin(t * 13) * Math.sin(t * 7.1) : 1;
    ctx.fillStyle = lit ? `rgba(255,${200 + p.light * 15},${110 + p.light * 25},${flicker})` : '#3a3f4a';
    ctx.fillRect(-s * 0.09, top - s * 0.2, s * 0.18, s * 0.17);
    ctx.fillStyle = '#2b2f38';
    ctx.beginPath();
    ctx.moveTo(-s * 0.13, top - s * 0.2);
    ctx.lineTo(0, top - s * 0.34);
    ctx.lineTo(s * 0.13, top - s * 0.2);
    ctx.fill();
    // light pips
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = k < p.light ? '#ffd36e' : 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(s * 0.36, -s * 0.28 + k * s * 0.2, s * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (!lit && Math.random() < 0.04) {
      this.particles.push({ kind: 'smoke', x: x + rand(-3, 3), y: y - s * 0.75, vx: rand(-4, 4), vy: -rand(12, 22), life: 0, max: 2, size: rand(3, 6), color: '140,140,160' });
    }
  }

  drawBeams(ctx, t) {
    const s = this.s;
    const col = BEAMS[this.cosmetics.beam] || BEAMS.amber;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.shown.ports) {
      if (p.kind !== 'port' || p.light === 0) continue;
      const c = this.centers[p.hex];
      const lx = c.x, ly = c.y - s * 0.62;
      const flicker = p.light === 1 ? 0.55 + 0.45 * Math.abs(Math.sin(t * 9) * Math.sin(t * 5.3)) : 1;
      const k = (0.35 + p.light * 0.22) * flicker;
      const glowR = s * (0.45 + p.light * 0.3);
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, glowR);
      g.addColorStop(0, `rgba(${col},${0.75 * k})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(lx, ly, glowR, 0, Math.PI * 2);
      ctx.fill();
      const len = s * (1.6 + p.light * 0.85);
      const a0 = t * 0.75 + p.id * 1.7;
      for (const a of [a0, a0 + Math.PI]) {
        const spread = 0.17;
        const lg = ctx.createLinearGradient(lx, ly, lx + Math.cos(a) * len, ly + Math.sin(a) * len * 0.6);
        lg.addColorStop(0, `rgba(${col},${0.32 * k})`);
        lg.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx + Math.cos(a - spread) * len, ly + Math.sin(a - spread) * len * 0.6);
        ctx.lineTo(lx + Math.cos(a + spread) * len, ly + Math.sin(a + spread) * len * 0.6);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawShips(ctx, t, dt) {
    const s = this.s;
    const hl = this.hl;
    const order = [...this.shown.ships].sort((a, b) => (this.disp.get(a.id)?.y || 0) - (this.disp.get(b.id)?.y || 0));
    for (const ship of order) {
      const d = this.disp.get(ship.id);
      if (!d) continue;
      if (d.goal) {
        d.x = lerp(d.x, d.goal.x, Math.min(1, dt * 8));
        d.y = lerp(d.y, d.goal.y, Math.min(1, dt * 8));
        d.scale = lerp(d.scale ?? 1, d.goal.scale, Math.min(1, dt * 8));
        if (Math.hypot(d.x - d.goal.x, d.y - d.goal.y) < 0.3) d.goal = null;
      } else if (!this.animating && !d.goal) {
        const slot = this.shipSlot(this.shown, ship.id);
        if (Math.hypot(d.x - slot.x, d.y - slot.y) > 0.5) d.goal = slot;
      }
      const bob = Math.sin(t * 2.4 + ship.id * 1.7) * s * 0.04;
      const selectable = hl.ships?.has(ship.id);
      const selected = hl.selectedShip === ship.id || hl.selectedShips?.includes(ship.id);
      if (selectable || selected) {
        const r = s * 0.48 * (d.scale || 1);
        ctx.strokeStyle = selected ? `rgba(255,255,255,${0.75 + 0.25 * Math.sin(t * 8)})` : `rgba(120,255,225,${0.45 + 0.3 * Math.sin(t * 4 + ship.id)})`;
        ctx.lineWidth = selected ? 3 : 2;
        ctx.beginPath();
        ctx.ellipse(d.x, d.y + s * 0.12, r, r * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.drawBoat(ctx, d.x, d.y + bob, s * 0.82 * (d.scale || 1), ship, d, t);
      if (ship.hull < MAX_HULL && Math.random() < 0.08) {
        this.particles.push({ kind: 'smoke', x: d.x, y: d.y - s * 0.3, vx: rand(-5, 5), vy: -rand(10, 20), life: 0, max: 1.4, size: rand(2, 4), color: '120,120,130' });
      }
    }
  }

  drawBoat(ctx, x, y, L, ship, d, t) {
    const color = ROLE_COLOR[ship.owner];
    const style = this.cosmetics.boat;
    ctx.save();
    ctx.globalAlpha = (d.alpha ?? 1) * (1 - (d.sink || 0) * 0.9);
    ctx.translate(x, y + (d.sink || 0) * L * 0.6);
    ctx.rotate((d.tilt || 0) + Math.sin(t * 1.9 + ship.id) * 0.04);
    ctx.scale(d.face || 1, 1);
    // reflection / shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, L * 0.25, L * 0.5, L * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    const lightHull = ship.owner === 'A' ? '#ffcf86' : '#7fe7f2';
    const g = ctx.createLinearGradient(0, 0, 0, L * 0.24);
    g.addColorStop(0, lightHull);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-L * 0.46, 0);
    ctx.lineTo(L * 0.5, -L * 0.02);
    ctx.quadraticCurveTo(L * 0.4, L * 0.2, L * 0.28, L * 0.22);
    ctx.lineTo(-L * 0.32, L * 0.22);
    ctx.quadraticCurveTo(-L * 0.42, L * 0.14, -L * 0.46, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,20,30,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-L * 0.38, L * 0.06, L * 0.74, L * 0.03);
    // cargo crates on deck
    ship.cargo.forEach((good, k) => {
      ctx.fillStyle = GOOD_COLOR[good];
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      const cx = -L * 0.34 + k * L * 0.17;
      ctx.fillRect(cx, -L * 0.15, L * 0.14, L * 0.14);
      ctx.strokeRect(cx, -L * 0.15, L * 0.14, L * 0.14);
    });
    // masts and sails
    const sail = ship.hull < MAX_HULL ? '#c9c2b5' : '#fbf6ea';
    const masts = style === 'galion' ? [0.16, -0.04] : [0.1];
    for (const mx of masts) {
      ctx.strokeStyle = '#4a3a2a';
      ctx.lineWidth = Math.max(1, L * 0.03);
      ctx.beginPath();
      ctx.moveTo(L * mx, 0);
      ctx.lineTo(L * mx, -L * 0.78);
      ctx.stroke();
      ctx.fillStyle = sail;
      ctx.beginPath();
      if (style === 'galion') {
        ctx.moveTo(L * (mx - 0.15), -L * 0.68);
        ctx.quadraticCurveTo(L * (mx + 0.02), -L * 0.55, L * (mx + 0.15), -L * 0.68);
        ctx.lineTo(L * (mx + 0.15), -L * 0.24);
        ctx.quadraticCurveTo(L * (mx + 0.02), -L * 0.12, L * (mx - 0.15), -L * 0.24);
      } else if (style === 'barca') {
        ctx.moveTo(L * (mx + 0.02), -L * 0.6);
        ctx.lineTo(L * (mx + 0.02), -L * 0.08);
        ctx.lineTo(L * (mx - 0.3), -L * 0.08);
      } else {
        ctx.moveTo(L * (mx + 0.02), -L * 0.74);
        ctx.quadraticCurveTo(L * (mx + 0.3), -L * 0.4, L * (mx + 0.36), -L * 0.1);
        ctx.lineTo(L * (mx + 0.02), -L * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(L * (mx - 0.02), -L * 0.66);
        ctx.lineTo(L * (mx - 0.02), -L * 0.1);
        ctx.lineTo(L * (mx - 0.32), -L * 0.1);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.stroke();
      // flag
      const wave = Math.sin(t * 6 + ship.id) * L * 0.03;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(L * mx, -L * 0.78);
      ctx.lineTo(L * (mx - 0.2), -L * 0.74 + wave);
      ctx.lineTo(L * mx, -L * 0.68);
      ctx.fill();
    }
    if (ship.anchored === this.shown.night) {
      ctx.strokeStyle = `rgba(140,220,255,${0.5 + 0.3 * Math.sin(t * 4)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, -L * 0.25, L * 0.62, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
    }
    ctx.restore();
    if (ship.hull < MAX_HULL && !(d.sink > 0)) this.emoji(ctx, '🩹', x + L * 0.42, y - L * 0.55, L * 0.32, 0.9);
  }

  drawStorm(ctx, t) {
    if (!this.storm) return;
    const s = this.s;
    const p = this.storm.p || 0;
    const a = Math.sin(Math.min(1, p * 1.15) * Math.PI);
    for (const cell of this.storm.cells) {
      const c = this.centers[cell.h];
      for (const b of cell.blobs) {
        const bx = c.x + (b.dx + Math.sin(t + b.ph) * 0.15) * s, by = c.y + (b.dy - 0.4) * s;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, s * b.r * 1.3);
        g.addColorStop(0, `rgba(70,66,100,${0.85 * a})`);
        g.addColorStop(0.6, `rgba(45,42,70,${0.55 * a})`);
        g.addColorStop(1, 'rgba(40,38,60,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, s * b.r * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawBolts(ctx) {
    for (const b of this.storm.bolts) {
      const age = this.time - b.t;
      if (age > 0.22) continue;
      const al = 1 - age / 0.22;
      for (const [w, col] of [[7, `rgba(150,170,255,${0.35 * al})`], [2.5, `rgba(245,248,255,${al})`]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        b.pts.forEach((pt, k) => (k ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
      }
    }
  }

  drawParticles(ctx, dt) {
    const keep = [];
    for (const p of this.particles) {
      if (p.kind === 'fly') {
        if (!p.dead) {
          this.emoji(ctx, p.emoji, p.x, p.y, this.s * 0.5);
          keep.push(p);
        }
        continue;
      }
      p.life += dt;
      if (p.life >= p.max) continue;
      keep.push(p);
      const k = p.life / p.max;
      p.x += (p.vx || 0) * dt;
      p.y += (p.vy || 0) * dt;
      if (p.g) p.vy += p.g * dt;
      if (p.kind === 'spark') {
        p.vx *= 0.96;
        p.vy *= 0.96;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(${p.color},${1 - k})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (p.kind === 'wake' || p.kind === 'bubble') {
        ctx.strokeStyle = `rgba(${p.color},${0.5 * (1 - k)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + k * 3), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'smoke') {
        ctx.fillStyle = `rgba(${p.color},${0.35 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + k * 2), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'rain') {
        ctx.strokeStyle = `rgba(${p.color},${0.55 * (1 - k)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 0.03, p.y - p.size);
        ctx.stroke();
      } else if (p.kind === 'ring') {
        ctx.strokeStyle = `rgba(${p.color},${0.8 * (1 - k)})`;
        ctx.lineWidth = 2.5 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + p.grow * ease(k), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'debris') {
        ctx.fillStyle = `rgba(${p.color},${1 - k})`;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
    }
    this.particles = keep;
  }

  drawTexts(ctx, dt) {
    const keep = [];
    for (const tx of this.texts) {
      tx.life += dt;
      if (tx.life >= tx.max) continue;
      keep.push(tx);
      const k = tx.life / tx.max;
      const y = tx.y - ease(Math.min(1, k * 1.4)) * this.s * 0.8;
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.5 : k < 0.2 ? 1.1 - ((k - 0.12) / 0.08) * 0.1 : 1;
      ctx.save();
      ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      ctx.font = `800 ${this.s * 0.42 * tx.size * pop}px system-ui, -apple-system, ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5,10,25,0.85)';
      ctx.strokeText(tx.text, tx.x, y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, tx.x, y);
      ctx.restore();
    }
    this.texts = keep;
  }

  drawBanner(ctx, t) {
    const b = this.banner;
    if (!b) return;
    const k = (t - b.t0) / b.dur;
    if (k >= 1) {
      this.banner = null;
      return;
    }
    const a = k < 0.2 ? k / 0.2 : k > 0.75 ? (1 - k) / 0.25 : 1;
    const slide = (1 - ease(Math.min(1, k * 3))) * 40;
    ctx.save();
    ctx.globalAlpha = a;
    const y = this.h * 0.42;
    const g = ctx.createLinearGradient(0, y - 50, 0, y + 50);
    g.addColorStop(0, 'rgba(5,10,30,0)');
    g.addColorStop(0.5, 'rgba(5,10,30,0.82)');
    g.addColorStop(1, 'rgba(5,10,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 60, this.w, 120);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.min(40, this.w * 0.09)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = '#ffe2a0';
    ctx.shadowColor = 'rgba(255,200,120,0.8)';
    ctx.shadowBlur = 18;
    ctx.fillText(b.title, this.w / 2 + slide, y - 6);
    ctx.shadowBlur = 0;
    if (b.sub) {
      ctx.font = `600 ${Math.min(16, this.w * 0.04)}px system-ui, sans-serif`;
      ctx.fillStyle = '#cdd8f0';
      ctx.fillText(b.sub, this.w / 2 - slide, y + 26);
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
