// Turns bank transactions into budget entries: maps fields, auto-categorises,
// and de-duplicates so re-syncing never creates doubles or resurrects
// transactions you deleted.

import { createHash } from 'node:crypto';
import { categorize, extractMerchant, ruleText } from '../public/js/shared/categories.js';
import { round2, todayISO, uid } from '../public/js/shared/money.js';
import { pickBalance } from './enablebanking.js';
import { accountKind } from '../public/js/shared/accounts.js';
import { mergeDuplicates } from '../public/js/shared/dedupe.js';
import { ownContext, ownTransferCategory, ibansIn } from '../public/js/shared/own.js';
import { bnrRate } from './fx.js';

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

/**
 * Re-run automatic categorisation (your rules first, then the built-in ones)
 * on imported/bank transactions whose category you did not pick by hand.
 * `only` optionally limits it to some transactions. Returns how many changed.
 */
export function recategorize(s, only = () => true) {
  const own = ownContext(s);
  let changed = 0;
  for (const t of s.transactions) {
    if (t.manualCategory || t.goalId || t.source === 'manual' || !only(t)) continue;
    const category = ownTransferCategory(t, own) || categorize({ description: ruleText(t), type: t.type }, s.rules, s.categories);
    if (category !== t.category) {
      t.category = category;
      t.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  return changed;
}

const CARD_NO = /\*{2,}\s*(\d{4})\b/;

/**
 * CSV imports made before you could pick the account don't know which account
 * they belong to. Work it out:
 *   1. card number (**** 8391) → the account bank-synced transactions with that card belong to;
 *   2. a credit-card repayment received → the credit card;
 *   3. otherwise the account most rows of the same import belong to, or the current account.
 * Returns how many were assigned.
 */
export function assignImportAccounts(s) {
  const accounts = s.bank.connections.flatMap((c) => c.accounts);
  if (!accounts.length) return 0;
  const current = accounts.find((a) => accountKind(a) === 'current');
  const card = accounts.find((a) => accountKind(a) === 'credit');
  const cardDigits = (t) => `${t.description} ${t.note || ''}`.match(CARD_NO)?.[1];
  const cardAccount = new Map();
  for (const t of s.transactions) {
    const digits = t.accountId && t.source === 'bank' && cardDigits(t);
    if (digits) cardAccount.set(digits, t.accountId);
  }
  const todo = s.transactions.filter((t) => t.source === 'import' && !t.accountId);
  const guess = (t) => {
    const digits = cardDigits(t);
    if (digits && cardAccount.has(digits)) return cardAccount.get(digits);
    if (card && t.type === 'income' && /rambursare (rata )?card/i.test(`${t.description} ${t.note || ''}`)) return card.uid;
    return null;
  };
  const batchOf = (t) => t.batchId || (t.createdAt || '').slice(0, 16);
  const votes = new Map();
  for (const t of todo) {
    const g = guess(t);
    if (!g) continue;
    const v = votes.get(batchOf(t)) || new Map();
    v.set(g, (v.get(g) || 0) + 1);
    votes.set(batchOf(t), v);
  }
  let n = 0;
  for (const t of todo) {
    let acc = guess(t);
    if (!acc) {
      const v = [...(votes.get(batchOf(t)) || new Map()).entries()].sort((a, b) => b[1] - a[1]);
      const total = v.reduce((x, [, c]) => x + c, 0);
      if (v.length && v[0][1] / total >= 0.8) acc = v[0][0];
    }
    acc ||= current?.uid;
    if (acc) { t.accountId = acc; n += 1; }
  }
  return n;
}

function fingerprintOf(t) {
  return [
    t.booking_date || t.value_date || t.transaction_date,
    t.transaction_amount?.amount,
    t.credit_debit_indicator,
    (t.remittance_information || []).join(' '),
    t.creditor?.name, t.debtor?.name,
  ].join('|');
}

/**
 * Stable id for a bank transaction. Without a bank-provided id it is a hash of
 * the transaction's fields; `nth` numbers identical rows within one fetch (two
 * 5 RON parking tickets on the same day), so they don't collapse into one.
 * The first one keeps the plain hash, which matches refs stored by earlier versions.
 */
export function bankRef(accountUid, t, nth = 1) {
  const id = t.entry_reference || t.transaction_id;
  if (id) return `${accountUid}:${id}`;
  const hash = createHash('sha1').update(fingerprintOf(t)).digest('hex').slice(0, 16);
  return `${accountUid}:h${hash}${nth > 1 ? `#${nth}` : ''}`;
}

// Income or expense: the bank's credit/debit indicator, else the amount's sign.
function directionOf(t) {
  if (t.credit_debit_indicator === 'CRDT') return 'income';
  if (t.credit_debit_indicator === 'DBIT') return 'expense';
  return Number(t.transaction_amount?.amount) < 0 ? 'expense' : 'income';
}

/**
 * `rate` converts the transaction's currency to RON (RON per unit); the
 * original amount and currency are kept alongside.
 */
export function mapBankTransaction(accountUid, t, { rules, categories }, own = null, { nth = 1, rate = 1 } = {}) {
  if (t.status && t.status !== 'BOOK') return null; // skip pending
  const original = Math.abs(Number(t.transaction_amount?.amount));
  const currency = t.transaction_amount?.currency || 'RON';
  const amount = round2(currency === 'RON' ? original : original * rate);
  if (!amount) return null;
  const type = directionOf(t);
  const counterparty = (type === 'income' ? t.debtor?.name : t.creditor?.name) || '';
  const remittance = (t.remittance_information || []).join(' ').replace(/\s+/g, ' ').trim();
  // Money moving between your own linked accounts (e.g. paying off the credit
  // card from the current account) is a transfer, not income or spending.
  const counterpartyIban = ((type === 'income' ? t.debtor_account?.iban : t.creditor_account?.iban) || '').replace(/\s/g, '').toUpperCase();
  const description = (counterparty || extractMerchant(remittance) || remittance || t.bank_transaction_code?.description || 'Bank transaction').slice(0, 140);
  const note = remittance && remittance !== description ? remittance.slice(0, 280) : '';
  const ownCategory = ownTransferCategory({ accountId: accountUid, type, counterpartyIban, counterparty, description, note }, own);
  const now = new Date().toISOString();
  return {
    id: uid(),
    type,
    amount,
    category: ownCategory || categorize({ description: `${description} ${remittance}`, counterparty, type }, rules, categories),
    counterpartyIban: counterpartyIban || ibansIn(remittance)[0] || undefined,
    counterparty: counterparty || undefined,
    description,
    note,
    date: t.booking_date || t.value_date || t.transaction_date || todayISO(),
    source: 'bank',
    accountId: accountUid,
    bankRef: bankRef(accountUid, t, nth),
    currency: 'RON',
    ...(currency !== 'RON' ? { originalAmount: round2(original), originalCurrency: currency, exchangeRate: rate } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// RON per unit for every non-RON currency in the transactions.
async function ratesFor(txs, rate) {
  const rates = new Map();
  for (const raw of txs) {
    const currency = raw.transaction_amount?.currency || 'RON';
    if (currency !== 'RON' && !rates.has(currency)) rates.set(currency, await rate(currency));
  }
  return rates;
}

async function fetchAccount(client, acc, { lookbackDays, rate }) {
  const since = acc.lastSyncDate
    ? todayISO(new Date(new Date(acc.lastSyncDate).getTime() - 5 * 86400 * 1000)) // small overlap for late bookings
    : todayISO(new Date(Date.now() - lookbackDays * 86400 * 1000));
  const [balances, txs] = await Promise.all([client.balances(acc.uid), client.transactions(acc.uid, since)]);
  // Account type and credit limit (to tell credit cards apart); fetched once.
  const details = acc.detailsFetched ? null : await client.accountDetails(acc.uid).catch(() => ({}));
  return { balance: pickBalance(balances), txs, truncated: Boolean(txs.truncated), details, rates: await ratesFor(txs, rate) };
}

/**
 * Pull balances + transactions for every linked account into the store.
 * An account that fails is reported in `errors` without losing the others;
 * the sync only throws when every account failed.
 * Returns { added, accounts, errors }.
 */
export async function syncBank(store, client, { lookbackDays = 90, rate = bnrRate } = {}) {
  const state = store.get();
  const connections = state.bank.connections.filter((c) => new Date(c.validUntil) > new Date());
  if (!connections.length) {
    const expired = state.bank.connections.length > 0;
    throw new Error(expired ? 'Your bank consent expired. Re-link the bank in Settings (PSD2 requires this every 90–180 days).' : 'No bank account linked yet.');
  }

  const fetched = [];
  const errors = [];
  for (const conn of connections) {
    for (const acc of conn.accounts) {
      try {
        fetched.push({ conn, acc, ...await fetchAccount(client, acc, { lookbackDays, rate }) });
      } catch (err) {
        errors.push(`${acc.nickname || acc.name || acc.uid}: ${err.message}`);
      }
    }
  }
  if (!fetched.length) throw new Error(errors.join('; '));

  return store.mutate((s) => {
    const known = new Set(s.transactions.filter((t) => t.bankRef).map((t) => t.bankRef));
    for (const ref of s.deletedBankRefs) known.add(ref);
    let added = 0;
    for (const { conn, acc, balance, txs, truncated, details, rates } of fetched) {
      const target = s.bank.connections.find((c) => c.sessionId === conn.sessionId)?.accounts.find((a) => a.uid === acc.uid);
      if (!target) continue; // the bank was unlinked while we were fetching
      if (details) Object.assign(target, accountInfo(details), { detailsFetched: true });
      const own = ownContext(s); // after details: names/IBANs of every linked account
      const occurrences = new Map();
      for (const raw of txs) {
        const hasId = Boolean(raw.entry_reference || raw.transaction_id);
        const fp = hasId ? null : fingerprintOf(raw);
        const nth = hasId ? 1 : (occurrences.get(fp) || 0) + 1;
        if (fp) occurrences.set(fp, nth);
        const rateRON = rates.get(raw.transaction_amount?.currency) || 1;
        const t = mapBankTransaction(acc.uid, raw, s, own, { nth, rate: rateRON });
        if (!t || known.has(t.bankRef)) continue;
        known.add(t.bankRef);
        s.transactions.push(t);
        added += 1;
      }
      target.balance = balance;
      // An incomplete fetch keeps the old date, so the next sync asks for the rest again.
      if (truncated) errors.push(`${acc.nickname || acc.name || acc.uid}: too many transactions, only part was fetched`);
      else target.lastSyncDate = todayISO();
    }
    // Earlier entries between your own accounts (not categorised by hand) → Transfers.
    const own = ownContext(s);
    recategorize(s, (t) => { const c = ownTransferCategory(t, own); return Boolean(c) && c !== t.category; });
    const merged = mergeDuplicates(s); // same purchase already imported from a CSV
    s.bank.lastSync = new Date().toISOString();
    s.bank.lastError = errors.length ? errors.join('; ') : null;
    return { added: Math.max(0, added - merged), accounts: fetched.length, errors };
  });
}
