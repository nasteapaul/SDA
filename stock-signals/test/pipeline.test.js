import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, updateJournal } from '../lib/pipeline.js';
import { loadState } from '../lib/journal.js';
import { CONFIG } from '../config.js';
import { formatSignal } from '../lib/telegram.js';
import { weeklyReport, reportDue } from '../lib/report.js';

const rss = (items) => `<rss><channel>${items.map(([id, title, desc]) =>
  `<item><guid>${id}</guid><title>${title}</title><link>https://ex.com/${id}</link><description>${desc}</description></item>`).join('')}</channel></rss>`;
const emptyAtom = '<feed></feed>';
const bars = (n, vol = 2e6) => Array.from({ length: n }, (_, i) => ({ time: i * 86400e3, close: 50, volume: vol }));

function fakeIo(news) {
  const sent = [];
  return {
    sent,
    log: () => {},
    sec: async () => emptyAtom,
    news: async () => news(),
    tickers: async () => new Map(),
    chart: async (sym) => {
      if (sym === 'TINY') return { currency: 'USD', price: 0.5, bars: bars(30, 1e4) };
      return { currency: 'USD', price: 50, bars: bars(30) };
    },
    assess: async () => ({ summary: 'Contract important.', impact: 1 }),
    alert: async (ev) => sent.push(ev),
    notify: async (m) => sent.push(m),
  };
}

test('first run memorises old news; later runs alert only on new, strong, liquid events', async () => {
  const state = loadState('/nonexistent/state.json');
  let batch = [['old', 'Acme secures $400 million contract with Microsoft', 'Acme (NASDAQ: ACME)']];
  const io = fakeIo(() => rss(batch));
  const feeds = [{ name: 'Wire', url: 'u' }];
  const now = Date.parse('2026-10-08T15:00:00Z');

  assert.deepEqual(await runOnce({ state, config: CONFIG, feeds, io, now }), []);
  assert.equal(io.sent.length, 0);

  batch = [
    ['old', 'Acme secures $400 million contract with Microsoft', 'Acme (NASDAQ: ACME)'],
    ['n1', 'Beta wins $90 million contract with NVIDIA', 'Beta (NYSE: BETA)'],
    ['n2', 'Tiny secures contract with Apple', 'Tiny (NASDAQ: TINY)'],
    ['n3', 'Gamma announces proposed public offering', 'Gamma (NASDAQ: GAM)'],
    ['n4', 'Delta wins contract', 'Delta (OTCQB: DLTA)'],
  ];
  const alerts = await runOnce({ state, config: CONFIG, feeds, io, now: now + 1800e3 });
  assert.deepEqual(alerts.map((a) => a.listing.xtb), ['BETA.US']);
  assert.equal(alerts[0].score, 5); // contract 2 + giant 2 + AI 1
  assert.equal(state.journal.length, 1);

  // The same stock is not repeated within a few days.
  batch = [['n5', 'Beta wins second $50 million contract with NVIDIA', 'Beta (NYSE: BETA)']];
  assert.equal((await runOnce({ state, config: CONFIG, feeds, io, now: now + 3600e3 })).length, 0);

  const html = formatSignal(alerts[0]);
  assert.match(html, /BETA\.US/);
  assert.match(html, /Contract important\./);
});

test('a failing feed is reported once after repeated failures', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  const io = fakeIo(() => { throw new Error('down'); });
  for (let i = 0; i < CONFIG.feedFailWarn + 3; i++) await runOnce({ state, config: CONFIG, feeds: [{ name: 'Wire', url: 'u' }], io });
  assert.equal(io.sent.filter((m) => typeof m === 'string' && /Wire/.test(m)).length, 1);
});

test('journal is filled once a day and the Sunday report summarises it', async () => {
  const DAY = 86400e3;
  const t0 = Date.parse('2026-06-01T15:00:00Z');
  const state = { ...loadState('/nonexistent'), journal: [{ time: t0, yahoo: 'X', benchmark: 'SPY', returns: {} }] };
  const series = (step) => Array.from({ length: 100 }, (_, i) => ({ time: t0 - 1.5 * 3600e3 + i * DAY, close: 100 + i * step }));
  const io = { chart: async (s) => ({ bars: s === 'SPY' ? series(0.1) : series(1) }) };
  await updateJournal(state, io, t0 + 90 * DAY);
  assert.equal(state.journal[0].returns[5], 105 / 100 - 1);
  assert.ok(state.journal[0].bench[5] > 0);
  const sunday = Date.parse('2026-10-11T18:00:00Z');
  assert.equal(reportDue(state, sunday), true);
  assert.equal(reportDue(state, sunday + 3600e3), false);
  assert.match(weeklyReport(state, sunday), /După 5 zile \(1 alerte\): medie \+5\.0%/);
});
