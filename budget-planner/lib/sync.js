// Turns bank transactions into budget entries: maps fields, auto-categorises,
// and de-duplicates so re-syncing never creates doubles or resurrects
// transactions you deleted.

import { createHash } from 'node:crypto';
import { categorize, extractMerchant, ruleText } from '../public/js/shared/categories.js';
import { round2, todayISO, uid } from '../public/js/shared/money.js';
import { pickBalance } from './enablebanking.js';
import { mergeDuplicates } from '../public/js/shared/dedupe.js';

// Fields we keep from an Enable Banking account resource. Only defined values,
// so a sparse /details response never wipes what the session already gave us.
export function accountInfo(a = {}) {
  const info = {
    cashAccountType: a.cash_account_type,
    creditLimit: a.credit_limit?.amount != null ? Number(a.credit_limit.amount) : undefined,
    product: a.product,
  };
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function ownIbanSet(s) {
  return new Set(s.bank.connections.flatMap((c) => c.accounts).map((a) => (a.iban || '').replace(/\s/g, '').toUpperCase()).filter(Boolean));
}

/**
 * Re-run automatic categorisation (your rules first, then the built-in ones)
 * on imported/bank transactions whose category you did not pick by hand.
 * `only` optionally limits it to some transactions. Returns how many changed.
 */
export function recategorize(s, only = () => true) {
  const own = ownIbanSet(s);
  let changed = 0;
  for (const t of s.transactions) {
    if (t.manualCategory || t.goalId || t.source === 'manual' || !only(t)) continue;
    if (t.counterpartyIban && own.has(t.counterpartyIban)) continue; // own-account transfer
    const category = categorize({ description: ruleText(t), type: t.type }, s.rules, s.categories);
    if (category !== t.category) {
      t.category = category;
      t.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  return changed;
}

export function bankRef(accountUid, t) {
  const id = t.entry_reference || t.transaction_id;
  if (id) return `${accountUid}:${id}`;
  const fingerprint = [
    t.booking_date || t.value_date || t.transaction_date,
    t.transaction_amount?.amount,
    t.credit_debit_indicator,
    (t.remittance_information || []).join(' '),
    t.creditor?.name, t.debtor?.name,
  ].join('|');
  return `${accountUid}:h${createHash('sha1').update(fingerprint).digest('hex').slice(0, 16)}`;
}

export function mapBankTransaction(accountUid, t, { rules, categories }, ownIbans = new Set()) {
  if (t.status && t.status !== 'BOOK') return null; // skip pending
  const amount = round2(Math.abs(Number(t.transaction_amount?.amount)));
  if (!amount) return null;
  const type = t.credit_debit_indicator === 'CRDT' ? 'income' : 'expense';
  const counterparty = (type === 'income' ? t.debtor?.name : t.creditor?.name) || '';
  const remittance = (t.remittance_information || []).join(' ').replace(/\s+/g, ' ').trim();
  // Money moving between your own linked accounts (e.g. paying off the credit
  // card from the current account) is a transfer, not income or spending.
  const counterpartyIban = ((type === 'income' ? t.debtor_account?.iban : t.creditor_account?.iban) || '').replace(/\s/g, '').toUpperCase();
  const own = counterpartyIban && ownIbans.has(counterpartyIban);
  const description = (counterparty || extractMerchant(remittance) || remittance || t.bank_transaction_code?.description || 'Bank transaction').slice(0, 140);
  const now = new Date().toISOString();
  return {
    id: uid(),
    type,
    amount,
    category: own ? 'Transfers' : categorize({ description: `${description} ${remittance}`, counterparty, type }, rules, categories),
    counterpartyIban: counterpartyIban || undefined,
    description,
    note: remittance && remittance !== description ? remittance.slice(0, 280) : '',
    date: t.booking_date || t.value_date || t.transaction_date || todayISO(),
    source: 'bank',
    accountId: accountUid,
    bankRef: bankRef(accountUid, t),
    currency: t.transaction_amount?.currency || 'RON',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pull balances + transactions for every linked account into the store.
 * Returns { added, accounts }.
 */
export async function syncBank(store, client, { lookbackDays = 90 } = {}) {
  const state = store.get();
  const connections = state.bank.connections.filter((c) => new Date(c.validUntil) > new Date());
  if (!connections.length) {
    const expired = state.bank.connections.length > 0;
    throw new Error(expired ? 'Your bank consent expired. Re-link the bank in Settings (PSD2 requires this every 90–180 days).' : 'No bank account linked yet.');
  }

  const fetched = [];
  for (const conn of connections) {
    for (const acc of conn.accounts) {
      const since = acc.lastSyncDate
        ? todayISO(new Date(new Date(acc.lastSyncDate).getTime() - 5 * 86400 * 1000)) // small overlap for late bookings
        : todayISO(new Date(Date.now() - lookbackDays * 86400 * 1000));
      const [balances, txs] = await Promise.all([client.balances(acc.uid), client.transactions(acc.uid, since)]);
      // Account type and credit limit (to tell credit cards apart); fetched once.
      let details = null;
      if (!acc.detailsFetched) details = await client.accountDetails(acc.uid).catch(() => ({}));
      fetched.push({ conn, acc, balance: pickBalance(balances), txs, details });
    }
  }

  return store.mutate((s) => {
    const known = new Set(s.transactions.filter((t) => t.bankRef).map((t) => t.bankRef));
    for (const ref of s.deletedBankRefs) known.add(ref);
    let added = 0;
    const ownIbans = new Set(s.bank.connections.flatMap((c) => c.accounts).map((a) => (a.iban || '').replace(/\s/g, '').toUpperCase()).filter(Boolean));
    for (const { conn, acc, balance, txs, details } of fetched) {
      const target = s.bank.connections.find((c) => c.sessionId === conn.sessionId)?.accounts.find((a) => a.uid === acc.uid);
      if (target && details) Object.assign(target, accountInfo(details), { detailsFetched: true });
      for (const raw of txs) {
        const t = mapBankTransaction(acc.uid, raw, s, ownIbans);
        if (!t || known.has(t.bankRef)) continue;
        known.add(t.bankRef);
        s.transactions.push(t);
        added += 1;
      }
      if (target) {
        target.balance = balance;
        target.lastSyncDate = todayISO();
      }
    }
    const ibanOf = new Map(s.bank.connections.flatMap((c) => c.accounts).map((a) => [a.uid, (a.iban || '').replace(/\s/g, '').toUpperCase()]));
    // Older imports between your own accounts (never edited by you) → Transfers.
    for (const t of s.transactions) {
      if (t.source !== 'bank' || t.category === 'Transfers' || t.goalId || t.updatedAt !== t.createdAt) continue;
      const text = `${t.description} ${t.note || ''}`.replace(/\s/g, '').toUpperCase();
      const self = ibanOf.get(t.accountId);
      if ([...ownIbans].some((iban) => iban !== self && text.includes(iban))) t.category = 'Transfers';
    }
    const merged = mergeDuplicates(s); // same purchase already imported from a CSV
    s.bank.lastSync = new Date().toISOString();
    s.bank.lastError = null;
    return { added: added - merged, accounts: fetched.length };
  });
}
