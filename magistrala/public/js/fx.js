// Synthesised sound (Web Audio, no files) and haptics.
let ctx = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem('magistrala.muted') === '1'; } catch { /* private mode */ }

export const isMuted = () => muted;
export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('magistrala.muted', v ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.value = v ? 0 : 0.8;
}

/** Call from a user gesture (iOS requirement). */
export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.8;
  master.connect(ctx.destination);
}

function tone(freq, { type = 'sine', dur = 0.3, vol = 0.15, delay = 0, slide = 0, vibrato = 0 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  if (vibrato) {
    const l = ctx.createOscillator();
    const lg = ctx.createGain();
    l.frequency.value = 6;
    lg.gain.value = vibrato;
    l.connect(lg).connect(o.frequency);
    l.start(t);
    l.stop(t + dur);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ dur = 0.2, vol = 0.2, freq = 1200, type = 'bandpass', q = 1, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const len = Math.floor(ctx.sampleRate * (dur + 0.05));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  tap: () => tone(700, { type: 'triangle', dur: 0.05, vol: 0.05 }),
  card: () => noise({ dur: 0.14, vol: 0.22, freq: 3000, q: 0.6 }),
  clack: (k = 0) => { noise({ dur: 0.06, vol: 0.35, freq: 900, q: 2, delay: k * 0.09 }); tone(160, { type: 'square', dur: 0.05, vol: 0.03, delay: k * 0.09 }); },
  whistle: () => { tone(880, { dur: 0.55, vol: 0.07, vibrato: 8 }); tone(1108, { dur: 0.55, vol: 0.05, vibrato: 8 }); },
  chug: () => { for (let k = 0; k < 6; k++) noise({ dur: 0.08, vol: 0.12, freq: 400, q: 0.8, delay: k * 0.18 }); },
  coin: () => { tone(1568, { type: 'triangle', dur: 0.18, vol: 0.08 }); tone(2093, { type: 'triangle', dur: 0.3, vol: 0.07, delay: 0.08 }); },
  build: () => [523, 659, 784].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.3, vol: 0.08, delay: i * 0.08 })),
  ticket: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, { type: 'sine', dur: 0.4, vol: 0.08, delay: i * 0.07 })),
  turn: () => { tone(587, { type: 'sine', dur: 0.25, vol: 0.08 }); tone(880, { type: 'sine', dur: 0.35, vol: 0.08, delay: 0.12 }); },
  gavel: () => { noise({ dur: 0.1, vol: 0.5, freq: 600, q: 1.5 }); noise({ dur: 0.1, vol: 0.4, freq: 600, q: 1.5, delay: 0.18 }); },
  win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.55, vol: 0.1, delay: i * 0.12 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, { dur: 0.6, vol: 0.09, delay: i * 0.18 })),
};

export function haptic(p = 10) {
  try { navigator.vibrate?.(p); } catch { /* iOS has no vibration API */ }
}
