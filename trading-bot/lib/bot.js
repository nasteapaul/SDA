import { CandleBuilder } from './candles.js';
import { emaCrossSignals } from './strategy.js';
import { StateStore, tradingDay } from './state.js';
import { berlinClock, hhmm } from './session.js';

export const RESOLUTIONS = Object.freeze({ MINUTE: 60e3, MINUTE_5: 300e3, MINUTE_15: 900e3, HOUR: 3600e3 });

// Polls the market price, builds candles, and on every closed candle asks `signal` for a
// trade. One position at a time, always with a stop. New trades only between tradeFrom and
// tradeUntil (Frankfurt time), everything closed at flatAt, at most maxTradesPerDay.
// The daily loss limit is checked on every poll, survives restarts (state file) and closes
// open positions when hit.
export class Bot {
  constructor({
    client, epic, resolution = 'MINUTE_5', size, maxDailyLoss, strategy = {}, signal,
    tradeFrom = '09:15', tradeUntil = '17:00', flatAt = '17:30', maxTradesPerDay = Infinity,
    state = new StateStore(null), log = console.log, now = Date.now, heartbeatMs = 5 * 60e3,
  }) {
    if (!RESOLUTIONS[resolution]) throw new Error(`Unknown resolution ${resolution}`);
    if (!(size > 0)) throw new Error('BOT_SIZE must be > 0');
    if (!(maxDailyLoss > 0)) throw new Error('BOT_MAX_DAILY_LOSS must be > 0');
    if (!(maxTradesPerDay >= 1)) throw new Error('maxTradesPerDay must be >= 1');
    Object.assign(this, { client, epic, resolution, size, maxDailyLoss, maxTradesPerDay, state, log, now, heartbeatMs });
    this.signal = signal ?? ((candles) => emaCrossSignals(candles, strategy).at(-1));
    this.tradeFrom = hhmm(tradeFrom);
    this.tradeUntil = hhmm(tradeUntil);
    this.flatAt = hhmm(flatAt);
    this.periodMs = RESOLUTIONS[resolution];
    this.candles = [];
    this.pending = [];
    this.builder = new CandleBuilder(this.periodMs, (c) => this.onCandle(c));
    this.risk = { day: null, dayStartEquity: null, halted: false, trades: 0, ...state.load() };
  }

  async start(historyCount = 100) {
    await this.client.login();
    this.market = await this.client.market(this.epic);
    if (this.market.minStopUnit !== 'POINTS') throw new Error(`Unsupported stop unit ${this.market.minStopUnit} on ${this.epic}`);
    if (this.size < this.market.minSize) throw new Error(`Size ${this.size} is below IG minimum ${this.market.minSize}`);
    const history = await this.client.candles(this.epic, this.resolution, historyCount);
    // IG includes the candle still in progress; it would be counted twice.
    while (history.length && history.at(-1).time + this.periodMs > this.now()) history.pop();
    this.candles = history;
    // The first live candle starts mid-period, so it is incomplete: skip it.
    this.skipBefore = Math.floor(this.now() / this.periodMs) * this.periodMs + this.periodMs;
    const open = await this.client.openPositions(this.epic);
    if (open.length) this.log(`Poziții deja deschise pe ${this.epic}: ${open.map((p) => `${p.direction} ${p.size}`).join(', ')}.`);
    await this.checkRisk();
    this.log(`Pornit pe ${this.epic} (${this.resolution}), ${this.candles.length} lumânări istorice.`);
  }

  async tick() {
    const m = await this.client.market(this.epic);
    this.market = m;
    const now = this.now();
    this.builder.flush(now);
    if (m.status === 'TRADEABLE' && m.bid != null && m.offer != null) {
      this.builder.push({ time: now, price: (m.bid + m.offer) / 2 });
    }
    await this.checkRisk();
    await this.flattenAfterHours(now);
    if (now - (this.lastBeat ?? -Infinity) >= this.heartbeatMs) this.heartbeat(now);
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) await p;
  }

  onCandle(c) {
    if (c.time < this.skipBefore) return;
    const last = this.candles.at(-1);
    if (last && c.time <= last.time) return;
    this.candles.push(c);
    if (this.candles.length > 500) this.candles.shift();
    this.pending.push(this.act(c).catch((e) => this.log(`Eroare: ${e.message}`)));
  }

  async act(candle) {
    if (this.risk.halted || this.stopped || this.market?.status !== 'TRADEABLE') return;
    // A candle that closed long ago (market was shut) is not a signal to act on now.
    if (this.now() - candle.time > 2 * this.periodMs) return;
    const { mod } = berlinClock(this.now());
    if (mod < this.tradeFrom || mod >= this.tradeUntil) return;
    if (this.risk.trades >= this.maxTradesPerDay) return;
    const sig = this.signal(this.candles);
    if (!sig?.side) return;
    const open = await this.client.openPositions(this.epic);
    if (open.some((p) => p.direction === sig.side)) return;
    for (const p of open) {
      await this.client.closePosition(p);
      this.log(`Închis ${p.direction} ${p.size} (semnal invers).`);
    }
    if (await this.checkRisk()) return;
    let { stopDist, targetDist } = sig;
    if (sig.stopLevel != null) {
      // Level-based signal: measure from the price we would actually get.
      const entry = sig.side === 'BUY' ? this.market.offer : this.market.bid;
      stopDist = (entry - sig.stopLevel) * (sig.side === 'BUY' ? 1 : -1);
      if (!(stopDist > 0)) return this.log('Prețul a trecut deja de nivelul de stop; sar peste semnal.');
      targetDist = sig.targetR ? stopDist * sig.targetR : undefined;
    }
    const stopDistance = this.points(Math.max(stopDist, this.market.minStop));
    const limitDistance = targetDist == null ? undefined : this.points(Math.max(targetDist, this.market.minStop));
    if (!(stopDistance > 0)) throw new Error('Stop distance rounded to zero; refusing to trade');
    try {
      const res = await this.client.openMarket({
        epic: this.epic,
        direction: sig.side,
        size: this.size,
        currency: this.market.currency,
        stopDistance,
        limitDistance,
      });
      this.risk.trades++;
      this.state.save(this.risk);
      this.log(`Deschis ${sig.side} ${this.size} la ${res.level}, stop ${stopDistance}, țintă ${limitDistance ?? 'fără'}. ${sig.reason}`);
    } catch (e) {
      if (e.code === 'UNKNOWN_ORDER_STATE') {
        // Until a human checks, any new order could double the position.
        this.stopped = true;
        this.log('Nu știu dacă ordinul a intrat. Verifică pozițiile în IG și repornește bot-ul.');
      }
      throw e;
    }
  }

  // Distances are sent in the market's price units, rounded to its decimals.
  points(n) {
    const f = 10 ** (this.market.decimals ?? 2);
    return Math.round(n * f) / f;
  }

  // Returns true when trading must stop. Resets at the start of each trading day.
  async checkRisk() {
    const today = tradingDay(this.now());
    const equity = await this.client.equity();
    this.equity = equity;
    if (this.risk.day !== today) {
      this.risk = { day: today, dayStartEquity: equity, halted: false, trades: 0 };
      this.state.save(this.risk);
    }
    if (!this.risk.halted && this.risk.dayStartEquity - equity >= this.maxDailyLoss) {
      this.halt(`Pierderea zilei a atins ${this.maxDailyLoss}. Închid pozițiile și nu mai tranzacționez azi.`);
      for (const p of await this.client.openPositions(this.epic)) await this.client.closePosition(p);
    }
    return this.risk.halted;
  }

  // Day trading only: nothing is held past flatAt (no overnight gaps or funding costs).
  async flattenAfterHours(now) {
    if (berlinClock(now).mod < this.flatAt) return;
    const open = await this.client.openPositions(this.epic);
    for (const p of open) {
      await this.client.closePosition(p);
      this.log(`Închis ${p.direction} ${p.size} (sfârșitul sesiunii).`);
    }
  }

  // Periodic status line so a quiet console still shows the bot is alive and why it waits.
  heartbeat(now) {
    this.lastBeat = now;
    const m = this.market ?? {};
    const pnl = this.equity - this.risk.dayStartEquity;
    const { mod } = berlinClock(now);
    let what = 'caut semnal';
    if (this.risk.halted) what = 'oprit pe azi (limita de pierdere)';
    else if (this.stopped) what = 'oprit, verifică pozițiile în IG';
    else if (m.status !== 'TRADEABLE') what = 'piața e închisă';
    else if (mod < this.tradeFrom) what = 'aștept începutul ferestrei de tranzacționare';
    else if (mod >= this.tradeUntil) what = 'nu mai deschid tranzacții azi';
    else if (this.risk.trades >= this.maxTradesPerDay) what = 'am făcut tranzacțiile zilei';
    this.log(`Activ. ${this.epic} ${m.bid ?? '-'}/${m.offer ?? '-'}. Azi: ${this.risk.trades} tranzacții, rezultat ${Number.isFinite(pnl) ? pnl.toFixed(2) : '-'} ${m.currency ?? ''}. Stare: ${what}.`);
  }

  halt(message) {
    this.risk.halted = true;
    this.state.save(this.risk);
    this.log(message);
  }
}
