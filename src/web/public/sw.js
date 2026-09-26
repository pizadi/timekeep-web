// Service worker (FR-U6): app-shell caching ONLY — v1 is not offline-first
// (§2.5): mutations require connectivity; /api is always network-first.
const SHELL = 'tk-shell-v2'; // bump on shell-shape changes (audit: 'v1' never changed)
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/favicon.svg', '/theme-boot.js', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // never cache API

  // hashed build assets: cache-first
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ??
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // navigation: network-first with shell fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  }
});
