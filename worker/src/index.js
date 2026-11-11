// The Conference Caddie API Worker (PLAN section 1.5). It stays thin: CORS, preflight, body caps,
// slug resolution, admin auth, health and the VAPID key, then exactly one Durable Object request
// per API call. All ranking, privacy gates and SQL run in the Durable Objects.
//
// The same Worker serves the web app as static assets on its own origin ([assets] in
// wrangler.toml). Static files never reach this code: only /api, /admin and their subpaths do
// (run_worker_first), so the app's files cost no Worker request and never count in the pace
// budget, and their headers come from the build's _headers file.
//
// Logging: one line per request with the method, a path template, the status and the duration.
// Never a body, a header value, query text, a profile field, a token or a secret.

import { ConferenceDO } from './conference.js';
import { DirectoryDO } from './directory.js';
import { CONFERENCE_ADMIN_PATHS } from './admin.js';
import { capabilitiesDocument, CAPABILITIES_MAX_AGE_S } from './capabilities.js';
import { HEADER_NAME, NONCE_HEADER, TS_HEADER, adminKeys, bodyMatches, verifyAdminHeader } from './lib/admin-auth.js';
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
// Polled at every cold start of every app behind one venue address, so as generous as health.
const CAPABILITIES_PER_MIN = 600;
// Failed admin signatures per minute per address before the Worker stops computing HMACs for it
// (W4). It protects CPU, not the key.
const ADMIN_FAIL_PER_MIN = 10;

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
//   owner: an owner's delete or a read of what they made, served for any conference whose object
//          exists (has_object), not only a searchable one, so nobody is locked out of deleting
//          their data when a conference turns unavailable

const people = (src) => ({ src, key: 'event', style: 'people', origin: true });
const owner = (src) => ({ ...people(src), owner: true });
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
  '/api/people/profile': { PUT: people('body'), DELETE: owner('query') },
  '/api/people/matches': { POST: people('body') },
  '/api/people/block': { POST: people('body'), DELETE: owner('body') },
  '/api/people/blocks': { GET: owner('query') },
  '/api/people/report': { POST: people('body') },
  '/api/presence': { PUT: people('body'), DELETE: owner('query') },
  '/api/presence/ble/rotate': { POST: people('body') },
  '/api/presence/sightings': { POST: people('body') },
  '/api/meet': { POST: people('body') },
  '/api/meet/inbox': { GET: people('query') },
  '/api/push/subscription': { PUT: people('body'), DELETE: owner('body') },
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
// Isolate-level state: the directory cache and the small rate limits (health, VAPID key,
// capabilities and failed admin signatures).

let directory = null; // { at, bySlug: Map, byPrefix: Map }
let directoryPending = null;
let lastEarlyRefresh = 0;
const buckets = new Map();

// The bucket of key, refilled at perMin tokens a minute up to perMin. A key without a bucket is
// full: take() creates its bucket, peek() leaves it out of the map and gets null.
function refill(key, perMin, create) {
  const now = Date.now();
  let bk = buckets.get(key);
  if (!bk) {
    if (!create) return null;
    if (buckets.size > 10_000) buckets.clear();
    bk = { tokens: perMin, at: now };
    buckets.set(key, bk);
  } else {
    bk.tokens = Math.min(perMin, bk.tokens + ((now - bk.at) * perMin) / 60_000);
    bk.at = now;
  }
  return bk;
}

// Takes one token: 0 when there was one, else the seconds until there is.
function take(key, perMin) {
  const bk = refill(key, perMin, true);
  if (bk.tokens >= 1) {
    bk.tokens -= 1;
    return 0;
  }
  return Math.max(1, Math.ceil(((1 - bk.tokens) * 60_000) / perMin / 1000));
}

// Whether take() would find a token now. It refills exactly as take() does and takes nothing, so
// a check that runs on every request charges no one.
function peek(key, perMin) {
  const bk = refill(key, perMin, false);
  return !bk || bk.tokens >= 1;
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

// True when the slug is searchable, or, with ownerRoute, when its object exists (has_object).
async function servedSlug(env, slug, { ownerRoute = false, fresh = false } = {}) {
  const ok = (d) => {
    const c = d.bySlug.get(slug);
    return c?.status === 'searchable' || (ownerRoute && c?.has_object === true);
  };
  let d = await getDirectory(env, { fresh });
  if (!ok(d) && !fresh) d = await getDirectory(env, { early: true });
  return ok(d);
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

// An Origin the API accepts: the Worker's own origin, where the web app is served (a browser sends
// Origin on a same-origin POST, PUT or DELETE too), or one of the development origins in
// ALLOWED_ORIGINS. A request with no Origin (the native apps, Node, curl) needs no CORS answer and
// is handled by the callers.
function originIsAllowed(origin, url, env) {
  if (!origin) return false;
  return origin === url.origin || allowedOrigins(env).has(origin);
}

// Reads the body as bytes, refusing more than cap bytes (413).
async function readCappedBytes(request, cap) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw reply(413, { error: 'Request body is too large' });
  if (!request.body) return new Uint8Array(0);
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
  return all;
}

// Reads the body as text, refusing more than cap bytes (413).
async function readCapped(request, cap) {
  return new TextDecoder().decode(await readCappedBytes(request, cap));
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
// device header, so rate-limit keys cannot be spoofed. An admin request also carries the nonce and
// timestamp of its verified X-Caddie-Admin header, for the object's replay check; a client's own
// X-Caddie-Admin-Nonce or X-Caddie-Admin-Ts is never copied, as no other client header is.
function forwardHeaders(request, slug, admin = null) {
  const h = new Headers();
  const type = request.headers.get('content-type');
  if (type) h.set('Content-Type', type);
  const device = request.headers.get('x-caddie-device');
  if (device) h.set('X-Caddie-Device', device);
  h.set('X-Caddie-IP', (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 45));
  if (slug) h.set('X-Caddie-Slug', slug);
  if (admin) {
    h.set(NONCE_HEADER, admin.nonce);
    h.set(TS_HEADER, admin.ts);
  }
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

  if (path === '/api/capabilities') {
    if (method !== 'GET' && method !== 'HEAD') throw reply(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    const retry = take(`capabilities:${request.headers.get('cf-connecting-ip') || 'unknown'}`, CAPABILITIES_PER_MIN);
    if (retry) throw reply(429, { error: 'Too many requests' }, { 'Retry-After': String(retry) });
    return json(200, capabilitiesDocument(env), { 'Cache-Control': `public, max-age=${CAPABILITIES_MAX_AGE_S}`, 'Access-Control-Allow-Origin': '*' });
  }

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
    if (!(await servedSlug(env, value, { ownerRoute: spec.owner === true }))) throw reply(400, { error: errors.unknown });
    slug = value;
  }

  return callDo(conferenceStub(env, slug), `https://conference.internal${path}${url.search}`, {
    method,
    headers: forwardHeaders(request, slug),
    body: raw === null || raw === '' ? undefined : raw,
  });
}

// ---------------------------------------------------------------------------------------------
// Admin routes: every /admin/* request carries X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>,
// an HMAC-SHA256 made with ADMIN_TOKEN (or ADMIN_TOKEN_NEXT during a rotation) over the method, the
// path and query, the body hash, the timestamp and the nonce (lib/admin-auth.js). The checks run in
// this order, and every failure before the clock check answers 404, so the routes are never
// advertised and only a key holder can ever see a 401:
//   1. an Origin header (a browser is never an admin client): 404;
//   2. no ADMIN_TOKEN of at least 32 characters after trimming: 404;
//   3. the header absent or malformed: 404;
//   4. GET, HEAD or DELETE with a body hash other than the empty body's: 404;
//   5. ten failed signatures from this address within the last minute (peek, nothing computed): 404;
//   6. no key reproduces the signature: one token taken from that bucket, 404;
//   7. the timestamp more than 300 seconds from the Worker's clock: 401 admin_skew;
//   8. only now the body is read (4 MB cap) and hashed; another hash than the signed one: 401
//      admin_body;
//   9. the buffered bytes are forwarded with the verified nonce and timestamp, and the Durable
//      Object refuses a nonce it has seen (401 admin_replay, schema.js admin_nonces).
// The Authorization header is not read here.

const timingSafeEqual = (a, b) => crypto.subtle.timingSafeEqual(a, b);

// Steps 1 to 7. Returns the verified header ({ ts, nonce, bodySha256, sig }, as strings).
async function adminAuth(request, env, url) {
  if (request.headers.has('origin')) throw reply(404, { error: 'Not found' });
  const failKey = `admin-fail:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
  const v = await verifyAdminHeader({
    headerValue: request.headers.get(HEADER_NAME),
    method: request.method,
    pathWithQuery: url.pathname + url.search,
    keys: adminKeys(env),
    nowMs: Date.now(),
    timingSafeEqual,
    mayTry: () => peek(failKey, ADMIN_FAIL_PER_MIN),
  });
  if (v.ok) return v.header;
  if (v.reason === 'signature') take(failKey, ADMIN_FAIL_PER_MIN);
  if (v.reason === 'skew') throw reply(401, { error: 'admin_skew' });
  throw reply(404, { error: 'Not found' });
}

// Steps 8 and 9, then the route.
async function handleAdmin(request, env, url, header) {
  const path = url.pathname;
  const method = request.method;
  let raw = null;
  if (method !== 'GET' && method !== 'HEAD') {
    raw = await readCappedBytes(request, CAP_ADMIN);
    if (!(await bodyMatches(header.bodySha256, raw, timingSafeEqual))) throw reply(401, { error: 'admin_body' });
  }
  // The bytes that were hashed, never request.body (already consumed).
  const body = raw && raw.byteLength > 0 ? raw : undefined;
  const verified = { nonce: header.nonce, ts: header.ts };

  if (path === '/admin/conferences') {
    if (method !== 'PUT') throw reply(405, { error: 'Method not allowed' }, { Allow: 'PUT' });
    const res = await callDo(directoryStub(env), 'https://directory.internal/admin/conferences', {
      method: 'PUT',
      headers: forwardHeaders(request, null, verified),
      body,
    });
    if (!res.ok) return res;
    // searchable: the documents to copy into each conference's object (searchable ones, and those
    // whose object exists, so it learns its status).
    const { upserted, searchable: docs } = await res.json();
    const searchable = docs.filter((c) => c.doc?.status === 'searchable');
    directory = null;
    let synced = 0;
    for (const c of docs) {
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
  // Any conference the directory knows: the operator's moderation, stats and test routes must reach
  // a conference whose status turned unavailable.
  const known = (await getDirectory(env, { fresh: true })).bySlug.has(slug);
  if (!known) throw reply(400, { error: 'conference is not available' });
  return callDo(conferenceStub(env, slug), `https://conference.internal${path}${url.search}`, {
    method,
    headers: forwardHeaders(request, slug, verified),
    body,
  });
}

// ---------------------------------------------------------------------------------------------
// The fetch handler.

function template(path) {
  if (MEET_PATH_RE.test(path)) return path.split('/').length > 4 ? '/api/meet/:id/:action' : '/api/meet/:id';
  if (ROUTES[path] || CONFERENCE_ADMIN_PATHS.has(path) || ['/api/health', '/api/capabilities', '/api/push/vapid', '/api/conferences', '/admin/conferences'].includes(path)) return path;
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
  if (path.startsWith('/admin/')) return handleAdmin(request, env, url, await adminAuth(request, env, url));
  if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env, url, originAllowed);
  return json(404, { error: 'Not found' });
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const originAllowed = originIsAllowed(origin, url, env);
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

  // Every 10 minutes: purge, expiry and embedding retries in each conference the directory's
  // cron targets name (recent ones, and any whose object still holds personal data, whatever its
  // status), and the cross-conference usage totals (PLAN sections 1.5, 1.10 and 1.14).
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
  const holds = {};
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
          if (Number.isFinite(u.holds)) holds[slug] = u.holds;
        }
      } catch (err) {
        console.error(`cron call failed: ${err?.name ?? 'Error'}`);
      }
    }),
  );
  await dir.fetch('https://directory.internal/internal/usage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, usage: results, holds }),
  });
  console.log(`cron conferences=${targets.length} answered=${Object.keys(results).length}`);
}
