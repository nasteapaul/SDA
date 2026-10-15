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
  const p = m?.plan;
  if (!p) return null;
  const cur = esc(m.currency);
  const num = (x) => x.toFixed(m.price >= 1 ? 2 : 4);
  return [
    `<b>Plan:</b> cumpără până la ${num(p.buyUpTo)} ${cur}`,
    `🎯 Vinde la ${num(p.target)} (${pct(p.target / m.price - 1)}) · 🛑 Stop-loss ${num(p.stop)} (${pct(p.stop / m.price - 1)})`,
    `Dacă în ~4 săptămâni n-a atins niciuna, închide.`,
    p.stretched ? '⚠️ A urcat deja mult azi: nu cumpăra peste nivelul de mai sus, mai bine aștepți o retragere.' : null,
  ].filter(Boolean).join('\n');
}

export function formatSignal(s) {
  const icon = s.score >= 8 ? '🟢🟢' : '🟢';
  const lines = [
    `${icon} <b>${esc(s.company)}</b> · XTB: <code>${esc(s.listing.xtb)}</code> · scor ${s.score}`,
    esc(s.title),
    '',
    s.summary ? esc(s.summary) : null,
    `<i>De ce:</i> ${esc(s.reasons.join('; '))}`,
    s.market ? `Preț ${s.market.price?.toFixed(2)} ${esc(s.market.currency)}, azi ${pct(s.market.change1d)}${s.market.volumeRatio ? `, volum ${s.market.volumeRatio.toFixed(1)}× media` : ''}` : null,
    formatPlan(s.market),
    `<a href="${esc(s.link)}">Sursa (${esc(s.source)})</a>`,
    '',
    '<i>Doar informație, nu sfat de investiții. Verifică sursa înainte să cumperi.</i>',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
