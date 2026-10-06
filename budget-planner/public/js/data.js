// Client data layer.
// - The server (on your home network) is the source of truth.
// - The last known state is cached locally so the app opens instantly and
//   works away from home; edits made offline are queued in an outbox and
//   replayed when the phone is back on the home Wi-Fi.
// - Replayed edits carry the version they were made on; if another device
//   changed or deleted the same transaction meanwhile, the server refuses it
//   (409) and the edit is dropped with a message instead of overwriting.
// - Server-sent events keep the phone and laptop in sync live.

const LS_STATE = 'bp.state';
const LS_OUTBOX = 'bp.outbox';
const LS_TOKEN = 'bp.token';

// Transaction fields the server keeps itself; never sent as "changes".
const TX_META = new Set(['id', 'createdAt', 'updatedAt', 'source', 'bankRef', 'importHash', 'batchId']);
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || ((a ?? '') === '' && (b ?? '') === '');

const CONFLICT_MESSAGES = {
  deleted: 'A change was not applied: this transaction was deleted on another device.',
  conflict: 'A change was not applied: this transaction was changed on another device in the meantime. Showing the latest version.',
};

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export class AuthError extends Error {}

export class Data extends EventTarget {
  constructor() {
    super();
    this.state = load(LS_STATE, null);
    this.outbox = load(LS_OUTBOX, []);
    this.token = load(LS_TOKEN, '');
    this.online = false;
    this.flushing = null;
    this.events = null;
    this.deletedHere = new Set(); // deleted from this device: "undo" restores them from the trash
  }

  get pending() { return this.outbox.length; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setToken(token) { this.token = token; save(LS_TOKEN, token); }

  async logout() {
    // Revoke the token on the server too, so a copy of it stops working.
    try { await this.fetch('/api/logout', { method: 'POST' }); } catch { /* offline: it expires on its own */ }
    this.setToken('');
    try { localStorage.removeItem(LS_STATE); } catch { /* ignore */ }
    this.events?.close();
    location.reload();
  }

  async fetch(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError(data.error || 'Login required');
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async login(password) {
    const { token } = await this.fetch('/api/login', { method: 'POST', body: { password } });
    this.setToken(token);
  }

  setOnline(v) {
    if (this.online !== v) { this.online = v; this.emit('status'); }
  }

  async refresh() {
    try {
      const state = await this.fetch('/api/state');
      this.setOnline(true);
      if (this.outbox.length) return; // let flush() finish first, it refreshes after
      this.state = state;
      save(LS_STATE, state);
      this.emit('change');
    } catch (err) {
      if (err instanceof AuthError) this.emit('auth');
      else this.setOnline(false);
    }
  }

  // Apply a change locally right away, then queue it for the server.
  mutate(op, applyLocally) {
    if (this.state && applyLocally) {
      applyLocally(this.state);
      save(LS_STATE, this.state);
      this.emit('change');
    }
    this.outbox.push(op);
    save(LS_OUTBOX, this.outbox);
    this.emit('status');
    return this.flush();
  }

  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.outbox.length) {
        const op = this.outbox[0];
        try {
          await this.fetch(op.path, { method: op.method, body: op.body });
          this.setOnline(true);
        } catch (err) {
          if (err instanceof AuthError) { this.emit('auth'); return; }
          if (err.status === 409) {
            // Changed or deleted on another device: drop it; the refresh below shows the server's copy.
            this.emit('error', CONFLICT_MESSAGES[err.data?.error] || CONFLICT_MESSAGES.conflict);
          } else if (err.status && err.status < 500) {
            // The server rejected it (invalid data) — drop it so the queue can't jam.
            this.emit('error', `Couldn't save a change: ${err.message}`);
          } else {
            this.setOnline(false);
            return;
          }
        }
        this.outbox.shift();
        save(LS_OUTBOX, this.outbox);
        this.emit('status');
      }
      await this.refresh();
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  // EventSource can't send the Authorization header, so it gets a one-time
  // ticket instead of the login token (which would end up in server logs).
  async connectLive() {
    if (!('EventSource' in window) || this.events || this.connecting) return;
    this.connecting = true;
    let ticket = '';
    try {
      if (this.token) ({ ticket } = await this.fetch('/api/events/ticket', { method: 'POST' }));
    } catch (err) {
      this.connecting = false;
      if (err instanceof AuthError) { this.emit('auth'); return; }
      this.setOnline(false);
      setTimeout(() => this.connectLive(), 10000);
      return;
    }
    this.connecting = false;
    if (this.events) return;
    const es = new EventSource(`/api/events${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`);
    this.events = es;
    es.addEventListener('change', (e) => {
      this.setOnline(true);
      const { updatedAt } = JSON.parse(e.data);
      if (!this.state || updatedAt !== this.state.updatedAt) {
        if (this.outbox.length) this.flush(); else this.refresh();
      }
    });
    es.onerror = () => {
      this.setOnline(false);
      es.close();
      this.events = null;
      setTimeout(() => this.connectLive(), 10000);
    };
  }

  // ---- high level operations ----
  // An edit of a known transaction sends only the fields that changed, with the
  // values and version (updatedAt) it was made on, so the server can tell a
  // stale edit from another device's newer change.
  upsertTransaction(t) {
    const path = `/api/transactions/${encodeURIComponent(t.id)}`;
    if (this.deletedHere.has(t.id)) {
      // Undo of a delete made here: bring back the original from the trash.
      this.deletedHere.delete(t.id);
      return this.mutate({ method: 'POST', path: `/api/trash/${encodeURIComponent(t.id)}/restore` }, (s) => {
        if (!s.transactions.some((x) => x.id === t.id)) s.transactions.push(t);
      });
    }
    const prev = this.state?.transactions?.find((x) => x.id === t.id);
    let body = t;
    if (prev) {
      body = { baseUpdatedAt: prev.updatedAt, base: {} };
      const changes = {};
      for (const [key, value] of Object.entries(t)) {
        if (TX_META.has(key) || sameValue(value, prev[key])) continue;
        changes[key] = value;
        body.base[key] = prev[key];
      }
      body = { ...changes, ...body };
    }
    return this.mutate({ method: 'PUT', path, body }, (s) => {
      const i = s.transactions.findIndex((x) => x.id === t.id);
      if (i === -1) s.transactions.push({ source: 'manual', ...t });
      else s.transactions[i] = { ...s.transactions[i], ...t };
    });
  }

  deleteTransaction(id) {
    this.deletedHere.add(id);
    return this.mutate({ method: 'DELETE', path: `/api/transactions/${encodeURIComponent(id)}` }, (s) => {
      s.transactions = s.transactions.filter((x) => x.id !== id);
    });
  }

  // Removed transactions (deleted or merged as duplicates), newest first.
  async trash() {
    return (await this.fetch('/api/trash')).trash;
  }

  restoreTransaction(id) {
    this.deletedHere.delete(id);
    return this.mutate({ method: 'POST', path: `/api/trash/${encodeURIComponent(id)}/restore` });
  }

  upsertGoal(g) {
    return this.mutate({ method: 'PUT', path: `/api/goals/${encodeURIComponent(g.id)}`, body: g }, (s) => {
      const i = s.goals.findIndex((x) => x.id === g.id);
      if (i === -1) s.goals.push(g); else s.goals[i] = { ...s.goals[i], ...g };
    });
  }

  deleteGoal(id) {
    return this.mutate({ method: 'DELETE', path: `/api/goals/${encodeURIComponent(id)}` }, (s) => {
      s.goals = s.goals.filter((x) => x.id !== id);
      for (const t of s.transactions) if (t.goalId === id) t.goalId = null;
    });
  }

  setBudgets(budgets) {
    return this.mutate({ method: 'PUT', path: '/api/budgets', body: { budgets } }, (s) => { s.budgets = budgets; });
  }

  setCategories(categories) {
    return this.mutate({ method: 'PUT', path: '/api/categories', body: { categories } }, (s) => { s.categories = categories; });
  }

  setSettings(settings) {
    return this.mutate({ method: 'PUT', path: '/api/settings', body: settings }, (s) => { s.settings = { ...s.settings, ...settings }; });
  }

  // replace: pattern of an existing rule this one supersedes (editing a rule).
  addRule(keyword, category, replace) {
    return this.mutate({ method: 'POST', path: '/api/rules', body: { keyword, category, apply: true, replace } });
  }

  recategorizeAll() {
    return this.mutate({ method: 'POST', path: '/api/recategorize' });
  }

  deleteRule(pattern) {
    return this.mutate({ method: 'DELETE', path: `/api/rules/${encodeURIComponent(pattern)}` }, (s) => {
      s.rules = s.rules.filter((r) => r.pattern !== pattern);
    });
  }
}
