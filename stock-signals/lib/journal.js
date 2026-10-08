import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Everything the bot remembers between runs: what it already processed, insider buys,
// and the journal of every alert with how the stock did afterwards.
export function loadState(path) {
  try {
    return { seen: {}, insiders: {}, lastAlert: {}, journal: [], health: {}, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { seen: {}, insiders: {}, lastAlert: {}, journal: [], health: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${path}.tmp`, path);
}

const DAY = 86400e3;

export function prune(state, now) {
  for (const [k, t] of Object.entries(state.seen)) if (now - t > 10 * DAY) delete state.seen[k];
  for (const [k, t] of Object.entries(state.lastAlert)) if (now - t > 30 * DAY) delete state.lastAlert[k];
  for (const [cik, buys] of Object.entries(state.insiders)) {
    const keep = buys.filter((b) => now - b.time <= 30 * DAY);
    if (keep.length) state.insiders[cik] = keep;
    else delete state.insiders[cik];
  }
}

export const HORIZONS = [5, 20, 60];
export const benchmarkFor = (listing) => (listing.us ? 'SPY' : 'EXSA.DE'); // S&P 500 / STOXX Europe 600 ETFs

export function record(state, s, now) {
  state.journal.push({
    time: now,
    company: s.company,
    xtb: s.listing.xtb,
    yahoo: s.listing.yahoo,
    benchmark: benchmarkFor(s.listing),
    score: s.score,
    title: s.title.slice(0, 200),
    returns: {},
  });
}

// Entry = close of the first daily bar that ends after the alert (bar start + 6 h is a
// conservative stand-in for the close), i.e. what you could realistically have bought at.
export function forwardReturns(bars, alertTime) {
  const i = bars.findIndex((b) => b.time + 6 * 3600e3 > alertTime);
  if (i < 0) return {};
  const out = {};
  for (const h of HORIZONS) if (bars[i + h]) out[h] = bars[i + h].close / bars[i].close - 1;
  return out;
}

export function pending(entry) {
  return HORIZONS.some((h) => entry.returns[h] == null) && entry.failed !== true;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function journalStats(journal) {
  return HORIZONS.map((h) => {
    const done = journal.filter((e) => e.returns[h] != null);
    const excess = done.filter((e) => e.bench?.[h] != null).map((e) => e.returns[h] - e.bench[h]);
    return {
      h,
      n: done.length,
      avg: avg(done.map((e) => e.returns[h])),
      excess: avg(excess),
      winRate: done.length ? done.filter((e) => e.returns[h] > 0).length / done.length : null,
    };
  });
}
