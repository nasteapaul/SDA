// Paper version of the daily Bitcoin/Ether trend (lib/trendbot.js rules), no orders anywhere.
// Paul's demo is IG UK, where crypto CFDs are banned for retail clients, so the trend is
// tested on paper (his choice, 2026-10-25). Daily candles are Coinbase's (UTC days, like the
// research on Binance). Costs as in bin/crypto-research.js: 0.1 % spread per trade, 0.05 %
// slippage on stops, overnight funding at IG's demo rates. Results in R (1R = the amount
// risked, 1 % of the account); a trade is never re-entered on the day it ends.

import { trendSignal } from './trendbot.js';

const DAY = 86400e3;
const SPREAD = 0.001;
const SLIP = 0.0005;
const STOP_ATR = 3;

export const PAPER_MARKETS = [
  { key: 'BTC', name: 'Bitcoin', product: 'BTC-USD', fundingYr: 0.125 },
  { key: 'ETH', name: 'Ether', product: 'ETH-USD', fundingYr: 0.2 },
];

// Completed daily candles, oldest first: { time, day, open, high, low, close }.
export async function coinbaseDays(product, now = Date.now(), fetchFn = fetch) {
  const res = await fetchFn(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`, {
    headers: { 'User-Agent': 'sda-trading-bot' },
  });
  if (!res.ok) throw new Error(`Coinbase ${product}: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Coinbase ${product}: unexpected answer`);
  return rows
    .map(([t, low, high, open, close]) => ({ time: t * 1000, day: new Date(t * 1000).toISOString().slice(0, 10), open, high, low, close }))
    .filter((c) => c.time + DAY <= now)
    .sort((a, b) => a.time - b.time);
}

const fmt = (x) => (x >= 100 ? Math.round(x).toLocaleString('ro-RO') : x.toFixed(2));
const fmtR = (r) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

export class PaperTrendBot {
  // startDay: the first day a signal may be taken (YYYY-MM-DD, UTC).
  constructor({ markets = PAPER_MARKETS, state, log = console.log, getDays = coinbaseDays, now = Date.now, startDay }) {
    Object.assign(this, { markets, state, log, getDays, now, startDay });
    this.data = { markets: {}, ...state.load() };
    this.data.markets ??= {};
  }

  async run() {
    for (const m of this.markets) {
      try {
        await this.step(m);
      } catch (e) {
        this.log(`Eroare la ${m.name}: ${e.message}`);
      }
    }
  }

  async step(m) {
    const st = (this.data.markets[m.key] ??= { trades: [] });
    const days = await this.getDays(m.product, this.now());
    if (!days.length) return this.log(`Eroare la ${m.name}: nu am prețuri zilnice.`);
    // Every completed day not handled yet, in order (a missed run is caught up).
    // On the first run: from startDay, or only the last day.
    const isNew = (d) => (st.lastDay ? d.day > st.lastDay : this.startDay ? d.day >= this.startDay : d === days.at(-1));
    const todo = days.map((d, i) => i).filter((i) => isNew(days[i]));
    if (!todo.length) return console.log(`${m.name}: nicio zi nouă (ultima tratată ${st.lastDay}).`);
    for (const i of todo) this.day(m, st, days.slice(0, i + 1));
    st.lastDay = days[todo.at(-1)].day;
    this.state.save(this.data);
  }

  day(m, st, days) {
    const d = days.at(-1);
    const pos = st.pos;
    if (pos) {
      const dir = pos.side === 'BUY' ? 1 : -1;
      const hitStop = dir > 0 ? d.low <= pos.stop : d.high >= pos.stop;
      const exitSig = !hitStop && trendSignal(days, pos.side)?.exit;
      console.log(`${m.name} ${d.day}: închidere ${d.close}, poziție ${pos.side}, stop ${pos.stop}${hitStop ? ', stop atins' : exitSig ? ', semnal de ieșire' : ''}`);
      if (!hitStop && !exitSig) return;
      const exit = hitStop ? (dir > 0 ? Math.min(d.open, pos.stop) : Math.max(d.open, pos.stop)) * (1 - dir * SLIP) : d.close;
      const nights = Math.round((d.time - pos.time) / DAY);
      const pnl = (exit - pos.entry) * dir - pos.entry * (SPREAD + (nights * m.fundingYr) / 365);
      const r = pnl / pos.risk;
      st.trades.push({ side: pos.side, from: pos.day, to: d.day, entry: pos.entry, exit, r: Math.round(r * 100) / 100 });
      st.pos = null;
      const total = st.trades.reduce((s, t) => s + t.r, 0);
      this.log(`Pe hârtie: ieșire ${m.name} ${pos.side === 'BUY' ? 'cumpărare' : 'vânzare'} la ${fmt(exit)} $ (${hitStop ? 'stop atins' : 'trendul s-a întors'}), după ${nights} zile: ${fmtR(r)} după costuri, ≈ ${Math.round(r * 100)} lei la 10.000 lei. Total ${m.name} pe hârtie: ${fmtR(total)} din ${st.trades.length} tranzacții.`);
      return; // no new entry on the day a trade ends
    }
    const sig = trendSignal(days);
    console.log(`${m.name} ${d.day}: închidere ${d.close}, fără poziție, semnal ${sig?.enter ?? 'niciunul'}`);
    if (!sig?.enter) return;
    const dir = sig.enter === 'BUY' ? 1 : -1;
    const risk = STOP_ATR * sig.atr;
    st.pos = { side: sig.enter, day: d.day, time: d.time, entry: d.close, stop: Math.round((d.close - dir * risk) * 100) / 100, risk };
    this.log(`Pe hârtie: ${sig.enter === 'BUY' ? 'cumpăr' : 'vând'} ${m.name} la ${fmt(d.close)} $ (închiderea zilei ${d.day} a ieșit din intervalul ultimelor 50 de zile). Stop la ${fmt(st.pos.stop)} $ (3 × mișcarea medie zilnică). Risc 1R = 1% din cont. Nu e niciun ordin real.`);
  }
}
