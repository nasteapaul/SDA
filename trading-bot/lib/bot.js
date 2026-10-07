import { CandleBuilder } from './candles.js';
import { emaCrossSignals } from './strategy.js';
import { StateStore, tradingDay } from './state.js';

export const RESOLUTIONS = Object.freeze({ MINUTE: 60e3, MINUTE_5: 300e3, MINUTE_15: 900e3, HOUR: 3600e3 });

// Polls the market price, builds candles, and on every closed candle runs the strategy.
// One position at a time, always with a stop. The daily loss limit is checked on every
// poll, survives restarts (state file) and closes open positions when hit.
export class Bot {
  constructor({ client, epic, resolution = 'MINUTE_5', size, maxDailyLoss, strategy = {}, state = new StateStore(null), log = console.log, now = Date.now }) {
    if (!RESOLUTIONS[resolution]) throw new Error(`Unknown resolution ${resolution}`);
    if (!(size > 0)) throw new Error('BOT_SIZE must be > 0');
    if (!(maxDailyLoss > 0)) throw new Error('BOT_MAX_DAILY_LOSS must be > 0');
    Object.assign(this, { client, epic, resolution, size, maxDailyLoss, strategy, state, log, now });
    this.periodMs = RESOLUTIONS[resolution];
    this.candles = [];
    this.pending = [];
    this.builder = new CandleBuilder(this.periodMs, (c) => this.onCandle(c));
    this.risk = { day: null, dayStartEquity: null, halted: false, ...state.load() };
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
    const sig = emaCrossSignals(this.candles, this.strategy).at(-1);
    if (!sig?.side) return;
    const open = await this.client.openPositions(this.epic);
    if (open.some((p) => p.direction === sig.side)) return;
    for (const p of open) {
      await this.client.closePosition(p);
      this.log(`Închis ${p.direction} ${p.size} (semnal invers).`);
    }
    if (await this.checkRisk()) return;
    const stopDistance = this.points(Math.max(sig.stopDist, this.market.minStop));
    const limitDistance = this.points(Math.max(sig.targetDist, this.market.minStop));
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
      this.log(`Deschis ${sig.side} ${this.size} la ${res.level}, stop ${stopDistance}, țintă ${limitDistance}. ${sig.reason}`);
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
    if (this.risk.day !== today) {
      this.risk = { day: today, dayStartEquity: equity, halted: false };
      this.state.save(this.risk);
    }
    if (!this.risk.halted && this.risk.dayStartEquity - equity >= this.maxDailyLoss) {
      this.halt(`Pierderea zilei a atins ${this.maxDailyLoss}. Închid pozițiile și nu mai tranzacționez azi.`);
      for (const p of await this.client.openPositions(this.epic)) await this.client.closePosition(p);
    }
    return this.risk.halted;
  }

  halt(message) {
    this.risk.halted = true;
    this.state.save(this.risk);
    this.log(message);
  }
}
