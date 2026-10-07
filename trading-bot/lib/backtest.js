// Simulates one position at a time. Entries at the next candle's open, paying half the
// spread on entry and half on exit. Stops are checked before targets inside a candle
// (pessimistic, since intra-candle order is unknown).

export function backtest(candles, signals, opts = {}) {
  const {
    capital = 10000,
    riskPct = 1, // % of equity risked per trade
    spread = 0, // in price points, full bid/ask spread
  } = opts;
  if (!(capital > 0) || !(riskPct > 0 && riskPct <= 100) || !(spread >= 0)) {
    throw new Error('Invalid backtest options');
  }
  const half = spread / 2;
  let equity = capital;
  let peak = capital;
  let maxDrawdownPct = 0;
  let pos = null;
  const trades = [];

  const close = (exitPrice, time, why) => {
    const dir = pos.side === 'BUY' ? 1 : -1;
    const exit = exitPrice - dir * half;
    const pnl = (exit - pos.entry) * dir * pos.size;
    equity += pnl;
    trades.push({ ...pos, exit, exitTime: time, pnl, why });
    pos = null;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const sig = signals[i - 1];

    if (!pos && sig?.side) {
      const dir = sig.side === 'BUY' ? 1 : -1;
      const entry = c.open + dir * half;
      const size = (equity * riskPct) / 100 / sig.stopDist;
      pos = {
        side: sig.side,
        entry,
        entryTime: c.time,
        size,
        stop: entry - dir * sig.stopDist,
        target: entry + dir * sig.targetDist,
      };
    } else if (pos && sig?.side && sig.side !== pos.side) {
      close(c.open, c.time, 'semnal invers');
      continue;
    }

    if (pos) {
      const long = pos.side === 'BUY';
      const hitStop = long ? c.low <= pos.stop : c.high >= pos.stop;
      const hitTarget = long ? c.high >= pos.target : c.low <= pos.target;
      // A gap through the level fills at the open, not at the level.
      if (hitStop) close(long ? Math.min(c.open, pos.stop) : Math.max(c.open, pos.stop), c.time, 'stop-loss');
      else if (hitTarget) close(long ? Math.max(c.open, pos.target) : Math.min(c.open, pos.target), c.time, 'take-profit');
    }
  }
  if (pos) close(candles.at(-1).close, candles.at(-1).time, 'final date');

  return summarize(trades, capital, equity, maxDrawdownPct);
}

function summarize(trades, capital, equity, maxDrawdownPct) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  return {
    trades,
    count: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    net: equity - capital,
    returnPct: ((equity - capital) / capital) * 100,
    maxDrawdownPct,
    finalEquity: equity,
  };
}
