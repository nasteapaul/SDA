#!/usr/bin/env node
// Do US stocks that open with a big gap (usually overnight news: earnings, deals, guidance)
// keep moving the same way until the close? Per day and stock: gap = open / previous close - 1.
// "Follow" buys a gap up (shorts a gap down) at the open and closes at the same day's close;
// "fade" does the opposite. Results per trade before and after a round-trip cost.
// Daily prices from Yahoo (needs open internet, runs in a GitHub workflow).
//   node bin/gap-research.js
const TICKERS = `AAPL MSFT AMZN GOOGL META NVDA TSLA BRK-B JPM JNJ V PG UNH HD MA DIS BAC XOM CVX PFE KO PEP
CSCO INTC ORCL CRM ADBE NFLX AMD QCOM TXN AVGO IBM MU AMAT LRCX NOW INTU PYPL SHOP UBER ABNB SNAP
PINS ROKU ZM DOCU SQ COIN PLTR SNOW CRWD NET DDOG MDB OKTA TWLO ETSY EBAY BKNG EXPE MAR
WMT COST TGT LOW NKE SBUX MCD CMG LULU DG DLTR BBY KR GIS
BA CAT DE GE HON MMM UPS FDX LMT RTX GM F
GS MS C WFC AXP SCHW BLK
MRK ABBV LLY BMY AMGN GILD BIIB REGN VRTX MRNA ISRG TMO ABT MDT CVS
T VZ TMUS CMCSA CHTR
SLB OXY COP HAL DVN FCX NEM AA X CLF`.split(/\s+/);
const FROM = Date.UTC(2010, 0, 1) / 1000;

async function daily(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${FROM}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const r = (await res.json()).chart.result?.[0];
      if (!r?.timestamp) return [];
      const q = r.indicators.quote[0];
      return r.timestamp.map((t, k) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[k], close: q.close[k] }))
        .filter((d) => d.open > 0 && d.close > 0);
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  console.error(`${sym}: no data`);
  return [];
}

const events = [];
for (const sym of TICKERS) {
  const rows = await daily(sym);
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].open / rows[i - 1].close - 1;
    // Yahoo opens are unadjusted for splits on the split day: skip absurd gaps.
    if (Math.abs(gap) > 0.6) continue;
    events.push({ sym, date: rows[i].date, gap, day: rows[i].close / rows[i].open - 1 });
  }
}
console.log(`${TICKERS.length} acțiuni, ${events.length} zile de tranzacționare\n`);

const PERIODS = [['2010', '2018'], ['2018', '2020'], ['2020', '2023'], ['2023', '2100']];
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
function row(label, sel, sign) {
  const cells = PERIODS.map(([a, b]) => {
    const t = sel.filter((e) => e.date >= a && e.date < b).map((e) => sign(e) * e.day);
    if (!t.length) return 'n=0';
    const avg = t.reduce((s, x) => s + x, 0) / t.length;
    const win = t.filter((x) => x > 0).length / t.length;
    return `n=${t.length} medie ${pct(avg)} câștig ${(win * 100).toFixed(0)}% net0.1% ${pct(avg - 0.001)} net0.3% ${pct(avg - 0.003)}`;
  });
  console.log(`${label.padEnd(28)} ${cells.join(' | ')}`);
}
console.log(`Perioade: ${PERIODS.map(([a, b]) => `${a}–${b === '2100' ? 'azi' : +b - 1}`).join(' | ')}`);
for (const g of [0.02, 0.04, 0.06, 0.1]) {
  const up = events.filter((e) => e.gap >= g), down = events.filter((e) => e.gap <= -g);
  row(`Salt ≥${g * 100}% sus, urmez`, up, () => 1);
  row(`Salt ≥${g * 100}% jos, urmez`, down, () => -1);
  row(`Salt ≥${g * 100}% sus, contra`, up, () => -1);
  row(`Salt ≥${g * 100}% jos, contra`, down, () => 1);
}
row('Toate zilele, cumpăr (reper)', events, () => 1);
