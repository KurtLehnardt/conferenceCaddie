// DirectoryDO 'global': the conference list, the slug to meet-id prefix map the Worker routes
// with, the public conference list, and the cron's cross-conference usage totals (PLAN sections
// 1.2, 1.4, 1.5 and 1.14). API codes and other internal fields never leave this object except to
// a ConferenceDO through the admin fan-out.

import { DurableObject } from 'cloudflare:workers';
import { migrateDirectory } from './schema.js';
import { HttpError, bad, json, readJson, isPlainObject, SLUG_RE, isDailyLimitError, dailyLimitResponse } from './lib/http.js';
import { consumeAdminNonce } from './lib/admin-auth.js';
import { utcDay } from './lib/time.js';

const CONFERENCES_PER_MIN = 120;
const CRON_DAYS_AFTER_END = 3;
// DELETE /internal/conference/<slug>: the Worker's second step of DELETE /admin/conference.
const RETIRE_PATH_RE = /^\/internal\/conference\/([a-z0-9][a-z0-9-]{0,119})$/;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function prefixFor(slug, salt) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt ? `${slug}:${salt}` : slug));
  return b64url(digest).slice(0, 6);
}

// The public projection of server/conferences.mjs publicConferences().
function publicConference(c) {
  const mapping = c.category_mapping ?? null;
  const loc = c.location ?? {};
  return {
    slug: c.slug,
    name: c.name ?? '',
    start_date: c.start_date ?? null,
    end_date: c.end_date ?? null,
    time_zone: c.time_zone ?? null,
    location: { city: loc.city ?? '', region: loc.region ?? '', country: loc.country ?? '', virtual: loc.virtual === true },
    status: c.status === 'searchable' ? 'searchable' : 'unavailable',
    official_schedule_url: c.official_schedule_url ?? null,
    source: c.source ?? 'sessionize',
    has_level: Boolean(mapping?.level_group),
    track_group: mapping?.track_group ?? null,
    tag_groups: Array.isArray(mapping?.tag_groups) ? mapping.tag_groups : [],
    talk_count: Number.isInteger(c.counts?.talk) ? c.counts.talk : 0,
  };
}

// Sorted by start_date then name, missing values last, as the Elasticsearch sort was.
const cmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);

export class DirectoryDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.docs = null; // parsed rows, sorted
    this.buckets = new Map();
    state.blockConcurrencyWhile(async () => migrateDirectory(this.sql));
  }

  #rows() {
    if (!this.docs) {
      this.docs = this.sql.exec('SELECT slug, doc, status, route_prefix, has_object, holds FROM conferences').toArray().map((r) => {
        let doc = {};
        try {
          doc = JSON.parse(r.doc);
        } catch {
          doc = { slug: r.slug };
        }
        return { slug: r.slug, status: r.status, route_prefix: r.route_prefix, has_object: r.has_object === 1, holds: r.holds > 0, doc };
      });
      this.docs.sort((a, c) => cmp(a.doc.start_date, c.doc.start_date) || cmp(a.doc.name, c.doc.name));
    }
    return this.docs;
  }

  #limit(key, perMin) {
    const now = Date.now();
    const rate = perMin / 60_000;
    let bk = this.buckets.get(key);
    if (!bk) {
      if (this.buckets.size > 10_000) this.buckets.clear();
      bk = { tokens: perMin, at: now };
      this.buckets.set(key, bk);
    } else {
      bk.tokens = Math.min(perMin, bk.tokens + (now - bk.at) * rate);
      bk.at = now;
    }
    if (bk.tokens >= 1) {
      bk.tokens -= 1;
      return;
    }
    throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(Math.max(1, Math.ceil((1 - bk.tokens) / rate / 1000))) });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/conferences') {
        this.#limit(`conferences:${request.headers.get('x-caddie-ip') || 'unknown'}`, CONFERENCES_PER_MIN);
        const conferences = this.#rows().map((r) => publicConference(r.doc));
        return json(200, { conferences }, { 'Cache-Control': 'public, max-age=60' });
      }
      if (path === '/internal/routes') {
        return json(200, {
          conferences: this.#rows().map((r) => ({
            slug: r.slug, status: r.status, route_prefix: r.route_prefix, has_object: r.has_object, end_date: r.doc.end_date ?? null, time_zone: r.doc.time_zone ?? null,
          })),
        });
      }
      // An admin request's nonce is recorded before its handler runs, as in a ConferenceDO (W2):
      // the Worker forwards it only after verifying the signature, and strips any client copy.
      if (path.startsWith('/admin/')) {
        const nonce = consumeAdminNonce((q, ...b) => this.sql.exec(q, ...b), request.headers, Date.now());
        if (nonce === 'missing') return json(404, { error: 'Not found' });
        if (nonce === 'skew') return json(401, { error: 'admin_skew' });
        if (nonce === 'replay') return json(401, { error: 'admin_replay' });
      }
      if (path === '/admin/conferences' && request.method === 'PUT') return await this.#upsert(request);
      if (path === '/admin/stats' && (request.method === 'GET' || request.method === 'HEAD')) return this.#stats();
      // The directory half of a conference removal. The Worker calls it only after the object's
      // /internal/wipe accepted the request's nonce, so it records none of its own (W2).
      const retire = RETIRE_PATH_RE.exec(path);
      if (retire && request.method === 'DELETE') return this.#retire(retire[1]);
      if (path === '/internal/cron-targets') return this.#cronTargets();
      if (path === '/internal/usage' && request.method === 'PUT') {
        const body = await readJson(request, new Set(['day', 'usage', 'holds']));
        if (typeof body.day !== 'string' || !isPlainObject(body.usage)) throw bad('day and usage are required');
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('usage', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify({ day: body.day, usage: body.usage }));
        // What each answering conference still holds, so the cron keeps visiting it until it is empty.
        if (isPlainObject(body.holds)) {
          for (const [slug, n] of Object.entries(body.holds)) {
            if (SLUG_RE.test(slug) && Number.isFinite(n)) this.sql.exec('UPDATE conferences SET holds = ? WHERE slug = ? AND holds != ?', n > 0 ? 1 : 0, slug, n > 0 ? 1 : 0);
          }
          this.docs = null;
        }
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, err.body, err.headers);
      // The account's daily limit (for example written rows, which the nonce insert needs): 503
      // daily_limit with Retry-After, which the clients do not retry, rather than a 502 they would.
      if (isDailyLimitError(err)) return dailyLimitResponse();
      console.error(`directory request failed: ${err?.name ?? 'Error'}`);
      return json(502, { error: 'Conferences are temporarily unavailable' });
    }
  }

  // PUT /admin/conferences {conferences: [documents]}: upserts rows (an unchanged document is not
  // rewritten), keeping each slug's route prefix once assigned. Returns, for the Worker to copy
  // into each ConferenceDO, the documents of the searchable conferences and of those whose object
  // was given a document before (has_object), so an object learns that its conference became
  // unavailable and still serves its owners' deletes.
  //
  // A slug with a retired row (DELETE /admin/conference) is skipped and listed in skipped_retired,
  // unless its document carries the top-level key "unretire": true, which deletes the row first.
  // The key is never stored. It must be a boolean when present (400 otherwise, before anything is
  // written); it lives in the body, never the query, so the signature's body hash covers it.
  async #upsert(request) {
    const body = await readJson(request, new Set(['conferences']));
    if (!Array.isArray(body.conferences) || body.conferences.length > 5000) throw bad('conferences must be an array');
    for (const raw of body.conferences) {
      if (isPlainObject(raw) && raw.unretire !== undefined && typeof raw.unretire !== 'boolean') throw bad('unretire must be a boolean');
    }
    const existing = new Map(this.sql.exec('SELECT slug, doc, route_prefix, has_object FROM conferences').toArray().map((r) => [r.slug, r]));
    const retired = new Set(this.sql.exec('SELECT slug FROM retired').toArray().map((r) => r.slug));
    const used = new Set([...existing.values()].map((r) => r.route_prefix));
    const now = Date.now();
    let upserted = 0;
    const searchable = [];
    const skipped = [];
    for (const raw of body.conferences) {
      if (!isPlainObject(raw) || typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug)) continue;
      const { _id, unretire, ...doc } = raw;
      if (retired.has(doc.slug)) {
        if (unretire !== true) {
          if (!skipped.includes(doc.slug)) skipped.push(doc.slug);
          continue;
        }
        this.sql.exec('DELETE FROM retired WHERE slug = ?', doc.slug);
        retired.delete(doc.slug);
      }
      const text = JSON.stringify(doc);
      const prev = existing.get(doc.slug);
      let prefix = prev?.route_prefix;
      if (!prefix) {
        for (let i = 0; ; i++) {
          prefix = await prefixFor(doc.slug, i ? String(i) : '');
          if (!used.has(prefix)) break;
        }
        used.add(prefix);
      }
      const status = doc.status === 'searchable' ? 'searchable' : 'unavailable';
      const hasObject = status === 'searchable' || prev?.has_object === 1;
      if (!prev || prev.doc !== text || (hasObject && prev.has_object !== 1)) {
        this.sql.exec(
          `INSERT INTO conferences (slug, doc, status, start_date, end_date, name, route_prefix, updated_at_ms, has_object, holds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET doc = excluded.doc, status = excluded.status, start_date = excluded.start_date,
             end_date = excluded.end_date, name = excluded.name, updated_at_ms = excluded.updated_at_ms, has_object = excluded.has_object,
             holds = MAX(holds, excluded.holds)`,
          // A new object is assumed to hold data until the cron has looked (holds).
          doc.slug, text, status, doc.start_date ?? null, doc.end_date ?? null, doc.name ?? null, prefix, now, hasObject ? 1 : 0, hasObject && prev?.has_object !== 1 ? 1 : 0,
        );
      }
      upserted += 1;
      if (hasObject) searchable.push({ slug: doc.slug, doc, route_prefix: prefix });
    }
    this.docs = null;
    return json(200, { upserted, searchable, skipped_retired: skipped });
  }

  // DELETE /internal/conference/<slug>: deletes the conference row (removed: 1, or 0 when the
  // directory did not know it) and writes or refreshes its tombstone. Idempotent.
  #retire(slug) {
    const removed = this.sql.exec('DELETE FROM conferences WHERE slug = ? RETURNING 1', slug).toArray().length;
    this.sql.exec('INSERT INTO retired (slug, at_ms) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET at_ms = excluded.at_ms', slug, Date.now());
    this.docs = null;
    return json(200, { ok: true, removed });
  }

  // GET /admin/stats without event: the day's usage per conference and the conferences whose object
  // still held personal data at the last cron visit, both as the cron stored them (it runs every 10
  // minutes): {day, usage: {<slug>: {requests, rows_read, rows_written}}, holds: {<slug>: true}}.
  // day is null before the first cron run. A conference whose stored totals belong to another UTC
  // day than the cron's is left out of usage, as the cron's own sums leave it out.
  #stats() {
    let stored = null;
    try {
      stored = JSON.parse(this.sql.exec("SELECT v FROM meta WHERE k = 'usage'").toArray()[0]?.v ?? 'null');
    } catch {
      stored = null;
    }
    const day = typeof stored?.day === 'string' ? stored.day : null;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const usage = {};
    const totals = isPlainObject(stored?.usage) ? stored.usage : {};
    for (const slug of Object.keys(totals).sort()) {
      const u = totals[slug];
      if (!SLUG_RE.test(slug) || !isPlainObject(u) || day === null || u.day !== day) continue;
      usage[slug] = { requests: n(u.requests), rows_read: n(u.rows_read), rows_written: n(u.rows_written) };
    }
    const holds = Object.fromEntries(this.sql.exec('SELECT slug FROM conferences WHERE holds = 1 ORDER BY slug').toArray().map((r) => [r.slug, true]));
    return json(200, { day, usage, holds });
  }

  // The conferences whose object the cron visits, whatever their status: those with an object
  // whose end_date is at most 3 days ago, and those whose object still held personal data at the
  // last visit (holds), so a conference that turned unavailable, or ended long ago, is purged
  // until it is empty. Returned with the usage totals the last cron run stored.
  #cronTargets() {
    const cutoff = utcDay(Date.now() - CRON_DAYS_AFTER_END * 24 * 3600_000);
    const targets = this.#rows()
      .filter((r) => r.has_object && (r.holds || (typeof r.doc.end_date === 'string' && r.doc.end_date >= cutoff)))
      .map((r) => ({ slug: r.slug }));
    let usage = { day: null, usage: {} };
    try {
      usage = JSON.parse(this.sql.exec("SELECT v FROM meta WHERE k = 'usage'").toArray()[0]?.v ?? 'null') ?? usage;
    } catch {
      /* keep the empty totals */
    }
    return json(200, { targets, day: usage.day, usage: usage.usage ?? {} });
  }
}
