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
    ripple: async () => [],
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

test('a slow feed is read only every everyMin minutes and its recovery is reported', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  let up = false, calls = 0;
  const io = fakeIo(() => { calls++; if (!up) throw new Error('503'); return rss([]); });
  const feeds = [{ name: 'Google', url: 'u', kind: 'ripple', everyMin: 15 }];
  const t0 = Date.parse('2026-10-24T10:00:00Z');
  for (let m = 0; m < 60; m += 2) await runOnce({ state, config: CONFIG, feeds, io, now: t0 + m * 60e3 });
  assert.equal(calls, 4); // minutes 0, 16, 32, 48
  assert.equal(io.sent.filter((m) => /nu mai răspunde/.test(m)).length, 1);
  up = true;
  await runOnce({ state, config: CONFIG, feeds, io, now: t0 + 64 * 60e3 });
  assert.equal(io.sent.filter((m) => /merge din nou/.test(m)).length, 1);
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

test('a new 13D by an activist becomes an alert for the target company', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  const entry = (role, name, cik) => `<entry><title>SCHEDULE 13D - ${name} (${cik}) (${role})</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm"/>
    <summary type="html">Filed: 2026-10-15</summary><updated>2026-10-15T10:00:00-04:00</updated>
    <id>urn:tag:sec.gov,2008:accession-number=0000000001-26-000001</id></entry>`;
  const atom13d = `<feed>${entry('Subject', 'TARGET INC', '0000000777')}${entry('Filed by', 'Starboard Value LP', '0000000999')}</feed>`;
  const io = fakeIo(() => rss([]));
  io.sec = async (url) => {
    if (url.includes('type=SCHEDULE%2013D')) return atom13d;
    if (url.endsWith('index.json')) return JSON.stringify({ directory: { item: [{ name: 'primary_doc.xml' }] } });
    if (url.endsWith('primary_doc.xml')) return '<item4>The Reporting Persons intend to discuss strategic alternatives with the Issuer</item4>';
    return emptyAtom;
  };
  io.tickers = async () => new Map([['777', 'TGT']]);
  const alerts = await runOnce({ state, config: CONFIG, feeds: [], io });
  assert.deepEqual(alerts.map((a) => a.listing.xtb), ['TGT.US']);
  assert.match(alerts[0].title, /Starboard Value LP a cumpărat peste 5% din TARGET INC/);
  assert.equal(alerts[0].score, 8); // 13D 3 + activist 2 + sale intent 2 + AI 1
  // Seen once: the next check does not alert again.
  assert.equal((await runOnce({ state, config: CONFIG, feeds: [], io })).length, 0);
});

test('ripple: queued headlines become alerts for a US-listed company the AI names', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  const io = fakeIo(() => rss([['h1', 'Big Pharma said to weigh bid for rival biotech', 'Talks are early, sources say']]));
  io.tickers = async () => new Map([['1', 'BIOX']]);
  let seen;
  io.ripple = async (items) => { seen = items; return [{ item: 0, ticker: 'BIOX', company: 'BioX', why: 'Ar putea fi cumpărată.', confidence: 3 }, { item: 0, ticker: 'FAKE', company: 'Nope', why: 'x', confidence: 3 }]; };
  const feeds = [{ name: 'Rumours', url: 'u', kind: 'ripple' }];
  const alerts = await runOnce({ state, config: CONFIG, feeds, io, now: Date.parse('2026-10-15T20:00:00Z') });
  assert.equal(seen.length, 1);
  assert.deepEqual(alerts.map((a) => a.listing.xtb), ['BIOX.US'], 'only tickers that exist');
  assert.match(formatSignal(alerts[0]), /De ce merită:<\/b> Ar putea fi cumpărată\./);
  // The next batch waits for rippleEveryMin.
  io.news = async () => rss([['h2', 'Another headline', '']]);
  seen = null;
  await runOnce({ state, config: CONFIG, feeds, io, now: Date.parse('2026-10-15T20:02:00Z') });
  assert.equal(seen, null);
});

test('skips stocks XTB does not offer and caches the answer', async () => {
  const state = loadState('/nonexistent/state.json');
  let batch = [];
  const io = fakeIo(() => rss(batch));
  const asked = [];
  io.xtb = async (l) => { asked.push(l.xtb); if (l.xtb === 'DOWN.US') throw new Error('HTTP 503'); return l.xtb !== 'SRTA.US'; };
  const feeds = [{ name: 'Wire', url: 'u' }];
  const now = Date.parse('2026-10-08T15:00:00Z');
  await runOnce({ state, config: CONFIG, feeds, io, now });
  batch = [
    ['a', 'Strata wins $90 million contract with NVIDIA', 'Strata (NASDAQ: SRTA)'],
    ['b', 'Beta wins $90 million contract with NVIDIA', 'Beta (NYSE: BETA)'],
    ['c', 'Down wins $90 million contract with NVIDIA', 'Down (NYSE: DOWN)'],
  ];
  const alerts = await runOnce({ state, config: CONFIG, feeds, io, now: now + 1800e3 });
  assert.deepEqual(alerts.map((a) => a.listing.xtb).sort(), ['BETA.US', 'DOWN.US']);
  assert.equal(alerts.find((a) => a.listing.xtb === 'DOWN.US').xtbUnchecked, true);
  assert.match(formatSignal(alerts.find((a) => a.listing.xtb === 'DOWN.US')), /n-am putut verifica/);
  assert.deepEqual(state.xtb['SRTA.US'].ok, false);
  batch = [['d', 'Strata wins another $90 million contract with NVIDIA', 'Strata (NASDAQ: SRTA)']];
  asked.length = 0;
  await runOnce({ state, config: CONFIG, feeds, io, now: now + 3600e3 });
  assert.deepEqual(asked, [], 'cached answer reused');
});

test('Reddit mention spikes become events; strong events feed the knock-on queue', async () => {
  const state = loadState('/nonexistent/state.json');
  let batch = [];
  const io = fakeIo(() => rss(batch));
  io.tickers = async () => new Map([['1', 'HYPE'], ['2', 'CALM'], ['3', 'BETA']]);
  io.buzz = async () => [
    { ticker: 'HYPE', name: 'Hype Corp', mentions: 120, mentions_24h_ago: 10 },
    { ticker: 'CALM', name: 'Calm Inc', mentions: 100, mentions_24h_ago: 80 },
    { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', mentions: 400, mentions_24h_ago: 20 },
  ];
  const feeds = [{ name: 'Wire', url: 'u' }];
  const now = Date.parse('2026-10-08T15:00:00Z');
  await runOnce({ state, config: CONFIG, feeds, io, now });
  batch = [['b', 'Beta wins $90 million contract with NVIDIA', 'Beta (NYSE: BETA)']];
  const alerts = await runOnce({ state, config: CONFIG, feeds, io, now: now + 86400e3 });
  const hype = alerts.find((a) => a.source === 'Reddit');
  assert.equal(hype?.listing.xtb, 'HYPE.US', 'big jump with AI +1 alerts');
  assert.ok(!alerts.some((a) => a.company === 'Calm Inc'));
  assert.match(formatSignal(hype), /forumurile de investiții/);
  assert.ok(state.ripple.queue.some((q) => /Beta/.test(q.title)), 'strong event queued for knock-on ideas');
  assert.ok(!state.ripple.queue.some((q) => /Hype/.test(q.title)), 'Reddit buzz is not');
});

test('feeds that fail together are reported in one message', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  const io = fakeIo(() => { throw new Error('503'); });
  const feeds = [{ name: 'G1', url: 'u', kind: 'ripple', everyMin: 15 }, { name: 'G2', url: 'v', kind: 'ripple', everyMin: 15 }];
  const t0 = Date.parse('2026-10-24T10:00:00Z');
  for (let m = 0; m < 60; m += 2) await runOnce({ state, config: CONFIG, feeds, io, now: t0 + m * 60e3 });
  const warnings = io.sent.filter((m) => /nu mai răspund/.test(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /„G1”, „G2” nu mai răspund de cam o oră/);
});

test('four weeks after an alert one message says how the stock did and whether the plan worked', async () => {
  const DAY = 86400e3;
  const t0 = Date.parse('2026-06-01T15:00:00Z');
  // bar k: close 100 + k, high close + 1, low close - 1; the target 112 is touched on bar 11
  const series = (f) => Array.from({ length: 40 }, (_, k) => ({ time: t0 - 1.5 * 3600e3 + k * DAY, close: f(k), high: f(k) + 1, low: f(k) - 1 }));
  const sent = [];
  let upTo = 0; // Yahoo only has the days that have passed
  const io = { chart: async (s) => ({ bars: (s === 'SPY' ? series((k) => 400 + k * 0.4) : series((k) => 100 + k)).filter((b) => b.time < upTo) }), notify: async (m) => sent.push(m) };
  const entry = { time: t0, company: 'Beta & Co', xtb: 'BETA.US', source: 'SEC 8-K', yahoo: 'BETA', benchmark: 'SPY', returns: {}, plan: { price: 100, stop: 90, target: 112 } };
  const state = { ...loadState('/nonexistent'), journal: [entry] };
  upTo = t0 + 10 * DAY;
  await updateJournal(state, io, upTo);
  assert.equal(sent.length, 0, 'not before 20 trading days');
  upTo = t0 + 40 * DAY;
  await updateJournal(state, io, upTo);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Beta &amp; Co \(BETA\.US\)/);
  assert.match(sent[0], /Preț la intrare 100 → după 4 săptămâni 120: <b>\+20,0%<\/b>/);
  assert.match(sent[0], /S&amp;P 500\) în aceeași perioadă: \+2,0%/);
  assert.match(sent[0], /Ținta de 112 a fost atinsă pe 12 iun\. \(\+12,0%\)/);
  upTo = t0 + 41 * DAY;
  await updateJournal(state, io, upTo);
  assert.equal(sent.length, 1, 'sent only once');
});
