// Service worker: keeps the app shell available offline (e.g. away from home
// Wi-Fi). Data itself is cached by the app in localStorage; API calls are
// never cached here. Network-first so updates show up immediately at home.
const CACHE = 'budget-shell-v3';
// Every module the app imports, or the first offline start fails on the missing one.
const SHELL = [
  '/', '/index.html', '/app.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/js/app.js', '/js/data.js', '/js/charts.js',
  '/js/shared/money.js', '/js/shared/categories.js', '/js/shared/planner.js', '/js/shared/csv.js',
  '/js/shared/accounts.js', '/js/shared/own.js', '/js/shared/periods.js', '/js/shared/ledger.js', '/js/shared/dedupe.js',
  '/js/shared/refunds.js', '/js/shared/reconcile.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/bank/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
