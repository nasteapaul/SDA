#!/usr/bin/env node
// Runs once and exits; GitHub Actions calls it every 30 minutes.
//   STATE_DIR          folder for state.json (kept on the signals-data branch)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   where alerts go (secrets)
//   SEC_CONTACT        your e-mail; SEC requires a contact in the User-Agent (secret)
//   GITHUB_TOKEN       given by Actions; used for the free AI summary (GitHub Models)
//   DRY_RUN=1          print alerts instead of sending them
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
