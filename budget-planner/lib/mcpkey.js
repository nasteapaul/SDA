// The key for the HTTP MCP endpoint (/mcp): a separate, read-only key, never
// the login token, so a Claude connector can read the budget but not log in or
// change anything. One key at a time; only its SHA-256 is kept on disk, so the
// file doesn't hand out a working key. Creating a new key replaces the old one.

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MCP_KEY_FILE = '.mcp-key.json'; // inside DATA_DIR

const sha256 = (key) => createHash('sha256').update(String(key)).digest('hex');
const HASH_RE = /^[0-9a-f]{64}$/;

export class McpKeys {
  constructor(file) {
    this.file = file;
    this.record = null; // { hash, createdAt }
    this.mtime = null;
  }

  async load() {
    this.reload();
    return this;
  }

  // Re-read when the file changed, so a key made with `node mcp.js --new-key`
  // works (and a revoked one stops) without restarting the server.
  reload() {
    let mtime = null;
    try { mtime = statSync(this.file).mtimeMs; } catch { /* no key */ }
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    this.record = null;
    if (mtime === null) return;
    try {
      const r = JSON.parse(readFileSync(this.file, 'utf8'));
      if (HASH_RE.test(r?.hash)) this.record = { hash: r.hash, createdAt: r.createdAt || null };
    } catch { /* unreadable: no key */ }
  }

  get exists() {
    this.reload();
    return Boolean(this.record);
  }

  get createdAt() {
    this.reload();
    return this.record?.createdAt || null;
  }

  /** A new random key (shown once); replaces any previous key. */
  async create() {
    const key = randomBytes(32).toString('base64url');
    const record = { hash: sha256(key), createdAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    this.record = record;
    this.mtime = statSync(this.file).mtimeMs;
    return key;
  }

  valid(key) {
    this.reload();
    if (!this.record || typeof key !== 'string' || !key || key.length > 256) return false;
    return timingSafeEqual(Buffer.from(sha256(key), 'hex'), Buffer.from(this.record.hash, 'hex'));
  }

  async revoke() {
    await fs.rm(this.file, { force: true });
    this.record = null;
    this.mtime = null;
  }
}
