// Daily trend following on Bitcoin and Ether CFDs (lib/markets.js TREND_MARKETS), demo only.
// Rules as in bin/crypto-research.js (Paul's choice on demo, 2026-10-24):
//   - enter when a day closes above the highest close of the 50 days before it (buy) or
//     below the lowest (sell);
//   - stop at 3 × ATR(20) from the entry, placed at IG and never moved;
//   - exit when a day closes below the lowest low of the 20 days before it (buys) or above
//     the highest high (sells).
// Runs once a day on the last completed daily candle (IG's, from midnight UK time; crypto
// trades at weekends too). Each trade risks `riskPct` % of the
// account. Positions the bot did not open are left alone.

import { tradingDay } from './state.js';

const DAY = 86400e3;
const ENTRY_DAYS = 50;
const EXIT_DAYS = 20;
const ATR_DAYS = 20;
const STOP_ATR = 3;

// Average true range of the ATR_DAYS days before index i (as in the research).
export function atrBefore(days, i) {
  const w = days.slice(i - ATR_DAYS, i);
  return w.reduce((s, x, k) => {
    const pc = k ? w[k - 1].close : x.open;
    return s + Math.max(x.high - x.low, Math.abs(x.high - pc), Math.abs(x.low - pc));
  }, 0) / ATR_DAYS;
}

// Signal on the last day of `days` (completed daily candles, oldest first).
// Without a position: { enter: 'BUY' | 'SELL', atr } or null. With one: { exit: true } or null.
export function trendSignal(days, side) {
  const i = days.length - 1;
  if (i < ENTRY_DAYS) return null;
  const d = days[i];
  if (side) {
    const w = days.slice(i - EXIT_DAYS, i);
    const exit = side === 'BUY' ? d.close < Math.min(...w.map((x) => x.low)) : d.close > Math.max(...w.map((x) => x.high));
    return exit ? { exit: true } : null;
  }
  const closes = days.slice(i - ENTRY_DAYS, i).map((x) => x.close);
  const enter = d.close > Math.max(...closes) ? 'BUY' : d.close < Math.min(...closes) ? 'SELL' : null;
  return enter ? { enter, atr: atrBefore(days, i) } : null;
}

export class TrendBot {
  constructor({ client, markets, riskPct, state, log = console.log, now = Date.now }) {
    if (!markets?.length) throw new Error('No markets to trade');
    if (!(riskPct > 0 && riskPct <= 2)) throw new Error('BOT_RISK_PCT must be between 0 and 2');
    Object.assign(this, { client, markets, riskPct, state, log, now });
    this.data = { markets: {}, ...state.load() };
    this.data.markets ??= {};
  }

  async run() {
    await this.client.login();
    if (this.client.accountType !== 'CFD') throw new Error('The trend bot trades CFD accounts only');
    const equity = await this.client.equity();
    const risk = Math.round(equity * this.riskPct) / 100;
    for (const m of this.markets) {
      try {
        await this.step(m, risk);
      } catch (e) {
        if (e.fatal) throw e;
        this.log(`Eroare la ${m.name}: ${e.message}`);
      }
    }
  }

  async step(m, risk) {
    const st = (this.data.markets[m.key] ??= {});
    const now = this.now();
    // Completed daily candles only; the one still forming is dropped.
    const days = (await this.client.candles(m.epic, 'DAY', ENTRY_DAYS + 10)).filter((c) => c.time + DAY <= now);
    const last = days.at(-1);
    if (!last) return this.log(`Eroare la ${m.name}: IG nu a trimis prețuri zilnice.`);
    // IG's daily candles start at midnight UK time.
    const day = tradingDay(last.time + 3600e3, 'Europe/London');
    if (st.lastDay === day) return console.log(`${m.name}: ziua ${day} a fost deja tratată.`);
    const positions = await this.client.openPositions(m.epic);

    let justClosed = false;
    if (st.pos && !positions.length) {
      justClosed = true; // as in the research, no new entry on the day a trade ends
      this.log(`${m.name}: poziția ${st.pos.side} deschisă pe ${st.pos.day} s-a închis (stop atins sau închisă manual).`);
      st.pos = null;
    } else if (!st.pos && positions.length) {
      st.lastDay = day;
      this.state.save(this.data);
      return this.log(`${m.name}: există o poziție pe care nu am deschis-o eu; nu fac nimic.`);
    }

    const signal = justClosed ? null : trendSignal(days, st.pos?.side);
    // Log only (not sent to Telegram): what the bot saw on the day it acts on.
    const prev = days.slice(-ENTRY_DAYS - 1, -1).map((x) => x.close);
    console.log(`${m.name}: zi ${day}, ${days.length} zile, închidere ${last.close}, interval 50 zile ${Math.min(...prev)}–${Math.max(...prev)}, poziție ${st.pos?.side ?? 'niciuna'}, semnal ${signal?.enter ?? (signal?.exit ? 'ieșire' : 'niciunul')}`);
    if (signal?.exit) {
      for (const p of positions) await this.client.closePosition(p);
      this.log(`Închis ${m.name} ${st.pos.side} (prețul a ieșit din trend: închidere dincolo de extrema ultimelor ${EXIT_DAYS} zile).`);
      st.pos = null;
    } else if (signal?.enter) {
      const done = await this.enter(m, st, signal, risk, day);
      if (!done) return; // market closed or refused: try again on the next run
    }
    st.lastDay = day;
    this.state.save(this.data);
  }

  // Returns false when the order could not be tried (the day is then handled again later).
  async enter(m, st, { enter: side, atr }, risk, day) {
    const q = await this.client.market(m.epic);
    if (q.status !== 'TRADEABLE' || q.bid == null || q.offer == null) {
      this.log(`Eroare la ${m.name}: piața nu se poate tranzacționa acum (${q.status}); reîncerc la rularea următoare.`);
      return false;
    }
    const entry = side === 'BUY' ? q.offer : q.bid;
    const minStop = q.minStopUnit === 'PERCENTAGE' ? (q.minStop / 100) * entry * q.scaling : q.minStop;
    const stopDistance = Math.round(Math.max(STOP_ATR * atr * q.scaling, minStop) * 10) / 10;
    const perPoint = q.pointValue * q.toAccount;
    if (!(stopDistance > 0 && perPoint > 0)) throw new Error(`no point value for ${m.epic}`);
    // As many decimals as the smallest allowed size has (e.g. 0.001 on Bitcoin).
    const f = 10 ** Math.max(2, Math.ceil(-Math.log10(q.minSize || 0.01) - 1e-9));
    let size = Math.floor((risk / (stopDistance * perPoint)) * f) / f;
    if (size < q.minSize) {
      if (q.minSize * stopDistance * perPoint > 2 * risk) {
        this.log(`Azi fără tranzacție pe ${m.name}: stopul e prea larg pentru riscul ales.`);
        return true;
      }
      size = q.minSize;
    }
    if (q.marginPct > 0) {
      const need = size * q.contractSize * entry * q.toAccount * q.marginPct / 100;
      const free = await this.client.available();
      if (need > free) {
        this.log(`Azi fără tranzacție pe ${m.name}: marjă insuficientă (trebuie ≈ ${need.toFixed(0)}, disponibil ${free.toFixed(0)}).`);
        return true;
      }
    }
    // Saved before sending: after a crash the bot treats the order as placed, never sends it twice.
    st.pos = { side, day, level: entry };
    this.state.save(this.data);
    let res;
    // IG's size step is not in the market data (Ether rejected 4 decimals with SIZE_INCREMENT):
    // a rejected order opens nothing, so try again with one decimal fewer, never below the minimum.
    for (let d = Math.round(Math.log10(f)); ; d--) {
      try {
        res = await this.client.openMarket({ epic: m.epic, expiry: q.expiry, direction: side, size, currency: q.currency, stopDistance });
        break;
      } catch (e) {
        const smaller = Math.floor(size * 10 ** (d - 1)) / 10 ** (d - 1);
        if (/SIZE_INCREMENT/.test(e.message) && d > 0 && smaller >= q.minSize && smaller > 0) {
          size = smaller;
          continue;
        }
        if (e.code !== 'UNKNOWN_ORDER_STATE') {
          st.pos = null;
          this.state.save(this.data);
        }
        e.message += ` (mărime ${size})`;
        throw e;
      }
    }
    st.pos.level = res.level ?? entry;
    this.log(`Deschis ${m.name} ${side} ${size} la ${res.level ?? entry}, stop la ${stopDistance} puncte (3 × mișcarea medie zilnică). Risc ≈ ${(size * stopDistance * perPoint).toFixed(2)}.`);
    return true;
  }
}
