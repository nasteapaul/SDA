// Recognises money moving between your own accounts — paying off the credit
// card, topping up / getting money back from Revolut, sending to yourself.
// Those are transfers: counting them as income or spending would inflate both
// (and the month's "left over") by the same amount.

import { normalize } from './categories.js';
import { accountKind } from './accounts.js';

const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

export function ibansIn(text) {
  return String(text || '').toUpperCase().match(IBAN_RE) || [];
}

// Counterparty name in bank text: "Ordering party, NAME, …", "Ordonator:NAME", "Beneficiar:NAME".
export function partyName(text) {
  const m = String(text || '').match(/(?:ordering party|beneficiary|ordonator|beneficiar|platitor|payer|payee)\s*[:,]\s*([^,;\n]+)/i);
  return m ? nameKey(m[1]) : '';
}

// Word order doesn't matter: "Nastea Dan Paul" is "Dan Paul Nastea".
function nameKey(name) {
  return normalize(name).replace(/\b(dl|dna|d-l|d-na|mr|mrs)\b\.?/g, ' ').split(/[^a-z]+/).filter(Boolean).sort().join(' ');
}

function looksLikePersonName(name) {
  const words = normalize(name).split(' ').filter(Boolean);
  return words.length >= 2 && !/\b(cont|card|account|credit|economii|savings|current|curent|depozit)\b/.test(normalize(name));
}

/** Everything that identifies "you": linked IBANs and the account holder name(s). */
export function ownContext(state) {
  const accounts = (state.bank?.connections || []).flatMap((c) => c.accounts);
  const ibans = new Set(accounts.map((a) => (a.iban || '').replace(/\s/g, '').toUpperCase()).filter(Boolean));
  const names = new Set(accounts.map((a) => a.name).filter(looksLikePersonName).map(nameKey));
  for (const n of state.settings?.ownNames || []) names.add(nameKey(n));
  const ibanOf = new Map(accounts.map((a) => [a.uid, (a.iban || '').replace(/\s/g, '').toUpperCase()]));
  const byIban = new Map(accounts.map((a) => [(a.iban || '').replace(/\s/g, '').toUpperCase(), a]));
  return { ibans, names, ibanOf, byIban };
}

// Which of your accounts the money went to / came from (null if not one of the linked ones).
function otherOwnAccount(t, ctx) {
  const self = ctx.ibanOf?.get(t.accountId);
  const candidates = [t.counterpartyIban, ...ibansIn(`${t.description || ''} ${t.note || ''}`)];
  const iban = candidates.find((i) => i && i !== self && ctx.ibans.has(i));
  return iban ? ctx.byIban?.get(iban) : null;
}

/**
 * Category for money moving between your own accounts, or null if it isn't.
 *   current → credit card : "Credit card repayment" (spending from the current account)
 *   current → savings     : "Savings"
 *   anything else         : "Transfers" (not counted)
 */
export function ownTransferCategory(t, ctx) {
  if (!isOwnTransfer(t, ctx)) return null;
  if (t.type !== 'expense') return 'Transfers';
  const to = otherOwnAccount(t, ctx);
  const kind = to ? accountKind(to) : null;
  if (kind === 'credit') return 'Credit card repayment';
  if (kind === 'savings') return 'Savings';
  return 'Transfers';
}

export function isOwnTransfer(t, ctx) {
  if (!ctx) return false;
  const self = ctx.ibanOf?.get(t.accountId);
  if (t.counterpartyIban && t.counterpartyIban !== self && ctx.ibans.has(t.counterpartyIban)) return true;
  const text = `${t.description || ''} ${t.note || ''}`;
  if (ibansIn(text.replace(/\s/g, ' ')).some((iban) => iban !== self && ctx.ibans.has(iban))) return true;
  const who = partyName(text) || (t.counterparty ? nameKey(t.counterparty) : '');
  return Boolean(who) && ctx.names.has(who);
}
