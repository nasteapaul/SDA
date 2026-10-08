import { journalStats } from './journal.js';

const pct = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

// Sunday report: is any of this actually working?
export function weeklyReport(state, now) {
  const week = state.journal.filter((e) => now - e.time < 7 * 86400e3);
  const lines = [`📊 <b>Raport săptămânal</b>`, `Alerte săptămâna asta: ${week.length}. Total în jurnal: ${state.journal.length}.`, ''];
  for (const s of journalStats(state.journal)) {
    if (!s.n) continue;
    lines.push(`După ${s.h} zile (${s.n} alerte): medie ${pct(s.avg)}, față de piață ${pct(s.excess)}, pe plus ${Math.round(s.winRate * 100)}%.`);
  }
  if (lines.length === 3) lines.push('Încă nu sunt destule date ca să judecăm semnalele.');
  lines.push('', '<i>„Față de piață” compară cu indicele (S&amp;P 500 sau STOXX 600) din aceeași perioadă. Abia peste câteva zeci de alerte cifrele încep să însemne ceva.</i>');
  return lines.join('\n');
}

export function reportDue(state, now) {
  const d = new Date(now);
  const week = `${d.getUTCFullYear()}-${Math.floor((now / 86400e3 + 4) / 7)}`;
  if (d.getUTCDay() !== 0 || d.getUTCHours() < 17 || state.reportWeek === week) return false;
  state.reportWeek = week;
  return true;
}
