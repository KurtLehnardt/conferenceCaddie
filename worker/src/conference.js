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
// Every table a wipe (DELETE /admin/conference, POST /internal/wipe) empties: each table of
// schema.js and the meter's usage_days, so nothing of the conference is left, and only admin_nonces
// is kept, because it holds the wipe's own nonce and the replay check needs it. The full-text
// tables are emptied through their virtual tables, never their shadow tables. meta keeps its
// schema_version row (the database's shape, not conference data), gets the retired_at marker, and
// keeps the two order numbers (META_KEPT). storage.deleteAll() is not used, so the tables and their indexes stay and the
// object can take the conference again.
const WIPE_TABLES = [
  'talks_fts', 'talk_vectors', 'talks', 'topics', 'facets', 'people_fts', 'shared_talks', 'presence', 'blocks', 'meets',
  'reports', 'push_subs', 'nudges', 'nudge_sends', 'ble_caps', 'people', 'usage_days', 'meta',
];
// The meta rows a wipe keeps. retired_at (the time of the first wipe since the conference was last
// given back) marks a removed object: while it is set, PUT /internal/conference is refused unless
// the directory's fan-out says the conference was unretired, so a fan-out that left the Worker
// before the removal cannot make the object searchable again; admin writes are refused too.
// wipe_seq and unretire_seq are the highest numbers of the directory's order sequence (directory.js
// #nextSeq) that a wipe and an unretire fan-out brought to this object: a wipe is refused when an
// unretire with a higher number was already taken, and an unretire fan-out is refused unless its
// number is higher than the last wipe's, so the later of the two, by the directory's order, wins.
// An object without either row reads it as 0, so objects from before the sequence keep working.
const META_KEPT = "('schema_version', 'retired_at', 'wipe_seq', 'unretire_seq')";
const isSeq = (n) => Number.isSafeInteger(n) && n > 0;

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
    // meta retired_at as a number, or null when the object was never removed (or was given back).
    this.retiredAt = null;
    this.store = new Store(this);
    // How many times this instance was wiped. A request's ctx remembers the value it started with,
    // and its SQL throws once the value has moved (#ctx), so a request that was waiting on an await
    // when the wipe ran cannot write into the emptied object.
    this.wipes = 0;
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
    const retired = this.state.storage.sql.exec("SELECT v FROM meta WHERE k = 'retired_at'").toArray()[0];
    this.retiredAt = retired ? Number(retired.v) : null;
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
    const wipes = this.wipes;
    return {
      env: this.env,
      sql: {
        exec: (q, ...b) => {
          if (this.wipes !== wipes) throw new HttpError(400, { error: 'conference is not available' });
          return this.exec(q, ...b);
        },
      },
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
      // Worker sent: 404. A timestamp more than 305 seconds from this object's clock is refused
      // (401), and a nonce seen before is a replay (401); no handler runs for either. The insert
      // is a written row, so once the account's daily written-rows limit is reached every admin
      // request, a read included, answers 503 daily_limit (it fails closed).
      const nonce = admin ? consumeAdminNonce((q, ...b) => this.exec(q, ...b), request.headers, now) : 'ok';
      if (nonce === 'missing') {
        res = json(404, { error: 'Not found' });
      } else if (nonce === 'skew') {
        res = json(401, { error: 'admin_skew' });
      } else if (nonce === 'replay') {
        res = json(401, { error: 'admin_replay' });
      } else if (!route) {
        res = allowed.size
          ? json(405, { error: 'Method not allowed' }, { Allow: [...allowed].join(', ') })
          : json(404, { error: 'Not found' });
      } else if (!admin && (!this.conf || this.retiredAt !== null || (this.conf.status !== 'searchable' && !OWNER_ROUTES.has(`${route.method} ${path}`)))) {
        res = json(400, { error: 'conference is not available' });
      } else if (admin && request.method !== 'GET' && request.method !== 'HEAD' && (!this.conf || this.retiredAt !== null)) {
        // An object without its conference document (never given one, or wiped) takes no admin
        // write: nothing would ever purge what it wrote, because the cron visits only conferences
        // the directory lists. Reads still answer.
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

  // A meta row holding an order number (wipe_seq, unretire_seq), or 0 when there is none.
  #seqOf(key) {
    const v = Number(this.exec('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v ?? 0);
    return isSeq(v) ? v : 0;
  }

  // POST /internal/wipe {seq} (step 2 of DELETE /admin/conference in the Worker): the only internal
  // route that takes the admin nonce the Worker forwards, which is recorded first, as for every
  // /admin/* request (W2): missing headers are 404, a timestamp past the object's clock window 401
  // admin_skew, a nonce seen before 401 admin_replay, and nothing is deleted for any of them. seq
  // is the removal's number in the directory's order sequence (the Worker's, from step 1; 400 when
  // it is not a positive integer). When this object already took an unretire with a higher number,
  // that unretire came later and wins: 409 {error: "removal_superseded"} and nothing is deleted.
  // Otherwise every row of WIPE_TABLES goes, the retired_at marker is written (kept if already
  // there) and wipe_seq is raised to seq, in one transaction, and the caches, the conference
  // document (this.conf), the query-vector cache and the rate-limit buckets (keyed by client
  // addresses) are dropped. Answers {ok, deleted: {table: rows}}; a second wipe answers zero counts.
  async #wipe(request) {
    const now = Date.now();
    const nonce = consumeAdminNonce((q, ...b) => this.exec(q, ...b), request.headers, now);
    if (nonce === 'missing') return json(404, { error: 'Not found' });
    if (nonce === 'skew') return json(401, { error: 'admin_skew' });
    if (nonce === 'replay') return json(401, { error: 'admin_replay' });
    const { seq } = await readJson(request, new Set(['seq']));
    if (!isSeq(seq)) throw new HttpError(400, { error: 'seq must be a positive integer' });
    const deleted = {};
    let retiredAt = null;
    let superseded = false;
    this.state.storage.transactionSync(() => {
      if (this.#seqOf('unretire_seq') > seq) {
        superseded = true;
        return;
      }
      for (const t of WIPE_TABLES) {
        const where = t === 'meta' ? ` WHERE k NOT IN ${META_KEPT}` : '';
        deleted[t] = Number(this.exec(`SELECT COUNT(*) AS n FROM ${t}${where}`).one().n);
        if (deleted[t]) this.exec(`DELETE FROM ${t}${where}`);
      }
      this.exec("INSERT INTO meta (k, v) VALUES ('retired_at', ?) ON CONFLICT(k) DO NOTHING", String(now));
      retiredAt = Number(this.exec("SELECT v FROM meta WHERE k = 'retired_at'").one().v);
      if (seq > this.#seqOf('wipe_seq')) this.exec("INSERT INTO meta (k, v) VALUES ('wipe_seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(seq));
    });
    if (superseded) return json(409, { error: 'removal_superseded' });
    this.wipes += 1;
    this.retiredAt = retiredAt;
    this.store.close();
    this.store = new Store(this);
    this.embedState = newEmbedState();
    this.buckets.clear();
    this.limitCalls = 0;
    this.conf = null;
    return json(200, { ok: true, deleted });
  }

  async #internal(request, path) {
    if (path === '/internal/wipe' && request.method === 'POST') return this.#wipe(request);
    if (path === '/internal/conference' && request.method === 'PUT') {
      const body = await readJson(request, new Set(['doc', 'route_prefix', 'unretired']));
      if (!body.doc || typeof body.doc.slug !== 'string' || typeof body.route_prefix !== 'string') throw new HttpError(400, { error: 'doc and route_prefix are required' });
      const unretired = body.unretired !== undefined;
      if (unretired && !isSeq(body.unretired)) throw new HttpError(400, { error: 'unretired must be a positive integer' });
      // A removed object takes its document back only from the fan-out of an unretire (unretired:
      // <its number in the directory's order sequence>), which also drops the marker. Any other
      // fan-out, such as one that left the Worker before the removal, is refused. An unretire is
      // taken only when it came after the last wipe by that order; an earlier one lost to the
      // removal (409 unretire_superseded, which the Worker answers as unretire_incomplete, so the
      // client's repeat, with a new number, wins). Of two unretires that both came after the last
      // wipe, the higher number is the later one: when this object already took a higher one, the
      // lower one's fan-out answers 200 and writes nothing, so it cannot put its document over the
      // later unretire's. The object is live then (no wipe was taken after the higher unretire, or
      // wipe_seq would be above this number), so there is nothing left for it to do.
      if (this.retiredAt !== null && !unretired) return json(409, { error: 'conference_retired' });
      let superseded = false;
      let overtaken = false;
      const doc = { ...body.doc, route_prefix: body.route_prefix };
      this.state.storage.transactionSync(() => {
        if (unretired && !(body.unretired > this.#seqOf('wipe_seq'))) {
          superseded = true;
          return;
        }
        if (unretired && body.unretired < this.#seqOf('unretire_seq')) {
          overtaken = true;
          return;
        }
        this.exec("INSERT INTO meta (k, v) VALUES ('conference', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(doc));
        if (unretired) {
          this.exec("DELETE FROM meta WHERE k = 'retired_at'");
          // Not below the stored number (checked above), so unretire_seq only grows.
          this.exec("INSERT INTO meta (k, v) VALUES ('unretire_seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(body.unretired));
        }
      });
      if (superseded) return json(409, { error: 'unretire_superseded' });
      if (overtaken) return json(200, { ok: true });
      if (unretired) this.retiredAt = null;
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
