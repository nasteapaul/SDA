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

  // mutate(fn): fn receives a copy of the state and may change it in place; its
  // return value is passed back. The copy replaces the state only once it is on
  // disk, so a fn that throws halfway (or a failed write) changes nothing.
  mutate(fn) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      draft.updatedAt = new Date().toISOString();
      await this.persist(draft);
      this.state = draft;
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

  async persist(state = this.state) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await renameWithRetry(tmp, this.file);
  }
}

// On Windows, antivirus or sync tools briefly holding the file make rename fail
// with EPERM/EBUSY/EACCES; a short retry gets past it.
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 1; ; i += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}
