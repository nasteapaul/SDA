// Why a transaction has its category, which guessed categories are worth a
// quick look (the review queue), and which rules you would want after
// correcting the same merchant twice ("two of the last three", like YNAB).
// Pure: no DOM, used by the browser and by Node.

import { matchRule, ruleText, merchantKey, isUselessKeyword, ruleMatches } from './categories.js';
import { ownContext, ownTransferCategory } from './own.js';
import { todayISO } from './money.js';

const DAY = 86400000;

/**
 * { kind, keyword?, pattern? } — kind:
 *   'goal'         money put into / taken out of a goal
 *   'manual'       you picked the category (or it no longer matches the rules)
 *   'manual-entry' a transaction you typed in
 *   'own-transfer' money between your own linked accounts
 *   'rule'         one of your rules (keyword, pattern)
 *   'builtin'      a built-in rule guessed it from the bank text
 *   'fallback'     nothing matched: Other / Other income
 */
export function categoryReason(t, state, own = ownContext(state)) {
  if (!t) return null;
  if (t.goalId) return { kind: 'goal' };
  if (t.manualCategory) return { kind: 'manual' };
  if (t.source === 'manual') return { kind: 'manual-entry' };
  const ownCat = ownTransferCategory(t, own);
  if (ownCat && ownCat === t.category) return { kind: 'own-transfer' };
  const m = matchRule({ description: ruleText(t), type: t.type }, state.rules || [], state.categories);
  if (m.category !== t.category) return { kind: 'manual' };
  if (m.source === 'user') return { kind: 'rule', keyword: m.rule.keyword || '', pattern: m.rule.pattern };
  return { kind: m.source };
}

/** Bank/CSV rows from the last `days` days whose category was only guessed, newest first. */
export function reviewQueue(state, { today = todayISO(), days = 45 } = {}) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
  const own = ownContext(state);
  // Card repayments and transfers are bookkeeping, not spending to sort: they'd come back every month.
  const roles = new Map((state.categories || []).map((c) => [c.name, c.role]));
  return (state.transactions || [])
    .filter((t) => (t.source === 'bank' || t.source === 'import') && !t.reviewed && !t.manualCategory && !t.goalId && !t.needsFx
      && t.date >= from && t.date <= today && !roles.get(t.category))
    .filter((t) => ['builtin', 'fallback'].includes(categoryReason(t, state, own)?.kind))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * Rules worth creating: a merchant whose last 3 transactions you re-categorised
 * at least twice to the same category, not already covered by one of your rules.
 * [{ keyword, category, count, txIds }].
 */
export function suggestRules(state) {
  const groups = new Map();
  for (const t of state.transactions || []) {
    if (t.goalId || !t.date) continue;
    const key = merchantKey(`${t.description || ''} ${t.note || ''}`);
    if (!key || key.length < 3 || isUselessKeyword(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rules = state.rules || [];
  const out = [];
  for (const [keyword, list] of groups) {
    const last3 = [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const counts = new Map();
    for (const t of last3) if (t.manualCategory) counts.set(t.category, (counts.get(t.category) || 0) + 1);
    const [category, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!category || count < 2) continue;
    const covered = rules.some((r) => r.category === category && last3.some((t) => ruleMatches(r, t)));
    if (covered) continue;
    out.push({ keyword, category, count, txIds: last3.filter((t) => t.manualCategory && t.category === category).map((t) => t.id) });
  }
  return out.sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
}
