// ConferenceDO: one SQLite-backed Durable Object per conference slug (PLAN sections 1.2 to 1.6,
// 1.10 and 1.14). It holds the conference's talks, vectors, topics, facets, people and every
// connection between them, and serves the API routes of the four handler modules, the admin
// routes and the cron call. It is reachable only through the Worker, which forwards a fresh
// header set (Content-Type, X-Caddie-Device, X-Caddie-IP, X-Caddie-Slug), so those are trusted.

import { DurableObject } from 'cloudflare:workers';
import { migrate } from './schema.js';
import { Store } from './store.js';
import apiRoutes from './routes.js';
import adminRoutes from './admin.js';
import { HttpError, json, readJson, isDailyLimitError, dailyLimitResponse, secondsUntilUtcMidnight } from './lib/http.js';
import { newEmbedState } from './lib/embed.js';
import { visibleUntilMs, utcDay } from './lib/time.js';

const FLUSH_EVERY = 1000;
const WINDOW_MIN = 10;
const BUCKET_SWEEP_EVERY = 1000;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const zero = (day) => ({ day, requests: 0, rows_read: 0, rows_written: 0 });
// The routes an object serves while its conference is not searchable: an owner's deletes and the
// list of their own blocks, so nobody is locked out of deleting their data (the Worker forwards
// these for any conference whose object exists).
const OWNER_ROUTES = new Set([
  'DELETE /api/people/profile', 'DELETE /api/presence', 'DELETE /api/push/subscription', 'DELETE /api/people/block', 'GET /api/people/blocks',
]);
// The tables whose rows the cron still has to purge; while any holds a row, the directory keeps
// the conference among the cron targets.
const HELD_TABLES = ['people', 'presence', 'blocks', 'meets', 'push_subs', 'nudges', 'nudge_sends', 'ble_caps'];

// The daily meter of section 1.14: API requests served, and SQLite rows read and written, per UTC
// day, plus the other conferences' totals from the last cron call.
class Meter {
  constructor(owner) {
    this.owner = owner;
    const day = utcDay(Date.now());
    let usage = null;
    try {
      usage = JSON.parse(owner.state.storage.sql.exec("SELECT v FROM meta WHERE k = 'usage'").toArray()[0]?.v ?? 'null');
    } catch {
      usage = null;
    }
    this.usage = usage && usage.day === day ? { ...zero(day), ...usage } : zero(day);
    this.others = zero(day);
    this.othersGrowth = 0; // growth of others.requests between the last two cron calls
    this.minutes = new Map(); // minute index -> requests
    this.sinceFlush = 0;
  }

  #roll(now) {
    const day = utcDay(now);
    if (this.usage.day !== day) this.usage = zero(day);
    if (this.others.day !== day) {
      this.others = zero(day);
      this.othersGrowth = 0;
    }
  }

  countRequest(now) {
    this.#roll(now);
    this.usage.requests += 1;
    const m = Math.floor(now / 60_000);
    this.minutes.set(m, (this.minutes.get(m) ?? 0) + 1);
    for (const k of this.minutes.keys()) if (k <= m - WINDOW_MIN) this.minutes.delete(k);
    this.sinceFlush += 1;
    if (this.sinceFlush >= FLUSH_EVERY) this.flush();
  }

  addRows(read, written) {
    this.#roll(Date.now());
    this.usage.rows_read += read;
    this.usage.rows_written += written;
  }

  // Writes the day's totals to meta.usage (one written row).
  flush() {
    this.sinceFlush = 0;
    this.owner.exec("INSERT INTO meta (k, v) VALUES ('usage', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(this.usage));
  }

  setOthers(day, others) {
    const now = Date.now();
    this.#roll(now);
    if (day !== this.usage.day || !others) return;
    const next = { day, requests: num(others.requests, 0), rows_read: num(others.rows_read, 0), rows_written: num(others.rows_written, 0) };
    this.othersGrowth = Math.max(0, next.requests - this.others.requests);
    this.others = next;
  }

  global() {
    this.#roll(Date.now());
    return {
      requests: this.usage.requests + this.others.requests,
      rows_read: this.usage.rows_read + this.others.rows_read,
      rows_written: this.usage.rows_written + this.others.rows_written,
    };
  }

  // The request pace clients multiply their poll intervals by: 1 (normal) to 10 (slowest).
  pace(now = Date.now()) {
    const env = this.owner.env;
    const budget = num(env.DAILY_REQUEST_BUDGET, 70_000);
    const left = budget - this.global().requests;
    if (left < 0.02 * budget) return 10;
    let recent = 0;
    const m = Math.floor(now / 60_000);
    for (const [k, n] of this.minutes) if (k > m - WINDOW_MIN) recent += n;
    const projected = ((recent + this.othersGrowth) * secondsUntilUtcMidnight(now)) / 600;
    const pace = Math.min(10, Math.max(1, projected / Math.max(left, 1)));
    return Math.round(pace * 10) / 10;
  }

  lexicalAllowed() {
    return this.global().rows_read < num(this.owner.env.ROWS_READ_SOFT_CAP, 3_500_000);
  }

  writesAllowed() {
    return this.global().rows_written < num(this.owner.env.ROWS_WRITTEN_SOFT_CAP, 85_000);
  }
}

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
      this.meter = new Meter(this);
    });
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

  usage() {
    return { ...this.meter.usage, pace: this.meter.pace() };
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
      if (!route) {
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
      this.#drain();
      this.meter.flush();
      this.#drain();
      // One row read per table (EXISTS), not a count, so the check stays cheap every 10 minutes.
      const holds = HELD_TABLES.some((t) => this.exec(`SELECT EXISTS (SELECT 1 FROM ${t}) AS x`).one().x === 1) ? 1 : 0;
      this.#drain();
      const { day, requests, rows_read, rows_written } = this.meter.usage;
      return json(200, { day, requests, rows_read, rows_written, purged: purged.people, embedded: embedded.embedded, holds });
    }
    return json(404, { error: 'Not found' });
  }
}
