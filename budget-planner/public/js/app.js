import { Data } from './data.js';
import { esc, categoryBars, trendChart, attachTooltips } from './charts.js';
import {
  formatRON, parseAmount, round2, todayISO, monthKey, addMonths, monthLabel, daysInMonth, monthsBetween, uid,
} from './shared/money.js';
import { SAVINGS_CATEGORY, merchantKey, escapeForRule, isUselessKeyword, ruleMatches } from './shared/categories.js';
import { analyzeHistory, buildPlan, goalSaved, INTENSITY, cardPeriod, cardPace } from './shared/planner.js';
import { reconcile } from './shared/reconcile.js';
import { csvToTransactions } from './shared/csv.js';
import { ACCOUNT_KINDS, accountKind, accountView, bankTotals, balanceMeaning } from './shared/accounts.js';
import { ownContext, isOwnTransfer } from './shared/own.js';
import { makePeriods } from './shared/periods.js';
import { makeLedger, COUNT_MODES } from './shared/ledger.js';
// ux-3: add/edit modal + CSV import preview
import { categorize } from './shared/categories.js';
import { ownTransferCategory } from './shared/own.js';
import { importSeen, isSameTransaction } from './shared/dedupe.js';
// foundation: SVG icons (named svgIcon here — icon() below is the category emoji)
import { icon as svgIcon, iconTile } from './icons.js';
import { collapsible } from './collapse.js';

const data = new Data();
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const modal = $('#modal');
const modalForm = $('#modal-form');

// Transactions filters. month: null = current period, '' = all months.
const TX_DEFAULTS = Object.freeze({ q: '', type: '', category: '', account: '', counted: false, month: null, limit: 150 });

const ui = {
  route: 'overview',
  params: new URLSearchParams(),
  month: null, // budget period shown on the Overview (null = current)
  tx: { ...TX_DEFAULTS },
  planGoals: null, // null = all active goals
  banks: null,
  csvPreview: null,
  installPrompt: null,
};

// ---------------------------------------------------------------- helpers
const S = () => data.state;

// Budget periods: calendar months, or payday to payday (Settings → Budget month).
let periodsCache = null;
let periodsKey = '';
function P() {
  const k = `${S().updatedAt}|${S().settings?.payday || ''}|${JSON.stringify(S().settings?.paydays || {})}|${S().transactions.length}`;
  if (k !== periodsKey) {
    periodsCache = makePeriods({ payday: S().settings?.payday, transactions: S().transactions, overrides: S().settings?.paydays || {} });
    periodsKey = k;
  }
  return periodsCache;
}

// How each transaction counts (current-account cash flow by default).
let ledgerCache = null;
let ledgerKey = '';
function L() {
  const k = `${S().updatedAt}|${S().settings?.countMode || ''}|${S().settings?.mainAccountId || ''}`;
  if (k !== ledgerKey) { ledgerCache = makeLedger(S()); ledgerKey = k; }
  return ledgerCache;
}
const counts = (t) => L().counts(t);
const keyOf = (date) => P().keyOf(date);
const cat = (name) => S().categories.find((c) => c.name === name) || { name, icon: '•', kind: 'expense' };
const icon = (name) => cat(name).icon || '•';

function summary(key) {
  let income = 0; let spend = 0; let saved = 0; let count = 0; let ownIn = 0;
  const own = ownContext(S());
  for (const t of S().transactions) {
    if (keyOf(t.date) !== key) continue;
    const e = L().effect(t); // a shop refund lowers spending instead of counting as income
    if (!e.as) continue;
    count += 1; // transactions that count (current account)
    if (e.as === 'saved') saved += e.amount;
    else if (e.as === 'income') { income += e.amount; if (isOwnTransfer(t, own) || /depunere numerar|cash deposit/i.test(`${t.description} ${t.note || ''}`)) ownIn += e.amount; }
    else spend += e.amount;
  }
  return { income: round2(income), spend: round2(spend), saved: round2(saved), left: round2(income - spend - saved), count, ownIn: round2(ownIn) };
}

function spendingByCategory(key) {
  const map = new Map();
  for (const t of S().transactions) {
    if (keyOf(t.date) !== key) continue;
    const e = L().effect(t);
    if (e.as !== 'expense') continue;
    const m = map.get(e.category) || { name: e.category, icon: icon(e.category), value: 0, count: 0 };
    m.value += e.amount; m.count += 1;
    map.set(e.category, m);
  }
  const budgets = S().budgets || {};
  for (const [name, limit] of Object.entries(budgets)) {
    if (!map.has(name) && cat(name).kind !== 'income') map.set(name, { name, icon: icon(name), value: 0, count: 0 });
    map.get(name).limit = limit;
  }
  return [...map.values()].map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.value - a.value || (b.limit || 0) - (a.limit || 0));
}

function goalsWithProgress() {
  return S().goals.map((g) => {
    const saved = goalSaved(g, S().transactions);
    return { ...g, saved, pct: g.target ? Math.min(saved / g.target, 1) : 0, done: saved >= g.target };
  });
}

function currentPlan(goalIds = ui.planGoals) {
  // With a payday, habits are measured per pay period instead of per calendar month.
  const p = P();
  // Money into the current account is income even if it carries a savings/transfer category.
  const counted = S().transactions.flatMap((t) => {
    const e = L().effect(t);
    if (!e.as) return [];
    if (counts(t) === 'refund') return [{ ...t, type: 'expense', amount: e.amount, category: e.category }];
    return [L().mode === 'cashflow' && e.as === 'income' && cat(t.category).role ? { ...t, category: 'Other income' } : t];
  });
  const txs = p.payday ? counted.map((t) => ({ ...t, date: p.pseudoDate(t.date) })) : counted;
  const analysis = analyzeHistory(txs, S().categories, { today: p.payday ? p.pseudoDate(todayISO()) : todayISO() });
  const goals = goalsWithProgress().filter((g) => !g.done && (!goalIds || goalIds.includes(g.id)));
  return { analysis, plan: buildPlan(analysis, goals, { today: todayISO(), intensity: S().settings?.planIntensity || 'balanced' }) };
}

function fmtDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', opts);
}

// ---------------------------------------------------------------- foundation: card titles + date fields
// Card heading with an icon tile: cardTitle('bank', 'Bank connection').
// tone: '' (accent) | neutral | good | warning | critical. after: trusted HTML appended to the title.
function cardTitle(iconName, text, { tone = '', after = '' } = {}) {
  return `<h2 class="card-title">${iconTile(iconName, { tone })}<span>${esc(text)}${after}</span></h2>`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ATTR_NAME = /^[a-z][a-z0-9-]*$/i;

/**
 * A date input that always reads "9 Oct 2026": a styled box with the native
 * <input type="date"> stretched transparently over it, so a tap opens the
 * phone's own picker but the text shown is never an ambiguous 09/10/2026.
 *   dateField({ name: 'date', value: t.date, attrs: { required: true } })
 *   dateField({ value: P().start(k), label: 'Salary date', attrs: { 'data-action': 'salary-date', 'data-key': k }, cls: 'compact' })
 * attrs: extra attributes for the <input>, as an object (values escaped; true = bare
 * attribute, false/null = left out) or a trusted string. label: aria-label.
 * cls: 'compact' (36px high, for rows) and/or 'block' (full width; automatic inside .field).
 */
function dateField({ name = '', value = '', attrs = '', label = '', placeholder = 'Pick a date', cls = '' } = {}) {
  const iso = ISO_DAY.test(value || '') ? value : '';
  const extra = typeof attrs === 'string' ? attrs : Object.entries(attrs || {})
    .filter(([k, v]) => ATTR_NAME.test(k) && v !== false && v != null)
    .map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`)).join(' ');
  const off = /(^|\s)(disabled|readonly)(\s|=|$)/i.test(extra);
  return `<span class="date-field${cls ? ` ${esc(cls)}` : ''}${off ? ' is-disabled' : ''}">${svgIcon('calendar', { size: 18 })}`
    + `<span class="date-field-text${iso ? '' : ' placeholder'}" data-placeholder="${esc(placeholder)}">${esc(iso ? fmtDate(iso) : placeholder)}</span>`
    + `<input type="date"${name ? ` name="${esc(name)}"` : ''} value="${esc(iso)}"${label ? ` aria-label="${esc(label)}"` : ''}${extra ? ` ${extra}` : ''}></span>`;
}

export { cardTitle, dateField }; // for UI checks in the browser: (await import('/js/app.js')).dateField(…)

// Keeps the visible text in step with the picker (views that re-render redraw it anyway).
function syncDateField(input) {
  const out = input.closest('.date-field')?.querySelector('.date-field-text');
  if (!out) return;
  const iso = ISO_DAY.test(input.value) ? input.value : '';
  out.textContent = iso ? fmtDate(iso) : out.dataset.placeholder || '';
  out.classList.toggle('placeholder', !iso);
}
for (const type of ['input', 'change']) {
  document.addEventListener(type, (e) => { if (e.target.matches?.('.date-field input')) syncDateField(e.target); });
}
// With a mouse, browsers only open the calendar from its small icon: open it from anywhere in the box.
document.addEventListener('click', (e) => {
  const input = e.target.closest?.('.date-field input');
  if (!input || input.disabled || input.readOnly || !window.matchMedia?.('(pointer: fine)').matches) return;
  try { input.showPicker?.(); } catch { /* not allowed here; the native control still works */ }
});

function dayHeading(iso) {
  const today = todayISO();
  const yest = todayISO(new Date(Date.now() - 86400000));
  if (iso === today) return 'Today';
  if (iso === yest) return 'Yesterday';
  return fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short', year: iso.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
}

function amountHTML(t) {
  const income = t.type === 'income';
  return `<span class="num ${income ? 'pos' : ''}">${income ? '+' : '−'}${formatRON(t.amount)}</span>`;
}

function statusChip(status) {
  const map = {
    'on-track': ['good', 'On track'],
    'needs-cuts': ['warning', 'Needs small cuts'],
    stretch: ['serious', 'Stretch'],
    'at-risk': ['serious', 'At risk'],
    overdue: ['critical', 'Overdue'],
    done: ['good', 'Reached'],
  };
  const [cls, label] = map[status] || ['', status];
  return `<span class="status ${cls}">${label}</span>`;
}

// Toast tone from the wording when the caller doesn't say: problems get the alert
// icon, known confirmations a check, anything else the neutral info icon.
const TOAST_BAD = /couldn['’]?t|can['’]?t|cannot|failed|error|unable|invalid|expired|denied|refused|offline|timed? ?out|unavailable|too many|not (allowed|found|configured|reach|linked|enough)|\b[45]\d\d\b/i;
const TOAST_GOOD = /^(saved|transaction (added|deleted|restored)|goal (created|saved|deleted|added)|rule (saved|deleted)|account updated|withdrawn|budgets set|bank (synced|linked)|imported|import undone|removed|categories updated|totals updated|main current account|budget months|got it|already up to date)|added to /i;
const TOAST_ICONS = { good: 'check', critical: 'alert', info: 'info' };

let toastTimer;
/** toast('Saved'), toast('Deleted', { label: 'Undo', run }), toast(err.message, null, { tone: 'critical' }). */
function toast(msg, action, { tone } = {}) {
  const el = $('#toast');
  const text = String(msg ?? '');
  const t = TOAST_ICONS[tone] ? tone : TOAST_BAD.test(text) ? 'critical' : TOAST_GOOD.test(text) ? 'good' : 'info';
  el.className = `toast ${t}`;
  el.setAttribute('role', t === 'critical' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ico">${svgIcon(TOAST_ICONS[t], { size: 20 })}</span><span class="toast-text">${esc(text)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : t === 'critical' ? 5000 : 3000);
}

function txIcon(t) {
  return t.goalId ? (S().goals.find((g) => g.id === t.goalId)?.icon || icon(t.category)) : icon(t.category);
}

// Short name of an account for chips and filters: the nickname, else "Current ··7204", "Card ··8391"
// (O1: never the bank's account name, which is the holder's full name). See accountName().
function accountLabel(a) {
  return accountName(a, { short: true });
}

// Bank text often arrives in capitals ("CARREFOUR MARKET RO ORADEA"): show it as
// "Carrefour Market RO Oradea". Display only — the stored description never changes.
// Tokens with digits, short codes (RO, SA) and known abbreviations keep their capitals.
const KEEP_CAPS = new Set(['SRL', 'PFA', 'ING', 'BCR', 'BRD', 'CEC', 'OTP', 'OMV', 'MOL', 'ATM', 'POS', 'IBAN', 'USA', 'KFC', 'SMS', 'RCS', 'RDS', 'UPC', 'EON', 'ANAF', 'CFR', 'STB', 'RATB', 'HBO']);
const SMALL_WORDS = new Set(['LA', 'DE', 'DIN', 'SI', 'ȘI', 'ŞI', 'CU', 'PE', 'IN', 'ÎN', 'PT']); // "Plata la POS Profi"
function displayDesc(text) {
  const s = String(text || '').trim();
  if (/\p{Ll}/u.test(s) || (s.match(/\p{Lu}/gu) || []).length < 4) return s;
  let first = true;
  return s.split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    const out = /\d/.test(tok) ? tok : tok.replace(/\p{L}+/gu, (w, i, all) => {
      if (i > 0 && /['’]/.test(all[i - 1])) return w.toLocaleLowerCase('ro-RO'); // VINNY'S → Vinny's
      if (!first && w === all && SMALL_WORDS.has(w)) return w.toLocaleLowerCase('ro-RO');
      if (w.length <= 2 || KEEP_CAPS.has(w)) return w;
      return w[0] + w.slice(1).toLocaleLowerCase('ro-RO');
    });
    first = false;
    return out;
  }).join('');
}

// "−120,00" / "+3.500,00": list rows leave out " RON" (the totals above say RON).
// Not converted yet: the original amount and currency instead.
function rowAmount(t) {
  const sign = t.type === 'income' ? '+' : '−';
  if (t.needsFx) return `${sign}${t.originalAmount != null && t.originalCurrency ? `${amountFmt.format(Number(t.originalAmount))} ${t.originalCurrency}` : '? RON'}`;
  return `${sign}${amountFmt.format(Number(t.amount) || 0)}`;
}

/**
 * One transaction: category emoji tile · description (+ category, account, badges) · amount.
 * showDate: line 2 starts with the date (lists without day headers, e.g. Overview "Recent").
 */
function txRow(t, { showDelete = true, showDate = !showDelete } = {}) {
  const acc = L().accountOf(t);
  const counted = Boolean(counts(t));
  const income = t.type === 'income';
  const accLabel = acc && acc !== L().mainAccount ? accountLabel(acc) : null;
  // Converted from another currency: the original amount and the rate go on line 2.
  const fx = t.originalAmount != null && t.originalCurrency && t.originalCurrency !== 'RON';
  const orig = fx && !t.needsFx ? `${amountFmt.format(Number(t.originalAmount))} ${t.originalCurrency}${t.exchangeRate ? ` @ ${Number(t.exchangeRate).toLocaleString('ro-RO', { maximumFractionDigits: 4 })}` : ''}` : '';
  const meta = [showDate ? fmtDate(t.date, { day: 'numeric', month: 'short' }) : '', t.category, t.source === 'manual' && !t.goalId ? 'Manual' : ''].filter(Boolean).join(' · ');
  const tags = [
    accLabel ? `<span class="tx-acct">${svgIcon(accountView(acc).kind === 'credit' ? 'card' : 'wallet', { size: 13 })}${esc(accLabel)}</span>` : '',
    counted ? '' : '<span class="badge tx-badge">Not counted</span>',
    t.date > todayISO() ? '<span class="badge warning tx-badge" title="Dated in the future">Future</span>' : '',
    t.needsFx ? '<span class="badge warning tx-badge" title="Not converted to RON yet">Needs conversion</span>' : '',
  ].join('');
  const amtCls = !counted ? ' uncounted' : income ? ' pos' : '';
  return `<div class="tx" role="button" tabindex="0" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="ico-tile neutral lg tx-ico" aria-hidden="true">${esc(txIcon(t))}</span>
    <span class="tx-main">
      <span class="tx-line"><span class="tx-desc">${esc(displayDesc(t.description) || t.category)}</span><span class="tx-amt num${amtCls}">${esc(rowAmount(t))}</span></span>
      <span class="tx-line tx-line2"><span class="tx-meta"><span class="tx-meta-text">${esc(meta)}</span>${tags}</span>${orig ? `<span class="tx-orig num">${esc(orig)}</span>` : ''}</span>
    </span>
    ${showDelete ? `<button class="tx-del btn ghost icon-only small" type="button" data-action="delete-tx" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.description)}" title="Delete">${svgIcon('trash', { size: 18 })}</button>` : ''}
  </div>`;
}

function sortTx(list) {
  return [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ---------------------------------------------------------------- views
const views = {
  overview() {
    const key = ui.month || P().current();
    const isCurrent = key === P().current();
    const s = summary(key);
    const rows = spendingByCategory(key);
    const accounts = S().bank.connections.flatMap((c) => c.accounts).filter((a) => a.balance);
    const used = s.income ? Math.min((s.spend + s.saved) / s.income, 1) : 0;
    const daysLeft = isCurrent ? P().daysLeft(key) : 0;
    const months = Array.from({ length: 6 }, (_, i) => addMonths(key, i - 5)).map((k) => ({ key: k, ...summary(k) }));
    const goals = goalsWithProgress().filter((g) => !g.archived).slice(0, 4);
    const recent = sortTx(S().transactions.filter((t) => keyOf(t.date) === key)).slice(0, 6);
    const budgetTotal = rows.reduce((sum, r) => sum + (r.limit || 0), 0);

    // G11: a brand-new budget (no transactions, no bank) gets a welcome card instead of a wall of zeros.
    if (!S().transactions.length && !linkedAccounts().length) return welcomeCard(goals);

    const salaryDay = P().payday ? new Date(P().start(key)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const salarySet = Boolean(S().settings?.paydays?.[key]);
    const before = prevSamePoint(key);
    // Income / Spending / Saved: one grouped list, each row opens the matching transactions.
    const flowRow = ({ href, icon: ico, tone, label, value, cls = '', sub = '' }) => `<a class="row ov-row" href="${href}">
        ${iconTile(ico, { tone })}
        <span class="ov-row-main">
          <span class="ov-row-top"><span class="row-label">${label}</span><span class="ov-row-value num ${cls}">${value}</span></span>
          ${sub ? `<span class="sub">${sub}</span>` : ''}
        </span>
        ${svgIcon('chevron-right', { size: 18, cls: 'ov-go' })}
      </a>`;
    const incomeSub = s.ownIn
      ? `${formatRON(s.income - s.ownIn, { short: true })} earned + ${formatRON(s.ownIn, { short: true })} from your own accounts or cash`
      : pctChange(s.income, before.income, isCurrent, true);
    const spendSub = budgetTotal
      ? `Budget ${formatRON(budgetTotal, { short: true })}${s.spend > budgetTotal ? ` · ${formatRON(s.spend - budgetTotal, { short: true })} over` : ` · ${formatRON(budgetTotal - s.spend, { short: true })} left`}`
      : pctChange(s.spend, before.spend, isCurrent, false);
    const linkHead = (href, text) => `<a class="link" href="${href}">${esc(text)}${svgIcon('chevron-right', { size: 16 })}</a>`;

    return `
      <div class="ov-period">
        <div class="month-switch" role="group" aria-label="Month">
          <button class="btn ghost icon-only" type="button" data-action="month" data-delta="-1" aria-label="Previous month">${svgIcon('chevron-left')}</button>
          <span class="ms-label"><span class="ms-month">${esc(P().label(key))}</span>${P().payday ? `<span class="ms-range">${esc(P().rangeLabel(key))}</span>` : ''}</span>
          <button class="btn ghost icon-only" type="button" data-action="month" data-delta="1" aria-label="Next month">${svgIcon('chevron-right')}</button>
        </div>
        ${P().payday ? `<button class="btn ov-salary" type="button" data-action="edit-payday" data-key="${esc(key)}" title="Change the salary date for this period">${svgIcon('calendar')}<span>Salary · ${esc(salaryDay)}</span>${salarySet ? '<span class="badge accent">Set</span>' : ''}${svgIcon('edit', { size: 16, cls: 'ov-salary-edit' })}</button>` : ''}
      </div>
      ${unassignedBanner()}
      ${s.count ? '' : `<div class="banner info ov-banner">${iconTile('info', { tone: 'accent' })}<div><b>No current-account transactions ${isCurrent ? 'yet this period' : 'in this period'}</b>
        <div class="small muted">${isCurrent
          ? (linkedAccounts().length ? 'New ones show up after the next bank sync.' : 'Add one with the + button, or import a statement in Settings.')
          : `${linkedAccounts().length ? 'The bank connection only goes back about 90 days. ' : ''}For older months, import the current account’s CSV statement in Settings and pick the current account.`}</div></div></div>`}
      <div class="ov-top">
        ${heroCard({ s, key, isCurrent, used, daysLeft })}
        <div class="card ov-flow" role="group" aria-label="This period">
          <div class="list ov-bleed">
            ${flowRow({ href: txLink({ month: key, type: 'income', counted: 1 }), icon: 'arrow-down-left', tone: 'good', label: 'Income', value: formatRON(s.income), cls: s.income > 0 ? 'pos' : '', sub: incomeSub })}
            ${flowRow({ href: txLink({ month: key, type: 'expense', counted: 1 }), icon: 'arrow-up-right', tone: 'accent', label: 'Spending', value: formatRON(s.spend), sub: spendSub })}
            ${flowRow({ href: txLink({ month: key, type: 'saved', counted: 1 }), icon: 'savings', tone: 'neutral', label: 'Saved to goals', value: formatRON(s.saved), sub: s.income ? `${Math.round((s.saved / s.income) * 100)}% of income` : '' })}
          </div>
        </div>
      </div>
      ${accountsStrip()}
      ${creditCardPanel(key)}
      <div class="grid two ov-grid">
        <div class="stack">
          <div class="card">
            <div class="card-head">${cardTitle('pie', 'Spending by category')}${linkHead('#plan', 'Budgets')}</div>
            ${categoryBars(rows.filter((r) => r.value > 0 || r.limit), s.spend, {
              split: (items) => moreRows({ key: 'overview.categories', rows: items, shown: 5, title: 'More categories', cls: 'ov-more-bleed', wrap: (h) => `<div class="bars" role="list">${h}</div>` }),
            })}
          </div>
          <div class="card">
            <div class="card-head">${cardTitle('bars', 'Income vs spending')}
              <div class="legend"><span><i style="background:var(--series-1)"></i>Income</span><span><i style="background:var(--series-2)"></i>Spending</span></div>
            </div>
            ${trendChart(months.map((m) => ({ ...m, noData: !m.count, partial: isPartialPeriod(m.key) })))}
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head">${cardTitle('goals', 'Goals')}${goals.length ? linkHead('#goals', 'All goals') : ''}</div>
            ${goals.length ? `<div class="list ov-bleed">${goals.map((g) => `
              <a class="row ov-row ov-goal" href="#goals">
                <span class="ico-tile neutral" aria-hidden="true">${esc(g.icon || '🎯')}</span>
                <span class="ov-row-main">
                  <span class="ov-row-top"><span class="row-label">${esc(g.name)}</span><span class="ov-row-value"><span class="num">${formatRON(g.saved, { short: true })}</span> <span class="muted num">of ${formatRON(g.target, { short: true })}</span></span></span>
                  <span class="progress" role="progressbar" aria-valuenow="${Math.round(g.pct * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)}"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></span>
                </span>
                ${svgIcon('chevron-right', { size: 18, cls: 'ov-go' })}
              </a>`).join('')}</div>` : emptyState({ icon: 'goals', title: 'No goals yet', text: 'Save for a holiday, an emergency fund or anything else.', action: '<button class="btn primary" type="button" data-action="add-goal">Add a goal</button>' })}
          </div>
          <div class="card">
            <div class="card-head">${cardTitle('transactions', 'Recent')}${recent.length ? linkHead('#transactions', 'See all') : ''}</div>
            ${recent.length
              ? moreRows({ key: 'overview.recent', rows: recent.map((t) => txRow(t, { showDelete: false })), shown: 3, title: 'Earlier this period', wrap: (h) => `<div class="tx-list">${h}</div>` })
              : `<div class="tx-list">${emptyState({ icon: 'transactions', title: 'Nothing in this period yet', text: 'New transactions show up here as soon as they sync.' })}</div>`}
          </div>
        </div>
      </div>`;
  },

  transactions() {
    const f = ui.tx;
    const q = f.q.toLowerCase();
    const month = f.month === null ? P().current() : f.month;
    const accounts = S().bank.connections.flatMap((c) => c.accounts || []);
    const account = f.account === 'none' || accounts.some((a) => a.uid === f.account) ? f.account : '';
    const typeOk = (t) => {
      if (f.counted) {
        const e = L().effect(t); // refund-aware: a shop refund shows under spending
        return Boolean(e.as) && (!f.type || e.as === f.type);
      }
      if (!f.type) return true;
      return f.type === 'saved' ? Boolean(t.goalId) : t.type === f.type;
    };
    const accountOk = (t) => {
      if (!account) return true;
      const acc = L().accountOf(t);
      return account === 'none' ? !acc : acc?.uid === account;
    };
    const list = sortTx(S().transactions.filter((t) => (!month || keyOf(t.date) === month)
      && typeOk(t) && accountOk(t)
      && (!f.category || t.category === f.category)
      && (!q || `${t.description} ${t.note || ''} ${t.category}`.toLowerCase().includes(q))));
    const counted = L().totals(list);
    // Nothing in the list counts (e.g. only credit-card rows): show the plain sums, labelled.
    const raw = !counted.count && list.length > 0;
    const income = raw ? round2(list.filter((t) => t.type === 'income' && !t.needsFx).reduce((n, t) => n + t.amount, 0)) : counted.income;
    const spend = raw ? round2(list.filter((t) => t.type === 'expense' && !t.needsFx).reduce((n, t) => n + t.amount, 0)) : counted.spend;
    const monthsWithData = [...new Set([P().current(), ...(month ? [month] : []), ...S().transactions.map((t) => keyOf(t.date))])].sort().reverse();
    const active = [f.q, f.type, f.category, account, f.counted, month !== P().current()].filter(Boolean).length;
    const filtered = active > 0;

    // Day groups: a heading (with what was spent that day) above a card of rows.
    const days = [];
    for (const t of list.slice(0, f.limit)) {
      if (days.at(-1)?.date !== t.date) days.push({ date: t.date, txs: [] });
      days.at(-1).txs.push(t);
    }
    const dayHTML = ({ date, txs }) => {
      const spent = round2(list.filter((x) => x.date === date).reduce((n, x) => { const e = L().effect(x); return e.as === 'expense' ? n + e.amount : n; }, 0));
      return `<section class="tx-group" aria-label="${esc(dayHeading(date))}"><h3 class="tx-day"><span>${esc(dayHeading(date))}</span>${spent > 0 ? `<span class="num" title="Spent this day">−${esc(amountFmt.format(spent))}</span>` : ''}</h3>`
        + `<div class="card tx-list">${txs.map((t) => txRow(t)).join('')}</div></section>`;
    };
    // The plain current-period list keeps the latest days in view (≈ 20 rows) and puts the
    // rest in a minimizable "Earlier this period" section. Searches and filters show everything.
    let recentDays = days;
    let olderDays = [];
    if (!filtered) {
      let shown = 0;
      const cut = days.findIndex((d) => { const over = shown >= 20; shown += d.txs.length; return over; });
      const rest = cut > 0 ? days.slice(cut) : [];
      if (rest.reduce((n, d) => n + d.txs.length, 0) >= 6) { recentDays = days.slice(0, cut); olderDays = rest; }
    }
    const olderCount = olderDays.reduce((n, d) => n + d.txs.length, 0);
    const groups = recentDays.map(dayHTML).join('') + (olderDays.length ? collapsible({
      key: 'transactions.earlier',
      cls: 'tx-earlier',
      icon: iconTile('clock', { tone: 'neutral' }),
      title: `Earlier this ${P().payday ? 'period' : 'month'}<span class="collapse-sub">${esc(fmtDate(olderDays.at(-1).date, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(olderDays[0].date, { day: 'numeric', month: 'short' }))}</span>`,
      count: `${olderCount}`,
      body: olderDays.map(dayHTML).join(''),
    }) : '');

    // Filter chips: the visible text is the short choice; the native <select> is laid
    // transparently over it (so the phone's own picker opens and long names never get cut).
    const fchip = (filter, aria, text, on, options, ico = '') => `<label class="fchip${on ? ' active' : ''}">${ico}<span class="fchip-val">${esc(text)}</span>${svgIcon('chevron-down', { size: 16 })}<select data-filter="${filter}" aria-label="${aria}">${options}</select></label>`;
    const TYPES = { expense: 'Expenses', income: 'Income', saved: 'Saved to goals' };
    const accText = account === 'none' ? 'No account' : account ? accountLabel(accounts.find((a) => a.uid === account)) : 'Account';
    const chips = [
      filtered ? `<button class="fchip fclear" type="button" data-action="tx-clear">${svgIcon('x', { size: 16 })}<span class="fchip-val">Clear ${active === 1 ? 'filter' : `${active} filters`}</span></button>` : '',
      // With a payday the period's dates say more than its name ("10 Sept – 8 Oct", not "September 2026").
      fchip('month', 'Month', month ? (P().payday ? P().rangeLabel(month) : P().label(month)) : 'All months', month !== P().current(),
        `<option value="">All months</option>${monthsWithData.map((k) => `<option value="${k}" ${k === month ? 'selected' : ''}>${esc(P().label(k))}${P().payday ? ` (${esc(P().rangeLabel(k))})` : ''}</option>`).join('')}`,
        svgIcon('calendar', { size: 16 })),
      fchip('type', 'Type', TYPES[f.type] || 'Type', Boolean(f.type),
        `<option value="">All types</option>${Object.entries(TYPES).map(([v, label]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${label}</option>`).join('')}`),
      fchip('category', 'Category', f.category ? `${icon(f.category)} ${f.category}` : 'Category', Boolean(f.category),
        `<option value="">All categories</option>${S().categories.map((c) => `<option ${c.name === f.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`),
      accounts.length ? fchip('account', 'Account', accText, Boolean(account),
        `<option value="">All accounts</option>${accounts.map((a) => `<option value="${esc(a.uid)}" ${a.uid === account ? 'selected' : ''}>${esc(accountLabel(a))}${a === L().mainAccount ? ' (main)' : ''}</option>`).join('')}<option value="none" ${account === 'none' ? 'selected' : ''}>No account (cash / other)</option>`) : '',
      `<button class="fchip toggle${f.counted ? ' active' : ''}" type="button" aria-pressed="${f.counted}" data-action="${f.counted ? 'tx-uncounted' : 'tx-counted'}" title="${f.counted ? 'Also show transactions that don’t count' : 'Hide transactions that don’t count in the budget'}">${svgIcon(f.counted ? 'check' : 'sliders', { size: 16 })}<span class="fchip-val">Only what counts</span></button>`,
    ].join('');

    // In / Out / Net: a strip that wraps on content (no fixed columns) so big amounts never get cut.
    const sumCell = (label, n, cls, ico) => `<div class="sum-cell sum-${label.toLowerCase()}"><span class="sum-label">${svgIcon(ico, { size: 14 })}${label}</span><b class="sum-val num ${cls}">${esc(formatRON(n, { sign: label === 'Net' }).replace(/\s*RON$/, ''))}<span class="cur"> RON</span></b></div>`;
    const summary = list.length ? `<div class="card txv-sum" aria-label="Totals">
        <div class="txv-sum-head"><span>${list.length} transaction${list.length === 1 ? '' : 's'}</span>${raw ? '<span class="badge">Not counted in your budget</span>' : counted.count && counted.count < list.length ? `<span class="badge">${counted.count} counted</span>` : ''}</div>
        <div class="txv-sum-cells">${sumCell('In', income, 'pos', 'arrow-down-left')}${sumCell('Out', spend, '', 'arrow-up-right')}${sumCell('Net', income - spend, income - spend < 0 ? 'neg' : '', 'wallet')}</div>
      </div>` : '';

    const btn = (action, label, cls = '') => `<button class="btn${cls}" type="button" data-action="${action}">${label}</button>`;
    let empty;
    if (!S().transactions.length) {
      empty = `<div class="card empty">${iconTile('transactions', { tone: 'neutral' })}<b>No transactions yet</b><span>Link your bank or import a statement in Settings, or add one by hand.</span>
        <div class="empty-actions">${btn('add-tx', `${svgIcon('plus')}Add transaction`, ' primary')}<a class="btn" href="#settings">${svgIcon('bank')}Bank and import</a></div></div>`;
    } else {
      const where = !month ? '' : month === P().current() ? ` this ${P().payday ? 'period' : 'month'}` : ` in ${esc(P().label(month))}`;
      empty = `<div class="card empty">${iconTile(filtered ? 'search' : 'calendar', { tone: 'neutral' })}<b>${filtered ? 'Nothing matches' : `No transactions${where}`}</b><span>${filtered ? `No transactions${where} match these filters.` : 'Nothing has come in or gone out yet.'}</span>
        <div class="empty-actions">${month ? btn('tx-all-months', 'Search all months', ' primary') : ''}${filtered ? btn('tx-clear', 'Clear filters', month ? '' : ' primary') : btn('add-tx', `${svgIcon('plus')}Add transaction`)}</div></div>`;
    }
    return `
      <div class="txv">
        <div class="txv-search">${svgIcon('search', { size: 18 })}<input type="search" placeholder="Search transactions" value="${esc(f.q)}" data-filter="q" aria-label="Search" enterkeyhint="search"></div>
        <div class="txv-filters" role="group" aria-label="Filters">${chips}</div>
        ${summary}
        <div class="tx-groups">${groups || empty}</div>
        ${list.length > f.limit ? `<div class="txv-more"><button class="btn" type="button" data-action="more-tx">Show more</button><span class="caption">${f.limit} of ${list.length} shown</span></div>` : ''}
      </div>`;
  },

  goals() {
    const { plan } = currentPlan(null);
    const goals = goalsWithProgress();
    const card = (g) => {
      const p = plan.goals.find((x) => x.id === g.id);
      const monthsLeft = g.deadline ? monthsBetween(todayISO(), g.deadline) : null;
      const needed = g.deadline && !g.done ? (g.target - g.saved) / Math.max(monthsLeft, 1) : null;
      const status = g.done ? 'done' : p?.status;
      // GO2: a flexible goal has no "needs", but the plan still sets money aside for it each month.
      const planned = !g.deadline && !g.done && p?.eta ? (g.target - g.saved) / Math.max(monthsBetween(todayISO(), p.eta), 1) : null;
      const perMonth = g.done ? '—' : g.deadline ? formatRON(needed, { short: true }) : planned != null ? `≈ ${formatRON(planned, { short: true })}` : 'Not funded yet';
      const priority = PRIORITY_LABELS[g.priority] || PRIORITY_LABELS.medium;
      return `<div class="card goal">
        <div class="goal-top">
          <span class="ico-tile neutral lg goal-ico" aria-hidden="true">${esc(g.icon || '🎯')}</span>
          <div class="goal-head">
            <h2 class="goal-name">${esc(g.name)}</h2>
            <div class="goal-tags">${status ? statusChip(status) : ''}<span class="badge">${priority}</span></div>
          </div>
          <button class="btn ghost icon-only goal-edit" type="button" data-action="edit-goal" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}" title="Edit goal">${svgIcon('edit')}</button>
        </div>
        <div class="goal-amounts"><span class="goal-saved">${bigAmount(g.saved)}</span><span class="goal-of">of <span class="num">${formatRON(g.target)}</span> · ${Math.round(g.pct * 100)}%</span></div>
        <div class="progress" role="progressbar" aria-valuenow="${Math.round(g.pct * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)} progress"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></div>
        <div class="goal-facts">
          <div><span>Remaining</span><b class="num">${formatRON(Math.max(g.target - g.saved, 0))}</b></div>
          <div><span>Deadline</span><b>${g.deadline ? fmtDate(g.deadline) : 'No deadline'}</b></div>
          <div><span>${g.deadline ? 'Needs per month' : 'Planned per month'}</span><b class="num">${perMonth}</b></div>
          <div><span>${g.done ? 'Status' : 'Ready by'}</span><b>${g.done ? 'Reached' : p?.eta ? fmtDate(p.eta, { month: 'short', year: 'numeric' }) : '—'}</b></div>
        </div>
        <div class="goal-actions">
          <button class="btn primary" type="button" data-action="contribute" data-id="${esc(g.id)}">${svgIcon('plus')}Add money</button>
          <button class="btn" type="button" data-action="withdraw" data-id="${esc(g.id)}">Withdraw</button>
        </div>
      </div>`;
    };
    // Long lists stay short: 4 goals in view, the rest and the reached ones minimized.
    const active = goals.filter((g) => !g.done);
    const reached = goals.filter((g) => g.done);
    const grid = (html) => `<div class="goals-grid">${html}</div>`;
    if (!goals.length) {
      return `<div class="card">${emptyState({
        icon: 'goals', title: 'No goals yet', text: 'A holiday, an emergency fund, a new laptop — add as many as you like and save towards them at the same time.',
        action: `<button class="btn primary" type="button" data-action="add-goal">${svgIcon('plus')}Create your first goal</button>`,
      })}</div>`;
    }
    return `
      <div class="goals-head">
        <p class="muted">Save towards several goals at once. The Plan tab shows how to reach them from your real spending.</p>
        <button class="btn primary" type="button" data-action="add-goal">${svgIcon('plus')}New goal</button>
      </div>
      ${goalsVsSavings(goals)}
      ${active.length ? moreRows({ key: 'goals.more', rows: active.map(card), shown: 4, title: 'More goals', wrap: grid, cls: 'ov-more-page' }) : ''}
      ${reached.length ? collapsible({ key: 'goals.reached', title: 'Reached goals', count: reached.length, body: grid(reached.map(card).join('')), cls: 'ov-more ov-more-page' }) : ''}`;
  },

  plan() {
    const all = goalsWithProgress().filter((g) => !g.done);
    const { analysis, plan } = currentPlan();
    const intensity = S().settings?.planIntensity || 'balanced';
    if (analysis.status === 'no-data') {
      return `<div class="card">${emptyState({
        icon: 'plan', title: 'Not enough history yet',
        text: 'The plan learns from your real spending. Link your bank or import a CSV statement, or add a few weeks of transactions.',
        action: `<a class="btn primary" href="#settings">${svgIcon('bank')}Connect bank or import</a><button class="btn" type="button" data-action="add-tx">${svgIcon('plus')}Add a transaction</button>`,
      })}</div>`;
    }
    const selected = ui.planGoals || all.map((g) => g.id);
    const banner = {
      'on-track': ['check', 'good', 'You can reach these goals without changing your habits', 'Keep saving the amount below every month.'],
      'needs-cuts': ['sliders', 'accent', 'Reachable with a few small cuts', 'Trim the flexible categories below and every goal stays on schedule.'],
      stretch: ['alert', 'warning', 'Not every goal fits your current budget', 'The plan gets you as close as possible. See the realistic dates and the tips below.'],
    }[plan.status];
    const budgetsApplied = plan.budgets.every((b) => S().budgets?.[b.name] === b.limit);
    const short = (n) => formatRON(n, { short: true });
    const month = (iso) => fmtDate(iso, { month: 'short', year: 'numeric' });
    const n = analysis.monthKeys.length;
    const stat = (label, value, sub, cls = '') => `<div class="card pl-stat"><span class="pl-stat-label">${label}</span><span class="pl-stat-value num ${cls}">${value}</span><span class="pl-stat-sub">${sub}</span></div>`;
    const hint = INTENSITY[intensity]?.hint || '';
    const tips = plan.tips.map(tipRow);
    const TIPS_SHOWN = 4;
    return `
      <div class="stack plan">
        <div class="card plan-controls">
          <div class="pc-block">
            <span class="section-label">How hard should the plan push?</span>
            <div class="segmented" role="group" aria-label="Plan intensity">${Object.entries(INTENSITY).map(([k, v]) => `<button type="button" data-action="intensity" data-value="${k}" aria-pressed="${k === intensity}" title="${esc(v.hint)}">${v.label}</button>`).join('')}</div>
            ${hint ? `<span class="caption">${esc(hint.charAt(0).toUpperCase() + hint.slice(1))}</span>` : ''}
          </div>
          <div class="pc-block">
            <span class="section-label">Goals in this plan</span>
            ${all.length ? `<div class="goal-check">${all.map((g) => `<label class="chip-check"><input type="checkbox" data-action="plan-goal" value="${esc(g.id)}" ${selected.includes(g.id) ? 'checked' : ''}><span aria-hidden="true">${esc(g.icon || '🎯')}</span><span>${esc(g.name)}</span></label>`).join('')}</div>` : `<a class="btn" href="#goals">${svgIcon('plus')}Add a goal to plan for</a>`}
          </div>
          ${dataCoverage()}
        </div>
        <div class="plan-summary">
          ${stat('Income / month', short(plan.income), `Average of ${n} month${n === 1 ? '' : 's'}`)}
          ${stat('Spending / month', short(plan.spend), 'Excl. savings and transfers')}
          ${stat('Free / month', short(plan.surplus), `Goals need ${short(plan.totalRequired)}`, plan.surplus < 0 ? 'neg' : '')}
          ${stat('Save / month', short(plan.monthlySaving), `≈ ${short(plan.perWeek)} a week`)}
        </div>
        ${debtBanner()}
        ${banner ? `<div class="banner callout">${iconTile(banner[0], { tone: banner[1] })}<div><b>${esc(banner[2])}</b><div class="muted small">${esc(banner[3])}</div></div></div>` : ''}
        ${plan.goals.length ? `<div class="card">
          <div class="card-head">${cardTitle('flag', 'Goal timeline')}</div>
          ${moreRows({ key: 'plan.timeline', shown: 5, title: 'More goals', wrap: (h) => `<div class="list">${h}</div>`, rows: plan.goals.map((g) => `<div class="row ov-row pl-row">
              <span class="ico-tile neutral" aria-hidden="true">${esc(S().goals.find((x) => x.id === g.id)?.icon || '🎯')}</span>
              <span class="ov-row-main">
                <span class="ov-row-top"><span class="row-label">${esc(g.name)}</span>${statusChip(g.status)}</span>
                <span class="sub">${g.eta ? `Ready ${esc(month(g.eta))}` : 'Not funded yet'}${g.deadline ? ` · due ${esc(month(g.deadline))}` : ' · no deadline'}</span>
                <span class="sub"><span class="num">${short(g.remaining)}</span> to go${g.deadline ? ` · needs <span class="num">${short(g.required)}</span> a month` : ''}</span>
              </span>
            </div>`) })}
        </div>` : ''}
        <div class="grid two">
          <div class="card">
            <div class="card-head">${cardTitle('sliders', 'Suggested monthly budgets')}
              <button class="btn small ${budgetsApplied ? '' : 'primary'}" type="button" data-action="apply-budgets" ${budgetsApplied ? 'disabled' : ''}>${budgetsApplied ? `${svgIcon('check')}Applied` : 'Use as my budgets'}</button>
            </div>
            <div class="pl-list-head"><span>Category</span><span>Budget / month</span></div>
            ${moreRows({ key: 'plan.budgets', shown: 5, title: 'More categories', wrap: (h) => `<div class="list">${h}</div>`, rows: plan.budgets.map((b) => {
              const diff = b.limit - b.avg;
              return `<div class="row ov-row pl-row">
                <span class="ico-tile neutral" aria-hidden="true">${esc(b.icon)}</span>
                <span class="ov-row-main">
                  <span class="ov-row-top"><span class="row-label">${esc(b.name)}</span><span class="ov-row-value num">${short(b.limit)}</span></span>
                  <span class="sub">You spend <span class="num">${short(b.avg)}</span>${diff < -1 ? ` · <span class="pos"><span class="num">${short(-diff)}</span> less</span>` : ''}${b.essential ? ' · essential' : ''}</span>
                </span>
              </div>`;
            }) })}
            <p class="caption pl-foot">Essential categories (rent, bills, groceries, transport, health) are never cut. Choose which ones are essential in Settings.</p>
          </div>
          <div class="stack">
            <div class="card"><div class="card-head">${cardTitle('bulb', 'What to do')}</div>
              ${tips.length ? moreRows({ key: 'plan.tips', rows: tips, shown: TIPS_SHOWN, title: 'More tips', wrap: (h) => `<ul class="list pl-tips">${h}</ul>` })
                : `<ul class="list pl-tips">${tipRow({ level: 'good', text: 'Nothing to change. Nice.' })}</ul>`}
            </div>
            ${analysis.recurring.length ? `<div class="card"><div class="card-head">${cardTitle('repeat', 'Recurring payments')}</div>
              ${moreRows({ key: 'plan.recurring', shown: 4, title: 'More payments', wrap: (h) => `<div class="list">${h}</div>`, rows: analysis.recurring.map((r) => `<div class="row ov-row pl-row">
                <span class="ico-tile neutral" aria-hidden="true">${esc(icon(r.category))}</span>
                <span class="ov-row-main">
                  <span class="ov-row-top"><span class="row-label pl-rec">${esc(r.label)}</span><span class="ov-row-value num">${short(r.avg)}</span></span>
                  <span class="sub">${esc(r.category)} · every month</span>
                </span>
              </div>`) })}</div>` : ''}
          </div>
        </div>
      </div>`;
  },

  // screens-settings: grouped sections; long lists are minimizable (shared collapsible()).
  settings() {
    const b = S().bank;
    const accounts = b.connections.flatMap((c) => c.accounts.map((a) => ({ ...a, bank: c.bank, validUntil: c.validUntil, sessionId: c.sessionId, archived: Boolean(c.archived) })));
    const group = (id, label, cards) => `<section class="ss-group" aria-labelledby="ss-g-${id}">
        <div class="section-label" id="ss-g-${id}">${esc(label)}</div>${cards}</section>`;
    return `
      <div class="grid two ss-settings">
        <div class="stack ss-col">
          ${group('bank', 'Accounts & data', bankCardHTML(b, accounts) + importCardHTML(b))}
          ${group('budget', 'Budget', countModeCardHTML() + budgetMonthCardHTML())}
        </div>
        <div class="stack ss-col">
          ${group('cats', 'Categories & rules', categoriesCardHTML() + rulesCardHTML())}
          ${group('app', 'App', appCardHTML() + trashCardHTML())}
          ${group('danger', 'Danger zone', dangerCardHTML(b))}
        </div>
      </div>`;
  },
};

// ---------------------------------------------------------------- settings (screens-settings)
// Settings cards. Every data-action, id and field name is the same as before;
// only the layout changed: grouped sections, long lists minimized with the
// shared collapsible() (keys 'settings.*'), destructive actions in a
// "Danger zone" at the end.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const last4Of = (a) => accountDigits(a); // same digits as accountName() ("7204", the card on the current account)
const NO_BREAK = String.fromCharCode(160);

// Settings uses the shared account name (nickname, otherwise "Current account ··7204").
const settingsAccountName = (a) => accountName(a);

const ACCOUNT_ICON = { current: 'wallet', savings: 'savings', credit: 'card' };

// ---- Accounts & data: bank connection
function bankCardHTML(b, accounts) {
  const flash = ui.params.get('bank');
  const banner = (tone, ico, html) => `<div class="banner ${tone} ss-banner" role="status"><span class="banner-ico" aria-hidden="true">${svgIcon(ico, { size: 20 })}</span><div>${html}</div></div>`;
  const sync = b.connections.length
    ? `<button class="btn small ss-sync${b.syncing ? ' is-syncing' : ''}" type="button" data-action="sync-bank" title="Sync now" ${b.syncing ? 'disabled' : ''}>${svgIcon('refresh')}<span class="ss-sync-label">${b.syncing ? 'Syncing…' : 'Sync now'}</span></button>` : '';
  let body;
  if (!b.configured) {
    body = `<p class="ss-help">Bank sync runs on your home server through <b>Enable Banking</b> (PSD2 open banking, free for your own accounts: BT, BCR, BRD, ING, Raiffeisen, CEC, Revolut and more).</p>
      <p class="ss-help">To turn it on, set <code class="inline">EB_APP_ID</code> and <code class="inline">EB_PRIVATE_KEY_PATH</code> in the server’s <code class="inline">.env</code> file and restart it. The README has a 5-minute walkthrough.</p>`;
  } else {
    const link = `<div class="ss-link">
        <label class="field">Bank
          <select id="bank-select"><option value="">${ui.banks ? 'Choose your bank…' : 'Loading banks…'}</option>${(ui.banks || []).map((x) => `<option>${esc(x.name)}</option>`).join('')}</select>
        </label>
        <button class="btn primary block" type="button" data-action="link-bank">${svgIcon('link')}Connect bank</button>
        ${window.BudgetApp ? '<p class="ss-help">Your bank’s login opens in the browser. When it says the bank is linked, come back here.</p>' : ''}
        <details class="ss-more-help"><summary>Redirect didn’t come back to the app?</summary>
          <p class="ss-help">Register <code class="inline">${esc(b.redirectUrl)}</code> as a redirect URL in the Enable Banking control panel. If your bank sent you to a different page, paste its full address here:</p>
          <div class="ss-inline-form"><input id="bank-landed" placeholder="https://…?code=…" aria-label="Address the bank sent you to"><button class="btn" type="button" data-action="complete-bank">Finish</button></div>
        </details>
      </div>`;
    body = accounts.length
      ? `${bankAccountsHTML(accounts)}${collapsible({ key: 'settings.bank-link', title: 'Add or reconnect a bank', body: link })}`
      : `<p class="ss-help">Link your bank to import transactions and balances automatically.</p>${link}`;
  }
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('bank', 'Bank connection')}${sync}</div>
      ${flash === 'linked' ? banner('good', 'check', '<b>Bank linked.</b> Importing your transactions now…') : ''}
      ${flash === 'error' ? banner('critical', 'alert', `<b>Bank linking didn’t finish.</b> <span class="muted">${esc(ui.params.get('reason') || '')}</span>`) : ''}
      ${body}
    </div>`;
}

// Linked accounts: one freshness line for the card, one row per account, and the
// prompts that keep the totals honest (card balance meaning / limit).
function bankAccountsHTML(accounts) {
  const b = S().bank;
  if (!accounts.length) return '<p class="ss-help">No bank linked yet.</p>';
  const live = accounts.filter((a) => !a.archived);
  const until = live.map((a) => a.validUntil?.slice(0, 10)).filter(Boolean).sort()[0];
  const renewSoon = until && (Date.parse(until) - Date.now()) / (24 * HOUR) < 14;
  const stale = ageHours(b.lastSync) > 12;
  const fresh = `<div class="ss-fresh">
      <span class="ss-fresh-item">${svgIcon('clock', { size: 16 })}<span>${b.lastSync ? `Updated ${esc(bankTime(b.lastSync))}` : 'Not synced yet'}</span>${b.lastSync && stale ? '<span class="badge warning">Stale</span>' : ''}</span>
      ${until ? `<span class="ss-fresh-item">${svgIcon('lock', { size: 16 })}<span>Bank access until ${esc(fmtDate(until))}</span>${renewSoon ? '<span class="badge warning">Renew soon</span>' : ''}</span>` : ''}
    </div>`;
  const rows = accounts.map((a) => {
    const v = accountView(a);
    const name = settingsAccountName(a);
    const amount = v.excludedForeign ? `${esc(String(v.amount))} ${esc(v.currency)}`
      : !v.known ? '—' : v.kind === 'credit' ? formatRON(v.owed) : formatRON(v.cash);
    const details = [a.bank, a.nickname && last4Of(a) ? `··${last4Of(a)}` : ''];
    if (a.archived) details.push(`old link${a.lastSyncDate ? `, last balance ${fmtDate(a.lastSyncDate)}` : ''}`);
    else if (v.kind === 'credit') details.push(v.limit ? `${formatRON(v.available)} available of ${formatRON(v.limit, { short: true })}` : 'no credit limit set');
    let prompt = '';
    if (v.excludedForeign) {
      prompt = `<div class="ss-note">${svgIcon('info', { size: 18 })}<span>Not in your totals: no RON exchange rate for ${esc(v.currency)} yet.</span></div>`;
    } else if (v.kind === 'credit' && v.balanceUncertain && !a.archived) {
      const raw = Number(a.balance?.amount);
      prompt = v.limit
        ? `<div class="ss-note warn">${svgIcon('alert', { size: 18 })}<div class="ss-note-body"><span>The bank reports <b class="num">${formatRON(Math.abs(raw))}</b> for this card. Is that what you owe, or what you can still spend?</span>
            <span class="ss-note-actions"><button class="btn small" type="button" data-action="balance-meaning" data-id="${esc(a.uid)}" data-value="owed">What I owe</button>
            <button class="btn small" type="button" data-action="balance-meaning" data-id="${esc(a.uid)}" data-value="available">What I can spend</button></span></div></div>`
        : `<div class="ss-note warn">${svgIcon('alert', { size: 18 })}<div class="ss-note-body"><span>Enter the card’s credit limit so the app can work out how much you owe.</span>
            <span class="ss-note-actions"><button class="btn small" type="button" data-action="edit-account" data-id="${esc(a.uid)}">Set limit</button></span></div></div>`;
    }
    return `<div class="ss-acct${a.archived ? ' is-archived' : ''}">
      ${iconTile(ACCOUNT_ICON[v.kind] || 'wallet', { tone: 'neutral' })}
      <div class="ss-acct-body"><div class="ss-acct-grid">
        <span class="ss-acct-name">${esc(name)}</span>
        <span class="ss-acct-amt"><span class="num">${amount}</span>${v.kind === 'credit' && v.known ? '<span class="ss-acct-owed">owed</span>' : ''}</span>
        <span class="ss-acct-sub">${esc(details.filter(Boolean).join(' · '))}</span>
      </div></div>
      <button class="btn small icon-only ghost ss-icon-btn" type="button" data-action="edit-account" data-id="${esc(a.uid)}" aria-label="Edit ${esc(name)}" title="Account settings">${svgIcon('edit')}</button>
      ${prompt}
    </div>`;
  }).join('');
  const currents = live.filter((a) => accountView(a).kind === 'current');
  const main = L().mainAccount;
  const chosen = S().settings?.mainAccountId || '';
  const mainSelect = currents.length ? `<label class="field ss-main">Main current account
      <select data-action="main-account">
        <option value="" ${chosen ? '' : 'selected'}>Automatic${main && !chosen && last4Of(main) ? ` (··${esc(last4Of(main))})` : ''}</option>
        ${currents.map((a) => `<option value="${esc(a.uid)}" ${a.uid === chosen ? 'selected' : ''}>${esc(settingsAccountName(a))}</option>`).join('')}
      </select>
      <span class="ss-help">Its money in and out is your income and spending. Other accounts are for information.</span></label>` : '';
  let error = '';
  if (b.lastError) {
    const { lines, parts } = friendlyBankError(b.lastError);
    error = `<div class="banner critical ss-banner"><span class="banner-ico" aria-hidden="true">${svgIcon('alert', { size: 20 })}</span><div class="ss-error-body"><b>Last bank sync failed</b>
      ${lines.map((l) => `<div class="small">${esc(l)}</div>`).join('')}
      <details class="ss-more-help"><summary>Technical details</summary><ul class="ux1-raw small muted">${parts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details></div></div>`;
  }
  return `${fresh}${error}${collapsible({ key: 'settings.accounts', title: 'Accounts', count: accounts.length, open: true, body: `<div class="ss-accts">${rows}</div>` })}${mainSelect}`;
}

// ---- Accounts & data: CSV import
function importCardHTML(b) {
  const file = ui.csvPreview && ui.csvFile ? ui.csvFile : '';
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('upload', 'Import a CSV statement')}</div>
      <p class="ss-help">Exports from BT, BCR, ING, Raiffeisen, BRD, Revolut and most other banks work. Duplicates are skipped.</p>
      <div class="ss-file">
        <label class="btn ss-file-btn">${svgIcon('file')}<span>Choose CSV file</span><input class="sr-only" type="file" accept=".csv,text/csv,text/plain" data-action="csv-file" aria-label="CSV file"></label>
        <span class="ss-file-name${file ? '' : ' muted'}">${file ? esc(file) : 'No file chosen'}</span>
      </div>
      ${ui.csvPreview ? csvPreviewHTML(b) : ''}
    </div>`;
}

// ---- Budget: what counts
const COUNT_MODE_COPY = {
  cashflow: ['Current account', 'Money in is income, money out is spending'],
  all: ['All accounts', 'Card purchases count, card repayments don’t'],
};
function countModeCardHTML() {
  const options = Object.entries(COUNT_MODES).map(([k, label]) => {
    const [title, sub] = COUNT_MODE_COPY[k] || [label, ''];
    return `<label class="ss-option"><input type="radio" name="count-mode" data-action="count-mode" value="${esc(k)}" ${L().mode === k ? 'checked' : ''}>
        <span><span class="row-label">${esc(title)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span></label>`;
  }).join('');
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('sliders', 'Income and spending')}</div>
      <div class="ss-options" role="radiogroup" aria-label="What counts as income and spending">${options}</div>
      <details class="ss-more-help"><summary>How this works</summary>
        <p class="ss-help">${L().mode === 'cashflow'
          ? 'Income is everything coming into your current account; spending is everything leaving it, including paying off the credit card. “Left over” is then exactly how much the current account balance changed. Card and savings transactions are listed (marked “not counted”) but not added up, so nothing counts twice.'
          : 'Every account is added up: credit-card purchases are spending, and paying off the card is a transfer.'}</p>
      </details>
    </div>`;
}

// ---- Budget: budget month + salary date per month
function budgetMonthCardHTML() {
  const payday = S().settings?.payday;
  const seg = (value, label, on) => `<label><input class="sr-only" type="radio" name="period-mode" data-action="period-mode" value="${value}" ${on ? 'checked' : ''}><span>${label}</span></label>`;
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('calendar', 'Budget month')}</div>
      <p class="ss-help">Start each month on payday, so “left to spend” lasts until the next salary.</p>
      <div class="segmented ss-seg" role="radiogroup" aria-label="Budget month">${seg('calendar', 'Calendar month', !payday)}${seg('payday', 'From payday', Boolean(payday))}</div>
      <div class="list ss-list">
        <div class="row"${payday ? '' : ' hidden'}><span><span class="row-label">Payday</span><span class="sub">Day of the month. A weekend payday moves to the nearest weekday.</span></span>
          <input class="ss-day" type="number" min="1" max="28" inputmode="numeric" data-action="payday-day" value="${esc(String(payday || 10))}" aria-label="Payday, day of the month"></div>
      </div>
      ${payday ? salaryDatesHTML() : ''}
    </div>`;
}

// 12 months (next one first): the 3 most recent as rows, the rest behind "Show all".
function salaryDatesHTML() {
  const keys = Array.from({ length: 12 }, (_, i) => addMonths(P().current(), 1 - i));
  const row = (k) => {
    const set = S().settings?.paydays?.[k];
    const month = P().label(k, { month: 'short', year: 'numeric' });
    return `<div class="row ss-salary">
        <span><span class="row-label">${esc(month)}</span> <span class="badge${set ? ' accent' : ''}">${set ? 'Set' : 'Auto'}</span>
          <span class="sub">${esc(P().rangeLabel(k))}${k === P().current() ? ' · now' : ''}</span></span>
        <span class="ss-salary-edit">${dateField({ value: P().start(k), label: `Salary date, ${P().label(k)}`, attrs: { 'data-action': 'salary-date', 'data-key': k }, cls: 'compact' })}${set
          ? `<button class="btn small icon-only ghost ss-icon-btn" type="button" data-action="salary-auto" data-key="${esc(k)}" aria-label="Back to automatic for ${esc(month)}" title="Back to automatic">${svgIcon('undo')}</button>` : ''}</span>
      </div>`;
  };
  return `<div class="ss-sub">
      <div class="section-label">Salary date for each month</div>
      <p class="ss-help">When the salary came in. Each month runs until the day before the next salary.</p>
      <div class="list ss-list">${keys.slice(0, 3).map(row).join('')}</div>
      ${collapsible({ key: 'settings.salary-dates', title: 'Earlier months', count: keys.length - 3, body: `<div class="list ss-list">${keys.slice(3).map(row).join('')}</div>` })}
    </div>`;
}

// ---- Categories & rules
function categoriesCardHTML() {
  const all = S().categories.map((c, i) => ({ c, i }));
  const groups = [
    ['Spending', all.filter((x) => x.c.kind === 'expense')],
    ['Income', all.filter((x) => x.c.kind === 'income')],
    ['Savings & transfers', all.filter((x) => x.c.kind !== 'expense' && x.c.kind !== 'income')],
  ].filter(([, list]) => list.length);
  const row = ({ c, i }) => `<div class="ss-cat">
      <span class="ico-tile neutral" aria-hidden="true">${esc(c.icon || '•')}</span>
      <span class="ss-cat-name">${esc(c.name)}</span>
      ${c.kind === 'expense' ? `<label class="ss-switch" title="Essential: never cut by the planner"><input type="checkbox" role="switch" data-action="toggle-essential" data-index="${i}" ${c.essential ? 'checked' : ''} aria-label="${esc(c.name)} is essential"><span class="ss-switch-track" aria-hidden="true"></span></label>` : '<span></span>'}
      ${c.role ? `<span class="ss-locked" role="img" aria-label="Built-in, can’t be deleted" title="Built-in">${svgIcon('lock', { size: 16 })}</span>`
        : `<button class="btn small icon-only ghost ss-icon-btn ss-del" type="button" data-action="delete-category" data-index="${i}" aria-label="Delete ${esc(c.name)}" title="Delete">${svgIcon('trash')}</button>`}
    </div>`;
  const list = groups.map(([label, items]) => `<div class="ss-cat-head"><span>${esc(label)}</span>${label === 'Spending' ? '<span>Essential</span>' : ''}</div>${items.map(row).join('')}`).join('');
  const essential = all.filter((x) => x.c.kind === 'expense' && x.c.essential).length;
  const income = all.filter((x) => x.c.kind === 'income').length;
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('tag', 'Categories')}<button class="btn small" type="button" data-action="add-category">${svgIcon('plus')}Add</button></div>
      <p class="ss-help">${plural(essential, 'essential category', 'essential categories')}, never cut by the planner · ${income} for income.</p>
      ${collapsible({ key: 'settings.categories', title: 'All categories', count: all.length, body: `<div class="ss-cats">${list}</div>` })}
    </div>`;
}

function rulesCardHTML() {
  const rules = S().rules;
  let unused = 0;
  const rows = rules.map((r, i) => {
    const hits = S().transactions.filter((t) => ruleMatches(r, t));
    const n = hits.length;
    if (!n) unused += 1;
    const incomeHidden = cat(r.category).role === 'transfer' ? hits.filter((t) => t.type === 'income' && !t.manualCategory).reduce((s, t) => s + t.amount, 0) : 0;
    const key = r.keyword || r.pattern;
    return `<div class="ss-rule">
        <div class="ss-rule-main"><code class="ss-rule-key">${esc(key)}</code>
          <span class="sub"><span aria-hidden="true">${esc(icon(r.category))}</span> ${esc(r.category)} · ${n ? plural(n, 'match', 'matches') : 'no matches yet'}</span>
          ${incomeHidden > 1000 ? `<span class="ss-rule-warn">${svgIcon('alert', { size: 16 })}<span>Hides ${formatRON(incomeHidden, { short: true })} of income as transfers. Check this rule.</span></span>` : ''}</div>
        <button class="btn small icon-only ghost ss-icon-btn" type="button" data-action="edit-rule" data-index="${i}" aria-label="Edit rule ${esc(key)}" title="Edit">${svgIcon('edit')}</button>
      </div>`;
  }).join('');
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('rules', 'Category rules')}<button class="btn small" type="button" data-action="add-rule">${svgIcon('plus')}Add</button></div>
      <p class="ss-help">Bank text that contains a word gets that category. Your rules beat the built-in ones.</p>
      ${rules.length ? collapsible({ key: 'settings.rules', title: 'All rules', count: rules.length,
        body: `${unused ? `<p class="ss-help ss-body-note">${plural(unused, 'rule has', 'rules have')} no matches yet.</p>` : ''}<div class="ss-rules">${rows}</div>` }) : '<p class="ss-empty-line">No rules yet.</p>'}
      <div class="list ss-list ss-top-line">
        <div class="row"><span><span class="row-label">Re-run automatic categories</span><span class="sub">After changing rules. Your manual choices stay.</span></span>
          <button class="btn small" type="button" data-action="recategorize">${svgIcon('refresh')}Re-run</button></div>
      </div>
    </div>`;
}

// ---- App
function appCardHTML() {
  const theme = localStorage.getItem('bp.theme') || 'system';
  const install = window.BudgetApp
    ? `<div class="row"><span><span class="row-label">Server</span><span class="sub ss-url">${esc(window.BudgetApp.getServer())}</span></span><button class="btn small" type="button" data-action="change-server">Change</button></div>`
    : `<div class="row"><span><span class="row-label">Install on this device</span>${ui.installPrompt ? '' : '<span class="sub">iPhone: Share, then Add to Home Screen. Android: get the app (see the README) or use the browser menu, then Add to Home screen.</span>'}</span>${ui.installPrompt ? `<button class="btn small primary" type="button" data-action="install">${svgIcon('download')}Install</button>` : ''}</div>`;
  const seg = (t) => `<label><input class="sr-only" type="radio" name="theme" data-action="theme" value="${t}" ${t === theme ? 'checked' : ''}><span>${t[0].toUpperCase() + t.slice(1)}</span></label>`;
  return `<div class="card ss-card">
      <div class="card-head">${cardTitle('phone', 'App')}</div>
      <div class="list ss-list">
        ${install}
        <div class="row stack ss-theme"><span><span class="row-label">Theme</span></span>
          <div class="segmented ss-seg three" role="radiogroup" aria-label="Theme">${['system', 'light', 'dark'].map(seg).join('')}</div></div>
        <div class="row"><span><span class="row-label">Export all data</span><span class="sub">One JSON file with everything</span></span><button class="btn small" type="button" data-action="export">${svgIcon('download')}Download</button></div>
        <div class="row"><span><span class="row-label">Version</span></span><span class="row-value muted num">${esc(S().appVersion || '?')}</span></div>
      </div>
    </div>`;
}

// ---- Danger zone: unlink, delete imported, sign out
function dangerCardHTML(b) {
  const imported = S().transactions.filter((t) => t.source === 'import').length;
  const row = (title, sub, button) => `<div class="row"><span><span class="row-label">${title}</span><span class="sub">${sub}</span></span>${button}</div>`;
  const rows = [
    ...(b.configured ? b.connections.map((c) => row(`Unlink ${esc(c.bank)}${c.archived ? ' (old link)' : ''}`, 'Stops syncing. Transactions already imported stay.',
      `<button class="btn small danger" type="button" data-action="unlink-bank" data-id="${esc(c.sessionId)}">Unlink</button>`)) : []),
    imported ? row('Delete imported transactions', `${esc(plural(imported, 'transaction'))} from CSV files. Bank and manual ones stay.`,
      '<button class="btn small danger" type="button" data-action="delete-imported">Delete</button>') : '',
    row('Sign out', 'Of this device. Your data stays on the server.',
      `<button class="btn small danger" type="button" data-action="logout">${svgIcon('logout')}Sign out</button>`),
  ];
  return `<div class="card ss-card ss-danger"><div class="list ss-list">${rows.join('')}</div></div>`;
}

const TRASH_REASONS = { delete: 'Deleted', 'delete-imported': 'Import removed', 'duplicate-merge': 'Duplicate merged' };
// Lazy-loaded: fetched again whenever the data changes while Settings is open.
function trashCardHTML() {
  const stamp = S().updatedAt || '';
  if (ui.trashFor !== stamp) {
    ui.trashFor = stamp;
    const redraw = () => { if (ui.route === 'settings' && !modal.open) render(); };
    data.trash().then((list) => { ui.trash = Array.isArray(list) ? list : []; redraw(); })
      .catch(() => { if (!Array.isArray(ui.trash)) ui.trash = 'error'; redraw(); });
  }
  const list = Array.isArray(ui.trash) ? ui.trash : null;
  const shown = list ? (ui.trashAll ? list : list.slice(0, 8)) : [];
  let body;
  if (ui.trash === 'error') body = '<p class="ss-empty-line">Couldn’t load the trash. Try again when you’re online.</p>';
  else if (!list) body = '<p class="ss-empty-line">Loading…</p>';
  else if (!list.length) {
    body = '<div class="ss-empty"><b>Trash is empty</b><span class="sub">Deleted and merged transactions stay here for 60 days.</span></div>';
  } else {
    const rows = shown.map((e) => `<div class="ss-trash">
        <div class="ss-trash-main"><span class="ss-trash-desc">${esc(e.tx?.description || '(no description)')}</span>
          <span class="sub">${esc(fmtDate(e.tx?.date))} · ${esc(TRASH_REASONS[e.reason] || 'Removed')} ${esc(bankTime(e.removedAt))}</span></div>
        <div class="ss-trash-side">${e.tx ? amountHTML(e.tx) : ''}
          <button class="btn small" type="button" data-action="restore-tx" data-id="${esc(e.tx?.id || '')}">${svgIcon('undo')}Restore</button></div>
      </div>`).join('');
    body = `<p class="ss-help">Deleted and merged transactions stay here for 60 days.</p>
      ${collapsible({ key: 'settings.trash', title: 'Deleted transactions', count: list.length, body: `<div class="ss-trash-list">${rows}</div>
        ${list.length > shown.length ? `<button class="btn small ghost ss-show-all" type="button" data-action="trash-all">Show all ${list.length}</button>` : ''}` })}`;
  }
  return `<div class="card ss-card">
    <div class="card-head">${cardTitle('trash', 'Trash')}</div>
    ${body}
  </div>`;
}

// Link to the Transactions list with filters (contract in hive memory 'proposal.route'):
// #transactions?month=K|all&type=income|expense|saved&account=<uid>|none&counted=1&category=<name>&q=<text>
function txLink(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#transactions${s ? `?${s}` : ''}`;
}

/**
 * Totals of the period before `key`. For the period you're in, only up to the
 * same point (same number of days since the period started), so a half-finished
 * period isn't compared with a whole one.
 */
function prevSamePoint(key) {
  const prev = addMonths(key, -1);
  if (key !== P().current()) return summary(prev);
  const day = Math.round((Date.parse(todayISO()) - Date.parse(P().start(key))) / 86400000); // 0 = first day
  const cutoff = new Date(Math.min(Date.parse(P().start(prev)) + day * 86400000, Date.parse(P().end(prev)))).toISOString().slice(0, 10);
  return L().totals(S().transactions.filter((t) => t.date <= cutoff && keyOf(t.date) === prev));
}

// "↗ 12% more than this time last period" (HTML). For the period you're in, the comparison is
// at the same point of the previous one. upIsGood colours the arrow + % (green / red); '' = no data.
function pctChange(now, before, samePoint = false, upIsGood = null) {
  if (!before || (samePoint && !now)) return ''; // nothing yet this period: "100% less" would only be noise
  const prev = P().payday
    ? (samePoint ? 'this time last period' : 'the previous period')
    : (samePoint ? 'this time last month' : 'the previous month');
  const p = Math.round(((now - before) / before) * 100);
  if (!p) return `About the same as ${prev}`;
  const up = p > 0;
  const tone = upIsGood == null ? '' : up === upIsGood ? ' good' : ' bad';
  return `<span class="delta ${up ? 'up' : 'down'}${tone}">${svgIcon('arrow-up-right', { size: 14 })}${Math.abs(p)}%</span> ${up ? 'more' : 'less'} than ${prev}`;
}

const TITLES = { overview: 'Overview', transactions: 'Transactions', goals: 'Goals', plan: 'Plan', settings: 'Settings' };

function render() {
  if (!S()) return;
  const active = document.activeElement;
  const focusFilter = view.contains(active) && active.dataset.filter === 'q' ? active.selectionStart : null;
  view.innerHTML = (views[ui.route] || views.overview)();
  if (focusFilter != null) {
    // Gone when the route changed while typing (back button, a link): nothing to restore.
    const input = view.querySelector('[data-filter="q"]');
    if (input) { input.focus(); input.setSelectionRange(focusFilter, focusFilter); }
  }
  // Per-screen CSS hook (hive proposal.route-attr): body[data-route="goals"] etc. — e.g. no + button on Goals / Plan / Settings.
  document.body.dataset.route = views[ui.route] ? ui.route : 'overview';
  $('#view-title').textContent = TITLES[ui.route] || 'Overview';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === ui.route));
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === ui.route ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (ui.route === 'settings' && S().bank.configured && !ui.banks) loadBanks();
}

// ux-1: bank freshness + friendly sync errors (Settings and the status pill).
const HOUR = 3600000;
const ageHours = (iso) => (iso ? (Date.now() - Date.parse(iso)) / HOUR : Infinity);
// "today 18:26", "yesterday 18:26", "5 Oct, 18:26" (en-GB).
function bankTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = todayISO(d);
  if (day === todayISO()) return `today ${time}`;
  if (day === todayISO(new Date(Date.now() - 86400000))) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: day.slice(0, 4) === todayISO().slice(0, 4) ? undefined : 'numeric' })}, ${time}`;
}
const BANK_ERRORS = [
  [/ENOENT|EACCES|private key|\.pem|PRIVATE_KEY|EB_APP_ID|not configured/i, 'The server can’t read its Enable Banking key file. Check EB_PRIVATE_KEY_PATH in the server’s .env and restart it.'],
  [/\b(401|403)\b|expired|consent|revoked|unauthori[sz]ed|session/i, 'The bank access has expired or was revoked. Link the bank again below.'],
  [/\b429\b|rate.?limit|too many requests/i, 'The bank only allows a few updates a day. The server will try again later.'],
  [/too many transactions/i, 'Only part of the transactions were fetched. The next sync gets the rest.'],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|timeout|socket/i, 'The server couldn’t reach the bank. It will try again automatically.'],
  [/\b5\d\d\b|unavailable|maintenance/i, 'The bank’s service was unavailable. The server will try again later.'],
];
// One plain-English line per distinct problem; the raw text stays available under <details>.
function friendlyBankError(raw) {
  const parts = String(raw || '').split(/;\s*/).filter(Boolean);
  const lines = [...new Set(parts.map((p) => (BANK_ERRORS.find(([re]) => re.test(p)) || [null, 'The last bank sync didn’t finish. The server will try again automatically.'])[1]))];
  return { lines, parts };
}
const liveConnections = () => (S()?.bank?.connections || []).filter((c) => !c.archived);

function renderStatus() {
  const pending = data.pending;
  const b = S()?.bank;
  // Accounts linked but bank sync not configured on this server still means stale bank data.
  const linked = Boolean(liveConnections().length);
  let text; let short; let dot; let link = false;
  if (!data.online) { text = pending ? `Offline · ${pending} change${pending === 1 ? '' : 's'} waiting` : 'Offline · saved data'; short = 'Offline'; dot = 'var(--warning)'; }
  else if (pending) { text = `Saving ${pending}…`; short = 'Saving…'; dot = 'var(--warning)'; }
  else if (linked && b.lastError) { text = 'Bank sync failed · tap to see why'; short = 'Bank sync failed'; dot = 'var(--critical)'; link = true; }
  else if (linked && ageHours(b.lastSync) > 12) {
    text = b.lastSync ? `Bank data from ${bankTime(b.lastSync)}` : 'Bank not synced yet';
    short = b.lastSync ? `Bank: ${bankTime(b.lastSync)}` : 'Bank not synced'; dot = 'var(--warning)'; link = true;
  } else { text = linked && b.lastSync ? `Saved · bank ${bankTime(b.lastSync)}` : 'Saved'; short = 'Saved'; dot = 'var(--good)'; }
  for (const el of [$('#sync-pill'), $('#sync-pill-mobile')]) {
    if (!el) continue;
    el.textContent = el.id === 'sync-pill-mobile' ? short : text;
    el.style.setProperty('--sync-dot', dot);
    el.title = text;
    el.classList.toggle('ux1-pill-link', link);
    if (link) { el.setAttribute('role', 'link'); el.tabIndex = 0; } else { el.setAttribute('role', 'status'); el.removeAttribute('tabindex'); }
    el.onclick = link ? () => { location.hash = 'settings'; } : null;
    el.onkeydown = link ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'settings'; } } : null;
  }
}

// #transactions?month=K|all&type=income|expense|saved&account=<uid>|none&counted=1&category=<name>&q=<text>
// Any of these present: start from clean filters, so links always show the same list.
// Values are validated here (unknown ones are dropped); an unknown account is ignored by the view.
const TX_PARAMS = ['month', 'type', 'account', 'counted', 'category', 'q'];
function applyTxParams(params) {
  if (!TX_PARAMS.some((k) => params.has(k))) return;
  const text = (k, max) => String(params.get(k) || '').slice(0, max);
  const month = params.get('month');
  const type = params.get('type');
  ui.tx = {
    ...TX_DEFAULTS,
    q: text('q', 100),
    type: ['income', 'expense', 'saved'].includes(type) ? type : '',
    category: text('category', 60),
    account: text('account', 200),
    counted: params.get('counted') === '1',
    month: month === 'all' ? '' : /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : null,
  };
}

function route() {
  const [name, query] = location.hash.slice(1).split('?');
  ui.route = TITLES[name] ? name : 'overview';
  ui.params = new URLSearchParams(query || '');
  if (ui.route === 'transactions') applyTxParams(ui.params);
  render();
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  if (ui.params.has('add')) { history.replaceState(null, '', '#transactions'); openTxModal(); }
}

// ---------------------------------------------------------------- CSV import preview (ux-3)
// Mirrors what POST /api/transactions/import will do, so the preview tells the
// truth: same fingerprint (importHash), same "seen before" check (importSeen),
// same merge into an existing bank copy (isSameTransaction), same category guess.
function csvPreviewModel(preview, accountId) {
  const account = accountId ? S().bank.connections.flatMap((c) => c.accounts).find((a) => a.uid === accountId) : null;
  const occurrences = new Map();
  const rows = [];
  for (const raw of preview.items) {
    const amount = round2(Math.abs(Number(raw.amount)));
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) continue;
    const t = {
      type: raw.type, amount, date: raw.date,
      description: String(raw.description || '').slice(0, 140), note: String(raw.note || '').slice(0, 280),
      source: 'import', batchId: 'preview',
      ...(account ? { accountId: account.uid, accountChosen: true } : {}),
    };
    const bare = `${t.date}|${t.type}|${t.amount}|${String(raw.description || '').toLowerCase()}|${String(raw.note || '').toLowerCase()}`;
    const nth = (occurrences.get(bare) || 0) + 1;
    occurrences.set(bare, nth);
    t.importHash = `${t.accountId || ''}|${bare}${nth > 1 ? `#${nth}` : ''}`;
    rows.push({ raw, bare, t });
  }
  const seen = importSeen(S(), rows.map((r) => r.t));
  const own = ownContext(S());
  const bank = S().transactions.filter((x) => x.source === 'bank');
  const used = new Set();
  for (const r of rows) {
    if (seen.has(r.t, r.bare)) { r.isNew = false; continue; }
    seen.add(r.t);
    const twin = bank.find((y) => !used.has(y.id) && isSameTransaction(r.t, y) && !(r.t.accountId && y.accountId && r.t.accountId !== y.accountId));
    if (twin) { used.add(twin.id); r.isNew = false; continue; }
    r.isNew = true;
    r.category = ownTransferCategory(r.t, own) || categorize({ description: `${r.t.description} ${r.t.note || ''}`, type: r.t.type }, S().rules, S().categories);
  }
  const fresh = rows.filter((r) => r.isNew).length;
  return { rows, fresh, already: rows.length - fresh };
}

function csvPreviewHTML(b) {
  const p = ui.csvPreview;
  const m = csvPreviewModel(p, ui.csvAccount);
  const shown = [...m.rows.filter((r) => r.isNew), ...m.rows.filter((r) => !r.isNew)].slice(0, 8);
  const income = m.rows.filter((r) => r.t.type === 'income').length;
  const fx = p.needsFx || 0;
  const accounts = b.connections.flatMap((c) => c.accounts);
  // The account comes first: "New" / "Already in app" below depend on it.
  const account = accounts.length ? `<label class="field">Statement from
      <select data-action="csv-account">${accounts.map((a) => `<option value="${esc(a.uid)}" ${a.uid === ui.csvAccount ? 'selected' : ''}>${esc(settingsAccountName(a))}</option>`).join('')}<option value="" ${!ui.csvAccount ? 'selected' : ''}>Other / not linked</option></select></label>` : '';
  return `<div class="ss-csv">
    ${account}
    <div class="ss-csv-sum"><b>${esc(plural(m.rows.length, 'transaction'))} found</b>
      <span class="ss-csv-chips"><span class="badge${m.fresh ? ' good' : ''}">${m.fresh} new</span>${m.already ? `<span class="badge">${m.already} already in app</span>` : ''}</span>
      <span class="sub">${income} income, ${m.rows.length - income} expenses${p.skipped ? ` · ${plural(p.skipped, 'row')} skipped (not a transaction, or not completed)` : ''}</span></div>
    ${fx ? `<div class="banner warn ss-banner" role="note"><span class="banner-ico" aria-hidden="true">${svgIcon('alert', { size: 20 })}</span><div class="small"><b>${fx} row${fx === 1 ? ' is' : 's are'} in another currency.</b> After import ${fx === 1 ? 'it is' : 'they are'} converted to RON at the BNR rate of ${fx === 1 ? 'its' : 'their'} date (marked “needs conversion” until the rate can be fetched).</div></div>` : ''}
    ${collapsible({ key: 'settings.csv-preview', title: 'Preview', count: m.rows.length, open: true, cls: 'ss-csv-collapse', body: `<div class="ss-csv-rows">${shown.map((r) => `<div class="ss-csv-row${r.isNew ? '' : ' is-dup'}">
      <span class="ss-csv-main"><span class="ss-csv-desc">${esc(r.t.description || '—')}</span>
        <span class="sub">${esc(fmtDate(r.t.date))}${r.isNew ? ` · <span aria-hidden="true">${esc(icon(r.category))}</span> ${esc(r.category)}` : ''}${r.raw.needsFx ? ` · ${esc(r.raw.originalCurrency || '')}, converted at the BNR rate` : ''}</span></span>
      <span class="ss-csv-end"><span class="num ${r.t.type === 'income' ? 'pos' : ''}">${r.t.type === 'income' ? '+' : '−'}${r.raw.needsFx ? `${esc(amountFmt.format(r.t.amount))} ${esc(r.raw.originalCurrency || '')}` : formatRON(r.t.amount)}</span>
        <span class="badge${r.isNew ? ' good' : ''}">${r.isNew ? 'New' : 'In app'}</span></span>
    </div>`).join('')}</div>
    ${m.rows.length > shown.length ? `<p class="ss-help">And ${m.rows.length - shown.length} more.</p>` : ''}` })}
    <div class="ss-csv-actions"><button class="btn" type="button" data-action="csv-cancel">Cancel</button>
      <button class="btn primary" type="button" data-action="csv-import" ${m.fresh ? '' : 'disabled'}>${m.fresh ? `${svgIcon('download')}Import ${m.fresh} new` : 'Nothing new to import'}</button></div>
  </div>`;
}

// ---------------------------------------------------------------- modals
// Every modal is a sheet: header (drag handle look on a phone, title, close button),
// a body that scrolls, and a footer that always stays visible (the .modal-actions).
// The callers' markup is unchanged: openModal() sorts it into those three parts.
function sheetParts(form) {
  const title = form.querySelector(':scope > #modal-title');
  const actions = form.querySelector(':scope > .modal-actions');
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = '<span class="sheet-handle" aria-hidden="true"></span>';
  if (title) head.append(title);
  head.insertAdjacentHTML('beforeend', `<button class="btn ghost icon-only sheet-close" type="button" data-modal="cancel" aria-label="Close">${svgIcon('x', { size: 20 })}</button>`);
  // No field asks for the focus: the title takes it (announced first; no read-only field, no keyboard).
  if (title && !form.querySelector('[autofocus]')) { title.tabIndex = -1; title.setAttribute('autofocus', ''); }
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.append(...[...form.childNodes].filter((n) => n !== actions));
  const foot = document.createElement('div');
  foot.className = 'sheet-foot';
  if (actions) foot.append(actions);
  form.replaceChildren(head, body, ...(actions ? [foot] : []));
  return { head, body };
}

// The phone keyboard: keep the sheet (and its Save button) inside what is still visible.
function trackKeyboard(dialog) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const update = () => {
    dialog.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    dialog.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
}

// Pull the sheet down by its header to close it (phone).
function dragToClose(dialog, handle) {
  let startY = null;
  let dy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button') || !window.matchMedia('(max-width: 760px)').matches) return;
    startY = e.clientY; dy = 0;
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    dialog.style.transform = dy ? `translateY(${dy}px)` : '';
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    dialog.style.transform = '';
    if (dy > 90) dialog.close();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

let untrackKeyboard = () => {};
modal.addEventListener('close', () => { untrackKeyboard(); untrackKeyboard = () => {}; modal.style.transform = ''; });

function openModal(html, onSubmit) {
  modalForm.innerHTML = html;
  const { head, body } = sheetParts(modalForm);
  const run = async (action) => {
    try {
      const keepOpen = await onSubmit(action, new FormData(modalForm));
      if (!keepOpen) modal.close();
    } catch (err) {
      const errEl = modalForm.querySelector('.form-error');
      if (errEl) { errEl.textContent = err.message; errEl.scrollIntoView({ block: 'nearest' }); } else toast(err.message, null, { tone: 'critical' });
    }
  };
  modalForm.onsubmit = (e) => { e.preventDefault(); run('save'); };
  modalForm.onclick = (e) => {
    const btn = e.target.closest('button[data-modal]');
    if (!btn) return;
    if (btn.dataset.modal === 'cancel') modal.close(); else run(btn.dataset.modal);
  };
  dragToClose(modal, head);
  untrackKeyboard();
  untrackKeyboard = trackKeyboard(modal);
  modal.showModal();
  body.scrollTop = 0;
  // A field marked autofocus gets the focus; otherwise the dialog's first control,
  // which is the close button in the header (never a read-only field).
  setTimeout(() => modalForm.querySelector('[autofocus]')?.focus(), 30);
}

// In-app confirmation (instead of the browser's "The page at … says"): a small sheet
// that can open on top of another modal. Resolves true only for the confirm button.
let confirmEl = null;
function confirmSheet({ title, message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
  if (!confirmEl) {
    confirmEl = document.createElement('dialog');
    confirmEl.className = 'modal confirm-sheet';
    confirmEl.setAttribute('aria-labelledby', 'confirm-title');
    confirmEl.setAttribute('aria-describedby', 'confirm-text');
    document.body.append(confirmEl);
  }
  const d = confirmEl;
  d.innerHTML = `<div class="confirm-box">
      ${iconTile(danger ? 'alert' : 'info', { tone: danger ? 'critical' : '', cls: 'lg' })}
      <h2 id="confirm-title">${esc(title)}</h2>
      ${message ? `<p id="confirm-text">${esc(message)}</p>` : ''}
    </div>
    <div class="sheet-foot confirm-actions">
      <button class="btn" type="button" data-confirm="cancel" autofocus>${esc(cancelLabel)}</button>
      <button class="btn ${danger ? 'danger solid' : 'primary'}" type="button" data-confirm="ok">${esc(confirmLabel)}</button>
    </div>`;
  return new Promise((resolve) => {
    let answer = false;
    d.onclick = (e) => {
      const btn = e.target.closest('[data-confirm]');
      if (btn) { answer = btn.dataset.confirm === 'ok'; d.close(); return; }
      if (e.target === d) d.close(); // tap on the backdrop
    };
    d.onclose = () => { d.onclose = null; resolve(answer); };
    d.showModal();
  });
}

export { toast, confirmSheet }; // for UI checks in the browser, like cardTitle/dateField

function categoryOptions(type, selected) {
  return S().categories
    .filter((c) => c.kind === type || c.kind === 'both')
    .map((c) => `<option value="${esc(c.name)}" ${c.name === selected ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`)
    .join('');
}

// "1.200,00": amounts in the modal read like the rest of the app (no currency sign).
const amountFmt = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatAmountInput = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? amountFmt.format(Number(n)) : '');

const LS_LAST_EXPENSE_CAT = 'bp.lastExpenseCategory';
function lastExpenseCategory() {
  try {
    const name = localStorage.getItem(LS_LAST_EXPENSE_CAT);
    return name && S().categories.some((c) => c.name === name && (c.kind === 'expense' || c.kind === 'both')) ? name : '';
  } catch { return ''; }
}
function rememberExpenseCategory(name) {
  try { localStorage.setItem(LS_LAST_EXPENSE_CAT, name); } catch { /* storage blocked */ }
}

// Up to 6 most-used categories of this type, for 2–3 tap entry.
function topCategories(type, n = 6) {
  const allowed = new Set(S().categories.filter((c) => c.kind === type || c.kind === 'both').map((c) => c.name));
  const uses = new Map();
  for (const x of S().transactions) {
    if (x.type !== type || !allowed.has(x.category) || x.category === 'Transfers') continue;
    uses.set(x.category, (uses.get(x.category) || 0) + 1);
  }
  return [...uses.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name]) => name);
}
// New expense: the category you used last time, else your most-used one.
const defaultExpenseCategory = () => lastExpenseCategory() || topCategories('expense')[0] || '';
function categoryChips(type, selected) {
  return topCategories(type).map((name) => `<button type="button" class="qc-chip" data-pick-category="${esc(name)}" aria-pressed="${name === selected}">${esc(icon(name))} ${esc(name)}</button>`).join('');
}

function openTxModal(tx) {
  const isNew = !tx;
  const t = tx || { id: uid(), type: 'expense', amount: '', category: defaultExpenseCategory(), description: '', date: todayISO(), note: '' };
  let type = t.type;
  const originalCategory = t.category;
  const fromBank = t.source === 'bank' || t.source === 'import';
  // The bank is the source of truth for what moved and when; only your labels are editable.
  const locked = !isNew && t.source === 'bank';
  const chips = categoryChips(type, t.category);
  const acc = L().accountOf(t);
  const accLast4 = acc ? String(acc.iban || '').replace(/\s/g, '').slice(-4) : '';
  const accText = acc ? `${ACCOUNT_KINDS[accountView(acc).kind]}${accLast4 ? ` ··${accLast4}` : ''}` : 'Not linked';
  // Bank transactions: what moved, when and where is read-only text, not greyed inputs.
  const lockedRows = locked ? `<div class="locked">
      <p class="section-label locked-label">${svgIcon('lock', { size: 14 })}From the bank</p>
      <div class="list locked-list">
        <div class="row"><span class="row-label">Amount</span><span class="row-value locked-amt num${t.type === 'income' ? ' pos' : ''}">${t.type === 'income' ? '+' : '−'}${esc(formatRON(t.amount))}</span></div>
        <div class="row"><span class="row-label">Date</span><span class="row-value">${esc(fmtDate(t.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span></div>
        <div class="row"><span class="row-label">Account</span><span class="row-value">${esc(accText)}</span></div>
      </div>
    </div>` : '';
  const goalField = `<label class="field" id="goal-field" ${cat(t.category).role === 'savings' ? '' : 'hidden'}>Goal<select name="goalId"><option value="">No goal</option>${S().goals.map((g) => `<option value="${esc(g.id)}" ${g.id === t.goalId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>`;
  openModal(`
    <h2 id="modal-title">${isNew ? 'New transaction' : 'Edit transaction'} ${fromBank ? `<span class="badge">${t.source === 'bank' ? 'From bank' : 'Imported'}</span>` : ''}</h2>
    ${locked ? lockedRows : `<div class="type-toggle" role="group" aria-label="Type">
      <button type="button" data-type="expense" aria-pressed="${type === 'expense'}">${svgIcon('arrow-up-right', { size: 16 })}Expense</button>
      <button type="button" data-type="income" aria-pressed="${type === 'income'}">${svgIcon('arrow-down-left', { size: 16 })}Income</button>
    </div>
    <label class="field">Amount (RON)<input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(formatAmountInput(t.amount))}" ${isNew ? 'autofocus' : ''} required></label>`}
    <div class="field">
      <span id="cat-label">Category</span>
      <div class="qc-chips" id="qc-chips" role="group" aria-label="Frequent categories" ${chips ? '' : 'hidden'}>${chips}</div>
      <select name="category" aria-labelledby="cat-label">${categoryOptions(type, t.category)}</select>
    </div>
    <label class="field">Description<input name="description" maxlength="140" placeholder="e.g. Kaufland, Salary" value="${esc(t.description)}" autocomplete="off"></label>
    ${locked ? goalField : `<div class="field-row">
      <label class="field">Date${dateField({ name: 'date', value: t.date, attrs: { required: true } })}</label>
      ${goalField}
    </div>`}
    <label class="field">Note<textarea name="note" maxlength="280" rows="1" placeholder="Optional" class="autogrow">${esc(t.note || '')}</textarea></label>
    ${t.source !== 'bank' && S().bank.connections.length ? `<label class="field">Account<select name="accountId">${S().bank.connections.flatMap((c) => c.accounts).map((a) => `<option value="${esc(a.uid)}" ${a.uid === (L().accountOf(t)?.uid) ? 'selected' : ''}>${esc(ACCOUNT_KINDS[accountView(a).kind])} · ${esc((a.iban || '').slice(-4))}</option>`).join('')}<option value="" ${!L().accountOf(t) ? 'selected' : ''}>Not linked (cash / other)</option></select></label>` : ''}
    ${!isNew && t.category !== 'Transfers' && isOwnTransfer(t, ownContext(S())) ? `<div class="banner info"><span class="banner-ico" aria-hidden="true">${svgIcon('repeat')}</span><div class="small"><b>This looks like money moving between your own accounts.</b> As “${esc(t.category)}” it is counted as ${t.type === 'income' ? 'income' : 'spending'} — and again on the other account. Choose <b>Transfers</b> so it isn’t counted twice.</div></div>` : ''}
    ${fromBank ? `<div id="learn-row" class="learn-box" hidden>
      <label class="checkbox"><input type="checkbox" name="learn"> Also use this category for other transactions containing:</label>
      <input name="keyword" maxlength="60" value="${esc(merchantKey(`${t.description} ${t.note || ''}`))}" placeholder="shop name, e.g. carrefour" aria-label="Keyword" autocomplete="off">
      <p class="muted small" id="learn-preview"></p>
    </div>` : ''}
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="btn danger" type="button" data-modal="delete">${svgIcon('trash')}Delete</button>`}
      <span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">Save</button>
    </div>`, async (action, fd) => {
    if (action === 'delete') { deleteTx(t.id); return false; }
    const amount = locked ? t.amount : round2(Math.abs(parseAmount(fd.get('amount'))));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than 0.');
    const category = fd.get('category');
    const next = {
      ...t,
      type: locked ? t.type : type,
      amount,
      category,
      description: (fd.get('description') || '').trim() || category,
      date: locked ? t.date : (fd.get('date') || todayISO()),
      note: (fd.get('note') || '').trim(),
      goalId: cat(category).role === 'savings' ? (fd.get('goalId') || null) : null,
      ...(category !== originalCategory ? { manualCategory: true } : {}),
      ...(fd.has('accountId') && (fd.get('accountId') || null) !== (t.accountId || null) ? { accountId: fd.get('accountId') || null, accountManual: true } : {}),
    };
    const keyword = (fd.get('keyword') || '').trim().toLowerCase();
    const learn = fromBank && category !== originalCategory && fd.get('learn');
    if (learn && (keyword.length < 3 || isUselessKeyword(keyword))) throw new Error('That keyword is too generic. Use the shop’s name, e.g. “carrefour”.');
    data.upsertTransaction(next);
    if (isNew && next.type === 'expense') rememberExpenseCategory(category);
    if (learn) {
      data.addRule(keyword, category);
      toast(`Rule saved: “${keyword}” → ${category}`);
    } else toast(isNew ? 'Transaction added' : 'Saved');
    return false;
  });

  const form = modalForm;
  const chipsEl = $('#qc-chips', form);
  const syncChips = () => chipsEl.querySelectorAll('[data-pick-category]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pickCategory === form.category.value)));
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-category]');
    if (!b) return;
    form.category.value = b.dataset.pickCategory;
    form.category.dispatchEvent(new Event('change'));
  });
  if (!locked) {
    form.amount.addEventListener('blur', () => {
      const v = parseAmount(form.amount.value);
      if (Number.isFinite(v) && v !== 0) form.amount.value = formatAmountInput(round2(Math.abs(v)));
    });
  }
  form.querySelectorAll('[data-type]').forEach((btn) => btn.addEventListener('click', () => {
    if (locked) return;
    type = btn.dataset.type;
    form.querySelectorAll('[data-type]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const keep = form.category.value;
    form.category.innerHTML = categoryOptions(type, type === 'expense' && isNew && cat(keep).kind === 'income' ? defaultExpenseCategory() : keep);
    const html = categoryChips(type, form.category.value);
    chipsEl.innerHTML = html;
    chipsEl.hidden = !html;
    form.category.dispatchEvent(new Event('change'));
  }));
  form.category.addEventListener('change', () => {
    syncChips();
    $('#goal-field', form).hidden = cat(form.category.value).role !== 'savings';
    const learn = $('#learn-row', form);
    if (learn) { learn.hidden = form.category.value === originalCategory; updateLearnPreview(); }
  });
  const updateLearnPreview = () => {
    const out = $('#learn-preview', form);
    if (!out) return;
    out.innerHTML = rulePreview(form.keyword.value, t.id);
  };
  if (form.keyword) form.keyword.addEventListener('input', updateLearnPreview);
  autoGrow(form.note);
}

// A one-line note box that grows with its text (long bank notes wrap instead of being cut).
// Enter saves, like the single-line field it replaces, so notes stay one paragraph.
function autoGrow(area) {
  if (!area) return;
  const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
  area.addEventListener('input', fit);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); area.form?.requestSubmit(); }
  });
  requestAnimationFrame(fit);
}

// "Matches 4 other transactions: CARREFOUR EXPRESS, CARREFOUR MARKET, …"
function rulePreview(keyword, exceptId) {
  const k = String(keyword || '').trim();
  if (k.length < 3 || isUselessKeyword(k)) return `<span class="hint-warn">${svgIcon('alert', { size: 16 })}Too generic. Type the shop’s name, e.g. “carrefour”.</span>`;
  const rule = { pattern: escapeForRule(k) };
  const hits = S().transactions.filter((x) => x.id !== exceptId && !x.goalId && ruleMatches(rule, x));
  if (!hits.length) return 'No other transactions match yet; future ones will.';
  const names = [...new Set(hits.map((x) => x.description))].slice(0, 3).map(esc).join(', ');
  return `Matches <b>${hits.length}</b> other transaction${hits.length === 1 ? '' : 's'}: ${names}${hits.length > 3 ? '…' : ''}. Ones you categorised by hand stay as they are.`;
}

function openPaydayModal(key) {
  const current = S().settings?.paydays?.[key];
  openModal(`
    <h2 id="modal-title">Salary for ${esc(P().label(key))}</h2>
    <p class="muted small" style="margin:0">The budget month runs from this date until the day before the next salary. Leave it automatic to use the salary found in your transactions (or day ${esc(String(P().payday))}, moved off weekends).</p>
    <label class="field">Salary arrived on${dateField({ name: 'date', value: current || P().start(key), attrs: { required: true } })}</label>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${current ? '<button class="btn" type="button" data-modal="delete">Back to automatic</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`, async (action, fd) => {
    const paydays = { ...(S().settings?.paydays || {}) };
    if (action === 'delete') delete paydays[key];
    else {
      const date = fd.get('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a date.');
      const [y, m] = key.split('-').map(Number);
      const d = new Date(date);
      const monthsAway = (d.getFullYear() - y) * 12 + d.getMonth() - (m - 1);
      if (Math.abs(monthsAway) > 1) throw new Error('Pick a date close to that month.');
      paydays[key] = date;
    }
    data.setSettings({ paydays });
    return false;
  });
}

function openRuleModal(rule) {
  const isNew = !rule;
  const r = rule || { keyword: '', category: 'Groceries' };
  const kw = r.keyword || String(r.pattern || '').replace(/\\(.)/g, '$1'); // new rule: no pattern yet
  openModal(`
    <h2 id="modal-title">${isNew ? 'New rule' : 'Edit rule'}</h2>
    <label class="field">When the bank text contains<input name="keyword" maxlength="60" value="${esc(kw)}" placeholder="e.g. carrefour" autofocus></label>
    <p class="muted small" id="rule-preview" style="margin:0"></p>
    <label class="field">Put it in<select name="category">${S().categories.filter((c) => !c.role || c.role === 'transfer').map((c) => `<option value="${esc(c.name)}" ${c.name === r.category ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${isNew ? '' : '<button class="btn danger" type="button" data-modal="delete">Delete</button>'}
      <span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`, async (action, fd) => {
    if (action === 'delete') { data.deleteRule(r.pattern); toast('Rule deleted — its transactions were re-categorised'); return false; }
    const keyword = (fd.get('keyword') || '').trim().toLowerCase();
    if (keyword.length < 3 || isUselessKeyword(keyword)) throw new Error('That keyword is too generic. Use the shop’s name, e.g. “carrefour”.');
    data.addRule(keyword, fd.get('category'), isNew ? undefined : r.pattern);
    toast('Rule saved');
    return false;
  });
  const update = () => { $('#rule-preview', modalForm).innerHTML = rulePreview(modalForm.keyword.value); };
  modalForm.keyword.addEventListener('input', update);
  update();
}

function deleteTx(id) {
  const t = S().transactions.find((x) => x.id === id);
  if (!t) return;
  data.deleteTransaction(id);
  toast('Transaction deleted', { label: 'Undo', run: () => data.upsertTransaction(t) });
}

const GOAL_ICONS = ['🎯', '🏖️', '🚗', '🏠', '💻', '🛡️', '🎓', '💍', '👶', '✈️', '📱', '🎁'];
function openGoalModal(goal) {
  const isNew = !goal;
  const g = goal || { id: uid(), name: '', target: '', initialSaved: 0, deadline: '', priority: 'medium', icon: '🎯' };
  const current = g.icon || '🎯';
  // A custom icon (e.g. the card goal's 💳) stays selectable.
  const icons = GOAL_ICONS.includes(current) ? GOAL_ICONS : [current, ...GOAL_ICONS.slice(0, -1)];
  openModal(`
    <h2 id="modal-title">${isNew ? 'New goal' : 'Edit goal'}</h2>
    <label class="field">Name<input name="name" maxlength="80" required placeholder="e.g. Emergency fund, Summer in Greece" value="${esc(g.name)}" ${isNew ? 'autofocus' : ''} autocomplete="off"></label>
    <fieldset class="field icon-field"><legend>Icon</legend>
      <div class="icon-picker">${icons.map((i) => `<label class="icon-opt"><input class="sr-only" type="radio" name="icon" value="${esc(i)}" ${i === current ? 'checked' : ''}><span aria-hidden="true">${esc(i)}</span><span class="sr-only">${esc(i)}</span></label>`).join('')}</div>
    </fieldset>
    <div class="field-row">
      <label class="field">Target (RON)<input class="money-input" name="target" inputmode="decimal" required value="${esc(formatAmountInput(g.target))}" placeholder="10.000,00" autocomplete="off"></label>
      <label class="field">Already saved (RON)<input class="money-input" name="initialSaved" inputmode="decimal" value="${esc(formatAmountInput(g.initialSaved))}" placeholder="0,00" autocomplete="off"></label>
    </div>
    <div class="field-row">
      <div class="field"><span id="deadline-label">Deadline</span><span class="date-clearable">${dateField({ name: 'deadline', value: g.deadline || '', placeholder: 'No deadline', attrs: { min: todayISO(), 'aria-labelledby': 'deadline-label' } })}<button class="btn ghost icon-only date-clear" type="button" data-clear-date="deadline" aria-label="Clear the deadline" title="No deadline" ${g.deadline ? '' : 'hidden'}>${svgIcon('x', { size: 18 })}</button></span></div>
      <label class="field">Priority<select name="priority">${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${p === g.priority ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
    </div>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="btn danger" type="button" data-modal="delete">${svgIcon('trash')}Delete</button>`}
      <span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">Save goal</button>
    </div>`, async (action, fd) => {
    if (action === 'delete') {
      const ok = await confirmSheet({ title: `Delete “${g.name}”?`, message: 'Money you put aside stays recorded as savings.', confirmLabel: 'Delete goal' });
      if (!ok) return true;
      data.deleteGoal(g.id); toast('Goal deleted'); return false;
    }
    const target = round2(parseAmount(fd.get('target')));
    if (!fd.get('name').trim()) throw new Error('Give the goal a name.');
    if (!(target > 0)) throw new Error('Enter a target amount.');
    const initialSaved = round2(parseAmount(fd.get('initialSaved') || '0')) || 0;
    data.upsertGoal({ ...g, name: fd.get('name').trim(), target, initialSaved, deadline: fd.get('deadline') || null, priority: fd.get('priority'), icon: fd.get('icon') || '🎯' });
    toast(isNew ? 'Goal created — check the Plan tab' : 'Goal saved');
    return false;
  });
  formatMoneyOnBlur(modalForm);
  // "Clear" empties the deadline (the native clear button is hidden under the readable date).
  const deadline = modalForm.deadline;
  const clear = $('[data-clear-date="deadline"]', modalForm);
  deadline.addEventListener('change', () => { clear.hidden = !deadline.value; });
  clear.addEventListener('click', () => {
    deadline.value = '';
    deadline.dispatchEvent(new Event('input', { bubbles: true }));
    clear.hidden = true;
  });
}

// Amount boxes read like the rest of the app ("1.200,00") once you leave them.
function formatMoneyOnBlur(form) {
  form.querySelectorAll('.money-input, .amount-input').forEach((input) => input.addEventListener('blur', () => {
    if (input.readOnly || !input.value.trim()) return;
    const v = parseAmount(input.value);
    if (Number.isFinite(v) && v !== 0) input.value = formatAmountInput(round2(Math.abs(v)));
  }));
}

function openContributionModal(goal, withdraw = false) {
  const { plan } = currentPlan(null);
  const p = plan.goals.find((x) => x.id === goal.id);
  const suggestion = p?.required || (plan.monthlySaving && plan.goals.length ? plan.monthlySaving / plan.goals.length : 0);
  openModal(`
    <h2 id="modal-title">${withdraw ? 'Withdraw from goal' : 'Add money to goal'}</h2>
    <div class="goal-pill"><span class="ico-tile neutral lg" aria-hidden="true">${esc(goal.icon || '🎯')}</span><span class="goal-pill-name">${esc(goal.name)}</span></div>
    <label class="field">Amount (RON)<input class="amount-input" name="amount" inputmode="decimal" required autofocus autocomplete="off" placeholder="0,00" value="${esc(!withdraw && suggestion ? formatAmountInput(Math.round(suggestion)) : '')}"></label>
    ${!withdraw && suggestion ? `<p class="caption hint">${svgIcon('bulb', { size: 16 })}<span>Your plan suggests about ${formatRON(suggestion, { short: true })} a month for this goal.</span></p>` : ''}
    <label class="field">Date${dateField({ name: 'date', value: todayISO() })}</label>
    <p class="muted small" style="margin:0">${withdraw ? 'Recorded as money coming back into your budget.' : 'Recorded as a “Savings” transaction, so your left-to-spend balance goes down by the same amount.'}</p>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">${withdraw ? 'Withdraw' : 'Add money'}</button>
    </div>`, async (_, fd) => {
    const amount = round2(Math.abs(parseAmount(fd.get('amount'))));
    if (!(amount > 0)) throw new Error('Enter an amount greater than 0.');
    data.upsertTransaction({
      id: uid(), type: withdraw ? 'income' : 'expense', amount, category: SAVINGS_CATEGORY,
      description: `${withdraw ? 'From' : 'To'} goal: ${goal.name}`, date: fd.get('date') || todayISO(), goalId: goal.id, note: '',
    });
    toast(withdraw ? 'Withdrawn' : `${formatRON(amount)} added to ${goal.name}`);
    return false;
  });
  formatMoneyOnBlur(modalForm);
}

// ---------------------------------------------------------------- ux-4: balances, reconciliation, accounts
const linkedAccounts = () => S().bank.connections.filter((c) => !c.archived).flatMap((c) => c.accounts || []);
const STALE_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- screens-overview: account names (O1)
const SHORT_KINDS = { current: 'Current', savings: 'Savings', credit: 'Card' };

// The 4 digits people know an account by: its card number (set on the account, or learnt from
// bank transactions — "**** 7204"), else the end of its IBAN / account number.
function accountDigits(a) {
  if (!a) return '';
  const card = (a.cardDigits || []).find((d) => /^\d{4}$/.test(d))
    || [...L().byDigits].find(([, x]) => x.uid === a.uid)?.[0];
  if (card) return card;
  const number = String(a.iban || a.number || a.accountNumber || a.bban || '').replace(/\s/g, '');
  return number.length >= 4 ? number.slice(-4) : '';
}

/**
 * How an account is named everywhere (hero, strip, filters, chips, Settings, modals):
 * the nickname you gave it, else its kind + last 4 digits. The bank's own account
 * "name" is usually the holder's full name, so it is never shown.
 *   accountName(a)                  → "Current account ··7204" (or the nickname)
 *   accountName(a, { short: true }) → "Current ··7204" / "Card ··8391" / "Savings ··1021"
 */
function accountName(a, { short = false } = {}) {
  if (!a) return '';
  const nick = String(a.nickname || '').trim();
  if (nick) return nick;
  const kind = accountKind(a);
  const label = (short ? SHORT_KINDS : ACCOUNT_KINDS)[kind] || ACCOUNT_KINDS.current;
  const digits = accountDigits(a);
  return digits ? `${label} ··${digits}` : label; // no-break space: "··7204" never wraps on its own
}

// "1.202,73" + a smaller "RON": the big figure of a card (hero, goal).
function bigAmount(n, { sign = false } = {}) {
  return `<span class="big-amount"><span class="big-amount-n">${formatRON(n, { sign }).replace(/\s*RON$/u, '')}</span><span class="big-amount-cur">RON</span></span>`;
}

// One shared empty state (G11): icon tile, title, one line, optional buttons (trusted HTML).
function emptyState({ icon: ico = 'info', title, text = '', action = '', cls = '' }) {
  return `<div class="empty${cls ? ` ${cls}` : ''}">${iconTile(ico, { tone: 'neutral' })}<b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}${action ? `<div class="empty-actions">${action}</div>` : ''}</div>`;
}

// Long lists (user request, shared collapse.js): the first `shown` rows stay visible, the rest
// sit in a minimized section that remembers its state per `key`. rows: HTML strings.
// wrap(html) puts each part in its list container. Hiding just one row isn't worth a tap.
function moreRows({ key, rows, shown = 5, title = 'Show more', wrap = (html) => html, open = false, cls = '' }) {
  if (rows.length <= shown + 1) return wrap(rows.join(''));
  return wrap(rows.slice(0, shown).join(''))
    + collapsible({ key, title: esc(title), count: rows.length - shown, body: wrap(rows.slice(shown).join('')), open, cls: `ov-more${cls ? ` ${cls}` : ''}` });
}

// First run: nothing synced, imported or typed in yet.
function welcomeCard() {
  return `<div class="card welcome">
    ${iconTile('wallet', { cls: 'lg' })}
    <h2>Welcome to your budget</h2>
    <p class="muted">Bring in your transactions to see what you have until payday, where the money goes and how to reach your goals.</p>
    <div class="welcome-actions">
      <a class="btn primary" href="#settings">${svgIcon('bank')}Connect your bank</a>
      <a class="btn" href="#settings">${svgIcon('upload')}Import a CSV statement</a>
      <button class="btn" type="button" data-action="add-tx">${svgIcon('plus')}Add a transaction</button>
    </div>
  </div>`;
}

const PRIORITY_LABELS = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

// When the bank last confirmed this account's balance: the sync time when the
// account was synced in the last run, else its latest stored snapshot / sync day.
// text: "today 18:26", "yesterday 18:26", "6 Oct, 18:26" (same wording as bankTime).
function balanceAsOf(a) {
  const hist = S().bank.balanceHistory?.[a.uid];
  const snap = hist?.length ? hist[hist.length - 1].date : null;
  const last = S().bank.lastSync;
  let iso = snap;
  if (last && a.lastSyncDate && todayISO(new Date(last)) === a.lastSyncDate && (!iso || last > iso)) iso = last;
  if (!iso && a.lastSyncDate) iso = `${a.lastSyncDate}T00:00:00`;
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const d = new Date(iso);
  const hasTime = iso.length > 10 && !iso.endsWith('T00:00:00');
  const today = todayISO();
  const time = hasTime ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const day = todayISO(d) === today ? 'today' : todayISO(d) === todayISO(new Date(Date.now() - 86400000)) ? 'yesterday'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: todayISO(d).slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
  const text = time ? (day === 'today' || day === 'yesterday' ? `${day} ${time}` : `${day}, ${time}`) : day;
  return { iso, text, stale: Date.now() - d.getTime() > STALE_MS };
}

// "Updated today 18:26" + an amber "Stale" badge when the bank balance is over a day old (G12).
function updatedHTML(a) {
  const at = balanceAsOf(a);
  if (!at) return '';
  return `<span class="updated" title="${esc(new Date(at.iso).toLocaleString('en-GB'))}">${svgIcon('clock', { size: 14 })}<span>Updated ${esc(at.text)}</span>${at.stale ? '<span class="badge warning">Stale</span>' : ''}</span>`;
}

const fmtIn = (n, currency, opts = {}) => (!currency || currency === 'RON' ? formatRON(n, opts)
  : `${opts.sign && n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`);

// #transactions link for one account and one period (format agreed with ux-2: proposal.route).
const accountTxLink = (uid, month) => `#transactions?account=${encodeURIComponent(uid)}&month=${encodeURIComponent(month)}`;

// "Matches the bank" or the difference, for the account's latest two balances (one compact line).
function reconcileHTML(a) {
  const r = reconcile(S(), a.uid, { accountOf: (t) => L().accountOf(t) });
  if (!r) return '';
  const month = keyOf(r.fromDay) === keyOf(r.toDay) ? keyOf(r.toDay) : 'all';
  const span = `${fmtDate(r.fromDay, { day: 'numeric', month: 'short' })} – ${fmtDate(r.toDay, { day: 'numeric', month: 'short' })}`;
  const currency = String(a.balance?.currency || a.currency || 'RON').toUpperCase();
  const tip = `Bank balance ${span}, explained by ${r.txCount} transaction${r.txCount === 1 ? '' : 's'} in the app`;
  const pendingNote = r.pending ? ` · ${fmtIn(r.pending, currency, { sign: true })} card payments pending` : '';
  if (r.ok) return `<a class="recon ok" href="${accountTxLink(a.uid, month)}" title="${esc(tip)}">${svgIcon('check', { size: 16 })}<span>Matches the bank <span class="recon-span">· ${esc(span)}${esc(pendingNote)}</span></span></a>`;
  // Older balance snapshots don't say how much was pending: no alarm, it settles after the next syncs.
  if (r.uncertain) return `<a class="recon" href="${accountTxLink(a.uid, month)}" title="${esc(tip)}">${svgIcon('clock', { size: 16 })}<span>Bank check in progress <span class="recon-span">· card payments not booked yet are in the bank's balance; checked again after the next sync</span></span></a>`;
  return `<a class="recon off" href="${accountTxLink(a.uid, month)}" title="${esc(tip)}">${svgIcon('alert', { size: 16 })}<span>Differs from the bank by <span class="num">${esc(fmtIn(r.diff, currency, { sign: true }))}</span>
    <span class="recon-span">${esc(span)} · missing or duplicate transactions</span></span>${svgIcon('chevron-right', { size: 16 })}</a>`;
}

// Main card (O2). For the period you're in, the real balance of your MAIN current
// account is the truth ("what I have until payday"); past periods show what was left over.
function heroCard({ s, isCurrent, used, daysLeft }) {
  const main = L().mainAccount;
  const v = main?.balance ? accountView(main) : null;
  const until = P().payday ? 'payday' : 'month end';
  const pct = Math.round(used * 100);
  // The fill carries severity: accent, then amber from 85%, red when everything is used.
  const level = !s.income ? '' : used >= 1 ? ' critical' : used >= 0.85 ? ' warning' : '';
  const meterText = s.income ? `${pct}% of income spent${s.saved ? ' or saved' : ''}` : 'No income recorded yet';
  const meter = `<div class="hero-meter${level}">
      <div class="meter" role="img" aria-label="${esc(meterText)}"><i style="width:${(used * 100).toFixed(1)}%"></i></div>
      <span class="meter-label">${esc(meterText)}</span>
    </div>`;
  const mini = (label, value, sub = '', cls = '') => `<div class="hero-mini"><span class="hero-mini-label">${label}</span><span class="hero-mini-value num ${cls}">${value}</span>${sub ? `<span class="hero-mini-sub">${sub}</span>` : ''}</div>`;
  const days = `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  const net = round2(s.income - s.spend);
  if (isCurrent && v?.known) {
    const balance = v.cash;
    const perDay = balance > 0 && daysLeft ? balance / daysLeft : 0;
    return `<div class="card hero-card">
      <span class="hero-label">${svgIcon('wallet', { size: 18 })}<span>${esc(accountName(main))}</span></span>
      ${bigAmount(balance)}
      ${updatedHTML(main)}
      ${meter}
      <div class="hero-minis">
        ${mini(`Per day until ${until}`, perDay ? `≈ ${formatRON(perDay, { short: true })}` : formatRON(0, { short: true }), days)}
        ${mini('This period', formatRON(net, { sign: true, short: true }), 'Money in − out', net < 0 ? 'neg' : '')}
      </div>
      ${reconcileHTML(main)}
    </div>`;
  }
  const perDay = isCurrent && s.left > 0 && daysLeft ? s.left / daysLeft : 0;
  const foreign = isCurrent && v?.excludedForeign
    ? `<span class="hero-note">${esc(accountName(main))} shows ${esc(fmtIn(v.amount, v.currency))}: another currency, so it isn’t used here.</span>` : '';
  return `<div class="card hero-card">
    <span class="hero-label">${svgIcon('wallet', { size: 18 })}<span>${isCurrent ? `Left to spend until ${until}` : (P().payday ? 'Left over that pay period' : 'Left over that month')}</span></span>
    ${bigAmount(s.left)}
    <span class="hero-note">${L().mode === 'cashflow' ? 'Money in − money out of the current account' : 'All accounts added up'}</span>
    ${foreign}
    ${meter}
    ${isCurrent ? `<div class="hero-minis">${mini(`Per day until ${until}`, perDay ? `≈ ${formatRON(perDay, { short: true })}` : formatRON(0, { short: true }), days)}</div>` : ''}
  </div>`;
}

// Credit card (O6): what was spent on it, what was paid back, what's still owed,
// and when it's cleared at the current pace (shared/planner.js cardPeriod / cardPace).
function creditCardPanel(key) {
  const cards = linkedAccounts().filter((a) => accountView(a).kind === 'credit');
  if (!cards.length) return '';
  const owed = cards.reduce((sum, a) => sum + accountView(a).owed, 0);
  const onCard = S().transactions.filter((t) => L().kindOf(t) === 'credit');
  const opts = { isRefund: (t) => L().isRefund(t), refundCategory: (t) => L().refundCategory(t) };
  const periodOf = (k) => ({ key: k, ...cardPeriod(onCard.filter((t) => keyOf(t.date) === k), opts) });
  const now = periodOf(key);
  const firstDate = onCard.reduce((min, t) => (!min || t.date < min ? t.date : min), null);
  const firstKey = firstDate ? keyOf(firstDate) : null;
  const past = [1, 2, 3].map((i) => periodOf(addMonths(P().current(), -i)));
  const covered = past.filter((p) => (firstKey ? p.key >= firstKey : p.count > 0));
  const { periods, avgSpent, avgRepaid, net } = cardPace(past, { firstKey });
  const span = periods === 1 ? 'last period' : `last ${periods} periods`;
  const top = Object.entries(now.cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const in12 = owed / 12 + avgSpent;
  const short = (n) => formatRON(n, { short: true });
  const digits = [...L().byDigits].filter(([, a]) => cards.some((c) => c.uid === a.uid)).map(([x]) => x);
  const asOf = cards.length === 1 ? balanceAsOf(cards[0]) : null;
  // Label and value share the top line (the value drops under the label only when it can't fit); the note goes below.
  const kpi = (label, value, sub = '', cls = '') => `<div class="cc-kpi"><span class="cc-kpi-top"><span class="cc-kpi-label">${label}</span><span class="cc-kpi-value num ${cls}">${value}</span></span>${sub ? `<span class="cc-kpi-sub">${sub}</span>` : ''}</div>`;
  const row = (label, value, sub = '', cls = '') => `<div class="row cc-row"><span class="ov-row-main"><span class="ov-row-top"><span class="row-label">${label}</span><span class="ov-row-value ${cls}">${value}</span></span>${sub ? `<span class="sub">${sub}</span>` : ''}</span></div>`;
  let pace;
  if (!owed) pace = `<p class="cc-note good">${svgIcon('check', { size: 16 })}Nothing owed on the card.</p>`;
  else if (!covered.length) pace = '<p class="cc-note">Not enough card history yet to work out your repayment pace.</p>';
  else {
    const clears = net > 1 && owed / net <= 120;
    pace = `<div class="list cc-pace">
      ${row('At your pace', clears ? `Debt-free in ~${Math.ceil(owed / net)} months` : 'Not going down', `Repaid ${short(avgRepaid)}, spent ${short(avgSpent)} a period (${span})`, clears ? '' : 'warn')}
      ${row('Debt-free in 12 months', `<span class="num">${short(in12)}</span> a month`, `Repay this and keep card spending at ${short(avgSpent)} or less`)}
    </div>`;
  }
  return `<div class="card card-panel cc-panel">
    <div class="card-head">${cardTitle('card', 'Credit card', { after: digits.length ? ` <span class="cc-digits num">··${esc(digits.join(', ··'))}</span>` : '' })}<a class="link" href="${accountTxLink(cards[0].uid, key)}">Transactions${svgIcon('chevron-right', { size: 16 })}</a></div>
    <div class="cc-kpis">
      ${kpi('Owed', formatRON(owed), asOf ? `Updated ${esc(asOf.text)}${asOf.stale ? ' <span class="badge warning">Stale</span>' : ''}` : 'Now')}
      ${kpi('Spent this period', formatRON(now.spent), now.refunded ? `After ${short(now.refunded)} refunded` : '')}
      ${kpi('Paid back this period', formatRON(now.repaid), '', now.repaid > 0 ? 'pos' : '')}
    </div>
    ${pace}
    ${top.length ? `<span class="section-label cc-top-label">Top on the card this period (RON)</span>
      <div class="chips cc-chips">${top.map(([c, v]) => `<span class="chip"><span class="chip-emoji" aria-hidden="true">${esc(icon(c))}</span>${esc(c)} <b class="num">${short(v).replace(/\s*RON$/u, '')}</b></span>`).join('')}</div>` : ''}
  </div>`;
}

// Overview strip: Current | Savings | Card owed | Net, from the bank balances.
function accountsStrip() {
  const accs = linkedAccounts().filter((a) => a.balance);
  const rows = accs.map((a) => ({ a, v: accountView(a) }));
  if (!accs.length || (accs.length === 1 && rows[0].v.kind === 'current')) return '';
  const t = bankTotals(accs);
  const sum = (kind) => rows.filter((x) => x.v.kind === kind).reduce((n, x) => n + x.v.cash, 0);
  const has = (kind) => rows.some((x) => x.v.kind === kind);
  const of = (kind) => rows.filter((x) => x.v.kind === kind && x.v.known);
  // One account of a kind: its nickname or last digits ("··1021"); several: how many.
  const who = (kind) => {
    const list = of(kind);
    if (list.length > 1) return `${list.length} accounts`;
    if (!list.length) return '';
    const a = list[0].a;
    return String(a.nickname || '').trim() || (accountDigits(a) ? `··${accountDigits(a)}` : '');
  };
  const cell = (ico, label, value, cls = '', sub = '') => `<div class="strip-cell"><span class="strip-label">${ico ? svgIcon(ico, { size: 16 }) : ''}${label}</span><span class="strip-value num ${cls}">${value}</span>${sub ? `<span class="strip-sub">${esc(sub)}</span>` : ''}</div>`;
  const foreign = rows.filter((x) => x.v.excludedForeign);
  const excluded = foreign.length
    ? `<p class="caption strip-note">Not included: ${foreign.map((x) => `${esc(fmtIn(x.v.amount, x.v.currency))} (${esc(accountName(x.a, { short: true }))})`).join(', ')}, no RON value yet.</p>` : '';
  return `<div class="card accounts-strip" aria-label="Bank accounts">
    <div class="strip-cells">
      ${cell('wallet', 'Current', formatRON(sum('current')), '', who('current'))}
      ${cell('savings', 'Savings', has('savings') ? formatRON(sum('savings')) : '—', '', has('savings') ? who('savings') : 'None linked')}
      ${cell('card', 'Card owed', has('credit') ? (t.owed ? `−${formatRON(t.owed)}` : formatRON(0)) : '—', t.owed ? 'neg' : '', has('credit') ? who('credit') : 'No card linked')}
      ${cell('', 'Net', formatRON(t.net, { sign: true }), t.net < 0 ? 'neg' : '', 'Cash − card debt')}
    </div>
    ${excluded}
  </div>`;
}

// Goals page (GO3): what the goals hold vs what's really in the savings account.
function goalsVsSavings(goals) {
  const active = goals.filter((g) => !g.archived);
  if (!active.length) return '';
  const total = round2(active.reduce((n, g) => n + (g.saved || 0), 0));
  const savings = linkedAccounts().filter((a) => a.balance && accountView(a).kind === 'savings');
  const stat = (label, value, sub = '') => `<div class="gs-stat"><span class="gs-label">${label}</span><span class="gs-value num">${value}</span>${sub ? `<span class="caption">${sub}</span>` : ''}</div>`;
  const goalsStat = stat('In your goals', formatRON(total), `${active.length} goal${active.length === 1 ? '' : 's'}`);
  if (!savings.length) {
    return `<div class="card goals-summary"><div class="gs-stats">${goalsStat}${stat('Savings account', '—', 'None linked to compare with')}</div></div>`;
  }
  const bal = round2(savings.reduce((n, a) => n + accountView(a).cash, 0));
  const short = round2(total - bal);
  return `<div class="card goals-summary">
    <div class="gs-stats">${goalsStat}${stat(savings.length === 1 ? esc(accountName(savings[0])) : 'Savings accounts', formatRON(bal), 'Bank balance')}</div>
    ${short > 0.01
    ? `<div class="banner warn gs-alert">${iconTile('alert', { tone: 'warning' })}<div><b>Your goals count ${formatRON(short)} more than the savings account holds</b>
        <div class="small muted">Move that money to savings, or withdraw it from a goal so the goals match reality.</div></div></div>`
    : `<p class="gs-ok">${svgIcon('check', { size: 16 })}The savings account covers all your goals.</p>`}
  </div>`;
}

// Plan header (P4): which dates each account has transactions for, one row per account, with years.
function dataCoverage() {
  const by = new Map();
  for (const t of S().transactions) {
    if (t.source !== 'bank' && t.source !== 'import') continue;
    const a = L().accountOf(t);
    const k = a?.uid || '';
    const e = by.get(k) || { a, first: t.date, last: t.date };
    if (t.date < e.first) e.first = t.date;
    if (t.date > e.last) e.last = t.date;
    by.set(k, e);
  }
  if (!by.size) return '';
  const rows = [...by.values()].sort((x, y) => x.first.localeCompare(y.first)).map((e) => `<div class="row">
      <span><span class="row-label">${esc(e.a ? accountName(e.a) : 'No account')}</span><span class="sub pl-dates">${esc(fmtDate(e.first))} – ${esc(fmtDate(e.last))}</span></span>
    </div>`);
  return `<div class="pc-block pl-coverage"><span class="section-label">Data the plan learns from</span><div class="list">${rows.join('')}</div></div>`;
}

// First counted transaction date: periods starting before it are only partly covered.
function isPartialPeriod(k) {
  const first = S().transactions.reduce((min, t) => (L().effect(t).as && (!min || t.date < min) ? t.date : min), null);
  return Boolean(first && keyOf(first) === k && P().start(k) < first);
}

function unassignedBanner() {
  const accounts = S().bank.connections.flatMap((c) => c.accounts);
  if (accounts.length < 2) return '';
  const n = S().transactions.filter((t) => t.source === 'import' && !t.accountId).length;
  if (!n) return '';
  return `<div class="banner warn ov-banner">${iconTile('alert', { tone: 'warning' })}<div><b>${n} imported transactions don’t know their account</b>
    <div class="small muted">Card purchases may be counted as current-account spending. For exact totals, delete the imported transactions in Settings, then import each statement again and pick its account.</div></div></div>`;
}

function debtBanner() {
  const { owed } = bankTotals(S().bank.connections.flatMap((c) => c.accounts));
  if (!owed) return '';
  const hasGoal = S().goals.some((g) => /card/i.test(g.name));
  return `<div class="banner callout">${iconTile('card', { tone: 'warning' })}<div>
    <b>You owe ${formatRON(owed)} on your credit card</b>
    <div class="muted small">Card interest is usually much higher than anything savings earn, so paying it off first is the best “saving” there is. Repay the full statement balance before the grace period ends to pay no interest at all.</div>
    ${hasGoal ? '' : '<button class="btn small primary" type="button" data-action="debt-goal">Make paying it off a goal</button>'}
  </div></div>`;
}

// Plan tips (P1): a tinted icon per level, the first clause bold, the rest muted.
const TIP_LOOK = { info: ['bulb', 'accent'], warning: ['alert', 'warning'], critical: ['alert', 'critical'], good: ['check', 'good'] };
function tipRow(t) {
  const [ico, tone] = TIP_LOOK[t.level] || TIP_LOOK.info;
  const text = String(t.text || '').replace(/^\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*\s*/u, '');
  // "Shopping: you spend …" → lead "Shopping"; otherwise everything up to the last sentence is the lead
  // ("… total ~1.240 RON/month (names). | Cancel any you no longer use."), so merchant names never split it.
  const colon = text.indexOf(': ');
  const stop = text.lastIndexOf('. ', text.length - 2);
  let lead = text; let rest = '';
  if (colon > 0 && colon <= 40) { lead = text.slice(0, colon); rest = text.slice(colon + 2); } else if (stop > 0) { lead = text.slice(0, stop + 1); rest = text.slice(stop + 2); }
  rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  return `<li class="row pl-tip">${iconTile(ico, { tone })}<span class="pl-tip-text"><b>${esc(lead)}</b>${rest ? ` <span class="muted">${esc(rest)}</span>` : ''}</span></li>`;
}

function openAccountModal(accUid) {
  const a = S().bank.connections.flatMap((c) => c.accounts).find((x) => x.uid === accUid);
  if (!a) return;
  const v = accountView(a);
  const raw = a.balance ? Number(a.balance.amount) : 0;
  const meaning = a.balanceMeaning || 'auto';
  openModal(`
    <h2 id="modal-title">Account settings</h2>
    <div class="list acct-sum">
      <div class="row"><span class="row-label">Account</span><span class="row-value">${esc(ACCOUNT_KINDS[v.kind])}${a.bank ? ` · ${esc(a.bank)}` : ''}</span></div>
      ${a.iban ? `<div class="row"><span class="row-label">IBAN</span><span class="row-value num">${esc(maskIban(a.iban))}</span></div>` : ''}
      <div class="row"><span class="row-label">The bank reports</span><span class="row-value num">${esc(formatRON(raw))}</span></div>
    </div>
    <label class="field">Name<input name="nickname" maxlength="40" value="${esc(a.nickname || '')}" placeholder="e.g. ING card" autocomplete="off"></label>
    <label class="field">Card numbers on this account (last 4 digits)<input name="cardDigits" inputmode="numeric" value="${esc((a.cardDigits || [...L().byDigits].filter(([, x]) => x.uid === a.uid).map(([d]) => d)).join(', '))}" placeholder="e.g. 7204" autocomplete="off"></label>
    <label class="field">Type<select name="kind">${Object.entries(ACCOUNT_KINDS).map(([k, label]) => `<option value="${k}" ${k === v.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <div id="credit-fields" class="stack" style="gap:16px" ${v.kind === 'credit' ? '' : 'hidden'}>
      <label class="field">Credit limit (RON)<input class="money-input" name="creditLimit" inputmode="decimal" value="${esc(formatAmountInput(a.creditLimit))}" placeholder="9.900,00" autocomplete="off"></label>
      <fieldset class="field option-group"><legend>What does the bank’s number (<span class="num">${esc(formatRON(raw))}</span>) mean?</legend>
        <label class="option"><input type="radio" name="balanceMeaning" value="owed" ${balanceMeaning(a) === 'owed' && meaning !== 'auto' ? 'checked' : ''}> <span id="opt-owed"></span></label>
        <label class="option"><input type="radio" name="balanceMeaning" value="available" ${meaning === 'available' ? 'checked' : ''}> <span id="opt-available"></span></label>
        <label class="option"><input type="radio" name="balanceMeaning" value="auto" ${meaning === 'auto' ? 'checked' : ''}> <span>Let the app decide</span></label>
      </fieldset>
      <p class="muted small" style="margin:0">Pick the option that matches what your banking app shows. Card debt is never counted as money you have, and the Plan suggests paying it off.</p>
    </div>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`, async (_, fd) => {
    const kind = fd.get('kind');
    const limit = round2(parseAmount(fd.get('creditLimit') || '0')) || 0;
    if (kind === 'credit' && !(limit > 0)) throw new Error('Enter the card’s credit limit.');
    const body = {
      cardDigits: String(fd.get('cardDigits') || '').match(/\d{4}/g) || [],
      nickname: fd.get('nickname') || '',
      kind,
      creditLimit: kind === 'credit' ? limit : 0,
      balanceMeaning: kind === 'credit' ? fd.get('balanceMeaning') || 'auto' : 'auto',
    };
    await data.fetch(`/api/bank/accounts/${encodeURIComponent(a.uid)}`, { method: 'PUT', body });
    await data.refresh();
    toast('Account updated');
    return false;
  });
  const form = modalForm;
  const preview = () => {
    const limit = round2(parseAmount(form.creditLimit.value || '0')) || 0;
    const owedIfOwed = raw < 0 ? -raw : raw;
    $('#opt-owed', form).innerHTML = `It’s what I’ve spent / owe<span class="sub">Owed <b class="num">${formatRON(owedIfOwed)}</b>${limit ? `, available <span class="num">${formatRON(Math.max(limit - owedIfOwed, 0))}</span>` : ''}</span>`;
    $('#opt-available', form).innerHTML = `It’s what I can still spend<span class="sub">${limit ? `Owed <b class="num">${formatRON(Math.max(limit - raw, 0))}</b>, available <span class="num">${formatRON(raw)}</span>` : 'Enter the limit to see what you owe'}</span>`;
  };
  preview();
  form.creditLimit.addEventListener('input', preview);
  form.kind.addEventListener('change', () => { $('#credit-fields', form).hidden = form.kind.value !== 'credit'; });
  formatMoneyOnBlur(form);
}

// "RO49 •••• 7204": enough to recognise the account without showing the whole IBAN.
function maskIban(iban) {
  const s = String(iban || '').replace(/\s/g, '');
  return s.length > 8 ? `${s.slice(0, 4)} •••• ${s.slice(-4)}` : s;
}

const CATEGORY_ICONS = ['🏷️', '🛒', '🍕', '☕', '🚗', '⛽', '🏠', '💡', '📱', '💊', '👕', '🎬', '✈️', '🎁', '🐾', '👶', '📚', '💼'];
function openCategoryModal() {
  openModal(`
    <h2 id="modal-title">New category</h2>
    <label class="field">Name<input name="name" maxlength="40" required autofocus autocomplete="off" placeholder="e.g. Gym, Pets"></label>
    <fieldset class="field"><legend>Type</legend>
      <div class="segmented seg-radio">
        <label><input class="sr-only" type="radio" name="kind" value="expense" checked><span>Expense</span></label>
        <label><input class="sr-only" type="radio" name="kind" value="income"><span>Income</span></label>
      </div>
    </fieldset>
    <fieldset class="field icon-field"><legend>Icon</legend>
      <div class="icon-picker">${CATEGORY_ICONS.map((i, n) => `<label class="icon-opt"><input class="sr-only" type="radio" name="icon" value="${i}" ${n === 0 ? 'checked' : ''}><span aria-hidden="true">${i}</span><span class="sr-only">${i}</span></label>`).join('')}</div>
      <input class="icon-custom" name="iconCustom" maxlength="4" placeholder="Or type any emoji" aria-label="Other emoji" autocomplete="off">
    </fieldset>
    <label class="checkbox"><input type="checkbox" name="essential"> Essential (the planner won't suggest cutting it)</label>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">Add category</button>
    </div>`, async (_, fd) => {
    const name = fd.get('name').trim();
    if (!name) throw new Error('Name is required.');
    if (S().categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error('That category already exists.');
    const iconValue = String(fd.get('iconCustom') || '').trim() || fd.get('icon') || '🏷️';
    data.setCategories([...S().categories, { name, icon: iconValue, kind: fd.get('kind') || 'expense', essential: Boolean(fd.get('essential')) }]);
    return false;
  });
}

// ---------------------------------------------------------------- actions
async function loadBanks() {
  ui.banks = [];
  try {
    const { banks } = await data.fetch('/api/bank/banks?country=RO');
    ui.banks = banks.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    toast(`Couldn't load the bank list: ${err.message}`);
  }
  if (ui.route === 'settings') render();
}

async function syncBank(force = true) {
  if (!S()?.bank?.connections?.length) return;
  if (force) { S().bank.syncing = true; render(); }
  try {
    const r = await data.fetch('/api/bank/sync', { method: 'POST', body: { force } });
    if (force) toast(r.skipped ? `Already up to date (${r.skipped})` : `Bank synced — ${r.added} new transaction${r.added === 1 ? '' : 's'}`);
  } catch (err) {
    if (force) toast(err.message);
  } finally {
    await data.refresh();
  }
}

const actions = {
  'add-tx': () => openTxModal(),
  'edit-tx': (el) => { const t = S().transactions.find((x) => x.id === el.dataset.id); if (t) openTxModal(t); },
  'delete-tx': (el, e) => { e.stopPropagation(); deleteTx(el.dataset.id); },
  month: (el) => { ui.month = addMonths(ui.month || P().current(), Number(el.dataset.delta)); render(); },
  'more-tx': () => { ui.tx.limit += 150; render(); },
  'tx-all-months': () => { ui.tx = { ...ui.tx, month: '', limit: 150 }; render(); },
  'tx-clear': () => { ui.tx = { ...TX_DEFAULTS }; render(); },
  'tx-uncounted': () => { ui.tx = { ...ui.tx, counted: false, limit: 150 }; render(); },
  'tx-counted': () => { ui.tx = { ...ui.tx, counted: true, limit: 150 }; render(); },
  'add-goal': () => openGoalModal(),
  'edit-goal': (el) => openGoalModal(S().goals.find((g) => g.id === el.dataset.id)),
  contribute: (el) => openContributionModal(S().goals.find((g) => g.id === el.dataset.id)),
  withdraw: (el) => openContributionModal(S().goals.find((g) => g.id === el.dataset.id), true),
  intensity: (el) => { data.setSettings({ planIntensity: el.dataset.value }); },
  'apply-budgets': () => {
    const { plan } = currentPlan();
    data.setBudgets(Object.fromEntries(plan.budgets.map((b) => [b.name, b.limit])));
    toast('Budgets set — you\'ll see them on the Overview bars');
  },
  'sync-bank': () => syncBank(true),
  'link-bank': async () => {
    const bank = $('#bank-select')?.value;
    if (!bank) return toast('Choose your bank first');
    try {
      const { url } = await data.fetch('/api/bank/link', { method: 'POST', body: { bank, country: 'RO' } });
      location.href = url;
    } catch (err) { toast(err.message); }
    return undefined;
  },
  'complete-bank': async () => {
    try {
      await data.fetch('/api/bank/complete', { method: 'POST', body: { url: $('#bank-landed').value.trim() } });
      toast('Bank linked — importing transactions…');
      await data.refresh();
    } catch (err) { toast(err.message); }
  },
  'unlink-bank': async (el) => {
    if (!await confirmSheet({ title: 'Unlink this bank?', message: 'Transactions already imported are kept.', confirmLabel: 'Unlink' })) return;
    try { await data.fetch(`/api/bank/connections/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' }); await data.refresh(); } catch (err) { toast(err.message); }
  },
  'csv-import': async (el) => {
    if (!ui.csvPreview) return;
    el.disabled = true; // no double import on a double tap
    try {
      const r = await data.fetch('/api/transactions/import', { method: 'POST', body: { items: ui.csvPreview.items, accountId: ui.csvAccount || undefined } });
      ui.csvPreview = null;
      await data.refresh();
      const msg = `Imported ${r.added} transaction${r.added === 1 ? '' : 's'}${r.skipped ? ` · skipped ${r.skipped} already in app` : ''}`;
      toast(msg, r.added && r.batchId ? {
        label: 'Undo',
        run: async () => {
          try {
            const { removed } = await data.undoImport(r.batchId);
            toast(`Import undone — ${removed} transaction${removed === 1 ? '' : 's'} moved to the trash`);
          } catch (err) { toast(err.message); }
        },
      } : undefined);
    } catch (err) { el.disabled = false; toast(err.message); }
  },
  'csv-cancel': () => { ui.csvPreview = null; render(); },
  'add-category': () => openCategoryModal(),
  'delete-category': async (el) => {
    const c = S().categories[Number(el.dataset.index)];
    if (!c || !await confirmSheet({ title: `Delete category “${c.name}”?`, message: 'Existing transactions keep the name.', confirmLabel: 'Delete category' })) return;
    data.setCategories(S().categories.filter((_, i) => i !== Number(el.dataset.index)));
  },
  'delete-rule': (el) => data.deleteRule(el.dataset.pattern),
  'add-rule': () => openRuleModal(),
  'edit-payday': (el) => openPaydayModal(el.dataset.key),
  'salary-auto': (el) => {
    const paydays = { ...(S().settings?.paydays || {}) };
    delete paydays[el.dataset.key];
    data.setSettings({ paydays });
  },
  'delete-imported': async () => {
    if (!await confirmSheet({ title: 'Delete all imported transactions?', message: 'Every transaction that came from a CSV import goes to the trash. Bank-synced and manual ones stay.', confirmLabel: 'Delete imported' })) return;
    try {
      const { removed } = await data.fetch('/api/transactions/imported', { method: 'DELETE' });
      await data.refresh();
      toast(`Removed ${removed} imported transactions`);
    } catch (err) { toast(err.message); }
  },
  'edit-rule': (el) => openRuleModal(S().rules[Number(el.dataset.index)]),
  recategorize: () => { data.recategorizeAll(); toast('Categories updated'); },
  'edit-account': (el) => openAccountModal(el.dataset.id),
  'balance-meaning': async (el) => {
    el.disabled = true;
    try {
      await data.fetch(`/api/bank/accounts/${encodeURIComponent(el.dataset.id)}`, { method: 'PUT', body: { balanceMeaning: el.dataset.value } });
      await data.refresh();
      toast(el.dataset.value === 'owed' ? 'Got it: that’s what you owe' : 'Got it: that’s what you can still spend');
    } catch (err) { el.disabled = false; toast(err.message); }
  },
  'restore-tx': async (el) => {
    if (!el.dataset.id) return;
    el.disabled = true;
    try {
      await data.restoreTransaction(el.dataset.id);
      ui.trash = Array.isArray(ui.trash) ? ui.trash.filter((e) => e.tx?.id !== el.dataset.id) : ui.trash;
      ui.trashFor = null;
      render();
      toast('Transaction restored');
    } catch (err) { el.disabled = false; toast(err.message); }
  },
  'trash-all': () => { ui.trashAll = true; render(); },
  'debt-goal': () => {
    const { owed } = bankTotals(S().bank.connections.flatMap((c) => c.accounts));
    data.upsertGoal({ id: uid(), name: 'Pay off credit card', icon: '💳', target: owed, initialSaved: 0, deadline: null, priority: 'high' });
    toast('Goal added — the plan now includes paying off the card');
  },
  install: async () => { ui.installPrompt?.prompt(); ui.installPrompt = null; render(); },
  export: () => {
    if (window.BudgetApp?.saveFile) {
      window.BudgetApp.saveFile(`budget-${todayISO()}.json`, 'application/json', JSON.stringify(S(), null, 2));
      return;
    }
    const blob = new Blob([JSON.stringify(S(), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `budget-${todayISO()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  logout: () => data.logout(),
  'change-server': () => window.BudgetApp?.changeServer(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action] && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') {
    e.preventDefault();
    actions[el.dataset.action](el, e);
    return;
  }
  const bar = e.target.closest('.bar-row[data-category]');
  if (bar) {
    ui.tx = { ...TX_DEFAULTS, category: bar.dataset.category, month: ui.month || P().current() };
    location.hash = 'transactions';
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});

view.addEventListener('input', (e) => {
  if (e.target.dataset.filter === 'q') {
    ui.tx.q = e.target.value;
    render();
  }
});

view.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.filter && el.dataset.filter !== 'q') { ui.tx[el.dataset.filter] = el.value; ui.tx.limit = 150; render(); return; }
  switch (el.dataset.action) {
    case 'plan-goal': {
      const ids = [...view.querySelectorAll('[data-action="plan-goal"]:checked')].map((x) => x.value);
      ui.planGoals = ids; render(); break;
    }
    case 'toggle-essential': {
      const cats = S().categories.map((c, i) => (i === Number(el.dataset.index) ? { ...c, essential: el.checked } : c));
      data.setCategories(cats); break;
    }
    case 'theme': applyTheme(el.value); break;
    case 'csv-account': ui.csvAccount = el.value; render(); break; // "New / already in app" depends on the account
    case 'salary-date': {
      const k = el.dataset.key;
      const [y, m] = k.split('-').map(Number);
      const d = new Date(el.value);
      if (!el.value || Math.abs((d.getFullYear() - y) * 12 + d.getMonth() - (m - 1)) > 1) { toast('Pick a date close to that month'); render(); break; }
      data.setSettings({ paydays: { ...(S().settings?.paydays || {}), [k]: el.value } });
      toast(`${P().label(k)}: salary on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`);
      break;
    }
    case 'count-mode': data.setSettings({ countMode: el.value }); toast('Totals updated'); break;
    case 'main-account': data.setSettings({ mainAccountId: el.value || null }); toast('Main current account updated'); break;
    case 'period-mode':
    case 'payday-day': {
      const mode = view.querySelector('[data-action="period-mode"]:checked')?.value;
      const day = Math.min(Math.max(Number(view.querySelector('[data-action="payday-day"]').value) || 10, 1), 28);
      data.setSettings({ payday: mode === 'payday' ? day : null });
      ui.month = null; ui.tx.month = null;
      toast(mode === 'payday' ? `Budget months now start on payday (day ${day})` : 'Budget months follow the calendar');
      break;
    }
    case 'csv-file': {
      const file = el.files?.[0];
      if (!file) return;
      ui.csvFile = file.name; // shown next to the "Choose CSV file" button (screens-settings)
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1250').decode(buf); // older Romanian exports
      try { ui.csvPreview = csvToTransactions(text); } catch (err) { ui.csvPreview = null; toast(err.message); }
      // Guess the account: a credit-card statement mentions card repayments.
      const accounts = S().bank.connections.flatMap((c) => c.accounts);
      const isCard = /rambursare rata card|card(ul)? de credit|credit card/i.test(text);
      ui.csvAccount = (accounts.find((a) => accountView(a).kind === (isCard ? 'credit' : 'current')) || accounts[0])?.uid || '';
      render();
      break;
    }
    default:
  }
});

function applyTheme(t) {
  try { localStorage.setItem('bp.theme', t); } catch { /* ignore */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// Phone: the + button gets out of the way while scrolling down (so it never
// covers amounts) and comes back as soon as you scroll up or reach the top.
function watchFabScroll() {
  const fab = $('.fab');
  if (!fab) return;
  let lastY = window.scrollY;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 6) {
        fab.classList.toggle('fab-hidden', y > lastY && y > 80);
        lastY = y;
      }
      if (y <= 80) fab.classList.remove('fab-hidden');
      ticking = false;
    });
  }, { passive: true });
  window.addEventListener('hashchange', () => fab.classList.remove('fab-hidden'));
}

// ---------------------------------------------------------------- boot
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  route();
  renderStatus();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form').password.focus();
}

async function boot() {
  try { applyTheme(localStorage.getItem('bp.theme') || 'system'); } catch { /* ignore */ }
  attachTooltips(document.body, $('#tooltip'));
  data.addEventListener('change', () => { render(); renderStatus(); });
  data.addEventListener('status', renderStatus);
  data.addEventListener('error', (e) => toast(e.detail));
  data.addEventListener('auth', showLogin);
  window.addEventListener('hashchange', route);
  watchFabScroll();
  window.addEventListener('online', () => data.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { data.flush(); syncBank(false); }
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; if (ui.route === 'settings') render(); });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await data.login(e.target.password.value);
      await data.refresh();
      if (data.state) { showApp(); data.connectLive(); syncBank(false); }
    } catch (err) {
      $('#login-error').textContent = err.message === 'Failed to fetch' ? "Can't reach the server — are you on your home Wi-Fi?" : err.message;
    }
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (data.state) showApp(); // instant start from the cached copy

  let needsLogin = false;
  const onAuth = () => { needsLogin = true; };
  data.addEventListener('auth', onAuth, { once: true });
  await data.flush();
  if (needsLogin) return;
  if (!data.state) {
    // First run and the server is unreachable.
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').textContent = "Can't reach your budget server. Connect to your home Wi-Fi and try again.";
    return;
  }
  showApp();
  data.connectLive();
  syncBank(false);
}

boot();
