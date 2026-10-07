// Intraday simulator on 1-minute bars. Strategies decide entries; this file decides fills
// and costs the same way for all of them, so results are comparable.
//
// Fills: enter at the open of entry bar. Each later bar is checked stop first, then target
// (pessimistic); a gap through a level fills at the bar's open. Positions are closed at the
// open of the first bar at/after `exitMod`, or at the day's last close.
// Costs (points): the spread for the entry time, paid once per round trip, plus `slippage`
// on stop exits.

export const DEFAULT_COSTS = Object.freeze({
  sessionSpread: 1.2, // IG Germany 40 in Frankfurt cash hours
  offSpread: 2.5, // outside 09:00-17:30
  slippage: 0.5,
});

export function spreadAt(mod, costs = DEFAULT_COSTS) {
  return mod >= 540 && mod < 1050 ? costs.sessionSpread : costs.offSpread;
}

// trade: { dir: 1 | -1, entryIdx, stop, target?, exitMod }
export function simulate(bars, trade, costs = DEFAULT_COSTS) {
  const { dir, entryIdx, stop, target, exitMod } = trade;
  const entryBar = bars[entryIdx];
  const entry = entryBar.open;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return null;
  let exit = bars.at(-1).close;
  let exitIdx = bars.length - 1;
  let why = 'end of data';
  for (let j = entryIdx; j < bars.length; j++) {
    const b = bars[j];
    if (j > entryIdx && b.mod >= exitMod) { exit = b.open; exitIdx = j; why = 'time'; break; }
    const hitStop = dir > 0 ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      exit = (dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop)) - dir * costs.slippage;
      exitIdx = j; why = 'stop'; break;
    }
    if (target != null && (dir > 0 ? b.high >= target : b.low <= target)) {
      exit = dir > 0 ? Math.max(b.open, target) : Math.min(b.open, target);
      exitIdx = j; why = 'target'; break;
    }
  }
  const points = (exit - entry) * dir - spreadAt(entryBar.mod, costs);
  return { dir, entry, exit, exitIdx, why, points, r: points / risk, mod: entryBar.mod };
}

// Runs strategy(day, prevDays) over every day. A strategy returns trade specs in time order;
// a spec that starts before the previous trade's exit is skipped (one position at a time).
export function runDays(days, strategy, costs = DEFAULT_COSTS) {
  const trades = [];
  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    let busyUntil = -1;
    for (const spec of strategy(day, days, d) ?? []) {
      if (spec.entryIdx <= busyUntil || spec.entryIdx >= day.bars.length) continue;
      const t = simulate(day.bars, spec, costs);
      if (!t) continue;
      busyUntil = t.exitIdx;
      trades.push({ day: day.day, year: +day.day.slice(0, 4), ...t });
    }
  }
  return trades;
}

export function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, avg: 0, total: 0, winRate: 0, pf: 0, maxDD: 0, t: 0, avgR: 0 };
  const pts = trades.map((t) => t.points);
  const total = pts.reduce((a, b) => a + b, 0);
  const avg = total / n;
  const sd = Math.sqrt(pts.reduce((a, p) => a + (p - avg) ** 2, 0) / Math.max(1, n - 1));
  const win = pts.filter((p) => p > 0);
  const gw = win.reduce((a, b) => a + b, 0);
  const gl = -pts.filter((p) => p <= 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pts) { eq += p; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  return {
    n,
    avg,
    total,
    winRate: (win.length / n) * 100,
    pf: gl > 0 ? gw / gl : Infinity,
    maxDD,
    t: sd > 0 ? (avg / sd) * Math.sqrt(n) : 0,
    avgR: trades.reduce((a, t) => a + t.r, 0) / n,
  };
}
