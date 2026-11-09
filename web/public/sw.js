// Conference Caddie service worker: the offline mode.
//
// The app registers this file as /sw.js?build={id}, where the id comes from the hashed name of the
// app's entry script, so every build has its own caches and a new build replaces this worker.
//
// - The app shell (index.html, the hashed assets it references, the manifest, the pre-paint theme
//   script and the icons) is precached at install. Navigations are network-first and fall back to
//   the cached index.html; /assets/* files are cache-first, and any asset missed at install is
//   cached the first time it loads.
// - GET /api/conferences, GET /api/schedule and the full topic list (GET /api/topics without a
//   query) are network-first and fall back to the cached copy when the network fails.
// - Nothing else is cached. /api/people/* (matches, people search, blocks), /api/circles/*,
//   /api/presence, /api/meet/* (asks, the inbox and meets), /api/recommendations, searches and every
//   non-GET request always go to the network, so no profile, presence or meet data is ever stored.
// - At activation, the data cache of an older build is copied into this build's data cache, so a
//   saved schedule survives an update, and every older cache is then deleted.

const BUILD = (new URL(self.location.href).searchParams.get('build') || 'dev').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const PREFIX = 'caddie-';
const SHELL_CACHE = `${PREFIX}shell-${BUILD}`;
const DATA_CACHE = `${PREFIX}data-${BUILD}`;
const STATIC_FILES = [
  '/manifest.webmanifest',
  '/theme-init.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];
const NEVER_CACHE = /^\/api\/(people|circles|presence|meet|recommendations)(\/|$)/;

function isCachedApi(url) {
  if (NEVER_CACHE.test(url.pathname)) return false;
  if (url.pathname === '/api/conferences' || url.pathname === '/api/schedule') return true;
  return url.pathname === '/api/topics' && !url.searchParams.get('q');
}

// The /assets/ files that a text file references, such as the entry script and stylesheet in
// index.html and the chunks the entry script preloads.
function assetRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(/\/?assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2?|png|svg|webp)/g)) {
    out.add(m[0].startsWith('/') ? m[0] : `/${m[0]}`);
  }
  return [...out];
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const index = await fetch('/index.html', { cache: 'reload' });
  if (!index.ok) throw new Error('index.html could not be fetched');
  const html = await index.clone().text();
  await cache.put('/index.html', index);
  const assets = assetRefs(html);
  // The entry scripts and stylesheets can name further chunks; one level of that is enough here,
  // because anything missed is cached the first time it loads.
  const nested = [];
  for (const path of assets) {
    const res = await fetch(path, { cache: 'reload' });
    if (!res.ok) continue;
    if (/\.(js|css)$/.test(path)) nested.push(...assetRefs(await res.clone().text()));
    await cache.put(path, res);
  }
  const rest = [...new Set([...nested.filter((p) => !assets.includes(p)), ...STATIC_FILES])];
  await Promise.all(
    rest.map(async (path) => {
      try {
        const res = await fetch(path, { cache: 'reload' });
        if (res.ok) await cache.put(path, res);
      } catch {
        // A missing icon or chunk does not stop the install; it is cached on first use.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
      const data = await caches.open(DATA_CACHE);
      for (const name of names) {
        if (!name.startsWith(`${PREFIX}data-`) || name === DATA_CACHE) continue;
        const old = await caches.open(name);
        for (const req of await old.keys()) {
          if (await data.match(req, { ignoreVary: true })) continue;
          const res = await old.match(req, { ignoreVary: true });
          if (res) await data.put(req, res);
        }
      }
      await Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== DATA_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) {
      await cache.put(request, res.clone());
      return res;
    }
    return (await cache.match(request, { ignoreVary: true })) || res;
  } catch {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'You are offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    // Only the app's own page is kept; the server answers every app route with index.html.
    if (res.ok && (res.headers.get('Content-Type') || '').startsWith('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/index.html', res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match('/index.html', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (isCachedApi(url)) event.respondWith(networkFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || STATIC_FILES.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

// The page asks for a conference's schedule and the conference list to be saved when it is not
// yet controlled by this worker, as on the very first visit. Only those two routes are accepted.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'save' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    Promise.all(
      data.urls.slice(0, 4).map(async (raw) => {
        try {
          const url = new URL(raw, self.location.origin);
          if (url.origin !== self.location.origin || !isCachedApi(url) || url.pathname === '/api/topics') return;
          const res = await fetch(url.href);
          if (res.ok) await (await caches.open(DATA_CACHE)).put(url.href, res);
        } catch {
          // The next online load tries again.
        }
      }),
    ),
  );
});
