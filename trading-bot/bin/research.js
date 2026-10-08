#!/usr/bin/env node
// Studies minute data for intraday patterns and tests strategies with realistic costs.
// Parameters are chosen on the in-sample years only; the out-of-sample years are reported
// once, untouched, so you can see whether an edge survives on data it never saw.
//
//   node bin/research.js data --split 2016 [--out report.md]
// Accepts HistData.com minute files or CSV with time,open,high,low,close.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadBars, groupDays } from '../lib/history.js';
import { runDays, stats } from '../lib/daytrade.js';
const NO_COSTS = { sessionSpread: 0, offSpread: 0, slippage: 0 };
import { orb, lastHalfHour, gapFade, emaCross, prevDayBreakout } from '../lib/strategies.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { split: { type: 'string' }, out: { type: 'string' }, 'min-trades': { type: 'string', default: '150' } },
});
if (!positionals.length) {
  console.error('Usage: node bin/research.js <minute files...> --split <first out-of-sample year> [--out report.md]');
  process.exit(1);
}

const days = groupDays(loadBars(positionals));
const years = [...new Set(days.map((d) => +d.day.slice(0, 4)))];
const split = Number(values.split ?? years[Math.floor(years.length * 0.6)]);
const minTrades = Number(values['min-trades']);
const IS = days.filter((d) => +d.day.slice(0, 4) < split);
const OOS = days.filter((d) => +d.day.slice(0, 4) >= split);
const lines = [];
const out = (s = '') => lines.push(s);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '∞');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '∞');
const row = (cells) => out(`| ${cells.join(' | ')} |`);

out(`# Cercetare DAX: ${days[0].day} → ${days.at(-1).day}`);
out();
out(`${days.length} zile de tranzacționare. Ani de dezvoltare (in-sample): ${years.filter((y) => y < split).join(', ')}. Ani de verificare (out-of-sample): ${years.filter((y) => y >= split).join(', ')}.`);
out('Costuri incluse: spread 1,2 puncte în 09:00–17:30 și 2,5 în afara orelor, plus 0,5 puncte alunecare la stop. Rezultatele sunt în puncte DAX per tranzacție (1 punct = 1 € la mărimea 1 pe contractul mini de 1 €).');
out();

// ---- Patterns ---------------------------------------------------------------
out('## Tipare');
out();
out('### Cât se mișcă DAX-ul pe ore (ora Frankfurtului)');
out();
row(['Ora', 'Mișcare medie (puncte, high-low)', 'Spread / mișcare', 'Direcție medie (puncte)']);
row(['---', '---', '---', '---']);
for (let h = 1; h < 22; h++) {
  const ranges = [], rets = [];
  for (const d of days) {
    const hb = d.bars.filter((b) => b.mod >= h * 60 && b.mod < h * 60 + 60);
    if (hb.length < 30) continue;
    ranges.push(Math.max(...hb.map((b) => b.high)) - Math.min(...hb.map((b) => b.low)));
    rets.push(hb.at(-1).close - hb[0].open);
  }
  if (!ranges.length) continue;
  const avgR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const spread = h >= 9 && h < 17 ? 1.2 : 2.5;
  row([`${String(h).padStart(2, '0')}:00`, f1(avgR), `${f1((spread / avgR) * 100)}%`, f2(rets.reduce((a, b) => a + b, 0) / rets.length)]);
}
out();

const cash = (d) => {
  const s = d.bars.filter((b) => b.mod >= 540 && b.mod < 1050);
  return s.length > 300 ? s : null;
};
out('### Zilele săptămânii (09:00 → 17:30)');
out();
row(['Zi', 'Zile', 'Medie (puncte)', '% zile pe plus']);
row(['---', '---', '---', '---']);
for (const [dow, name] of [[1, 'Luni'], [2, 'Marți'], [3, 'Miercuri'], [4, 'Joi'], [5, 'Vineri']]) {
  const r = days.filter((d) => d.dow === dow).map(cash).filter(Boolean).map((s) => s.at(-1).close - s[0].open);
  row([name, r.length, f2(r.reduce((a, b) => a + b, 0) / r.length), f1((r.filter((x) => x > 0).length / r.length) * 100)]);
}
out();

// Intraday momentum and gap fill statistics.
let agree = 0, total = 0, gapDays = 0, filledNoon = 0, filledClose = 0;
for (let i = 1; i < days.length; i++) {
  const prev = cash(days[i - 1]), cur = cash(days[i]);
  if (!prev || !cur) continue;
  const pc = prev.at(-1).close;
  const at = (mod) => cur.find((b) => b.mod >= mod);
  const b930 = at(570), b1700 = at(1020);
  if (b930 && b1700) {
    const first = b930.open - pc, last = cur.at(-1).close - b1700.open;
    if (first && last) { total++; if (Math.sign(first) === Math.sign(last)) agree++; }
  }
  const gap = cur[0].open - pc;
  if (Math.abs(gap) >= 30) {
    gapDays++;
    const hit = (bs) => bs.some((b) => (gap > 0 ? b.low <= pc : b.high >= pc));
    if (hit(cur.filter((b) => b.mod < 720))) filledNoon++;
    if (hit(cur)) filledClose++;
  }
}
let intraday = 0, overnight = 0;
for (let i = 1; i < days.length; i++) {
  const prev = cash(days[i - 1]), cur = cash(days[i]);
  if (!prev || !cur) continue;
  overnight += cur[0].open - prev.at(-1).close;
  intraday += cur.at(-1).close - cur[0].open;
}
out('### Alte tipare');
out();
out(`- **Ziua vs. noaptea:** adunate pe toată perioada, mișcările din timpul zilei (09:00→17:30) fac ${f1(intraday)} puncte, iar cele de peste noapte (17:30→09:00) ${f1(overnight)} puncte.`);
out(`- **Momentum intraday:** în ${f1((agree / total) * 100)}% din ${total} zile, direcția ultimei jumătăți de oră (17:00–17:30) a fost aceeași cu a mișcării de la închiderea de ieri până la 09:30. 50% ar însemna întâmplare.`);
out(`- **Gap-uri de peste 30 de puncte la deschidere:** ${gapDays} zile. Gap-ul s-a închis (prețul a revenit la închiderea de ieri) până la 12:00 în ${f1((filledNoon / gapDays) * 100)}% din cazuri și până la 17:30 în ${f1((filledClose / gapDays) * 100)}%.`);
out();

// ---- Strategies -------------------------------------------------------------
const candidates = [
  { name: 'EMA 9/21 + ATR, toate orele (bot-ul de acum)', grid: [{}], make: () => emaCross() },
  { name: 'EMA 9/21 + ATR, doar 09:15–17:00, închis la 17:30', grid: [{}], make: () => emaCross({ from: 555, until: 1020, exit: 1050 }) },
  {
    name: 'Opening Range Breakout',
    grid: [15, 30, 60].flatMap((rangeMin) => [null, 1, 2].flatMap((targetR) => [1, 0.5].map((stopFrac) => ({ rangeMin, targetR, stopFrac })))),
    make: (p) => orb(p),
  },
  {
    name: 'Opening Range Breakout doar în direcția trendului (20 de zile)',
    grid: [15, 30, 60].flatMap((rangeMin) => [null, 1, 2].flatMap((targetR) => [1, 0.5].map((stopFrac) => ({ rangeMin, targetR, stopFrac, trend: true })))),
    make: (p) => orb(p),
  },
  {
    name: 'Opening Range Breakout la deschiderea SUA (15:30)',
    grid: [15, 30].flatMap((rangeMin) => [null, 1, 2].flatMap((targetR) => [1, 0.5].map((stopFrac) => ({ rangeMin, targetR, stopFrac, open: 930, lastEntry: 1050, exit: 1290 })))),
    make: (p) => orb(p),
  },
  { name: 'Spargerea maximului/minimului de ieri', grid: [0.25, 0.5, 1].map((stopFrac) => ({ stopFrac })), make: (p) => prevDayBreakout(p) },
  { name: 'Momentum ultima jumătate de oră', grid: [0, 20, 50].flatMap((minMove) => [25, 50].map((stop) => ({ minMove, stop }))), make: (p) => lastHalfHour(p) },
  { name: 'Gap fade (revenire la închiderea de ieri)', grid: [20, 40, 60].flatMap((minGap) => [0.5, 1].map((stopMult) => ({ minGap, stopMult }))), make: (p) => gapFade(p) },
];

const label = (p) => Object.entries(p).filter(([k]) => !['open', 'lastEntry', 'exit', 'trend'].includes(k)).map(([k, v]) => `${k}=${v ?? '—'}`).join(' ') || 'implicit';
out('## Strategii');
out();
out(`Pentru fiecare strategie am ales parametrii doar pe anii de dezvoltare (cel mai bun câștig mediu, minimum ${minTrades} tranzacții), apoi i-am rulat o singură dată pe anii de verificare.`);
out();
row(['Strategie', 'Parametri aleși', 'Dezvoltare: tranz. / medie / PF', 'Verificare: tranz. / medie / PF / t', 'Total verificare (puncte)', 'Medie verificare fără costuri']);
row(['---', '---', '---', '---', '---', '---']);
const summary = [];
for (const c of candidates) {
  let best = null;
  for (const p of c.grid) {
    const s = stats(runDays(IS, c.make(p)));
    if (s.n >= minTrades && (!best || s.avg > best.s.avg)) best = { p, s };
  }
  if (!best) { row([c.name, '—', `sub ${minTrades} tranzacții`, '—', '—', '—']); continue; }
  const oosTrades = runDays(OOS, c.make(best.p));
  const o = stats(oosTrades);
  summary.push({ c, best, o, oosTrades });
  const gross = stats(runDays(OOS, c.make(best.p), NO_COSTS));
  row([c.name, label(best.p), `${best.s.n} / ${f2(best.s.avg)} / ${f2(best.s.pf)}`, `${o.n} / ${f2(o.avg)} / ${f2(o.pf)} / ${f2(o.t)}`, f1(o.total), f2(gross.avg)]);
}
out();
out('PF = profit factor (câștiguri / pierderi; peste 1,3 e interesant). t = cât de sigur e că media nu e zero (peste 2 e semnificativ, sub 1 e zgomot).');
out();
out('### Pe ani (perioada de verificare)');
out();
for (const { c, best, oosTrades } of summary) {
  const byYear = years.filter((y) => y >= split).map((y) => `${y}: ${f1(stats(oosTrades.filter((t) => t.year === y)).total)}`);
  out(`- **${c.name}** (${label(best.p)}): ${byYear.join(', ')} puncte`);
}
out();

const text = lines.join('\n');
if (values.out) writeFileSync(values.out, text + '\n');
console.log(text);
