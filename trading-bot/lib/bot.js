import { CandleBuilder } from './candles.js';
import { emaCrossSignals } from './strategy.js';

export const RESOLUTIONS = Object.freeze({ MINUTE: 60e3, MINUTE_5: 300e3, MINUTE_15: 900e3, HOUR: 3600e3 });

// Polls the market price, builds candles, and on every closed candle runs the strategy.
// One position at a time, always with a stop. Stops trading for the day after maxDailyLoss.
export class Bot {
  constructor({ client, epic, resolution = 'MINUTE_5', size, maxDailyLoss, strategy = {}, log = console.log, now = Date.now }) {
    if (!RESOLUTIONS[resolution]) throw new Error(`Unknown resolution ${resolution}`);
    if (!(size > 0)) throw new Error('BOT_SIZE must be > 0');
    if (!(maxDailyLoss > 0)) throw new Error('BOT_MAX_DAILY_LOSS must be > 0');
    Object.assign(this, { client, epic, resolution, size, maxDailyLoss, strategy, log, now });
    this.candles = [];
    this.builder = new CandleBuilder(RESOLUTIONS[resolution], (c) => this.onCandle(c));
    this.day = null;
    this.dayStartEquity = null;
    this.halted = false;
    this.busy = false;
  }

  async start(historyCount = 100) {
    await this.client.login();
    this.market = await this.client.market(this.epic);
    if (this.size < this.market.minSize) throw new Error(`Size ${this.size} is below IG minimum ${this.market.minSize}`);
    this.candles = await this.client.candles(this.epic, this.resolution, historyCount);
    await this.dailyLossHit();
    this.log(`Pornit pe ${this.epic} (${this.resolution}), ${this.candles.length} lumânări istorice.`);
  }

  async tick() {
    const m = await this.client.market(this.epic);
    if (m.status !== 'TRADEABLE' || m.bid == null || m.offer == null) return;
    this.market = m;
    this.builder.push({ time: this.now(), price: (m.bid + m.offer) / 2 });
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      await p;
    }
  }

  onCandle(c) {
    this.candles.push(c);
    if (this.candles.length > 500) this.candles.shift();
    this.pending = this.act().catch((e) => this.log(`Eroare: ${e.message}`));
  }

  async act() {
    if (this.halted || this.busy) return;
    this.busy = true;
    try {
      const sig = emaCrossSignals(this.candles, this.strategy).at(-1);
      if (!sig?.side) return;
      const open = await this.client.openPositions(this.epic);
      const same = open.find((p) => p.direction === sig.side);
      if (same) return;
      for (const p of open) {
        await this.client.closePosition(p);
        this.log(`Închis ${p.direction} ${p.size} (semnal invers).`);
      }
      if (await this.dailyLossHit()) return;
      const stopDistance = round(Math.max(sig.stopDist, this.market.minStop));
      const limitDistance = round(Math.max(sig.targetDist, this.market.minStop));
      const res = await this.client.openMarket({
        epic: this.epic,
        direction: sig.side,
        size: this.size,
        currency: this.market.currency,
        stopDistance,
        limitDistance,
      });
      this.log(`Deschis ${sig.side} ${this.size} la ${res.level}, stop ${stopDistance}, țintă ${limitDistance}. ${sig.reason}`);
    } finally {
      this.busy = false;
    }
  }

  async dailyLossHit() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const equity = await this.client.equity();
    if (this.day !== today) {
      this.day = today;
      this.dayStartEquity = equity;
    }
    if (this.dayStartEquity - equity >= this.maxDailyLoss) {
      this.halted = true;
      this.log(`Pierderea zilei a atins ${this.maxDailyLoss}. Bot-ul nu mai deschide poziții până la repornire.`);
      return true;
    }
    return false;
  }
}

const round = (n) => Math.round(n * 100) / 100;
