#!/usr/bin/env node
// Runs once and exits, or with LOOP_MINUTES checks again every INTERVAL_SECONDS until
// that time is up (GitHub Actions keeps one such run going all day).
//   STATE_DIR          folder for state.json (kept on the signals-data branch)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   where alerts go (secrets)
//   SEC_CONTACT        your e-mail; SEC requires a contact in the User-Agent (secret)
//   GITHUB_TOKEN       given by Actions; used for the free AI summary (GitHub Models)
//   DRY_RUN=1          print alerts instead of sending them
//   LOOP_MINUTES, INTERVAL_SECONDS   keep checking (default: once)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { loadState, saveState } from '../lib/journal.js';
import { runOnce, updateJournal, makeIo } from '../lib/pipeline.js';
import { send, formatSignal } from '../lib/telegram.js';
import { weeklyReport, reportDue } from '../lib/report.js';

const env = process.env;
const dryRun = env.DRY_RUN === '1';
const tg = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
if (!dryRun && !(tg.token && tg.chatId)) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or DRY_RUN=1)');
if (!env.SEC_CONTACT || !/@/.test(env.SEC_CONTACT)) throw new Error('Set SEC_CONTACT to an e-mail address (SEC requires it)');

const notify = (html) => (dryRun ? console.log(`\n--- Telegram ---\n${html}\n`) : send(tg, html));
const io = makeIo({
  secAgent: `stock-signals ${env.SEC_CONTACT}`,
  githubToken: env.GITHUB_TOKEN,
  dryRun,
  telegram: { notify, alert: (ev) => notify(formatSignal(ev)) },
});

const statePath = join(env.STATE_DIR ?? 'data', 'state.json');
const { feeds } = JSON.parse(readFileSync(new URL('../feeds.json', import.meta.url), 'utf8'));
const state = loadState(statePath);
const loopMs = (Number(env.LOOP_MINUTES) || 0) * 60e3;
const intervalMs = Math.max(30, Number(env.INTERVAL_SECONDS) || 120) * 1e3;
const end = Date.now() + loopMs;
const startHealth = { ...state.health };

async function check() {
  const firstRun = !state.warm;
  const now = Date.now();
  try {
    await runOnce({ state, config: CONFIG, feeds, io, now });
    if (firstRun && state.warm) await notify('✅ Bot-ul de semnale e pornit. Îți scriu doar când apare ceva important.');
    await updateJournal(state, io, now);
    if (reportDue(state, now)) await notify(weeklyReport(state, now));
  } finally {
    saveState(statePath, state);
  }
}

for (;;) {
  const started = Date.now();
  try {
    await check();
  } catch (e) {
    if (!loopMs) throw e;
    console.log(`Verificare eșuată: ${e.message}`); // try again next round
  }
  // Some sites (Google News, PR Newswire) block the GitHub server they see too often. When a
  // source has failed for about an hour on this server, end the loop early: the workflow
  // then starts the next run, usually on another server.
  const blocked = feeds.find((f) => (state.health[f.name] ?? 0) - (startHealth[f.name] ?? 0) >= (f.everyMin ? 60 / f.everyMin : 3600e3 / intervalMs));
  if (loopMs && blocked) {
    console.log(`${blocked.name} nu răspunde pe acest server; repornesc pe altul.`);
    break;
  }
  const wait = intervalMs - (Date.now() - started);
  if (Date.now() + Math.max(wait, 0) >= end) break;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
