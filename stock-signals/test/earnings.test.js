import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filingDay, reaction } from '../lib/earnings.js';
import { runOnce } from '../lib/pipeline.js';
import { loadState } from '../lib/journal.js';
import { CONFIG } from '../config.js';
import { formatSignal } from '../lib/telegram.js';

// Daily bars as Yahoo gives them: stamped at the New York open (14:30 UTC in winter).
const bar = (day, close, volume = 5e6) => ({ time: Date.parse(`${day}T14:30:00Z`), high: close * 1.01, low: close * 0.99, close, volume });
const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
const flat = (closes) => DAYS.map((d, i) => bar(d, closes[i] ?? closes.at(-1)));

test('filingDay: New York date, next day when accepted after 17:30', () => {
  assert.equal(filingDay(Date.parse('2026-11-10T21:05:00Z')), '2026-11-10'); // 16:05 in New York
  assert.equal(filingDay(Date.parse('2026-11-10T23:00:00Z')), '2026-11-11'); // 18:00
  assert.equal(filingDay(Date.parse('2026-11-11T03:00:00Z')), '2026-11-11'); // 22:00 the evening before
  assert.equal(filingDay(Date.parse('2026-07-01T21:45:00Z')), '2026-07-02'); // 17:45 in summer
});

test('reaction: two-day move minus the market, only once the second day has closed', () => {
  const stock = flat([50, 50, 50, 50, 50, 50, 50, 56, 57]);       // filing on 11 Nov: 50 -> 57
  const spy = flat([400, 400, 400, 400, 400, 400, 400, 402, 404]); // +1 %
  assert.equal(reaction(stock, spy, '2026-11-11', Date.parse('2026-11-12T18:00:00Z')), null); // 12 Nov still open
  const r = reaction(stock, spy, '2026-11-11', Date.parse('2026-11-12T21:30:00Z'));
  assert.ok(Math.abs(r.move - 0.14) < 1e-9);
  assert.ok(Math.abs(r.excess - 0.13) < 1e-9);
  assert.equal(r.entryDay, '2026-11-12');
  // A filing on Saturday counts from Monday; the day after Monday is not there yet.
  assert.equal(reaction(stock.slice(0, 6), spy, '2026-11-07', Date.parse('2026-11-09T22:00:00Z')), null);
});

const atom = (entries) => `<feed>${entries.map(([acc, name, cik, updated]) => `<entry><title>8-K - ${name} (${cik}) (Filer)</title>
<link href="https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${acc}-index.htm"/>
<summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-10 &lt;br&gt;Item 2.02: Results of Operations and Financial Condition</summary>
<updated>${updated}</updated><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`).join('')}</feed>`;

test('a stock that jumps 10 % over the market on earnings is alerted once, after the second close', async () => {
  const state = { ...loadState('/nonexistent'), warm: true };
  const sent = [];
  let filings = atom([
    ['0000000001-26-000001', 'Jumper Inc', '0000000011', '2026-11-10T16:10:00-05:00'],
    ['0000000002-26-000002', 'Sleepy Corp', '0000000022', '2026-11-10T16:20:00-05:00'],
  ]);
  const io = {
    log: () => {},
    sec: async (url) => (/type=8-K/.test(url) ? filings : /index\.json/.test(url) ? '{"directory":{"item":[]}}' : '<feed></feed>'),
    news: async () => '<rss></rss>',
    tickers: async () => new Map([['11', 'JUMP'], ['22', 'SLPY']]),
    chart: async (sym) => ({
      currency: 'USD',
      price: sym === 'JUMP' ? 57 : sym === 'SPY' ? 404 : 50,
      bars: sym === 'JUMP' ? flat([50, 50, 50, 50, 50, 50, 56, 57]) : sym === 'SPY' ? flat([400, 400, 400, 400, 400, 400, 402, 404]) : flat([50, 50, 50, 50, 50, 50, 51, 51]),
    }),
    assess: async () => null,
    ripple: async () => [],
    alert: async (ev) => sent.push(ev),
    notify: async (m) => sent.push(m),
  };
  const run = (iso) => runOnce({ state, config: CONFIG, feeds: [], io, now: Date.parse(iso) });

  await run('2026-11-10T21:30:00Z'); // the reports arrive after the close
  assert.equal(state.earnings.length, 2);
  filings = '<feed></feed>';
  await run('2026-11-11T15:00:00Z'); // the day after the filing day is still open
  assert.equal(sent.length, 0);

  const alerts = await run('2026-11-11T21:30:00Z');
  assert.deepEqual(alerts.map((a) => a.listing.xtb), ['JUMP.US']);
  assert.equal(state.earnings.length, 0); // the quiet one is dropped too
  const html = formatSignal(alerts[0]);
  assert.match(html, /13% peste piață/);
  assert.match(html, /Ține 4 săptămâni/);
  assert.match(html, /Stop-loss de siguranță/);
  assert.doesNotMatch(html, /Vinde când ajunge la/);
  assert.equal(state.journal.at(-1).source, 'Rezultate financiare');

  assert.equal((await run('2026-11-11T21:40:00Z')).length, 0); // not repeated
});
