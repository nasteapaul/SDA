#!/usr/bin/env node
// Paul's ideas on the live ORB markets: small fixed take-profit with re-entry while the
// move continues, and more trades a day capped at 3 losses. Results in R per day-set.
const T = '../lib/';
const { groupDays } = await import(T + 'history.js');
const { loadMarketBars } = await import(T + 'marketdata.js');
const { simulate, stats } = await import(T + 'daytrade.js');
const { marketByKey, costsFor } = await import(T + 'markets.js');
const [key, D] = process.argv.slice(2); // node bin/reentry-research.js EURUSD <pyfinancialdata/data>
const m = marketByKey(key);

const days = groupDays(loadMarketBars(m, D, 2005), m.tz).filter((d) => d.bars.length > 60);
const costs = costsFor(m);
const { rangeMin, targetR } = m.live;

// One day. mode: 'base' (first breakout only), 'tp' (target tpR, re-enter on a new extreme in
// the same direction after a target), 'multi' (after a stop, re-enter on the next breakout of
// the opening range, either side). Stops for the day after maxLoss losing trades.
function day(dd, { mode, tpR, maxLoss = 3 }) {
  const bars = dd.bars;
  const start = bars.findIndex((b) => b.mod >= m.open);
  if (start < 0 || bars[start].mod > m.open + 5) return [];
  let hi = -Infinity, lo = Infinity, i = start;
  for (; i < bars.length && bars[i].mod < m.open + rangeMin; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  const width = hi - lo;
  if (!(width >= m.spread * 4)) return [];
  const lastEntry = m.open + 180;
  const out = [];
  let losses = 0;
  let need = null; // after a target: {dir, level} new extreme needed to re-enter
  let armed = true; // multi: price must come back inside the range before a new breakout counts
  for (; i < bars.length - 1 && bars[i].mod < lastEntry; i++) {
    const c = bars[i].close;
    let dir = 0;
    if (need) { if ((c - need.level) * need.dir > 0) dir = need.dir; }
    else if (out.length === 0 || (mode === 'multi' && armed)) dir = c > hi ? 1 : c < lo ? -1 : 0;
    if (mode === 'multi' && !armed && c <= hi && c >= lo) armed = true;
    if (!dir) continue;
    const entry = bars[i + 1].open;
    const stop = need ? entry - dir * width : dir > 0 ? hi - width : lo + width;
    const risk = (entry - stop) * dir;
    const tR = mode === 'tp' ? tpR : targetR;
    const t = simulate(bars, { dir, entryIdx: i + 1, stop, target: tR ? entry + dir * risk * tR : null, exitMod: m.close }, costs);
    if (!t) continue;
    out.push({ day: dd.day, year: +dd.day.slice(0, 4), ...t });
    i = t.exitIdx;
    if (t.r <= 0) losses++;
    if (mode === 'base' || losses >= maxLoss || t.why === 'time' || t.why === 'end of data') break;
    if (mode === 'tp') {
      if (t.why !== 'target') break; // the move failed: done for the day
      let ext = t.exit;
      need = { dir, level: ext };
    } else if (mode === 'multi') { armed = false; need = null; }
  }
  return out;
}

const variants = [
  { name: 'actual (o tranzacție, ținta botului)', mode: 'base' },
  ...[0.25, 0.5, 1].map((tpR) => ({ name: `țintă ${tpR}R + reintrare`, mode: 'tp', tpR })),
  { name: 'mai multe pe zi, stop la 3 pierderi', mode: 'multi' },
];
const res = variants.map((v) => {
  const tr = days.flatMap((d) => day(d, v));
  const s = stats(tr.map((t) => ({ ...t, points: t.r })));
  const early = stats(tr.filter((t) => t.year < 2013).map((t) => ({ ...t, points: t.r })));
  const late = stats(tr.filter((t) => t.year >= 2013).map((t) => ({ ...t, points: t.r })));
  const perDay = tr.length / days.length;
  return { name: v.name, n: s.n, perDay: +perDay.toFixed(2), avgR: +s.avg.toFixed(3), totalR: +s.total.toFixed(0), win: +s.winRate.toFixed(0), maxDD: +s.maxDD.toFixed(1), t: +s.t.toFixed(2), r0512: +early.total.toFixed(0), r1320: +late.total.toFixed(0) };
});
console.log(JSON.stringify({ key, days: days.length, res }));
