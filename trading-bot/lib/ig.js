// Minimal IG REST client. Demo only: the live endpoint is refused on purpose.
// Docs: https://labs.ig.com/rest-trading-api-reference

export const DEMO_URL = 'https://demo-api.ig.com/gateway/deal';

export class IgClient {
  constructor({ apiKey, identifier, password, baseUrl = DEMO_URL, fetchImpl = globalThis.fetch }) {
    if (baseUrl !== DEMO_URL) throw new Error('Only the IG demo API is allowed');
    if (!apiKey || !identifier || !password) throw new Error('IG_API_KEY, IG_USERNAME and IG_PASSWORD are required');
    this.apiKey = apiKey;
    this.identifier = identifier;
    this.password = password;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.tokens = null;
  }

  async request(method, path, { version = 1, body, retry = true } = {}) {
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
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (res.status === 401 && retry && path !== '/session') {
      await this.login();
      return this.request(method, path, { version, body, retry: false });
    }
    if (!res.ok) throw new Error(`IG ${method} ${path} -> ${res.status} ${data.errorCode ?? text}`);
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
    };
  }

  // Historical candles (mid prices). Counts against IG's weekly data allowance.
  async candles(epic, resolution, max) {
    const q = new URLSearchParams({ resolution, max: String(max), pageSize: '0' });
    const { data } = await this.request('GET', `/prices/${encodeURIComponent(epic)}?${q}`, { version: 3 });
    const mid = (p) => (p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : p.bid ?? p.ask);
    return (data.prices ?? []).map((p) => ({
      time: Date.parse(p.snapshotTimeUTC + 'Z'),
      open: mid(p.openPrice),
      high: mid(p.highPrice),
      low: mid(p.lowPrice),
      close: mid(p.closePrice),
    }));
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
    const { data } = await this.request('POST', '/positions/otc', {
      version: 2,
      body: {
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
    return this.confirm(data.dealReference);
  }

  async closePosition({ dealId, direction, size }) {
    const { data } = await this.request('DELETE', '/positions/otc', {
      version: 1,
      body: { dealId, direction: direction === 'BUY' ? 'SELL' : 'BUY', size, orderType: 'MARKET' },
    });
    return this.confirm(data.dealReference);
  }

  async confirm(dealReference) {
    const { data } = await this.request('GET', `/confirms/${encodeURIComponent(dealReference)}`);
    if (data.dealStatus !== 'ACCEPTED') throw new Error(`Order rejected: ${data.reason ?? data.dealStatus}`);
    return data;
  }
}
