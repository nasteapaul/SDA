// Loads 1-minute history for a market from lib/markets.js out of a FutureSharks/financial-data
// checkout (`root` = its pyfinancialdata/data folder): Oanda files (UTC) or HistData (DAX).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistData, parseOanda } from './history.js';

export function loadMarketBars(m, root, from = 0, to = 9999) {
  const [kind, sym] = m.history.split('/');
  const files = [];
  if (kind === 'oanda') {
    const dir = join(root, 'currencies/oanda', sym);
    for (const y of readdirSync(dir).filter((y) => +y >= from && +y <= to).sort()) {
      for (const f of readdirSync(join(dir, y))) files.push([join(dir, y, f), parseOanda]);
    }
  } else {
    const dir = join(root, 'stocks/histdata', sym);
    for (const f of readdirSync(dir).sort()) {
      const y = +(/(\d{4})\.csv$/.exec(f)?.[1] ?? 0);
      if (y >= from && y <= to) files.push([join(dir, f), parseHistData]);
    }
  }
  const bars = [];
  for (const [path, parse] of files) {
    if (!existsSync(path)) continue;
    for (const b of parse(readFileSync(path, 'utf8'))) bars.push(b);
  }
  bars.sort((a, b) => a.time - b.time);
  return bars;
}
