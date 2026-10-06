// Bank statement CSV import. Works with the CSV exports from Romanian banks
// (BT, BCR, ING, Raiffeisen, BRD, Revolut) and generic files: it finds the
// header row, guesses the date / description / amount (or debit + credit)
// columns and understands Romanian number and date formats.
//
// Also understood: a currency column (rows not in RON are flagged, see below),
// a status column (reverted / pending / declined rows are skipped), a fee
// column (added to what you paid), an unsigned amount with a direction column
// (Debit/Credit, D/C, DB/CR, in/out) and US month/day dates (decided per file).

import { parseAmount, round2 } from './money.js';
import { normalize, extractMerchant } from './categories.js';

export function parseCSV(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 30).join('\n');
  const counts = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch] += 1;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

const HEADERS = {
  date: ['data tranzactiei', 'data tranzactie', 'data operatiunii', 'data inregistrarii', 'data contabila', 'booking date', 'transaction date', 'completed date', 'started date', 'data', 'date'],
  description: ['descriere', 'detalii tranzactie', 'detalii', 'description', 'beneficiar', 'merchant', 'explicatie', 'payee', 'tranzactie', 'narrative', 'reference'],
  amount: ['suma', 'amount', 'valoare', 'value'],
  debit: ['debit', 'suma debit', 'plati', 'iesiri', 'money out', 'paid out'],
  credit: ['credit', 'suma credit', 'incasari', 'intrari', 'money in', 'paid in'],
};
// Matched exactly (normalised), so "Data valuta" is never taken for the currency.
const EXTRA = {
  currency: ['currency', 'valuta', 'moneda', 'moneda tranzactiei', 'valuta tranzactiei', 'transaction currency'],
  state: ['state', 'stare', 'status', 'stare tranzactie', 'status tranzactie', 'transaction status'],
  fee: ['fee', 'fees', 'comision', 'comisioane', 'comision bancar', 'taxa', 'taxe'],
  direction: ['tip', 'type', 'd/c', 'c/d', 'dc', 'debit/credit', 'credit/debit', 'dr/cr', 'cr/dr', 'sens', 'directie', 'direction', 'tip operatiune', 'tip tranzactie', 'transaction type'],
};
const NOT_DONE = /^(reverted|revert|pending|declined|failed|anulat|anulata|anulare|cancel+ed|rejected|respins|respinsa|in asteptare|in curs|in procesare|neefectuat|neefectuata|blocat|blocata|expired|expirat|expirata)\b/;
const DEBIT = new Set(['debit', 'd', 'db', 'dr', 'out', 'iesire', 'iesiri', 'plata', 'plati', '-']);
const CREDIT = new Set(['credit', 'c', 'cr', 'in', 'intrare', 'intrari', 'incasare', 'incasari', '+']);
const RON = new Set(['', 'ron', 'lei', 'leu']);

const findExact = (header, names) => header.findIndex((h) => names.includes(h));

function findCol(header, names) {
  for (const n of names) {
    const i = header.findIndex((h) => h === n);
    if (i !== -1) return i;
  }
  for (const n of names) {
    const i = header.findIndex((h) => h.startsWith(n) || h.includes(n));
    if (i !== -1) return i;
  }
  return -1;
}

const MONTHS_RO = { ian: 1, feb: 2, mar: 3, apr: 4, mai: 5, iun: 6, iul: 7, aug: 8, sep: 9, oct: 10, noi: 11, nov: 11, dec: 12, jan: 1, may: 5, jun: 6, jul: 7 };

const NUMERIC_DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/;

// order: 'dmy' (Romanian, default) or 'mdy' (US) for numeric dates like 09/03/2026.
export function parseDate(input, order = 'dmy') {
  const s = normalize(input);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(NUMERIC_DATE);
  if (m) {
    const [d, mo] = order === 'mdy' ? [m[2], m[1]] : [m[1], m[2]];
    return iso(m[3].length === 2 ? `20${m[3]}` : m[3], mo, d);
  }
  m = s.match(/^(\d{1,2})[ .-]([a-z]{3})[a-z]*\.?[ .-](\d{4})/);
  if (m && MONTHS_RO[m[2]]) return iso(m[3], MONTHS_RO[m[2]], m[1]);
  return null;
}

// Only real calendar dates (31.02 is rejected, 29.02 only in leap years).
function iso(y, mo, d) {
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysInMonth = new Date(Number(y), Number(mo), 0).getDate();
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= daysInMonth ? date : null;
}

// A file is US (month/day) only when some date can't be day/month (09/25/2026)
// and none can't be month/day (25/09/2026). Decided once for the whole file.
function dateOrder(cells) {
  let dmy = false; let mdy = false;
  for (const c of cells) {
    const m = normalize(c || '').match(NUMERIC_DATE);
    if (!m) continue;
    if (Number(m[1]) > 12 && Number(m[2]) <= 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  return mdy && !dmy ? 'mdy' : 'dmy';
}

/**
 * Returns { items, columns, skipped, needsFx }.
 * items: [{ date, type, amount, description, note }] with amount in RON, or —
 * for rows in another currency — { ..., amount: <original number, NOT RON>,
 * needsFx: true, originalAmount, originalCurrency: 'EUR' }. needsFx counts
 * those rows so the import screen can warn that they still need converting.
 * skipped counts rows that were not transactions or did not complete.
 */
export function csvToTransactions(text) {
  const rows = parseCSV(text);
  let headerIdx = -1; let cols = null;
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const header = rows[i].map(normalize);
    const c = {
      date: findCol(header, HEADERS.date),
      description: findCol(header, HEADERS.description),
      amount: findCol(header, HEADERS.amount),
      debit: findCol(header, HEADERS.debit),
      credit: findCol(header, HEADERS.credit),
    };
    if (c.description === c.date) c.description = -1;
    // One "Debit/Credit" column is the direction of the amount, not two amounts.
    if (c.debit !== -1 && c.debit === c.credit) { c.debit = -1; c.credit = -1; }
    if (c.date !== -1 && (c.amount !== -1 || c.debit !== -1 || c.credit !== -1)) {
      const taken = new Set([c.date, c.description, c.amount, c.debit, c.credit]);
      for (const [k, names] of Object.entries(EXTRA)) {
        const j = findExact(header, names);
        c[k] = j !== -1 && !taken.has(j) ? j : -1;
        if (c[k] !== -1) taken.add(c[k]);
      }
      headerIdx = i; cols = c; break;
    }
  }
  if (!cols) throw new Error('Could not find the date and amount columns in this file.');
  const order = dateOrder(rows.slice(headerIdx + 1).map((r) => r[cols.date]));
  const cell = (r, k) => (cols[k] !== -1 ? normalize(r[cols[k]] || '').trim() : '');

  const items = [];
  let skipped = 0;
  let needsFx = 0;
  let lastItem = null;
  const headerKey = rows[headerIdx].join('|');
  for (const r of rows.slice(headerIdx + 1)) {
    const date = parseDate(r[cols.date] || '', order);
    if (!date) {
      // Banks such as ING and BT put the details (merchant, IBAN, …) on extra
      // rows under the transaction. Only the description column belongs to it;
      // page footers and repeated headers are ignored.
      const extra = cols.description !== -1 ? (r[cols.description] || '').trim() : '';
      if (lastItem && extra && r.join('|') !== headerKey && !/^(sold|total)/i.test(extra)) lastItem.raw.push(extra);
      else skipped += 1;
      continue;
    }
    let amount = NaN;
    if (cols.debit !== -1 || cols.credit !== -1) {
      const debit = cols.debit !== -1 ? parseAmount(r[cols.debit]) : NaN;
      const credit = cols.credit !== -1 ? parseAmount(r[cols.credit]) : NaN;
      if (Number.isFinite(debit) && debit !== 0) amount = -Math.abs(debit);
      else if (Number.isFinite(credit) && credit !== 0) amount = Math.abs(credit);
    }
    if (!Number.isFinite(amount) && cols.amount !== -1) {
      amount = parseAmount(r[cols.amount]);
      const dir = cell(r, 'direction');
      if (DEBIT.has(dir)) amount = -Math.abs(amount);
      else if (CREDIT.has(dir)) amount = Math.abs(amount);
    }
    if (NOT_DONE.test(cell(r, 'state'))) { skipped += 1; lastItem = null; continue; }
    const fee = cols.fee !== -1 ? Math.abs(parseAmount(r[cols.fee])) : NaN;
    if (Number.isFinite(fee) && fee > 0) amount = (Number.isFinite(amount) ? amount : 0) - fee;
    if (!Number.isFinite(amount) || round2(amount) === 0) { skipped += 1; continue; }
    const description = (cols.description !== -1 ? r[cols.description] : '') || r.filter((c, i) => i !== cols.date && Number.isNaN(parseAmount(c))).join(' ');
    lastItem = {
      date,
      type: amount > 0 ? 'income' : 'expense',
      amount: round2(Math.abs(amount)),
      raw: [description.replace(/\s+/g, ' ').trim()],
    };
    const currency = cell(r, 'currency');
    if (!RON.has(currency)) {
      // Not converted: the amount is in `originalCurrency`; the UI must warn.
      Object.assign(lastItem, { needsFx: true, originalAmount: lastItem.amount, originalCurrency: currency.toUpperCase().slice(0, 3) });
      needsFx += 1;
    }
    items.push(lastItem);
  }
  // "Cumparare POS" + "Tranzactie la:KAUFLAND 1270 ORADEA" → description "KAUFLAND 1270 ORADEA",
  // with the full bank text kept as the note.
  for (const it of items) {
    const full = it.raw.filter(Boolean).join(', ').replace(/\s+/g, ' ');
    const merchant = it.raw.length > 1 ? extractMerchant(it.raw.slice(1).join(', ')) : '';
    it.description = (merchant && merchant !== it.raw.slice(1).join(', ') ? merchant : it.raw[0] || full).slice(0, 140) || 'Imported';
    it.note = full !== it.description ? full.slice(0, 280) : '';
    delete it.raw;
  }
  return { items, skipped, needsFx, columns: cols };
}
