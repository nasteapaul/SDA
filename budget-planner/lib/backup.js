// Copies of budget.json in data/backups: one a day, plus one before anything
// risky (migrations at startup, bulk removals). Names are
// budget-YYYY-MM-DD.json (daily) and budget-YYYY-MM-DD-<reason>[-HHMMSS].json.
// Retention: the 14 newest daily copies, and reason copies from the last 30 days.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEEP_DAILY = 14;
const KEEP_REASON_DAYS = 30;
const NAME_RE = /^budget-(\d{4}-\d{2}-\d{2})(?:-([a-z0-9-]+))?\.json$/;

const pad = (n) => String(n).padStart(2, '0');
// Local calendar date: "today" is the day the person sees on their clock.
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function cleanReason(reason) {
  const r = String(reason || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return r || null;
}

export function backupName(now = new Date(), reason) {
  const r = cleanReason(reason);
  return `budget-${localDate(now)}${r ? `-${r}` : ''}.json`;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Copy `file` into `dir`. Returns the backup's path, or null when there is
 * nothing to copy (no file yet) or `ifMissing` and today's copy already exists.
 * A copy with a reason never overwrites an earlier one (a time is appended).
 */
export async function createBackup(file, { dir = path.join(path.dirname(file), 'backups'), reason, now = new Date(), ifMissing = false } = {}) {
  if (!(await exists(file))) return null;
  await fs.mkdir(dir, { recursive: true });
  let target = path.join(dir, backupName(now, reason));
  if (await exists(target)) {
    if (ifMissing || !cleanReason(reason)) return null;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    target = path.join(dir, backupName(now, `${cleanReason(reason)}-${time}`));
    for (let i = 2; await exists(target); i += 1) target = path.join(dir, backupName(now, `${cleanReason(reason)}-${time}-${i}`));
  }
  await fs.copyFile(file, target);
  return target;
}

/** Delete backups past their retention. Files that aren't backups are left alone. */
export async function pruneBackups(dir, { now = new Date(), keepDaily = KEEP_DAILY, keepDays = KEEP_REASON_DAYS } = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  const cutoffDate = localDate(cutoff);
  const daily = [];
  const remove = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    if (m[2]) { if (m[1] < cutoffDate) remove.push(name); } else daily.push(name);
  }
  daily.sort().reverse();
  remove.push(...daily.slice(keepDaily));
  for (const name of remove) await fs.rm(path.join(dir, name), { force: true });
  return remove;
}

/** Today's backup if there isn't one yet, then prune old ones. */
export async function dailyBackup(file, { dir = path.join(path.dirname(file), 'backups'), now = new Date() } = {}) {
  const made = await createBackup(file, { dir, now, ifMissing: true });
  await pruneBackups(dir, { now });
  return made;
}

/** The most recently written backup that is valid JSON: { file, state } or null. */
export async function newestValidBackup(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch { return null; }
  const found = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    try { found.push({ file: path.join(dir, name), mtime: (await fs.stat(path.join(dir, name))).mtimeMs }); } catch { /* vanished */ }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of found) {
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) return { file, state };
    } catch { /* corrupt too: try the next one */ }
  }
  return null;
}
