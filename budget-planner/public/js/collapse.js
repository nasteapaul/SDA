// Collapsible sections for long lists, so nobody has to scroll forever.
// Each section remembers on this device whether you left it open or minimized.
const KEY = 'bp.collapsed';
let state = load();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: still works, just not remembered */ }
}

export function isOpen(key, defaultOpen = false) {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : defaultOpen;
}

/**
 * A minimizable section: header row (optional icon HTML, title, count badge, chevron) and the body.
 * `title`, `count`, `icon` and `body` are trusted HTML (escape user text before passing it).
 */
export function collapsible({ key, title, count = '', body = '', open = false, icon = '', cls = '' }) {
  return `<details class="collapse ${cls}" data-collapse="${key}"${isOpen(key, open) ? ' open' : ''}>`
    + `<summary class="collapse-head">${icon}<span class="collapse-title">${title}</span>`
    + `${count !== '' ? `<span class="badge">${count}</span>` : ''}`
    + '<span class="collapse-chev" aria-hidden="true"></span></summary>'
    + `<div class="collapse-body">${body}</div></details>`;
}

// One listener for every collapsible section on the page (toggle doesn't bubble: capture it).
document.addEventListener('toggle', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !el.matches('details[data-collapse]')) return;
  state[el.dataset.collapse] = el.open;
  save();
}, true);
