// ConferenceDO: one SQLite-backed Durable Object per conference slug (PLAN sections 1.2 to 1.6,
// 1.10 and 1.14). It holds the conference's talks, vectors, topics, facets, people and every
// connection between them, and serves the API routes of the four handler modules, the admin
// routes and the cron call. It is reachable only through the Worker, which forwards a fresh
// header set (Content-Type, X-Caddie-Device, X-Caddie-IP, X-Caddie-Slug, and on an admin request
// X-Caddie-Admin-Nonce and X-Caddie-Admin-Ts from the verified signature), so those are trusted.

import { DurableObject } from 'cloudflare:workers';
import { migrate } from './schema.js';
import { Store } from './store.js';
import apiRoutes from './routes.js';
import adminRoutes from './admin.js';
import { HttpError, json, readJson, isDailyLimitError, dailyLimitResponse } from './lib/http.js';
import { consumeAdminNonce } from './lib/admin-auth.js';
import { newEmbedState } from './lib/embed.js';
import { visibleUntilMs } from './lib/time.js';
import { Meter } from './lib/meter.js';

// The daily usage meter (src/lib/meter.js) adds its deltas to the day's stored totals after the
// first request of a new instance, then after 100 requests or on the first request 15 seconds or
// more after the last write, whichever comes first, and on every GET /admin/stats and cron call.
// It never writes from a timer: a pending timer keeps the object from hibernating, and an object
// that cannot hibernate is billed for duration (GB-s, a daily Free-plan limit for the whole
// account) while it waits. An object evicted while idle therefore loses the counts since its last
// write (fewer than 100 requests within 15 seconds of it). One write per interval costs up to
// 5,760 written rows a day for each object that is busy all day, so the total grows with the
// number of searchable conferences (about 23,000 a day for four).
const BUCKET_SWEEP_EVERY = 1000;
// The routes an object serves while its conference is not searchable: an owner's deletes and the
// list of their own blocks, so nobody is locked out of deleting their data (the Worker forwards
// these for any conference whose object exists).
const OWNER_ROUTES = new Set([
  'DELETE /api/people/profile', 'DELETE /api/presence', 'DELETE /api/push/subscription', 'DELETE /api/people/block', 'GET /api/people/blocks',
]);
// The tables whose rows the cron still has to purge; while any holds a row, the directory keeps
// the conference among the cron targets.
const HELD_TABLES = ['people', 'presence', 'blocks', 'meets', 'push_subs', 'nudges', 'nudge_sends', 'ble_caps'];

function matchRoute(routes, method, path) {
  const allowed = new Set();
  let hit = null;
  for (const r of routes) {
    let params = null;
    if (typeof r.path === 'string') {
      if (r.path === path) params = [];
    } else {
      const m = r.path.exec(path);
      if (m) params = m.slice(1);
    }
    if (!params) continue;
    allowed.add(r.method);
    if (r.method === 'GET') allowed.add('HEAD');
    if (!hit && (r.method === method || (method === 'HEAD' && r.method === 'GET'))) hit = { route: r, params };
  }
  // An exact method match wins over HEAD falling back to GET.
  if (hit && hit.route.method !== method) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = typeof r.path === 'string' ? (r.path === path ? [] : null) : r.path.exec(path)?.slice(1) ?? null;
      if (m) return { route: r, params: m, allowed };
    }
  }
  return { ...(hit ?? {}), allowed };
}

export class ConferenceDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.cursors = [];
    this.buckets = new Map();
    this.limitCalls = 0;
    this.embedState = newEmbedState();
    this.conf = null;
    this.slug = null;
    this.store = new Store(this);
    state.blockConcurrencyWhile(async () => {
      migrate(state.storage.sql);
      this.#loadConf();
      this.meter = this.#newMeter();
    });
  }

  // The meter's own writes are unmetered calls that count their cost themselves (lib/meter.js).
  #newMeter() {
    return new Meter({ sql: (q, ...b) => this.state.storage.sql.exec(q, ...b), exec: (q, ...b) => this.exec(q, ...b), env: this.env });
  }

  // The metered SQL: the same signature as storage.sql.exec. Every cursor is remembered so its
  // final rowsRead and rowsWritten reach the day's meter after the response is built.
  exec(query, ...bindings) {
    const c = this.state.storage.sql.exec(query, ...bindings);
    this.cursors.push(c);
    return c;
  }

  #drain() {
    let read = 0;
    let written = 0;
    for (const c of this.cursors) {
      read += c.rowsRead ?? 0;
      written += c.rowsWritten ?? 0;
    }
    this.cursors = [];
    if (read || written) this.meter.addRows(read, written);
  }

  #loadConf() {
    const row = this.state.storage.sql.exec("SELECT v FROM meta WHERE k = 'conference'").toArray()[0];
    if (!row) return;
    try {
      this.#setConf(JSON.parse(row.v));
    } catch {
      this.conf = null;
    }
  }

  #setConf(doc) {
    this.slug = doc.slug;
    this.conf = {
      slug: doc.slug,
      name: doc.name ?? '',
      time_zone: doc.time_zone ?? null,
      start_date: doc.start_date ?? null,
      end_date: doc.end_date ?? null,
      status: doc.status === 'searchable' ? 'searchable' : 'unavailable',
      visible_until_ms: doc.end_date ? visibleUntilMs(doc.end_date, doc.time_zone) : null,
      route_prefix: doc.route_prefix,
      doc,
    };
  }

  // In-memory token bucket per key, refilling at perWindow per windowMs. Throws 429.
  #limit(key, perWindow, windowMs = 60_000) {
    const now = Date.now();
    const rate = perWindow / windowMs;
    let bk = this.buckets.get(key);
    if (!bk) {
      bk = { tokens: perWindow, at: now, limit: perWindow, windowMs };
      this.buckets.set(key, bk);
    } else {
      bk.tokens = Math.min(perWindow, bk.tokens + (now - bk.at) * rate);
      bk.at = now;
      bk.limit = perWindow;
      bk.windowMs = windowMs;
    }
    this.limitCalls += 1;
    if (this.limitCalls % BUCKET_SWEEP_EVERY === 0) {
      for (const [k, x] of this.buckets) if (x.tokens + (now - x.at) * (x.limit / x.windowMs) >= x.limit) this.buckets.delete(k);
    }
    if (bk.tokens >= 1) {
      bk.tokens -= 1;
      return;
    }
    const retry = Math.max(1, Math.ceil((1 - bk.tokens) / rate / 1000));
    throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(retry) });
  }

  // The day's usage as GET /admin/stats reports it: the request's rows so far are counted, and the
  // meter writes its deltas before it reads, so the reading is a stored total (lib/meter.js).
  usage() {
    this.#drain();
    return { ...this.meter.report(), pace: this.meter.pace() };
  }

  #ctx(request, now) {
    const meter = this.meter;
    return {
      env: this.env,
      sql: { exec: (q, ...b) => this.exec(q, ...b) },
      slug: this.slug,
      conf: this.conf,
      now,
      ip: request.headers.get('x-caddie-ip') || 'unknown',
      store: this.store,
      // Runs fn in one synchronous SQLite transaction (storage.transactionSync), for state
      // transitions that must not interleave. An addition to the plan's contract.
      transactionSync: (fn) => this.state.storage.transactionSync(fn),
      limit: (key, perWindow, windowMs) => this.#limit(key, perWindow, windowMs),
      waitUntil: (promise) => {
        const p = Promise.resolve(promise)
          .catch((err) => console.error(`background work failed: ${err?.name ?? 'Error'}`))
          .finally(() => this.#drain());
        if (typeof this.state.waitUntil === 'function') this.state.waitUntil(p);
      },
      meter: { lexicalAllowed: () => meter.lexicalAllowed(), writesAllowed: () => meter.writesAllowed(), pace: meter.pace(now) },
      embedState: this.embedState,
      usage: () => this.usage(),
      // For the smoke's meter check: replaces the meter as a new instance of the object would
      // start, from the stored totals, and drops whatever the old meter had not written yet.
      restartMeter: () => {
        this.meter = this.#newMeter();
      },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();
    const headerSlug = request.headers.get('x-caddie-slug');
    if (!this.slug && headerSlug) this.slug = headerSlug;
    if (path.startsWith('/internal/')) {
      try {
        return await this.#internal(request, path);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, err.body, err.headers);
        console.error(`internal call failed: ${err?.name ?? 'Error'}`);
        return isDailyLimitError(err) ? dailyLimitResponse() : json(502, { error: 'Internal call failed' });
      } finally {
        this.#drain();
      }
    }

    this.meter.countRequest(now);
    const admin = path.startsWith('/admin/');
    const { route, params, allowed } = matchRoute(admin ? adminRoutes : apiRoutes, request.method, path);
    let res;
    try {
      // An admin request's nonce is recorded before anything else runs (W2). The Worker forwards
      // it only after verifying the signature, and no internal caller uses an /admin/* path (the
      // cron and the directory fan-out use /internal/*), so a request without it is not one the
      // Worker sent: 404. A nonce seen before is a replay: 401, and no handler runs.
      const nonce = admin ? consumeAdminNonce((q, ...b) => this.exec(q, ...b), request.headers, now) : 'ok';
      if (nonce === 'missing') {
        res = json(404, { error: 'Not found' });
      } else if (nonce === 'replay') {
        res = json(401, { error: 'admin_replay' });
      } else if (!route) {
        res = allowed.size
          ? json(405, { error: 'Method not allowed' }, { Allow: [...allowed].join(', ') })
          : json(404, { error: 'Not found' });
      } else if (!admin && (!this.conf || (this.conf.status !== 'searchable' && !OWNER_ROUTES.has(`${route.method} ${path}`)))) {
        res = json(400, { error: 'conference is not available' });
      } else {
        res = await route.handler(this.#ctx(request, now), request, params);
        if (!(res instanceof Response)) throw new TypeError('handler did not return a Response');
      }
    } catch (err) {
      if (err instanceof HttpError) {
        res = json(err.status, err.body, err.headers);
      } else if (isDailyLimitError(err)) {
        console.error(`route failed: ${err?.name ?? 'Error'} (daily limit)`);
        res = dailyLimitResponse(now);
      } else {
        console.error(`route failed: ${err?.name ?? 'Error'}`);
        res = json(502, { error: route?.fail ?? 'Service is temporarily unavailable' });
      }
    } finally {
      this.#drain();
    }
    try {
      this.meter.maybeFlush(now);
      this.#drain();
    } catch (err) {
      // A failed meter write never fails the response. The counts stay in memory and the next
      // request tries the write again.
      console.error(`meter flush failed: ${err?.name ?? 'Error'}`);
    }
    const out = new Response(request.method === 'HEAD' ? null : res.body, res);
    out.headers.set('X-Caddie-Pace', String(this.meter.pace()));
    return out;
  }

  async #internal(request, path) {
    if (path === '/internal/conference' && request.method === 'PUT') {
      const body = await readJson(request, new Set(['doc', 'route_prefix']));
      if (!body.doc || typeof body.doc.slug !== 'string' || typeof body.route_prefix !== 'string') throw new HttpError(400, { error: 'doc and route_prefix are required' });
      const doc = { ...body.doc, route_prefix: body.route_prefix };
      this.exec("INSERT INTO meta (k, v) VALUES ('conference', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(doc));
      this.#setConf(doc);
      return json(200, { ok: true });
    }
    if (path === '/internal/cron' && request.method === 'POST') {
      const body = await readJson(request, new Set(['day', 'others']));
      const ctx = this.#ctx(request, Date.now());
      const purged = this.store.purge(ctx.now);
      let embedded = { embedded: 0, pending: 0 };
      try {
        embedded = await this.store.embedPending(ctx);
      } catch (err) {
        console.error(`embedding retry failed: ${err?.name ?? 'Error'}`);
      }
      this.meter.setOthers(body.day, body.others);
      // One row read per table (EXISTS), not a count, so the check stays cheap every 10 minutes.
      const holds = HELD_TABLES.some((t) => this.exec(`SELECT EXISTS (SELECT 1 FROM ${t}) AS x`).one().x === 1) ? 1 : 0;
      this.meter.sweep(ctx.now);
      this.#drain();
      // Last, so the totals include this call's rows and the write itself.
      const { day, requests, rows_read, rows_written } = this.meter.report();
      return json(200, { day, requests, rows_read, rows_written, purged: purged.people, embedded: embedded.embedded, holds });
    }
    return json(404, { error: 'Not found' });
  }
}
