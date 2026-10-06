// Bank statement CSV import. Works with the CSV exports from Romanian banks
// (BT, BCR, ING, Raiffeisen, BRD, Revolut) and generic files: it finds the
// header row, guesses the date / description / amount (or debit + credit)
// columns and understands Romanian number and date formats.

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

export function parseDate(input) {
  const s = normalize(input);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) return iso(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
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

/**
 * Returns { items: [{date, type, amount, description}], columns, skipped }.
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
    if (c.date !== -1 && (c.amount !== -1 || c.debit !== -1 || c.credit !== -1)) { headerIdx = i; cols = c; break; }
  }
  if (!cols) throw new Error('Could not find the date and amount columns in this file.');

  const items = [];
  let skipped = 0;
  let lastItem = null;
  const headerKey = rows[headerIdx].join('|');
  for (const r of rows.slice(headerIdx + 1)) {
    const date = parseDate(r[cols.date] || '');
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
    if (!Number.isFinite(amount) && cols.amount !== -1) amount = parseAmount(r[cols.amount]);
    if (!Number.isFinite(amount) || amount === 0) { skipped += 1; continue; }
    const description = (cols.description !== -1 ? r[cols.description] : '') || r.filter((c, i) => i !== cols.date && Number.isNaN(parseAmount(c))).join(' ');
    lastItem = {
      date,
      type: amount > 0 ? 'income' : 'expense',
      amount: round2(Math.abs(amount)),
      raw: [description.replace(/\s+/g, ' ').trim()],
    };
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
  return { items, skipped, columns: cols };
}
