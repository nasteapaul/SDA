// App-shell cache: instant start from cache, refreshed in the background.
const VERSION = 'magistrala-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css', 'vendor/three.module.min.js',
  'js/app.js', 'js/scene.js', 'js/fx.js', 'js/net.js', 'js/local.js',
  'js/engine/engine.js', 'js/engine/map.js', 'js/engine/rng.js', 'js/engine/bot.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/ws')) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
