#!/usr/bin/env node
// Slow strategies on real ETFs (no CFD funding), 2005 onwards, with a cost per trade:
//  1. Monthly trend: each of a few ETFs is held only while its month-end price is above
//     its 10-month average, otherwise that slice sits in cash (Faber-style).
//  2. Turn of the month: S&P 500 held only from the close of the second-to-last trading
//     day of a month to the close of the 3rd trading day of the next one.
// Daily total-return prices (dividends included) come from Yahoo, Stooq as fallback.
//
//   node bin/etf-research.js [--cost 0.1] [--from 2005]
// Prints a plain-text report. Cash earns nothing, so the results are slightly pessimistic.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { cost: { type: 'string', default: '0.1' }, from: { type: 'string', default: '2005' } } });
const COST = Number(values.cost) / 100; // per buy or sell
const FROM = Number(values.from);
const TREND = ['SPY', 'EFA', 'IEF', 'VNQ', 'GLD'];

async function yahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${sym} ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const adj = r.indicators.adjclose[0].adjclose;
  return r.timestamp.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: adj[i] })).filter((d) => d.close > 0);
}

async function stooq(sym) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`);
  const rows = (await res.text()).trim().split('\n').slice(1).map((l) => l.split(','));
  if (rows.length < 100) throw new Error(`Stooq ${sym}: no data`);
  return rows.map((r) => ({ date: r[0], close: Number(r[4]) })).filter((d) => d.close > 0);
}

async function load(sym) {
  try {
    return await yahoo(sym);
  } catch (e) {
    console.error(`${e.message}, trying Stooq`);
    return stooq(sym);
  }
}

// Growth of 1 from a list of { date, ret } periods.
function summary(series) {
  let eq = 1, peak = 1, maxDd = 0;
  const years = {};
  for (const { date, ret } of series) {
    eq *= 1 + ret;
    peak = Math.max(peak, eq);
    maxDd = Math.min(maxDd, eq / peak - 1);
    const y = date.slice(0, 4);
    years[y] = (years[y] ?? 1) * (1 + ret);
  }
  const span = (Date.parse(series.at(-1).date) - Date.parse(series[0].date)) / (365.25 * 86400e3);
  return { cagr: eq ** (1 / span) - 1, maxDd, years: Object.fromEntries(Object.entries(years).map(([y, g]) => [y, g - 1])), total: eq - 1 };
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function monthEnds(rows) {
  const out = [];
  rows.forEach((d, i) => {
    if (i === rows.length - 1 || rows[i + 1].date.slice(0, 7) !== d.date.slice(0, 7)) out.push(d);
  });
  return out;
}

// Monthly trend on several ETFs, equal slices, rebalanced monthly.
function trend(data) {
  const months = TREND.map((s) => new Map(monthEnds(data[s]).map((d) => [d.date.slice(0, 7), d.close])));
  const keys = [...months[0].keys()].filter((k) => months.every((m) => m.has(k))).sort();
  const strat = [], hold = [];
  let prevIn = TREND.map(() => false);
  for (let i = 10; i < keys.length - 1; i++) {
    if (Number(keys[i].slice(0, 4)) < FROM) continue;
    let r = 0, rh = 0;
    const nowIn = TREND.map((_, a) => {
      const sma = keys.slice(i - 9, i + 1).reduce((s, k) => s + months[a].get(k), 0) / 10;
      return months[a].get(keys[i]) > sma;
    });
    TREND.forEach((_, a) => {
      const ret = months[a].get(keys[i + 1]) / months[a].get(keys[i]) - 1;
      const switched = nowIn[a] !== prevIn[a] ? COST : 0;
      r += ((nowIn[a] ? ret : 0) - switched) / TREND.length;
      rh += ret / TREND.length;
    });
    prevIn = nowIn;
    strat.push({ date: keys[i + 1], ret: r });
    hold.push({ date: keys[i + 1], ret: rh });
  }
  return { strat, hold, invested: null };
}

// Turn of the month on one index ETF, daily.
function turnOfMonth(rows, { restIn = null } = {}) {
  rows = rows.filter((d) => Number(d.date.slice(0, 4)) >= FROM);
  const other = restIn && new Map(restIn.map((d) => [d.date, d.close]));
  const inMkt = rows.map(() => false);
  let start = 0;
  for (let i = 0; i <= rows.length; i++) {
    if (i === rows.length || (i > 0 && rows[i].date.slice(0, 7) !== rows[i - 1].date.slice(0, 7))) {
      const n = i - start;
      for (let j = start; j < i; j++) {
        const fromStart = j - start + 1, fromEnd = j - i; // -1 = last day
        // The return of day j is earned if we hold from close j-1: last day of month and days 1..3.
        inMkt[j] = fromEnd === -1 || fromStart <= 3;
      }
      start = i;
      if (n === 0) break;
    }
  }
  const strat = [], hold = [];
  let held = false, invested = 0;
  for (let i = 1; i < rows.length; i++) {
    const ret = rows[i].close / rows[i - 1].close - 1;
    let r = 0;
    // Switching from bonds to the index (or back) is a sale plus a purchase.
    const sw = other ? 2 * COST : COST;
    if (inMkt[i]) {
      r = ret - (held ? 0 : sw);
      held = true;
      invested++;
    } else {
      r = held ? -sw : 0;
      held = false;
      if (other?.has(rows[i].date) && other.has(rows[i - 1].date)) r += other.get(rows[i].date) / other.get(rows[i - 1].date) - 1;
    }
    strat.push({ date: rows[i].date, ret: r });
    hold.push({ date: rows[i].date, ret });
  }
  return { strat, hold, invested: invested / (rows.length - 1) };
}

function print(title, { strat, hold, invested }, holdName) {
  const s = summary(strat), h = summary(hold);
  const halves = (series) => {
    const a = series.filter((x) => x.date < '2016'), b = series.filter((x) => x.date >= '2016');
    return `${pct(summary(a).cagr)}/an (${a[0].date.slice(0, 4)}–2015), ${pct(summary(b).cagr)}/an (2016–${b.at(-1).date.slice(0, 4)})`;
  };
  console.log(`\n=== ${title} ===`);
  console.log(`Perioada: ${strat[0].date} – ${strat.at(-1).date}, cost ${(COST * 100).toFixed(2)}% pe cumpărare/vânzare`);
  if (invested != null) console.log(`Timp în piață: ${(invested * 100).toFixed(0)}%`);
  console.log(`Strategie:   ${pct(s.cagr)}/an, scădere maximă ${pct(s.maxDd)}, total ${pct(s.total)} | ${halves(strat)}`);
  console.log(`${holdName}: ${pct(h.cagr)}/an, scădere maximă ${pct(h.maxDd)}, total ${pct(h.total)} | ${halves(hold)}`);
  console.log('An    strategie  ' + holdName);
  for (const y of Object.keys(s.years)) console.log(`${y}  ${pct(s.years[y]).padStart(8)}  ${pct(h.years[y] ?? 0).padStart(8)}`);
}

const data = {};
for (const s of [...new Set([...TREND, 'SPY', 'IEF'])]) {
  data[s] = await load(s);
  console.error(`${s}: ${data[s].length} zile, ${data[s][0].date} – ${data[s].at(-1).date}`);
}

print(`Trend lunar pe ${TREND.join(', ')} (preț peste media pe 10 luni)`, trend(data), 'Ținut mereu (egal)');
print('Sfârșit de lună pe S&P 500 (SPY), restul lunii cash', turnOfMonth(data.SPY), 'SPY ținut mereu');
print('Sfârșit de lună pe S&P 500, restul lunii în obligațiuni (IEF)', turnOfMonth(data.SPY, { restIn: data.IEF }), 'SPY ținut mereu');
