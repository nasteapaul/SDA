// Telegram Bot API: free push notifications on the phone.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function send({ token, chatId, fetchImpl = fetch }, html) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  // Never echo the URL: it contains the bot token.
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

const pct = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

export function formatPlan(m) {
  if (!m?.price) return '💵 Preț acum: necunoscut (nu am primit date de preț), deci fără niveluri de cumpărare.';
  const cur = esc(m.currency);
  const num = (x) => x.toFixed(m.price >= 1 ? 2 : 4);
  const p = m.plan;
  if (!p) return `💵 Preț acum: <b>${num(m.price)} ${cur}</b> (prea puține date ca să calculez nivelurile).`;
  return [
    `💵 Preț acum: <b>${num(m.price)} ${cur}</b>`,
    `✅ Cumpără până la: <b>${num(p.buyUpTo)}</b>`,
    `🎯 Vinde când ajunge la: <b>${num(p.target)}</b> (${pct(p.target / m.price - 1)})`,
    `🛑 Stop-loss: <b>${num(p.stop)}</b> (${pct(p.stop / m.price - 1)})`,
    '⏳ Dacă în ~4 săptămâni n-a atins nici ținta, nici stopul, vinde.',
    p.stretched ? '⚠️ A urcat deja mult azi: nu cumpăra peste nivelul de mai sus, mai bine aștepți o scădere.' : null,
  ].filter(Boolean).join('\n');
}

// Why the event matters, in plain words.
export function explain(s) {
  if (s.why) return s.why;
  if (s.source === 'SEC 13D') {
    const activist = s.reasons.some((r) => /activist/.test(r));
    const sale = s.reasons.some((r) => /scopul declarat/.test(r));
    return [
      'Un fond a cumpărat peste 5% din firmă și vrea să schimbe lucruri acolo, nu doar să țină acțiunile.',
      activist ? 'E un fond cunoscut pentru asta: de obicei forțează vânzarea firmei, schimbări în conducere sau răscumpărări, iar prețul tinde să crească în lunile următoare.' : null,
      sale ? 'A spus deschis că vrea ca firma să fie vândută sau să-și caute un cumpărător, iar un cumpărător plătește de obicei peste prețul de acum.' : null,
    ].filter(Boolean).join(' ');
  }
  if (s.source === 'Reddit') return 'Lumea a început brusc să vorbească mult despre acțiunea asta pe forumurile de investiții. Uneori asta împinge prețul în sus câteva zile, dar e și cel mai riscant tip de semnal: intră doar cu stop-loss.';
  if (s.source === 'SEC Form 4') return 'Directorii firmei au cumpărat acțiuni cu banii lor. Ei știu cel mai bine cum merge firma, așa că de obicei e un semn bun.' + (s.reasons?.length ? ` Pe scurt: ${s.reasons.join('; ')}.` : '');
  return `Motiv: ${s.reasons.join('; ')}.`;
}

export function formatSignal(s) {
  const strength = s.score >= 8 ? 'semnal puternic' : 'semnal mediu';
  const lines = [
    `${s.score >= 8 ? '🟢🟢' : '🟢'} <b>${esc(s.company)}</b> · în XTB: <code>${esc(s.listing.xtb)}</code>${s.xtbUnchecked ? ' (n-am putut verifica dacă e în XTB)' : ''} · ${strength}`,
    esc(s.title),
    '',
    `<b>De ce merită:</b> ${esc(explain(s))}`,
    s.summary ? `<i>${esc(s.summary)}</i>` : null,
    '',
    formatPlan(s.market),
    '',
    `<a href="${esc(s.link)}">Sursa</a>`,
    '<i>Doar informație, nu sfat de investiții. Pune stop-loss-ul în XTB imediat după cumpărare.</i>',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
