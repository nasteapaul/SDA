// Turns bank transactions into budget entries: maps fields, auto-categorises,
// and de-duplicates so re-syncing never creates doubles or resurrects
// transactions you deleted.

import { createHash } from 'node:crypto';
import { categorize } from '../public/js/shared/categories.js';
import { round2, todayISO, uid } from '../public/js/shared/money.js';
import { pickBalance } from './enablebanking.js';

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

export function mapBankTransaction(accountUid, t, { rules, categories }) {
  if (t.status && t.status !== 'BOOK') return null; // skip pending
  const amount = round2(Math.abs(Number(t.transaction_amount?.amount)));
  if (!amount) return null;
  const type = t.credit_debit_indicator === 'CRDT' ? 'income' : 'expense';
  const counterparty = (type === 'income' ? t.debtor?.name : t.creditor?.name) || '';
  const remittance = (t.remittance_information || []).join(' ').replace(/\s+/g, ' ').trim();
  const description = (counterparty || remittance || t.bank_transaction_code?.description || 'Bank transaction').slice(0, 140);
  const now = new Date().toISOString();
  return {
    id: uid(),
    type,
    amount,
    category: categorize({ description: `${description} ${remittance}`, counterparty, type }, rules, categories),
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
      fetched.push({ conn, acc, balance: pickBalance(balances), txs });
    }
  }

  return store.mutate((s) => {
    const known = new Set(s.transactions.filter((t) => t.bankRef).map((t) => t.bankRef));
    for (const ref of s.deletedBankRefs) known.add(ref);
    let added = 0;
    for (const { conn, acc, balance, txs } of fetched) {
      for (const raw of txs) {
        const t = mapBankTransaction(acc.uid, raw, s);
        if (!t || known.has(t.bankRef)) continue;
        known.add(t.bankRef);
        s.transactions.push(t);
        added += 1;
      }
      const target = s.bank.connections.find((c) => c.sessionId === conn.sessionId)?.accounts.find((a) => a.uid === acc.uid);
      if (target) {
        target.balance = balance;
        target.lastSyncDate = todayISO();
      }
    }
    s.bank.lastSync = new Date().toISOString();
    s.bank.lastError = null;
    return { added, accounts: fetched.length };
  });
}
