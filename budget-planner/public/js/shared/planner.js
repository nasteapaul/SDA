// Savings planner: learns from your spending history and builds a monthly plan
// to reach one or more goals. Pure functions — used by the browser (works
// offline) and covered by the Node test suite.

import {
  round2, monthKey, addMonths, daysInMonth, monthsBetween, todayISO,
} from './money.js';
import { merchantKey } from './categories.js';

export const INTENSITY = {
  gentle: { cap: 0.15, label: 'Gentle', hint: 'cut up to 15% of flexible spending' },
  balanced: { cap: 0.30, label: 'Balanced', hint: 'cut up to 30% of flexible spending' },
  aggressive: { cap: 0.50, label: 'Aggressive', hint: 'cut up to 50% of flexible spending' },
};

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const SMALL_PURCHASE = 50; // RON

function roleOf(name, categories) {
  return categories.find((c) => c.name === name)?.role;
}

export function goalSaved(goal, transactions) {
  const contributed = transactions
    .filter((t) => t.goalId === goal.id)
    .reduce((s, t) => s + (t.type === 'expense' ? t.amount : -t.amount), 0);
  return round2((Number(goal.initialSaved) || 0) + contributed);
}

/**
 * Summarise spending habits over the last full months (up to `months`).
 */
export function analyzeHistory(transactions, categories, { today = todayISO(), months = 6 } = {}) {
  const current = monthKey(today);
  const usable = transactions.filter((t) => roleOf(t.category, categories) !== 'transfer');
  const dated = usable.filter((t) => t.date && monthKey(t.date) <= current);
  if (!dated.length) {
    return { status: 'no-data', monthKeys: [], avgIncome: 0, avgSpend: 0, avgSaved: 0, categories: [], recurring: [], confidence: 'none' };
  }

  const firstDate = dated.reduce((min, t) => (t.date < min ? t.date : min), dated[0].date);
  let firstMonth = monthKey(firstDate);
  // A first month that starts late (e.g. a bank import from the 18th) would
  // drag every average down, so skip it when we have something better.
  if (Number(firstDate.slice(8, 10)) > 7 && firstMonth < addMonths(current, -1)) {
    firstMonth = addMonths(firstMonth, 1);
  }

  let monthKeys = [];
  for (let k = addMonths(current, -months); k < current; k = addMonths(k, 1)) {
    if (k >= firstMonth) monthKeys.push(k);
  }

  let factor = 1;
  let confidence = monthKeys.length >= 3 ? 'high' : monthKeys.length >= 1 ? 'medium' : 'low';
  if (!monthKeys.length) {
    // Only the current month so far: extrapolate it to a full month.
    monthKeys = [current];
    const day = Number(today.slice(8, 10));
    const startDay = firstMonth === current ? Number(firstDate.slice(8, 10)) : 1;
    const covered = Math.max(day - startDay + 1, 1);
    factor = daysInMonth(current) / covered;
  }
  const n = monthKeys.length;
  const inWindow = dated.filter((t) => monthKeys.includes(monthKey(t.date)));

  const perMonth = Object.fromEntries(monthKeys.map((k) => [k, { income: 0, spend: 0, saved: 0 }]));
  const byCat = new Map();
  for (const t of inWindow) {
    const k = monthKey(t.date);
    const role = roleOf(t.category, categories);
    if (role === 'savings') {
      // Money into a goal (expense) or taken back out of it (income).
      perMonth[k].saved += t.type === 'expense' ? t.amount : -t.amount;
      continue;
    }
    if (t.type === 'income') {
      perMonth[k].income += t.amount;
      continue;
    }
    perMonth[k].spend += t.amount;
    if (!byCat.has(t.category)) byCat.set(t.category, { total: 0, count: 0, smallCount: 0, smallTotal: 0, months: {} });
    const c = byCat.get(t.category);
    c.total += t.amount;
    c.months[k] = (c.months[k] || 0) + t.amount;
    if (t.amount <= 0) continue; // a refund (negative expense) lowers the total only
    c.count += 1;
    if (t.amount < SMALL_PURCHASE) { c.smallCount += 1; c.smallTotal += t.amount; }
  }

  const lastFull = monthKeys[monthKeys.length - 1];
  const cats = [...byCat.entries()].map(([name, c]) => {
    const def = categories.find((x) => x.name === name) || {};
    const avg = (c.total / n) * factor;
    const last = (c.months[lastFull] || 0) * factor;
    const prevKeys = monthKeys.slice(0, -1);
    const prevAvg = prevKeys.length ? prevKeys.reduce((s, k) => s + (c.months[k] || 0), 0) / prevKeys.length : null;
    return {
      name,
      icon: def.icon || '•',
      essential: Boolean(def.essential),
      avg: round2(avg),
      lastMonth: round2(last),
      trend: prevAvg ? round2((last - prevAvg) / prevAvg) : null,
      perMonthCount: round2((c.count / n) * factor),
      smallPerMonth: round2((c.smallCount / n) * factor),
      smallTotalPerMonth: round2((c.smallTotal / n) * factor),
    };
  }).sort((a, b) => b.avg - a.avg);

  const sum = (key) => monthKeys.reduce((s, k) => s + perMonth[k][key], 0);
  return {
    status: 'ok',
    monthKeys,
    extrapolated: factor !== 1,
    confidence,
    avgIncome: round2((sum('income') / n) * factor),
    avgSpend: round2((sum('spend') / n) * factor),
    avgSaved: round2((sum('saved') / n) * factor),
    perMonth,
    categories: cats,
    recurring: detectRecurring(dated, categories, current),
  };
}

// Same merchant, similar amount, in at least 2 of the last 3 full months.
export function detectRecurring(transactions, categories, currentMonth) {
  const window = [1, 2, 3].map((i) => addMonths(currentMonth, -i));
  const groups = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || roleOf(t.category, categories)) continue;
    const k = monthKey(t.date);
    if (!window.includes(k)) continue;
    const key = merchantKey(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = [];
  for (const [key, list] of groups) {
    const months = new Set(list.map((t) => monthKey(t.date)));
    if (months.size < 2 || list.length > months.size + 1) continue; // frequent shops aren't subscriptions
    const amounts = list.map((t) => t.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    if (avg <= 0 || spread / avg > 0.15) continue;
    out.push({ merchant: key, label: list[list.length - 1].description, avg: round2(avg), category: list[0].category, months: months.size });
  }
  return out.sort((a, b) => b.avg - a.avg);
}

/**
 * Credit-card activity in one period: { spent, repaid, refunded, cats, count }.
 * A refund from a shop lowers what was spent (in the purchase's category);
 * only real payments towards the card count as repaid.
 */
export function cardPeriod(transactions, { isRefund = () => false, refundCategory = (t) => t.category } = {}) {
  let spent = 0; let repaid = 0; let refunded = 0; let count = 0;
  const cats = {};
  for (const t of transactions) {
    count += 1;
    if (t.type === 'expense') {
      spent += t.amount;
      cats[t.category] = round2((cats[t.category] || 0) + t.amount);
    } else if (isRefund(t)) {
      refunded += t.amount;
      spent -= t.amount;
      const c = refundCategory(t);
      cats[c] = round2((cats[c] || 0) - t.amount);
    } else repaid += t.amount;
  }
  return { spent: round2(spent), repaid: round2(repaid), refunded: round2(refunded), cats, count };
}

/**
 * Average card spending / repayment over the recent periods [{ key?, spent,
 * repaid, count }]. Divides by the periods that are really covered by data —
 * from `firstKey` (the period of the first card transaction) on, or else the
 * ones with transactions — never by a fixed 3 (min 1).
 */
export function cardPace(periods, { firstKey = null } = {}) {
  const present = periods.filter((p) => (firstKey && p.key ? p.key >= firstKey : p.count > 0));
  const n = Math.max(present.length, 1);
  const avgSpent = round2(present.reduce((s, p) => s + p.spent, 0) / n);
  const avgRepaid = round2(present.reduce((s, p) => s + p.repaid, 0) / n);
  return { periods: n, avgSpent, avgRepaid, net: round2(avgRepaid - avgSpent) };
}

function addMonthsToDate(iso, months) {
  const d = new Date(iso);
  const whole = Math.floor(months);
  d.setMonth(d.getMonth() + whole);
  d.setDate(d.getDate() + Math.round((months - whole) * 30.44));
  return todayISO(d);
}

/**
 * Month-by-month simulation: each month the pool first covers dated goals
 * (earliest deadline first) up to what they need, then undated goals by
 * priority weight; money freed by finished goals flows to the rest.
 */
function simulate(goals, monthlyPool, today) {
  const state = goals.map((g) => ({ ...g, left: g.remaining, doneMonth: null }));
  if (monthlyPool <= 0) return state;
  for (let m = 1; m <= 600 && state.some((g) => g.left > 0.5); m += 1) {
    let pool = monthlyPool;
    const open = state.filter((g) => g.left > 0.5);
    for (const g of open.filter((x) => x.deadline)) {
      const give = Math.min(g.required, g.left, pool);
      g.left -= give; pool -= give;
    }
    const pass = (list) => {
      const totalW = list.reduce((s, g) => s + g.weight, 0);
      if (!totalW || pool <= 0) return;
      const start = pool;
      for (const g of list) {
        const give = Math.min(g.left, (start * g.weight) / totalW);
        g.left -= give; pool -= give;
      }
    };
    pass(open.filter((g) => !g.deadline && g.left > 0.5));
    // Anything still left over speeds up whatever is unfinished.
    pass(open.filter((g) => g.left > 0.5));
    for (const g of open) if (g.left <= 0.5 && g.doneMonth == null) g.doneMonth = m;
  }
  return state.map((g) => ({ ...g, eta: g.doneMonth ? addMonthsToDate(today, g.doneMonth) : null }));
}

function roundUp(n, step = 10) {
  return Math.ceil(n / step) * step;
}

/**
 * Build a plan to reach the goals given the spending analysis.
 * goals: [{ id, name, target, saved, deadline?, priority }]
 */
export function buildPlan(analysis, goals, { today = todayISO(), intensity = 'balanced' } = {}) {
  const cap = (INTENSITY[intensity] || INTENSITY.balanced).cap;
  const active = goals
    .map((g) => {
      const remaining = Math.max(round2(g.target - (g.saved || 0)), 0);
      const monthsLeft = g.deadline ? monthsBetween(today, g.deadline) : null;
      const overdue = g.deadline ? g.deadline <= today : false;
      const required = g.deadline ? remaining / Math.max(monthsLeft, 1) : 0;
      return { ...g, remaining, monthsLeft, overdue, required: round2(required), weight: PRIORITY_WEIGHT[g.priority] || 2 };
    })
    .filter((g) => g.remaining > 0)
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || b.weight - a.weight);

  const base = { intensity, cap, goals: [], cuts: [], budgets: [], tips: [] };
  if (analysis.status === 'no-data') {
    return { ...base, status: 'no-data', surplus: 0, monthlySaving: 0 };
  }

  const surplus = round2(analysis.avgIncome - analysis.avgSpend);
  const available = Math.max(surplus, 0);
  const totalRequired = round2(active.reduce((s, g) => s + g.required, 0));
  const hasUndated = active.some((g) => !g.deadline);

  // How much must come from cutting flexible spending.
  const flexible = analysis.categories.filter((c) => !c.essential && c.avg > 0);
  const flexTotal = flexible.reduce((s, c) => s + c.avg, 0);
  // Undated goals still deserve progress: aim for at least 10% of income when cutting.
  const undatedWish = hasUndated ? Math.max(analysis.avgIncome * 0.1 - Math.max(available - totalRequired, 0), 0) : 0;
  const need = Math.max(totalRequired - available, 0) + undatedWish + Math.max(-surplus, 0);
  const ratio = flexTotal > 0 ? Math.min(cap, need / flexTotal) : 0;

  const cuts = flexible.map((c) => {
    const amount = round2(c.avg * ratio);
    return { name: c.name, icon: c.icon, current: c.avg, cut: amount, limit: round2(c.avg - amount), smallPerMonth: c.smallPerMonth, smallTotalPerMonth: c.smallTotalPerMonth, trend: c.trend };
  }).filter((c) => c.cut >= 1);
  const totalCut = round2(cuts.reduce((s, c) => s + c.cut, 0));

  const monthlySaving = round2(Math.max(surplus + totalCut, 0));
  const sim = simulate(active, monthlySaving, today);

  const planGoals = sim.map((g) => {
    const late = g.deadline && (!g.eta || g.eta > g.deadline);
    return {
      id: g.id,
      name: g.name,
      target: g.target,
      saved: g.saved || 0,
      remaining: g.remaining,
      deadline: g.deadline || null,
      required: g.required,
      eta: g.eta,
      status: g.overdue ? 'overdue' : late ? 'at-risk' : 'on-track',
    };
  });

  let status = 'on-track';
  if (planGoals.some((g) => g.status !== 'on-track')) status = 'stretch';
  else if (totalCut > 0) status = 'needs-cuts';

  const budgets = analysis.categories.map((c) => {
    const cut = cuts.find((x) => x.name === c.name);
    return { name: c.name, icon: c.icon, essential: c.essential, avg: c.avg, limit: roundUp(cut ? cut.limit : c.avg) };
  });

  return {
    ...base,
    status,
    confidence: analysis.confidence,
    income: analysis.avgIncome,
    spend: analysis.avgSpend,
    surplus,
    totalRequired,
    totalCut,
    monthlySaving,
    perWeek: round2((monthlySaving * 12) / 52),
    perDay: round2((monthlySaving * 12) / 365),
    goals: planGoals,
    cuts,
    budgets,
    tips: buildTips(analysis, { surplus, cuts, planGoals, totalRequired, monthlySaving }),
  };
}

function lei(n) {
  return `${Math.round(n).toLocaleString('ro-RO')} RON`;
}

function day(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function buildTips(analysis, { surplus, cuts, planGoals, totalRequired, monthlySaving }) {
  const tips = [];
  if (surplus < 0) {
    tips.push({ level: 'critical', text: `You currently spend about ${lei(-surplus)} more than you earn each month. The plan below closes that gap first.` });
  }
  for (const c of [...cuts].sort((a, b) => b.cut - a.cut).slice(0, 4)) {
    // Quote the same rounded limit as the suggested budgets (plan.budgets), so the numbers on screen agree.
    const limit = roundUp(c.limit);
    if (c.current - limit < 1) continue; // rounding ate the cut: the budget already allows today's spending
    let why = '';
    if (c.smallPerMonth >= 6) why = ` Most of it is ${Math.round(c.smallPerMonth)} small purchases (${lei(c.smallTotalPerMonth)}) a month — skipping a few of those does the job.`;
    else if (c.trend && c.trend > 0.2) why = ` It went up ${Math.round(c.trend * 100)}% last month.`;
    tips.push({ level: 'info', text: `${c.icon} ${c.name}: you spend ~${lei(c.current)}/month. Keep it under ${lei(limit)} to free ${lei(c.current - limit)}.${why}` });
  }
  const rising = analysis.categories.filter((c) => c.trend && c.trend > 0.25 && c.lastMonth > 100 && !cuts.some((x) => x.name === c.name));
  for (const c of rising.slice(0, 2)) {
    tips.push({ level: 'warning', text: `${c.icon} ${c.name} rose ${Math.round(c.trend * 100)}% last month (${lei(c.lastMonth)}). Worth a look.` });
  }
  if (analysis.recurring.length) {
    const total = analysis.recurring.reduce((s, r) => s + r.avg, 0);
    const names = analysis.recurring.slice(0, 4).map((r) => r.label).join(', ');
    tips.push({ level: 'info', text: `${analysis.recurring.length} recurring payments total ~${lei(total)}/month (${names}). Cancel any you no longer use.` });
  }
  for (const g of planGoals.filter((x) => x.status !== 'on-track')) {
    tips.push({
      level: 'warning',
      text: g.eta
        ? `“${g.name}” won't be ready by ${day(g.deadline)} at this pace — a realistic date is ${day(g.eta)}. Moving the deadline, lowering the target or earning a bit more would close the gap.`
        : `“${g.name}” can't be funded yet — there's no money left over each month. Start with the cuts above.`,
    });
  }
  if (monthlySaving > 0 && totalRequired <= monthlySaving && planGoals.length) {
    tips.push({ level: 'good', text: `Set up an automatic transfer of ${lei(monthlySaving)} on payday so the money is saved before it can be spent.` });
  }
  if (analysis.confidence !== 'high') {
    tips.push({ level: 'info', text: `This plan uses ${analysis.monthKeys.length} month(s) of history${analysis.extrapolated ? ' (current month extrapolated)' : ''}. It gets sharper as more transactions come in.` });
  }
  return tips;
}
