// Post-earnings drift (Paul's choice, 2026-11-15). Research on 122 large US stocks, 2010–2026
// (bin/earnings-research.js): a stock that beats the market by 10 % or more over the two
// days around its earnings 8-K went on to beat it by about 1.7 % over the next 20 trading
// days, positive in all four periods, 59 % winners. This module finds those stocks.

const DAY = 86400e3;

// EDGAR's filing date for an acceptance time: the New York date, or the next day when the
// filing was accepted after 17:30 (weekends are skipped later by the price bars).
export function filingDay(time) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(time)).map((x) => [x.type, x.value]));
  const late = Number(p.hour) * 60 + Number(p.minute) > 17 * 60 + 30;
  const d = Date.parse(`${p.year}-${p.month}-${p.day}T12:00:00Z`) + (late ? DAY : 0);
  return new Date(d).toISOString().slice(0, 10);
}

const dayOf = (bar) => new Date(bar.time).toISOString().slice(0, 10);

// Move from the close before the filing day to the close of the day after it, minus the
// market's move over the same days. Null while that second day has not closed yet.
export function reaction(bars, benchBars, day, now) {
  const i = bars.findIndex((b) => dayOf(b) >= day);
  const end = bars[i + 1];
  // US markets close at 20:00 UTC in summer and 21:00 in winter.
  if (i < 1 || !end || now < Date.parse(`${dayOf(end)}T21:15:00Z`)) return null;
  const b0 = benchBars.find((b) => dayOf(b) === dayOf(bars[i - 1]));
  const b1 = benchBars.find((b) => dayOf(b) === dayOf(end));
  if (!b0 || !b1) return null;
  return { move: end.close / bars[i - 1].close - 1, excess: end.close / bars[i - 1].close - b1.close / b0.close, entryDay: dayOf(end) };
}
