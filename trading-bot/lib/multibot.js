import { CandleBuilder } from './candles.js';
import { StateStore, tradingDay } from './state.js';
import { localClock } from './session.js';

const MIN = 60e3;
const ENTRY_HOURS = 3; // entries allowed for 3 hours after the session open
const WAKE_AHEAD_MIN = 240; // a run waits at most this long for a session to open

// Opening range breakout on several IG markets, each in its own session (lib/markets.js,
// field `live`). Per market and local day: the high/low of the first `rangeMin` minutes
// after the open, then the first 1-minute close beyond it enters, with the stop at the
// other side of the range and an optional target in R, both placed at IG. One trade per
// market per day; positions are closed once the market's session is over. Each trade risks
// `riskPerTrade` (account currency). A shared daily loss limit stops everything.
export class MultiBot {
  constructor({
    client, markets, riskPerTrade, maxDailyLoss, state = new StateStore(null),
    log = console.log, now = Date.now, heartbeatMs = 30 * MIN,
  }) {
    if (!markets?.length) throw new Error('No markets to trade');
    if (!(riskPerTrade > 0)) throw new Error('BOT_RISK_PER_TRADE must be > 0');
    if (!(maxDailyLoss > 0)) throw new Error('BOT_MAX_DAILY_LOSS must be > 0');
    for (const m of markets) {
      if (!m.live?.epic || !(m.live.rangeMin > 0)) throw new Error(`Market ${m.key} has no live settings`);
    }
    Object.assign(this, { client, markets, riskPerTrade, maxDailyLoss, state, log, now, heartbeatMs });
    this.info = {};
    this.builders = {};
    this.risk = { day: null, dayStartEquity: null, halted: false, markets: {}, ...state.load() };
    this.risk.markets ??= {};
  }

  async start() {
    await this.client.login();
    for (const m of this.markets) {
      const info = await this.client.market(m.live.epic);
      if (info.minStopUnit !== 'POINTS') throw new Error(`Unsupported stop unit ${info.minStopUnit} on ${m.live.epic}`);
      this.info[m.key] = info;
    }
    await this.checkRisk();
    this.log(`Pornit pe ${this.markets.map((m) => m.name).join(', ')}. Risc pe tranzacție ${this.riskPerTrade}, pierdere maximă pe zi ${this.maxDailyLoss}.`);
  }

  // True while some market still has a session to trade within the next few hours.
  hasWork(now = this.now()) {
    if (this.risk.halted || this.stopped) return false;
    return this.markets.some((m) => {
      const { day, mod } = localClock(now, m.tz);
      const st = this.risk.markets[m.key];
      if (st?.day === day && st.done) return false;
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
        await this.step(m, now, positions.filter((p) => p.epic === m.live.epic));
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
    const rangeEnd = m.open + live.rangeMin;
    const lastEntry = m.open + ENTRY_HOURS * 60;
    if (mod < rangeEnd) return;
    if (mod >= lastEntry) return this.finish(st, m, `fereastra de intrare s-a încheiat fără semnal.`);

    if (!st.range) {
      // The range comes from IG's 1-minute candles (more exact than polled prices).
      const count = Math.min(mod - m.open + 2, ENTRY_HOURS * 60 + 2);
      const bars = (await this.client.candles(live.epic, 'MINUTE', count))
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

    const q = await this.client.market(live.epic);
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
      if (!side) continue;
      await this.enter(m, st, side, q);
      return;
    }
  }

  async enter(m, st, side, q) {
    const info = this.info[m.key];
    const entry = side === 'BUY' ? q.offer : q.bid;
    const stopLevel = side === 'BUY' ? st.range.lo : st.range.hi;
    const dist = (entry - stopLevel) * (side === 'BUY' ? 1 : -1);
    if (!(dist > 0)) return this.finish(st, m, `prețul a trecut deja de nivelul de stop.`);
    const stopDistance = this.round(Math.max(dist, info.minStop), info);
    const limitDistance = m.live.targetR ? this.round(Math.max(dist * m.live.targetR, info.minStop), info) : undefined;
    let size = Math.floor((this.riskPerTrade / stopDistance) * 100) / 100;
    if (size < info.minSize) {
      // The smallest allowed bet may risk a bit more than planned, but never over double.
      if (info.minSize * stopDistance > 2 * this.riskPerTrade) {
        return this.finish(st, m, `stopul e prea larg pentru riscul ales.`);
      }
      size = info.minSize;
    }
    if (await this.checkRisk()) return;
    st.done = true; // set before sending, so a crash never sends a second order today
    this.state.save(this.risk);
    const res = await this.client.openMarket({
      epic: m.live.epic, expiry: info.expiry, direction: side, size, currency: info.currency, stopDistance, limitDistance,
    });
    st.traded = true;
    this.state.save(this.risk);
    this.log(`Deschis ${m.name} ${side} ${size} la ${res.level}, stop ${stopDistance}, țintă ${limitDistance ?? 'fără (închid la sfârșitul sesiunii)'}. Risc ≈ ${(size * stopDistance).toFixed(2)}.`);
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
    if (!this.risk.halted && this.risk.dayStartEquity - equity >= this.maxDailyLoss) {
      this.risk.halted = true;
      this.state.save(this.risk);
      this.log(`Pierderea zilei a atins ${this.maxDailyLoss}. Închid pozițiile și nu mai tranzacționez azi.`);
      const epics = new Set(this.markets.map((m) => m.live.epic));
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
