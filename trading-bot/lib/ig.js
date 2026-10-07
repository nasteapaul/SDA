// Minimal IG REST client. Demo only: the live endpoint is refused on purpose.
// Docs: https://labs.ig.com/rest-trading-api-reference

import { randomUUID } from 'node:crypto';
import { validateCandle } from './candles.js';

export const DEMO_URL = 'https://demo-api.ig.com/gateway/deal';

// Login problems that retrying would only make worse (IG locks the account after repeated failures).
const FATAL_CODES = /^error\.security\.(invalid-details|account-suspended|account-migrated|client-suspended)|^error\.public-api\.failure\.(stockbroking-not-supported|kyc)/;

export class IgError extends Error {
  constructor(message, { status, code, fatal = false } = {}) {
    super(message);
    Object.assign(this, { status, code, fatal });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IgClient {
  constructor({ apiKey, identifier, password, baseUrl = DEMO_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000, wait = sleep }) {
    if (baseUrl !== DEMO_URL) throw new Error('Only the IG demo API is allowed');
    if (!apiKey || !identifier || !password) throw new Error('IG_API_KEY, IG_USERNAME and IG_PASSWORD are required');
    this.apiKey = apiKey;
    this.identifier = identifier;
    this.password = password;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.wait = wait;
    this.tokens = null;
    this.locked = null;
  }

  async request(method, path, { version = 1, body, retry = true } = {}) {
    if (this.locked) throw this.locked;
    const headers = {
      'X-IG-API-KEY': this.apiKey,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json; charset=UTF-8',
      Version: String(version),
    };
    if (this.tokens) {
      headers.CST = this.tokens.cst;
      headers['X-SECURITY-TOKEN'] = this.tokens.xst;
    }
    // IG takes DELETE bodies via POST + _method override.
    let httpMethod = method;
    if (method === 'DELETE' && body) {
      httpMethod = 'POST';
      headers._method = 'DELETE';
    }
    const res = await this.fetch(this.baseUrl + path, {
      method: httpMethod,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Gateway errors (502/503) come back as HTML.
    }
    if (res.status === 401 && retry && path !== '/session') {
      await this.login();
      return this.request(method, path, { version, body, retry: false });
    }
    if (!res.ok) {
      const code = data.errorCode ?? '';
      const err = new IgError(`IG ${method} ${path} -> ${res.status} ${code || text.slice(0, 120)}`, {
        status: res.status,
        code,
        fatal: FATAL_CODES.test(code),
      });
      if (err.fatal) this.locked = err;
      throw err;
    }
    return { data, headers: res.headers };
  }

  async login() {
    this.tokens = null;
    const { data, headers } = await this.request('POST', '/session', {
      version: 2,
      body: { identifier: this.identifier, password: this.password },
    });
    this.tokens = { cst: headers.get('CST'), xst: headers.get('X-SECURITY-TOKEN') };
    if (!this.tokens.cst || !this.tokens.xst) throw new Error('IG login returned no session tokens');
    this.accountId = data.currentAccountId;
    return data;
  }

  async market(epic) {
    const { data } = await this.request('GET', `/markets/${encodeURIComponent(epic)}`, { version: 3 });
    return {
      bid: data.snapshot?.bid,
      offer: data.snapshot?.offer,
      status: data.snapshot?.marketStatus,
      currency: data.instrument?.currencies?.find((c) => c.isDefault)?.code ?? data.instrument?.currencies?.[0]?.code,
      minSize: data.dealingRules?.minDealSize?.value ?? 0,
      minStop: data.dealingRules?.minNormalStopOrLimitDistance?.value ?? 0,
      minStopUnit: data.dealingRules?.minNormalStopOrLimitDistance?.unit ?? 'POINTS',
      decimals: decimalsOf(data.snapshot?.decimalPlacesFactor),
    };
  }

  // Historical candles (mid prices). Counts against IG's weekly data allowance.
  async candles(epic, resolution, max) {
    const q = new URLSearchParams({ resolution, max: String(max), pageSize: '0' });
    const { data } = await this.request('GET', `/prices/${encodeURIComponent(epic)}?${q}`, { version: 3 });
    const mid = (p = {}) => (p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : p.bid ?? p.ask);
    return (data.prices ?? []).map((p) => ({
      time: parseUtc(p.snapshotTimeUTC),
      open: mid(p.openPrice),
      high: mid(p.highPrice),
      low: mid(p.lowPrice),
      close: mid(p.closePrice ?? {}),
    })).filter(validateCandle);
  }

  // Balance plus open profit/loss of the current account.
  async equity() {
    const { data } = await this.request('GET', '/accounts');
    const acc = data.accounts?.find((a) => a.accountId === this.accountId) ?? data.accounts?.find((a) => a.preferred);
    if (!acc) throw new Error('IG account not found');
    return acc.balance.balance + acc.balance.profitLoss;
  }

  async openPositions(epic) {
    const { data } = await this.request('GET', '/positions', { version: 2 });
    return (data.positions ?? [])
      .filter((p) => !epic || p.market?.epic === epic)
      .map((p) => ({ dealId: p.position.dealId, direction: p.position.direction, size: p.position.size }));
  }

  // Market order with a mandatory stop. Distances are in the market's points.
  async openMarket({ epic, direction, size, currency, stopDistance, limitDistance }) {
    if (!(stopDistance > 0)) throw new Error('A stop distance is required for every order');
    // Our own reference lets us find the deal if the response is lost. Never re-send a trade.
    const dealReference = `bot-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    try {
      await this.request('POST', '/positions/otc', {
        version: 2,
        body: {
          dealReference,
        epic,
        expiry: '-',
        direction,
        size,
        orderType: 'MARKET',
        currencyCode: currency,
        forceOpen: true,
        guaranteedStop: false,
          stopDistance,
          limitDistance,
        },
      });
    } catch (e) {
      // A clear 4xx means IG refused it; anything else (timeout, 5xx) may still have opened it.
      if (e.status >= 400 && e.status < 500) throw e;
      const found = await this.confirm(dealReference).catch(() => null);
      if (found) return found;
      throw new IgError(`Order state unknown (${e.message}); check positions before trading again`, { code: 'UNKNOWN_ORDER_STATE' });
    }
    return this.confirm(dealReference);
  }

  async closePosition({ dealId, direction, size }) {
    const { data } = await this.request('DELETE', '/positions/otc', {
      version: 1,
      body: { dealId, direction: direction === 'BUY' ? 'SELL' : 'BUY', size, orderType: 'MARKET' },
    });
    return this.confirm(data.dealReference);
  }

  // IG may answer 404 for a moment before the confirmation exists.
  async confirm(dealReference, attempts = 4) {
    let data;
    for (let i = 1; ; i++) {
      try {
        ({ data } = await this.request('GET', `/confirms/${encodeURIComponent(dealReference)}`));
        break;
      } catch (e) {
        if (i >= attempts || (e.status && e.status !== 404 && e.status < 500)) throw e;
        await this.wait(500 * i);
      }
    }
    if (data.dealStatus !== 'ACCEPTED') throw new Error(`Order rejected: ${data.reason ?? data.dealStatus}`);
    return data;
  }
}

// IG sends times like 2026-10-07T09:00:00 (UTC, no zone); accept a zone if present.
function parseUtc(s) {
  if (typeof s !== 'string') return NaN;
  const iso = s.replace(/\//g, '-').replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

function decimalsOf(factor) {
  const n = Number(factor);
  return Number.isFinite(n) && n >= 1 ? Math.round(Math.log10(n)) : 2;
}
