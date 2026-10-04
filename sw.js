const CACHE_VERSION = 'housey-v3';
const NETWORK_TIMEOUT_MS = 3000;
const SLOW_NETWORK_MEMORY_MS = 60_000;

// './index.html' is deliberately not listed: hosts such as Cloudflare Pages
// redirect it to './', and a cached redirect response cannot be used to
// answer a navigation (the installed app would fail to open).
const APP_SHELL = [
  './',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/ui.js',
  './js/game.js',
  './js/ocr.js',
  './js/ticket-rules.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const API_PREFIX = new URL('api/', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

function cacheable(response) {
  return response.status === 200 && response.type === 'basic' && !response.redirected;
}

// Network first, so a new deployment is picked up on the next load without
// anyone having to bump a version; the cache only answers when the network is
// slow or gone (a party venue with bad signal). Without a cached copy the
// request just waits for the network.
//
// The app loads a chain of scripts, so waiting out the timeout on every file
// would multiply it. After one slow or failed request the worker answers from
// the cache straight away for a while and refreshes in the background.
let networkSlowUntil = 0;

function remember(request, response) {
  if (!cacheable(response)) return;
  const copy = response.clone();
  caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
}

async function networkFirst(event) {
  const { request } = event;
  const cached = await caches.match(request);

  if (cached && Date.now() < networkSlowUntil) {
    event.waitUntil(fetch(request).then((response) => remember(request, response)).catch(() => {}));
    return cached;
  }

  try {
    const fetched = fetch(request);
    const response = cached
      ? await Promise.race([
        fetched,
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), NETWORK_TIMEOUT_MS)),
      ])
      : await fetched;
    remember(request, response);
    return response;
  } catch (err) {
    if (cached) {
      networkSlowUntil = Date.now() + SLOW_NETWORK_MEMORY_MS;
      return cached;
    }
    if (request.mode === 'navigate') {
      const shell = await caches.match('./');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API_PREFIX)) return;

  event.respondWith(networkFirst(event));
});
