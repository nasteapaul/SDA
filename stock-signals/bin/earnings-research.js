#!/usr/bin/env node
// Do US stocks keep rising for weeks after a strong earnings report (post-earnings drift)?
// Earnings days come from SEC EDGAR: every 8-K with Item 2.02 (results of operations).
// The 8-K can land before the open or after the close, so the reaction is measured over
// two days, close of the day before the filing -> close of the day after it, minus the
// S&P 500 (SPY) over the same days. Entry is that second close, when the whole reaction
// is public (no look-ahead); the trade is held 5, 20 or 60 trading days.
// Daily prices from Yahoo, adjusted for splits and dividends. Needs open internet, so it
// runs in a GitHub workflow.
//   SEC_CONTACT=you@example.com node bin/earnings-research.js
// Caveat: the list is today's well-known large companies (survivorship bias flatters
// plain returns; the comparison with SPY and between buckets is what matters).
const TICKERS = `AAPL MSFT AMZN GOOGL META NVDA TSLA JPM JNJ V PG UNH HD MA DIS BAC XOM CVX PFE KO PEP
CSCO INTC ORCL CRM ADBE NFLX AMD QCOM TXN AVGO IBM MU AMAT LRCX NOW INTU PYPL SHOP UBER ABNB SNAP
PINS ROKU ZM DOCU COIN PLTR SNOW CRWD NET DDOG MDB OKTA TWLO ETSY EBAY BKNG EXPE MAR
WMT COST TGT LOW NKE SBUX MCD CMG LULU DG DLTR BBY KR GIS
BA CAT DE GE HON MMM UPS FDX LMT RTX GM F
GS MS C WFC AXP SCHW BLK
MRK ABBV LLY BMY AMGN GILD BIIB REGN VRTX MRNA ISRG TMO ABT MDT CVS
T VZ TMUS CMCSA CHTR
SLB OXY COP HAL DVN FCX NEM AA CLF`.split(/\s+/);
const START = '2010-01-01';
const HORIZONS = [5, 20, 60];
const PERIODS = [['2010', '2018'], ['2018', '2020'], ['2020', '2023'], ['2023', '2100']];
const COSTS = [0.003, 0.01]; // round trip: spread only; spread + XTB currency conversion both ways

const contact = process.env.SEC_CONTACT;
if (!contact || !/@/.test(contact)) throw new Error('Set SEC_CONTACT to an e-mail address (SEC requires it)');
const SEC_HEADERS = { 'User-Agent': `stock-signals ${contact}`, 'Accept-Encoding': 'gzip, deflate' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers }).catch(() => null);
    if (res?.ok) return res.json();
    if (res?.status === 404) return null;
    await sleep(1500 * (i + 1));
  }
  return null;
}
const sec = async (url) => { await sleep(150); return getJson(url, SEC_HEADERS); };

// Filing dates of 8-Ks with Item 2.02, oldest first, at most one per 10 days.
async function earningsDays(cik) {
  const id = String(cik).padStart(10, '0');
  const main = await sec(`https://data.sec.gov/submissions/CIK${id}.json`);
  if (!main) return [];
  const pages = [main.filings.recent];
  for (const f of main.filings.files ?? []) {
    if (f.filingTo && f.filingTo < START) continue;
    const page = await sec(`https://data.sec.gov/submissions/${f.name}`);
    if (page) pages.push(page);
  }
  const days = new Set();
  for (const p of pages) {
    p.form.forEach((form, k) => {
      if (form === '8-K' && /(^|,)2\.02(,|$)/.test(p.items[k] ?? '') && p.filingDate[k] >= START) days.add(p.filingDate[k]);
    });
  }
  const out = [];
  for (const d of [...days].sort()) {
    if (!out.length || Date.parse(d) - Date.parse(out.at(-1)) > 10 * 86400e3) out.push(d);
  }
  return out;
}

async function daily(sym) {
  const from = Date.UTC(2009, 5, 1) / 1000;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${from}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const r = (await getJson(url, { 'User-Agent': 'Mozilla/5.0' }))?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const adj = r.indicators.adjclose?.[0]?.adjclose ?? r.indicators.quote[0].close;
  return r.timestamp.map((t, k) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: adj[k] })).filter((d) => d.close > 0);
}

const tickers = await sec('https://www.sec.gov/files/company_tickers.json');
if (!tickers) throw new Error('SEC ticker list not available');
const cikOf = new Map(Object.values(tickers).map((t) => [t.ticker, t.cik_str]));
const spy = await daily('SPY');
const spyAt = new Map(spy.map((d, k) => [d.date, k]));
if (spy.length < 1000) throw new Error('No SPY prices');

const events = [];
let used = 0;
for (const sym of TICKERS) {
  const cik = cikOf.get(sym);
  const rows = cik ? await daily(sym) : [];
  const days = rows.length ? await earningsDays(cik) : [];
  if (!days.length) { console.error(`${sym}: sărit (fără date)`); continue; }
  used++;
  for (const day of days) {
    const i = rows.findIndex((r) => r.date >= day);
    if (i < 1 || !rows[i + 1]) continue;
    const s0 = spyAt.get(rows[i - 1].date), s1 = spyAt.get(rows[i + 1].date);
    if (s0 == null || s1 == null) continue;
    const surprise = rows[i + 1].close / rows[i - 1].close - spy[s1].close / spy[s0].close;
    const e = { sym, date: rows[i + 1].date, surprise, ret: {}, excess: {} };
    for (const h of HORIZONS) {
      const end = rows[i + 1 + h];
      const s2 = end && spyAt.get(end.date);
      if (s2 == null) continue;
      e.ret[h] = end.close / rows[i + 1].close - 1;
      e.excess[h] = e.ret[h] - (spy[s2].close / spy[s1].close - 1);
    }
    events.push(e);
  }
}
console.log(`${used} acțiuni din ${TICKERS.length}, ${events.length} raportări de rezultate din ${START}\n`);

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// t-statistic over calendar months, not single trades: reports cluster in the same weeks
// and move together, so trades in one month are not independent.
function monthT(list, h) {
  const by = new Map();
  for (const e of list) by.set(e.date.slice(0, 7), [...(by.get(e.date.slice(0, 7)) ?? []), e.excess[h]]);
  const m = [...by.values()].map(mean);
  if (m.length < 3) return NaN;
  const mu = mean(m), sd = Math.sqrt(mean(m.map((x) => (x - mu) ** 2)) * m.length / (m.length - 1));
  return mu / (sd / Math.sqrt(m.length));
}

const BUCKETS = [
  ['toate raportările', () => true],
  ['reacție ≥ +5% față de piață', (e) => e.surprise >= 0.05],
  ['reacție ≥ +10% față de piață', (e) => e.surprise >= 0.1],
  ['reacție între −5% și +5%', (e) => Math.abs(e.surprise) < 0.05],
  ['reacție ≤ −5% față de piață', (e) => e.surprise <= -0.05],
  ['reacție ≤ −10% față de piață', (e) => e.surprise <= -0.1],
];
for (const h of HORIZONS) {
  console.log(`\n=== Ținut ${h} zile de bursă după reacție (cumpărat la închiderea zilei de după raportare) ===`);
  for (const [label, test] of BUCKETS) {
    console.log(`\n${label}`);
    for (const [a, b] of [...PERIODS, [START.slice(0, 4), '2100']]) {
      const list = events.filter((e) => test(e) && e.date >= a && e.date < b && e.ret[h] != null);
      const name = `${a}–${b === '2100' ? 'azi' : +b - 1}`.padEnd(10);
      if (list.length < 5) { console.log(`  ${name} n=${list.length}`); continue; }
      const r = mean(list.map((e) => e.ret[h])), x = mean(list.map((e) => e.excess[h]));
      const win = list.filter((e) => e.ret[h] > 0).length / list.length;
      const beat = list.filter((e) => e.excess[h] > 0).length / list.length;
      console.log(`  ${name} n=${String(list.length).padStart(4)} acțiunea ${pct(r)} (pe plus ${(win * 100).toFixed(0)}%) | peste piață ${pct(x)} (bate piața ${(beat * 100).toFixed(0)}%, t=${monthT(list, h).toFixed(1)}) | după costuri ${COSTS.map((c) => `${(c * 100).toFixed(1)}%: ${pct(r - c)}`).join(', ')}`);
    }
  }
}
