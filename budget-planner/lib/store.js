// Tiny JSON-file database. One file, durable atomic writes (write temp, fsync,
// rename), writes serialised through a promise chain so concurrent requests
// from the phone and the laptop can't corrupt it. A corrupt file is set aside
// and the newest good backup is loaded instead.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CATEGORIES } from '../public/js/shared/categories.js';
import { mergeDuplicates } from '../public/js/shared/dedupe.js';
import { createBackup, newestValidBackup } from './backup.js';

export const TRASH_MAX = 500;
export const TRASH_DAYS = 60;
export const TOMBSTONES_MAX = 2000;

export function emptyState() {
  return {
    version: 1,
    transactions: [],
    goals: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    rules: [],
    budgets: {},
    deletedBankRefs: [],
    deletedIds: [], // ids of deleted transactions: a replayed offline edit must not bring them back
    trash: [], // [{ tx, reason, removedAt }] — removed transactions, restorable
    bank: { connections: [], lastSync: null, lastError: null, pendingAuth: null },
    settings: { planIntensity: 'balanced' },
    updatedAt: new Date().toISOString(),
  };
}

export class Store {
  constructor(file, { backupDir = path.join(path.dirname(file), 'backups') } = {}) {
    this.file = file;
    this.backupDir = backupDir;
    this.state = null;
    this.queue = Promise.resolve();
    this.listeners = new Set();
  }

  async load() {
    let saved;
    try {
      saved = parseState(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.state = emptyState();
        await this.persist();
        return this;
      }
      saved = await this.recover(err);
    }
    this.state = { ...emptyState(), ...saved };
    this.state.bank = { ...emptyState().bank, ...this.state.bank };
    for (const key of ['deletedIds', 'trash', 'deletedBankRefs']) if (!Array.isArray(this.state[key])) this.state[key] = [];
    // Pick up categories added in newer versions without touching user edits.
    for (const c of DEFAULT_CATEGORIES) {
      if (!this.state.categories.some((x) => x.name === c.name)) this.state.categories.push({ ...c });
    }
    return this;
  }

  // budget.json can't be read or isn't valid JSON (e.g. a crash or full disk on
  // an older version): keep it aside for inspection and use the newest backup.
  async recover(err) {
    const backup = await newestValidBackup(this.backupDir);
    if (!backup) {
      console.error(`\n  !!! ${this.file} is corrupt or could not be read (${err.message}) and there is no usable backup in ${this.backupDir}.`
        + '\n  !!! Not starting, so nothing is overwritten. Fix or restore the file by hand.\n');
      throw new Error(`${this.file} is corrupt and no backup could be loaded: ${err.message}`);
    }
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { await fs.rename(this.file, aside); } catch { /* unreadable and unmovable: it gets replaced below */ }
    console.error(`\n  !!! ${this.file} is corrupt or could not be read (${err.message}).`
      + `\n  !!! Loaded the newest good backup instead: ${backup.file}`
      + `\n  !!! The damaged file was kept as ${aside}. Changes made after that backup may be missing.\n`);
    await this.persist(backup.state);
    return backup.state;
  }

  // Copy budget.json into the backups folder (after any write in progress).
  backup(reason) {
    const run = this.queue.then(() => createBackup(this.file, { dir: this.backupDir, reason }));
    this.queue = run.catch(() => {});
    return run;
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
    // fsync before the rename, so a power cut can't leave an empty budget.json.
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(state, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmp, this.file);
  }
}

function parseState(raw) {
  const state = JSON.parse(raw);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new SyntaxError('not a JSON object');
  return state;
}

// ---------- trash and tombstones (pure helpers on a state draft) ----------

/** Keep removed transactions restorable: newest TRASH_MAX, none older than TRASH_DAYS. */
export function pushTrash(s, txs, reason, now = Date.now()) {
  const removedAt = new Date(now).toISOString();
  const cutoff = now - TRASH_DAYS * 86400000;
  const trash = Array.isArray(s.trash) ? s.trash : [];
  for (const tx of txs) trash.push({ tx, reason, removedAt });
  s.trash = trash.filter((e) => Date.parse(e.removedAt) >= cutoff).slice(-TRASH_MAX);
}

export function addTombstones(s, ids) {
  const set = new Set(ids);
  const kept = (Array.isArray(s.deletedIds) ? s.deletedIds : []).filter((id) => !set.has(id));
  s.deletedIds = [...kept, ...set].slice(-TOMBSTONES_MAX);
}

/**
 * Remove the transactions matching `predicate`: they go to the trash, their
 * ids become tombstones, and bank rows are remembered so a sync doesn't
 * bring them back. Returns the removed transactions.
 */
export function removeTransactions(s, predicate, reason) {
  const removed = s.transactions.filter(predicate);
  if (!removed.length) return removed;
  const gone = new Set(removed);
  s.transactions = s.transactions.filter((t) => !gone.has(t));
  pushTrash(s, removed, reason);
  addTombstones(s, removed.map((t) => t.id));
  for (const t of removed) if (t.bankRef && !s.deletedBankRefs.includes(t.bankRef)) s.deletedBankRefs.push(t.bankRef);
  return removed;
}

/**
 * mergeDuplicates, but the rows it merges away are kept in the trash (reason
 * 'duplicate-merge') and tombstoned. Use it wherever mergeDuplicates runs on
 * the stored state. Returns the number merged.
 */
export function mergeDuplicatesToTrash(s) {
  const before = new Map(s.transactions.map((t) => [t.id, structuredClone(t)]));
  const merged = mergeDuplicates(s);
  if (!merged) return merged;
  const left = new Set(s.transactions.map((t) => t.id));
  const removed = [...before.values()].filter((t) => !left.has(t.id));
  pushTrash(s, removed, 'duplicate-merge');
  addTombstones(s, removed.map((t) => t.id));
  return merged;
}

/**
 * Put a trashed transaction back exactly as it was. Returns it, or null when
 * it isn't in the trash or a transaction with that id exists again.
 */
export function restoreFromTrash(s, id) {
  const trash = Array.isArray(s.trash) ? s.trash : [];
  let i = -1;
  for (let k = trash.length - 1; k >= 0; k -= 1) if (trash[k].tx?.id === id) { i = k; break; }
  if (i === -1 || s.transactions.some((t) => t.id === id)) return null;
  const { tx } = trash[i];
  s.trash = trash.filter((e) => e.tx?.id !== id);
  s.transactions.push(tx);
  s.deletedIds = (s.deletedIds || []).filter((x) => x !== id);
  if (tx.bankRef) s.deletedBankRefs = (s.deletedBankRefs || []).filter((r) => r !== tx.bankRef);
  return tx;
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
