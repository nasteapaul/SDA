import { get, sleep } from './http.js';
import { parseFeed, stripTags } from './feed.js';
import { currentFeedUrl, parseCurrentEntry, folderUrl, pickDocument, parseForm4, tickerMap, SEC } from './sec.js';
import { scoreText, scoreInsiders } from './rules.js';
import { extractListings, usListing } from './tickers.js';
import { chart, summarize } from './market.js';
import { assess } from './ai.js';
import { record, prune, forwardReturns, pending } from './journal.js';

const DAY = 86400e3;

// One run: gather new events, score them, enrich the best with prices and AI, alert.
// `io` carries every side effect so tests can run the whole thing offline.
export async function runOnce({ state, config, feeds, io, now = Date.now() }) {
  const log = io.log ?? console.log;
  prune(state, now);
  const events = [];
  const sources = [
    ['SEC 8-K', () => secEvents(state, config, io, events)],
    ['SEC Form 4', () => insiderEvents(state, config, io, events, now)],
    ...feeds.map((f) => [f.name, () => newsEvents(state, f, io, events)]),
  ];
  let ok = 0;
  for (const [name, fn] of sources) {
    try {
      await fn();
      ok++;
      state.health[name] = 0;
    } catch (e) {
      state.health[name] = (state.health[name] ?? 0) + 1;
      log(`${name}: ${e.message}`);
      if (state.health[name] === config.feedFailWarn) {
        await io.notify(`⚠️ Sursa „${name}” nu mai răspunde de ${config.feedFailWarn} rulări la rând. Restul surselor merg în continuare.`);
      }
    }
  }

  // First run: everything in the feeds is old news. Remember it, alert nothing.
  if (!state.warm) {
    state.warm = ok > 0;
    log(`Prima rulare: am memorat ${events.length} evenimente vechi, fără alerte.`);
    return [];
  }

  const candidates = [];
  for (const ev of events) {
    if (ev.score < config.candidateScore || !ev.listing) continue;
    const key = ev.listing.xtb;
    if (state.lastAlert[key] && now - state.lastAlert[key] < config.repeatAfterDays * DAY) continue;
    if (candidates.some((c) => c.listing.xtb === key)) continue;
    candidates.push(ev);
  }
  candidates.sort((a, b) => b.score - a.score);

  let aiCalls = 0;
  const alerts = [];
  for (const ev of candidates) {
    try {
      ev.market = summarize(await io.chart(ev.listing.yahoo));
      if (ev.market.dollarVolume < config.minDollarVolume || ev.market.priceUsd < config.minPriceUsd) {
        log(`Sar peste ${ev.listing.xtb}: prea mică sau prea puțin lichidă.`);
        continue;
      }
      if (ev.market.volumeRatio >= 3) { ev.score += 1; ev.reasons.push('volum de peste 3× media'); }
    } catch {
      ev.market = null; // no price context; still worth sending if the event is strong
    }
    if (aiCalls < config.maxAiCalls) {
      aiCalls++;
      const a = await io.assess(ev);
      if (a) {
        ev.summary = a.summary;
        ev.score += a.impact;
        if (a.impact) ev.reasons.push(`AI: impact ${a.impact > 0 ? '+' : ''}${a.impact}`);
      }
    }
    if (ev.score >= config.alertScore) alerts.push(ev);
  }

  for (const ev of alerts) {
    await io.alert(ev);
    state.lastAlert[ev.listing.xtb] = now;
    record(state, ev, now);
  }
  log(`${events.length} evenimente noi, ${candidates.length} candidați, ${alerts.length} alerte.`);
  return alerts;
}

const isNew = (state, id, now = Date.now()) => {
  if (state.seen[id]) return false;
  state.seen[id] = now;
  return true;
};

async function secEvents(state, config, io, events) {
  const fresh = [];
  for (let p = 0; p < config.secPages; p++) {
    const entries = parseFeed(await io.sec(currentFeedUrl('8-K', p * 100))).map(parseCurrentEntry).filter(Boolean);
    const unseen = entries.filter((e) => !state.seen[`8k:${e.acc}`]);
    fresh.push(...unseen);
    if (unseen.length < entries.length) break; // reached what the last run already read
  }
  const tickers = await io.tickers();
  let docs = 0;
  for (const f of fresh) {
    if (!isNew(state, `8k:${f.acc}`)) continue;
    const ticker = tickers.get(f.cik);
    const { score } = scoreText('', f.items);
    // Only filings that report a deal, results or other news are worth opening.
    const interesting = f.items.some((i) => ['1.01', '2.01', '2.02', '7.01', '8.01'].includes(i));
    if (!ticker || !interesting || score < 0 || docs >= config.maxSecDocs) continue;
    docs++;
    let text = '';
    try {
      const folder = folderUrl(f.cik, f.acc);
      const doc = pickDocument(JSON.parse(await io.sec(`${folder}/index.json`)), '8k');
      if (doc) text = stripTags(await io.sec(`${folder}/${doc}`)).slice(0, 8000);
    } catch { /* the item numbers alone still score */ }
    const scored = scoreText(text, f.items);
    events.push({
      source: 'SEC 8-K', company: f.company, title: firstSentence(text) || `8-K: ${f.items.join(', ')}`,
      text, link: f.link, listing: usListing(ticker), ...scored,
    });
  }
}

async function insiderEvents(state, config, io, events, now) {
  const fresh = [];
  for (let p = 0; p < config.secPages; p++) {
    const entries = parseFeed(await io.sec(currentFeedUrl('4', p * 100))).map(parseCurrentEntry)
      .filter((e) => e && e.role === 'Issuer' && e.form === '4');
    const unseen = entries.filter((e) => !state.seen[`f4:${e.acc}`]);
    fresh.push(...unseen);
    if (unseen.length < entries.length) break;
  }
  const touched = new Set();
  let n = 0;
  for (const f of fresh) {
    if (!isNew(state, `f4:${f.acc}`) || n >= config.maxForm4) continue;
    n++;
    try {
      const folder = folderUrl(f.cik, f.acc);
      const doc = pickDocument(JSON.parse(await io.sec(`${folder}/index.json`)), 'form4');
      if (!doc) continue;
      const form = parseForm4(await io.sec(`${folder}/${doc}`));
      if (!form.bought || !form.issuer.ticker) continue;
      const cik = form.issuer.cik;
      (state.insiders[cik] ??= []).push({
        owner: form.owner.name, title: form.owner.title, value: form.bought, time: now,
        ticker: form.issuer.ticker, company: form.issuer.name, link: f.link,
      });
      touched.add(cik);
    } catch { /* one bad filing must not stop the rest */ }
  }
  for (const cik of touched) {
    const buys = state.insiders[cik];
    const s = scoreInsiders(buys);
    if (!s.score) continue;
    const last = buys.at(-1);
    const names = [...new Set(buys.map((b) => `${b.owner}${b.title ? ` (${b.title})` : ''}`))].slice(0, 4).join(', ');
    events.push({
      source: 'SEC Form 4', company: last.company,
      title: `Insiderii au cumpărat acțiuni de ${(s.total / 1e3).toFixed(0)} mii $ în ultimele 30 de zile`,
      text: `Cumpărări pe piață ale insiderilor: ${names}. Total ${s.total} $.`,
      link: last.link, listing: usListing(last.ticker), score: s.score, reasons: s.reasons,
    });
  }
}

async function newsEvents(state, feed, io, events) {
  const items = parseFeed(await io.news(feed.url));
  for (const it of items) {
    if (!isNew(state, `news:${it.id || it.link}`)) continue;
    const text = `${it.title}. ${stripTags(it.summary)}`;
    const scored = scoreText(text);
    if (scored.score <= 0) continue;
    const [listing] = extractListings(text);
    if (!listing) continue;
    events.push({
      source: feed.name, company: companyFrom(it.title), title: it.title, text,
      link: it.link, listing, ...scored,
    });
  }
}

const firstSentence = (t) => (/^(.{20,200}?[.!?])\s/.exec(t)?.[1] ?? '').trim();
const companyFrom = (title) => title.split(/ (announces|reports|to |receives|wins|secures|signs|enters|raises|completes)/i)[0].slice(0, 80);

// Fills in 5/20/60-day returns for past alerts, once a day.
export async function updateJournal(state, io, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.journalDay === day) return;
  state.journalDay = day;
  const cache = new Map();
  const bars = async (sym) => {
    if (!cache.has(sym)) cache.set(sym, io.chart(sym, '1y').then((c) => c.bars).catch(() => null));
    return cache.get(sym);
  };
  for (const e of state.journal.filter(pending)) {
    const b = await bars(e.yahoo);
    if (!b) continue;
    e.returns = forwardReturns(b, e.time);
    const bb = await bars(e.benchmark);
    if (bb) e.bench = forwardReturns(bb, e.time);
  }
}

export function makeIo({ secAgent, githubToken, telegram, dryRun, log = console.log }) {
  let tickers;
  const secHeaders = { 'User-Agent': secAgent, 'Accept-Encoding': 'gzip, deflate' };
  return {
    log,
    sec: async (url) => { await sleep(150); return get(url, { headers: secHeaders }); },
    news: (url) => get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (stock-signals)' } }),
    tickers: async () => (tickers ??= tickerMap(await get(`${SEC}/files/company_tickers.json`, { json: true, headers: secHeaders }))),
    chart: (sym, range) => chart(sym, { range }),
    assess: (ev) => assess(ev, { token: githubToken }),
    alert: telegram.alert,
    notify: telegram.notify,
    dryRun,
  };
}
