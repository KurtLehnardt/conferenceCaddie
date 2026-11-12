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
// DELETE /internal/conference/<slug>: the Worker's last step of DELETE /admin/conference; GET of
// the same path answers whether the slug has a tombstone.
const RETIRE_PATH_RE = /^\/internal\/conference\/([a-z0-9][a-z0-9-]{0,119})$/;
// The meta row that holds the order sequence of removals and unretires (see #nextSeq), and the
// prefix of the meta row that holds, per slug, the sequence number of its latest unretire.
const SEQ_KEY = 'order_seq';
const UNRETIRED_SEQ_PREFIX = 'unretired_seq:';
const isSeq = (n) => Number.isSafeInteger(n) && n > 0;

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

  // The next number of the order sequence, which ranks every removal (DELETE /admin/conference,
  // at its tombstone step) and every unretire (PUT /admin/conferences with "unretire": true, per
  // slug) in the order the directory committed them. It is persisted in meta and only grows; a
  // directory without the row starts at 0, so the first number is 1. Called inside the caller's
  // transaction, so the number and the write it orders commit together. The Worker passes a
  // removal's number to the object's wipe and to step 3, and an unretire's number to the object
  // with its document: the object takes whichever of the two came later by this number, and step 3
  // deletes the row only when no unretire of the slug came after its removal. So when a removal
  // and an unretire of one conference overlap, the later of the two wins everywhere.
  #nextSeq() {
    const prev = Number(this.sql.exec('SELECT v FROM meta WHERE k = ?', SEQ_KEY).toArray()[0]?.v ?? 0);
    const next = (Number.isSafeInteger(prev) && prev > 0 ? prev : 0) + 1;
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', SEQ_KEY, String(next));
    return next;
  }

  // The sequence number of the slug's latest unretire, or 0 when it was never unretired.
  #unretiredSeq(slug) {
    const v = Number(this.sql.exec('SELECT v FROM meta WHERE k = ?', UNRETIRED_SEQ_PREFIX + slug).toArray()[0]?.v ?? 0);
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
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
      if (path === '/admin/conference/retire' && request.method === 'POST') return this.#retireFirst(new URL(request.url));
      // The last step of a conference removal. The Worker calls it only after the tombstone step
      // and the object's /internal/wipe accepted the request's nonce, so it records none (W2).
      // GET answers whether the slug has a tombstone, for a removal whose wipe the object refused.
      const drop = RETIRE_PATH_RE.exec(path);
      if (drop && request.method === 'DELETE') return this.#dropRow(drop[1], new URL(request.url));
      if (drop && request.method === 'GET') return json(200, { retired: this.sql.exec('SELECT 1 FROM retired WHERE slug = ?', drop[1]).toArray().length > 0 });
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
  // unless a document of that slug in the batch carries the top-level key "unretire": true (read
  // in a first pass, so the order of duplicates does not matter). Then the row is deleted in the
  // same transaction as the upsert, after it. Every slug the batch unretires takes the next number
  // of the order sequence (#nextSeq), recorded as the slug's latest unretire, and every fan-out
  // entry of that slug carries it as unretired: <number> and is sent whatever the status
  // (has_object set), with or without a tombstone: that flag is the only fan-out a removed object
  // accepts (conference.js, retired_at), and only when its number is higher than the object's
  // last wipe, so an unretire repeated after its fan-out failed or was refused still clears the
  // object's marker with a new, higher number (the Worker answers 502 for such a failure, so the
  // client repeats it). The key is never stored. It must be
  // a boolean when present (400 otherwise, before anything is written); it lives in the body,
  // never the query, so the signature's body hash covers it. The route prefixes are computed first
  // (an await), then every write runs in one transaction against the tombstones as they are at that
  // moment, so a removal that ran meanwhile is honoured.
  //
  // A document may also carry the top-level key "expect_status": the status the operator expects
  // the slug's directory row to have now ("searchable" or "unavailable", as stored), or null for
  // no row (the state after a completed removal). It is checked inside the transaction, before any
  // write, against the rows as stored at that moment. When any document of the batch does not
  // match, the whole request answers 409 {error: "status_mismatch", mismatched: [{slug, expected,
  // actual}]} (actual null when there is no row, one entry per mismatching document in batch
  // order) and nothing is written: no row, no tombstone, no number of the order sequence, and no
  // fan-out, since the Worker returns the answer as it is. A value that is neither a non-empty
  // string nor null is 400, before anything is written. The key is never stored, and a document
  // without it is upserted as before. A request that matched and was applied, then retried by the
  // client because its answer was lost, can mismatch on the retry: the row now has the status the
  // first attempt set. That 409 is the expected answer and is not hidden.
  async #upsert(request) {
    const body = await readJson(request, new Set(['conferences']));
    if (!Array.isArray(body.conferences) || body.conferences.length > 5000) throw bad('conferences must be an array');
    const unretiring = new Set();
    for (const raw of body.conferences) {
      if (!isPlainObject(raw)) continue;
      // A key that differs from "expect_status" or "unretire" only in letter case or surrounding
      // whitespace would skip the check or the flag and be stored and fanned out as part of the
      // document, so the request is refused instead and the answer names the key as it must be.
      for (const key of Object.keys(raw)) {
        const folded = key.trim().toLowerCase();
        if ((folded === 'expect_status' || folded === 'unretire') && key !== folded) throw bad(`the key must be written exactly "${folded}"`);
      }
      if (raw.unretire !== undefined && typeof raw.unretire !== 'boolean') throw bad('unretire must be a boolean');
      if (raw.unretire === true && typeof raw.slug === 'string') unretiring.add(raw.slug);
      if (Object.hasOwn(raw, 'expect_status') && raw.expect_status !== null && (typeof raw.expect_status !== 'string' || raw.expect_status === '')) {
        throw bad('expect_status must be a non-empty string or null');
      }
    }
    const existing = new Map(this.sql.exec('SELECT slug, route_prefix FROM conferences').toArray().map((r) => [r.slug, r.route_prefix]));
    const used = new Set(existing.values());
    const planned = [];
    for (const raw of body.conferences) {
      if (!isPlainObject(raw) || typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug)) continue;
      const { _id, unretire, expect_status: expected, ...doc } = raw;
      let prefix = existing.get(doc.slug);
      if (!prefix) {
        for (let i = 0; ; i++) {
          prefix = await prefixFor(doc.slug, i ? String(i) : '');
          if (!used.has(prefix)) break;
        }
        used.add(prefix);
        existing.set(doc.slug, prefix);
      }
      planned.push({ doc, prefix, expects: Object.hasOwn(raw, 'expect_status'), expected });
    }
    const now = Date.now();
    let upserted = 0;
    const searchable = [];
    const skipped = [];
    const unretireSeq = new Map();
    const mismatched = [];
    this.state.storage.transactionSync(() => {
      const retired = new Set(this.sql.exec('SELECT slug FROM retired').toArray().map((r) => r.slug));
      // Every precondition is checked against the rows as they are before this request writes
      // anything, so a mismatch takes no number of the order sequence and changes nothing. The
      // statuses are read only when the request carries a precondition, so a request without one
      // runs exactly as before.
      const expecting = planned.filter((p) => p.expects);
      if (expecting.length) {
        const stored = new Map(this.sql.exec('SELECT slug, status FROM conferences').toArray().map((r) => [r.slug, r.status]));
        for (const { doc, expected } of expecting) {
          const actual = stored.get(doc.slug) ?? null;
          if (actual !== expected) mismatched.push({ slug: doc.slug, expected, actual });
        }
        if (mismatched.length) return;
      }
      const current = new Map(this.sql.exec('SELECT slug, doc, route_prefix, has_object FROM conferences').toArray().map((r) => [r.slug, r]));
      for (const { doc, prefix: plannedPrefix } of planned) {
        const wasRetired = retired.has(doc.slug);
        if (wasRetired && !unretiring.has(doc.slug)) {
          if (!skipped.includes(doc.slug)) skipped.push(doc.slug);
          continue;
        }
        const text = JSON.stringify(doc);
        const prev = current.get(doc.slug);
        const prefix = prev?.route_prefix ?? plannedPrefix;
        const status = doc.status === 'searchable' ? 'searchable' : 'unavailable';
        // An unretired conference's object is sent its document whatever the status, so it drops
        // the removal marker; it then holds a document, which is what has_object records.
        const unretired = unretiring.has(doc.slug);
        if (unretired && !unretireSeq.has(doc.slug)) {
          const seq = this.#nextSeq();
          unretireSeq.set(doc.slug, seq);
          this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', UNRETIRED_SEQ_PREFIX + doc.slug, String(seq));
        }
        const hasObject = status === 'searchable' || prev?.has_object === 1 || unretired;
        if (!prev || prev.doc !== text || (hasObject && prev.has_object !== 1)) {
          this.sql.exec(
            `INSERT INTO conferences (slug, doc, status, start_date, end_date, name, route_prefix, updated_at_ms, has_object, holds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET doc = excluded.doc, status = excluded.status, start_date = excluded.start_date,
               end_date = excluded.end_date, name = excluded.name, updated_at_ms = excluded.updated_at_ms, has_object = excluded.has_object,
               holds = MAX(holds, excluded.holds)`,
            // A new object is assumed to hold data until the cron has looked (holds).
            doc.slug, text, status, doc.start_date ?? null, doc.end_date ?? null, doc.name ?? null, prefix, now, hasObject ? 1 : 0, hasObject && prev?.has_object !== 1 ? 1 : 0,
          );
          current.set(doc.slug, { slug: doc.slug, doc: text, route_prefix: prefix, has_object: hasObject ? 1 : 0 });
        }
        if (wasRetired) {
          this.sql.exec('DELETE FROM retired WHERE slug = ?', doc.slug);
          retired.delete(doc.slug);
        }
        upserted += 1;
        if (hasObject) searchable.push({ slug: doc.slug, doc, route_prefix: prefix, ...(unretired ? { unretired: unretireSeq.get(doc.slug) } : {}) });
      }
    });
    if (mismatched.length) return json(409, { error: 'status_mismatch', mismatched });
    this.docs = null;
    return json(200, { upserted, searchable, skipped_retired: skipped });
  }

  // POST /admin/conference/retire?event=<slug> (step 1 of DELETE /admin/conference): writes or
  // refreshes the slug's tombstone and keeps its conferences row. Reached through the /admin/*
  // check above, so the request's nonce is recorded first and a replay is 401 before any write.
  // Answers {ok, already_retired_at, seq}: the time of the earlier tombstone (ISO), or null, so a
  // removal retried after its first answer was lost can say it had already happened; and the
  // removal's number in the order sequence (#nextSeq), taken in the same transaction, which the
  // Worker passes to the wipe and to step 3 and never shows the client.
  #retireFirst(url) {
    const slug = url.searchParams.get('event');
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('event must be a conference slug');
    let before = null;
    let seq = 0;
    this.state.storage.transactionSync(() => {
      before = this.sql.exec('SELECT at_ms FROM retired WHERE slug = ?', slug).toArray()[0]?.at_ms ?? null;
      this.sql.exec('INSERT INTO retired (slug, at_ms) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET at_ms = excluded.at_ms', slug, Date.now());
      seq = this.#nextSeq();
    });
    return json(200, { ok: true, already_retired_at: before === null ? null : new Date(Number(before)).toISOString(), seq });
  }

  // DELETE /internal/conference/<slug>?seq=<n> (step 3, after the object's wipe), n being the
  // removal's number from step 1: deletes the conference row only while a tombstone exists and no
  // unretire of the slug came after the removal by the order sequence (removed: 1, or 0 when the
  // directory did not know the slug), and never writes a tombstone. Otherwise an unretire ran
  // during the removal and its row and object are the conference now: 409 {error:
  // "removal_superseded", retired}, retired saying whether a tombstone exists (a later removal's),
  // and nothing deleted. A later removal of the slug finishes on its own, with its own number.
  // Idempotent.
  #dropRow(slug, url) {
    const seq = Number(url.searchParams.get('seq'));
    if (!isSeq(seq)) throw bad('seq must be a positive integer');
    let removed = 0;
    let retired = false;
    let superseded = false;
    this.state.storage.transactionSync(() => {
      retired = this.sql.exec('SELECT 1 FROM retired WHERE slug = ?', slug).toArray().length > 0;
      superseded = !retired || this.#unretiredSeq(slug) > seq;
      if (!superseded) removed = this.sql.exec('DELETE FROM conferences WHERE slug = ? AND EXISTS (SELECT 1 FROM retired WHERE slug = ?) RETURNING 1', slug, slug).toArray().length;
    });
    if (superseded) return json(409, { error: 'removal_superseded', retired });
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
