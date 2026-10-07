// Candles: { time (ms), open, high, low, close }.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateCandle(c) {
  if (!c || !isNum(c.time) || ![c.open, c.high, c.low, c.close].every(isNum)) return false;
  return c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close);
}

// CSV with header containing time,open,high,low,close (any order, extra columns ignored).
// time may be epoch ms, epoch s or an ISO date.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV needs a header and at least one row');
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const idx = {};
  for (const k of ['time', 'open', 'high', 'low', 'close']) {
    idx[k] = header.indexOf(k);
    if (idx[k] < 0) throw new Error(`CSV header missing column "${k}"`);
  }
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const c = {
      time: parseTime(cols[idx.time]),
      open: Number(cols[idx.open]),
      high: Number(cols[idx.high]),
      low: Number(cols[idx.low]),
      close: Number(cols[idx.close]),
    };
    if (!validateCandle(c)) throw new Error(`Invalid candle on line ${i + 1}`);
    candles.push(c);
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

function parseTime(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

// Builds candles of `periodMs` from ticks { time, price }. Ticks must be time-ordered.
export class CandleBuilder {
  constructor(periodMs, onClose) {
    if (!(periodMs > 0)) throw new Error('periodMs must be > 0');
    this.periodMs = periodMs;
    this.onClose = onClose;
    this.current = null;
  }

  // Closes the current candle once its period is over, even if no new tick arrived
  // (e.g. the market closed). Call it on every poll.
  flush(time) {
    if (this.current && time >= this.current.time + this.periodMs) {
      const c = this.current;
      this.current = null;
      this.onClose?.(c);
    }
  }

  push({ time, price }) {
    if (!isNum(time) || !isNum(price)) return;
    const start = Math.floor(time / this.periodMs) * this.periodMs;
    const c = this.current;
    if (c && start < c.time) return; // late tick, ignore
    if (c && start > c.time) {
      this.onClose?.(c);
      this.current = null;
    }
    if (!this.current) {
      this.current = { time: start, open: price, high: price, low: price, close: price };
    } else {
      const k = this.current;
      k.high = Math.max(k.high, price);
      k.low = Math.min(k.low, price);
      k.close = price;
    }
  }
}
