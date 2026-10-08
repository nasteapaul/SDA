import { tag, stripTags } from './feed.js';

// SEC EDGAR: free and official, no key. SEC asks for a User-Agent with a contact
// address and at most 10 requests per second.
export const SEC = 'https://www.sec.gov';

export const currentFeedUrl = (form, start = 0) =>
  `${SEC}/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&start=${start}&count=100&output=atom`;

// "8-K - Acme Corp (0000123456) (Filer)" plus "Item 1.01: ..." lines in the summary.
export function parseCurrentEntry(e) {
  const m = /^(\S+) - (.+?) \((\d{10})\) \((\w+)\)/.exec(e.title);
  if (!m) return null;
  const acc = /accession-number=([\d-]+)/.exec(e.id)?.[1] ?? /(\d{10}-\d{2}-\d{6})/.exec(e.link)?.[1];
  if (!acc) return null;
  const items = [...new Set([...stripTags(e.summary).matchAll(/Item (\d+\.\d+)/g)].map((x) => x[1]))];
  return { form: m[1], company: m[2], cik: String(Number(m[3])), role: m[4], acc, items, link: e.link, time: e.time };
}

export const folderUrl = (cik, acc) => `${SEC}/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}`;

// Picks the press release (exhibit 99) or else the main document from a filing folder listing.
export function pickDocument(index, kind) {
  const names = (index?.directory?.item ?? []).map((i) => i.name);
  if (kind === 'form4') return names.find((n) => /\.xml$/i.test(n) && !/^FilingSummary/i.test(n));
  return names.find((n) => /ex-?99/i.test(n) && /\.html?$/i.test(n))
    ?? names.find((n) => /\.html?$/i.test(n) && !/index/i.test(n));
}

const val = (block, name) => tag(tag(block, name), 'value') || tag(block, name);
const flag = (v) => v === '1' || /^true$/i.test(v);

// Form 4: who traded and how much was bought on the open market (code P).
export function parseForm4(xml) {
  const owner = {
    name: tag(xml, 'rptOwnerName'),
    title: tag(xml, 'officerTitle'),
    director: flag(tag(xml, 'isDirector')),
    officer: flag(tag(xml, 'isOfficer')),
  };
  let bought = 0;
  for (const [block] of xml.matchAll(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g)) {
    const code = tag(tag(block, 'transactionCoding'), 'transactionCode');
    const ad = val(block, 'transactionAcquiredDisposedCode');
    const shares = Number(val(block, 'transactionShares'));
    const price = Number(val(block, 'transactionPricePerShare'));
    if (code === 'P' && ad === 'A' && shares > 0 && price > 0) bought += shares * price;
  }
  return {
    issuer: { cik: String(Number(tag(xml, 'issuerCik'))), name: tag(xml, 'issuerName'), ticker: tag(xml, 'issuerTradingSymbol').toUpperCase() },
    owner,
    bought: Math.round(bought),
  };
}

// company_tickers.json: { "0": { cik_str, ticker, title }, ... } -> Map(cik -> ticker)
export function tickerMap(json) {
  const map = new Map();
  for (const r of Object.values(json ?? {})) if (!map.has(String(r.cik_str))) map.set(String(r.cik_str), r.ticker);
  return map;
}
