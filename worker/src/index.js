// The Conference Caddie API Worker (PLAN section 1.5). It stays thin: CORS, preflight, body caps,
// slug resolution, admin auth, health and the VAPID key, then exactly one Durable Object request
// per API call. All ranking, privacy gates and SQL run in the Durable Objects.
//
// Logging: one line per request with the method, a path template, the status and the duration.
// Never a body, a header value, query text, a profile field, a token or a secret.

import { ConferenceDO } from './conference.js';
import { DirectoryDO } from './directory.js';
import { CONFERENCE_ADMIN_PATHS } from './admin.js';
import { json, isPlainObject, SLUG_RE, dailyLimitResponse, isDailyLimitError } from './lib/http.js';
import { utcDay } from './lib/time.js';

export { ConferenceDO, DirectoryDO };

const DIRECTORY_TTL_MS = 300_000;
const EARLY_REFRESH_MS = 60_000;
const KB = 1024;
const CAP_SEARCH = 4 * KB;
const CAP_DEFAULT = 8 * KB;
const CAP_IMPORT = 1024 * KB;
const CAP_ADMIN = 4 * 1024 * KB;
const HEALTH_PER_MIN = 600;
const VAPID_PER_MIN = 60;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// ---------------------------------------------------------------------------------------------
// The routes a ConferenceDO serves, with where each finds its conference slug.
//   src: 'body' (a JSON body key), 'query' (?event=) or 'meet' (the meet id prefix)
//   style: which error messages today's server gives for a bad or unknown slug
//   origin: a present but foreign Origin gets 403 cross-origin request
//   cap: the body cap in bytes

const people = (src) => ({ src, key: 'event', style: 'people', origin: true });
const ROUTES = {
  '/api/search': { POST: { src: 'body', key: 'conference', style: 'search', origin: false, cap: CAP_SEARCH } },
  '/api/schedule': { GET: { src: 'query', key: 'event', style: 'schedule', origin: false } },
  '/api/related': { GET: { src: 'query', key: 'event', style: 'valid', origin: false } },
  '/api/topics': { GET: { src: 'query', key: 'event', style: 'valid', origin: false } },
  '/api/recommendations': { POST: { src: 'body', key: 'event', style: 'valid', origin: true } },
  '/api/topics/suggest': { POST: { src: 'body', key: 'event', style: 'valid', origin: true } },
  '/api/import/schedule': { POST: { src: 'body', key: 'event', style: 'valid', origin: true, cap: CAP_IMPORT } },
  '/api/import/github': { POST: { src: 'body', key: 'event', style: 'valid', origin: true } },
  '/api/circles/counts': { POST: people('body') },
  '/api/circles/members': { POST: people('body') },
  '/api/people/profile': { PUT: people('body'), DELETE: people('query') },
  '/api/people/matches': { POST: people('body') },
  '/api/people/block': { POST: people('body'), DELETE: people('body') },
  '/api/people/blocks': { GET: people('query') },
  '/api/people/report': { POST: people('body') },
  '/api/presence': { PUT: people('body'), DELETE: people('query') },
  '/api/presence/ble/rotate': { POST: people('body') },
  '/api/presence/sightings': { POST: people('body') },
  '/api/meet': { POST: people('body') },
  '/api/meet/inbox': { GET: people('query') },
  '/api/push/subscription': { PUT: people('body'), DELETE: people('body') },
};
const MEET_PATH_RE = /^\/api\/meet\/([A-Za-z0-9_-]{22})(?:\/(accept|decline|found|cancel|details))?$/;
const MEET_METHODS = { '': 'GET', accept: 'POST', decline: 'POST', found: 'POST', cancel: 'POST', details: 'PUT' };

const SLUG_ERRORS = {
  search: { type: 'conference must be a string', bad: 'conference is not available', unknown: 'conference is not available' },
  schedule: { type: 'event is not available', bad: 'event is not available', unknown: 'event is not available' },
  valid: { type: 'event must be a string', bad: 'event is not valid', unknown: 'event is not available' },
  people: { type: 'event must be a conference slug', bad: 'event must be a conference slug', unknown: 'conference is not available' },
};

class Reply extends Error {
  constructor(response) {
    super('reply');
    this.response = response;
  }
}
const reply = (status, body, headers) => new Reply(json(status, body, headers));

// ---------------------------------------------------------------------------------------------
// Isolate-level state: the directory cache and two small rate limits.

let directory = null; // { at, bySlug: Map, byPrefix: Map }
let directoryPending = null;
let lastEarlyRefresh = 0;
const buckets = new Map();

function take(key, perMin) {
  const now = Date.now();
  let bk = buckets.get(key);
  if (!bk) {
    if (buckets.size > 10_000) buckets.clear();
    bk = { tokens: perMin, at: now };
    buckets.set(key, bk);
  } else {
    bk.tokens = Math.min(perMin, bk.tokens + ((now - bk.at) * perMin) / 60_000);
    bk.at = now;
  }
  if (bk.tokens >= 1) {
    bk.tokens -= 1;
    return 0;
  }
  return Math.max(1, Math.ceil(((1 - bk.tokens) * 60_000) / perMin / 1000));
}

const directoryStub = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
const conferenceStub = (env, slug) => env.CONFERENCE.get(env.CONFERENCE.idFromName(slug));

async function fetchDirectory(env) {
  const res = await directoryStub(env).fetch('https://directory.internal/internal/routes');
  if (!res.ok) throw new Error('directory read failed');
  const { conferences } = await res.json();
  const bySlug = new Map();
  const byPrefix = new Map();
  for (const c of conferences) {
    bySlug.set(c.slug, c);
    if (c.status === 'searchable') byPrefix.set(c.route_prefix, c.slug);
  }
  return { at: Date.now(), bySlug, byPrefix };
}

// The cached directory. fresh forces a read (admin routes); early asks for one refresh when the
// cache does not know a slug or prefix, at most once per isolate per minute.
async function getDirectory(env, { fresh = false, early = false } = {}) {
  const now = Date.now();
  const stale = !directory || now - directory.at > DIRECTORY_TTL_MS;
  const earlyOk = early && now - lastEarlyRefresh > EARLY_REFRESH_MS;
  if (!fresh && !stale && !earlyOk) return directory;
  if (earlyOk) lastEarlyRefresh = now;
  if (!directoryPending) {
    directoryPending = fetchDirectory(env)
      .then((d) => {
        directory = d;
        return d;
      })
      .finally(() => {
        directoryPending = null;
      });
  }
  try {
    return await directoryPending;
  } catch (err) {
    if (directory && !fresh) return directory;
    throw err;
  }
}

async function searchableSlug(env, slug, opts) {
  let d = await getDirectory(env, opts);
  if (d.bySlug.get(slug)?.status !== 'searchable' && !opts?.fresh) d = await getDirectory(env, { early: true });
  return d.bySlug.get(slug)?.status === 'searchable';
}

async function slugForMeet(env, meetId) {
  const prefix = meetId.slice(0, 6);
  let d = await getDirectory(env);
  if (!d.byPrefix.has(prefix)) d = await getDirectory(env, { early: true });
  return d.byPrefix.get(prefix) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Request plumbing.

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

// Reads the body as text, refusing more than cap bytes (413).
async function readCapped(request, cap) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw reply(413, { error: 'Request body is too large' });
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw reply(413, { error: 'Request body is too large' });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function parseJsonBody(request, raw) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw reply(415, { error: 'Content-Type must be application/json' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw reply(400, { error: 'Malformed JSON' });
  }
  if (!isPlainObject(body)) throw reply(400, { error: 'Body must be a JSON object' });
  return body;
}

// The header set a Durable Object receives: nothing the client chose except Content-Type and the
// device header, so rate-limit keys cannot be spoofed.
function forwardHeaders(request, slug) {
  const h = new Headers();
  const type = request.headers.get('content-type');
  if (type) h.set('Content-Type', type);
  const device = request.headers.get('x-caddie-device');
  if (device) h.set('X-Caddie-Device', device);
  h.set('X-Caddie-IP', (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 45));
  if (slug) h.set('X-Caddie-Slug', slug);
  return h;
}

async function callDo(stub, url, init) {
  try {
    return await stub.fetch(url, init);
  } catch (err) {
    if (isDailyLimitError(err)) return dailyLimitResponse();
    console.error(`durable object call failed: ${err?.name ?? 'Error'}`);
    return json(502, { error: 'Service is temporarily unavailable' });
  }
}

// ---------------------------------------------------------------------------------------------
// API routes.

async function handleApi(request, env, url, originAllowed) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health' || path === '/api/push/vapid') {
    if (method !== 'GET' && method !== 'HEAD') throw reply(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const retry = path === '/api/health' ? take(`health:${ip}`, HEALTH_PER_MIN) : take(`vapid:${ip}`, VAPID_PER_MIN);
    if (retry) throw reply(429, { error: 'Too many requests' }, { 'Retry-After': String(retry) });
    if (path === '/api/health') return json(200, { ok: true });
    return json(200, { publicKey: env.VAPID_PUBLIC_KEY || null }, { 'Cache-Control': 'public, max-age=3600' });
  }

  if (path === '/api/conferences') {
    if (method !== 'GET' && method !== 'HEAD') throw reply(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    return callDo(directoryStub(env), 'https://directory.internal/api/conferences', { method, headers: forwardHeaders(request, null) });
  }

  let spec;
  let slug = null;
  const meet = MEET_PATH_RE.exec(path);
  if (meet) {
    const want = MEET_METHODS[meet[2] ?? ''];
    if (method !== want && !(want === 'GET' && method === 'HEAD')) throw reply(405, { error: 'Method not allowed' }, { Allow: want === 'GET' ? 'GET, HEAD' : want });
    spec = { src: 'meet', style: 'people', origin: true };
  } else {
    const route = ROUTES[path];
    if (!route) throw reply(404, { error: 'Not found' });
    spec = route[method] ?? (method === 'HEAD' ? route.GET : undefined);
    if (!spec) {
      const allow = Object.keys(route);
      if (allow.includes('GET')) allow.push('HEAD');
      throw reply(405, { error: 'Method not allowed' }, { Allow: allow.join(', ') });
    }
  }

  if (spec.origin && request.headers.has('origin') && !originAllowed) throw reply(403, { error: 'cross-origin request' });

  const errors = SLUG_ERRORS[spec.style];
  let raw = null;
  if (method !== 'GET' && method !== 'HEAD') raw = await readCapped(request, spec.cap ?? CAP_DEFAULT);

  if (spec.src === 'meet') {
    slug = await slugForMeet(env, meet[1]);
    if (!slug) throw reply(404, { error: 'not_found' });
  } else {
    let value;
    if (spec.src === 'query') {
      value = url.searchParams.get(spec.key);
    } else {
      value = parseJsonBody(request, raw)[spec.key];
    }
    if (typeof value !== 'string') throw reply(400, { error: errors.type });
    if (!SLUG_RE.test(value)) throw reply(400, { error: errors.bad });
    if (!(await searchableSlug(env, value))) throw reply(400, { error: errors.unknown });
    slug = value;
  }

  return callDo(conferenceStub(env, slug), `https://conference.internal${path}${url.search}`, {
    method,
    headers: forwardHeaders(request, slug),
    body: raw === null || raw === '' ? undefined : raw,
  });
}

// ---------------------------------------------------------------------------------------------
// Admin routes: bearer token compared on SHA-256 digests in constant time; any failure, a missing
// or short token, or an Origin header gives 404, so the endpoint is never advertised.

async function adminAuthorized(request, env) {
  if (request.headers.has('origin')) return false;
  const token = env.ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length < 32) return false;
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(m[1])), crypto.subtle.digest('SHA-256', enc.encode(token))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handleAdmin(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const raw = method === 'GET' || method === 'HEAD' ? null : await readCapped(request, CAP_ADMIN);

  if (path === '/admin/conferences') {
    if (method !== 'PUT') throw reply(405, { error: 'Method not allowed' }, { Allow: 'PUT' });
    const res = await callDo(directoryStub(env), 'https://directory.internal/admin/conferences', {
      method: 'PUT',
      headers: forwardHeaders(request, null),
      body: raw ?? '',
    });
    if (!res.ok) return res;
    const { upserted, searchable } = await res.json();
    directory = null;
    let synced = 0;
    for (const c of searchable) {
      const r = await callDo(conferenceStub(env, c.slug), 'https://conference.internal/internal/conference', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Caddie-Slug': c.slug },
        body: JSON.stringify({ doc: c.doc, route_prefix: c.route_prefix }),
      });
      if (r.ok) synced += 1;
    }
    console.log(`admin conferences upserted=${upserted} searchable=${searchable.length} synced=${synced}`);
    return json(200, { upserted, searchable: searchable.length, synced });
  }

  if (!CONFERENCE_ADMIN_PATHS.has(path)) throw reply(404, { error: 'Not found' });
  const slug = url.searchParams.get('event');
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw reply(400, { error: 'event must be a conference slug' });
  if (!(await searchableSlug(env, slug, { fresh: true }))) throw reply(400, { error: 'conference is not available' });
  return callDo(conferenceStub(env, slug), `https://conference.internal${path}${url.search}`, {
    method,
    headers: forwardHeaders(request, slug),
    body: raw === null || raw === '' ? undefined : raw,
  });
}

// ---------------------------------------------------------------------------------------------
// The fetch handler.

function template(path) {
  if (MEET_PATH_RE.test(path)) return path.split('/').length > 4 ? '/api/meet/:id/:action' : '/api/meet/:id';
  if (ROUTES[path] || CONFERENCE_ADMIN_PATHS.has(path) || ['/api/health', '/api/push/vapid', '/api/conferences', '/admin/conferences'].includes(path)) return path;
  return path.startsWith('/admin/') ? '/admin/other' : path.startsWith('/api/') ? '/api/other' : '/other';
}

function finish(response, { origin, originAllowed, admin }) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
  if (originAllowed && !admin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.append('Vary', 'Origin');
    res.headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Caddie-Pace');
  }
  return res;
}

async function route(request, env, url, originAllowed) {
  const path = url.pathname;
  if (path.startsWith('/admin/')) {
    if (!(await adminAuthorized(request, env))) return json(404, { error: 'Not found' });
    return handleAdmin(request, env, url);
  }
  if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env, url, originAllowed);
  return json(404, { error: 'Not found' });
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const originAllowed = Boolean(origin) && allowedOrigins(env).has(origin);
    const admin = url.pathname.startsWith('/admin/');
    let response;

    if (request.method === 'OPTIONS') {
      if (origin && !originAllowed) {
        response = new Response(null, { status: 403 });
      } else if (admin) {
        response = json(404, { error: 'Not found' });
      } else {
        response = new Response(null, {
          status: 204,
          headers: originAllowed
            ? {
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE',
                'Access-Control-Allow-Headers': 'Content-Type, X-Caddie-Device',
                'Access-Control-Max-Age': '86400',
              }
            : { Allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS' },
        });
      }
      // A refused preflight gets no CORS headers at all.
      response = finish(response, { origin, originAllowed: originAllowed && !admin, admin });
    } else {
      try {
        response = await route(request, env, url, originAllowed);
      } catch (err) {
        if (err instanceof Reply) {
          response = err.response;
        } else if (isDailyLimitError(err)) {
          response = dailyLimitResponse();
        } else {
          console.error(`worker error: ${err?.name ?? 'Error'}`);
          response = json(502, { error: 'Service is temporarily unavailable' });
        }
      }
      response = finish(response, { origin, originAllowed, admin });
    }
    console.log(`${request.method} ${template(url.pathname)} ${response.status} ${Date.now() - started}ms`);
    return response;
  },

  // Every 10 minutes: purge, expiry and embedding retries in each recent searchable conference,
  // and the cross-conference usage totals (PLAN sections 1.5, 1.10 and 1.14).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env) {
  const dir = directoryStub(env);
  const res = await dir.fetch('https://directory.internal/internal/cron-targets');
  if (!res.ok) {
    console.error(`cron targets failed: ${res.status}`);
    return;
  }
  const { targets, day: usageDay, usage } = await res.json();
  const day = utcDay(Date.now());
  const prev = usageDay === day && isPlainObject(usage) ? usage : {};
  const results = {};
  await Promise.all(
    targets.map(async ({ slug }) => {
      const others = { requests: 0, rows_read: 0, rows_written: 0 };
      for (const [s, u] of Object.entries(prev)) {
        if (s === slug || u?.day !== day) continue;
        others.requests += Number(u.requests) || 0;
        others.rows_read += Number(u.rows_read) || 0;
        others.rows_written += Number(u.rows_written) || 0;
      }
      try {
        const r = await conferenceStub(env, slug).fetch('https://conference.internal/internal/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Caddie-Slug': slug },
          body: JSON.stringify({ day, others }),
        });
        if (r.ok) {
          const u = await r.json();
          results[slug] = { day: u.day, requests: u.requests, rows_read: u.rows_read, rows_written: u.rows_written };
        }
      } catch (err) {
        console.error(`cron call failed: ${err?.name ?? 'Error'}`);
      }
    }),
  );
  await dir.fetch('https://directory.internal/internal/usage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, usage: results }),
  });
  console.log(`cron conferences=${targets.length} answered=${Object.keys(results).length}`);
}
