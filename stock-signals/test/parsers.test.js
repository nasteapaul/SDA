import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, stripTags } from '../lib/feed.js';
import { parseCurrentEntry, parseForm4, pickDocument, tickerMap } from '../lib/sec.js';
import { extractListings } from '../lib/tickers.js';
import { scoreText, scoreInsiders } from '../lib/rules.js';
import { summarize } from '../lib/market.js';
import { parseAssessment } from '../lib/ai.js';
import { forwardReturns, journalStats } from '../lib/journal.js';

const SEC_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>8-K - ACME CORP (0000123456) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/123456/000012345626000042/0000123456-26-000042-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-10-08 &lt;b&gt;AccNo:&lt;/b&gt; 0000123456-26-000042 &lt;br&gt;Item 1.01: Entry into a Material Definitive Agreement&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
<updated>2026-10-08T12:01:02-04:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0000123456-26-000042</id></entry>
</feed>`;

test('reads SEC current filings with their 8-K items', () => {
  const [e] = parseFeed(SEC_ATOM).map(parseCurrentEntry);
  assert.deepEqual([e.form, e.company, e.cik, e.role, e.acc], ['8-K', 'ACME CORP', '123456', 'Filer', '0000123456-26-000042']);
  assert.deepEqual(e.items, ['1.01', '9.01']);
  assert.match(e.link, /index\.htm$/);
});

test('reads RSS items with CDATA and entities', () => {
  const xml = `<rss><channel><title>x</title><item><title><![CDATA[Acme &amp; Co wins $40 million contract]]></title>
  <link>https://ex.com/a</link><guid>g1</guid><description>&lt;p&gt;Acme (NASDAQ: ACME) said&lt;/p&gt;</description>
  <pubDate>Wed, 08 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  const [it] = parseFeed(xml);
  assert.equal(it.title, 'Acme & Co wins $40 million contract');
  assert.equal(it.id, 'g1');
  assert.equal(stripTags(it.summary), 'Acme (NASDAQ: ACME) said');
  assert.equal(it.time, Date.parse('2026-10-08T12:00:00Z'));
});

test('Form 4: sums only open-market purchases', () => {
  const tx = (code, ad, shares, price) => `<nonDerivativeTransaction><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare>
    <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>`;
  const xml = `<ownershipDocument><issuer><issuerCik>0000123456</issuerCik><issuerName>Acme Corp</issuerName><issuerTradingSymbol>acme</issuerTradingSymbol></issuer>
    <reportingOwner><reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
    <nonDerivativeTable>${tx('P', 'A', 1000, 50)}${tx('S', 'D', 500, 55)}${tx('M', 'A', 9999, 1)}</nonDerivativeTable></ownershipDocument>`;
  const f = parseForm4(xml);
  assert.equal(f.bought, 50000);
  assert.deepEqual(f.issuer, { cik: '123456', name: 'Acme Corp', ticker: 'ACME' });
  assert.equal(f.owner.title, 'Chief Executive Officer');
  assert.equal(f.owner.officer, true);
});

test('picks the press release from a filing folder', () => {
  const idx = (names) => ({ directory: { item: names.map((name) => ({ name })) } });
  assert.equal(pickDocument(idx(['0001-index.htm', 'acme-8k.htm', 'acme-ex991.htm']), '8k'), 'acme-ex991.htm');
  assert.equal(pickDocument(idx(['0001-index.htm', 'acme-8k.htm']), '8k'), 'acme-8k.htm');
  assert.equal(pickDocument(idx(['FilingSummary.xml', 'wf-form4_1.xml']), 'form4'), 'wf-form4_1.xml');
  assert.equal(tickerMap({ 0: { cik_str: 320193, ticker: 'AAPL' } }).get('320193'), 'AAPL');
});

test('maps press-release listings to Yahoo and XTB symbols', () => {
  const ls = extractListings('Acme (NASDAQ: ACME) and Beta (Euronext Paris: BETA; OTCQX: BTAXF), Gamma (Nasdaq Stockholm: GAM B), Delta (NYSE: BRK.B)');
  assert.deepEqual(ls.map((l) => [l.yahoo, l.xtb]), [['ACME', 'ACME.US'], ['BETA.PA', 'BETA.FR'], ['GAM-B.ST', 'GAMB.SE'], ['BRK-B', 'BRK.B.US']]);
});

test('rules: a contract with a giant scores, an offering is penalised', () => {
  const good = scoreText('Acme secures $400 million multi-year contract with Microsoft');
  assert.equal(good.score, 4);
  assert.ok(good.reasons.some((r) => /Microsoft/.test(r)));
  assert.equal(scoreText('Acme mentions Apple in a blog post').score, 0);
  assert.ok(scoreText('Acme announces proposed public offering of common stock').score < 0);
  assert.equal(scoreText('', ['1.03']).score, -5);
  assert.equal(scoreText('Acme raises full-year guidance after record revenue').score, 5);
});

test('insider clusters score, a single small buy does not', () => {
  assert.equal(scoreInsiders([{ owner: 'A', title: 'Director', value: 40e3 }]).score, 0);
  const s = scoreInsiders([{ owner: 'A', title: 'Director', value: 60e3 }, { owner: 'B', title: 'Chief Executive Officer', value: 300e3 }]);
  assert.equal(s.score, 5);
});

test('market summary converts pence and measures volume spikes', () => {
  const bars = Array.from({ length: 21 }, (_, i) => ({ time: i, close: 100, volume: i === 20 ? 4e6 : 1e6 }));
  const m = summarize({ currency: 'GBp', price: 102, bars });
  assert.equal(m.volumeRatio, 4);
  assert.ok(Math.abs(m.priceUsd - 1.326) < 1e-9);
  assert.ok(Math.abs(m.change1d - 0.02) < 1e-9);
});

test('AI answer is parsed defensively', () => {
  assert.deepEqual(parseAssessment('Sigur: {"rezumat": "Contract mare.", "impact": 7}'), { summary: 'Contract mare.', impact: 2 });
  assert.equal(parseAssessment('nu știu'), null);
  assert.equal(parseAssessment('{"impact": 1}'), null);
});

test('journal returns start at the first close after the alert', () => {
  const DAY = 86400e3;
  const bars = Array.from({ length: 70 }, (_, i) => ({ time: i * DAY, close: 100 + i }));
  const r = forwardReturns(bars, 2 * DAY + 3600e3); // during day 2's session -> entry at day 2 close
  assert.equal(r[5], 107 / 102 - 1);
  assert.equal(r[60], 162 / 102 - 1);
  const stats = journalStats([{ returns: r, bench: { 5: 0.01 } }]);
  assert.equal(stats[0].n, 1);
  assert.ok(Math.abs(stats[0].excess - (107 / 102 - 1 - 0.01)) < 1e-12);
});
