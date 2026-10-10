// One-time data fixes for stores written by earlier versions. Each runs when
// its check says it's needed, then re-categorises what it changed. A backup is
// taken before the first one runs; rows merged away go to the trash.

import { recategorize, assignImportAccounts } from './sync.js';
import { mergeDuplicatesToTrash } from './store.js';
import { extractMerchant, isUselessKeyword, ruleMatches } from '../public/js/shared/categories.js';

// Clearer descriptions for bank rows: the merchant instead of the bank's boilerplate.
function cleanDescriptions(s, re) {
  for (const t of s.transactions) {
    if (t.source === 'bank' && re.test(t.description)) {
      if (!t.note) t.note = t.description;
      t.description = extractMerchant(t.description) || t.description;
    }
  }
}

const MIGRATIONS = [
  {
    // Earlier versions could learn rules from bank boilerplate (e.g. "number transaction"),
    // which matched almost every card payment. Drop them and redo the categories.
    needed: (s) => s.rules.some((r) => isUselessKeyword(r.keyword || r.pattern)),
    run: (s) => {
      const before = s.rules.length;
      s.rules = s.rules.filter((r) => !isUselessKeyword(r.keyword || r.pattern));
      cleanDescriptions(s, /^(card number|cumparare pos)/i);
      const changed = recategorize(s);
      return `Removed ${before - s.rules.length} rule(s) that matched too much; re-categorised ${changed} transaction(s)`;
    },
  },
  {
    // v3: recognise transfers between your own accounts (card repayments, Revolut,
    // cash deposits) and use the cleaner merchant names.
    needed: (s) => !s.settings?.ownTransfersFixed,
    run: (s) => {
      cleanDescriptions(s, /^ordering party|^beneficiary/i);
      const changed = recategorize(s);
      s.settings = { ...s.settings, ownTransfersFixed: true };
      return changed && `Re-categorised ${changed} transaction(s) (transfers between your own accounts are no longer income/spending)`;
    },
  },
  {
    // v4: after removing statements imported twice, redo automatic categories once.
    needed: (s) => !s.settings?.importsDeduped,
    run: (s) => {
      const merged = mergeDuplicatesToTrash(s);
      const changed = recategorize(s);
      s.settings = { ...s.settings, importsDeduped: true };
      return (merged || changed) && `Removed ${merged} duplicate(s) from repeated imports; re-categorised ${changed} transaction(s)`;
    },
  },
  {
    // v5: imported transactions get the account they belong to (card vs current), then
    // money between own accounts is re-categorised (current → card = card repayment).
    needed: (s) => !s.settings?.importAccountsAssigned,
    run: (s) => {
      const assigned = assignImportAccounts(s);
      const changed = recategorize(s);
      s.settings = { ...s.settings, importAccountsAssigned: true, countMode: s.settings?.countMode || 'cashflow' };
      return (assigned || changed) && `Linked ${assigned} imported transaction(s) to their account; re-categorised ${changed}`;
    },
  },
  {
    // v6: duplicates left by earlier versions (CSV import + bank sync of the same
    // purchase), merged once. New ones are merged by the import and the sync.
    needed: (s) => !s.settings?.duplicatesMerged,
    run: (s) => {
      const merged = mergeDuplicatesToTrash(s);
      s.settings = { ...s.settings, duplicatesMerged: true };
      return merged && `Merged ${merged} duplicate transaction(s) (kept in the trash)`;
    },
  },
  {
    // v7: rules made from a merchant key ("revolut dublin") now also match bank text with
    // card numbers or symbols between the words: apply your rules again once.
    needed: (s) => s.rules.length > 0 && !s.settings?.userRulesReapplied,
    run: (s) => {
      const changed = recategorize(s, (t) => s.rules.some((r) => ruleMatches(r, t)));
      s.settings = { ...s.settings, userRulesReapplied: true };
      return changed && `Applied your category rules again: ${changed} transaction(s) updated`;
    },
  },
];

export async function runMigrations(store, log = console.log) {
  let backedUp = false;
  for (const m of MIGRATIONS) {
    if (!m.needed(store.get())) continue;
    if (!backedUp) {
      const file = await store.backup('pre-migration');
      if (file) log(`  Backup before updating your data: ${file}`);
      backedUp = true;
    }
    const message = await store.mutate((s) => m.run(s));
    if (message) log(`  ${message}`);
  }
}
