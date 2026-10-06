import { Data } from './data.js';
import { esc, categoryBars, trendChart, attachTooltips } from './charts.js';
import {
  formatRON, parseAmount, round2, todayISO, monthKey, addMonths, monthLabel, daysInMonth, monthsBetween, uid,
} from './shared/money.js';
import { SAVINGS_CATEGORY, merchantKey, escapeForRule, isUselessKeyword, ruleMatches } from './shared/categories.js';
import { analyzeHistory, buildPlan, goalSaved, INTENSITY } from './shared/planner.js';
import { csvToTransactions } from './shared/csv.js';
import { ACCOUNT_KINDS, accountView, bankTotals, balanceMeaning } from './shared/accounts.js';
import { ownContext, isOwnTransfer } from './shared/own.js';
import { makePeriods } from './shared/periods.js';
import { makeLedger, COUNT_MODES } from './shared/ledger.js';
// ux-3: add/edit modal + CSV import preview
import { categorize } from './shared/categories.js';
import { ownTransferCategory } from './shared/own.js';
import { importSeen, isSameTransaction } from './shared/dedupe.js';

const data = new Data();
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const modal = $('#modal');
const modalForm = $('#modal-form');

const ui = {
  route: 'overview',
  params: new URLSearchParams(),
  month: null, // budget period shown on the Overview (null = current)
  tx: { q: '', type: '', category: '', month: null, limit: 150 },
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

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}

function txIcon(t) {
  return t.goalId ? (S().goals.find((g) => g.id === t.goalId)?.icon || icon(t.category)) : icon(t.category);
}

function txRow(t, { showDelete = true } = {}) {
  const acc = L().accountOf(t);
  const accLabel = acc && accountView(acc).kind !== 'current' ? ACCOUNT_KINDS[accountView(acc).kind] : null;
  const meta = [t.category, accLabel, t.source === 'bank' ? 'Bank' : t.source === 'import' ? 'Imported' : null, counts(t) ? null : 'not counted'].filter(Boolean).join(' · ');
  return `<div class="tx" role="button" tabindex="0" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="tx-ico" aria-hidden="true">${esc(txIcon(t))}</span>
    <span class="tx-main"><span class="tx-desc">${esc(t.description)}</span><span class="tx-meta">${esc(meta)}${t.note ? ` · ${esc(t.note)}` : ''}</span></span>
    <span class="tx-amt">${amountHTML(t)}</span>
    ${showDelete ? `<button class="tx-del" type="button" data-action="delete-tx" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.description)}">✕</button>` : '<span></span>'}
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

    return `
      <div class="month-switch" role="group" aria-label="Month">
        <button type="button" data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
        <span>${esc(P().label(key))}${P().payday ? `<small class="muted" style="display:block;font-weight:400;font-size:11.5px">${esc(P().rangeLabel(key))}</small>` : ''}</span>
        <button type="button" data-action="month" data-delta="1" aria-label="Next month">›</button>
      </div>
      ${P().payday ? `<button class="btn small" type="button" data-action="edit-payday" data-key="${esc(key)}" style="margin-left:8px">💼 Salary on ${esc(new Date(P().start(key)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}${S().settings?.paydays?.[key] ? ' (set by you)' : ''} ✎</button>` : ''}
      ${unassignedBanner()}
      ${s.count ? '' : `<div class="banner" style="margin-top:12px"><span class="banner-ico" aria-hidden="true">📭</span><div class="small"><b>No current-account transactions in this period.</b> The bank connection only goes back about 90 days — for older months import the current account statement (CSV) in Settings and pick the current account.</div></div>`}
      <div class="hero">
        ${heroCard({ s, key, isCurrent, used, daysLeft, accounts })}
        <div class="card"><span class="stat-label">Income</span><span class="stat-value num pos">${formatRON(s.income)}</span><span class="stat-sub">${s.ownIn ? `${formatRON(s.income - s.ownIn, { short: true })} earned + ${formatRON(s.ownIn, { short: true })} from your own accounts / cash` : pctChange(s.income, summary(addMonths(key, -1)).income)}</span></div>
        <div class="card"><span class="stat-label">Spending</span><span class="stat-value num">${formatRON(s.spend)}</span><span class="stat-sub">${budgetTotal ? `Budget ${formatRON(budgetTotal, { short: true })}` : pctChange(s.spend, summary(addMonths(key, -1)).spend)}</span></div>
        <div class="card"><span class="stat-label">Saved to goals</span><span class="stat-value num">${formatRON(s.saved)}</span><span class="stat-sub">${s.income ? `${Math.round((s.saved / s.income) * 100)}% savings rate` : '—'}</span></div>
      </div>
      ${creditCardPanel(key)}
      <div class="grid two">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Spending by category</h2><a class="link" href="#plan">Set budgets →</a></div>
            ${categoryBars(rows.filter((r) => r.value > 0 || r.limit), s.spend)}
          </div>
          <div class="card">
            <div class="card-head"><h2>Income vs spending</h2>
              <div class="legend"><span><i style="background:var(--series-1)"></i>Income</span><span><i style="background:var(--series-2)"></i>Spending</span></div>
            </div>
            ${trendChart(months.map((m) => ({ ...m, noData: !m.count })))}
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Goals</h2><a class="link" href="#goals">All goals →</a></div>
            ${goals.length ? goals.map((g) => `
              <div class="mini-goal">
                <div class="row"><span>${esc(g.icon || '🎯')} ${esc(g.name)}</span><span class="num"><b>${formatRON(g.saved, { short: true })}</b> <span class="muted">/ ${formatRON(g.target, { short: true })}</span></span></div>
                <div class="progress" role="progressbar" aria-valuenow="${Math.round(g.pct * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)}"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></div>
              </div>`).join('') : `<div class="empty"><b>No goals yet</b><button class="btn small" type="button" data-action="add-goal">Add a goal</button></div>`}
          </div>
          <div class="card">
            <div class="card-head"><h2>Recent</h2><a class="link" href="#transactions">See all →</a></div>
            <div class="tx-list">${recent.length ? recent.map((t) => txRow(t, { showDelete: false })).join('') : '<div class="empty">Nothing this month yet.</div>'}</div>
          </div>
        </div>
      </div>`;
  },

  transactions() {
    const f = ui.tx;
    const q = f.q.toLowerCase();
    const month = f.month === null ? P().current() : f.month;
    const list = sortTx(S().transactions.filter((t) => (!month || keyOf(t.date) === month)
      && (!f.type || t.type === f.type)
      && (!f.category || t.category === f.category)
      && (!q || `${t.description} ${t.note || ''} ${t.category}`.toLowerCase().includes(q))));
    const { income, spend } = L().totals(list);
    const monthsWithData = [...new Set([P().current(), ...S().transactions.map((t) => keyOf(t.date))])].sort().reverse();

    let html = '';
    let lastDay = '';
    for (const t of list.slice(0, f.limit)) {
      if (t.date !== lastDay) {
        const dayTotal = list.filter((x) => x.date === t.date && counts(x) === 'expense').reduce((s, x) => s + x.amount, 0);
        html += `<div class="tx-day"><span>${esc(dayHeading(t.date))}</span><span class="num">${dayTotal ? `−${formatRON(dayTotal)}` : ''}</span></div>`;
        lastDay = t.date;
      }
      html += txRow(t);
    }
    return `
      <div class="card">
        <div class="filters">
          <input type="search" placeholder="Search transactions" value="${esc(f.q)}" data-filter="q" aria-label="Search">
          <select data-filter="month" aria-label="Month"><option value="">All months</option>${monthsWithData.map((k) => `<option value="${k}" ${k === month ? 'selected' : ''}>${esc(P().label(k))}${P().payday ? ` (${esc(P().rangeLabel(k))})` : ''}</option>`).join('')}</select>
          <select data-filter="type" aria-label="Type"><option value="">All types</option><option value="expense" ${f.type === 'expense' ? 'selected' : ''}>Expenses</option><option value="income" ${f.type === 'income' ? 'selected' : ''}>Income</option></select>
          <select data-filter="category" aria-label="Category"><option value="">All categories</option>${S().categories.map((c) => `<option ${c.name === f.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="totals"><span>${list.length} transaction${list.length === 1 ? '' : 's'}</span><span>In <b class="num pos">${formatRON(income)}</b></span><span>Out <b class="num">${formatRON(spend)}</b></span><span>Net <b class="num">${formatRON(income - spend, { sign: true })}</b></span></div>
        <div class="tx-list">${html || '<div class="empty"><b>No transactions</b>Try another filter, or tap + to add one.</div>'}</div>
        ${list.length > f.limit ? '<div style="text-align:center;padding-top:12px"><button class="btn" type="button" data-action="more-tx">Show more</button></div>' : ''}
      </div>`;
  },

  goals() {
    const { plan } = currentPlan(null);
    const goals = goalsWithProgress();
    const cards = goals.map((g) => {
      const p = plan.goals.find((x) => x.id === g.id);
      const monthsLeft = g.deadline ? monthsBetween(todayISO(), g.deadline) : null;
      const needed = g.deadline && !g.done ? (g.target - g.saved) / Math.max(monthsLeft, 1) : null;
      const status = g.done ? 'done' : p?.status;
      return `<div class="card goal">
        <div class="goal-top">
          <span class="goal-ico" aria-hidden="true">${esc(g.icon || '🎯')}</span>
          <div style="flex:1;min-width:0"><div class="goal-name">${esc(g.name)}</div><div class="muted small">${esc(g.priority || 'medium')} priority</div></div>
          ${status ? statusChip(status) : ''}
        </div>
        <div class="goal-amounts"><b class="num">${formatRON(g.saved)}</b><span class="muted num">of ${formatRON(g.target)}</span></div>
        <div class="progress" role="progressbar" aria-valuenow="${Math.round(g.pct * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)} progress"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></div>
        <div class="goal-facts">
          <div><span>Remaining</span><b class="num">${formatRON(Math.max(g.target - g.saved, 0))}</b></div>
          <div><span>Deadline</span><b>${g.deadline ? fmtDate(g.deadline) : 'Flexible'}</b></div>
          <div><span>${g.deadline ? 'Needs per month' : 'Planned per month'}</span><b class="num">${needed != null ? formatRON(needed, { short: true }) : '—'}</b></div>
          <div><span>Projected</span><b>${g.done ? 'Done 🎉' : p?.eta ? fmtDate(p.eta, { month: 'short', year: 'numeric' }) : '—'}</b></div>
        </div>
        <div class="goal-actions">
          <button class="btn primary small" type="button" data-action="contribute" data-id="${esc(g.id)}">+ Add money</button>
          <button class="btn small" type="button" data-action="withdraw" data-id="${esc(g.id)}">Withdraw</button>
          <button class="btn small" type="button" data-action="edit-goal" data-id="${esc(g.id)}">Edit</button>
        </div>
      </div>`;
    }).join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <p class="muted" style="margin:0">Save towards several goals at once. The <a href="#plan">Plan</a> tab shows how to reach them from your real spending habits.</p>
        <button class="btn primary" type="button" data-action="add-goal">+ New goal</button>
      </div>
      ${goals.length ? `<div class="goals-grid">${cards}</div>` : '<div class="card empty"><b>No goals yet</b>Holiday, emergency fund, a new laptop… add as many as you like.<br><br><button class="btn primary" type="button" data-action="add-goal">Create your first goal</button></div>'}`;
  },

  plan() {
    const all = goalsWithProgress().filter((g) => !g.done);
    const { analysis, plan } = currentPlan();
    const intensity = S().settings?.planIntensity || 'balanced';
    if (analysis.status === 'no-data') {
      return '<div class="card empty"><b>Not enough history yet</b>Link your bank, import a CSV statement in Settings, or add a few weeks of transactions — the plan learns from your real spending.</div>';
    }
    const selected = ui.planGoals || all.map((g) => g.id);
    const banner = {
      'on-track': ['✅', 'You can reach these goals without changing your habits.', 'Keep saving the amount below every month.'],
      'needs-cuts': ['✂️', 'Reachable with a few small cuts.', 'Trim the flexible categories below and every goal stays on schedule.'],
      stretch: ['⚠️', 'Not every goal fits your current budget.', 'The plan below gets you as close as possible — see the realistic dates and suggestions.'],
      'no-data': ['ℹ️', 'Add some transactions first.', ''],
    }[plan.status];
    const budgetsApplied = plan.budgets.every((b) => S().budgets?.[b.name] === b.limit);
    return `
      <div class="stack">
        <div class="card" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
          <div class="stack" style="gap:8px">
            <span class="stat-label">How hard should the plan push?</span>
            <div class="segmented" role="group" aria-label="Plan intensity">${Object.entries(INTENSITY).map(([k, v]) => `<button type="button" data-action="intensity" data-value="${k}" aria-pressed="${k === intensity}" title="${esc(v.hint)}">${v.label}</button>`).join('')}</div>
          </div>
          ${all.length ? `<div class="stack" style="gap:8px"><span class="stat-label">Goals in this plan</span><div class="goal-check">${all.map((g) => `<label class="chip-check"><input type="checkbox" data-action="plan-goal" value="${esc(g.id)}" ${selected.includes(g.id) ? 'checked' : ''}> ${esc(g.icon || '🎯')} ${esc(g.name)}</label>`).join('')}</div></div>` : '<a class="btn" href="#goals">Add a goal to plan for</a>'}
        </div>
        <div class="plan-summary">
          <div class="card"><span class="stat-label">Typical monthly income</span><span class="stat-value num">${formatRON(plan.income, { short: true })}</span><span class="stat-sub">avg of ${analysis.monthKeys.length} month${analysis.monthKeys.length === 1 ? '' : 's'}</span></div>
          <div class="card"><span class="stat-label">Typical monthly spending</span><span class="stat-value num">${formatRON(plan.spend, { short: true })}</span><span class="stat-sub">excl. savings & transfers</span></div>
          <div class="card"><span class="stat-label">Free each month today</span><span class="stat-value num ${plan.surplus < 0 ? 'neg' : ''}">${formatRON(plan.surplus, { short: true })}</span><span class="stat-sub">goals need ${formatRON(plan.totalRequired, { short: true })}/mo</span></div>
          <div class="card"><span class="stat-label">Save each month</span><span class="stat-value num">${formatRON(plan.monthlySaving, { short: true })}</span><span class="stat-sub">≈ ${formatRON(plan.perWeek, { short: true })}/week · ${formatRON(plan.perDay, { short: true })}/day</span></div>
        </div>
        ${debtBanner()}
        ${banner ? `<div class="banner"><span class="banner-ico" aria-hidden="true">${banner[0]}</span><div><b>${esc(banner[1])}</b><div class="muted small">${esc(banner[2])}</div></div></div>` : ''}
        ${plan.goals.length ? `<div class="card">
          <div class="card-head"><h2>Goal timeline</h2></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Goal</th><th class="r hide-sm">Remaining</th><th class="r">Deadline</th><th class="r hide-sm">Needs / month</th><th class="r">With this plan</th><th>Status</th></tr></thead>
            <tbody>${plan.goals.map((g) => `<tr>
              <td>${esc(S().goals.find((x) => x.id === g.id)?.icon || '🎯')} ${esc(g.name)}</td>
              <td class="r hide-sm">${formatRON(g.remaining, { short: true })}</td>
              <td class="r">${g.deadline ? fmtDate(g.deadline, { month: 'short', year: 'numeric' }) : 'Flexible'}</td>
              <td class="r hide-sm">${g.deadline ? formatRON(g.required, { short: true }) : '—'}</td>
              <td class="r">${g.eta ? fmtDate(g.eta, { month: 'short', year: 'numeric' }) : 'Not funded'}</td>
              <td>${statusChip(g.status)}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}
        <div class="grid two">
          <div class="card">
            <div class="card-head"><h2>Suggested monthly budgets</h2>
              <button class="btn small ${budgetsApplied ? '' : 'primary'}" type="button" data-action="apply-budgets" ${budgetsApplied ? 'disabled' : ''}>${budgetsApplied ? 'Applied ✓' : 'Use as my budgets'}</button>
            </div>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Category</th><th class="r">You spend</th><th class="r">Budget</th><th class="r hide-sm">Change</th></tr></thead>
              <tbody>${plan.budgets.map((b) => {
                const diff = b.limit - b.avg;
                return `<tr><td>${esc(b.icon)} ${esc(b.name)}${b.essential ? ' <span class="badge hide-sm">essential</span>' : ''}</td>
                  <td class="r">${formatRON(b.avg, { short: true })}</td><td class="r"><b>${formatRON(b.limit, { short: true })}</b></td>
                  <td class="r hide-sm ${diff < -1 ? 'pos' : 'muted'}">${diff < -1 ? `−${formatRON(-diff, { short: true })}` : '—'}</td></tr>`;
              }).join('')}</tbody>
            </table></div>
            <p class="muted small">Essential categories (rent, bills, groceries, transport, health) are never cut. Change which categories are essential in Settings.</p>
          </div>
          <div class="stack">
            <div class="card"><div class="card-head"><h2>What to do</h2></div>
              <ul class="tips">${plan.tips.map((t) => `<li class="${esc(t.level)}"><span>${esc(t.text)}</span></li>`).join('') || '<li>Nothing to change — nice.</li>'}</ul>
            </div>
            ${analysis.recurring.length ? `<div class="card"><div class="card-head"><h2>Recurring payments</h2></div>
              <table class="data"><tbody>${analysis.recurring.map((r) => `<tr><td>${esc(icon(r.category))} ${esc(r.label)}</td><td class="r">${formatRON(r.avg)}/mo</td></tr>`).join('')}</tbody></table></div>` : ''}
          </div>
        </div>
      </div>`;
  },

  settings() {
    const b = S().bank;
    const accounts = b.connections.flatMap((c) => c.accounts.map((a) => ({ ...a, bank: c.bank, validUntil: c.validUntil, sessionId: c.sessionId })));
    const flash = ui.params.get('bank');
    const theme = localStorage.getItem('bp.theme') || 'system';
    return `
      <div class="grid two">
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>🏦 Bank connection</h2>${b.connections.length ? `<button class="btn small" type="button" data-action="sync-bank" ${b.syncing ? 'disabled' : ''}>${b.syncing ? 'Syncing…' : '↻ Sync now'}</button>` : ''}</div>
            ${flash === 'linked' ? '<div class="banner" style="margin-bottom:12px"><span class="banner-ico">✅</span><div><b>Bank linked.</b> Importing your transactions now…</div></div>' : ''}
            ${flash === 'error' ? `<div class="banner" style="margin-bottom:12px"><span class="banner-ico">⚠️</span><div><b>Bank linking didn't finish.</b> <span class="muted">${esc(ui.params.get('reason') || '')}</span></div></div>` : ''}
            ${!b.configured ? `<p>Bank sync runs on your home server through <b>Enable Banking</b> (PSD2 open banking, free for your own accounts — supports BT, BCR, BRD, ING, Raiffeisen, CEC, Revolut…).</p>
              <p class="muted small">To turn it on, set <code class="inline">EB_APP_ID</code> and <code class="inline">EB_PRIVATE_KEY_PATH</code> in the server's <code class="inline">.env</code> file and restart it. The README has a 5-minute walkthrough.</p>` : `
              ${accounts.length ? accounts.map((a) => {
                const v = accountView(a);
                const amount = !v.known ? '—' : v.kind === 'credit' ? `Owed ${formatRON(v.owed)}` : formatRON(v.cash);
                const sub = v.kind === 'credit'
                  ? (v.limit ? `${formatRON(v.available)} available of ${formatRON(v.limit, { short: true })}` : 'Set the credit limit →')
                  : `consent until ${fmtDate(a.validUntil?.slice(0, 10))}`;
                return `<div class="acct">
                  <div><b>${esc(a.nickname || a.name || 'Account')}</b> <span class="badge">${esc(ACCOUNT_KINDS[v.kind])}</span> <span class="muted small">${esc(a.bank)}</span><div class="muted small num">${esc(a.iban || '')}</div></div>
                  <div style="text-align:right"><b class="num">${amount}</b><div class="muted small">${sub}</div>
                    <button class="btn small" type="button" data-action="edit-account" data-id="${esc(a.uid)}" style="margin-top:4px">Edit</button></div>
                </div>`;
              }).join('') : '<p class="muted">No bank linked yet.</p>'}
              <p class="muted small">${b.lastSync ? `Last sync ${new Date(b.lastSync).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.` : ''} The server syncs automatically every few hours, and whenever you open the app on your home Wi-Fi.</p>
              ${b.lastError ? `<div class="banner"><span class="banner-ico">⚠️</span><div><b>Last sync failed</b><div class="muted small">${esc(b.lastError)}</div></div></div>` : ''}
              <div class="stack" style="gap:8px;margin-top:8px">
                <label class="field">Link ${accounts.length ? 'another / re-link a' : 'your'} bank
                  <select id="bank-select"><option value="">${ui.banks ? 'Choose your bank…' : 'Loading banks…'}</option>${(ui.banks || []).map((x) => `<option>${esc(x.name)}</option>`).join('')}</select>
                </label>
                <button class="btn primary" type="button" data-action="link-bank">Connect bank</button>
                ${window.BudgetApp ? '<p class="muted small" style="margin:0">Your bank login opens in the browser. When it says the bank is linked, come back to this app.</p>' : ''}
                <details><summary class="muted small">Redirect didn't come back to the app?</summary>
                  <p class="muted small">Register <code class="inline">${esc(b.redirectUrl)}</code> as a redirect URL in the Enable Banking control panel. If your bank sent you to a different page, paste its full address here:</p>
                  <div style="display:flex;gap:8px"><input id="bank-landed" placeholder="https://…?code=…"><button class="btn" type="button" data-action="complete-bank">Finish</button></div>
                </details>
                ${b.connections.map((c) => `<button class="btn danger small" type="button" data-action="unlink-bank" data-id="${esc(c.sessionId)}">Unlink ${esc(c.bank)}</button>`).join('')}
              </div>`}
          </div>
          <div class="card">
            <div class="card-head"><h2>📄 Import a bank statement (CSV)</h2></div>
            <p class="muted small">Works with CSV exports from BT, BCR, ING, Raiffeisen, BRD, Revolut and most other banks. Duplicates are skipped automatically.</p>
            <input type="file" accept=".csv,text/csv,text/plain" data-action="csv-file" aria-label="CSV file">
            ${S().transactions.some((t) => t.source === 'import') ? `<div class="setting"><span class="small">${S().transactions.filter((t) => t.source === 'import').length} imported transactions<div class="muted small">Start over: remove them, then import the statements again.</div></span><button class="btn small danger" type="button" data-action="delete-imported">Delete imported</button></div>` : ''}
            ${ui.csvPreview ? csvPreviewHTML(b) : ''}
          </div>
          <div class="card">
            <div class="card-head"><h2>🧮 What counts as income and spending</h2></div>
            <div class="settings-list">
              ${Object.entries(COUNT_MODES).map(([k, label]) => `<label class="checkbox"><input type="radio" name="count-mode" data-action="count-mode" value="${k}" ${L().mode === k ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
              <p class="muted small" style="margin:6px 0 0">${L().mode === 'cashflow'
                ? 'Income is everything coming into your current account; spending is everything leaving it — including paying off the credit card. “Left over” is then exactly how much your current account balance changed. Card and savings-account transactions are listed (marked “not counted”) but not added up, so nothing is counted twice.'
                : 'Every account is added up: credit-card purchases are spending, and paying off the card is a transfer.'}</p>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h2>📅 Budget month</h2></div>
            <p class="muted small" style="margin-top:0">Count each month from payday to payday, so “left to spend” matches the money you actually have until the next salary.</p>
            <div class="settings-list">
              <label class="checkbox"><input type="radio" name="period-mode" data-action="period-mode" value="calendar" ${S().settings?.payday ? '' : 'checked'}> Calendar month (1st – last day)</label>
              <label class="checkbox"><input type="radio" name="period-mode" data-action="period-mode" value="payday" ${S().settings?.payday ? 'checked' : ''}> From payday, on day
                <input type="number" min="1" max="28" inputmode="numeric" data-action="payday-day" value="${S().settings?.payday || 10}" style="width:70px;min-height:34px;padding:4px 8px" aria-label="Payday"></label>
              <p class="muted small" style="margin:6px 0 0">If the day falls on a Saturday the period starts on Friday, on a Sunday it starts on Monday. When the salary has arrived, its real date is used.${S().settings?.payday ? ` Current period: <b>${esc(P().rangeLabel(P().current()))}</b>.` : ''}</p>
            </div>
            ${S().settings?.payday ? `<div class="card-head" style="margin:14px 0 6px"><h2 class="small">Salary date for each month</h2></div>
              <p class="muted small" style="margin:0 0 6px">Set the exact day the salary came in. Each month runs from that day until the day before the next salary.</p>
              <div class="settings-list">${Array.from({ length: 12 }, (_, i) => addMonths(P().current(), 1 - i)).map((k) => {
                const set = S().settings?.paydays?.[k];
                return `<div class="setting"><span>${esc(P().label(k))}<div class="muted small">${set ? 'set by you' : 'automatic'} · runs until ${esc(new Date(P().end(k)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</div></span>
                  <span style="display:flex;gap:6px;align-items:center"><input type="date" data-action="salary-date" data-key="${k}" value="${esc(P().start(k))}" style="width:auto;min-height:34px;padding:4px 8px" aria-label="Salary date ${esc(P().label(k))}">
                  ${set ? `<button class="btn small" type="button" data-action="salary-auto" data-key="${k}" title="Back to automatic">↺</button>` : ''}</span></div>`;
              }).join('')}</div>` : ''}
          </div>
          <div class="card">
            <div class="card-head"><h2>📱 App</h2></div>
            <div class="settings-list">
              ${window.BudgetApp ? `<div class="setting"><span>Server address<div class="muted small num">${esc(window.BudgetApp.getServer())}</div></span><button class="btn small" type="button" data-action="change-server">Change</button></div>`
                : `<div class="setting"><span>Install on this device</span>${ui.installPrompt ? '<button class="btn small primary" type="button" data-action="install">Install</button>' : '<span class="muted small" style="text-align:right">iPhone: Share → Add to Home Screen<br>Android: get the app (see README) or ⋮ → Add to Home screen</span>'}</div>`}
              <div class="setting"><span>Theme</span><select data-action="theme" style="width:auto">${['system', 'light', 'dark'].map((t) => `<option value="${t}" ${t === theme ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
              <div class="setting"><span>Export all data (JSON)</span><button class="btn small" type="button" data-action="export">Download</button></div>
              <div class="setting"><span>App version</span><span class="muted small num">${esc(S().appVersion || '?')}</span></div>
              <div class="setting"><span>Sign out of this device</span><button class="btn small" type="button" data-action="logout">Sign out</button></div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>🗂 Categories</h2><button class="btn small" type="button" data-action="add-category">+ Add</button></div>
            <p class="muted small" style="margin-top:0">Essential categories are never cut by the planner.</p>
            ${S().categories.map((c, i) => `<div class="cat-row">
              <span style="font-size:20px;text-align:center" aria-hidden="true">${esc(c.icon)}</span>
              <span>${esc(c.name)} <span class="muted small">${c.kind === 'income' ? 'income' : c.kind === 'both' ? '' : ''}</span></span>
              ${c.kind === 'expense' ? `<label class="checkbox small"><input type="checkbox" data-action="toggle-essential" data-index="${i}" ${c.essential ? 'checked' : ''}> Essential</label>` : '<span></span>'}
              ${c.role ? '<span class="muted small">built-in</span>' : `<button class="btn small danger" type="button" data-action="delete-category" data-index="${i}" aria-label="Delete ${esc(c.name)}">✕</button>`}
            </div>`).join('')}
          </div>
          <div class="card">
            <div class="card-head"><h2>🧠 Category rules</h2><button class="btn small" type="button" data-action="add-rule">+ Add</button></div>
            <p class="muted small" style="margin-top:0">“When the bank text contains <i>carrefour</i>, use <i>Groceries</i>.” Your rules win over the built-in ones and apply to every sync. Transactions you categorised by hand are never changed.</p>
            ${S().rules.length ? S().rules.map((r, i) => {
              const hits = S().transactions.filter((t) => ruleMatches(r, t));
              const n = hits.length;
              const incomeHidden = cat(r.category).role === 'transfer' ? hits.filter((t) => t.type === 'income' && !t.manualCategory).reduce((s, t) => s + t.amount, 0) : 0;
              return `<div class="setting"><span><code class="inline">${esc(r.keyword || r.pattern)}</code> → ${esc(icon(r.category))} ${esc(r.category)} <span class="muted small">· ${n} match${n === 1 ? '' : 'es'}</span>
                ${incomeHidden > 1000 ? `<div class="small" style="color:var(--critical-text)">⚠️ Hides ${formatRON(incomeHidden, { short: true })} of income as transfers — check this rule</div>` : ''}</span>
                <button class="btn small" type="button" data-action="edit-rule" data-index="${i}">Edit</button></div>`;
            }).join('') : '<p class="muted small">None yet.</p>'}
            <div class="setting"><span class="small">Re-run automatic categories on bank transactions<div class="muted small">Useful after changing rules. Your manual choices are kept.</div></span><button class="btn small" type="button" data-action="recategorize">Re-run</button></div>
          </div>
        </div>
      </div>`;
  },
};

function pctChange(now, before) {
  const prev = P().payday ? 'previous period' : 'last month';
  if (!before) return `vs ${prev}: —`;
  const p = Math.round(((now - before) / before) * 100);
  return `${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}% vs ${prev}`;
}

const TITLES = { overview: 'Overview', transactions: 'Transactions', goals: 'Goals', plan: 'Savings plan', settings: 'Settings' };

function render() {
  if (!S()) return;
  const active = document.activeElement;
  const focusFilter = view.contains(active) && active.dataset.filter === 'q' ? active.selectionStart : null;
  view.innerHTML = (views[ui.route] || views.overview)();
  if (focusFilter != null) {
    const input = view.querySelector('[data-filter="q"]');
    input.focus(); input.setSelectionRange(focusFilter, focusFilter);
  }
  $('#view-title').textContent = TITLES[ui.route] || 'Overview';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === ui.route));
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === ui.route ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (ui.route === 'settings' && S().bank.configured && !ui.banks) loadBanks();
}

function renderStatus() {
  const pending = data.pending;
  const last = S()?.bank?.lastSync ? new Date(S().bank.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  let text; let dot;
  if (!data.online) { text = pending ? `Offline · ${pending} change${pending === 1 ? '' : 's'} waiting` : 'Offline · saved data'; dot = 'var(--warning)'; }
  else if (pending) { text = `Saving ${pending}…`; dot = 'var(--warning)'; }
  else { text = last ? `Up to date · bank ${last}` : 'Up to date'; dot = 'var(--good)'; }
  for (const el of [$('#sync-pill'), $('#sync-pill-mobile')]) {
    el.textContent = el.id === 'sync-pill-mobile' ? (data.online ? (pending ? 'Saving…' : 'Synced') : 'Offline') : text;
    el.style.setProperty('--sync-dot', dot);
    el.title = text;
  }
}

function route() {
  const [name, query] = location.hash.slice(1).split('?');
  ui.route = TITLES[name] ? name : 'overview';
  ui.params = new URLSearchParams(query || '');
  if (ui.route === 'transactions' && ui.params.has('category')) {
    ui.tx.category = ui.params.get('category');
    ui.tx.month = ui.params.get('month') ?? ui.tx.month;
  }
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
  const label = m.fresh
    ? `Import ${m.fresh}${m.already ? ` · skip ${m.already} already in app` : ''}`
    : 'Nothing new to import';
  return `<div class="stack qc-preview" style="gap:8px;margin-top:12px">
    <p style="margin:0"><b>${m.rows.length}</b> transaction${m.rows.length === 1 ? '' : 's'} found (${income} income, ${m.rows.length - income} expenses): <b>${m.fresh} new</b>, ${m.already} already in app.</p>
    ${p.skipped ? `<p class="muted small" style="margin:0">${p.skipped} row${p.skipped === 1 ? '' : 's'} skipped (not a transaction, or not completed).</p>` : ''}
    ${fx ? `<div class="banner qc-warn" role="note"><span class="banner-ico" aria-hidden="true">⚠️</span><div class="small"><b>${fx} row${fx === 1 ? ' is' : 's are'} in another currency and ${fx === 1 ? 'is' : 'are'} NOT converted to RON.</b> ${fx === 1 ? 'Its amount is' : 'Their amounts are'} imported as the bank shows ${fx === 1 ? 'it' : 'them'}; edit ${fx === 1 ? 'it' : 'them'} after import.</div></div>` : ''}
    <div class="qc-rows">${shown.map((r) => `<div class="qc-row${r.isNew ? '' : ' qc-dup'}">
      <span class="qc-row-main"><span class="qc-row-desc">${esc(r.t.description || '—')}</span>
        <span class="muted small">${esc(fmtDate(r.t.date))}${r.isNew ? ` · ${esc(icon(r.category))} ${esc(r.category)}` : ''}${r.raw.needsFx ? ` · ${esc(r.raw.originalCurrency || '')} not converted` : ''}</span></span>
      <span class="qc-row-end"><span class="num ${r.t.type === 'income' ? 'pos' : ''}">${r.t.type === 'income' ? '+' : '−'}${r.raw.needsFx ? `${esc(amountFmt.format(r.t.amount))} ${esc(r.raw.originalCurrency || '')}` : formatRON(r.t.amount)}</span>
        <span class="qc-tag ${r.isNew ? 'qc-tag-new' : ''}">${r.isNew ? 'New' : 'Already in app'}</span></span>
    </div>`).join('')}</div>
    ${m.rows.length > shown.length ? `<p class="muted small" style="margin:0">…and ${m.rows.length - shown.length} more.</p>` : ''}
    ${b.connections.length ? `<label class="field">Which account is this statement from?
      <select data-action="csv-account">${b.connections.flatMap((c) => c.accounts).map((a) => `<option value="${esc(a.uid)}" ${a.uid === ui.csvAccount ? 'selected' : ''}>${esc(ACCOUNT_KINDS[accountView(a).kind])} · ${esc((a.iban || '').slice(-4))} · ${esc(a.nickname || a.name || '')}</option>`).join('')}<option value="" ${!ui.csvAccount ? 'selected' : ''}>Other / not linked</option></select></label>` : ''}
    <div class="qc-actions"><button class="btn" type="button" data-action="csv-cancel">Cancel</button>
      <button class="btn primary" type="button" data-action="csv-import" ${m.fresh ? '' : 'disabled'}>${esc(label)}</button></div>
  </div>`;
}

// ---------------------------------------------------------------- modals
function openModal(html, onSubmit) {
  modalForm.innerHTML = html;
  const run = async (action) => {
    try {
      const keepOpen = await onSubmit(action, new FormData(modalForm));
      if (!keepOpen) modal.close();
    } catch (err) {
      const errEl = modalForm.querySelector('.form-error');
      if (errEl) errEl.textContent = err.message; else toast(err.message);
    }
  };
  modalForm.onsubmit = (e) => { e.preventDefault(); run('save'); };
  modalForm.onclick = (e) => {
    const btn = e.target.closest('button[data-modal]');
    if (!btn) return;
    if (btn.dataset.modal === 'cancel') modal.close(); else run(btn.dataset.modal);
  };
  modal.showModal();
  setTimeout(() => modalForm.querySelector('[autofocus]')?.focus(), 30);
}

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
  const lockAttr = locked ? 'readonly aria-readonly="true"' : '';
  const chips = categoryChips(type, t.category);
  openModal(`
    <h2 id="modal-title">${isNew ? 'New transaction' : 'Edit transaction'} ${fromBank ? `<span class="badge">${t.source === 'bank' ? 'from bank' : 'imported'}</span>` : ''}</h2>
    <div class="type-toggle" role="group" aria-label="Type">
      <button type="button" data-type="expense" aria-pressed="${type === 'expense'}" ${locked ? 'disabled' : ''}>Expense</button>
      <button type="button" data-type="income" aria-pressed="${type === 'income'}" ${locked ? 'disabled' : ''}>Income</button>
    </div>
    <label class="field">Amount (RON)<input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(formatAmountInput(t.amount))}" ${isNew ? 'autofocus' : ''} ${lockAttr} required></label>
    ${locked ? '<p class="muted small qc-locked-note">🔒 Amount and date come from the bank</p>' : ''}
    <div class="qc-chips" id="qc-chips" role="group" aria-label="Frequent categories" ${chips ? '' : 'hidden'}>${chips}</div>
    <label class="field">Category<select name="category">${categoryOptions(type, t.category)}</select></label>
    <label class="field">Description<input name="description" maxlength="140" placeholder="e.g. Kaufland, Salary" value="${esc(t.description)}"></label>
    <div class="field-row">
      <label class="field">Date${locked
        ? `<input class="qc-locked-date" value="${esc(fmtDate(t.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}" ${lockAttr}>`
        : `<input type="date" name="date" value="${esc(t.date)}" required>`}</label>
      <label class="field" id="goal-field" ${cat(t.category).role === 'savings' ? '' : 'hidden'}>Goal<select name="goalId"><option value="">—</option>${S().goals.map((g) => `<option value="${esc(g.id)}" ${g.id === t.goalId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    </div>
    <label class="field">Note<input name="note" maxlength="280" value="${esc(t.note || '')}" placeholder="Optional"></label>
    ${t.source !== 'bank' && S().bank.connections.length ? `<label class="field">Account<select name="accountId">${S().bank.connections.flatMap((c) => c.accounts).map((a) => `<option value="${esc(a.uid)}" ${a.uid === (L().accountOf(t)?.uid) ? 'selected' : ''}>${esc(ACCOUNT_KINDS[accountView(a).kind])} · ${esc((a.iban || '').slice(-4))}</option>`).join('')}<option value="" ${!L().accountOf(t) ? 'selected' : ''}>Not linked (cash / other)</option></select></label>` : ''}
    ${!isNew && t.category !== 'Transfers' && isOwnTransfer(t, ownContext(S())) ? `<div class="banner"><span class="banner-ico" aria-hidden="true">🔁</span><div class="small"><b>This looks like money moving between your own accounts.</b> As “${esc(t.category)}” it is counted as ${t.type === 'income' ? 'income' : 'spending'} — and again on the other account. Choose <b>Transfers</b> so it isn’t counted twice.</div></div>` : ''}
    ${fromBank ? `<div id="learn-row" class="stack" style="gap:8px" hidden>
      <label class="checkbox"><input type="checkbox" name="learn"> Also use this category for other transactions containing:</label>
      <input name="keyword" maxlength="60" value="${esc(merchantKey(`${t.description} ${t.note || ''}`))}" placeholder="shop name, e.g. carrefour" aria-label="Keyword">
      <p class="muted small" id="learn-preview" style="margin:0"></p>
    </div>` : ''}
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${isNew ? '' : '<button class="btn danger" type="button" data-modal="delete">Delete</button>'}
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
}

// "Matches 4 other transactions: CARREFOUR EXPRESS, CARREFOUR MARKET, …"
function rulePreview(keyword, exceptId) {
  const k = String(keyword || '').trim();
  if (k.length < 3 || isUselessKeyword(k)) return '⚠️ Too generic. Type the shop’s name, e.g. “carrefour”.';
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
    <label class="field">Salary arrived on<input type="date" name="date" value="${esc(current || P().start(key))}" required></label>
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
  const kw = r.keyword || r.pattern.replace(/\\(.)/g, '$1');
  openModal(`
    <h2 id="modal-title">${isNew ? 'New rule' : 'Edit rule'}</h2>
    <label class="field">When the bank text contains<input name="keyword" maxlength="60" value="${esc(kw)}" placeholder="e.g. carrefour" autofocus></label>
    <p class="muted small" id="rule-preview" style="margin:0"></p>
    <label class="field">put it in<select name="category">${S().categories.filter((c) => !c.role || c.role === 'transfer').map((c) => `<option value="${esc(c.name)}" ${c.name === r.category ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
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
  openModal(`
    <h2 id="modal-title">${isNew ? 'New goal' : 'Edit goal'}</h2>
    <label class="field">Name<input name="name" maxlength="80" required placeholder="e.g. Emergency fund, Summer in Greece" value="${esc(g.name)}" ${isNew ? 'autofocus' : ''}></label>
    <div class="field">Icon<div class="goal-check">${GOAL_ICONS.map((i) => `<label class="chip-check"><input type="radio" name="icon" value="${i}" ${i === (g.icon || '🎯') ? 'checked' : ''}> ${i}</label>`).join('')}</div></div>
    <div class="field-row">
      <label class="field">Target (RON)<input name="target" inputmode="decimal" required value="${g.target ? String(g.target).replace('.', ',') : ''}" placeholder="10.000"></label>
      <label class="field">Already saved (RON)<input name="initialSaved" inputmode="decimal" value="${g.initialSaved ? String(g.initialSaved).replace('.', ',') : ''}" placeholder="0"></label>
    </div>
    <div class="field-row">
      <label class="field">Deadline (optional)<input type="date" name="deadline" value="${esc(g.deadline || '')}" min="${todayISO()}"></label>
      <label class="field">Priority<select name="priority">${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${p === g.priority ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
    </div>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions">
      ${isNew ? '' : '<button class="btn danger" type="button" data-modal="delete">Delete</button>'}
      <span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">Save goal</button>
    </div>`, async (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`Delete “${g.name}”? Money you put aside stays recorded as savings.`)) return true;
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
}

function openContributionModal(goal, withdraw = false) {
  const { plan } = currentPlan(null);
  const p = plan.goals.find((x) => x.id === goal.id);
  const suggestion = p?.required || (plan.monthlySaving && plan.goals.length ? plan.monthlySaving / plan.goals.length : 0);
  openModal(`
    <h2 id="modal-title">${withdraw ? 'Withdraw from' : 'Add money to'} ${esc(goal.icon || '🎯')} ${esc(goal.name)}</h2>
    <label class="field">Amount (RON)<input class="amount-input" name="amount" inputmode="decimal" required autofocus value="${!withdraw && suggestion ? String(Math.round(suggestion)) : ''}"></label>
    ${!withdraw && suggestion ? `<p class="muted small" style="margin:0">Your plan suggests about ${formatRON(suggestion, { short: true })} a month for this goal.</p>` : ''}
    <label class="field">Date<input type="date" name="date" value="${todayISO()}"></label>
    <p class="muted small" style="margin:0">${withdraw ? 'Recorded as money coming back into your budget.' : 'Recorded as a “Savings” transaction, so your left-to-spend balance goes down by the same amount.'}</p>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">${withdraw ? 'Withdraw' : 'Add'}</button>
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
}

// Main card. For the period you're in, the real balance of your current account
// is the truth ("what I have until payday"); past periods show what was left over.
function heroCard({ s, key, isCurrent, used, daysLeft, accounts }) {
  const currentAccounts = accounts.filter((a) => accountView(a).kind === 'current' && accountView(a).known);
  const balance = currentAccounts.reduce((sum, a) => sum + accountView(a).cash, 0);
  const until = P().payday ? 'until payday' : 'until the end of the month';
  if (isCurrent && currentAccounts.length) {
    const perDay = balance > 0 && daysLeft ? balance / daysLeft : 0;
    return `<div class="card balance">
      <span class="stat-label">In your current account now</span>
      <span class="stat-value big num">${formatRON(balance)}</span>
      <div class="meter" aria-hidden="true"><i style="width:${(used * 100).toFixed(1)}%"></i></div>
      <span class="stat-sub">${perDay ? `≈ ${formatRON(perDay, { short: true })}/day for ${daysLeft} day${daysLeft === 1 ? '' : 's'} ${until}` : `${daysLeft} days ${until}`} · this period so far: ${formatRON(s.income - s.spend, { sign: true })} (in ${formatRON(s.income, { short: true })}, out ${formatRON(s.spend, { short: true })})</span>
    </div>`;
  }
  const perDay = isCurrent && s.left > 0 && daysLeft ? s.left / daysLeft : 0;
  return `<div class="card balance">
    <span class="stat-label">${isCurrent ? `Left to spend ${until}` : (P().payday ? 'Left over that pay period' : 'Left over that month')}</span>
    <span class="stat-value big num">${formatRON(s.left)}</span>
    <div class="meter" aria-hidden="true"><i style="width:${(used * 100).toFixed(1)}%"></i></div>
    <span class="stat-sub">${s.income ? `${Math.round(used * 100)}% of income used` : 'No income recorded'}${perDay ? ` · ≈ ${formatRON(perDay, { short: true })}/day for ${daysLeft} days` : ''}${L().mode === 'cashflow' ? ' · money in − money out of the current account' : ''}</span>
  </div>`;
}

// Credit card: what was spent on it, what was paid back, what's still owed,
// and when it's cleared at the current pace.
function creditCardPanel(key) {
  const cards = S().bank.connections.flatMap((c) => c.accounts).filter((a) => accountView(a).kind === 'credit');
  if (!cards.length) return '';
  const owed = cards.reduce((sum, a) => sum + accountView(a).owed, 0);
  const onCard = (t) => L().kindOf(t) === 'credit';
  const period = (k) => {
    let spent = 0; let repaid = 0; const cats = {};
    for (const t of S().transactions) {
      if (keyOf(t.date) !== k || !onCard(t)) continue;
      if (t.type === 'expense') { spent += t.amount; cats[t.category] = (cats[t.category] || 0) + t.amount; } else repaid += t.amount;
    }
    return { spent, repaid, cats };
  };
  const now = period(key);
  const past = [1, 2, 3].map((i) => period(addMonths(P().current(), -i)));
  const avgSpent = past.reduce((x, p) => x + p.spent, 0) / 3;
  const avgRepaid = past.reduce((x, p) => x + p.repaid, 0) / 3;
  const net = avgRepaid - avgSpent; // debt paid down per period
  const top = Object.entries(now.cats).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const in12 = owed / 12 + avgSpent;
  let pace;
  if (!owed) pace = 'Nothing owed 🎉';
  else if (net > 1 && owed / net <= 120) pace = `At your pace of the last 3 periods (repaid ${formatRON(avgRepaid, { short: true })}, spent ${formatRON(avgSpent, { short: true })} on the card), it's cleared in about <b>${Math.ceil(owed / net)} months</b>.`;
  else pace = `In the last 3 periods you spent ${formatRON(avgSpent, { short: true })} a month on the card and repaid ${formatRON(avgRepaid, { short: true })} — <b>the debt isn't going down</b>.`;
  const digits = [...L().byDigits].filter(([, a]) => cards.some((c) => c.uid === a.uid)).map(([x]) => x);
  return `<div class="card card-panel">
    <div class="card-head"><h2>💳 Credit card${digits.length ? ` <span class="muted num" style="font-weight:400">**** ${esc(digits.join(', '))}</span>` : ''}</h2><a class="link" href="#transactions">Card transactions →</a></div>
    <div class="kpis">
      <div class="kpi"><span class="stat-label">Owed now</span><span class="kpi-value num">${formatRON(owed)}</span></div>
      <div class="kpi"><span class="stat-label">Spent on the card</span><span class="kpi-value num">${formatRON(now.spent)}</span><span class="stat-sub">this period</span></div>
      <div class="kpi"><span class="stat-label">Paid back</span><span class="kpi-value num pos">${formatRON(now.repaid)}</span><span class="stat-sub">this period</span></div>
    </div>
    ${top.length ? `<div class="chips">${top.map(([c, v]) => `<span class="chip"><span aria-hidden="true">${esc(icon(c))}</span> ${esc(c)} <b class="num">${formatRON(v, { short: true })}</b></span>`).join('')}</div>` : ''}
    <p class="small muted" style="margin:12px 0 0">${pace}${owed ? ` To be debt-free in 12 months: repay about <b>${formatRON(in12, { short: true })}</b> a month and keep card spending around ${formatRON(avgSpent, { short: true })} (or less).` : ''}</p>
  </div>`;
}

function unassignedBanner() {
  const accounts = S().bank.connections.flatMap((c) => c.accounts);
  if (accounts.length < 2) return '';
  const n = S().transactions.filter((t) => t.source === 'import' && !t.accountId).length;
  if (!n) return '';
  return `<div class="banner" style="margin-top:12px"><span class="banner-ico" aria-hidden="true">⚠️</span><div class="small"><b>${n} imported transactions don't know which account they're from</b>, so card purchases may be counted as current-account spending. For exact totals: Settings → Import → <i>Delete imported</i>, then import each statement again and pick its account.</div></div>`;
}

function debtBanner() {
  const { owed } = bankTotals(S().bank.connections.flatMap((c) => c.accounts));
  if (!owed) return '';
  const hasGoal = S().goals.some((g) => /card/i.test(g.name));
  return `<div class="banner"><span class="banner-ico" aria-hidden="true">💳</span><div style="flex:1">
    <b>You owe ${formatRON(owed)} on your credit card.</b>
    <div class="muted small">Card interest is usually much higher than anything savings earn, so paying it off first is the best “saving” there is. Repay the full statement balance before the grace period ends to pay no interest at all.</div>
    ${hasGoal ? '' : '<button class="btn small primary" type="button" data-action="debt-goal" style="margin-top:8px">Make paying it off a goal</button>'}
  </div></div>`;
}

function openAccountModal(accUid) {
  const a = S().bank.connections.flatMap((c) => c.accounts).find((x) => x.uid === accUid);
  if (!a) return;
  const v = accountView(a);
  const raw = a.balance ? Number(a.balance.amount) : 0;
  const meaning = a.balanceMeaning || 'auto';
  openModal(`
    <h2 id="modal-title">Account settings</h2>
    <p class="muted small" style="margin:0">${esc(a.name || '')} · <span class="num">${esc(a.iban || '')}</span><br>The bank reports <b class="num">${formatRON(raw)}</b> for this account.</p>
    <label class="field">Name<input name="nickname" maxlength="40" value="${esc(a.nickname || '')}" placeholder="${esc(a.name || 'e.g. ING card')}"></label>
    <label class="field">Card numbers on this account (last 4 digits)<input name="cardDigits" inputmode="numeric" value="${esc((a.cardDigits || [...L().byDigits].filter(([, x]) => x.uid === a.uid).map(([d]) => d)).join(', '))}" placeholder="e.g. 7204"></label>
    <label class="field">Type<select name="kind">${Object.entries(ACCOUNT_KINDS).map(([k, label]) => `<option value="${k}" ${k === v.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <div id="credit-fields" class="stack" style="gap:14px" ${v.kind === 'credit' ? '' : 'hidden'}>
      <label class="field">Credit limit (RON)<input name="creditLimit" inputmode="decimal" value="${a.creditLimit ? String(a.creditLimit).replace('.', ',') : ''}" placeholder="9.900"></label>
      <div class="field">What does the bank's number (${formatRON(raw)}) mean?
        <label class="checkbox"><input type="radio" name="balanceMeaning" value="owed" ${balanceMeaning(a) === 'owed' && meaning !== 'auto' ? 'checked' : ''}> <span id="opt-owed"></span></label>
        <label class="checkbox"><input type="radio" name="balanceMeaning" value="available" ${meaning === 'available' ? 'checked' : ''}> <span id="opt-available"></span></label>
        <label class="checkbox"><input type="radio" name="balanceMeaning" value="auto" ${meaning === 'auto' ? 'checked' : ''}> <span>Let the app decide</span></label>
      </div>
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
    $('#opt-owed', form).innerHTML = `It's what I've spent / owe → owed <b class="num">${formatRON(owedIfOwed)}</b>${limit ? `, available ${formatRON(Math.max(limit - owedIfOwed, 0))}` : ''}`;
    $('#opt-available', form).innerHTML = `It's what I can still spend → ${limit ? `owed <b class="num">${formatRON(Math.max(limit - raw, 0))}</b>, available ${formatRON(raw)}` : 'enter the limit to see what you owe'}`;
  };
  preview();
  form.creditLimit.addEventListener('input', preview);
  form.kind.addEventListener('change', () => { $('#credit-fields', form).hidden = form.kind.value !== 'credit'; });
}

function openCategoryModal() {
  openModal(`
    <h2 id="modal-title">New category</h2>
    <div class="field-row">
      <label class="field">Icon (emoji)<input name="icon" maxlength="4" value="🏷️"></label>
      <label class="field">Type<select name="kind"><option value="expense">Expense</option><option value="income">Income</option></select></label>
    </div>
    <label class="field">Name<input name="name" maxlength="40" required autofocus></label>
    <label class="checkbox"><input type="checkbox" name="essential"> Essential (the planner won't suggest cutting it)</label>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><span class="spacer"></span>
      <button class="btn" type="button" data-modal="cancel">Cancel</button>
      <button class="btn primary" type="submit" value="save">Add</button>
    </div>`, async (_, fd) => {
    const name = fd.get('name').trim();
    if (!name) throw new Error('Name is required.');
    if (S().categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error('That category already exists.');
    data.setCategories([...S().categories, { name, icon: fd.get('icon') || '🏷️', kind: fd.get('kind'), essential: Boolean(fd.get('essential')) }]);
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
    if (!confirm('Unlink this bank? Transactions already imported are kept.')) return;
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
  'delete-category': (el) => {
    const c = S().categories[Number(el.dataset.index)];
    if (!confirm(`Delete category “${c.name}”? Existing transactions keep the name.`)) return;
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
    if (!confirm('Delete every transaction that came from a CSV import? Bank-synced and manual ones stay.')) return;
    try {
      const { removed } = await data.fetch('/api/transactions/imported', { method: 'DELETE' });
      await data.refresh();
      toast(`Removed ${removed} imported transactions`);
    } catch (err) { toast(err.message); }
  },
  'edit-rule': (el) => openRuleModal(S().rules[Number(el.dataset.index)]),
  recategorize: () => { data.recategorizeAll(); toast('Categories updated'); },
  'edit-account': (el) => openAccountModal(el.dataset.id),
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
    ui.tx = { ...ui.tx, category: bar.dataset.category, month: ui.month || P().current(), type: '', q: '' };
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
