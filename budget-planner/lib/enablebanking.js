// Minimal Enable Banking (PSD2 open banking) client.
// Enable Banking is free for linking your *own* accounts ("restricted"
// production mode) and covers Romanian banks: Banca Transilvania, BCR, BRD,
// ING, Raiffeisen, CEC, UniCredit, Revolut and more.
// Docs: https://enablebanking.com/docs/api/reference/

import { createSign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { round2 } from '../public/js/shared/money.js';

const DEFAULT_API = 'https://api.enablebanking.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export class EnableBanking {
  constructor({ appId, privateKeyPath, privateKey, apiBase = DEFAULT_API }) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.appId = appId;
    this.privateKeyPath = privateKeyPath;
    this.privateKey = privateKey;
  }

  get configured() {
    return Boolean(this.appId && (this.privateKey || this.privateKeyPath));
  }

  async key() {
    if (!this.privateKey) this.privateKey = await fs.readFile(this.privateKeyPath, 'utf8');
    return this.privateKey;
  }

  async jwt() {
    const iat = Math.floor(Date.now() / 1000);
    const header = { typ: 'JWT', alg: 'RS256', kid: this.appId };
    const body = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(await this.key(), 'base64url');
    return `${unsigned}.${signature}`;
  }

  async request(method, path, { query, body } = {}) {
    if (!this.configured) throw new Error('Bank sync is not configured (set EB_APP_ID and EB_PRIVATE_KEY_PATH).');
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.jwt()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      // A stalled bank request must not leave the sync "running" forever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.detail || data?.error || res.statusText;
      const err = new Error(`Bank API ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async listBanks(country = 'RO') {
    const data = await this.request('GET', '/aspsps', { query: { country, psu_type: 'personal' } });
    return (data.aspsps || []).map((a) => ({
      name: a.name,
      country: a.country,
      logo: a.logo,
      maxConsentDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : null,
    }));
  }

  async startAuth({ bank, country = 'RO', redirectUrl, state, days = 90 }) {
    const validUntil = new Date(Date.now() + days * 86400 * 1000).toISOString();
    return this.request('POST', '/auth', {
      body: {
        access: { valid_until: validUntil },
        aspsp: { name: bank, country },
        state,
        redirect_url: redirectUrl,
        psu_type: 'personal',
      },
    });
  }

  async createSession(code) {
    return this.request('POST', '/sessions', { body: { code } });
  }

  async deleteSession(sessionId) {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async accountDetails(accountUid) {
    return this.request('GET', `/accounts/${encodeURIComponent(accountUid)}/details`);
  }

  async balances(accountUid) {
    const data = await this.request('GET', `/accounts/${encodeURIComponent(accountUid)}/balances`);
    return data.balances || [];
  }

  // Returns the transactions; `.truncated` is true when the page limit was hit
  // and more pages remain, so the caller knows the list is incomplete.
  async transactions(accountUid, dateFrom) {
    const all = [];
    let continuationKey;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.request('GET', `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
        query: { date_from: dateFrom, continuation_key: continuationKey },
      });
      all.push(...(data.transactions || []));
      continuationKey = data.continuation_key;
      if (!continuationKey) break;
    }
    all.truncated = Boolean(continuationKey);
    return all;
  }
}

/**
 * What identifies a stored account across bank links (a new consent gives the
 * same account a new uid): normalised IBAN, Enable Banking identification
 * hashes, and the last 4 digits of a masked card number.
 */
export function accountIdentity(a = {}) {
  const iban = String(a.iban || '').replace(/\s/g, '').toUpperCase() || null;
  const hashes = [a.identificationHash, ...(Array.isArray(a.identificationHashes) ? a.identificationHashes : [])]
    .filter((h) => typeof h === 'string' && h);
  const panLast4 = String(a.maskedPan || '').match(/(\d{4})\s*$/)?.[1] || null;
  return { iban, hashes: [...new Set(hashes)], panLast4 };
}

// Pick the most useful balance: booked/closing first, then available.
// Balances without a usable amount are ignored.
export function pickBalance(balances) {
  const order = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD', 'PRCD'];
  const sorted = (balances || [])
    .filter((b) => Number.isFinite(Number.parseFloat(b?.balance_amount?.amount)))
    .sort((a, b) => {
      const ia = order.indexOf(a.balance_type); const ib = order.indexOf(b.balance_type);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  const b = sorted[0];
  if (!b) return null;
  return {
    amount: round2(b.balance_amount.amount),
    currency: b.balance_amount?.currency,
    type: b.balance_type,
    creditLimitIncluded: Boolean(b.credit_limit_included),
  };
}
