#!/usr/bin/env node
// Which IG markets made money over the last 10 years? Yahoo daily bars, 2016–today, for ~80
// markets IG offers (currencies, indices, commodities, bonds, crypto, large shares). Per market:
// the daily trend rule from bin/crypto-research.js (50-day breakout in, 20-day breakout out,
// stop 3 × ATR(20), 1R = amount risked) in both directions and buys only, with IG-like spreads
// and overnight funding, plus buy-and-hold for reference. Periods 2016–19, 2020–22, 2023–today.
//   node bin/ig-scan-daily.js            (needs internet: run it in the ig-scan workflow)
const FX = { spread: 0.0002, fundLong: 0.01, fundShort: 0.01 };
const IDX = { spread: 0.0004, fundLong: 0.04, fundShort: 0.01 };
const COM = { spread: 0.0008, fundLong: 0.04, fundShort: 0.01 };
const STK = { spread: 0.001, fundLong: 0.045, fundShort: 0.015 };
const CRY = { spread: 0.002, fundLong: 0.12, fundShort: 0.12 };
const M = [
  ['Valute', FX, [['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'], ['AUDUSD=X', 'AUD/USD'], ['USDCAD=X', 'USD/CAD'], ['USDCHF=X', 'USD/CHF'], ['NZDUSD=X', 'NZD/USD'], ['EURGBP=X', 'EUR/GBP'], ['EURJPY=X', 'EUR/JPY'], ['GBPJPY=X', 'GBP/JPY'], ['EURCHF=X', 'EUR/CHF'], ['AUDJPY=X', 'AUD/JPY'], ['EURAUD=X', 'EUR/AUD'], ['GBPAUD=X', 'GBP/AUD'], ['USDSEK=X', 'USD/SEK'], ['USDNOK=X', 'USD/NOK'], ['USDMXN=X', 'USD/MXN'], ['USDZAR=X', 'USD/ZAR'], ['EURPLN=X', 'EUR/PLN'], ['USDSGD=X', 'USD/SGD']]],
  ['Indici', IDX, [['^GSPC', 'US 500'], ['^NDX', 'US Tech 100'], ['^DJI', 'Wall Street'], ['^RUT', 'US Russell 2000'], ['^GDAXI', 'Germania 40'], ['^FTSE', 'FTSE 100'], ['^FCHI', 'Franța 40'], ['^STOXX50E', 'EU Stocks 50'], ['^N225', 'Japonia 225'], ['^HSI', 'Hong Kong HS50'], ['^AXJO', 'Australia 200'], ['^IBEX', 'Spania 35'], ['FTSEMIB.MI', 'Italia 40'], ['^AEX', 'Olanda 25'], ['^SSMI', 'Elveția 20'], ['^NSEI', 'India 50'], ['^GSPTSE', 'Canada 60'], ['^VIX', 'Volatilitate VIX']]],
  ['Mărfuri', COM, [['GC=F', 'Aur'], ['SI=F', 'Argint'], ['CL=F', 'Petrol WTI'], ['BZ=F', 'Petrol Brent'], ['NG=F', 'Gaze naturale'], ['HG=F', 'Cupru'], ['PL=F', 'Platină'], ['PA=F', 'Paladiu'], ['ZC=F', 'Porumb'], ['ZW=F', 'Grâu'], ['ZS=F', 'Soia'], ['KC=F', 'Cafea'], ['SB=F', 'Zahăr'], ['CC=F', 'Cacao'], ['CT=F', 'Bumbac'], ['LE=F', 'Vite'], ['HO=F', 'Motorină'], ['RB=F', 'Benzină']]],
  ['Obligațiuni', IDX, [['ZN=F', 'T-Note SUA 10 ani'], ['ZB=F', 'T-Bond SUA 30 ani'], ['ZF=F', 'T-Note SUA 5 ani']]],
  ['Cripto', CRY, [['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['XRP-USD', 'Ripple'], ['LTC-USD', 'Litecoin'], ['SOL-USD', 'Solana'], ['ADA-USD', 'Cardano'], ['DOGE-USD', 'Dogecoin']]],
  ['Acțiuni', STK, [['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta'], ['TSLA', 'Tesla'], ['JPM', 'JPMorgan'], ['XOM', 'Exxon'], ['JNJ', 'J&J'], ['KO', 'Coca-Cola'], ['NFLX', 'Netflix'], ['AMD', 'AMD'], ['SAP.DE', 'SAP'], ['ASML.AS', 'ASML'], ['MC.PA', 'LVMH'], ['NESN.SW', 'Nestlé'], ['SHEL.L', 'Shell'], ['AZN.L', 'AstraZeneca'], ['SIE.DE', 'Siemens']]],
];
const PERIODS = [['2016', '2020'], ['2020', '2023'], ['2023', '2100']];
const YEARS = [4, 3, (Date.now() - Date.parse('2023-01-01')) / 3.156e10];

async function daily(sym) {
  const p1 = Math.floor(Date.parse('2015-06-01') / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`;
  for (let k = 0; k < 3; k++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const r = (await res.json())?.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      if (!r?.timestamp || !q) return [];
      return r.timestamp.map((t, i) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] }))
        .filter((b) => [b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return [];
}

function trend(days, c, longOnly) {
  const trades = [];
  let pos = null;
  for (let i = 51; i < days.length; i++) {
    const d = days[i], prev = days.slice(i - 50, i), last20 = days.slice(i - 20, i);
    const atr = last20.reduce((s, x, k) => s + Math.max(x.high - x.low, Math.abs(x.high - (k ? last20[k - 1].close : x.open)), Math.abs(x.low - (k ? last20[k - 1].close : x.open))), 0) / 20;
    if (pos) {
      const hitStop = pos.dir > 0 ? d.low <= pos.stop : d.high >= pos.stop;
      const exitSig = pos.dir > 0 ? d.close < Math.min(...last20.map((x) => x.low)) : d.close > Math.max(...last20.map((x) => x.high));
      if (hitStop || exitSig) {
        const exit = hitStop ? (pos.dir > 0 ? Math.min(d.open, pos.stop) : Math.max(d.open, pos.stop)) : d.close;
        const nights = Math.round((Date.parse(d.day) - Date.parse(pos.day)) / 864e5);
        const fund = pos.dir > 0 ? c.fundLong : c.fundShort;
        const pnl = (exit - pos.entry) * pos.dir - pos.entry * (c.spread * (hitStop ? 2 : 1) + nights * fund / 365);
        trades.push({ day: d.day, r: pnl / pos.risk });
        pos = null;
      }
      continue;
    }
    const hi = Math.max(...prev.map((x) => x.close)), lo = Math.min(...prev.map((x) => x.close));
    const dir = d.close > hi ? 1 : d.close < lo && !longOnly ? -1 : 0;
    if (dir && atr > 0) pos = { dir, day: d.day, entry: d.close, stop: d.close - dir * 3 * atr, risk: 3 * atr };
  }
  return trades;
}

const per = (trades) => PERIODS.map(([a, b]) => trades.filter((x) => x.day >= a && x.day < b).reduce((s, x) => s + x.r, 0));
const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`;
const rows = [];
for (const [group, costs, list] of M) {
  for (const [sym, name] of list) {
    const days = await daily(sym);
    await new Promise((r) => setTimeout(r, 400));
    if (days.length < 300) { console.log(`${name} (${sym}): fără date`); continue; }
    const both = per(trend(days, costs, false)), long = per(trend(days, costs, true));
    const n = trend(days, costs, false).filter((x) => x.day >= '2016').length;
    const hold = PERIODS.map(([a, b]) => { const s = days.filter((d) => d.day >= a && d.day < b); return s.length > 20 ? (s.at(-1).close / s[0].open - 1) * 100 : NaN; });
    const row = { group, name, sym, both, long, n, hold, perYr: both.reduce((s, x) => s + x, 0) / YEARS.reduce((s, y, k) => s + (days[0].day < PERIODS[k][1] ? y : 0), 0) };
    rows.push(row);
    console.log(`${group.padEnd(11)} ${name.padEnd(18)} trend ambele ${both.map(sign).join(' / ').padEnd(16)} doar long ${long.map(sign).join(' / ').padEnd(16)} ${String(n).padStart(3)} tr | cumpără și ține ${hold.map((x) => (Number.isFinite(x) ? `${sign(x)}%` : '–')).join(' / ')}`);
  }
}

console.log('\n=== Clasament: trend în ambele direcții, după cea mai slabă perioadă (2016–19 / 2020–22 / 2023–azi, în R) ===');
for (const r of [...rows].sort((a, b) => Math.min(...b.both) - Math.min(...a.both)).slice(0, 25)) {
  console.log(`${r.name.padEnd(18)} ${r.group.padEnd(11)} ${r.both.map(sign).join(' / ').padEnd(16)} ≈ ${r.perYr.toFixed(1)}R/an${r.both.every((x) => x > 0) ? '  <-- pozitiv în toate' : ''}`);
}
for (const g of [...new Set(rows.map((r) => r.group)), 'Toate']) {
  const rs = rows.filter((r) => g === 'Toate' || r.group === g);
  const tot = PERIODS.map((_, k) => rs.reduce((s, r) => s + r.both[k], 0) / rs.length);
  console.log(`Media pe piață, ${g.padEnd(11)} (${rs.length}): ${tot.map(sign).join(' / ')} R; pozitive în toate perioadele: ${rs.filter((r) => r.both.every((x) => x > 0)).length}`);
}
