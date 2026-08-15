// ============================================================
// SICKLESTRONG SERVICE WORKER
// Enables offline access + installability
// ============================================================
// Bump this version with every deploy to force cache refresh:
const CACHE_VERSION = 'sicklestrong-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// The app cannot start without this: index.html creates the Supabase client at
// the top level of its main script. Left uncached, opening the installed app
// offline loaded the page from cache, failed to fetch this, and blanked the
// screen. Cross-origin, so it needs handling separately from the app shell.
const VENDOR_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

// ── INSTALL: cache the app shell ─────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      // Best-effort: if the CDN is down while installing, don't fail the whole
      // install — the fetch handler will cache it on the first successful load.
      await Promise.all(
        VENDOR_ASSETS.map((url) =>
          cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
        )
      );
    })
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

  // Vendor scripts: cache-first, since a stale-but-working copy beats a blank
  // app. Refresh in the background so updates still land on the next open.
  if (VENDOR_ASSETS.some((asset) => event.request.url.startsWith(asset))) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

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
