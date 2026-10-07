import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// Small JSON state file so risk limits survive a restart. path = null keeps it in memory.
export class StateStore {
  constructor(path) {
    this.path = path;
  }

  load() {
    if (!this.path) return this.mem ?? {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new Error(`Cannot read bot state ${this.path}: ${e.message}`);
    }
  }

  save(state) {
    if (!this.path) {
      this.mem = { ...state };
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }
}

// Trading day in the exchange's time zone (DAX: Frankfurt), as YYYY-MM-DD.
export function tradingDay(time, timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
