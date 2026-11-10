// Conference Caddie service worker: the offline mode.
//
// The app registers this file as {base}sw.js?build={id}&api={origin}. The id comes from the hashed
// name of the app's entry script, so every build has its own caches and a new build replaces this
// worker. {base} is where the app is served ("/" on Cloud Run, "/conferenceCaddie/" on GitHub
// Pages) and is read from this worker's scope; {origin} is the API's origin when the API lives on
// another origin than the app, as on Pages (it is left out when they are the same).
//
// - The app shell (index.html, the hashed assets it references, the manifest, the pre-paint theme
//   script and the icons) is precached at install. Navigations are network-first and fall back to
//   the cached index.html; /assets/* files are cache-first, and any asset missed at install is
//   cached the first time it loads.
// - GET /api/conferences, GET /api/schedule and the full topic list (GET /api/topics without a
//   query), on the API origin, are network-first and fall back to the cached copy when the
//   network fails. Every other cross-origin request is left alone.
// - Nothing else is cached. /api/people/* (matches, people search, blocks), /api/circles/*,
//   /api/presence, /api/meet/* (asks, the inbox and meets), /api/recommendations, searches and every
//   non-GET request always go to the network, so no profile, presence or meet data is ever stored.
// - At activation, the data cache of an older build is copied into this build's data cache, so a
//   saved schedule survives an update, and every older cache is then deleted.
// - Web Push: a push event shows its payload as a notification ("Conference Caddie" with the
//   nudge sentence; the payload never carries a name). A tap focuses the app, or opens it, at the
//   payload's url (the People tab with "Around now" on). The payload url is a path such as
//   /e/{slug}#/people?around=1 and is resolved against the scope, so one server payload works at
//   any base.

const PARAMS = new URL(self.location.href).searchParams;
const BUILD = (PARAMS.get('build') || 'dev').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const PREFIX = 'caddie-';
const SHELL_CACHE = `${PREFIX}shell-${BUILD}`;
const DATA_CACHE = `${PREFIX}data-${BUILD}`;
// The scope is the app's own URL, for example https://host/conferenceCaddie/, and BASE is its path.
const SCOPE = self.registration.scope;
const BASE = new URL(SCOPE).pathname;
const INDEX = `${BASE}index.html`;
// The API origin: the `api` query parameter when the API is on another origin, else this one.
const API_ORIGIN = (() => {
  try {
    const raw = PARAMS.get('api');
    return raw ? new URL(raw).origin : self.location.origin;
  } catch {
    return self.location.origin;
  }
})();
const STATIC_FILES = [
  'manifest.webmanifest',
  'theme-init.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
].map((f) => BASE + f);
const NEVER_CACHE = /^\/api\/(people|circles|presence|meet|recommendations)(\/|$)/;

function isApiRequest(url) {
  return url.origin === API_ORIGIN && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
}

function isCachedApi(url) {
  if (NEVER_CACHE.test(url.pathname)) return false;
  if (url.pathname === '/api/conferences' || url.pathname === '/api/schedule') return true;
  return url.pathname === '/api/topics' && !url.searchParams.get('q');
}

// The assets/ files that a text file references, such as the entry script and stylesheet in
// index.html and the chunks the entry script preloads, as paths under the base.
function assetRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2?|png|svg|webp|mjs)/g)) {
    out.add(BASE + m[0]);
  }
  return [...out];
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const index = await fetch(INDEX, { cache: 'reload' });
  if (!index.ok) throw new Error('index.html could not be fetched');
  const html = await index.clone().text();
  await cache.put(INDEX, index);
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
      await cache.put(INDEX, res.clone());
    }
    // A static host without a server-side route answers an app path such as /e/{slug} with its
    // 404 page, which is the same app; the cached copy is served instead, with a normal status.
    if (res.status === 404 && (res.headers.get('Content-Type') || '').startsWith('text/html')) {
      const cached = await caches.match(INDEX, { cacheName: SHELL_CACHE });
      if (cached) return cached;
    }
    return res;
  } catch (err) {
    const cached = await caches.match(INDEX, { cacheName: SHELL_CACHE });
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
  // Requests to the API origin are looked at even when it is another origin than the app's.
  if (isApiRequest(url)) {
    if (isCachedApi(url)) event.respondWith(networkFirst(request));
    return;
  }
  // Every other cross-origin request is none of this worker's business.
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith(`${BASE}assets/`) || STATIC_FILES.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

// The page asks for a conference's schedule and the conference list to be saved when it is not
// yet controlled by this worker, as on the very first visit. Only those two routes, on the API
// origin, are accepted.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'save' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    Promise.all(
      data.urls.slice(0, 4).map(async (raw) => {
        try {
          const url = new URL(raw, API_ORIGIN);
          if (!isApiRequest(url) || !isCachedApi(url) || url.pathname === '/api/topics') return;
          const res = await fetch(url.href);
          if (res.ok) await (await caches.open(DATA_CACHE)).put(url.href, res);
        } catch {
          // The next online load tries again.
        }
      }),
    ),
  );
});

// ---------------------------------------------------------------------------------------------
// Web Push nudges. The payload is { title, body, data: { url } }, built by the server's nudge.mjs.

const NUDGE_TAG = 'caddie-nudge';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Conference Caddie';
  const body = typeof payload.body === 'string' ? payload.body : '';
  // The payload url is a path from the site root, such as /e/{slug}#/people?around=1; it is
  // resolved against the scope, which is the root on Cloud Run and the app's folder on Pages.
  const path = typeof payload.data?.url === 'string' && payload.data.url.startsWith('/') ? payload.data.url : '/';
  const url = new URL(path.replace(/^\/+/, ''), SCOPE).href;
  const icon = new URL('icons/icon-192.png', SCOPE).href;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: icon,
      tag: NUDGE_TAG,
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || SCOPE, SCOPE).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) await open.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
