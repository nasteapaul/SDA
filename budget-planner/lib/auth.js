// Login sessions: each login gets a random token that expires and can be
// revoked (sign out). Only a hash of each token is kept on disk, so reading
// the sessions file doesn't hand out working tokens. Live updates
// (EventSource can't send headers) use short-lived single-use tickets instead
// of putting the real token in a URL.

import { promises as fs, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const DAY = 86400 * 1000;
const TICKET_MS = 60 * 1000;

const hash = (token) => createHash('sha256').update(String(token)).digest('hex');

export class Sessions {
  constructor(file, { days = 30, now = () => Date.now() } = {}) {
    this.file = file;
    this.ttl = days * DAY;
    this.now = now;
    this.sessions = new Map(); // hash → { createdAt, expiresAt }
    this.tickets = new Map(); // ticket → expiresAt
    try {
      for (const [h, s] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) this.sessions.set(h, s);
    } catch { /* no sessions yet */ }
  }

  async save() {
    this.prune();
    await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
  }

  prune() {
    const now = this.now();
    for (const [h, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(h);
    for (const [t, exp] of this.tickets) if (exp <= now) this.tickets.delete(t);
  }

  async create() {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.sessions.set(hash(token), { createdAt: now, expiresAt: now + this.ttl });
    await this.save();
    return { token, expiresAt: new Date(now + this.ttl).toISOString() };
  }

  valid(token) {
    if (!token) return false;
    const s = this.sessions.get(hash(token));
    return Boolean(s) && s.expiresAt > this.now();
  }

  async revoke(token) {
    if (this.sessions.delete(hash(token))) await this.save();
  }

  // Signs every device out (e.g. after changing the password).
  async revokeAll() {
    this.sessions.clear();
    await this.save();
  }

  ticket() {
    this.prune();
    const t = randomBytes(24).toString('base64url');
    this.tickets.set(t, this.now() + TICKET_MS);
    return t;
  }

  useTicket(t) {
    const exp = t && this.tickets.get(t);
    if (!exp) return false;
    this.tickets.delete(t);
    return exp > this.now();
  }
}

// Failed logins per IP over the last 15 minutes; old entries are dropped.
export class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000, maxIps = 10_000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, maxIps, now });
    this.attempts = new Map();
  }

  recent(ip) {
    const now = this.now();
    const list = (this.attempts.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.attempts.set(ip, list); else this.attempts.delete(ip);
    return list;
  }

  blocked(ip) {
    return this.recent(ip).length >= this.max;
  }

  fail(ip) {
    if (this.attempts.size >= this.maxIps) {
      for (const key of this.attempts.keys()) this.recent(key);
      if (this.attempts.size >= this.maxIps) this.attempts.delete(this.attempts.keys().next().value);
    }
    this.attempts.set(ip, [...this.recent(ip), this.now()]);
  }
}
