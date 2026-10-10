// The few alerts worth an interruption, built from the data alone (no AI, no
// third party): bank access running out, sync failing, a bill or the card
// repayment due in the next days, a subscription that got dearer, a yearly
// renewal, a refund that is late, bills before payday that exceed the balance,
// the summary of the period that just ended, and manual values to update.
// Each alert has a stable id, so the phone notifies it once and the app can
// hide it once dismissed. Used by the app (Overview) and by GET /api/alerts.
// Pure: no DOM, used by the browser and by Node.

import { formatRON, todayISO, addMonths } from './money.js';
import { makePeriods } from './periods.js';
import { makeLedger } from './ledger.js';
import { accountView } from './accounts.js';
import { detectSeries, upcoming } from './recurring.js';
import { safeToSpend } from './safespend.js';
import { cardDue } from './cardpay.js';
import { consentStatus } from './trust.js';
import { expectedRefunds } from './refunds.js';
import { netWorth } from './networth.js';

export const ALERT_KINDS = ['consent', 'sync', 'bill', 'price', 'renewal', 'refund', 'card', 'low', 'summary', 'assets'];
const DAY = 86400000;
const BILL_DAYS = 3; // bills and the card repayment: this many days ahead
const RENEWAL_DAYS = 7; // yearly renewals: a week ahead
const PRICE_DAYS = 30; // a price rise stays news for a month
const STALE_SYNC_HOURS = 48;

const plus = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return todayISO(x); };
const dayText = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const when = (iso, today) => (iso === today ? 'today' : iso === plus(today, 1) ? 'tomorrow' : `on ${dayText(iso)}`);
const range = (lo, hi) => (Math.abs(hi - lo) < 0.5 ? formatRON(hi) : `${formatRON(lo, { short: true })}–${formatRON(hi, { short: true })}`);

/**
 * [{ id, kind, level: 'info'|'warning'|'critical', title, text, date, link }], most
 * urgent first. Kinds turned off in settings.alerts are left out.
 */
export function buildAlerts(state, { today = todayISO(), now = Date.now() } = {}) {
  if (!state) return [];
  const on = (kind) => state.settings?.alerts?.[kind] !== false;
  const out = [];
  const add = (a) => { if (on(a.kind)) out.push(a); };
  const live = (state.bank?.connections || []).filter((c) => !c.archived);
  const periods = makePeriods({ payday: state.settings?.payday, transactions: state.transactions || [], overrides: state.settings?.paydays || {} });
  const ledger = makeLedger(state);
  const key = periods.current(today);
  const end = periods.end(key);

  // Bank access (PSD2 consent): 14 and 3 days before, and once it has ended.
  for (const c of consentStatus(state, { now })) {
    if (c.level === 'ok') continue;
    const expired = c.level === 'expired';
    add({
      id: `consent:${c.bank}:${String(c.validUntil).slice(0, 10)}:${c.level}`,
      kind: 'consent',
      level: c.level === 'soon' ? 'warning' : 'critical',
      title: expired ? `Bank access to ${c.bank} has ended` : `Bank access to ${c.bank} ends in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`,
      text: expired ? 'New transactions stopped. Renew it in Settings, or import a CSV statement meanwhile.' : 'Renew it in Settings → Add or reconnect a bank. It takes about two minutes.',
      date: today,
      link: '#settings',
    });
  }

  // Sync failing or out of date (only while the access is valid).
  if (live.length && consentStatus(state, { now }).some((c) => c.level !== 'expired')) {
    const last = Date.parse(state.bank?.lastSync || '');
    if (state.bank?.lastError) {
      add({ id: `sync:error:${today}`, kind: 'sync', level: 'warning', title: 'Bank sync is failing', text: 'The last update from the bank didn’t finish. Open Settings to see why.', date: today, link: '#settings' });
    } else if (Number.isNaN(last) || now - last > STALE_SYNC_HOURS * 3600000) {
      add({ id: `sync:stale:${today}`, kind: 'sync', level: 'warning', title: 'Bank data is out of date', text: Number.isNaN(last) ? 'The bank hasn’t synced yet.' : `Last update ${dayText(todayISO(new Date(last)))}. Is the server running?`, date: today, link: '#settings' });
    }
  }

  // Bills, subscriptions and renewals (from the payments that repeat).
  const series = detectSeries(state, { today, accountOf: (t) => ledger.accountOf(t) });
  const main = ledger.mainAccount;
  // Only what leaves the current account needs money there (card subscriptions don't).
  const soon = upcoming(series, today, plus(today, BILL_DAYS)).filter((u) => !main || !u.accountId || u.accountId === main.uid);
  for (const u of soon) {
    const s = series.find((x) => x.key === u.key);
    if (s?.cadence === 'yearly') continue; // announced a week ahead below
    add({
      id: `bill:${u.key}:${u.date}`, kind: 'bill', level: 'info',
      title: `${u.label}: ${range(u.min, u.max)} ${u.late ? 'is due' : when(u.date, today)}`,
      text: u.late ? 'It was due a few days ago and hasn’t shown up yet.' : 'Make sure the money is in the account.',
      date: u.date, link: '#overview',
    });
  }
  for (const s of series) {
    if (s.status === 'ignored') continue;
    if (s.cadence === 'yearly' && s.nextDate > today && s.nextDate <= plus(today, RENEWAL_DAYS)) {
      add({ id: `renewal:${s.key}:${s.nextDate}`, kind: 'renewal', level: 'info', title: `${s.label} renews ${when(s.nextDate, today)}`, text: `About ${formatRON(s.amount)} for another year. Cancel before then if you no longer use it.`, date: s.nextDate, link: '#plan' });
    }
    const p = s.priceChange;
    if (p && Date.parse(`${p.date}T00:00:00`) >= Date.parse(`${today}T00:00:00`) - PRICE_DAYS * DAY) {
      add({ id: `price:${s.key}:${p.date}`, kind: 'price', level: 'warning', title: `${s.label} costs ${p.pct}% more`, text: `${formatRON(p.from)} → ${formatRON(p.to)} since ${dayText(p.date)}.`, date: p.date, link: '#plan' });
    }
  }

  // The card repayment still expected from the current account.
  const due = cardDue(state, ledger, periods, today);
  if (due && due.date <= plus(today, BILL_DAYS)) {
    add({ id: `card:${key}`, kind: 'card', level: 'info', title: `Credit card repayment due ${when(due.date, today)}`, text: `You usually pay ${range(due.min, due.max)}. Paying the full statement balance avoids interest.`, date: due.date, link: '#overview' });
  }

  // Refunds you're waiting for that are late.
  for (const r of expectedRefunds(state, { today })) {
    if (r.status !== 'overdue') continue;
    add({ id: `refund:${r.tx.id}:${r.due}`, kind: 'refund', level: 'warning', title: `Refund from ${r.tx.description} is late`, text: `Expected by ${dayText(r.due)} for the ${formatRON(r.tx.amount)} purchase on ${dayText(r.tx.date)}.`, date: r.due, link: '#overview' });
  }

  // Bills before payday that the balance doesn't cover.
  const v = main?.balance ? accountView(main) : null;
  if (v?.known) {
    const bills = upcoming(series, today, end).filter((u) => !u.accountId || u.accountId === main.uid);
    const safe = safeToSpend({ balance: v.cash, today, periodEnd: end, upcoming: bills, cardDue: due, buffer: Number(state.settings?.spendBuffer) || 0 });
    if (safe && safe.low < 0) {
      const short = safe.high < 0;
      add({
        id: `low:${key}:${short ? 'short' : 'tight'}`, kind: 'low', level: short ? 'critical' : 'warning',
        title: short ? 'Bills before payday are more than your balance' : 'Money is tight until payday',
        text: short ? `You’re about ${formatRON(-safe.high)} short. Move money in or postpone a payment.` : `If the bills come in high, you’ll be ${formatRON(-safe.low)} short.`,
        date: today, link: '#overview',
      });
    }
  }

  // The period that just ended, on the first two days of the new one.
  const start = periods.start(key);
  if (today >= start && today <= plus(start, 1)) {
    const prev = addMonths(key, -1);
    const t = ledger.totals((state.transactions || []).filter((x) => periods.keyOf(x.date) === prev));
    if (t.count) {
      add({
        id: `summary:${prev}`, kind: 'summary', level: 'info',
        title: `Last ${state.settings?.payday ? 'pay period' : 'month'}: ${formatRON(t.left, { sign: true })} left over`,
        text: `In ${formatRON(t.income)}, spent ${formatRON(t.spend)}, saved ${formatRON(t.saved)}.`,
        date: start, link: '#overview',
      });
    }
  }

  // Pensions, investments… entered by hand and not updated for 100+ days: once a month.
  const stale = netWorth(state, { now }).stale;
  if (stale.length) {
    add({ id: `assets:${today.slice(0, 7)}`, kind: 'assets', level: 'info', title: `Update ${stale.length === 1 ? stale[0].name : `${stale.length} values`} in your net worth`, text: 'Not updated for over three months (Goals → Net worth).', date: today, link: '#goals' });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || String(a.date).localeCompare(String(b.date)));
}
