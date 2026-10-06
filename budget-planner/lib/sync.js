// Turns bank transactions into budget entries: maps fields, auto-categorises,
// and de-duplicates so re-syncing never creates doubles or resurrects
// transactions you deleted.

import { createHash } from 'node:crypto';
import { categorize, extractMerchant, ruleText } from '../public/js/shared/categories.js';
import { round2, todayISO, uid } from '../public/js/shared/money.js';
import { pickBalance, accountIdentity } from './enablebanking.js';
import { accountKind } from '../public/js/shared/accounts.js';
import { mergeDuplicates } from '../public/js/shared/dedupe.js';
import { ownContext, ownTransferCategory, ibansIn } from '../public/js/shared/own.js';
import { bnrRateOn } from './fx.js';

// Booked transactions are re-fetched this many days before the last sync:
// banks backdate the booking date of long-pending card payments. The bankRef
// de-duplication makes the overlap safe.
const SYNC_OVERLAP_DAYS = 30;

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

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** The stored form of an account from a new Enable Banking session (string uid or account resource). */
export function accountFromSession(raw) {
  const a = typeof raw === 'string' ? { uid: raw } : raw || {};
  const other = a.account_id?.other;
  const otherId = typeof other?.identification === 'string' ? other.identification : '';
  const maskedPan = /^(MPAN|CPAN)$/i.test(other?.scheme_name || '') || otherId.includes('*') ? otherId : undefined;
  return {
    uid: a.uid,
    name: a.name || a.product || a.details || 'Account',
    iban: accountIdentity({ iban: a.account_id?.iban }).iban,
    currency: a.currency || 'RON',
    ...accountInfo(a),
    ...defined({
      identificationHash: typeof a.identification_hash === 'string' ? a.identification_hash : undefined,
      identificationHashes: Array.isArray(a.identification_hashes) && a.identification_hashes.length ? a.identification_hashes.filter((h) => typeof h === 'string') : undefined,
      maskedPan,
    }),
    detailsFetched: Boolean(a.cash_account_type),
    balance: null,
    lastSyncDate: null,
  };
}

// Your own settings and sync progress, kept from the old account on a re-link.
const CARRIED = ['name', 'nickname', 'kind', 'creditLimit', 'balanceMeaning', 'cardDigits', 'balance', 'lastSyncDate', 'detailsFetched'];

// The uid a bankRef was made with, and the bank's own id for the entry.
function splitRef(ref, accountId) {
  if (accountId && ref.startsWith(`${accountId}:`)) return [accountId, ref.slice(accountId.length + 1)];
  const i = ref.indexOf(':');
  return i < 0 ? ['', ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

/**
 * Moves everything recorded under account `from` to account `to`: the
 * transactions' account, their bankRef / importHash prefixes and the refs of
 * deleted bank transactions (so they stay deleted).
 */
export function moveAccount(s, from, to) {
  if (!from || !to || from === to) return 0;
  let n = 0;
  for (const t of s.transactions) {
    if (t.bankRef && t.bankRef.startsWith(`${from}:`)) t.bankRef = `${to}:${t.bankRef.slice(from.length + 1)}`;
    if (t.importHash && t.importHash.startsWith(`${from}|`)) t.importHash = `${to}|${t.importHash.slice(from.length + 1)}`;
    if (t.accountId === from) { t.accountId = to; n += 1; }
  }
  s.deletedBankRefs = [...new Set((s.deletedBankRefs || []).map((r) => (r.startsWith(`${from}:`) ? `${to}:${r.slice(from.length + 1)}` : r)))];
  return n;
}

/**
 * A new bank link (consent renewal) gives the same accounts new uids. Matches
 * each account of `conn` (the new connection) to one of the accounts in
 * `previous` (the connections it replaces) — by IBAN, else Enable Banking
 * identification hash, else masked card number — carries over your settings
 * and moves the old account's transactions to the new uid.
 * Old accounts without a match that still have transactions are returned in
 * `archived` (a connection that is never synced), so their transactions keep
 * a known account and kind. Returns { matched: { oldUid: newUid }, archived }.
 */
export function relinkAccounts(s, conn, previous) {
  const olds = previous.flatMap((c) => c.accounts || []);
  const matched = {};
  const taken = new Set();
  const sameCurrency = (o, n) => !o.currency || !n.currency || o.currency === n.currency;
  const passes = [
    (o, n) => Boolean(o.iban && o.iban === n.iban),
    (o, n) => o.hashes.some((h) => n.hashes.includes(h)),
    (o, n, old) => Boolean(n.panLast4 && (o.panLast4 === n.panLast4 || (old.cardDigits || []).includes(n.panLast4))),
  ];
  for (const same of passes) {
    for (const acc of conn.accounts) {
      if (Object.values(matched).includes(acc.uid)) continue;
      const nid = accountIdentity(acc);
      const old = olds.find((o) => !taken.has(o.uid) && o.uid !== acc.uid && sameCurrency(o, acc) && same(accountIdentity(o), nid, o));
      if (!old) continue;
      taken.add(old.uid);
      matched[old.uid] = acc.uid;
      const carried = Object.fromEntries(CARRIED.filter((k) => old[k] !== undefined && old[k] !== null).map((k) => [k, old[k]]));
      if (!carried.detailsFetched) delete carried.detailsFetched;
      Object.assign(acc, { ...old, ...defined(acc), ...carried, uid: acc.uid });
      moveAccount(s, old.uid, acc.uid);
    }
  }
  dedupeBankTransactions(s);

  const inUse = new Set(s.transactions.map((t) => t.accountId).filter(Boolean));
  const leftover = olds.filter((o) => !taken.has(o.uid) && inUse.has(o.uid));
  let archived = null;
  if (leftover.length) {
    const first = previous[0];
    const now = new Date().toISOString();
    const validUntil = first.validUntil && first.validUntil < now ? first.validUntil : now;
    archived = { sessionId: first.sessionId, bank: first.bank, validUntil, archived: true, accounts: leftover };
  }
  return { matched, archived };
}

/**
 * Bank transactions orphaned by an earlier re-link (their account uid is no
 * longer linked) are moved to the linked account that has the same bank
 * entries. Returns the number of accounts adopted.
 */
export function adoptOrphanAccounts(s) {
  const known = new Set(s.bank.connections.flatMap((c) => c.accounts || []).map((a) => a.uid));
  const owners = new Map(); // entry id → linked account uids having it
  const orphans = new Map(); // orphan uid → its entry ids
  for (const t of s.transactions) {
    if (t.source !== 'bank' || !t.bankRef || !t.accountId) continue;
    const [, entry] = splitRef(t.bankRef, t.accountId);
    if (known.has(t.accountId)) {
      if (!owners.has(entry)) owners.set(entry, new Set());
      owners.get(entry).add(t.accountId);
    } else {
      if (!orphans.has(t.accountId)) orphans.set(t.accountId, []);
      orphans.get(t.accountId).push(entry);
    }
  }
  let n = 0;
  for (const [orphan, entries] of orphans) {
    const votes = new Map();
    for (const e of entries) for (const owner of owners.get(e) || []) votes.set(owner, (votes.get(owner) || 0) + 1);
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) continue; // no or ambiguous evidence
    moveAccount(s, orphan, ranked[0][0]);
    n += 1;
  }
  return n;
}

/**
 * Two bank transactions with the same bank entry id on the same account are
 * one transaction. Keeps the copy you edited (category, goal, account), else
 * the oldest. Returns how many were removed.
 */
export function dedupeBankTransactions(s) {
  const keep = new Map();
  const remove = new Set();
  const edited = (t) => Number(Boolean(t.manualCategory)) + Number(Boolean(t.goalId)) + Number(Boolean(t.accountManual));
  const better = (a, b) => edited(a) - edited(b) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  for (const t of s.transactions) {
    if (t.source !== 'bank' || !t.bankRef) continue;
    const key = `${t.accountId || ''}\u0000${splitRef(t.bankRef, t.accountId)[1]}`;
    const kept = keep.get(key);
    if (!kept) { keep.set(key, t); continue; }
    if (better(t, kept) > 0) { remove.add(kept.id); keep.set(key, t); } else remove.add(t.id);
  }
  if (remove.size) s.transactions = s.transactions.filter((t) => !remove.has(t.id));
  return remove.size;
}

/**
 * RON per unit of `currency` from the bank's own exchange-rate field, when it
 * is a rate to or from RON; otherwise null.
 */
export function bankRateRON(t, currency) {
  const er = t?.exchange_rate;
  if (!er || !currency || currency === 'RON') return null;
  const instructed = er.instructed_amount;
  const original = Math.abs(Number(t.transaction_amount?.amount));
  if (instructed?.currency === 'RON' && Number(instructed.amount) && original) {
    return Math.abs(Number(instructed.amount)) / original;
  }
  if (instructed?.currency && instructed.currency !== 'RON') return null; // a rate to another currency
  const rate = Number(er.exchange_rate);
  if (!(rate > 0)) return null;
  if (er.unit_currency === currency) return rate;
  if (er.unit_currency === 'RON') return 1 / rate;
  return null;
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
export function mapBankTransaction(accountUid, t, { rules, categories }, own = null, { nth = 1, rate = 1, rateDate, rateSource } = {}) {
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
    ...(currency !== 'RON' ? {
      originalAmount: round2(original),
      originalCurrency: currency,
      exchangeRate: rate,
      ...defined({ rateDate, rateSource }), // day of the rate used; 'bank' or 'bnr'
    } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// `rate(currency, date)` may return RON per unit, or { rate, date } with the day of the rate used.
async function lookupRate(rate, currency, date) {
  const r = await rate(currency, date);
  return typeof r === 'number' ? { rate: r, date } : { rate: Number(r?.rate), date: r?.date || date };
}

/**
 * Exchange rate for each foreign-currency transaction (same order as `txs`,
 * null for RON): the bank's own rate when it gave one, else BNR's rate of the
 * booking date. Each (currency, day) is looked up once.
 */
async function ratesFor(txs, rate) {
  const memo = new Map();
  const out = [];
  for (const raw of txs) {
    const currency = raw.transaction_amount?.currency || 'RON';
    const date = raw.booking_date || raw.value_date || raw.transaction_date || todayISO();
    if (currency === 'RON' || (raw.status && raw.status !== 'BOOK')) { out.push(null); continue; }
    const fromBank = bankRateRON(raw, currency);
    if (fromBank) { out.push({ rate: fromBank, date, source: 'bank' }); continue; }
    const key = `${currency}|${date}`;
    if (!memo.has(key)) {
      const found = await lookupRate(rate, currency, date);
      if (!(found.rate > 0)) throw new Error(`No exchange rate for ${currency}`);
      memo.set(key, { ...found, source: 'bnr' });
    }
    out.push(memo.get(key));
  }
  return out;
}

// The balance plus `amountRON` (today's rate) so balances in other currencies add up in RON.
// An unknown rate leaves amountRON out rather than failing the account.
async function balanceWithRON(balance, acc, rate) {
  if (!balance) return balance;
  const currency = balance.currency || acc.currency || 'RON';
  if (currency === 'RON') return { ...balance, amountRON: balance.amount };
  try {
    const { rate: r } = await lookupRate(rate, currency, todayISO());
    return r > 0 ? { ...balance, amountRON: round2(balance.amount * r) } : balance;
  } catch {
    return balance;
  }
}

async function fetchAccount(client, acc, { lookbackDays, rate }) {
  const since = acc.lastSyncDate
    ? todayISO(new Date(new Date(acc.lastSyncDate).getTime() - SYNC_OVERLAP_DAYS * 86400 * 1000))
    : todayISO(new Date(Date.now() - lookbackDays * 86400 * 1000));
  const [balances, txs] = await Promise.all([client.balances(acc.uid), client.transactions(acc.uid, since)]);
  // Account type and credit limit (to tell credit cards apart); fetched once.
  const details = acc.detailsFetched ? null : await client.accountDetails(acc.uid).catch(() => ({}));
  const rates = await ratesFor(txs, rate);
  return { balance: await balanceWithRON(pickBalance(balances), acc, rate), txs, truncated: Boolean(txs.truncated), details, rates };
}

/**
 * Pull balances + transactions for every linked account into the store.
 * An account that fails is reported in `errors` without losing the others;
 * the sync only throws when every account failed.
 * Returns { added, accounts, errors }.
 */
export async function syncBank(store, client, { lookbackDays = 90, rate = bnrRateOn } = {}) {
  const state = store.get();
  // Archived connections hold old accounts a re-link could not match: kept for their history, never synced.
  const connections = state.bank.connections.filter((c) => !c.archived && new Date(c.validUntil) > new Date());
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
    // Repair data from re-links made before accounts were carried over.
    adoptOrphanAccounts(s);
    dedupeBankTransactions(s);
    const known = new Set(s.transactions.filter((t) => t.bankRef).map((t) => t.bankRef));
    for (const ref of s.deletedBankRefs) known.add(ref);
    let added = 0;
    for (const { conn, acc, balance, txs, truncated, details, rates } of fetched) {
      const target = s.bank.connections.find((c) => c.sessionId === conn.sessionId)?.accounts.find((a) => a.uid === acc.uid);
      if (!target) continue; // the bank was unlinked while we were fetching
      if (details) Object.assign(target, accountInfo(details), { detailsFetched: true });
      const own = ownContext(s); // after details: names/IBANs of every linked account
      const occurrences = new Map();
      txs.forEach((raw, i) => {
        const hasId = Boolean(raw.entry_reference || raw.transaction_id);
        const fp = hasId ? null : fingerprintOf(raw);
        const nth = hasId ? 1 : (occurrences.get(fp) || 0) + 1;
        if (fp) occurrences.set(fp, nth);
        const r = rates[i];
        const t = mapBankTransaction(acc.uid, raw, s, own, { nth, rate: r?.rate || 1, rateDate: r?.date, rateSource: r?.source });
        if (!t || known.has(t.bankRef)) return;
        known.add(t.bankRef);
        s.transactions.push(t);
        added += 1;
      });
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
