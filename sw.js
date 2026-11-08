// Liwliwa Connect — Service Worker
//
// WHAT THIS DOES
// - Lets the site be "installed" and opened without internet (offline mode).
// - Caches the app shell (pages, CSS, JS, icons) so repeat visits are instant.
// - Never caches the Google Apps Script API — that's live business data and
//   must always come from the network, never a stale copy.
//
// HOW TO UPDATE THE CACHE AFTER EDITING A FILE
// Every time you change css/style.css, js/main.js, or any .html file and
// redeploy, bump CACHE_VERSION below (v1 -> v2 -> v3 ...). That's the only
// step needed — this file auto-deletes the old cache and re-downloads
// everything fresh the next time someone opens the site. If you forget to
// bump it, people may keep seeing the old version until the cache expires
// on its own.

const CACHE_VERSION = 'v17'; // bumped: page navigation is now cache-first-with-background-refresh instead of network-first — fixes slow loads when the app is installed
const CACHE_NAME = `liwliwa-connect-${CACHE_VERSION}`;

// The "app shell" — everything needed for the site to load and look right
// with zero internet connection. Keep this list in sync with the files in
// the project (README lists them all).
const PRECACHE_URLS = [
  './',
  'index.html',
  'guest-home.html',
  'resorts.html',
  'restaurants.html',
  'cafes.html',
  'surf-schools.html',
  'activities.html',
  'business.html',
  'map.html',
  'register.html',
  'vendor-register.html',
  'admin.html',
  'dashboard.html',
  'for-business-owners.html',
  'nearby-essentials.html',
  'food-finder.html',
  'parking-guide.html',
  'favorites.html',
  '404.html',
  '500.html',
  'offline.html',
  'css/style.css',
  'js/main.js',
  'images/hero-beach.webp',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// Never touch the live backend (Google Apps Script) with the cache — listing
// data, login, registration, and admin actions must always be real-time.
const NEVER_CACHE_HOSTS = ['script.google.com', 'script.googleusercontent.com'];

// ---------- INSTALL ----------
// Downloads and caches the app shell as soon as the new service worker is
// found. skipWaiting() means an update takes over immediately instead of
// waiting for every open tab to be closed first.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ---------- ACTIVATE ----------
// Deletes any caches left over from a previous CACHE_VERSION, then takes
// control of already-open tabs right away.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('liwliwa-connect-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only ever intercept GET requests. POST/PUT etc. (form submissions,
  // registration, admin approvals) must always go straight to the network.
  if (request.method !== 'GET') return;

  // Let the live backend through untouched — no caching, no offline fallback.
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Page navigations (clicking a link, typing a URL, opening the installed
  // app): THIS WAS THE MAIN CAUSE OF SLOW LOADS, ESPECIALLY WHEN INSTALLED.
  // It used to be network-first — every single page open waited for a full
  // round-trip to the server before showing anything at all, even though a
  // perfectly good cached copy of that exact page was sitting right there.
  // On a slow or spotty beach-area connection, that wait is the whole
  // "installed app feels sluggish" complaint right there.
  //
  // Now it's the same instant-cache-first-with-background-refresh strategy
  // as every other asset below: show the cached page immediately if one
  // exists, then quietly fetch a fresh copy in the background for next
  // time. This is safe here because the actual business data (listings,
  // events, analytics, etc.) is never part of this cache — it's always
  // fetched fresh from Apps Script by the page's own JS after it loads
  // (see NEVER_CACHE_HOSTS above) — only the surrounding page shell
  // (HTML/layout) is cached, and that barely ever changes.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached || caches.match('offline.html'));

        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else (CSS, JS, images, fonts, CDN scripts like Tailwind/
  // Lucide/Leaflet): serve the cached copy instantly if we have one, and
  // quietly refresh the cache in the background so the next visit has the
  // newest version. If nothing's cached yet, fetch from the network and
  // cache it for next time.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          // Only cache valid, cacheable responses (basic same-origin OK,
          // and opaque no-cors CDN responses are cached as-is).
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached — nothing we can do

      return cached || networkFetch;
    })
  );
});
