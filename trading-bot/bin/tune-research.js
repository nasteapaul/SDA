#!/usr/bin/env node
// Tuning grid for the live ORB (with re-entry until 3 losses). Picks on 2005-2012, reports 2013-2020.
const T = '../lib/';
const { groupDays } = await import(T + 'history.js');
const { loadMarketBars } = await import(T + 'marketdata.js');
const { marketByKey, costsFor } = await import(T + 'markets.js');
const [key, D] = process.argv.slice(2); // node bin/tune-research.js GBPUSD <pyfinancialdata/data>
const m = marketByKey(key);
const days = groupDays(loadMarketBars(m, D, 2005), m.tz).filter((d) => d.bars.length > 60);
const costs = costsFor(m);

function sim(bars, { dir, entryIdx, stop, target, be }) {
  const entry = bars[entryIdx].open;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return null;
  let s = stop, exit = bars.at(-1).close, exitIdx = bars.length - 1, why = 'end';
  for (let j = entryIdx; j < bars.length; j++) {
    const b = bars[j];
    if (j > entryIdx && b.mod >= m.close) { exit = b.open; exitIdx = j; why = 'time'; break; }
    if (dir > 0 ? b.low <= s : b.high >= s) { exit = (dir > 0 ? Math.min(b.open, s) : Math.max(b.open, s)) - dir * costs.slippage; exitIdx = j; why = 'stop'; break; }
    if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) { exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target); exitIdx = j; why = 'target'; break; }
    if (be && (dir > 0 ? b.high : -b.low) >= (dir > 0 ? entry + be * risk : -(entry - be * risk))) s = dir > 0 ? Math.max(s, entry) : Math.min(s, entry);
  }
  const pts = (exit - entry) * dir - costs.sessionSpread;
  return { exitIdx, why, r: pts / risk };
}

// per-day range info, computed once per rangeMin
const rangeCache = {};
function ranges(rangeMin) {
  if (rangeCache[rangeMin]) return rangeCache[rangeMin];
  const out = days.map((dd) => {
    const bars = dd.bars;
    const start = bars.findIndex((b) => b.mod >= m.open);
    if (start < 0 || bars[start].mod > m.open + 5) return null;
    let hi = -Infinity, lo = Infinity, i = start;
    for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
    return { hi, lo, width: hi - lo, i, close: bars.filter((b) => b.mod < m.close).at(-1)?.close };
  });
  // width relative to median of last 20 days; trend = last close vs 20-day avg close
  out.forEach((r, k) => {
    if (!r) return;
    const prev = out.slice(Math.max(0, k - 20), k).filter(Boolean);
    if (prev.length < 15) return;
    const w = prev.map((p) => p.width).sort((a, b) => a - b);
    r.rel = r.width / w[Math.floor(w.length / 2)];
    const cl = prev.map((p) => p.close).filter(Number.isFinite);
    const last = cl.at(-1);
    r.trend = last > cl.reduce((a, b) => a + b, 0) / cl.length ? 1 : -1;
  });
  return (rangeCache[rangeMin] = out);
}

function run(v) {
  const rs = ranges(v.rangeMin);
  const trades = [];
  days.forEach((dd, k) => {
    const r = rs[k];
    if (!r || !(r.width >= m.spread * 4) || r.rel == null) return;
    if (v.width === 'narrow' && r.rel > 1) return;
    if (v.width === 'wide' && r.rel <= 1) return;
    const bars = dd.bars;
    const mid = (r.hi + r.lo) / 2;
    let losses = 0, n = 0, armed = true, i = r.i;
    for (; i < bars.length - 1 && bars[i].mod < m.open + 180; i++) {
      const c = bars[i].close;
      if (c <= r.hi && c >= r.lo) { armed = true; continue; }
      if (!armed) continue;
      const dir = c > r.hi ? 1 : -1;
      if (v.trend && dir !== r.trend) { armed = false; continue; }
      const entry = bars[i + 1].open;
      const stop = v.stopFrac === 1 ? (dir > 0 ? r.lo : r.hi) : mid;
      const risk = (entry - stop) * dir;
      const t = sim(bars, { dir, entryIdx: i + 1, stop, target: v.targetR ? entry + dir * risk * v.targetR : null, be: v.be });
      if (!t) { armed = false; continue; }
      trades.push({ year: +dd.day.slice(0, 4), r: t.r });
      n++; if (t.r <= 0) losses++;
      i = t.exitIdx; armed = false;
      if (losses >= 3 || n >= 6 || t.why === 'time' || t.why === 'end') break;
    }
  });
  const sum = (a) => a.reduce((s, t) => s + t.r, 0);
  const is = trades.filter((t) => t.year < 2013), oos = trades.filter((t) => t.year >= 2013);
  const tstat = (a) => { const n = a.length; if (n < 2) return 0; const av = sum(a) / n; const sd = Math.sqrt(a.reduce((s, t) => s + (t.r - av) ** 2, 0) / (n - 1)); return av / sd * Math.sqrt(n); };
  let eq = 0, peak = 0, dd = 0; for (const t of oos) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const yrs = {}; for (const t of oos) yrs[t.year] = (yrs[t.year] ?? 0) + t.r;
  return { ...v, nIS: is.length, rIS: +sum(is).toFixed(0), tIS: +tstat(is).toFixed(2), nOOS: oos.length, rOOS: +sum(oos).toFixed(0), tOOS: +tstat(oos).toFixed(2), ddOOS: +dd.toFixed(0), badYearsOOS: Object.values(yrs).filter((x) => x < 0).length };
}

const vs = [];
for (const rangeMin of [15, 30, 60]) for (const stopFrac of [1, 0.5]) for (const targetR of [null, 1.5, 2, 3]) for (const be of [0, 1]) for (const width of ['all', 'narrow', 'wide']) for (const trend of [false, true]) vs.push({ rangeMin, stopFrac, targetR, be, width, trend });
const res = vs.map(run);
const cur = res.find((r) => r.rangeMin === m.live.rangeMin && r.stopFrac === 1 && r.targetR === m.live.targetR && !r.be && r.width === 'all' && !r.trend);
const byIS = [...res].filter((r) => r.nIS >= 300).sort((a, b) => b.tIS - a.tIS);
const both = res.filter((r) => r.rIS > 0 && r.rOOS > 0).length;
console.log(JSON.stringify({ key, variants: res.length, positiveBoth: both, current: cur, top5IS: byIS.slice(0, 5), all: res }));
