// Press releases name their listing as "(Nasdaq: ABCD)" or "(Euronext Paris: XYZ)".
// Each exchange maps to a Yahoo suffix (price data) and an XTB suffix (what Paul searches
// in the XTB app). OTC and small venues are left out on purpose: XTB doesn't list them.
const EXCHANGES = [
  [/^nasdaq (stockholm|first north)/, '.ST', 'SE'],
  [/^nasdaq copenhagen/, '.CO', 'DK'],
  [/^nasdaq helsinki/, '.HE', 'FI'],
  [/^(nasdaq|nyse)( (gs|gm|cm|global select( market)?|global market|capital market|american|arca|mkt))?$/, '', 'US'],
  [/^euronext paris$/, '.PA', 'FR'],
  [/^euronext amsterdam$/, '.AS', 'NL'],
  [/^euronext brussels$/, '.BR', 'BE'],
  [/^euronext lisbon$/, '.LS', 'PT'],
  [/^(euronext milan|borsa italiana)$/, '.MI', 'IT'],
  [/^(oslo b[oø]rs|euronext oslo)$/, '.OL', 'NO'],
  [/^(xetra|fse|frankfurt( stock exchange)?)$/, '.DE', 'DE'],
  [/^(lse|london stock exchange|lse main market)$/, '.L', 'UK'],
  [/^six( swiss exchange)?$/, '.SW', 'CH'],
  [/^(bme|madrid stock exchange)$/, '.MC', 'ES'],
  [/^(wse|warsaw stock exchange|gpw)$/, '.WA', 'PL'],
];

export function listing(exchange, ticker) {
  const ex = exchange.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = ticker.toUpperCase();
  for (const [re, ysuf, xtb] of EXCHANGES) {
    if (re.test(ex)) {
      // Class shares: "BRK.B" is BRK-B on Yahoo; Nordic "VOLV B" is VOLV-B on Yahoo.
      const yahoo = (xtb === 'US' ? t.replace(/\./g, '-') : t.replace(/ /g, '-')) + ysuf;
      return { ticker: t, yahoo, xtb: `${t.replace(/ /g, '')}.${xtb}`, us: xtb === 'US' };
    }
  }
  return null;
}

export const usListing = (ticker) => listing('nasdaq', ticker);

export function extractListings(text) {
  const out = new Map();
  for (const [, inside] of text.matchAll(/\(([^()]{3,120})\)/g)) {
    for (const part of inside.split(/[,;]| and /)) {
      const m = /^\s*([A-Za-zø ]{2,40}?)\s*:\s*([A-Z0-9][A-Z0-9.\-]{0,7}(?: [A-Z])?)\s*$/.exec(part);
      if (!m) continue;
      const l = listing(m[1], m[2]);
      if (l && !out.has(l.xtb)) out.set(l.xtb, l);
    }
  }
  return [...out.values()];
}
