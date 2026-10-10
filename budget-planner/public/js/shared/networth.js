// Net worth: the money in your linked accounts minus the credit-card debt, plus
// what you add by hand (pension pillars, investments, cash at home, property)
// minus loans. Manual values go stale, so the ones not updated for 100 days are
// listed for a reminder.
// Pure: no DOM, used by the browser and by Node.

import { round2 } from './money.js';
import { bankTotals } from './accounts.js';

const DAY = 86400000;
export const STALE_DAYS = 100;

/**
 * { bankCash, cardOwed, assets, debts, total, items, stale }
 * items: [{ name, kind, amount, source: 'bank'|'manual', id? }] — bank: one line for
 * the cash in your accounts ('bank') and one for the card debt ('card'); manual:
 * your assets (kind as entered; 'loan' is a debt). stale: manual entries to update.
 */
export function netWorth(state, { now = Date.now() } = {}) {
  const accounts = (state?.bank?.connections || []).filter((c) => !c.archived).flatMap((c) => c.accounts || []);
  const bank = bankTotals(accounts.filter((a) => a.balance));
  const items = [];
  if (accounts.some((a) => a.balance)) items.push({ name: 'Bank accounts', kind: 'bank', amount: bank.cash, source: 'bank' });
  if (bank.owed) items.push({ name: 'Credit card debt', kind: 'card', amount: bank.owed, source: 'bank' });
  let assets = 0; let debts = 0;
  const stale = [];
  for (const a of state?.assets || []) {
    const amount = Number(a.amount);
    if (!Number.isFinite(amount)) continue;
    if (a.kind === 'loan') debts += amount; else assets += amount;
    items.push({ name: a.name, kind: a.kind || 'other', amount: round2(amount), source: 'manual', id: a.id });
    const at = Date.parse(a.updatedAt || '');
    if (Number.isNaN(at) || now - at > STALE_DAYS * DAY) stale.push(a);
  }
  const total = round2(bank.cash - bank.owed + assets - debts);
  return { bankCash: bank.cash, cardOwed: bank.owed, assets: round2(assets), debts: round2(debts), total, items, stale };
}
