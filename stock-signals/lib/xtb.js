// Is this stock actually on XTB? xtb.com has a page per stock at /int/stocks/<ticker>-<market>
// (e.g. mpw-us); for a stock XTB doesn't offer, that address redirects to the /int/stocks list.
export const xtbPage = (listing) => {
  const [t, mkt] = listing.xtb.toLowerCase().split(/\.(?=[a-z]+$)/);
  return `https://www.xtb.com/int/stocks/${t.replace(/\./g, '-')}-${mkt}`;
};

// true = listed, false = not listed; throws when xtb.com can't be reached (unknown).
export async function onXtb(listing, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(xtbPage(listing), {
    headers: { 'User-Agent': 'Mozilla/5.0 (stock-signals)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${xtbPage(listing)}`);
  const path = new URL(res.url).pathname.replace(/\/+$/, '');
  return path !== '/int/stocks';
}
