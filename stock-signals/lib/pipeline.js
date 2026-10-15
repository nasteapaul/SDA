import { get, sleep } from './http.js';
import { parseFeed, stripTags } from './feed.js';
import { currentFeedUrl, parseCurrentEntry, folderUrl, pickDocument, parseForm4, tickerMap, SEC } from './sec.js';
import { scoreText, scoreInsiders, score13D } from './rules.js';
import { extractListings, usListing } from './tickers.js';
import { chart, summarize } from './market.js';
import { assess, ripple } from './ai.js';
import { onXtb } from './xtb.js';
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
    ['SEC 13D', () => stakeEvents(state, config, io, events)],
    ['Reddit', () => buzzEvents(state, config, io, events, now)],
    ...feeds.map((f) => [f.name, () => (f.kind === 'ripple' ? queueHeadlines(state, f, io, now) : newsEvents(state, f, io, events))]),
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

  await rippleEvents(state, config, io, events, now);

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
    if (!(await listedOnXtb(state, ev, io, now))) {
      log(`Sar peste ${ev.listing.xtb}: nu se găsește pe XTB.`);
      continue;
    }
    // GitHub Models' free tier allows about 150 calls a day; the bot now runs all day.
    const day = new Date(now).toISOString().slice(0, 10);
    if (state.ai?.day !== day) state.ai = { day, n: 0 };
    if (!ev.why && aiCalls < config.maxAiCalls && state.ai.n < config.maxAiPerDay) {
      aiCalls++;
      state.ai.n++;
      const a = await io.assess(ev);
      if (a) {
        ev.summary = a.summary;
        ev.score += a.impact;
        if (a.impact) ev.reasons.push(`AI: impact ${a.impact > 0 ? '+' : ''}${a.impact}`);
      }
    }
    if (ev.score >= config.alertScore) alerts.push(ev);
  }

  // Second-order: a strong event at one company often moves its suppliers, customers or
  // rivals later. Queue it for the knock-on AI.
  for (const ev of events) {
    if (ev.score < config.alertScore || ev.source === 'Efect în lanț' || ev.source === 'Reddit') continue;
    state.ripple ??= { queue: [], last: 0 };
    state.ripple.queue.push({ feed: `eveniment puternic la ${ev.company}`, title: ev.title.slice(0, 200), summary: ev.reasons.join('; ').slice(0, 200), link: ev.link });
    state.ripple.queue = state.ripple.queue.slice(-60);
  }

  for (const ev of alerts) {
    await io.alert(ev);
    state.lastAlert[ev.listing.xtb] = now;
    record(state, ev, now);
  }
  log(`${events.length} evenimente noi, ${candidates.length} candidați, ${alerts.length} alerte.`);
  return alerts;
}

// Paul can only act on stocks XTB offers. Answers are cached (a week if listed, a day if not);
// when xtb.com can't be reached the alert still goes out, marked as unchecked.
async function listedOnXtb(state, ev, io, now) {
  if (!io.xtb) return true;
  state.xtb ??= {};
  const key = ev.listing.xtb;
  const c = state.xtb[key];
  if (c && now - c.at < (c.ok ? 7 : 1) * DAY) return c.ok;
  try {
    const ok = await io.xtb(ev.listing);
    state.xtb[key] = { ok, at: now };
    return ok;
  } catch (e) {
    io.log?.(`XTB ${key}: ${e.message}`);
    ev.xtbUnchecked = true;
    return true;
  }
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
        shares: form.shares, after: form.after, tenPctOnly: form.owner.tenPct && !form.owner.officer && !form.owner.director,
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

// Schedule 13D: one filing shows up twice in the feed, as "Subject" (the company) and
// "Filed by" (the investor). Amendments are skipped: the first filing is the news.
async function stakeEvents(state, config, io, events) {
  const entries = parseFeed(await io.sec(currentFeedUrl('SCHEDULE 13D'))).map(parseCurrentEntry).filter(Boolean);
  const filers = new Map(entries.filter((e) => e.role !== 'Subject').map((e) => [e.acc, e.company]));
  const tickers = await io.tickers();
  let docs = 0;
  for (const f of entries) {
    if (f.role !== 'Subject' || !/^(SCHEDULE|SC) 13D$/.test(f.form) || !isNew(state, `13d:${f.acc}`)) continue;
    const ticker = tickers.get(f.cik);
    if (!ticker || docs >= config.maxSecDocs) continue;
    docs++;
    const filer = filers.get(f.acc) ?? '';
    let text = '';
    try {
      const folder = folderUrl(f.cik, f.acc);
      const doc = pickDocument(JSON.parse(await io.sec(`${folder}/index.json`)), '13d');
      if (doc) text = stripTags(await io.sec(`${folder}/${doc}`)).slice(0, 8000);
    } catch { /* the filer's name alone still scores */ }
    events.push({
      source: 'SEC 13D', company: f.company,
      title: `${filer || 'Un investitor'} a cumpărat peste 5% din ${f.company}`,
      text: text || `Schedule 13D depus de ${filer} pentru ${f.company}.`,
      link: f.link, listing: usListing(ticker), ...score13D(filer, text),
    });
  }
}

// Headlines from general and specialist sites rarely name a listing; they wait in a queue
// and every few minutes the AI reads the batch for companies that gain from them.
async function queueHeadlines(state, feed, io, now) {
  state.ripple ??= { queue: [], last: 0 };
  for (const it of parseFeed(await io.news(feed.url))) {
    if (!isNew(state, `news:${it.id || it.link}`)) continue;
    if (it.time && now - it.time > DAY) continue; // old news is already in the price
    state.ripple.queue.push({ feed: feed.name, title: it.title.slice(0, 200), summary: stripTags(it.summary).slice(0, 200), link: it.link });
  }
  state.ripple.queue = state.ripple.queue.slice(-60);
}

async function rippleEvents(state, config, io, events, now) {
  const r = state.ripple;
  if (!r?.queue.length || now - r.last < config.rippleEveryMin * 60e3) return;
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.ai?.day !== day) state.ai = { day, n: 0 };
  if (state.ai.n >= config.maxAiPerDay) return;
  state.ai.n++;
  r.last = now;
  const items = r.queue.splice(0, config.rippleBatch);
  const ideas = (await io.ripple(items)) ?? [];
  const known = new Set((await io.tickers()).values());
  for (const idea of ideas) {
    const listing = known.has(idea.ticker) ? usListing(idea.ticker) : null;
    if (!listing) continue; // the AI named something that is not a US listing
    const src = items[idea.item];
    events.push({
      source: 'Efect în lanț', company: idea.company || idea.ticker, title: src.title, text: src.title,
      link: src.link, listing, why: idea.why, score: config.alertScore - 2 + idea.confidence,
      reasons: [`AI, încredere ${idea.confidence}/3`, `știre din ${src.feed}`],
    });
  }
}

// Reddit (WallStreetBets and other stock forums), counted by apewisdom.io. What matters is a
// sudden jump in mentions against the day before, not the mood of the posts.
const FUND = /\b(ETF|Trust|Shares|Fund|Index)\b/;
async function buzzEvents(state, config, io, events, now) {
  if (!io.buzz) return;
  state.buzz ??= { last: 0 };
  if (now - state.buzz.last < config.buzzEveryMin * 60e3) return;
  state.buzz.last = now;
  const known = new Set((await io.tickers()).values());
  const day = new Date(now).toISOString().slice(0, 10);
  for (const r of await io.buzz()) {
    const before = Number(r.mentions_24h_ago) || 0;
    const ratio = r.mentions / Math.max(before, 5);
    if (r.mentions < config.buzzMinMentions || ratio < 3 || FUND.test(r.name ?? '')) continue;
    if (!known.has(r.ticker) || !isNew(state, `buzz:${r.ticker}:${day}`, now)) continue;
    const title = `${r.name} e brusc în discuție pe Reddit: ${r.mentions} mențiuni în 24 de ore, față de ${before} cu o zi înainte`;
    events.push({
      source: 'Reddit', company: r.name, title, text: title,
      link: `https://apewisdom.io/stocks/${encodeURIComponent(r.ticker)}/`, listing: usListing(r.ticker),
      score: ratio >= 6 ? 4 : 3, reasons: [`mențiuni pe Reddit de ${Math.round(ratio)}× mai multe ca ieri`],
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
    ripple: (items) => ripple(items, { token: githubToken }),
    xtb: (listing) => onXtb(listing),
    buzz: async () => (await get('https://apewisdom.io/api/v1.0/filter/all-stocks/page/1', { json: true, headers: { 'User-Agent': 'Mozilla/5.0 (stock-signals)' } }))?.results ?? [],
    alert: telegram.alert,
    notify: telegram.notify,
    dryRun,
  };
}
