// Tiny JSON-file database. One file, atomic writes (write temp + rename),
// writes serialised through a promise chain so concurrent requests from the
// phone and the laptop can't corrupt it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';

export function emptyState() {
  return {
    version: 1,
    transactions: [],
    goals: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    rules: [],
    budgets: {},
    deletedBankRefs: [],
    bank: { connections: [], lastSync: null, lastError: null, pendingAuth: null },
    settings: { planIntensity: 'balanced' },
    updatedAt: new Date().toISOString(),
  };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.state = null;
    this.queue = Promise.resolve();
    this.listeners = new Set();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = { ...emptyState(), ...JSON.parse(raw) };
      this.state.bank = { ...emptyState().bank, ...this.state.bank };
      // Pick up categories added in newer versions without touching user edits.
      for (const c of DEFAULT_CATEGORIES) {
        if (!this.state.categories.some((x) => x.name === c.name)) this.state.categories.push({ ...c });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = emptyState();
      await this.persist();
    }
    return this;
  }

  get() {
    return this.state;
  }

  // mutate(fn): fn receives the state and may change it in place; its return
  // value is passed back. The change is persisted before the promise resolves.
  mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.state);
      this.state.updatedAt = new Date().toISOString();
      await this.persist();
      for (const l of this.listeners) l(this.state);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
