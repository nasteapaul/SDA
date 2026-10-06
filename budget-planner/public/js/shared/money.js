// Money and date helpers shared by the server and the browser.
// All amounts are stored as positive numbers in RON with 2 decimals.

export const CURRENCY = 'RON';
export const LOCALE = 'ro-RO';

const fmt = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtShort = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  maximumFractionDigits: 0,
});

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function formatRON(n, { short = false, sign = false } = {}) {
  const v = Number(n) || 0;
  const s = (short ? fmtShort : fmt).format(Math.abs(v));
  if (v < 0) return `−${s}`;
  if (sign && v > 0) return `+${s}`;
  return s;
}

// Accepts "1.234,56", "1,234.56", "1234.56", "-12,5", "12 345,00 lei", "2.500"
// (dot thousands), "12-" (trailing minus), "12,50 DR" (debit) and "12 CR" etc.
export function parseAmount(input) {
  if (typeof input === 'number') return input;
  let s = String(input ?? '').trim().replace(/\s|lei|ron/gi, '');
  if (!s) return NaN;
  let neg = /^[-−(]/.test(s) || /[-−)]$/.test(s);
  const dc = s.match(/(dr|db|cr)\.?$/i);
  if (dc) neg = dc[1].toLowerCase() !== 'cr';
  s = s.replace(/[^\d.,]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "2.500" = 2500: RON amounts never have 3 decimals
  } else if (/^\d{1,3}(,\d{3}){2,}$/.test(s)) {
    s = s.replace(/,/g, ''); // "1,234,567"
  } else if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, '.');
  }
  const n = parseFloat(s);
  return neg ? -n : n;
}

export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function monthKey(dateISO) {
  return String(dateISO).slice(0, 7);
}

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key, opts = { month: 'short', year: '2-digit' }) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', opts);
}

export function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Whole months from `fromISO` until `toISO` (at least 1 when the target is in the future).
export function monthsBetween(fromISO, toISO) {
  const a = new Date(fromISO);
  const b = new Date(toISO);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
    + (b.getDate() - a.getDate()) / 30.44;
  return Math.max(months, 0);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) {
    try { return globalThis.crypto.randomUUID(); } catch { /* insecure context */ }
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
