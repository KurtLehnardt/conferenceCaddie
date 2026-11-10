// DirectoryDO 'global': the conference list, the slug to meet-id prefix map the Worker routes
// with, the public conference list, and the cron's cross-conference usage totals (PLAN sections
// 1.2, 1.4, 1.5 and 1.14). API codes and other internal fields never leave this object except to
// a ConferenceDO through the admin fan-out.

import { DurableObject } from 'cloudflare:workers';
import { migrateDirectory } from './schema.js';
import { HttpError, bad, json, readJson, isPlainObject, SLUG_RE } from './lib/http.js';
import { utcDay } from './lib/time.js';

const CONFERENCES_PER_MIN = 120;
const CRON_DAYS_AFTER_END = 3;

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
      this.docs = this.sql.exec('SELECT slug, doc, status, route_prefix FROM conferences').toArray().map((r) => {
        let doc = {};
        try {
          doc = JSON.parse(r.doc);
        } catch {
          doc = { slug: r.slug };
        }
        return { slug: r.slug, status: r.status, route_prefix: r.route_prefix, doc };
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
            slug: r.slug, status: r.status, route_prefix: r.route_prefix, end_date: r.doc.end_date ?? null, time_zone: r.doc.time_zone ?? null,
          })),
        });
      }
      if (path === '/admin/conferences' && request.method === 'PUT') return await this.#upsert(request);
      if (path === '/internal/cron-targets') return this.#cronTargets();
      if (path === '/internal/usage' && request.method === 'PUT') {
        const body = await readJson(request, new Set(['day', 'usage']));
        if (typeof body.day !== 'string' || !isPlainObject(body.usage)) throw bad('day and usage are required');
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('usage', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify({ day: body.day, usage: body.usage }));
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, err.body, err.headers);
      console.error(`directory request failed: ${err?.name ?? 'Error'}`);
      return json(502, { error: 'Conferences are temporarily unavailable' });
    }
  }

  // PUT /admin/conferences {conferences: [documents]}: upserts rows (an unchanged document is not
  // rewritten), keeping each slug's route prefix once assigned. Returns the searchable ones with
  // their documents, for the Worker to copy into each ConferenceDO.
  async #upsert(request) {
    const body = await readJson(request, new Set(['conferences']));
    if (!Array.isArray(body.conferences) || body.conferences.length > 5000) throw bad('conferences must be an array');
    const existing = new Map(this.sql.exec('SELECT slug, doc, route_prefix FROM conferences').toArray().map((r) => [r.slug, r]));
    const used = new Set([...existing.values()].map((r) => r.route_prefix));
    const now = Date.now();
    let upserted = 0;
    const searchable = [];
    for (const raw of body.conferences) {
      if (!isPlainObject(raw) || typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug)) continue;
      const { _id, ...doc } = raw;
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
      if (!prev || prev.doc !== text) {
        this.sql.exec(
          `INSERT INTO conferences (slug, doc, status, start_date, end_date, name, route_prefix, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET doc = excluded.doc, status = excluded.status, start_date = excluded.start_date,
             end_date = excluded.end_date, name = excluded.name, updated_at_ms = excluded.updated_at_ms`,
          doc.slug, text, status, doc.start_date ?? null, doc.end_date ?? null, doc.name ?? null, prefix, now,
        );
      }
      upserted += 1;
      if (status === 'searchable') searchable.push({ slug: doc.slug, doc, route_prefix: prefix });
    }
    this.docs = null;
    return json(200, { upserted, searchable });
  }

  // Searchable conferences whose end_date is at most 3 days ago, with the usage totals the last
  // cron run stored.
  #cronTargets() {
    const cutoff = utcDay(Date.now() - CRON_DAYS_AFTER_END * 24 * 3600_000);
    const targets = this.#rows()
      .filter((r) => r.status === 'searchable' && typeof r.doc.end_date === 'string' && r.doc.end_date >= cutoff)
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
