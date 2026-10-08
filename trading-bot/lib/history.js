import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, validateCandle } from './candles.js';
import { berlinClock } from './session.js';

// HistData.com ASCII minute bars: "20180102 020100;open;high;low;close;volume".
// Their timestamps are EST without daylight saving, i.e. always UTC-5.
export function parseHistData(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2});([^;]+);([^;]+);([^;]+);([^;]+)/.exec(line);
    if (!m) continue;
    const c = {
      time: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 5, +m[5], +m[6]),
      open: +m[7], high: +m[8], low: +m[9], close: +m[10],
    };
    if (validateCandle(c)) out.push(c);
  }
  return out;
}

// Loads files or folders of .csv files (Windows shells don't expand data\*.csv);
// HistData format is detected, otherwise a headed CSV. Empty downloads are skipped.
export function loadBars(paths, warn = console.warn) {
  const files = paths.flatMap((p) => (statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => f.toLowerCase().endsWith('.csv')).sort().map((f) => join(p, f))
    : [p]));
  const bars = [];
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    if (!text.trim()) {
      warn(`Sar peste ${p}: fișierul e gol.`);
      continue;
    }
    const rows = /^\d{8} \d{6};/.test(text) ? parseHistData(text) : parseCsv(text);
    for (const r of rows) bars.push(r);
  }
  if (!bars.length) throw new Error('No data: every input file is empty');
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

// Groups bars by Frankfurt trading day; each bar gets its local minute of day.
export function groupDays(bars) {
  const days = [];
  let cur = null;
  for (const b of bars) {
    const { day, mod, dow } = berlinClock(b.time);
    if (dow === 0 || dow === 6) continue;
    if (!cur || cur.day !== day) {
      cur = { day, dow, bars: [] };
      days.push(cur);
    }
    cur.bars.push({ ...b, mod });
  }
  return days;
}

// Aggregates bars into `minutes`-long candles aligned to the local clock.
export function resample(bars, minutes) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const slot = Math.floor(b.mod / minutes) * minutes;
    if (!cur || cur.slot !== slot) {
      cur = { slot, time: b.time, mod: slot, open: b.open, high: b.high, low: b.low, close: b.close };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  return out.map(({ slot, ...c }) => c);
}
