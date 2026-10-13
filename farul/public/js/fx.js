// Synthesised sound effects (Web Audio, no files) and haptics.
let ctx = null;
let master = null;
let ambience = null;
let muted = false;

try { muted = localStorage.getItem('farul.muted') === '1'; } catch { /* private mode */ }

export function isMuted() { return muted; }

export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('farul.muted', v ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.value = v ? 0 : 0.8;
}

/** Must be called from a user gesture (iOS requirement). */
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
  startAmbience();
}

function noiseBuffer(seconds, brown = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

function startAmbience() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(4, true);
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  const gain = ctx.createGain();
  gain.gain.value = 0.05;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.12;
  lfoGain.gain.value = 0.035;
  lfo.connect(lfoGain).connect(gain.gain);
  src.connect(filter).connect(gain).connect(master);
  src.start();
  lfo.start();
  ambience = gain;
}

export function setAmbience(level) {
  if (ambience) ambience.gain.setTargetAtTime(level, ctx.currentTime, 0.8);
}

function tone(freq, { type = 'sine', dur = 0.4, vol = 0.2, delay = 0, slide = 0 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise({ dur = 0.3, vol = 0.3, freq = 1000, type = 'bandpass', q = 1, delay = 0, brown = false } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur + 0.1, brown);
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
  tap: () => tone(660, { type: 'triangle', dur: 0.06, vol: 0.06 }),
  card: () => noise({ dur: 0.12, vol: 0.25, freq: 3200, q: 0.7 }),
  sail: () => noise({ dur: 0.7, vol: 0.18, freq: 500, q: 0.6 }),
  bell: () => {
    tone(1318, { dur: 1.2, vol: 0.16 });
    tone(1976, { dur: 0.9, vol: 0.07, delay: 0.01 });
    tone(2637, { dur: 0.5, vol: 0.04, delay: 0.02 });
  },
  chime: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, { dur: 0.35, vol: 0.09, delay: i * 0.07, type: 'triangle' })),
  thunder: () => {
    noise({ dur: 2.4, vol: 0.9, freq: 160, type: 'lowpass', brown: true });
    noise({ dur: 0.25, vol: 0.35, freq: 2400, type: 'highpass' });
  },
  splash: () => noise({ dur: 0.5, vol: 0.3, freq: 900, q: 0.5 }),
  hit: () => {
    noise({ dur: 0.3, vol: 0.5, freq: 300, q: 1.2 });
    tone(110, { type: 'square', dur: 0.25, vol: 0.06, slide: -60 });
  },
  sink: () => {
    tone(320, { type: 'sine', dur: 1.2, vol: 0.12, slide: -260 });
    noise({ dur: 1.2, vol: 0.25, freq: 600, q: 0.8, delay: 0.1 });
  },
  horn: () => {
    tone(147, { type: 'sawtooth', dur: 0.7, vol: 0.06 });
    tone(220, { type: 'sawtooth', dur: 0.7, vol: 0.04 });
  },
  light: () => tone(523, { type: 'triangle', dur: 0.5, vol: 0.1, slide: 500 }),
  dim: () => tone(392, { type: 'triangle', dur: 0.6, vol: 0.09, slide: -200 }),
  ping: () => tone(1046, { dur: 0.25, vol: 0.08, type: 'sine' }),
  win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, { dur: 0.6, vol: 0.12, delay: i * 0.12, type: 'triangle' })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, { dur: 0.7, vol: 0.1, delay: i * 0.18, type: 'sine' })),
};

export function haptic(pattern = 12) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS has no vibration API */ }
}
