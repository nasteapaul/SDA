// End-of-day and end-of-week trade reports from IG's transaction history (closed deals).
import { tradingDay } from './state.js';

export const TZ = 'Europe/Bucharest';
const DAY = 86400e3;

// IG gives the result as text with a currency prefix, e.g. "E-53.87" or "£1,234.50".
export function parsePnl(s) {
  if (typeof s === 'number') return s;
  const digits = String(s ?? '').replace(/[^\d.-]/g, '');
  return digits ? Number(digits) : NaN;
}

// IG times like 2026-10-16T15:05:25 are UTC without a zone.
function utc(s) {
  if (typeof s !== 'string') return NaN;
  const iso = s.replace(/\//g, '-').replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

// Closed trades: { time, name, pnl }, oldest first.
export function closedTrades(transactions) {
  return (transactions ?? [])
    .filter((t) => t.transactionType === 'DEAL' || t.transactionType === 'TRADE')
    .map((t) => ({ time: utc(t.dateUtc ?? t.date), name: t.instrumentName, pnl: parsePnl(t.profitAndLoss) }))
    .filter((t) => Number.isFinite(t.time) && Number.isFinite(t.pnl))
    .sort((a, b) => a.time - b.time);
}

// Romanian days from this week's Monday up to the day of `now`.
export function weekDays(now) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now);
  const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
  return Array.from({ length: back + 1 }, (_, i) => tradingDay(now - i * DAY, TZ));
}

export const isFriday = (now) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now) === 'Fri';

const money = (n, ccy) => `${n > 0 ? '+' : ''}${n.toFixed(2)} ${ccy}`;
const sum = (trades) => trades.reduce((s, t) => s + t.pnl, 0);

export function dailyReport(trades, now, ccy = 'EUR') {
  const day = tradingDay(now, TZ);
  const today = trades.filter((t) => tradingDay(t.time, TZ) === day);
  if (!today.length) return `📊 Raport ${day}: nicio tranzacție azi.`;
  const lines = today.map((t, i) => `${i + 1}. ${t.name}: ${money(t.pnl, ccy)}`);
  return [`📊 Raport ${day}: ${today.length} ${today.length === 1 ? 'tranzacție' : 'tranzacții'}`, ...lines, `Total zi: ${money(sum(today), ccy)}`].join('\n');
}

export function weeklyReport(trades, now, ccy = 'EUR') {
  const days = new Set(weekDays(now));
  const week = trades.filter((t) => days.has(tradingDay(t.time, TZ)));
  const [first] = [...days].sort();
  const head = `📅 Raport săptămână ${first} – ${tradingDay(now, TZ)}`;
  if (!week.length) return `${head}: nicio tranzacție.`;
  const wins = week.filter((t) => t.pnl > 0).length;
  const pct = Math.round((wins / week.length) * 100);
  return [
    head,
    `Tranzacții: ${week.length}`,
    `Câștigătoare: ${wins} (${pct}%), pierzătoare: ${week.length - wins} (${100 - pct}%)`,
    `Total net: ${money(sum(week), ccy)}`,
  ].join('\n');
}
