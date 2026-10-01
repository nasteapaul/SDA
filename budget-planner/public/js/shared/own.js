// Recognises money moving between your own accounts — paying off the credit
// card, topping up / getting money back from Revolut, sending to yourself.
// Those are transfers: counting them as income or spending would inflate both
// (and the month's "left over") by the same amount.

import { normalize } from './categories.js';

const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

export function ibansIn(text) {
  return String(text || '').toUpperCase().match(IBAN_RE) || [];
}

// Counterparty name in bank text: "Ordering party, NAME, …", "Ordonator:NAME", "Beneficiar:NAME".
export function partyName(text) {
  const m = String(text || '').match(/(?:ordering party|beneficiary|ordonator|beneficiar|platitor|payer|payee)\s*[:,]\s*([^,;\n]+)/i);
  return m ? normalize(m[1]) : '';
}

function looksLikePersonName(name) {
  const words = normalize(name).split(' ').filter(Boolean);
  return words.length >= 2 && !/\b(cont|card|account|credit|economii|savings|current|curent|depozit)\b/.test(normalize(name));
}

/** Everything that identifies "you": linked IBANs and the account holder name(s). */
export function ownContext(state) {
  const accounts = (state.bank?.connections || []).flatMap((c) => c.accounts);
  const ibans = new Set(accounts.map((a) => (a.iban || '').replace(/\s/g, '').toUpperCase()).filter(Boolean));
  const names = new Set(accounts.map((a) => a.name).filter(looksLikePersonName).map(normalize));
  for (const n of state.settings?.ownNames || []) names.add(normalize(n));
  const ibanOf = new Map(accounts.map((a) => [a.uid, (a.iban || '').replace(/\s/g, '').toUpperCase()]));
  return { ibans, names, ibanOf };
}

export function isOwnTransfer(t, ctx) {
  if (!ctx) return false;
  const self = ctx.ibanOf?.get(t.accountId);
  if (t.counterpartyIban && t.counterpartyIban !== self && ctx.ibans.has(t.counterpartyIban)) return true;
  const text = `${t.description || ''} ${t.note || ''}`;
  if (ibansIn(text.replace(/\s/g, ' ')).some((iban) => iban !== self && ctx.ibans.has(iban))) return true;
  const who = partyName(text) || normalize(t.counterparty || '');
  return Boolean(who) && ctx.names.has(who);
}
