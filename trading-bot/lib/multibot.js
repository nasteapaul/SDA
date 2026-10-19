import { CandleBuilder } from './candles.js';
import { StateStore, tradingDay } from './state.js';
import { localClock } from './session.js';

const MIN = 60e3;
const ENTRY_HOURS = 3; // entries allowed for 3 hours after the session open
const WAKE_AHEAD_MIN = 240; // a run waits at most this long for a session to open
const MAX_LOSSES = 3; // per market and day; a later breakout of the range trades again until then
const MAX_TRADES = 6; // per market and day, a safety cap

// Holiday pause (Paul's choice, 2026-10-19): no new trades from 24 December to 2 January,
// when thin markets give false breakouts and wider spreads. Uses the market's local date.
export const isHolidayPause = (day) => day.slice(5) >= '12-24' || day.slice(5) <= '01-02';

// Opening range breakout on several IG markets, each in its own session (lib/markets.js,
// field `live`). Per market and local day: the high/low of the first `rangeMin` minutes
// after the open, then a 1-minute close beyond it enters, with the stop at the other side
// of the range and an optional target in R, both placed at IG. After a trade closes, the
// price must come back inside the range before the next breakout trades again (research:
// more R than one trade a day on EUR/USD, about the same elsewhere), until MAX_LOSSES
// losing trades on that market that day. Positions are closed once the session is over. Each trade risks
// `riskPct` % of the equity at the start of the day, or a fixed `riskPerTrade` (account
// currency). A shared daily loss limit (`maxDailyLossPct` % or a fixed `maxDailyLoss`)
// stops everything. A trade whose margin the account cannot cover is skipped.
export class MultiBot {
  constructor({
    client, markets, riskPerTrade, maxDailyLoss, riskPct, maxDailyLossPct, state = new StateStore(null),
    log = console.log, now = Date.now, heartbeatMs = 30 * MIN,
  }) {
    if (!markets?.length) throw new Error('No markets to trade');
    if (riskPct != null) {
      if (!(riskPct > 0 && riskPct <= 2)) throw new Error('BOT_RISK_PCT must be between 0 and 2');
    } else if (!(riskPerTrade > 0)) throw new Error('BOT_RISK_PER_TRADE must be > 0');
    if (maxDailyLossPct != null) {
      if (!(maxDailyLossPct > 0 && maxDailyLossPct <= 6)) throw new Error('BOT_MAX_DAILY_LOSS_PCT must be between 0 and 6');
    } else if (!(maxDailyLoss > 0)) throw new Error('BOT_MAX_DAILY_LOSS must be > 0');
    for (const m of markets) {
      if (!m.live?.epic || !(m.live.rangeMin > 0)) throw new Error(`Market ${m.key} has no live settings`);
    }
    Object.assign(this, { client, markets, riskPerTrade, maxDailyLoss, riskPct, maxDailyLossPct, state, log, now, heartbeatMs });
    this.info = {};
    this.builders = {};
    this.risk = { day: null, dayStartEquity: null, halted: false, markets: {}, ...state.load() };
    this.risk.markets ??= {};
  }

  async start() {
    await this.client.login();
    this.epics = {};
    for (const m of this.markets) {
      const cfd = this.client.accountType === 'CFD';
      const candidates = cfd ? m.live.cfdEpics ?? [] : [m.live.epic];
      for (const epic of candidates) {
        const info = await this.client.market(epic);
        // A CFD contract with no prices on this account is skipped for the next one.
        if (cfd && (info.bid == null || !(info.pointValue > 0))) continue;
        if (info.minStopUnit !== 'POINTS') throw new Error(`Unsupported stop unit ${info.minStopUnit} on ${epic}`);
        this.epics[m.key] = epic;
        this.info[m.key] = info;
        break;
      }
      if (!this.epics[m.key]) throw new Error(`No tradeable epic for ${m.name} on this ${cfd ? 'CFD' : 'spread-bet'} account`);
    }
    await this.checkRisk();
    const pct = (p) => (p != null ? ` (${p}% din cont)` : '');
    this.log(`Pornit pe ${this.markets.map((m) => m.name).join(', ')}. Risc pe tranzacție ${this.tradeRisk()}${pct(this.riskPct)}, pierdere maximă pe zi ${this.dailyLimit()}${pct(this.maxDailyLossPct)}.`);
  }

  // Amounts in account currency, from the equity at the start of the (Romanian) day.
  tradeRisk() {
    return this.riskPct != null ? Math.round(this.risk.dayStartEquity * this.riskPct) / 100 : this.riskPerTrade;
  }

  dailyLimit() {
    return this.maxDailyLossPct != null ? Math.round(this.risk.dayStartEquity * this.maxDailyLossPct) / 100 : this.maxDailyLoss;
  }

  // True while some market still has a session to trade within the next few hours.
  hasWork(now = this.now()) {
    if (this.risk.halted || this.stopped) return false;
    return this.markets.some((m) => {
      const { day, mod } = localClock(now, m.tz);
      const st = this.risk.markets[m.key];
      if ((st?.day === day && st.done) || isHolidayPause(day)) return false;
      const lastEntry = m.open + ENTRY_HOURS * 60;
      return mod < lastEntry && m.open - mod <= WAKE_AHEAD_MIN;
    });
  }

  async tick() {
    const now = this.now();
    await this.checkRisk();
    const positions = await this.client.openPositions();
    for (const m of this.markets) {
      try {
        await this.step(m, now, positions.filter((p) => p.epic === this.epics[m.key]));
      } catch (e) {
        if (e.code === 'UNKNOWN_ORDER_STATE') {
          // Until a human checks, any new order could double the position.
          this.stopped = true;
          this.log('Nu știu dacă ordinul a intrat. Verifică pozițiile în IG și repornește bot-ul.');
        } else {
          this.log(`Eroare la ${m.name}: ${e.message}`);
        }
        if (e.fatal) throw e;
      }
    }
    if (now - (this.lastBeat ?? -Infinity) >= this.heartbeatMs) this.heartbeat(now);
  }

  async step(m, now, positions) {
    const { day, mod } = localClock(now, m.tz);
    const live = m.live;
    let st = this.risk.markets[m.key];
    if (st?.day !== day) {
      st = this.risk.markets[m.key] = { day, done: false };
      delete this.builders[m.key];
    }

    // Day trading only: nothing is held outside the session.
    if (mod >= m.close || mod < m.open) {
      for (const p of positions) {
        await this.client.closePosition(p);
        this.log(`Închis ${m.name} ${p.direction} ${p.size} (sesiunea s-a încheiat).`);
      }
      return;
    }
    if (st.done || this.risk.halted || this.stopped) return;
    if (!st.open && !positions.length && isHolidayPause(day)) return this.finish(st, m, 'pauză de sărbători (24 decembrie – 2 ianuarie).');
    const rangeEnd = m.open + live.rangeMin;
    const lastEntry = m.open + ENTRY_HOURS * 60;
    if (mod < rangeEnd) return;
    if (st.open) {
      if (positions.length) return; // the trade is still running
      await this.closed(m, st);
      if (st.done) return;
    }
    if (mod >= lastEntry) {
      if (st.trades) { st.done = true; this.state.save(this.risk); return; }
      return this.finish(st, m, `fereastra de intrare s-a încheiat fără semnal.`);
    }

    if (!st.range) {
      // The range comes from IG's 1-minute candles (more exact than polled prices).
      const count = Math.min(mod - m.open + 2, ENTRY_HOURS * 60 + 2);
      const bars = (await this.client.candles(this.epics[m.key], 'MINUTE', count))
        .map((c) => ({ ...c, ...localClock(c.time, m.tz) }))
        .filter((c) => c.day === day && c.time + MIN <= now);
      const inRange = bars.filter((c) => c.mod >= m.open && c.mod < rangeEnd);
      if (inRange.length < live.rangeMin / 2) return this.finish(st, m, `prea puține date în intervalul de deschidere.`);
      const hi = Math.max(...inRange.map((c) => c.high));
      const lo = Math.min(...inRange.map((c) => c.low));
      // A late start must not trade a breakout that already happened.
      if (bars.some((c) => c.mod >= rangeEnd && (c.close > hi || c.close < lo))) {
        return this.finish(st, m, `ruperea intervalului a avut loc înainte să pornesc.`);
      }
      st.range = { hi, lo };
      this.state.save(this.risk);
      this.log(`${m.name}: interval ${lo}–${hi}. Aștept o închidere de minut în afara lui.`);
    }

    const q = await this.client.market(this.epics[m.key]);
    this.info[m.key] = { ...this.info[m.key], ...q };
    if (q.status !== 'TRADEABLE' || q.bid == null || q.offer == null) return;
    const spread = q.offer - q.bid;
    if (st.range.hi - st.range.lo < 4 * spread) {
      return this.finish(st, m, `interval prea mic față de spread (${spread}).`);
    }
    let b = this.builders[m.key];
    if (!b) {
      // The first live minute is seen only part way through: skip it.
      b = this.builders[m.key] = { closed: [], skipBefore: Math.floor(now / MIN) * MIN + MIN };
      b.builder = new CandleBuilder(MIN, (c) => b.closed.push(c));
    }
    b.builder.flush(now);
    b.builder.push({ time: now, price: (q.bid + q.offer) / 2 });
    const closed = b.closed.splice(0).filter((c) => c.time >= b.skipBefore && now - c.time <= 3 * MIN);
    for (const c of closed) {
      const side = c.close > st.range.hi ? 'BUY' : c.close < st.range.lo ? 'SELL' : null;
      if (!side) {
        st.armed = true; // back inside the range: the next breakout counts
        continue;
      }
      if (st.trades && !st.armed) continue;
      await this.enter(m, st, side, q);
      return;
    }
  }

  // A position the bot opened is gone (stop, target or closed by hand). IG does not say
  // which here, so a trade counts as lost when the price is on the losing side of the entry.
  async closed(m, st) {
    const q = await this.client.market(this.epics[m.key]);
    const mid = (q.bid + q.offer) / 2;
    const lost = !Number.isFinite(mid) || (mid - st.open.level) * (st.open.side === 'BUY' ? 1 : -1) <= 0;
    if (lost) st.losses = (st.losses ?? 0) + 1;
    st.open = null;
    st.armed = false;
    this.state.save(this.risk);
    if (st.losses >= MAX_LOSSES) {
      st.done = true;
      this.state.save(this.risk);
      this.log(`${m.name}: ${MAX_LOSSES} pierderi azi, mă opresc pe această piață până mâine.`);
    } else if (st.trades >= MAX_TRADES) {
      st.done = true;
      this.state.save(this.risk);
      this.log(`${m.name}: ${MAX_TRADES} tranzacții azi, mă opresc pe această piață până mâine.`);
    }
  }

  async enter(m, st, side, q) {
    const info = this.info[m.key];
    const entry = side === 'BUY' ? q.offer : q.bid;
    const stopLevel = side === 'BUY' ? st.range.lo : st.range.hi;
    const dist = (entry - stopLevel) * (side === 'BUY' ? 1 : -1);
    if (!(dist > 0)) return this.finish(st, m, `prețul a trecut deja de nivelul de stop.`);
    // Spread bet: distances are in price units and the stake is per point in account currency.
    // CFD: distances in points (price × scaling), one contract moves pointValue (market
    // currency) per point, and notional = contracts × contract size × price.
    const cfd = info.expiry === '-';
    const scale = cfd ? info.scaling : 1;
    const perPoint = cfd ? info.pointValue * info.toAccount : 1;
    const round = cfd ? (n) => Math.round(n * 10) / 10 : (n) => this.round(n, info);
    const stopDistance = round(Math.max(dist * scale, info.minStop));
    const limitDistance = m.live.targetR ? round(Math.max(dist * scale * m.live.targetR, info.minStop)) : undefined;
    const risk = this.tradeRisk();
    let size = Math.floor((risk / (stopDistance * perPoint)) * 100) / 100;
    if (size < info.minSize) {
      // The smallest allowed size may risk a bit more than planned, but never over double.
      if (info.minSize * stopDistance * perPoint > 2 * risk) {
        return this.finish(st, m, `stopul e prea larg pentru riscul ales.`);
      }
      size = info.minSize;
    }
    if (await this.checkRisk()) return;
    if (info.marginPct > 0 && this.client.available) {
      const value = cfd ? size * info.contractSize * entry * info.toAccount : size * entry;
      const need = value * info.marginPct / 100;
      const free = await this.client.available();
      if (need > free) return this.finish(st, m, `marjă insuficientă (trebuie ≈ ${need.toFixed(0)}, disponibil ${free.toFixed(0)}).`);
    }
    // Saved before sending: after a crash the bot treats the order as placed, never sends it twice.
    st.open = { side, level: entry };
    st.trades = (st.trades ?? 0) + 1;
    this.state.save(this.risk);
    let res;
    try {
      res = await this.client.openMarket({
        epic: this.epics[m.key], expiry: info.expiry, direction: side, size, currency: info.currency, stopDistance, limitDistance,
      });
    } catch (e) {
      if (/INSUFFICIENT_FUNDS/.test(e.message)) return this.finish(st, m, 'IG a refuzat ordinul: fonduri insuficiente pentru marjă.');
      throw e;
    }
    st.traded = true;
    st.open.level = res.level ?? entry;
    this.state.save(this.risk);
    this.log(`Deschis ${m.name} ${side} ${size} la ${res.level}, stop ${stopDistance}, țintă ${limitDistance ?? 'fără (închid la sfârșitul sesiunii)'}. Risc ≈ ${(size * stopDistance * perPoint).toFixed(2)}.`);
  }

  finish(st, m, reason) {
    st.done = true;
    this.state.save(this.risk);
    this.log(`Azi fără tranzacție pe ${m.name}: ${reason}`);
  }

  round(n, info) {
    const f = 10 ** (info.decimals ?? 2);
    return Math.round(n * f) / f;
  }

  // Returns true when trading must stop. The day follows Romanian time, so the night
  // (Sydney) and morning (London) sessions share one loss limit.
  async checkRisk() {
    const today = tradingDay(this.now(), 'Europe/Bucharest');
    const equity = await this.client.equity();
    this.equity = equity;
    if (this.risk.day !== today) {
      this.risk = { day: today, dayStartEquity: equity, halted: false, markets: this.risk.markets ?? {} };
      this.state.save(this.risk);
    }
    const limit = this.dailyLimit();
    if (!this.risk.halted && this.risk.dayStartEquity - equity >= limit) {
      this.risk.halted = true;
      this.state.save(this.risk);
      this.log(`Pierderea zilei a atins ${limit}. Închid pozițiile și nu mai tranzacționez azi.`);
      const epics = new Set(Object.values(this.epics ?? {}));
      for (const p of await this.client.openPositions()) if (epics.has(p.epic)) await this.client.closePosition(p);
    }
    return this.risk.halted;
  }

  heartbeat(now) {
    this.lastBeat = now;
    const pnl = this.equity - this.risk.dayStartEquity;
    const parts = this.markets.map((m) => {
      const st = this.risk.markets[m.key] ?? {};
      const { mod } = localClock(now, m.tz);
      const what = st.traded ? 'a tranzacționat azi' : st.done ? 'gata pe azi'
        : mod < m.open || mod >= m.close ? 'sesiunea e închisă' : mod < m.open + m.live.rangeMin ? 'formez intervalul' : st.range ? 'aștept ruperea intervalului' : 'formez intervalul';
      return `${m.name}: ${what}`;
    });
    this.log(`Activ. Azi rezultat ${Number.isFinite(pnl) ? pnl.toFixed(2) : '-'}. ${parts.join('; ')}.`);
  }
}
