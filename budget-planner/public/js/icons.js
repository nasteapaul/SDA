// Line icons, drawn for this app on a 24 × 24 grid (no third-party set).
// Every icon is stroked with currentColor, so it takes the colour of its text.
//   icon('bank')                      → <svg class="icon" …>
//   icon('plus', { size: 18 })
//   iconTile('card', { tone: 'warning' }) → icon in a 32px tinted square (.ico-tile)
// index.html repeats the nav icons inline with the same paths.

const PATHS = {
  overview: '<rect x="3.5" y="3.5" width="7" height="9" rx="2"/><rect x="13.5" y="3.5" width="7" height="5" rx="2"/><rect x="13.5" y="11.5" width="7" height="9" rx="2"/><rect x="3.5" y="15.5" width="7" height="5" rx="2"/>',
  transactions: '<path d="M7.5 3.5 4 7l3.5 3.5M4 7h12.5M16.5 13.5 20 17l-3.5 3.5M20 17H7.5"/>',
  goals: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  plan: '<path d="M3.5 17 9 11.5l4 4 7.5-7.5"/><path d="M15 8h5.5v5.5"/>',
  settings: '<path d="M10.08 4.85 10.33 2.55H13.67L13.92 4.85A7.4 7.4 0 0 1 15.7 5.59L17.51 4.14 19.86 6.49 18.41 8.3A7.4 7.4 0 0 1 19.15 10.08L21.45 10.33V13.67L19.15 13.92A7.4 7.4 0 0 1 18.41 15.7L19.86 17.51 17.51 19.86 15.7 18.41A7.4 7.4 0 0 1 13.92 19.15L13.67 21.45H10.33L10.08 19.15A7.4 7.4 0 0 1 8.3 18.41L6.49 19.86 4.14 17.51 5.59 15.7A7.4 7.4 0 0 1 4.85 13.92L2.55 13.67V10.33L4.85 10.08A7.4 7.4 0 0 1 5.59 8.3L4.14 6.49 6.49 4.14 8.3 5.59A7.4 7.4 0 0 1 10.08 4.85Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bank: '<path d="M3.5 9 12 4l8.5 5"/><path d="M5 9.5h14M6.5 12v5M10 12v5M14 12v5M17.5 12v5M4 20h16"/>',
  upload: '<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4 14.5v3.5A2 2 0 0 0 6 20h12a2 2 0 0 0 2-2v-3.5"/>',
  download: '<path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M4 14.5v3.5A2 2 0 0 0 6 20h12a2 2 0 0 0 2-2v-3.5"/>',
  tag: '<path d="M3.5 12.1V5a1.5 1.5 0 0 1 1.5-1.5h7.1l8.2 8.2a1.6 1.6 0 0 1 0 2.3l-6.6 6.6a1.6 1.6 0 0 1-2.3 0z"/><circle cx="8" cy="8" r="1.5"/>',
  rules: '<circle cx="6" cy="5.5" r="2"/><path d="M6 7.5V12a3.5 3.5 0 0 0 3.5 3.5H19M15.5 12 19 15.5 15.5 19"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l.9 12.1A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.9L18 7M10 11v5.5M14 11v5.5"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6.2 7.2L4.5 9M4.5 4.5V9H9"/><path d="M4.5 13a7.5 7.5 0 0 0 13.3 3.8l1.7-1.8M19.5 19.5V15H15"/>',
  'chevron-right': '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  'chevron-left': '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  'chevron-down': '<path d="m5.5 9 6.5 6.5L18.5 9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M10.3 4.4 2.9 17.3A2 2 0 0 0 4.6 20.3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5V14M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6.5 15h4"/>',
  wallet: '<path d="M18.5 7.5V6a2 2 0 0 0-2-2H6a2.5 2.5 0 0 0 0 5h13a1.5 1.5 0 0 1 1.5 1.5V18a2 2 0 0 1-2 2H6a2.5 2.5 0 0 1-2.5-2.5v-11"/><path d="M16.5 14.5h.01"/>',
  savings: '<path d="M20 10.5h-1.2a6.6 6.6 0 0 0-2.3-3V4.5l-2.6 1.8A8.6 8.6 0 0 0 11.5 6C7.4 6 4 8.7 4 12c0 2.1 1.3 3.9 3.3 5V20H10v-1.6a8 8 0 0 0 3 0V20h2.7v-3a6.4 6.4 0 0 0 2.1-2.5H20z"/><path d="M4 12c-.9 0-1.5-.6-1.5-1.5M9.5 8.8h3M15.5 10.3h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20l1-4.5L15.8 4.7a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="m14 6.5 3 3"/>',
  logout: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/><path d="m15 8 4 4-4 4M19 12H9.5"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  'arrow-up-right': '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
  'arrow-down-left': '<path d="M17 7 7 17M15.5 17H7V8.5"/>',
  // extras for screen headers and rows
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  pie: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z"/><path d="M15 3.9A8.5 8.5 0 0 1 20.1 9H15z"/>',
  bars: '<path d="M4 20h16M7 16.5V11M12 16.5V6M17 16.5v-3.5"/>',
  repeat: '<path d="M17 3.5 20 6.5l-3 3M20 6.5H8A4 4 0 0 0 4 10.5v1M7 20.5l-3-3 3-3M4 17.5h12a4 4 0 0 0 4-4v-1"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3.5a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3.5z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  flag: '<path d="M5 21V4.5M5 4.5h11l-2 4 2 4H5"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  // alerts, bank check, split, report, meal vouchers
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  split: '<path d="M12 21v-7L5 7M12 14l7-7"/><path d="M5 11V7h4M19 11V7h-4"/>',
  print: '<path d="M7 8.5V3.5h10v5"/><rect x="3.5" y="8.5" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
};

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

const attr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Inline SVG string for a named icon ('' for an unknown name). Decorative: aria-hidden. */
export function icon(name, { size = 20, cls = '' } = {}) {
  const body = PATHS[name];
  if (!body) return '';
  const px = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 20;
  return `<svg class="icon${cls ? ` ${attr(cls)}` : ''}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

const TONES = new Set(['', 'accent', 'neutral', 'good', 'warning', 'critical']);

/** Icon in a rounded tinted square (32px; cls 'lg' = 40px). tone: accent (default) | neutral | good | warning | critical. */
export function iconTile(name, { tone = '', size = 18, cls = '' } = {}) {
  const t = TONES.has(tone) ? tone : '';
  return `<span class="ico-tile${t ? ` ${t}` : ''}${cls ? ` ${attr(cls)}` : ''}" aria-hidden="true">${icon(name, { size })}</span>`;
}
