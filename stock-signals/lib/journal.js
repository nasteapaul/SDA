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
  for (const [k, c] of Object.entries(state.xtb ?? {})) if (now - c.at > 7 * DAY) delete state.xtb[k];
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
    source: s.source,
    yahoo: s.listing.yahoo,
    benchmark: benchmarkFor(s.listing),
    score: s.score,
    title: s.title.slice(0, 200),
    plan: s.market?.plan ? { price: s.market.price, buyUpTo: s.market.plan.buyUpTo, stop: s.market.plan.stop, target: s.market.plan.target } : undefined,
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

// Four weeks (20 trading days) after an alert: how the stock did from the realistic entry
// (as in forwardReturns), whether the plan's stop or target was touched first, and the
// market over the same days. Null until the 20 days have passed.
export const REPORT_DAYS = 20;

export function monthReport(e, bars, benchBars) {
  const i = bars.findIndex((b) => b.time + 6 * 3600e3 > e.time);
  if (i < 0 || !bars[i + REPORT_DAYS]) return null;
  const entry = bars[i].close, last = bars[i + REPORT_DAYS].close;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1).replace('.', ',')}%`;
  const num = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(2)).replace('.', ',');
  const date = (t) => new Date(t).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', timeZone: 'Europe/Bucharest' });
  const lines = [
    `📋 <b>Semnal de acum 4 săptămâni: ${esc(e.company)} (${esc(e.xtb)})</b>`,
    `Alertă pe ${date(e.time)}, sursa: ${esc(e.source)}.`,
    `Preț la intrare ${num(entry)} → după 4 săptămâni ${num(last)}: <b>${pct(last / entry - 1)}</b>.`,
  ];
  const bi = benchBars?.findIndex((b) => b.time + 6 * 3600e3 > e.time) ?? -1;
  if (bi >= 0 && benchBars[bi + REPORT_DAYS]) {
    lines.push(`Piața (${e.benchmark === 'SPY' ? 'S&amp;P 500' : 'Europa 600'}) în aceeași perioadă: ${pct(benchBars[bi + REPORT_DAYS].close / benchBars[bi].close - 1)}.`);
  }
  if (e.plan?.stop && e.plan?.target) {
    // The day after the entry onwards; on a day that touched both, count the stop (cautious).
    let hit = 'Nici stopul, nici ținta nu au fost atinse.';
    for (let k = i + 1; k <= i + REPORT_DAYS; k++) {
      if (bars[k].low <= e.plan.stop) { hit = `Stopul de ${num(e.plan.stop)} a fost atins pe ${date(bars[k].time)} (${pct(e.plan.stop / entry - 1)}).`; break; }
      if (bars[k].high >= e.plan.target) { hit = `Ținta de ${num(e.plan.target)} a fost atinsă pe ${date(bars[k].time)} (${pct(e.plan.target / entry - 1)}).`; break; }
    }
    lines.push(`Planul: ${hit}`);
  }
  return lines.join('\n');
}
