// ============================================================
// SICKLESTRONG SERVICE WORKER
// Enables offline access + installability
// ============================================================
// Bump this version with every deploy to force cache refresh:
const CACHE_VERSION = 'sicklestrong-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── INSTALL: cache the app shell ─────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: network-first for the app, cache fallback offline ─
// Network-first means families always get the newest version
// when online, but the app still opens with no connection.
self.addEventListener('fetch', (event) => {
  // Only handle GET requests from our own origin
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Got fresh copy — update the cache
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => {
          cache.put(event.request, copy);
        });
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || caches.match('/index.html');
        });
      })
  );
});
