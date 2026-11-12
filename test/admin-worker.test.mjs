// The tier 2 adapter of the caddie-admin CLI (scripts/admin/backends/worker.mjs and the conference
// file layer in scripts/admin/commands/conferences.mjs), driven in-process through main() against
// a loopback stand-in for the Worker's admin routes (the shapes of worker/src/admin.js and of the
// peer's operator routes, PR #69).
//
// Run with `npm test`. Nothing here reaches the network: the CLI's fetch is the real one but the
// api is a loopback server answering from memory; child processes (gh) are recorded by an injected
// spawn and never started. The stand-in verifies every admin request's X-Caddie-Admin header with
// verifyAdminSignature, checks the body hash, refuses a GET or DELETE with a body, refuses a nonce
// it has seen, and records every request; a failed check fails the test. The token is a dummy
// string that every run checks is absent from stdout, stderr, the audit file, every request URL,
// header and body, and every child argument list and environment.
//
// The tests check
// - SEC-4, SEC-13, SEC-15, SEC-16, CLI-8, CONF-13: signing, re-signing on a retry, no redirect,
//   the optional Access headers, no body on GET and DELETE, the query-key allow-list;
// - ATT-1 to ATT-4, ATT-7, ATT-9, ATT-10: search (q64), view with the privacy rule, delete, block
//   and unblock, and the 404-after-retry rule (PEER-6): a 404 is "already done" only after an
//   attempt that may have run (a 5xx, a reset once connected), and only with a target code;
//   "Not found" is a refusal, exit 4, and a 2xx must carry a JSON object ("ok": true for writes);
// - MOD-2, MOD-4, MOD-5, MOD-6, MOD-7: queue, hide, unhide, delete, purge-reports, and exit 5 for
//   purge-expired and rules;
// - CONF-1, CONF-3, CONF-4, CONF-7, CONF-8, CONF-12: list, add and refresh through gh, hide and
//   unhide through PUT /admin/conferences, remove through DELETE /admin/conference, unretire with
//   the flag on the document, refused for a typo or for a slug the Worker lists with another status;
// - the stand-in models the failed-signature limiter, 415 without Content-Type, the moderation
//   body key rule, a listed conference whose object was wiped, a removal overtaken at step wipe or
//   directory (#69 at c74612d), and an unretire fan-out that fails with a cause (503 daily_limit,
//   502 unretire_superseded or conference_retired);
// - the unretire's expect_status precondition (#79): the stand-in models the DirectoryDO's first
//   pass (400 for a near-miss of "expect_status" or "unretire" and for an invalid value) and the
//   check (409 status_mismatch for the whole batch, nothing written); the tests cover a matching
//   unretire, a removal or an unretire landing between the read and the PUT, each documented
//   repair flow, the retry's expectation after an answer that proves a commit (for searchable and
//   other documents, and a removal landing between the attempts) and not after one that does not,
//   the earlier attempts named only when the row shows the status sent, a version mismatch, the
//   near-miss keys of a local document (sent, written back, and handed to the adapter directly),
//   skipped_retired, and a listing that does not say what the row holds;
// - STAT-1 to STAT-3: counts, usage and health, with the smoke and log commands naming variables.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODYLESS_METHODS, HEADER_NAME, bodyMatches, signAdminRequest, verifyAdminSignature } from '../scripts/lib/admin-sign.mjs';
import { main } from '../scripts/admin/cli.mjs';
import { createWorkerAdapter, workerOrigin } from '../scripts/admin/backends/worker.mjs';
import { shellPath } from '../scripts/lib/admin-token-file.mjs';

const realFetch = globalThis.fetch;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN ='dummy-worker-admin-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const ACCESS_ID = 'dummy-access-client-id.access';
const ACCESS_SECRET = 'dummy-access-client-secret-0123456789abcdef';
const EVENT = 'testconf-2099';
const OTHER = 'otherconf-2099';
const NOTE = 'fixture-note-text-that-must-not-travel';
const LINE = 'fixture rules test line that must not be logged';
const MEET = 'AbCdEfGhIjKlMnOpQrSt_-';
const ALLOWED_QUERY_KEYS = new Set(['event', 'ref', 'q64', 'limit', 'include_hidden', 'fields', 'since']);
const SENTINELS = {
  profile_id: 'SENTINEL-PROFILE-ID', secret_hash: 'SENTINEL-SECRET-HASH', zone: 'SENTINEL-ZONE', position: { lat: 51.5, lon: -0.1 }, cell: 'SENTINEL-CELL',
  ble_token: 'SENTINEL-BLE-TOKEN', push_endpoint: 'https://push.example/SENTINEL-ENDPOINT', reporter_ids: ['SENTINEL-REPORTER'], leaked_extra: 'SENTINEL-EXTRA',
};
const NEVER = ['SENTINEL-PROFILE-ID', 'SENTINEL-SECRET-HASH', 'SENTINEL-ZONE', '51.5', 'SENTINEL-CELL', 'SENTINEL-BLE-TOKEN', 'SENTINEL-ENDPOINT', 'SENTINEL-REPORTER', 'SENTINEL-EXTRA'];
const TEXT = ['SENTINEL-ABOUT', 'SENTINEL-INTERESTS', 'SENTINEL-EXPERTISE', 'SENTINEL-CONTACT-NOTE', 'SENTINEL-SPOT', 'SENTINEL-PENDING'];
const CONTACT = ['SENTINEL-LINKEDIN'];

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const refOf = (n) => n.toString(16).padStart(16, '0');
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ---- the stand-in ----

function newPerson(ref, name, fields = {}) {
  return {
    ref, display_name: name, hidden: false, spot_hidden: false, open_to_meet: true, sample: false, visible_until: '2099-12-31T23:59:59.000Z', updated_at: '2026-11-10T08:00:00.000Z',
    presence: 'off', shared_talks: 0, meets: { requested: 0, accepted: 0, declined: 0, ended: 0, other: 0 }, blocks_made: 0, blocks_received: 0, push: 0,
    about: null, interests: null, expertise: null, contact_note: null, spot: null, pending: {}, linkedin_url: null,
    reporters: [], ...fields,
  };
}

function stubWorker() {
  const state = {
    people: new Map(),
    staleOperatorReports: new Set(),
    meets: new Map(),
    conferences: [],
    retired: new Set(),
    wiped: [],
    puts: [],
    tables: { talks: 3, topics: 1, facets: 1, people: 2, shared_talks: 4, presence: 1, blocks: 1, meets: 1, reports: 2, push_subs: 1, nudges: 0, vectors: 3 },
    usage: { day: '2026-11-11', requests: 120, rows_read: 900, rows_written: 30, pace: 1.5 },
    account: { day: '2026-11-11', usage: { [EVENT]: { requests: 120, rows_read: 900, rows_written: 30 }, [OTHER]: { requests: 7, rows_read: 10, rows_written: 1 } }, holds: { [EVENT]: true } },
    conferenceEnded: false,
    // Conferences the directory still lists whose object was wiped (a removal an unretire
    // overtook): reads answer 200 with nothing, writes 400 "conference is not available".
    wipedObjects: new Set(),
    // The failed-signature limiter: from 10 refused signatures on, every admin request, a validly
    // signed one included, answers 404 "Not found" (worker/src/index.js adminAuth).
    failedSignatures: 0,
    // A later unretire that overtakes the next removal (#69 at c74612d): { step: 'wipe' | 'directory',
    // retired: true | false | null }. At step wipe the object refuses the wipe and nothing is
    // deleted; at step directory the object was wiped and the directory keeps the row.
    supersede: null,
    // An unretire fan-out that fails: { status: 503, cause: 'daily_limit', retryAfter } or
    // { status: 502, cause: 'unretire_superseded' | 'conference_retired' }, with `times` for a
    // failure of that many requests only. The directory's upsert still commits, as in the Worker.
    fanOutFailure: null,
    // How many PUT /admin/conferences answered 409 status_mismatch (and wrote nothing).
    mismatches: 0,
  };
  const requests = [];
  const nonces = new Set();
  const problems = [];
  // Answers to force on the next admin requests, in order: { status, body, headers, act,
  // pathWithQuery } where act runs the handler for its side effects before the forced answer is
  // sent (an answer that was lost), and pathWithQuery, when given, waits for that request.
  const forced = [];

  const personCounts = (p) => ({
    shared_talks: p.shared_talks, meets: { ...p.meets }, blocks_made: p.blocks_made, blocks_received: p.blocks_received, push: { web: p.push },
    reports: { total: p.reporters.length, reasons: p.reporters.reduce((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {}) },
  });
  const personRow = (p) => ({ ref: p.ref, display_name: p.display_name, hidden: p.hidden, spot_hidden: p.spot_hidden, open_to_meet: p.open_to_meet, sample: p.sample, visible_until: p.visible_until });
  const hiddenByReports = (p) => new Set(p.reporters.map((r) => r.id)).size >= 2 || p.reporters.some((r) => r.id === 'operator');

  function handle(method, url, body) {
    const path = url.pathname;
    const sp = url.searchParams;
    const event = sp.get('event');
    const parsed = () => {
      try { return JSON.parse(body.toString('utf8') || '{}'); } catch { return null; }
    };
    if (path === '/admin/conferences') {
      if (method !== 'PUT') return [405, { error: 'Method not allowed' }, { Allow: 'PUT' }];
      const b = parsed();
      // Only `conferences` at the top level, as the DirectoryDO's readJson allows; the flag lives
      // on each document.
      const unknown = Object.keys(b ?? {}).find((k) => k !== 'conferences');
      if (unknown !== undefined) return [400, { error: `Unknown key: ${unknown}` }];
      if (!Array.isArray(b?.conferences)) return [400, { error: 'conferences must be an array' }];
      // The DirectoryDO's first pass (worker/src/directory.js #upsert, #79), before anything is
      // written: a key that differs from "expect_status" or "unretire" only in letter case or
      // surrounding whitespace, a non-boolean unretire, and an expect_status that is neither a
      // non-empty string nor null are each a 400. The CLI never sends any of them, so each is also
      // a problem the test reports.
      for (const d of b.conferences) {
        if (d === null || typeof d !== 'object' || Array.isArray(d)) continue;
        for (const key of Object.keys(d)) {
          const folded = key.trim().toLowerCase();
          if ((folded === 'expect_status' || folded === 'unretire') && key !== folded) {
            problems.push(`PUT /admin/conferences: a near-miss key ${JSON.stringify(key)}`);
            return [400, { error: `the key must be written exactly as ${folded}` }];
          }
        }
        if (d.unretire !== undefined && typeof d.unretire !== 'boolean') return [400, { error: 'unretire must be a boolean' }];
        if (Object.hasOwn(d, 'expect_status') && d.expect_status !== null && (typeof d.expect_status !== 'string' || d.expect_status === '')) {
          problems.push('PUT /admin/conferences: an invalid expect_status');
          return [400, { error: 'expect_status must be a non-empty string or null' }];
        }
      }
      // The precondition, checked against the rows as stored before this request writes anything:
      // any document that does not match makes the whole request a 409 that writes nothing (no
      // row, no tombstone dropped, no removal marker cleared), one entry per mismatching document
      // in request order, actual null when the slug has no row.
      const mismatched = [];
      for (const d of b.conferences) {
        if (!Object.hasOwn(d, 'expect_status')) continue;
        const actual = state.conferences.find((c) => c.slug === d.slug)?.status ?? null;
        if (actual !== d.expect_status) mismatched.push({ slug: d.slug, expected: d.expect_status, actual });
      }
      if (mismatched.length) {
        state.mismatches += 1;
        return [409, { error: 'status_mismatch', mismatched }];
      }
      const skipped = [];
      let upserted = 0;
      let searchable = 0;
      for (const d of b.conferences) {
        if (state.retired.has(d.slug) && d.unretire !== true) { skipped.push(d.slug); continue; }
        state.retired.delete(d.slug);
        // The fan-out of an unretire clears the object's removal marker.
        if (d.unretire === true) state.wipedObjects.delete(d.slug);
        const { unretire, expect_status: expected, ...doc } = d;
        state.puts.push(doc);
        const i = state.conferences.findIndex((c) => c.slug === doc.slug);
        const row = { ...(i >= 0 ? state.conferences[i] : {}), ...doc, status: doc.status === 'searchable' ? 'searchable' : 'unavailable' };
        if (i >= 0) state.conferences[i] = row; else state.conferences.push(row);
        upserted += 1;
        if (row.status === 'searchable') searchable += 1;
      }
      const unretiring = b.conferences.filter((d) => d.unretire === true).map((d) => d.slug);
      const f = state.fanOutFailure;
      if (f && unretiring.length) {
        if (f.times !== undefined && --f.times <= 0) state.fanOutFailure = null;
        // The unretired objects keep their removal marker; the answer names the cause first.
        for (const s of unretiring) state.wipedObjects.add(s);
        const rest = { error: 'unretire_incomplete', unretire_failed: unretiring, upserted, searchable, synced: upserted - unretiring.length, skipped_retired: skipped };
        if (f.status === 503) return [503, { cause: 'daily_limit', ...rest }, f.retryAfter ? { 'Retry-After': f.retryAfter } : {}];
        return [502, { cause: f.cause, ...rest }];
      }
      return [200, { upserted, searchable, synced: upserted, skipped_retired: skipped }];
    }
    if (path === '/admin/conference') {
      if (method !== 'DELETE') return [405, { error: 'Method not allowed' }, { Allow: 'DELETE' }];
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(event ?? '')) return [400, { error: 'event must be a conference slug' }];
      // Tombstone first (its nonce check refuses a replay before any write), then the wipe, then
      // the directory row; a second removal reports already_retired_at.
      const known = state.conferences.some((c) => c.slug === event);
      const s = state.supersede;
      if (s?.step === 'wipe') return [409, { error: 'removal_superseded', step: 'wipe', retired: s.retired, wiped: false }];
      if (s?.step === 'directory') {
        state.wiped.push(event);
        return [409, { error: 'removal_superseded', step: 'directory', retired: s.retired, wiped: true, deleted: { talks: 3, people: 2 } }];
      }
      const already = { already_retired_at: state.retired.has(event) ? '2025-11-11T00:00:00.000Z' : null };
      state.retired.add(event);
      const deleted = state.wiped.includes(event) ? Object.fromEntries(Object.keys(state.tables).map((k) => [k, 0])) : { talks_fts: 3, ...state.tables, usage_days: 1, meta: 2 };
      delete deleted.vectors;
      state.wiped.push(event);
      state.conferences = state.conferences.filter((c) => c.slug !== event);
      return [200, { ok: true, deleted, directory: known ? 1 : 0, retired: true, ...already }];
    }
    if (path === '/admin/stats' && event === null) {
      if (method !== 'GET') return [405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' }];
      // Any query key is a 400, so a misspelt event= never answers the totals instead.
      if (url.search !== '') return [400, { error: `Unknown parameter: ${[...sp.keys()][0] ?? ''}` }];
      return [200, state.account];
    }
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(event ?? '')) return [400, { error: 'event must be a conference slug' }];
    if (!state.conferences.some((c) => c.slug === event)) return [400, { error: 'conference is not available' }];
    if (state.wipedObjects.has(event)) {
      // A wiped object without its document (worker/src/conference.js): it takes no admin write,
      // and reads see it empty.
      if (method !== 'GET') return [400, { error: 'conference is not available' }];
      if (path === '/admin/stats') return [200, { ...Object.fromEntries(Object.keys(state.tables).map((k) => [k, 0])), usage: state.usage }];
      if (path === '/admin/people/search') return sp.has('ref') ? [404, { error: 'not_found' }] : [200, { people: [], matched: 0 }];
      if (path === '/admin/people/view') return [404, { error: 'not_found' }];
      if (path === '/admin/moderation') return [200, { hidden: [], reports: [] }];
    }
    if (path === '/admin/stats') return [200, { ...state.tables, usage: state.usage }];
    if (path === '/admin/people/search') {
      const keys = [...sp.keys()];
      if (keys.some((k) => !['event', 'q64', 'ref', 'limit', 'include_hidden'].includes(k))) return [400, { error: 'unknown query key' }];
      if (sp.has('q64') === sp.has('ref')) return [400, { error: 'give exactly one of q64 and ref' }];
      if (sp.has('ref')) {
        const p = state.people.get(sp.get('ref'));
        return p ? [200, { people: [personRow(p)], matched: 1 }] : [404, { error: 'not_found' }];
      }
      const text = Buffer.from(sp.get('q64'), 'base64url').toString('utf8');
      if (!text || Buffer.byteLength(text) > 200) return [400, { error: 'q64 must be base64url without padding of 1 to 200 bytes of UTF-8' }];
      const limit = sp.has('limit') ? Number(sp.get('limit')) : 50;
      if (!/^[1-9][0-9]{0,2}$/.test(sp.get('limit') ?? '1') || limit > 200) return [400, { error: 'limit must be 1 to 200' }];
      const inc = sp.get('include_hidden');
      if (inc !== null && inc !== '0' && inc !== '1') return [400, { error: 'include_hidden must be 0 or 1' }];
      const all = [...state.people.values()].filter((p) => p.display_name.toLowerCase().includes(text.toLowerCase()) && (inc === '1' || !p.hidden)).sort((a, b) => a.display_name.localeCompare(b.display_name));
      return [200, { people: all.slice(0, limit).map(personRow), matched: all.length }];
    }
    if (path === '/admin/people/view') {
      const keys = [...sp.keys()];
      if (keys.some((k) => !['event', 'ref', 'fields'].includes(k))) return [400, { error: 'unknown query key' }];
      const p = state.people.get(sp.get('ref') ?? '');
      if (!p) return [404, { error: 'not_found' }];
      const fields = new Set((sp.get('fields') ?? '').split(',').filter(Boolean));
      if ([...fields].some((f) => f !== 'text' && f !== 'contact')) return [400, { error: "fields must be a comma list of 'text' and 'contact'" }];
      const person = { ...personRow(p), updated_at: p.updated_at, presence: p.presence, counts: personCounts(p), ...SENTINELS };
      if (fields.has('text')) Object.assign(person, { about: p.about, interests: p.interests, expertise: p.expertise, contact_note: p.contact_note, spot: p.spot, pending: p.pending });
      if (fields.has('contact')) person.linkedin_url = p.linkedin_url;
      return [200, { person }];
    }
    if (path === '/admin/people/block') {
      if (method !== 'POST') return [405, { error: 'Method not allowed' }];
      const b = parsed();
      if (!b || !/^[0-9a-f]{16}$/.test(b.ref ?? '') || !['block', 'unblock'].includes(b.action) || Object.keys(b).length !== 2) return [400, { error: 'bad body' }];
      const p = state.people.get(b.ref);
      if (!p) {
        if (b.action === 'unblock' && state.staleOperatorReports.has(b.ref)) {
          state.staleOperatorReports.delete(b.ref);
          return [200, { ok: true, hidden: null, found: false, removed: true }];
        }
        return [404, { error: 'not_found' }];
      }
      if (b.action === 'block') {
        if (!p.reporters.some((r) => r.id === 'operator')) p.reporters.push({ id: 'operator', reason: 'operator' });
        p.hidden = true;
        return [200, { ok: true, hidden: true }];
      }
      if (!p.reporters.some((r) => r.id === 'operator')) return [404, { error: 'no_operator_block' }];
      p.reporters = p.reporters.filter((r) => r.id !== 'operator');
      p.hidden = hiddenByReports(p);
      return [200, { ok: true, hidden: p.hidden, found: true, removed: true }];
    }
    if (path === '/admin/moderation' && method === 'GET') {
      const hidden = [];
      for (const p of [...state.people.values()].sort((a, b) => a.display_name.localeCompare(b.display_name))) {
        const counts = personCounts(p).reports;
        if (p.hidden) hidden.push({ kind: 'profile', display_name: p.display_name, ref: p.ref, reports: counts.total, reasons: counts.reasons });
        if (p.spot_hidden) hidden.push({ kind: 'spot', display_name: p.display_name, ref: p.ref, reports: counts.total, reasons: counts.reasons });
      }
      for (const m of state.meets.values()) if (m.hidden) hidden.push({ kind: 'meet', meet_id: m.meet_id, state: m.state, between: m.between, reports: m.reports.length, reasons: {} });
      const sinceMs = sp.has('since') ? Date.parse(sp.get('since')) : 0;
      if (!Number.isFinite(sinceMs)) return [400, { error: 'since must be an ISO 8601 instant' }];
      const reports = [];
      for (const p of state.people.values()) {
        for (const r of p.reporters) if (Date.parse(r.at ?? '2026-11-10T09:00:00.000Z') >= sinceMs) reports.push({ created_at: r.at ?? '2026-11-10T09:00:00.000Z', kind: 'profile', reason: r.reason, target: { kind: 'profile', ref: p.ref, display_name: p.display_name } });
      }
      for (const m of state.meets.values()) for (const r of m.reports) reports.push({ created_at: '2026-11-10T09:30:00.000Z', kind: 'meet', reason: r, target: { kind: 'meet', meet_id: m.meet_id, state: m.state, between: m.between } });
      return [200, { hidden, reports }];
    }
    if (path === '/admin/moderation' && method === 'POST') {
      const b = parsed();
      if (!b) return [400, { error: 'bad json' }];
      // readJson's key rule (worker/src/lib/http.js): a key outside action, kind and id is a 400.
      const extra = Object.keys(b).find((k) => !['action', 'kind', 'id'].includes(k));
      if (extra !== undefined) {
        problems.push(`POST /admin/moderation: unknown body key ${extra}`);
        return [400, { error: `Unknown key: ${extra}` }];
      }
      if (b.action === 'purge') {
        if (!state.conferenceEnded) return [200, { ok: true, purged: 0, ends_at: '2099-12-31T23:59:59.000Z' }];
        let purged = 0;
        for (const p of state.people.values()) { purged += p.reporters.length; p.reporters = []; }
        return [200, { ok: true, purged }];
      }
      if (!['hide', 'unhide', 'delete'].includes(b.action)) return [400, { error: "action must be 'hide', 'unhide', 'delete' or 'purge'" }];
      if (b.kind === 'meet') {
        if (b.action === 'hide') return [400, { error: "kind must be 'profile' or 'spot' to hide" }];
        const m = state.meets.get(b.id);
        if (!m) return [404, { error: 'not_found' }];
        if (b.action === 'delete') { state.meets.delete(b.id); return [200, { ok: true }]; }
        const removed = m.reports.length;
        m.hidden = false;
        m.reports = [];
        return [200, { ok: true, found: true, removed }];
      }
      const p = state.people.get(b.id);
      if (b.action === 'hide') {
        if (!p) return [404, { error: 'not_found' }];
        if (!p.reporters.some((r) => r.id === 'operator')) p.reporters.push({ id: 'operator', reason: 'operator' });
        if (b.kind === 'profile') p.hidden = true; else { p.spot_hidden = true; p.spot = null; }
        return [200, { ok: true }];
      }
      if (b.action === 'unhide') {
        if (!p) {
          if (state.staleOperatorReports.has(b.id)) { state.staleOperatorReports.delete(b.id); return [200, { ok: true, found: false, removed: 1 }]; }
          return [404, { error: 'not_found' }];
        }
        const removed = p.reporters.length;
        p.reporters = [];
        if (b.kind === 'profile') p.hidden = false; else p.spot_hidden = false;
        return [200, { ok: true, found: true, removed }];
      }
      if (!p) return [404, { error: 'not_found' }];
      if (b.kind === 'profile') state.people.delete(b.id); else { p.spot = null; p.spot_hidden = true; }
      return [200, { ok: true }];
    }
    return [404, { error: 'Not found' }];
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stub');
      const record = { method: req.method, path: url.pathname, query: [...url.searchParams.keys()], pathWithQuery: url.pathname + url.search, body: body.toString('utf8'), headers: { ...req.headers } };
      requests.push(record);
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/capabilities') return json(res, 200, { tier: 2, ble: { mode: 'off' }, push: { apns: false, fcm: false } });
      if (url.pathname === '/api/conferences') {
        return json(res, 200, { conferences: state.conferences.map((c) => ({ slug: c.slug, name: c.name ?? '', start_date: c.start_date ?? null, end_date: c.end_date ?? null, status: c.status, talk_count: c.counts?.talk ?? 0 })) });
      }
      if (!url.pathname.startsWith('/admin/')) return json(res, 404, { error: 'Not found' });
      // The Worker's checks, in its order: the signature over method, path and query, the empty
      // body on GET and DELETE, the body hash, then the nonce.
      if (req.headers.authorization !== undefined) problems.push(`${record.method} ${record.path}: an Authorization header was sent`);
      if (req.headers.origin !== undefined) problems.push(`${record.method} ${record.path}: an Origin header was sent`);
      // The failed-signature limiter is peeked before the signature is checked: once it is empty,
      // every request is refused, a valid one included.
      if (state.failedSignatures >= 10) return json(res, 404, { error: 'Not found' });
      // As the Worker with ADMIN_ORIGIN unset: v1 or v2, a v2 signature bound to this stand-in's
      // own origin (the api in the config), so one signed for any other origin is refused.
      const v = verifyAdminSignature({ headerValue: req.headers['x-caddie-admin'] ?? null, method: req.method, pathWithQuery: record.pathWithQuery, keys: [TOKEN], allowedVersions: [1, 2], expectedOrigins: [`http://127.0.0.1:${server.address().port}`] });
      record.nonce = v.nonce ?? null;
      record.version = v.ok ? (v.version ?? 1) : null;
      if (!v.ok) {
        if (v.reason === 'signature') state.failedSignatures += 1;
        problems.push(`${record.method} ${record.pathWithQuery}: signature ${v.reason}`);
        return json(res, 404, { error: 'Not found' });
      }
      if (BODYLESS_METHODS.has(req.method) && body.length > 0) problems.push(`${record.method} ${record.path}: a body on a bodyless method`);
      if (!bodyMatches(v.bodySha256, body)) {
        problems.push(`${record.method} ${record.path}: the body hash does not match`);
        return json(res, 401, { error: 'admin_body' });
      }
      if (nonces.has(v.nonce)) return json(res, 401, { error: 'admin_replay' });
      nonces.add(v.nonce);
      // A body goes with Content-Type: application/json, or readJson answers 415.
      if (body.length > 0 && (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        problems.push(`${record.method} ${record.path}: a body without Content-Type: application/json`);
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }
      const at = forced.findIndex((f) => f.pathWithQuery === undefined || f.pathWithQuery === record.pathWithQuery);
      const force = at >= 0 ? forced.splice(at, 1)[0] : undefined;
      if (force) {
        if (force.act) handle(req.method, url, body);
        record.forced = force.status;
        return json(res, force.status, force.body ?? { error: 'forced' }, force.headers ?? {});
      }
      const [status, answer, headers] = handle(req.method, url, body);
      return json(res, status, answer, headers);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, state, requests, problems, forced, url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// ---- the harness ----

let home;
let root;
let stub;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'caddie-admin-worker-home-'));
  root = mkdtempSync(join(tmpdir(), 'caddie-admin-worker-root-'));
  stub = await stubWorker();
  stub.state.conferences.push({ slug: EVENT, name: 'Test Conf', status: 'searchable', start_date: '2099-12-30', end_date: '2099-12-31', counts: { talk: 12 } });
  stub.state.conferences.push({ slug: OTHER, name: 'Other', status: 'unavailable', start_date: '2099-01-01', end_date: '2099-01-02', counts: { talk: 0 } });
  writeConfig({ default: 't2', backends: { t2: { tier: 2, api: stub.url } } });
});
afterEach(async () => {
  await stub.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(config) {
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

function auditLines() {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Runs main() with the real adapter factory against the stand-in. `spawn` records child processes
// instead of starting them. Every run checks the token leaks nowhere and the stand-in saw no bad
// request.
async function invoke(argv, { spawnResult, env = {}, tolerateProblems = false, fetch = realFetch, trackSend } = {}) {
  // The version every verified admin request must carry: v2 unless CADDIE_ADMIN_SIG_VERSION is "1".
  const signVersion = env.CADDIE_ADMIN_SIG_VERSION === '1' ? 1 : 2;
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { status: 0, stdout: '', stderr: '', ...(typeof spawnResult === 'function' ? spawnResult(args) : spawnResult ?? {}) };
  };
  const out = sink();
  const err = sink();
  const before = stub.requests.length;
  const code = await main(argv, {
    env: { CADDIE_ADMIN_HOME: home, CADDIE_ADMIN_ROOT: root, ADMIN_TOKEN: TOKEN, ...env },
    stdout: out,
    stderr: err,
    stdin: { isTTY: false },
    isTTY: false,
    now: () => new Date(),
    spawn,
    fetch,
    ...(trackSend ? { trackSend } : {}),
  });
  const stdout = out.text();
  const stderr = err.text();
  const auditText = existsSync(join(home, 'audit.jsonl')) ? readFileSync(join(home, 'audit.jsonl'), 'utf8') : '';
  for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['audit', auditText]]) {
    for (const secret of [TOKEN, ACCESS_SECRET]) assert.ok(!text.includes(secret), `a secret leaked into ${where}`);
  }
  const requests = stub.requests.slice(before);
  for (const r of requests) {
    assert.ok(!JSON.stringify(r).includes(TOKEN), `the token leaked into a request to ${r.path}`);
    assert.equal(r.headers.authorization, undefined, 'no Authorization header');
    if (r.method === 'GET' || r.method === 'DELETE') assert.equal(r.body, '', `${r.method} ${r.path} carries no body`);
    if (r.path.startsWith('/api/')) {
      assert.equal(r.headers['x-caddie-admin'], undefined, 'public routes are not signed');
      assert.equal(r.headers['cf-access-client-id'], undefined, 'public routes carry no Access headers');
      // Never a cached copy: the listing is served with max-age=60.
      assert.equal(r.headers['cache-control'], 'no-cache', `${r.path} asks for no cached copy`);
      assert.deepEqual(r.query, r.path === '/api/conferences' ? ['fresh'] : [], `${r.path} query`);
    } else {
      for (const key of r.query) assert.ok(ALLOWED_QUERY_KEYS.has(key), `query key ${key} on ${r.path} (CONF-13: flags travel in the body)`);
      if (r.version !== null && r.version !== undefined) assert.equal(r.version, signVersion, `${r.method} ${r.path} is signed v${signVersion}`);
    }
  }
  if (!tolerateProblems) assert.deepEqual(stub.problems, [], 'the stand-in saw a bad admin request');
  for (const child of spawned) {
    assert.ok(!JSON.stringify([child.file, child.args, child.options?.env]).includes(TOKEN), 'the token leaked into a child process');
    assert.equal(child.options?.env?.ADMIN_TOKEN, undefined, 'the child environment has no ADMIN_TOKEN');
  }
  return { code, stdout, stderr, audit: auditLines(), requests, spawned, json: () => JSON.parse(stdout) };
}

// A fetch whose first calls fail as a network error with the given codes, then the real one. With
// `after`, a failing call first reaches the stand-in (the request runs) and then fails, as a
// connection that broke before the answer came back.
function flakyFetch(codes, { after = false } = {}) {
  const queue = [...codes];
  return async (url, init) => {
    const code = queue.shift();
    if (code === undefined) return realFetch(url, init);
    if (after) await (await realFetch(url, init)).text();
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error(code), { code });
    throw err;
  };
}

// A request-sent probe that reports every attempt as written to a socket, for a fetch that throws
// without undici (so the real probe never fires).
const SENT = () => ({ sent: () => true, stop() {} });
// A fetch whose first answer is a 5xx whose body cannot be read, then the real one.
function lostBodyFetch(status) {
  let first = true;
  return async (url, init) => {
    if (!first || !String(url).includes('/admin/')) return realFetch(url, init);
    first = false;
    const body = new ReadableStream({ start(c) { c.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); } });
    return new Response(body, { status });
  };
}

const confirmed = (argv, target) => [...argv, '--yes', '--confirm', target];
const admins = (requests) => requests.filter((r) => r.path.startsWith('/admin/'));

function person(name, fields = {}) {
  const ref = refOf(stub.state.people.size + 1);
  const p = newPerson(ref, name, fields);
  stub.state.people.set(ref, p);
  return p;
}

function seedConferenceFiles(slug, { talks = true, status = 'searchable', statusReason = null } = {}) {
  mkdirSync(join(root, 'data', slug), { recursive: true });
  writeFileSync(join(root, 'data', slug, 'conference.json'), `${JSON.stringify({ slug, name: `Conference ${slug}`, status, status_reason: statusReason, start_date: '2099-12-01', end_date: '2099-12-03', raw_fetched_at: '2026-11-01T00:00:00.000Z', counts: { talk: 2 } }, null, 2)}\n`);
  if (talks) writeFileSync(join(root, 'data', slug, 'talks.ndjson'), '{"talk_id":"a"}\n{"talk_id":"b"}\n');
  mkdirSync(join(root, 'data', 'raw', slug), { recursive: true });
  writeFileSync(join(root, 'data', 'raw', slug, 'lf-event.json'), '{}\n');
  writeFileSync(join(root, 'data', 'conference-operator.json'), '{\n  "hidden": {},\n  "removed": {}\n}\n');
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const operatorFile = () => readJson(join(root, 'data', 'conference-operator.json'));

// ---------------------------------------------------------------------------------------------

describe('SEC-4, SEC-13, SEC-15, SEC-16, CLI-8 transport', () => {
  test('every admin request is signed, verified by the stand-in, and carries no Authorization header', async () => {
    person('Ann Lee');
    const r = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests).length, 1);
    assert.match(admins(r.requests)[0].headers['x-caddie-admin'], /^v2 \d+ [A-Za-z0-9_-]{22} [0-9a-f]{64} [0-9a-f]{64}$/);
  });

  // Step c of the migration (DECISIONS.md, "Admin signature v2"): v2 by default, bound to the
  // configured api's origin; CADDIE_ADMIN_SIG_VERSION=1 is the rollback to v1 until step d; empty
  // counts as unset (GitHub Actions passes an undefined variable as "").
  test('the signature is v2 by default, bound to the api origin; CADDIE_ADMIN_SIG_VERSION=1 signs v1 and "" means 2', async () => {
    const verify = (call, allowedVersions, expectedOrigins) => verifyAdminSignature({ headerValue: call.headers['x-caddie-admin'], method: call.method, pathWithQuery: call.pathWithQuery, keys: [TOKEN], allowedVersions, expectedOrigins });
    for (const [env, version] of [[{}, 2], [{ CADDIE_ADMIN_SIG_VERSION: '' }, 2], [{ CADDIE_ADMIN_SIG_VERSION: '2' }, 2], [{ CADDIE_ADMIN_SIG_VERSION: '1' }, 1]]) {
      const r = await invoke(['stats', 'counts', '--event', EVENT], { env });
      assert.equal(r.code, 0, `${JSON.stringify(env)}: ${r.stderr}`);
      const [call] = admins(r.requests);
      assert.equal(call.version, version, JSON.stringify(env));
      // The rollback is never silent: one warning under "1", none otherwise.
      assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('caddie-admin: warning: CADDIE_ADMIN_SIG_VERSION=1: ')).length, version === 1 ? 1 : 0, r.stderr);
      assert.ok(call.headers['x-caddie-admin'].startsWith(`v${version} `));
      if (version === 2) {
        assert.equal(verify(call, [2], [stub.url]).origin, stub.url);
        // The same header for another origin is a plain signature failure, and a v1-only verifier
        // reads it as malformed.
        for (const origin of [stub.url.replace('127.0.0.1', 'localhost'), stub.url.replace('http:', 'https:'), 'https://conference-caddie.example']) {
          assert.equal(verify(call, [2], [origin]).reason, 'signature', origin);
        }
        assert.equal(verify(call, [1]).reason, 'malformed');
      } else {
        assert.equal(verify(call, [1]).ok, true);
        assert.equal(verify(call, [2], [stub.url]).reason, 'malformed', 'a v2-only Worker (step d) refuses it');
      }
    }
  });

  test('a CADDIE_ADMIN_SIG_VERSION other than unset, empty, "1" or "2" is a usage error (exit 2) before any request', async () => {
    for (const raw of ['3', ' 2', '02', 'v2', '1 ', 'true']) {
      const r = await invoke(['stats', 'counts', '--event', EVENT], { env: { CADDIE_ADMIN_SIG_VERSION: raw } });
      assert.equal(r.code, 2, JSON.stringify(raw));
      assert.match(r.stderr, /CADDIE_ADMIN_SIG_VERSION must be exactly "1" or "2" when it is set/);
      assert.equal(r.requests.length, 0, JSON.stringify(raw));
      const j = await invoke(['stats', 'counts', '--event', EVENT, '--json'], { env: { CADDIE_ADMIN_SIG_VERSION: raw } });
      assert.equal(JSON.parse(j.stderr).error, 'usage');
    }
    // The adapter reads the env it is given, never process.env.
    assert.throws(() => createWorkerAdapter({ name: 't2', tier: 2, api: stub.url }, { credential: TOKEN, env: { CADDIE_ADMIN_SIG_VERSION: '3' } }), (e) => e.exitCode === 2 && /CADDIE_ADMIN_SIG_VERSION/.test(e.message));
    assert.doesNotThrow(() => createWorkerAdapter({ name: 't2', tier: 2, api: stub.url }, { credential: TOKEN, env: { CADDIE_ADMIN_SIG_VERSION: '1' } }));
  });

  // The api as configured goes through canonicalOrigin before any URL parsing: each of these parses
  // to the stand-in's own origin, so the code before step c would have signed and sent to it.
  test('the api as configured must pass canonicalOrigin: a full-width, percent-encoded or user-name api is exit 2 before any request', async () => {
    const port = new URL(stub.url).port;
    const apis = [`http://\uff11\uff12\uff17.0.0.1:${port}`, `http://127.0.0.%31:${port}`, `http://ops@127.0.0.1:${port}`];
    for (const api of apis) {
      assert.equal(new URL(api).origin, stub.url, `${api} parses to the stand-in`);
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api } } });
      const r = await invoke(['stats', 'counts', '--event', EVENT]);
      assert.equal(r.code, 2, api);
      assert.match(r.stderr, /api must be the Worker's origin as plain ASCII/);
      assert.equal(stub.requests.length, 0);
    }
    // Typed plainly (upper case, a final "/"), the same origin works and signs v2 for it.
    writeConfig({ default: 't2', backends: { t2: { tier: 2, api: `HTTP://127.0.0.1:${port}/` } } });
    const ok = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(admins(ok.requests)[0].version, 2);
  });

  test('workerOrigin reads the configured api strictly and returns its origin', () => {
    const origin = (api) => workerOrigin({ name: 't2', api });
    assert.equal(origin('https://Caddie.Example:443/'), 'https://caddie.example');
    assert.equal(origin('https://xn--bcher-kva.example'), 'https://xn--bcher-kva.example');
    assert.equal(origin('http://localhost:8787'), 'http://localhost:8787');
    for (const api of ['https://caddie.example%E3%80%82evil.example', 'https://b\u00fccher.example', 'https://caddie\uff0eexample', 'https://caddie.example\\', 'https://@caddie.example', 'https://caddie.example/admin', 'https://caddie.example/?x=1', 'https:caddie.example', 'http://10.0.0.5:8787', 'ftp://caddie.example', '', undefined]) {
      assert.throws(() => origin(api), (e) => e.exitCode === 2, String(api));
    }
  });

  test('a retry is signed afresh with a new nonce; a 503 and a 429 are retried, a 404 and a 400 are not', async () => {
    person('Ann Lee');
    stub.forced.push({ status: 503, body: { error: 'try again' } }, { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } });
    const r = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(r.code, 0, r.stderr);
    const calls = admins(r.requests);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.nonce)).size, 3, 'three different nonces');
    assert.equal(new Set(calls.map((c) => c.headers['x-caddie-admin'])).size, 3, 'three different signatures');
    const bad = await invoke(['stats', 'counts', '--event', 'nosuch-2099']);
    assert.equal(bad.code, 4);
    assert.equal(admins(bad.requests).length, 1, 'a 400 is not retried');
    stub.forced.push({ status: 404, body: { error: 'Not found' } });
    const gone = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(gone.code, 4);
    assert.equal(admins(gone.requests).length, 1, 'a 404 is not retried');
    assert.match(gone.stderr, /refused: check the admin key, the failed-signature rate limit or the route/);
  });

  test('a 503 daily_limit, an admin_skew and an admin_replay stop at once with a clear message', async () => {
    stub.forced.push({ status: 503, body: { error: 'daily_limit' } });
    const limit = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(limit.code, 1);
    assert.match(limit.stderr, /daily limit is reached; try again after 00:00 UTC/);
    assert.equal(admins(limit.requests).length, 1);
    stub.forced.push({ status: 401, body: { error: 'admin_skew' } });
    const skew = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(skew.code, 1);
    assert.match(skew.stderr, /clock is more than five minutes from the Worker's/);
    stub.forced.push({ status: 401, body: { error: 'admin_replay' } });
    assert.match((await invoke(['stats', 'counts', '--event', EVENT])).stderr, /saw this nonce before/);
  });

  test('a redirect is refused at once, never followed and never retried, on admin and public routes', async () => {
    const hops = [];
    const redirecting = http.createServer((req, res) => {
      hops.push(req.url);
      res.writeHead(302, { location: `${stub.url}${req.url}` });
      res.end('moved');
    });
    await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    try {
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api: `http://127.0.0.1:${redirecting.address().port}` } } });
      const r = await invoke(['stats', 'counts', '--event', EVENT]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /status 302, a redirect; admin requests never follow redirects/);
      assert.equal(hops.length, 1, 'one attempt, no retry');
      assert.equal(stub.requests.length, 0, 'the redirect target was never called');
      const pub = await invoke(['conferences', 'list']);
      assert.equal(pub.code, 1);
      assert.match(pub.stderr, /a redirect/);
      assert.equal(stub.requests.length, 0);
    } finally {
      await new Promise((resolve) => redirecting.close(resolve));
    }
  });

  test('a redirect whose body stalls and never ends is refused at once, well before the timeout, and its target is never contacted', async () => {
    // The headers of a 302 arrive, then a first chunk of a body that never ends (chunked, no
    // Content-Length). The CLI cancels the body without waiting for it, so it neither hangs until
    // TIMEOUT_MS (60 s) nor follows the Location.
    const hops = [];
    const sockets = new Set();
    const stalling = http.createServer((req, res) => {
      hops.push(req.url);
      res.writeHead(302, { location: `${stub.url}${req.url}`, 'content-type': 'text/plain' });
      res.write('moved, and the rest never comes');
    });
    stalling.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    try {
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api: `http://127.0.0.1:${stalling.address().port}` } } });
      for (const [argv, message] of [
        [['stats', 'counts', '--event', EVENT], /GET \/admin\/stats: status 302, a redirect; admin requests never follow redirects/],
        [['conferences', 'list'], /GET \/api\/conferences: status 302, a redirect/],
      ]) {
        const before = hops.length;
        const started = Date.now();
        const r = await invoke(argv);
        const took = Date.now() - started;
        assert.equal(r.code, 1, r.stderr);
        assert.match(r.stderr, message);
        assert.ok(took < 2000, `${argv.join(' ')} took ${took} ms`);
        assert.equal(hops.length - before, 1, 'one attempt, no retry');
        assert.equal(stub.requests.length, 0, 'the redirect target was never contacted');
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => stalling.close(resolve));
    }
  });

  test('the Access headers are sent only when both variables are set, on admin routes only, and never logged', async () => {
    const without = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(admins(without.requests)[0].headers['cf-access-client-id'], undefined);
    const half = await invoke(['stats', 'counts', '--event', EVENT], { env: { CF_ACCESS_CLIENT_ID: ACCESS_ID } });
    assert.equal(admins(half.requests)[0].headers['cf-access-client-id'], undefined);
    const both = await invoke(['stats', 'health'], { env: { CF_ACCESS_CLIENT_ID: ACCESS_ID, CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET } });
    assert.equal(both.code, 0, both.stderr);
    const signedBoth = await invoke(['stats', 'counts', '--event', EVENT], { env: { CF_ACCESS_CLIENT_ID: ACCESS_ID, CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET } });
    const h = admins(signedBoth.requests)[0].headers;
    assert.equal(h['cf-access-client-id'], ACCESS_ID);
    assert.equal(h['cf-access-client-secret'], ACCESS_SECRET);
    assert.ok(!signedBoth.stdout.includes(ACCESS_ID) && !JSON.stringify(signedBoth.audit).includes(ACCESS_ID));
  });

  test('the api must be the Worker origin: a path, a query or a non-loopback http url is refused before any request', async () => {
    for (const api of [`${stub.url}/admin`, `${stub.url}/?x=1`, 'http://10.0.0.5:8787']) {
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api } } });
      const r = await invoke(['stats', 'counts', '--event', EVENT]);
      assert.equal(r.code, 2, api);
      assert.equal(stub.requests.length, 0);
    }
  });

  test('a credential file of mode 0600 is read and trimmed; the token file wins over nothing else', async () => {
    writeFileSync(join(home, 'admin-token'), `${TOKEN}\n`, { mode: 0o600 });
    const r = await invoke(['stats', 'counts', '--event', EVENT], { env: { ADMIN_TOKEN: '' } });
    assert.equal(r.code, 0, r.stderr);
  });

  test('a wrong token is a 404 from the Worker, reported as not found or refused', async () => {
    const r = await invoke(['stats', 'counts', '--event', EVENT], { env: { ADMIN_TOKEN: 'wrong-token-0123456789-abcdefghijklmnopqrstuvwxyz' }, tolerateProblems: true });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /refused: check the admin key, the failed-signature rate limit or the route \(the Worker answers 404 "Not found" to each\)/);
    assert.deepEqual(stub.problems.map((p) => p.split(': ').at(-1)), ['signature signature']);
    stub.problems.length = 0;
  });

  test('the failed-signature limiter refuses even a valid signature: exit 4, "refused", no retry', async () => {
    stub.state.failedSignatures = 10;
    const r = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(r.code, 4);
    assert.equal(admins(r.requests).length, 1);
    assert.match(r.stderr, /refused: check the admin key, the failed-signature rate limit or the route/);
    assert.equal(r.audit.at(-1).result, 'not_found');
  });
});

describe('ATT-1, ATT-2 attendees search', () => {
  test('--name travels as q64, matches a substring, excludes hidden people unless asked, and is never audited', async () => {
    const ann = person('Ann Lee');
    person('Bob Stone');
    const hidden = person('ANNA HIDDEN', { hidden: true });
    const r = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Ann Lee', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const call = admins(r.requests)[0];
    assert.equal(call.pathWithQuery, `/admin/people/search?event=${EVENT}&q64=${Buffer.from('Ann Lee').toString('base64url')}&limit=50`);
    const { result } = r.json();
    assert.deepEqual(result.items.map((i) => i.ref), [ann.ref]);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['display_name', 'hidden', 'open_to_meet', 'ref', 'sample', 'spot_hidden', 'visible_until']);
    assert.deepEqual(result.counts, { matched: 1, shown: 1 });
    const all = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'ann', '--include-hidden', '--json']);
    assert.match(admins(all.requests)[0].pathWithQuery, /&include_hidden=1$/);
    assert.deepEqual(all.json().result.items.map((i) => i.ref).sort(), [ann.ref, hidden.ref].sort());
    assert.ok(!JSON.stringify(all.audit).includes('ann') && !JSON.stringify(all.audit).includes('Ann Lee'), 'the search text and the names are not audited');
    assert.deepEqual(all.audit.at(-1).flags, ['include-hidden']);
    const human = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Lee', '--limit', '1']);
    assert.match(human.stdout, /^ref=[0-9a-f]{16} display_name=Ann Lee hidden=false spot_hidden=false open_to_meet=true sample=false visible_until=2099/);
    assert.match(human.stdout, /1 attendee matched at testconf-2099 \(hidden excluded\)/);
    // Free text with characters outside the query charset still passes, through q64.
    const odd = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'a% _b\\ \u00e9&=']);
    assert.equal(odd.code, 0, odd.stderr);
    assert.match(admins(odd.requests)[0].pathWithQuery, /^\/admin\/people\/search\?event=testconf-2099&q64=[A-Za-z0-9_-]+&limit=50$/);
    assert.match(odd.stdout, /0 attendees matched/);
  });

  test('--limit is capped at 200 for the Worker and said so; a name over 200 bytes exits 2', async () => {
    for (let i = 0; i < 3; i++) person(`Lee ${i}`);
    const r = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Lee', '--limit', '1000', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(admins(r.requests)[0].pathWithQuery, /&limit=200$/);
    const two = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Lee', '--limit', '2']);
    assert.match(two.stdout, /3 attendees matched at testconf-2099, 2 shown \(--limit\)/);
    const long = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'x'.repeat(201)]);
    assert.equal(long.code, 2);
    const nul = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'a\u0000b']);
    assert.equal(nul.code, 2);
    assert.match(nul.stderr, /NUL/);
    assert.equal(stub.requests.length - admins(r.requests).length - admins(two.requests).length, 0, 'no request for the long name or the NUL');
  });

  test('--ref finds exactly that person, hidden or not, or exits 4', async () => {
    const ann = person('Ann Lee', { hidden: true });
    person('Bob Stone');
    const r = await invoke(['attendees', 'search', '--event', EVENT, '--ref', ann.ref, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests)[0].pathWithQuery, `/admin/people/search?event=${EVENT}&ref=${ann.ref}`);
    assert.deepEqual(r.json().result.items.map((i) => i.display_name), ['Ann Lee']);
    const missing = await invoke(['attendees', 'search', '--event', EVENT, '--ref', '0123456789abcdef']);
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /profile 0123456789abcdef at testconf-2099: no such target \(the Worker answered not_found\)/);
    assert.equal(missing.audit.at(-1).result, 'not_found');
  });
});

describe('ATT-3, ATT-4 attendees view', () => {
  function seedViewed() {
    return person('Viewed Person', {
      spot_hidden: true, presence: 'on', shared_talks: 2, meets: { requested: 1, accepted: 1, declined: 0, ended: 0, other: 0, found: 3 }, blocks_made: 1, blocks_received: 2, push: 1,
      about: 'SENTINEL-ABOUT', interests: 'SENTINEL-INTERESTS', expertise: 'SENTINEL-EXPERTISE', contact_note: 'SENTINEL-CONTACT-NOTE', spot: 'SENTINEL-SPOT', pending: { spot: 'SENTINEL-PENDING' },
      linkedin_url: 'https://www.linkedin.com/in/SENTINEL-LINKEDIN', reporters: [{ id: 'r1', reason: 'spam' }, { id: 'r2', reason: 'harassment' }],
    });
  }

  for (const asJson of [false, true]) {
    test(`default fields only, --text and --contact add theirs, forbidden and unknown fields never (${asJson ? '--json' : 'human'})`, async () => {
      const { ref } = seedViewed();
      const flag = asJson ? ['--json'] : [];
      const base = await invoke(['attendees', 'view', '--event', EVENT, ref, ...flag]);
      assert.equal(base.code, 0, base.stderr);
      assert.equal(admins(base.requests)[0].pathWithQuery, `/admin/people/view?event=${EVENT}&ref=${ref}`);
      for (const s of [...NEVER, ...TEXT, ...CONTACT]) assert.ok(!base.stdout.includes(s), `${s} in the default view`);
      assert.match(base.stdout, /Viewed Person/);
      assert.match(base.stdout, /spot_hidden=true|"spot_hidden":true/);
      assert.match(base.stdout, /presence=on|"presence":"on"/);
      assert.match(base.stdout, /shared_talks=2|"shared_talks":2/);
      assert.match(base.stdout, /"requested":1/);
      assert.match(base.stdout, /"found":3/, 'a bucket the Worker adds is rendered as it comes');
      assert.match(base.stdout, /meets=5|"meets":5/);
      assert.match(base.stdout, /blocks_made=1|"blocks_made":1/);
      assert.match(base.stdout, /blocks_received=2|"blocks_received":2/);
      assert.match(base.stdout, /"web":1/);
      assert.match(base.stdout, /"total":2/);
      assert.match(base.stdout, /"spam":1/);

      const text = await invoke(['attendees', 'view', '--event', EVENT, ref, '--text', ...flag]);
      assert.equal(admins(text.requests)[0].pathWithQuery, `/admin/people/view?event=${EVENT}&ref=${ref}&fields=text`);
      for (const s of TEXT) assert.ok(text.stdout.includes(s), `${s} under --text`);
      for (const s of [...NEVER, ...CONTACT]) assert.ok(!text.stdout.includes(s), `${s} under --text`);

      const contact = await invoke(['attendees', 'view', '--event', EVENT, ref, '--contact', ...flag]);
      assert.equal(admins(contact.requests)[0].pathWithQuery, `/admin/people/view?event=${EVENT}&ref=${ref}&fields=contact`);
      for (const s of CONTACT) assert.ok(contact.stdout.includes(s), `${s} under --contact`);
      for (const s of [...NEVER, ...TEXT]) assert.ok(!contact.stdout.includes(s), `${s} under --contact`);

      const both = await invoke(['attendees', 'view', '--event', EVENT, ref, '--text', '--contact', ...flag]);
      assert.equal(admins(both.requests)[0].pathWithQuery, `/admin/people/view?event=${EVENT}&ref=${ref}&fields=text,contact`);
      for (const s of NEVER) assert.ok(!both.stdout.includes(s), `${s} under both`);
      if (asJson) assert.equal(both.stdout.trim().split('\n').length, 1);

      const entries = auditLines();
      assert.deepEqual(entries.map((e) => e.flags), [[], ['text'], ['contact'], ['text', 'contact']]);
      assert.equal(entries.at(-1).target, ref);
      assert.deepEqual(entries.at(-1).counts, { meets: 5, blocks_made: 1, blocks_received: 2, push: 1, reports: 2 });
      for (const s of [...NEVER, ...TEXT, ...CONTACT, 'Viewed Person']) assert.ok(!JSON.stringify(entries).includes(s), `${s} in the audit`);
    });
  }

  test('an unknown ref exits 4', async () => {
    const r = await invoke(['attendees', 'view', '--event', EVENT, '0123456789abcdef']);
    assert.equal(r.code, 4);
    assert.equal(r.audit.at(-1).result, 'not_found');
  });
});

describe('ATT-7, ATT-10 attendees delete and the 404-after-retry rule', () => {
  test('the dry-run reads the view only and prints counts, no name; the run sends one POST and nothing else', async () => {
    const p = person('Doomed Person', { meets: { requested: 1, accepted: 1, declined: 0, ended: 0, other: 0 }, blocks_made: 1, push: 1, reporters: [{ id: 'r1', reason: 'spam' }] });
    const dry = await invoke(['attendees', 'delete', '--event', EVENT, p.ref, '--note', NOTE]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(admins(dry.requests).map((r) => `${r.method} ${r.path}`), ['GET /admin/people/view']);
    assert.match(dry.stdout, /profile 1, meets 2, blocks_made 1, push 1, reports 1/);
    assert.match(dry.stdout, /dry-run, nothing changed/);
    assert.ok(!dry.stdout.includes('Doomed Person') && !dry.stdout.includes(NOTE));
    assert.ok(stub.state.people.has(p.ref));
    assert.equal(dry.audit.at(-1).mode, 'dry-run');

    const unconfirmed = await invoke(['attendees', 'delete', '--event', EVENT, p.ref, '--yes']);
    assert.equal(unconfirmed.code, 3);
    assert.equal(admins(unconfirmed.requests).length, 0);
    const wrong = await invoke(['attendees', 'delete', '--event', EVENT, p.ref, '--yes', '--confirm', '0123456789abcdef']);
    assert.equal(wrong.code, 3);
    assert.equal(wrong.audit.at(-1).result, 'refused');

    const r = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, p.ref, '--reason', 'spam', '--note', NOTE], p.ref));
    assert.equal(r.code, 0, r.stderr);
    const calls = admins(r.requests);
    assert.equal(calls.length, 1, 'one request after confirmation');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].pathWithQuery, `/admin/moderation?event=${EVENT}`);
    assert.deepEqual(JSON.parse(calls[0].body), { action: 'delete', kind: 'profile', id: p.ref });
    assert.ok(!stub.state.people.has(p.ref));
    const entry = r.audit.at(-1);
    assert.equal(entry.mode, 'run');
    assert.equal(entry.result, 'ok');
    assert.equal(entry.reason, 'spam');
    assert.equal(entry.target, p.ref);
    assert.deepEqual(entry.counts, { profile: 1 });
    assert.ok(!JSON.stringify(r.audit).includes(NOTE) && !r.stdout.includes(NOTE) && !r.stdout.includes('Doomed Person'));
  });

  test('a 404 on the first attempt is exit 4; a 404 after a lost answer is "already done" and exit 0', async () => {
    const gone = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, '0123456789abcdef'], '0123456789abcdef'));
    assert.equal(gone.code, 4);
    assert.match(gone.stderr, /no such target/);
    const p = person('Lost Answer');
    // The first attempt does the work but its answer is lost (a 503); the retry sees 404.
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const r = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, p.ref], p.ref));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests).length, 2);
    assert.ok(!stub.state.people.has(p.ref));
    assert.match(r.stdout, /profile .*: already done \(an earlier attempt may have run and its answer was lost; the retry answered not_found\)/);
    assert.equal(r.audit.at(-1).result, 'ok');
    assert.equal(r.audit.at(-1).note, 'already_deleted');
    assert.deepEqual(r.audit.at(-1).counts, { profile: 0 });
    const asJson = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `profile:${p.ref}`, '--json'], `profile:${p.ref}`));
    assert.equal(asJson.code, 4, 'a plain 404 stays exit 4');
  });

  test('a 404 counts as done only after an attempt that may have run, and only with a target code', async () => {
    const typo = '0123456789abcdef';
    const del = (ref, opts) => invoke(confirmed(['attendees', 'delete', '--event', EVENT, ref], ref), opts);
    // A 429 is the limiter's, before any handler: the not_found after it is exit 4.
    stub.forced.push({ status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': '0' } });
    const limited = await del(typo);
    assert.equal(limited.code, 4);
    assert.equal(admins(limited.requests).length, 2);
    assert.match(limited.stderr, /no such target/);
    // A refused connection never sent the request: exit 4.
    const refused = await del(typo, { fetch: flakyFetch(['ECONNREFUSED']) });
    assert.equal(refused.code, 4);
    assert.equal(admins(refused.requests).length, 1, 'the refused attempt never reached the stand-in');
    // A typo'd ref after a DNS failure, a connect timeout or a TLS error: exit 4, for a delete and an unblock.
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']) {
      const failed = await del(typo, { fetch: flakyFetch([code]) });
      assert.equal(failed.code, 4, code);
      assert.equal(failed.audit.at(-1).result, 'not_found', code);
    }
    const unblock = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, typo], typo), { fetch: flakyFetch(['ENOTFOUND']) });
    assert.equal(unblock.code, 4);
    // A 503 may have run the handler, but a "Not found" refusal after it is still exit 4.
    const p = person('Refused Later');
    stub.forced.push({ status: 503, body: { error: 'lost' } }, { status: 404, body: { error: 'Not found' } });
    const notFound = await del(p.ref);
    assert.equal(notFound.code, 4);
    assert.match(notFound.stderr, /refused: check the admin key, the failed-signature rate limit or the route/);
    assert.ok(stub.state.people.has(p.ref));
    assert.equal(notFound.audit.at(-1).result, 'not_found');
    // A 503 whose attempt did the work, then not_found: exit 0 with the note.
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const done = await del(p.ref);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.audit.at(-1).note, 'already_deleted');
    // A reset once connected (the request ran, its answer was lost) counts too.
    const q = person('Reset Answer');
    const reset = await del(q.ref, { fetch: flakyFetch(['ECONNRESET'], { after: true }) });
    assert.equal(reset.code, 0, reset.stderr);
    assert.ok(!stub.state.people.has(q.ref));
    assert.match(reset.stdout, /already done/);
  });

  test('only a request written whole may have run: a reset before it was sent is exit 4, and the message says an earlier attempt may have done the work', async () => {
    const typo = '0123456789abcdef';
    const del = (ref, opts) => invoke(confirmed(['attendees', 'delete', '--event', EVENT, ref], ref), opts);
    // A reset or timeout the request-sent probe did not see (a fetch that never wrote it): exit 4,
    // with the earlier failure named.
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CLOSED']) {
      const unsent = await del(typo, { fetch: flakyFetch([code]) });
      assert.equal(unsent.code, 4, code);
      assert.match(unsent.stderr, new RegExp(`no such target \\(the Worker answered not_found\\); an earlier attempt failed \\(${code}\\); if it reached the Worker it may have done the work`));
      assert.equal(unsent.audit.at(-1).result, 'not_found');
    }
    // The same codes after a request the probe saw written: it may have run, so not_found is done.
    for (const code of ['ETIMEDOUT', 'UND_ERR_CLOSED']) {
      const sent = await del(typo, { fetch: flakyFetch([code]), trackSend: SENT });
      assert.equal(sent.code, 0, `${code}: ${sent.stderr}`);
      assert.equal(sent.audit.at(-1).note, 'already_deleted');
    }
    // A 502 whose body could not be read may have run: not_found after it is done.
    const lostBody = await del(typo, { fetch: lostBodyFetch(502) });
    assert.equal(lostBody.code, 0, lostBody.stderr);
    assert.match(lostBody.stdout, /already done/);
    // A reset, then a "Not found" refusal: exit 4, refused, and the earlier attempt named.
    const p = person('Refused After Reset');
    stub.forced.push({ status: 404, body: { error: 'Not found' } });
    const refused = await del(p.ref, { fetch: flakyFetch(['ECONNRESET']) });
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /refused: check the admin key, the failed-signature rate limit or the route \(the Worker answers 404 "Not found" to each\); an earlier attempt failed \(ECONNRESET\); if it reached the Worker it may have done the work/);
    // A write that gives up after four 502s says the work may have been done.
    for (let i = 0; i < 4; i++) stub.forced.push({ status: 502, body: { error: 'Service is temporarily unavailable' } });
    const gaveUp = await del(p.ref);
    assert.equal(gaveUp.code, 1);
    assert.match(gaveUp.stderr, /status 502 \(Service is temporarily unavailable\) \(gave up after 4 attempts; an earlier attempt failed \(status 502 \(Service is temporarily unavailable\)\); if it reached the Worker it may have done the work\)/);
    // A read that gives up says nothing of the kind.
    for (let i = 0; i < 4; i++) stub.forced.push({ status: 502, body: { error: 'Service is temporarily unavailable' } });
    const read = await invoke(['attendees', 'view', '--event', EVENT, p.ref]);
    assert.equal(read.code, 1);
    assert.ok(!/may have done the work/.test(read.stderr));
  });
});

describe('ATT-8, ATT-9 block and unblock', () => {
  test('block posts to /admin/people/block, previews first, and never sends --reason or --note', async () => {
    const p = person('Blocked Person');
    const dry = await invoke(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'harassment', '--note', NOTE]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(admins(dry.requests).map((r) => `${r.method} ${r.path}`), ['GET /admin/people/view']);
    assert.match(dry.stdout, /would set profile .* hidden with an operator report \(0 reports on file\)/);
    assert.equal(p.hidden, false);
    const r = await invoke(confirmed(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'harassment', '--note', NOTE], p.ref));
    assert.equal(r.code, 0, r.stderr);
    const calls = admins(r.requests);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathWithQuery, `/admin/people/block?event=${EVENT}`);
    assert.deepEqual(JSON.parse(calls[0].body), { ref: p.ref, action: 'block' });
    assert.equal(p.hidden, true);
    assert.deepEqual(p.reporters, [{ id: 'operator', reason: 'operator' }]);
    assert.equal(r.audit.at(-1).reason, 'harassment');
    assert.deepEqual(r.audit.at(-1).counts, { reports: 1 });
    assert.ok(!r.stdout.includes(NOTE) && !JSON.stringify(r.audit).includes(NOTE));
    const again = await invoke(confirmed(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'spam'], p.ref));
    assert.equal(again.code, 0, 'blocking twice is harmless');
    assert.equal(p.reporters.length, 1);
    assert.equal((await invoke(confirmed(['attendees', 'block', '--event', EVENT, '0123456789abcdef', '--reason', 'spam'], '0123456789abcdef'))).code, 4);
  });

  test('unblock removes the operator report; the Worker keeps the profile hidden when two others remain', async () => {
    const p = person('Blocked Person', { hidden: true, reporters: [{ id: 'a', reason: 'spam' }, { id: 'b', reason: 'spam' }, { id: 'operator', reason: 'operator' }] });
    const dry = await invoke(['attendees', 'unblock', '--event', EVENT, p.ref]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would remove the operator block of .*; 2 other reports remain/);
    assert.equal(p.reporters.length, 3);
    const r = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(admins(r.requests)[0].body), { ref: p.ref, action: 'unblock' });
    assert.equal(p.reporters.length, 2);
    assert.equal(p.hidden, true);
    assert.match(r.stdout, /removed the operator block of .*; it stays hidden \(other reports remain\)/);
    const one = person('Lightly Reported', { hidden: true, reporters: [{ id: 'a', reason: 'spam' }, { id: 'operator', reason: 'operator' }] });
    const visible = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, one.ref], one.ref));
    assert.equal(visible.code, 0, visible.stderr);
    assert.equal(one.hidden, false);
    assert.match(visible.stdout, /is visible again/);
  });

  test('unblock without an operator block exits 4; after a lost answer it is "already done"; a deleted profile keeps its stale report removable', async () => {
    const p = person('Plain Person');
    const none = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(none.code, 4);
    assert.match(none.stderr, /has no operator block at testconf-2099/);
    const dryNone = await invoke(['attendees', 'unblock', '--event', EVENT, p.ref]);
    assert.match(dryNone.stdout, /has no operator block/);
    // The four answers: after an attempt that may have run (here a 503 whose attempt did the
    // work), a 404 no_operator_block (the block went) or not_found (a deleted profile's stale
    // report went) is "already unblocked" (exit 0); found:true is an unblock; found:false removed
    // a stale report of a deleted profile.
    p.reporters.push({ id: 'operator', reason: 'operator' });
    p.hidden = true;
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const lost = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(lost.code, 0, lost.stderr);
    assert.equal(admins(lost.requests).length, 2);
    assert.match(lost.stdout, /the operator block of .*: already unblocked \(an earlier attempt may have run and its answer was lost; the retry answered no_operator_block\)/);
    assert.equal(lost.audit.at(-1).note, 'already_unblocked');
    assert.equal(lost.audit.at(-1).result, 'ok');
    assert.equal(p.reporters.length, 0);
    // A deleted profile's stale report removed by a lost attempt: the retry answers not_found.
    stub.state.staleOperatorReports.add('0123456789abcdef');
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const staleLost = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, '0123456789abcdef'], '0123456789abcdef'));
    assert.equal(staleLost.code, 0, 'not_found after a lost attempt is "already unblocked"');
    assert.equal(admins(staleLost.requests).length, 2);
    assert.ok(!stub.state.staleOperatorReports.has('0123456789abcdef'), 'the lost attempt did the work');
    assert.match(staleLost.stdout, /the operator block of 0123456789abcdef: already unblocked \(.*the retry answered not_found\)/);
    assert.deepEqual(staleLost.audit.at(-1).counts, { reports: 0 });
    const noPerson = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, '0123456789abcdef'], '0123456789abcdef'));
    assert.equal(noPerson.code, 4, 'not_found on a first attempt is exit 4');
    assert.equal(admins(noPerson.requests).length, 1);
    stub.state.staleOperatorReports.add('fedcba9876543210');
    const stale = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, 'fedcba9876543210'], 'fedcba9876543210'));
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(stale.stdout, /is gone; removed its stale operator report/);
    assert.deepEqual(stale.audit.at(-1).counts, { reports: 1 });
    assert.equal((await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, 'fedcba9876543210'], 'fedcba9876543210'))).code, 4, 'no person and no stale report');
  });
});

describe('MOD-2, MOD-4, MOD-7 moderation queue, hide, unhide, delete, purge-reports', () => {
  function seedModeration() {
    const h = person('Hidden Harry', { hidden: true, reporters: [{ id: 'r1', reason: 'spam' }, { id: 'r2', reason: 'hate' }] });
    const s = person('Spot Sally', { spot_hidden: true, reporters: [{ id: 'r3', reason: 'sexual', at: '2026-11-09T09:00:00.000Z' }] });
    person('Visible Vic');
    stub.state.meets.set(MEET, { meet_id: MEET, state: 'accepted', between: ['Hidden Harry', 'Visible Vic'], hidden: true, reports: ['harassment', 'harassment'] });
    return { h, s };
  }

  test('queue lists hidden targets with counts, names and reasons only with --show-content, and reports since an instant in Z form', async () => {
    const { h, s } = seedModeration();
    const plain = await invoke(['moderation', 'queue', '--event', EVENT, '--json']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(admins(plain.requests)[0].pathWithQuery, `/admin/moderation?event=${EVENT}`);
    const items = plain.json().result.items;
    assert.deepEqual(items.map((i) => [i.list, i.kind, i.id, i.reports]), [['hidden', 'profile', h.ref, 2], ['hidden', 'spot', s.ref, 1], ['hidden', 'meet', MEET, 2]]);
    for (const x of ['Hidden Harry', 'Spot Sally', 'Visible Vic', 'spam', 'hate', 'sexual', 'r1']) assert.ok(!plain.stdout.includes(x), `${x} without --show-content`);
    assert.deepEqual(plain.json().result.counts, { hidden: 3 });
    const shown = await invoke(['moderation', 'queue', '--event', EVENT, '--show-content', '--since', '2026-11-10T00:00:00+00:00', '--json']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(admins(shown.requests)[0].pathWithQuery, `/admin/moderation?event=${EVENT}&since=2026-11-10T00:00:00.000Z`, 'the instant is sent in Z form');
    const { result } = shown.json();
    assert.equal(result.items[0].display_name, 'Hidden Harry');
    assert.deepEqual(result.items[0].reasons, { spam: 1, hate: 1 });
    assert.match(result.items[2].display_name, /^between "Hidden Harry" and "Visible Vic", state accepted$/);
    const reports = result.items.filter((i) => i.list === 'report');
    assert.equal(reports.length, 4, 'the older report is left out');
    assert.deepEqual(reports.map((r) => r.reason).sort(), ['harassment', 'harassment', 'hate', 'spam']);
    assert.ok(!shown.stdout.includes('r1'), 'reporter ids never');
    assert.deepEqual(result.counts, { hidden: 3, reports: 4 });
    assert.match(result.summary, /3 hidden targets at testconf-2099\. 4 reports since 2026-11-10T00:00:00\.000Z/);
    assert.deepEqual(shown.audit.at(-1).flags, ['show-content']);
    assert.ok(!JSON.stringify(shown.audit).includes('Harry'));
  });

  test('hide profile and spot send action hide; a meet is refused by the CLI; unhide clears and reports found and removed', async () => {
    const p = person('Plain Pat', { spot: 'red hat' });
    const dry = await invoke(['moderation', 'hide', '--event', EVENT, `profile:${p.ref}`, '--reason', 'spam']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(admins(dry.requests).map((r) => `${r.method} ${r.path}`), ['GET /admin/people/view']);
    assert.equal(p.hidden, false);
    const hideP = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `profile:${p.ref}`, '--reason', 'spam', '--note', NOTE], `profile:${p.ref}`));
    assert.equal(hideP.code, 0, hideP.stderr);
    assert.deepEqual(JSON.parse(admins(hideP.requests)[0].body), { action: 'hide', kind: 'profile', id: p.ref });
    assert.equal(p.hidden, true);
    assert.equal(hideP.audit.at(-1).reason, 'spam');
    assert.equal(hideP.audit.at(-1).target, `profile:${p.ref}`);
    const hideS = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `spot:${p.ref}`, '--reason', 'other'], `spot:${p.ref}`));
    assert.equal(hideS.code, 0, hideS.stderr);
    assert.equal(p.spot_hidden, true);
    assert.equal(p.spot, null);
    const meet = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `meet:${MEET}`, '--reason', 'spam'], `meet:${MEET}`));
    assert.equal(meet.code, 2);
    assert.equal(stub.requests.length, admins(dry.requests).length + admins(hideP.requests).length + admins(hideS.requests).length, 'no request for the meet');

    const dryUn = await invoke(['moderation', 'unhide', '--event', EVENT, `profile:${p.ref}`]);
    assert.match(dryUn.stdout, /would clear the hidden flag of profile .* and remove up to 1 report, those of this profile/);
    assert.equal(p.hidden, true);
    const unhide = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, `profile:${p.ref}`], `profile:${p.ref}`));
    assert.equal(unhide.code, 0, unhide.stderr);
    assert.deepEqual(JSON.parse(admins(unhide.requests)[0].body), { action: 'unhide', kind: 'profile', id: p.ref });
    assert.equal(p.hidden, false);
    assert.deepEqual(unhide.audit.at(-1).counts, { reports: 1 });
    assert.match(unhide.stdout, /cleared the hidden flag of profile .*; removed 1 report; it is hidden again after two new ones/);
    assert.equal((await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, 'profile:0123456789abcdef'], 'profile:0123456789abcdef'))).code, 4);
  });

  test('unhide of a gone target with stale reports prints found=false; a 404 after a lost answer is "already done"', async () => {
    stub.state.staleOperatorReports.add('fedcba9876543210');
    const stale = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, 'profile:fedcba9876543210'], 'profile:fedcba9876543210'));
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(stale.stdout, /profile fedcba9876543210 is gone; removed 1 stale report/);
    // A live target's unhide is idempotent on the Worker (a retry answers 200 again); only a gone
    // target whose stale reports the lost attempt deleted answers 404 on the retry (PR #69, W6).
    const p = person('Hidden Pat', { hidden: true, reporters: [{ id: 'operator', reason: 'operator' }] });
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const live = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, `profile:${p.ref}`], `profile:${p.ref}`));
    assert.equal(live.code, 0, live.stderr);
    assert.equal(p.hidden, false);
    assert.equal(admins(live.requests).length, 2);
    assert.match(live.stdout, /cleared the hidden flag of profile .*; removed 0 reports/);
    stub.state.staleOperatorReports.add('0123456789abcdef');
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const lost = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, 'profile:0123456789abcdef'], 'profile:0123456789abcdef'));
    assert.equal(lost.code, 0, lost.stderr);
    assert.equal(admins(lost.requests).length, 2);
    assert.ok(!stub.state.staleOperatorReports.has('0123456789abcdef'), 'the lost attempt did the work');
    assert.match(lost.stdout, /the hidden flag of profile 0123456789abcdef: already done \(an earlier attempt may have run/);
    assert.equal(lost.audit.at(-1).result, 'ok');
    assert.equal(lost.audit.at(-1).note, 'already_unhidden');
    assert.deepEqual(lost.audit.at(-1).counts, { reports: 0 });
  });

  test('delete of a meet and a spot; the meet dry-run says there is no preview read on tier 2', async () => {
    seedModeration();
    const dry = await invoke(['moderation', 'delete', '--event', EVENT, `meet:${MEET}`]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(admins(dry.requests).length, 0, 'no read for a meet');
    assert.match(dry.stdout, /would delete meet .* \(tier 2 has no preview read of a meet\)/);
    const del = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `meet:${MEET}`], `meet:${MEET}`));
    assert.equal(del.code, 0, del.stderr);
    assert.deepEqual(JSON.parse(admins(del.requests)[0].body), { action: 'delete', kind: 'meet', id: MEET });
    assert.ok(!stub.state.meets.has(MEET));
    assert.equal((await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `meet:${MEET}`], `meet:${MEET}`))).code, 4);
    const s = [...stub.state.people.values()].find((x) => x.display_name === 'Spot Sally');
    const spot = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `spot:${s.ref}`], `spot:${s.ref}`));
    assert.equal(spot.code, 0, spot.stderr);
    assert.match(spot.stdout, /cleared the spot line of .* and kept it hidden/);
    assert.equal((await invoke(['moderation', 'delete', '--event', EVENT, 'spot:0123456789abcdef'])).code, 4);
  });

  test('purge-reports previews from the stats, refuses before the conference end with ends_at, and purges after it', async () => {
    seedModeration();
    const dry = await invoke(['moderation', 'purge-reports', '--event', EVENT]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(admins(dry.requests).map((r) => r.pathWithQuery), [`/admin/stats?event=${EVENT}`]);
    assert.match(dry.stdout, /would ask the Worker to delete the reports of testconf-2099 made before its end \(2 reports on file/);
    const early = await invoke(confirmed(['moderation', 'purge-reports', '--event', EVENT], EVENT));
    assert.equal(early.code, 1);
    assert.deepEqual(JSON.parse(admins(early.requests)[0].body), { action: 'purge' });
    assert.match(early.stderr, /testconf-2099 ends at 2099-12-31T23:59:59\.000Z; nothing is purged before that/);
    assert.equal(early.audit.at(-1).result, 'failed');
    stub.state.conferenceEnded = true;
    const run = await invoke(confirmed(['moderation', 'purge-reports', '--event', EVENT], EVENT));
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /deleted 3 reports of testconf-2099/);
    assert.deepEqual(run.audit.at(-1).counts, { reports: 3 });
    assert.equal((await invoke(['moderation', 'purge-reports', '--event', 'nosuch-2099'])).code, 4);
  });

  test('a retried purge says an earlier attempt may have deleted more, and audits the note', async () => {
    seedModeration();
    stub.state.conferenceEnded = true;
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const r = await invoke(confirmed(['moderation', 'purge-reports', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /deleted 0 reports of testconf-2099 made before its end; an earlier attempt may have run and deleted more \(its answer was lost\), so the count can be short/);
    assert.equal(r.audit.at(-1).note, 'earlier_attempt_may_have_run');
  });

  test('a 2xx without a JSON object, or a write without "ok": true, is exit 1 and never success', async () => {
    const p = person('Odd Answer');
    stub.forced.push({ status: 200, body: { done: true } });
    const del = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `profile:${p.ref}`], `profile:${p.ref}`));
    assert.equal(del.code, 1);
    assert.match(del.stderr, /POST \/admin\/moderation: status 200 without "ok": true; the request may have taken effect/);
    assert.equal(del.audit.at(-1).result, 'failed');
    stub.forced.push({ status: 200, body: 'oops' });
    const block = await invoke(confirmed(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'spam'], p.ref));
    assert.equal(block.code, 1);
    assert.match(block.stderr, /POST \/admin\/people\/block: status 200 without a JSON object/);
    stub.forced.push({ status: 200, body: [1, 2] });
    const search = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Odd']);
    assert.equal(search.code, 1, 'a read too');
    seedConferenceFiles(EVENT);
    stub.forced.push({ status: 200, body: { deleted: { talks: 3 }, directory: 1, retired: true } });
    const remove = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(remove.code, 1);
    assert.match(remove.stderr, /DELETE \/admin\/conference: status 200 without "ok": true/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable', 'the local files are left alone');
  });
});

describe('MOD-5, MOD-6 unsupported on tier 2', () => {
  test('purge-expired exits 5 with the reason, in preview and for real, starting nothing', async () => {
    for (const argv of [['moderation', 'purge-expired'], confirmed(['moderation', 'purge-expired'], 'purge-expired'), ['moderation', 'purge-expired', '--json']]) {
      const r = await invoke(argv);
      assert.equal(r.code, 5, argv.join(' '));
      assert.match(r.stderr, /hourly cron/);
      assert.equal(r.spawned.length + stub.requests.length, 0);
      assert.equal(r.audit.at(-1).result, 'unsupported');
    }
    const asJson = await invoke(['moderation', 'purge-expired', '--json']);
    assert.deepEqual(Object.keys(JSON.parse(asJson.stderr)), ['ok', 'error', 'message']);
    assert.equal(JSON.parse(asJson.stderr).error, 'unsupported');
  });

  test('rules test and reload exit 5; the line is never sent, logged or audited', async () => {
    const t = await invoke(['moderation', 'rules', 'test', LINE]);
    assert.equal(t.code, 5);
    assert.match(t.stderr, /compiles its word list into the Worker/);
    assert.ok(!t.stderr.includes(LINE) && !JSON.stringify(t.audit).includes(LINE));
    assert.equal(stub.requests.length, 0);
    const reload = await invoke(confirmed(['moderation', 'rules', 'reload'], 'reload'));
    assert.equal(reload.code, 5);
    assert.equal(reload.spawned.length, 0);
    assert.equal(reload.audit.at(-1).result, 'unsupported');
  });
});

describe('CONF-1, CONF-3 conferences list, add and refresh', () => {
  test('list reads the public route unsigned: searchable by default, --all every one, no status_reason', async () => {
    const r = await invoke(['conferences', 'list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.requests.map((x) => `${x.method} ${x.path}`), ['GET /api/conferences']);
    assert.deepEqual(r.json().result.items, [{ slug: EVENT, name: 'Test Conf', start_date: '2099-12-30', end_date: '2099-12-31', status: 'searchable', talks: 12 }]);
    const all = await invoke(['conferences', 'list', '--all']);
    assert.match(all.stdout, /^slug=testconf-2099 name=Test Conf start_date=2099-12-30 end_date=2099-12-31 status=searchable talks=12\nslug=otherconf-2099 /);
    assert.match(all.stdout, /2 conferences$/m);
    assert.deepEqual(all.audit.at(-1).flags, ['all']);
  });

  test('add and refresh run gh workflow run ingest.yml with the slug, allow_shrink in the inputs, and the token out of the environment', async () => {
    const r = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: { stdout: '\u2713 Created workflow_dispatch event for ingest.yml at main\n' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.spawned.length, 1);
    const [child] = r.spawned;
    assert.equal(child.file, 'gh');
    assert.deepEqual(child.args, ['workflow', 'run', 'ingest.yml', '-f', `events=${OTHER}`]);
    assert.equal(child.options.cwd, root);
    assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(stub.requests.length, 0, 'no Worker request');
    assert.match(r.stdout, /step=gh line=\u2713 Created workflow_dispatch event/);
    assert.match(r.stdout, /started the ingest workflow for otherconf-2099; watch it with gh run list --workflow ingest.yml/);
    const env = { PATH: '/usr/bin', HOME: '/home/op', GH_TOKEN: 'gh-own-token', ADMIN_TOKEN: TOKEN, CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET, ES_API_KEY: 'es-key', NODE_AUTH_TOKEN: 'npm' };
    const shrink = await invoke(['conferences', 'refresh', '--event', OTHER, '--allow-shrink'], { env });
    assert.equal(shrink.code, 0, shrink.stderr);
    assert.deepEqual(shrink.spawned[0].args, ['workflow', 'run', 'ingest.yml', '-f', `events=${OTHER}`, '-f', 'allow_shrink=true']);
    const childEnv = shrink.spawned[0].options.env;
    assert.deepEqual(Object.keys(childEnv).sort(), ['GH_TOKEN', 'HOME', 'PATH'], 'gh gets its own token and the basics, nothing else');
    assert.equal(childEnv.GH_TOKEN, 'gh-own-token');
    assert.deepEqual(shrink.audit.at(-1).flags, ['allow-shrink']);
    const failed = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: { status: 4, stderr: 'could not find any workflows named ingest.yml\n' } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /gh exited with 4: could not find any workflows/);
    const absent = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: { error: { code: 'ENOENT' } } });
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /gh could not start: ENOENT; install the GitHub CLI/);
  });

  test('add and refresh with --dry-run start nothing and print the command', async () => {
    for (const argv of [['conferences', 'add', '--event', OTHER], ['conferences', 'refresh', '--event', OTHER, '--allow-shrink']]) {
      const r = await invoke([...argv, '--dry-run']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.spawned.length + stub.requests.length, 0);
      assert.match(r.stdout, /step=workflow command=gh workflow run ingest\.yml -f events=otherconf-2099/);
      if (argv.includes('--allow-shrink')) assert.match(r.stdout, /-f allow_shrink=true/);
      assert.match(r.stdout, /dry-run, nothing changed/);
      assert.equal(r.audit.at(-1).mode, 'dry-run');
    }
  });
});

describe('CONF-4 conferences hide and unhide', () => {
  test('hide previews, then sends the rewritten document in a PUT body, rewrites the files, and unhide reverses it', async () => {
    seedConferenceFiles(EVENT);
    const dry = await invoke(['conferences', 'hide', '--event', EVENT, '--reason', 'other', '--note', NOTE]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.requests.map((x) => `${x.method} ${x.path}`), ['GET /api/conferences']);
    assert.match(dry.stdout, /would send testconf-2099 as unavailable \(operator_hidden\) to the Worker \(now searchable\); would rewrite/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });

    const r = await invoke(confirmed(['conferences', 'hide', '--event', EVENT, '--reason', 'other', '--note', NOTE], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const put = admins(r.requests)[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.pathWithQuery, '/admin/conferences');
    const body = JSON.parse(put.body);
    assert.equal(body.conferences.length, 1);
    assert.equal(body.conferences[0].slug, EVENT);
    assert.equal(body.conferences[0].status, 'unavailable');
    assert.equal(body.conferences[0].status_reason, 'operator_hidden');
    assert.equal(body.conferences[0].name, `Conference ${EVENT}`);
    assert.equal(body.conferences[0].unretire, undefined);
    assert.equal(stub.state.conferences.find((c) => c.slug === EVENT).status, 'unavailable');
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status_reason, 'operator_hidden');
    assert.match(local.raw_fetched_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(operatorFile().hidden[EVENT].reason, 'other');
    assert.deepEqual(operatorFile().hidden[EVENT].previous, { status: 'searchable', status_reason: null });
    assert.match(r.stdout, /sent testconf-2099 as unavailable \(operator_hidden\) to the Worker \(was searchable; 1 object synced\); commit data\/testconf-2099\/conference\.json and data\/conference-operator\.json/);
    assert.ok(!r.stdout.includes(NOTE) && !JSON.stringify(r.audit).includes(NOTE));
    assert.deepEqual(r.audit.at(-1).counts, { upserted: 1, searchable: 0, synced: 1 });

    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(unhide.code, 0, unhide.stderr);
    const sent = JSON.parse(admins(unhide.requests)[0].body).conferences[0];
    assert.equal(sent.status, 'searchable');
    assert.equal(sent.status_reason, null);
    assert.equal(stub.state.conferences.find((c) => c.slug === EVENT).status, 'searchable');
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.match(unhide.stdout, /run conferences refresh --event testconf-2099/);
  });

  test('hide of a conference the Worker does not list exits 4 and writes nothing; a retired tombstone is reported', async () => {
    seedConferenceFiles('unknown-2099');
    const gone = await invoke(confirmed(['conferences', 'hide', '--event', 'unknown-2099'], 'unknown-2099'));
    assert.equal(gone.code, 4);
    assert.equal(admins(gone.requests).length, 0);
    assert.equal(readJson(join(root, 'data', 'unknown-2099', 'conference.json')).status, 'searchable');
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    const retired = await invoke(confirmed(['conferences', 'hide', '--event', EVENT], EVENT));
    assert.equal(retired.code, 1);
    assert.match(retired.stderr, /testconf-2099 is retired on the Worker .*run conferences unretire --event testconf-2099 first/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable', 'the local file is untouched after the failed backend write');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
  });
});

describe('CONF-7, CONF-8, CONF-12, CONF-13 conferences remove and unretire', () => {
  test('the dry-run reads the stats; the run sends DELETE /admin/conference with no body, prints the counts, retires the local files', async () => {
    seedConferenceFiles(EVENT);
    const dry = await invoke(['conferences', 'remove', '--event', EVENT, '--json']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(admins(dry.requests).map((x) => `${x.method} ${x.pathWithQuery}`), [`GET /admin/stats?event=${EVENT}`]);
    assert.deepEqual(dry.json().result.counts, stub.state.tables);
    assert.match(dry.json().result.summary, /would wipe testconf-2099 from the Worker: talks 3, topics 1, .*; directory row 1, and leave a retired tombstone; would retire data\/testconf-2099\/conference\.json/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.equal(stub.state.wiped.length, 0);

    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--reason', 'other'], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const del = admins(r.requests)[0];
    assert.equal(del.method, 'DELETE');
    assert.equal(del.pathWithQuery, `/admin/conference?event=${EVENT}`);
    assert.equal(del.body, '');
    assert.deepEqual(stub.state.wiped, [EVENT]);
    assert.ok(stub.state.retired.has(EVENT));
    const counts = r.audit.at(-1).counts;
    assert.equal(counts.talks, 3);
    assert.equal(counts.people, 2);
    assert.equal(counts.directory, 1);
    assert.equal(counts.meta, 2);
    assert.match(r.stdout, /wiped testconf-2099 from the Worker: talks_fts 3, talks 3, .*; tombstone left, so the weekly ingest skips it until conferences unretire; retired testconf-2099; commit data\/testconf-2099\/conference\.json and data\/conference-operator\.json/);
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status, 'unavailable');
    assert.equal(local.status_reason, 'operator_removed');
    assert.ok(existsSync(join(root, 'data', EVENT, 'talks.ndjson')));
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT]);
    // A second wipe is idempotent on the Worker: zero counts, already_retired_at, still exit 0.
    const again = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /nothing was left to delete.*it was retired already, at 2025-11-11T00:00:00\.000Z/);
    assert.equal(again.audit.at(-1).result, 'ok');
    // After the wipe the object refuses admin requests until an unretire; the message says so.
    const search = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'x']);
    assert.equal(search.code, 4);
    assert.match(search.stderr, /the Worker does not route testconf-2099 or takes no admin write for it; check the slug; if it was removed, run conferences unretire --event testconf-2099 and then conferences refresh/);
    // A write is answered the same (400 "conference is not available"): exit 4, the unretire
    // hint, one request and no retry.
    const hide = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, 'profile:0123456789abcdef', '--reason', 'spam'], 'profile:0123456789abcdef'));
    assert.equal(hide.code, 4);
    assert.equal(admins(hide.requests).length, 1);
    assert.match(hide.stderr, /^caddie-admin: POST \/admin\/moderation: the Worker does not route testconf-2099 or takes no admin write for it; check the slug; if it was removed, run conferences unretire --event testconf-2099 and then conferences refresh\n$/);
    assert.equal(hide.audit.at(-1).result, 'not_found');
    assert.equal(hide.audit.at(-1).error, 'conference_unavailable');
    const hideJson = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, 'profile:0123456789abcdef', '--reason', 'spam', '--json'], 'profile:0123456789abcdef'));
    assert.equal(hideJson.code, 4);
    assert.equal(JSON.parse(hideJson.stderr).error, 'conference_unavailable');
    const statsAfter = await invoke(['stats', 'counts', '--event', EVENT]);
    assert.equal(statsAfter.code, 4);
    assert.match(statsAfter.stderr, /run conferences unretire --event testconf-2099 and then conferences refresh/);
  });

  test('a retried removal says an earlier attempt may have deleted more, and audits the note', async () => {
    seedConferenceFiles(EVENT);
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests).length, 2);
    assert.match(r.stdout, /it was retired already, at .*; an earlier attempt may have run and deleted more \(its answer was lost\), so these counts can be short/);
    assert.equal(r.audit.at(-1).note, 'earlier_attempt_may_have_run');
  });

  test('a removal that stopped between its steps exits 1 naming the step, is not retried blind, and leaves the local files alone', async () => {
    seedConferenceFiles(EVENT);
    stub.forced.push({ status: 502, headers: { 'retry-after': '5' }, body: { error: 'removal_incomplete', step: 'wipe', retired: true, wiped: false, cause: 'object \u001b[2J unreachable: Error 1102' } });
    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(r.code, 1);
    assert.equal(admins(r.requests).length, 1, 'not retried by the client');
    assert.match(r.stderr, /DELETE \/admin\/conference: removal incomplete at step wipe \(status 502; retired true, wiped false\); run the removal again after 5 seconds \(Retry-After\)/);
    assert.ok(!r.stderr.includes('\u001b') && !r.stderr.includes('1102'), 'a cause outside the plain charset is dropped, not echoed');
    stub.forced.push({ status: 502, body: { error: 'removal_incomplete', step: 'directory', retired: true, wiped: true, deleted: { talks: 3 }, cause: 'directory request failed: Error' } });
    const plain = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.match(plain.stderr, /at step directory \(status 502; retired true, wiped true; cause: directory request failed: Error\); run the removal again \(after the Retry-After/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.equal(r.audit.at(-1).result, 'failed');
    const again = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status_reason, 'operator_removed');
  });

  test('--purge-local deletes only the raw directory and the talk file; a slug the directory does not route is still wiped', async () => {
    seedConferenceFiles('unknown-2099');
    const dry = await invoke(['conferences', 'remove', '--event', 'unknown-2099']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /the Worker does not route unknown-2099 \(no directory row\); a run would still wipe its object and leave a retired tombstone/);
    const r = await invoke(confirmed(['conferences', 'remove', '--event', 'unknown-2099', '--purge-local'], 'unknown-2099'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.audit.at(-1).counts.directory, 0);
    assert.ok(existsSync(join(root, 'data', 'unknown-2099', 'conference.json')), 'conference.json survives --purge-local');
    assert.ok(!existsSync(join(root, 'data', 'unknown-2099', 'talks.ndjson')));
    assert.ok(!existsSync(join(root, 'data', 'raw', 'unknown-2099')));
    assert.deepEqual(r.audit.at(-1).flags, ['purge-local']);
  });

  test('unretire sends the local document with unretire: true in the body and no query, drops the removed entry, and points at refresh', async () => {
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const dry = await invoke(['conferences', 'unretire', '--event', EVENT]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.requests.map((x) => `${x.method} ${x.path}`), ['GET /api/conferences'], 'the preview reads the public listing only');
    assert.match(dry.stdout, /would unretire testconf-2099: sending searchable \(Worker now not listed\) to PUT \/admin\/conferences with "unretire": true and "expect_status": null on the document/);
    assert.ok(stub.state.retired.has(EVENT));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const put = admins(r.requests)[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.pathWithQuery, '/admin/conferences');
    assert.deepEqual(put.query, []);
    const doc = JSON.parse(put.body).conferences[0];
    assert.equal(doc.unretire, true);
    assert.equal(doc.expect_status, null, 'not listed: the directory has no row');
    assert.equal(doc.slug, EVENT);
    assert.equal(doc.status_reason, null, 'the local document as it is (seeded searchable)');
    assert.ok(!stub.state.retired.has(EVENT), 'the tombstone is gone');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.match(r.stdout, /unretired testconf-2099: sent searchable \(Worker was not listed\) with unretire: true and expect_status: null; the Worker dropped its tombstone \(upserted 1\); commit data\/conference-operator\.json; run conferences refresh --event testconf-2099 next/);
    assert.deepEqual(r.audit.at(-1).counts, { upserted: 1, searchable: 1, synced: 1 });
    // On tier 2 a second unretire is sent again (the repair path), with no local entry to drop;
    // it reads the row the first one stored and expects its status.
    const again = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(admins(again.requests).length, 1);
    assert.equal(JSON.parse(admins(again.requests)[0].body).conferences[0].expect_status, 'searchable');
    assert.match(again.stdout, /has no removed entry for testconf-2099, so it is left as it is/);
  });

  test('unretire of an unavailable local document renders the counts as the Worker returns them (synced 1, searchable 0)', async () => {
    seedConferenceFiles(EVENT, { status: 'unavailable', statusReason: 'operator_removed' });
    // A removed conference: a tombstone, and no row in the directory's listing.
    stub.state.retired.add(EVENT);
    stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.counts, { upserted: 1, searchable: 0, synced: 1 });
    assert.ok(!stub.state.retired.has(EVENT));
  });

  test('a failed unretire fan-out (502) is retried with fresh signatures; still failing, it says "unretire incomplete; run it again"', async () => {
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    stub.forced.push({ status: 502, body: { error: 'Conferences are temporarily unavailable' }, act: true }, { status: 502, body: { error: 'Conferences are temporarily unavailable' }, act: true });
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const calls = admins(r.requests);
    assert.equal(calls.length, 3, 'two 502s, then success');
    assert.equal(new Set(calls.map((c) => c.nonce)).size, 3, 'each attempt signed afresh');
    for (const c of calls) assert.equal(JSON.parse(c.body).conferences[0].unretire, true, 'the flag travels on every attempt');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    stub.state.retired.add(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    // The final shape: 502 unretire_incomplete with the slugs whose fan-out failed, the counts
    // beside it, and the tombstone already gone.
    const incomplete = { error: 'unretire_incomplete', unretire_failed: [EVENT], upserted: 1, searchable: 1, synced: 0, skipped_retired: [] };
    for (let i = 0; i < 4; i++) stub.forced.push({ status: 502, body: incomplete });
    const failed = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(failed.code, 1);
    assert.equal(admins(failed.requests).length, 4, 'bounded retries');
    assert.match(failed.stderr, /^caddie-admin: unretire of testconf-2099 incomplete; run the unretire again \(PUT \/admin\/conferences: status 502 \(unretire_incomplete\) \(gave up after 4 attempts; an earlier attempt failed \(status 502 \(unretire_incomplete\)\); if it reached the Worker it may have done the work\)\)/);
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT], 'the local removed entry stays');
    assert.equal(failed.audit.at(-1).result, 'failed');
    assert.equal(failed.audit.at(-1).error, 'unretire_incomplete');
    const asJson = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT), { });
    assert.equal(asJson.code, 0, 'the next run, with no forced answer, repairs it');
  });

  test('a removal overtaken by an unretire at step directory (409 removal_superseded) exits 1, says the data is gone and the row kept, prints both commands with the right flags, and changes no local file', async () => {
    seedConferenceFiles(EVENT);
    const superseded = { error: 'removal_superseded', step: 'directory', retired: false, wiped: true, deleted: { talks: 3, people: 2 } };
    stub.forced.push({ status: 409, body: superseded });
    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--reason', 'spam', '--purge-local', '--note', NOTE], EVENT));
    assert.equal(r.code, 1);
    assert.equal(admins(r.requests).length, 1, 'one request, nothing else on its own');
    assert.match(r.stderr, /^caddie-admin: an unretire overtook the removal of testconf-2099 at step directory: the object was wiped first \(talks 3, people 2\) and the directory kept its row: the conference is listed and its data is gone, and if that unretire's fan-out failed, the object refuses the conference until an unretire is repeated; the directory holds no tombstone for it; nothing further was done; choose one: finish the removal with `caddie-admin conferences remove --event testconf-2099 --reason spam --purge-local --yes --confirm testconf-2099`, or restore the conference with `caddie-admin conferences unretire --event testconf-2099 --yes --confirm testconf-2099` \(DELETE \/admin\/conference: an unretire overtook the removal at step directory \(status 409\)\)\n$/);
    assert.ok(!/run the removal again/.test(r.stderr), 'no plain re-run hint');
    assert.ok(!r.stderr.includes(NOTE));
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.ok(existsSync(join(root, 'data', EVENT, 'talks.ndjson')), 'nothing purged locally');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    const entry = r.audit.at(-1);
    assert.equal(entry.result, 'failed');
    assert.equal(entry.error, 'removal_superseded');
    assert.equal(entry.reason, 'spam');
    stub.forced.push({ status: 409, body: superseded });
    const asJson = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--json'], EVENT));
    assert.equal(asJson.code, 1);
    const body = JSON.parse(asJson.stderr);
    assert.equal(body.error, 'removal_superseded');
    assert.match(body.message, /finish the removal with `caddie-admin conferences remove --event testconf-2099 --yes --confirm testconf-2099`, or restore/);
    // The field order of the answer does not matter.
    stub.forced.push({ status: 409, body: { deleted: {}, wiped: true, retired: null, step: 'directory', error: 'removal_superseded' } });
    assert.match((await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT))).stderr, /at step directory: the object was wiped first \(nothing was left to delete\).*; the Worker could not say whether the directory holds a tombstone for it;/);
    // --purge-local is carried into the "finish" command, and nothing is purged locally.
    stub.forced.push({ status: 409, body: superseded });
    const purge = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--purge-local'], EVENT));
    assert.equal(purge.code, 1);
    assert.equal(admins(purge.requests).length, 1);
    assert.match(purge.stderr, /finish the removal with `caddie-admin conferences remove --event testconf-2099 --purge-local --yes --confirm testconf-2099`/);
    assert.ok(existsSync(join(root, 'data', EVENT, 'talks.ndjson')), 'nothing purged locally');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
  });

  test('a removal overtaken at step wipe (the object took a later unretire first) says nothing was deleted and the conference is live, for each tombstone state', async () => {
    seedConferenceFiles(EVENT);
    const tombstone = {
      true: 'the directory holds a tombstone for it again \\(a later removal wrote one\\)',
      false: 'the directory holds no tombstone for it',
      null: 'the Worker could not say whether the directory holds a tombstone for it',
    };
    for (const retired of [true, false, null]) {
      stub.state.supersede = { step: 'wipe', retired };
      const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--reason', 'other', '--purge-local'], EVENT));
      assert.equal(r.code, 1, `retired ${retired}`);
      assert.equal(admins(r.requests).length, 1);
      assert.match(r.stderr, new RegExp(`^caddie-admin: an unretire overtook the removal of testconf-2099 at step wipe: the conference's object had already taken that unretire and refused the wipe, and the directory kept its row: nothing was deleted; the conference is live as the unretire left it; ${tombstone[retired]}; nothing further was done; choose one: remove it after all with \`caddie-admin conferences remove --event testconf-2099 --reason other --purge-local --yes --confirm testconf-2099\`, or keep it as it is \\(nothing to run; \`caddie-admin conferences unretire --event testconf-2099 --yes --confirm testconf-2099\` sends the local document again\\)`));
      assert.ok(!/data is gone|run the removal again/.test(r.stderr));
      assert.equal(r.audit.at(-1).error, 'removal_superseded');
    }
    assert.deepEqual(stub.state.wiped, [], 'nothing was wiped');
    assert.ok(stub.state.conferences.some((c) => c.slug === EVENT), 'still listed');
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.ok(existsSync(join(root, 'data', EVENT, 'talks.ndjson')), 'nothing purged locally');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
  });

  // At step directory the object was wiped and then took the later unretire, unless that
  // unretire's fan-out failed: then it keeps its removal marker, as here.
  test('after a superseded removal whose unretire fan-out failed the conference is listed but its object is wiped: reads are empty, writes exit 4, and the unretire repairs it', async () => {
    seedConferenceFiles(EVENT);
    const p = person('Kept Person');
    stub.forced.push({ status: 409, body: { error: 'removal_superseded', step: 'directory', retired: false, wiped: true, deleted: { people: 1 } } });
    const removed = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(removed.code, 1);
    // What the Worker holds then: the directory row (the unretire's), and a wiped object.
    stub.state.wipedObjects.add(EVENT);
    const search = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Kept', '--json']);
    assert.equal(search.code, 0, search.stderr);
    assert.deepEqual(search.json().result.counts, { matched: 0, shown: 0 });
    const hide = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `profile:${p.ref}`, '--reason', 'spam'], `profile:${p.ref}`));
    assert.equal(hide.code, 4);
    assert.equal(hide.audit.at(-1).error, 'conference_unavailable');
    assert.match(hide.stderr, /check the slug; if it was removed, run conferences unretire --event testconf-2099/);
    // The repair: no local removed entry (the removal never finished here), and the local document
    // has the status the Worker lists, so the unretire is sent.
    const dry = await invoke(['conferences', 'unretire', '--event', EVENT]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would unretire testconf-2099: sending searchable \(Worker now searchable\)/);
    const repair = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(repair.code, 0, repair.stderr);
    assert.match(repair.stdout, /unretired testconf-2099: sent searchable \(Worker was searchable\)/);
    assert.ok(!stub.state.wipedObjects.has(EVENT), 'the unretire cleared the removal marker');
    const after = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `profile:${p.ref}`, '--reason', 'spam'], `profile:${p.ref}`));
    assert.equal(after.code, 0, after.stderr);
  });

  test('unretire sends the flag on the document and only `conferences` at the top level; the stand-in refuses any other top-level key, as the Worker does', async () => {
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(admins(r.requests)[0].body);
    assert.deepEqual(Object.keys(body), ['conferences'], 'no top-level unretire key');
    assert.equal(body.conferences[0].unretire, true);
    // The fixture's vector carries the same shape, and a top-level flag would be a 400.
    const fixture = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'admin-sign.v1.json'), 'utf8')).cases.find((c) => c.id === 'post-unretire-flag');
    assert.deepEqual(Object.keys(JSON.parse(fixture.body)), ['conferences']);
    assert.equal(JSON.parse(fixture.body).conferences[0].unretire, true);
    const res = await realFetch(`${stub.url}/admin/conferences`, { method: 'PUT', body: '{"conferences":[],"unretire":true}' });
    assert.equal(res.status, 404, 'unsigned, so refused before the key rule');
    stub.problems.length = 0;
  });

  test('an unretire whose fan-out hit the daily limit (503, cause daily_limit) stops at once; one that lost to a later removal (502, a cause) is retried and names the cause', async () => {
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    stub.state.fanOutFailure = { status: 503, retryAfter: '3600' };
    const limited = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(limited.code, 1);
    assert.equal(admins(limited.requests).length, 1, 'not retried before the reset');
    assert.match(limited.stderr, /^caddie-admin: unretire of testconf-2099 incomplete; the account's daily limit is reached; run the unretire again after 00:00 UTC \(PUT \/admin\/conferences: status 503 \(unretire_incomplete; cause daily_limit\): the account's daily limit is reached; try again after 00:00 UTC\)\n$/);
    assert.equal(limited.audit.at(-1).error, 'unretire_incomplete');
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT], 'the local removed entry stays');
    const asJson = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT));
    assert.equal(JSON.parse(asJson.stderr).error, 'unretire_incomplete');
    for (const cause of ['unretire_superseded', 'conference_retired']) {
      stub.state.fanOutFailure = { status: 502, cause };
      const lost = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
      assert.equal(lost.code, 1);
      assert.equal(admins(lost.requests).length, 4, 'bounded retries');
      assert.match(lost.stderr, new RegExp(`unretire of testconf-2099 incomplete; run the unretire again \\(PUT /admin/conferences: status 502 \\(unretire_incomplete; cause ${cause}\\)`));
    }
    stub.state.fanOutFailure = null;
    const repaired = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.ok(!stub.state.wipedObjects.has(EVENT));
  });

  test('on tier 2 an unretire with no local removed entry is still sent (the repair after removal_superseded or unretire_incomplete), and the operator file is left alone', async () => {
    seedConferenceFiles(EVENT);
    stub.state.retired.add(EVENT);
    const dry = await invoke(['conferences', 'unretire', '--event', EVENT]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would send it anyway \(data\/conference-operator\.json has no removed entry for testconf-2099, so it is left as it is\)/);
    assert.ok(stub.state.retired.has(EVENT));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(admins(r.requests)[0].body).conferences[0].unretire, true);
    assert.ok(!stub.state.retired.has(EVENT), 'the tombstone is gone');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} }, 'nothing to drop, nothing written');
    assert.match(r.stdout, /data\/conference-operator\.json has no removed entry for testconf-2099, so it is left as it is; run conferences refresh --event testconf-2099 next/);
    assert.ok(!r.stdout.includes('commit data/conference-operator.json'));
    assert.equal(r.audit.at(-1).result, 'ok');
  });

  test('unretire without a local file sends the slug alone, with the status the Worker lists as its expectation', async () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [OTHER]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', OTHER], OTHER));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(admins(r.requests)[0].body), { conferences: [{ slug: OTHER, unretire: true, expect_status: 'unavailable' }] });
  });

  test('an unretire is refused for a typo (no removed entry, no local document) and for a slug the Worker lists with another status', async () => {
    const typo = await invoke(confirmed(['conferences', 'unretire', '--event', 'testconf-2098'], 'testconf-2098'));
    assert.equal(typo.code, 4);
    assert.match(typo.stderr, /testconf-2098 has no removed entry in data\/conference-operator\.json and no data\/testconf-2098\/conference\.json; check the slug/);
    assert.equal(stub.requests.length, 0, 'nothing sent, not even a read');
    // Live as searchable while the local document is hidden: the unretire would take it offline.
    seedConferenceFiles(EVENT, { status: 'unavailable', statusReason: 'operator_hidden' });
    for (const argv of [['conferences', 'unretire', '--event', EVENT], confirmed(['conferences', 'unretire', '--event', EVENT], EVENT)]) {
      const live = await invoke(argv);
      assert.equal(live.code, 1);
      assert.match(live.stderr, /testconf-2099 is listed on the Worker as searchable, and the unretire would send it as unavailable \(operator_hidden\); refused, because that would change a live conference/);
      assert.deepEqual(admins(live.requests), [], 'no PUT');
      assert.equal(live.audit.at(-1).error, 'unretire_refused');
    }
    // The same with a removed entry recorded locally: the live listing still wins.
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const recorded = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(recorded.code, 1);
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT], 'the entry stays');
    // The slug alone (no local document) would be stored as unavailable: refused for a live one.
    rmSync(join(root, 'data', EVENT, 'conference.json'));
    const bare = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /would send it as unavailable; refused/);
    // A listing without a conferences array is an error, never "not listed".
    const broken = async (url, init) => (new URL(url).pathname === '/api/conferences' ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init));
    const odd = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: broken });
    assert.equal(odd.code, 1);
    assert.match(odd.stderr, /GET \/api\/conferences: the answer holds no conferences list/);
    assert.deepEqual(stub.state.puts, [], 'no document was ever sent');
  });
});

describe('conferences unretire: the expect_status precondition (#79)', () => {
  // The arrow of `slug expected->actual`, U+2192, written as an escape so this file stays ASCII.
  const TO = '\u2192';
  const RECORDED = () => writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
  // A completed removal as the Worker leaves it: a tombstone and no directory row.
  const removedOnWorker = () => {
    stub.state.retired.add(EVENT);
    stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
  };
  const row = () => stub.state.conferences.find((c) => c.slug === EVENT) ?? null;
  const sentDoc = (r, i = 0) => JSON.parse(admins(r.requests).filter((x) => x.method === 'PUT')[i].body).conferences[0];
  // A fetch that runs `change` once, right after the CLI's read of GET /api/conferences was
  // answered and before its PUT: another command landing between the two requests.
  const racingFetch = (change) => {
    let done = false;
    return async (url, init) => {
      const res = await realFetch(url, init);
      if (!done && new URL(url).pathname === '/api/conferences') {
        done = true;
        change();
      }
      return res;
    };
  };
  // A fetch whose GET /api/conferences answers this listing, and every other request the real one.
  const listing = (conferences) => async (url, init) => (new URL(url).pathname === '/api/conferences'
    ? new Response(JSON.stringify({ conferences }), { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(url, init));

  test('a normal unretire expects the status it read: null for a slug the Worker does not list, the listed status otherwise', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests).length, 1);
    const doc = sentDoc(r);
    assert.ok(Object.hasOwn(doc, 'expect_status') && doc.expect_status === null, 'null, sent as a key');
    assert.equal(doc.unretire, true);
    assert.ok(!stub.state.retired.has(EVENT));
    assert.equal(row().status, 'searchable');
    assert.ok(!('expect_status' in stub.state.puts.at(-1)), 'the stand-in, like the Worker, never stores the key');
    // Listed with the status the local document has: that status is the expectation.
    const listed = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT));
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(sentDoc(listed).expect_status, 'searchable');
    assert.match(listed.json().result.summary, /sent searchable \(Worker was searchable\) with unretire: true and expect_status: "searchable"/);
    assert.equal(stub.state.mismatches, 0);
  });

  test('a removal that lands between the read and the PUT: 409 status_mismatch, exit 1, nothing written, no retry; the explicit re-run reads again', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    // A removal that stopped at step directory: the tombstone and the row are both there.
    stub.state.retired.add(EVENT);
    stub.state.wipedObjects.add(EVENT);
    const puts = stub.state.puts.length;
    // Its re-run finishes between this command's read and its PUT, and deletes the row.
    const finish = () => { stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT); };
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: racingFetch(finish) });
    assert.equal(r.code, 1);
    assert.equal(admins(r.requests).length, 1, 'a 409 is not retried');
    assert.equal(sentDoc(r).expect_status, 'searchable');
    assert.equal(r.stderr, `caddie-admin: unretire of testconf-2099 not applied: the directory holds another status than this command expected (expected${TO}actual): testconf-2099 searchable${TO}(no row); nothing was written by this attempt; something else changed the conference after this command read it (another remove, unretire, hide or unhide, or an ingest run); check it with conferences list --all, then run conferences unretire --event testconf-2099 again if it is still wanted: it re-reads the status and expects that (PUT /admin/conferences: status 409 (status_mismatch))\n`);
    assert.equal(r.audit.at(-1).result, 'failed');
    assert.equal(r.audit.at(-1).error, 'status_mismatch');
    // Nothing written: the tombstone, the missing row and the marker as the removal left them,
    // and the local removed entry kept.
    assert.ok(stub.state.retired.has(EVENT));
    assert.equal(row(), null);
    assert.ok(stub.state.wipedObjects.has(EVENT));
    assert.equal(stub.state.puts.length, puts);
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT]);
    // The same as JSON: the code, and the arrow in the message.
    stub.state.conferences.push({ slug: EVENT, name: 'Test Conf', status: 'searchable' });
    const asJson = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT), { fetch: racingFetch(finish) });
    assert.equal(asJson.code, 1);
    const err = JSON.parse(asJson.stderr);
    assert.equal(err.error, 'status_mismatch');
    assert.ok(err.message.includes(`testconf-2099 searchable${TO}(no row)`));
    // The operator re-runs it: it reads "not listed", expects no row, and brings the conference back.
    const again = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(sentDoc(again).expect_status, null);
    assert.ok(!stub.state.retired.has(EVENT));
    assert.ok(!stub.state.wipedObjects.has(EVENT));
    assert.deepEqual(operatorFile().removed, {});
  });

  test('an unretire that lands between the read and the PUT is not overwritten, and the re-run refuses the other status', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    // Another operator unretires it as hidden in between.
    const other = () => {
      stub.state.retired.delete(EVENT);
      stub.state.conferences.push({ slug: EVENT, name: 'Test Conf', status: 'unavailable', status_reason: 'operator_hidden' });
    };
    // A 429 first is the limiter's, before any handler: not an attempt that may have run.
    stub.forced.push({ status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': '0' } });
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: racingFetch(other) });
    assert.equal(r.code, 1);
    assert.equal(admins(r.requests).length, 2);
    assert.match(r.stderr, new RegExp(`testconf-2099 \\(no row\\)${TO}unavailable; nothing was written by this attempt; something else changed the conference after this command read it`));
    assert.ok(!r.stderr.includes('earlier attempt'), 'a 429 never ran');
    assert.equal(row().status, 'unavailable', 'the other unretire stands');
    const again = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(again.code, 1);
    assert.equal(again.audit.at(-1).error, 'unretire_refused');
    assert.deepEqual(admins(again.requests), [], 'no PUT');
  });

  test('each documented repair flow still works: the unretire expects the row each one leaves', async () => {
    const flows = [
      // removal_superseded at step wipe: the overtaking unretire's row and live object, no tombstone.
      { name: 'removal_superseded at step wipe', supersede: { step: 'wipe', retired: false }, expected: 'searchable' },
      // At step directory the row is kept and the object wiped, still marked when the unretire's fan-out failed.
      { name: 'removal_superseded at step directory', supersede: { step: 'directory', retired: false }, after: () => stub.state.wipedObjects.add(EVENT), expected: 'searchable' },
      // removal_incomplete at step wipe: the tombstone and the row, the object untouched.
      { name: 'removal_incomplete at step wipe', incomplete: { step: 'wipe', wiped: false }, after: () => stub.state.retired.add(EVENT), expected: 'searchable' },
      // removal_incomplete at step directory: the tombstone, the row, and a wiped object.
      { name: 'removal_incomplete at step directory', incomplete: { step: 'directory', wiped: true }, after: () => { stub.state.retired.add(EVENT); stub.state.wipedObjects.add(EVENT); }, expected: 'searchable' },
      // removal_incomplete of a slug the directory never had: a tombstone and no row.
      { name: 'removal_incomplete without a row', incomplete: { step: 'wipe', wiped: false }, before: () => { stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT); }, after: () => stub.state.retired.add(EVENT), expected: null },
    ];
    for (const flow of flows) {
      stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
      stub.state.conferences.push({ slug: EVENT, name: 'Test Conf', status: 'searchable' });
      stub.state.retired.clear();
      stub.state.wipedObjects.clear();
      stub.state.supersede = flow.supersede ?? null;
      seedConferenceFiles(EVENT);
      flow.before?.();
      if (flow.incomplete) stub.forced.push({ status: 502, body: { error: 'removal_incomplete', retired: true, ...flow.incomplete } });
      const removal = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
      assert.equal(removal.code, 1, flow.name);
      flow.after?.();
      stub.state.supersede = null;
      const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
      assert.equal(r.code, 0, `${flow.name}: ${r.stderr}`);
      assert.equal(sentDoc(r).expect_status, flow.expected, flow.name);
      assert.ok(!stub.state.retired.has(EVENT), `${flow.name}: no tombstone`);
      assert.ok(!stub.state.wipedObjects.has(EVENT), `${flow.name}: no removal marker`);
      assert.equal(row()?.status, 'searchable', flow.name);
    }
    // unretire_incomplete: the row is stored and the tombstone gone, the object still marked (here
    // the fan-out hit the daily limit, which stops at once). Running it again expects that row.
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    stub.state.fanOutFailure = { status: 503, retryAfter: '3600' };
    const first = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(first.code, 1);
    assert.equal(first.audit.at(-1).error, 'unretire_incomplete');
    assert.equal(sentDoc(first).expect_status, null);
    assert.ok(stub.state.wipedObjects.has(EVENT));
    stub.state.fanOutFailure = null;
    const repaired = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(sentDoc(repaired).expect_status, 'searchable');
    assert.ok(!stub.state.wipedObjects.has(EVENT));
    assert.deepEqual(operatorFile().removed, {});
    assert.equal(stub.state.mismatches, 0);
  });

  test('after a 502 unretire_incomplete the retry expects the status the directory committed, and repairs the object', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    // The first attempt stores the row and drops the tombstone, then its fan-out fails once.
    stub.state.fanOutFailure = { status: 502, cause: 'unretire_superseded', times: 1 };
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(admins(r.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, 'searchable']);
    assert.equal(new Set(admins(r.requests).map((x) => x.nonce)).size, 2, 'each attempt signed afresh over its own body');
    assert.ok(!stub.state.wipedObjects.has(EVENT), 'the retry cleared the removal marker');
    assert.ok(!stub.state.retired.has(EVENT));
    assert.deepEqual(operatorFile().removed, {});
    assert.equal(stub.state.mismatches, 0);
  });

  test('after a 502 unretire_incomplete the retry expects the stored status of a document that is not searchable: unavailable, partial_index, or the slug alone', async () => {
    for (const [name, status, slugOnly] of [['unavailable', 'unavailable', false], ['partial_index', 'partial_index', false], ['slug only', undefined, true]]) {
      seedConferenceFiles(EVENT);
      RECORDED();
      removedOnWorker();
      const path = join(root, 'data', EVENT, 'conference.json');
      // A removal rewrites the local document as unavailable (operator_removed), so this is the usual case.
      if (slugOnly) rmSync(path, { force: true });
      else writeFileSync(path, JSON.stringify({ ...readJson(path), status, status_reason: 'operator_removed' }));
      stub.state.fanOutFailure = { status: 502, cause: 'unretire_superseded', times: 1 };
      const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      const sent = admins(r.requests).map((x) => JSON.parse(x.body).conferences[0]);
      assert.ok(sent.every((d) => Object.hasOwn(d, 'expect_status')), `${name}: every attempt carries the key`);
      assert.deepEqual(sent.map((d) => d.expect_status), [null, 'unavailable'], name);
      assert.equal(row()?.status, 'unavailable', name);
      assert.ok(!stub.state.wipedObjects.has(EVENT), `${name}: the retry cleared the removal marker`);
    }
    assert.equal(stub.state.mismatches, 0);
  });

  test('after a 2xx whose body was lost the retry expects the status the directory committed', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    let first = true;
    const lostBody = async (url, init) => {
      if (!first || !String(url).includes('/admin/')) return realFetch(url, init);
      first = false;
      const res = await realFetch(url, init);
      assert.equal(res.status, 200);
      await res.text();
      const body = new ReadableStream({ start(c) { c.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); } });
      return new Response(body, { status: 200 });
    };
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: lostBody });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(admins(r.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, 'searchable']);
    assert.ok(!stub.state.retired.has(EVENT));
    assert.equal(stub.state.mismatches, 0);
  });

  test('a removal that finishes between a committed attempt and its retry is not undone: 409 searchable->(no row), "something else changed"', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    stub.state.fanOutFailure = { status: 502, cause: 'unretire_superseded', times: 1 };
    let puts = 0;
    const racing = async (url, init) => {
      const res = await realFetch(url, init);
      if (new URL(url).pathname === '/admin/conferences' && ++puts === 1) {
        // Operator B's removal (a later order number) wipes the object, then its step 3 deletes the row.
        stub.state.retired.add(EVENT);
        stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
        stub.state.wipedObjects.add(EVENT);
      }
      return res;
    };
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: racing });
    assert.equal(r.code, 1);
    assert.deepEqual(admins(r.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, 'searchable']);
    assert.equal(r.stderr, `caddie-admin: unretire of testconf-2099 not applied: the directory holds another status than this command expected (expected${TO}actual): testconf-2099 searchable${TO}(no row); nothing was written by this attempt; something else changed the conference after this command read it (another remove, unretire, hide or unhide, or an ingest run); check it with conferences list --all, then run conferences unretire --event testconf-2099 again if it is still wanted: it re-reads the status and expects that (PUT /admin/conferences: status 409 (status_mismatch))\n`);
    assert.equal(r.audit.at(-1).error, 'status_mismatch');
    // B's removal stands.
    assert.ok(stub.state.retired.has(EVENT));
    assert.equal(row(), null);
    assert.ok(stub.state.wipedObjects.has(EVENT));
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT]);
  });

  test('after failures that prove no commit the retry keeps its expectation; a 409 showing the sent status names every earlier attempt that may have run', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    // The connection breaks after the request was written whole and applied: no answer.
    let failed = false;
    const lostAnswer = async (url, init) => {
      if (failed || !String(url).includes('/admin/')) return realFetch(url, init);
      failed = true;
      await (await realFetch(url, init)).text();
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) });
    };
    const lost = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: lostAnswer, trackSend: SENT });
    assert.equal(lost.code, 1);
    assert.deepEqual(admins(lost.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, null], 'a network error proves nothing');
    assert.equal(lost.stderr, `caddie-admin: unretire of testconf-2099 not applied: the directory holds another status than this command expected (expected${TO}actual): testconf-2099 (no row)${TO}searchable; nothing was written by this attempt; an earlier attempt of this command got no answer (ECONNRESET) and may have been applied, so the actual status can be the one this command sent; run conferences unretire --event testconf-2099 again until it answers 200: each run re-reads the status and expects that (PUT /admin/conferences: status 409 (status_mismatch))\n`);
    assert.ok(!stub.state.retired.has(EVENT), 'that attempt did unretire it');
    // The re-run reads the row it stored and expects it.
    const again = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(sentDoc(again).expect_status, 'searchable');

    // A 5xx without unretire_incomplete proves nothing either; every attempt that may have run is named.
    removedOnWorker();
    RECORDED();
    stub.forced.push({ status: 502, body: { error: 'Service is temporarily unavailable' }, act: true }, { status: 503, body: { error: 'busy' } });
    const both = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(both.code, 1);
    assert.deepEqual(admins(both.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, null, null]);
    assert.ok(both.stderr.includes(`testconf-2099 (no row)${TO}searchable; nothing was written by this attempt; earlier attempts of this command may have been applied (answered status 502 (Service is temporarily unavailable); answered status 503 (busy)), so the actual status can be the one this command sent; run conferences unretire --event testconf-2099 again until it answers 200`), both.stderr);
    assert.ok(!both.stderr.includes('may have done the work'));
  });

  test('a 5xx whose body could not be read proves no commit: the retry keeps its expectation, and the 409 names that answer', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    // The first attempt is applied, but its answer arrives as a 502 whose body read fails.
    let first = true;
    const lost5xx = async (url, init) => {
      if (!first || !String(url).includes('/admin/')) return realFetch(url, init);
      first = false;
      await (await realFetch(url, init)).text();
      const body = new ReadableStream({ start(c) { c.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); } });
      return new Response(body, { status: 502 });
    };
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT), { fetch: lost5xx });
    assert.equal(r.code, 1);
    assert.deepEqual(admins(r.requests).map((x) => JSON.parse(x.body).conferences[0].expect_status), [null, null]);
    assert.ok(r.stderr.includes(`testconf-2099 (no row)${TO}searchable; nothing was written by this attempt; an earlier attempt of this command answered status 502, its answer lost and may have been applied`), r.stderr);
    assert.equal(r.audit.at(-1).error, 'status_mismatch');
  });

  test('the adapter drops every control key and near-miss of a document it is handed, before it sends', async () => {
    const adapter = createWorkerAdapter({ name: 't2', tier: 2, api: stub.url }, { credential: TOKEN, fetch: realFetch });
    const nearMiss = { 'Expect_Status': 'draft', ' expect_status': 'searchable', 'EXPECT_STATUS ': 7, 'Unretire': 'yes', 'unretire ': false, expect_status: 'draft', unretire: true };
    const before = stub.requests.length;
    const hidden = await adapter.hideConference({ event: EVENT, slug: EVENT, mode: 'run', doc: { slug: EVENT, name: 'Test Conf', status: 'unavailable', status_reason: 'operator_hidden', ...nearMiss } });
    assert.equal(hidden.counts.upserted, 1);
    const put = stub.requests.slice(before).find((x) => x.method === 'PUT');
    const doc = JSON.parse(put.body).conferences[0];
    for (const key of Object.keys(nearMiss)) assert.ok(!Object.hasOwn(doc, key), `the hide sends no ${JSON.stringify(key)}`);
    assert.equal(doc.status_reason, 'operator_hidden');
    // The unretire sends its own flag and precondition, never the document's.
    stub.state.conferences = stub.state.conferences.filter((c) => c.slug !== EVENT);
    stub.state.retired.add(EVENT);
    const mark = stub.requests.length;
    await adapter.unretireConference({ event: EVENT, slug: EVENT, mode: 'run', doc: { slug: EVENT, status: 'searchable', ...nearMiss } });
    const sent = JSON.parse(stub.requests.slice(mark).find((x) => x.method === 'PUT').body).conferences[0];
    for (const key of Object.keys(nearMiss).filter((k) => k !== 'expect_status' && k !== 'unretire')) assert.ok(!Object.hasOwn(sent, key), `the unretire sends no ${JSON.stringify(key)}`);
    assert.equal(sent.expect_status, null);
    assert.equal(sent.unretire, true);
    assert.deepEqual(stub.problems, [], 'the stand-in saw no near-miss key and no invalid expect_status');
  });

  test('no near-miss of expect_status or unretire is ever sent or written back, whatever the local document holds; a hide sends no precondition', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    const path = join(root, 'data', EVENT, 'conference.json');
    const nearMiss = { 'Expect_Status': 'draft', ' expect_status': 'searchable', 'EXPECT_STATUS ': 7, 'Unretire': 'yes', 'unretire ': false };
    writeFileSync(path, JSON.stringify({ ...readJson(path), ...nearMiss, expect_status: '', unretire: false }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const doc = sentDoc(r);
    for (const key of Object.keys(nearMiss)) assert.ok(!Object.hasOwn(doc, key), `${JSON.stringify(key)} is not sent`);
    assert.equal(doc.expect_status, null, "the CLI's own precondition, not the file's");
    assert.equal(doc.unretire, true, "the CLI's own flag, not the file's");
    assert.equal(doc.name, `Conference ${EVENT}`, 'the conference fields go as they are');
    const controlKeys = [...Object.keys(nearMiss), 'expect_status', 'unretire'];
    const salt = () => writeFileSync(path, JSON.stringify({ ...readJson(path), ...nearMiss, expect_status: 'draft', unretire: true }));
    const clean = (what) => { for (const key of controlKeys) assert.ok(!Object.hasOwn(readJson(path), key), `${what} writes no ${JSON.stringify(key)} back`); };
    salt();
    const hide = await invoke(confirmed(['conferences', 'hide', '--event', EVENT, '--reason', 'other'], EVENT));
    assert.equal(hide.code, 0, hide.stderr);
    const hidden = sentDoc(hide);
    for (const key of controlKeys) assert.ok(!Object.hasOwn(hidden, key), `the hide sends no ${JSON.stringify(key)}`);
    clean('hide');
    assert.equal(readJson(path).status_reason, 'operator_hidden');
    salt();
    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(unhide.code, 0, unhide.stderr);
    for (const key of controlKeys) assert.ok(!Object.hasOwn(sentDoc(unhide), key), `the unhide sends no ${JSON.stringify(key)}`);
    clean('unhide');
    salt();
    const remove = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(remove.code, 0, remove.stderr);
    clean('remove');
    assert.equal(readJson(path).status_reason, 'operator_removed');
    // invoke checked that the stand-in saw no near-miss key and no invalid expect_status.
  });

  test('a 200 that lists the slug under skipped_retired is "not applied (retired)", exit 1, and leaves the local files alone', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    stub.forced.push({ status: 200, body: { upserted: 0, searchable: 0, synced: 0, skipped_retired: [EVENT] } });
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'caddie-admin: unretire of testconf-2099 not applied (retired): the Worker answered status 200 and listed testconf-2099 under skipped_retired, so it kept the tombstone and applied nothing of the document; a Worker that reads "unretire": true never skips it, so check that the Worker is deployed from a version with the unretire flag (worker/README.md), then run conferences unretire --event testconf-2099 again\n');
    assert.equal(r.audit.at(-1).error, 'skipped_retired');
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT]);
    stub.forced.push({ status: 200, body: { upserted: 0, searchable: 0, synced: 0, skipped_retired: [EVENT] } });
    const asJson = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT));
    assert.equal(JSON.parse(asJson.stderr).error, 'skipped_retired');
  });

  test('a status_mismatch shows (no row) for null, quotes a status that reads as null, counts malformed entries and names at most 20', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    stub.forced.push({ status: 409, body: { error: 'status_mismatch', mismatched: [
      { slug: EVENT, expected: null, actual: 'null' },
      { slug: OTHER, expected: 'NULL', actual: null },
      { slug: 'Bad Slug \u001b[2J', expected: null, actual: 'searchable' },
      { slug: EVENT, expected: null, actual: 'x\u001b]52;c;aGk=\u0007' },
      null,
    ] } });
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`(expected${TO}actual): testconf-2099 (no row)${TO}"null", otherconf-2099 "NULL"${TO}(no row) (3 malformed entries not shown); nothing was written`), r.stderr);
    assert.ok(!r.stderr.includes('\u001b') && !r.stderr.includes('aGk'), 'nothing of a malformed entry is echoed');
    // "null" as a status, a malformed status and a null entry are none a row holds: a version
    // mismatch, with no advice to run it again.
    assert.ok(r.stderr.includes('so the Worker and this CLI are not from the same version; do not run the unretire again until they are'), r.stderr);
    assert.ok(!r.stderr.includes('run conferences unretire --event'));
    stub.forced.push({ status: 409, body: { error: 'status_mismatch', mismatched: Array.from({ length: 22 }, () => ({ slug: EVENT, expected: null, actual: 'searchable' })) } });
    const many = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(many.stderr.split(`(no row)${TO}searchable`).length - 1, 20);
    assert.ok(many.stderr.includes(`(no row)${TO}searchable and 2 more; nothing was written`));
  });

  test('a 409 whose actual status is one a row never holds is a version mismatch: no re-run advised', async () => {
    seedConferenceFiles(EVENT);
    RECORDED();
    removedOnWorker();
    stub.forced.push({ status: 409, body: { error: 'status_mismatch', mismatched: [{ slug: EVENT, expected: null, actual: 'partial_index' }] } });
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `caddie-admin: unretire of testconf-2099 not applied: the directory holds another status than this command expected (expected${TO}actual): testconf-2099 (no row)${TO}partial_index; nothing was written by this attempt; the Worker answered a status that a directory row never holds in this CLI's version (searchable or unavailable, or no row), so the Worker and this CLI are not from the same version; do not run the unretire again until they are (PUT /admin/conferences: status 409 (status_mismatch))\n`);
    assert.equal(r.audit.at(-1).error, 'status_mismatch');
    assert.deepEqual(Object.keys(operatorFile().removed), [EVENT]);
  });

  test('a listing that does not say what the row holds refuses the unretire and sends nothing', async () => {
    seedConferenceFiles(EVENT);
    for (const [conferences, shown] of [
      [[{ slug: EVENT, status: 'partial_index' }], 'partial_index'],
      [[{ slug: EVENT, status: 'searchable' }, { slug: EVENT, status: 'unavailable' }], 'searchable and unavailable'],
      [[{ slug: EVENT }], 'a malformed value'],
    ]) {
      for (const argv of [['conferences', 'unretire', '--event', EVENT], confirmed(['conferences', 'unretire', '--event', EVENT], EVENT)]) {
        const r = await invoke(argv, { fetch: listing(conferences) });
        assert.equal(r.code, 1);
        assert.match(r.stderr, new RegExp(`testconf-2099 is listed on the Worker as ${shown}, which is not one status a directory row stores \\(searchable or unavailable\\), so this command cannot tell what to expect; refused, nothing was sent`));
        assert.equal(r.audit.at(-1).error, 'unretire_refused');
        assert.deepEqual(admins(r.requests), []);
      }
    }
  });

  test('the stand-in answers as the Worker does: 400 for a near-miss key or an invalid expect_status, 409 status_mismatch for the whole batch, writing nothing', async () => {
    const send = async (conferences) => {
      const payload = JSON.stringify({ conferences });
      const signed = signAdminRequest({ method: 'PUT', path: '/admin/conferences', base: stub.url, body: payload, key: TOKEN, now: Date.now() });
      const res = await realFetch(signed.url, { method: 'PUT', headers: { [HEADER_NAME]: signed.header, 'Content-Type': 'application/json' }, body: payload });
      return [res.status, await res.json()];
    };
    const before = JSON.stringify(stub.state.conferences);
    for (const key of ['Expect_Status', ' expect_status', 'EXPECT_STATUS ']) assert.deepEqual(await send([{ slug: EVENT, status: 'searchable', [key]: 'searchable' }]), [400, { error: 'the key must be written exactly as expect_status' }]);
    for (const key of ['Unretire', 'unretire ']) assert.deepEqual(await send([{ slug: EVENT, [key]: true }]), [400, { error: 'the key must be written exactly as unretire' }]);
    for (const value of [0, true, {}, [], '']) assert.deepEqual(await send([{ slug: EVENT, expect_status: value }]), [400, { error: 'expect_status must be a non-empty string or null' }]);
    stub.state.retired.add(OTHER);
    const batch = [
      { slug: OTHER, status: 'searchable', expect_status: 'unavailable', unretire: true },
      { slug: EVENT, status: 'unavailable', expect_status: 'unavailable' },
      { slug: 'new-2099', status: 'searchable', expect_status: 'searchable' },
    ];
    assert.deepEqual(await send(batch), [409, { error: 'status_mismatch', mismatched: [{ slug: EVENT, expected: 'unavailable', actual: 'searchable' }, { slug: 'new-2099', expected: 'searchable', actual: null }] }]);
    assert.equal(JSON.stringify(stub.state.conferences), before, 'no row written');
    assert.ok(stub.state.retired.has(OTHER), 'no tombstone dropped');
    assert.deepEqual(stub.state.puts, []);
    const [status, answer] = await send([batch[0], { ...batch[1], expect_status: 'searchable' }, { ...batch[2], expect_status: null }]);
    assert.equal(status, 200);
    assert.deepEqual(answer.skipped_retired, []);
    assert.ok(!stub.state.retired.has(OTHER));
    assert.ok(stub.state.puts.every((d) => !('expect_status' in d) && !('unretire' in d)), 'neither key is stored');
    // Each 400 above is also a problem the stand-in reports, so a CLI run that sent one would fail.
    assert.equal(stub.problems.length, 10);
    stub.problems.length = 0;
    // The CLI shows both 400s as plain codes, should one ever come back.
    for (const error of ['the key must be written exactly as expect_status', 'expect_status must be a non-empty string or null']) {
      // Listed as unavailable since the batch above, as the local document is.
      seedConferenceFiles(EVENT, { status: 'unavailable' });
      stub.forced.push({ status: 400, body: { error } });
      const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes(`PUT /admin/conferences: status 400 (${error})`), r.stderr);
    }
  });
});

describe('SEC terminal output: control characters in user text are escaped', () => {
  // OSC 52 (clipboard write), CSI 2J (clear screen), a right-to-left override, a C1 CSI (0x9B)
  // and a newline, in a display name and in profile text.
  const HOSTILE = 'Eve\u001b]52;c;aGk=\u0007 \u001b[2J \u202Eevil\u202C \u009b31m\nnext';
  const RAW = ['\u001b', '\u0007', '\u202e', '\u202c', '\u009b', '\n'];
  const cleanOf = (text) => text.split('\n').every((line) => RAW.filter((c) => c !== '\n').every((c) => !line.includes(c)));

  test('human and --json output of search, view, queue and errors hold no raw control or bidi character on tier 2', async () => {
    const p = person(HOSTILE, { hidden: true, about: `about ${HOSTILE}`, spot: HOSTILE, pending: { spot: HOSTILE }, reporters: [{ id: 'r', reason: 'spam' }] });
    stub.state.meets.set(MEET, { meet_id: MEET, state: 'accepted', between: [HOSTILE, 'Bob'], hidden: true, reports: [] });
    const runs = [
      ['attendees', 'search', '--event', EVENT, '--name', 'Eve', '--include-hidden'],
      ['attendees', 'view', '--event', EVENT, p.ref, '--text'],
      ['moderation', 'queue', '--event', EVENT, '--show-content', '--since', '2026-11-01T00:00:00Z'],
    ];
    for (const argv of runs) {
      for (const flag of [[], ['--json']]) {
        const r = await invoke([...argv, ...flag]);
        assert.equal(r.code, 0, `${argv.join(' ')} ${flag}: ${r.stderr}`);
        assert.ok(cleanOf(r.stdout), `raw control characters in stdout of ${argv.join(' ')} ${flag}`);
        assert.ok(!r.stdout.includes('\u202e') && !r.stdout.includes('\u009b'), 'no bidi override or C1');
        if (flag.length) {
          const parsed = JSON.parse(r.stdout);
          assert.ok(JSON.stringify(parsed).includes('Eve'), 'the JSON still parses to the same document');
          assert.match(r.stdout, /\\u001b\]52;c;aGk=\\u0007/, 'C0 as JSON escapes');
          assert.match(r.stdout, /\\u202e/);
          assert.match(r.stdout, /\\u009b/);
          assert.match(r.stdout, /\\nnext/, 'the newline as a JSON escape');
          assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one JSON line');
        } else {
          assert.match(r.stdout, /Eve\\u\{1B\}\]52;c;aGk=\\u\{7\} \\u\{1B\}\[2J \\u\{202E\}evil\\u\{202C\} \\u\{9B\}31m\\u\{A\}next/);
          assert.equal(r.stdout.trimEnd().split('\n').length, argv[1] === 'view' ? 4 : argv[1] === 'queue' ? 4 : 2, 'a newline in a value does not add a line');
        }
        assert.ok(cleanOf(JSON.stringify(r.audit)) && !JSON.stringify(r.audit).includes('Eve'), 'the audit holds no user text');
      }
    }
    // A Worker error text and a warning are escaped too.
    stub.forced.push({ status: 400, body: { error: `bad \u001b[2J request` } });
    const err = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Eve']);
    assert.equal(err.code, 1);
    assert.ok(!err.stderr.includes('\u001b'), 'the error text is escaped, or the hostile text was dropped');
    assert.match(err.stderr, /status 400$/m, 'an error text outside the plain charset is dropped, not echoed');
    stub.forced.push({ status: 400, body: { error: `bad \u001b[2J request` } });
    const errJson = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Eve', '--json']);
    assert.ok(!errJson.stderr.includes('\u001b'));
    JSON.parse(errJson.stderr);
  });
});

describe('STAT-1 to STAT-3 stats', () => {
  test('counts with --event prints the tables; without it, the requests per conference from the account stats', async () => {
    const r = await invoke(['stats', 'counts', '--event', EVENT, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.counts, stub.state.tables);
    assert.match((await invoke(['stats', 'counts', '--event', EVENT])).stdout, /^table=talks count=3\n/);
    const all = await invoke(['stats', 'counts', '--json']);
    assert.equal(all.code, 0, all.stderr);
    assert.equal(admins(all.requests)[0].pathWithQuery, '/admin/stats');
    assert.deepEqual(all.json().result.items, [
      { conference: EVENT, requests: 120, rows_read: 900, rows_written: 30, holds: true },
      { conference: OTHER, requests: 7, rows_read: 10, rows_written: 1, holds: false },
    ]);
    assert.deepEqual(all.json().result.counts, { testconf_2099: 120, otherconf_2099: 7 });
    assert.match(all.json().result.summary, /requests per conference on 2026-11-11/);
  });

  test('usage prints the day, each conference with its pace, and the totals', async () => {
    stub.state.account.usage['gone-2099'] = { requests: 1, rows_read: 1, rows_written: 1 };
    const r = await invoke(['stats', 'usage', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(admins(r.requests).map((x) => x.pathWithQuery), ['/admin/stats', `/admin/stats?event=${EVENT}`, `/admin/stats?event=${OTHER}`, '/admin/stats?event=gone-2099']);
    const { result } = r.json();
    assert.deepEqual(result.items[0], { conference: EVENT, requests: 120, rows_read: 900, rows_written: 30, pace: 1.5, holds: true });
    assert.equal(result.items[2].pace, null, 'a conference the Worker does not route has no pace');
    assert.deepEqual(result.items.at(-1), { day: '2026-11-11', total_requests: 128, total_rows_read: 911, total_rows_written: 32, conferences: 3 });
    assert.deepEqual(result.counts, { conferences: 3, requests: 128, rows_read: 911, rows_written: 32 });
    assert.match(result.summary, /3 conferences metered on 2026-11-11; totals 128 requests, 911 rows read, 32 rows written/);
    stub.state.account = { day: null, usage: {}, holds: {} };
    const none = await invoke(['stats', 'usage']);
    assert.match(none.stdout, /0 conferences metered on no day yet \(the cron has not run\)/);
  });

  test('usage stops at the first per-conference failure other than an unrouted conference, with its exit code', async () => {
    stub.forced.push({ pathWithQuery: `/admin/stats?event=${EVENT}`, status: 401, body: { error: 'admin_skew' } });
    const skew = await invoke(['stats', 'usage']);
    assert.equal(skew.code, 1);
    assert.match(skew.stderr, /clock is more than five minutes/);
    assert.deepEqual(admins(skew.requests).map((x) => x.pathWithQuery), ['/admin/stats', `/admin/stats?event=${EVENT}`], 'nothing after the failure');
    stub.forced.push({ pathWithQuery: `/admin/stats?event=${OTHER}`, status: 404, body: { error: 'Not found' } });
    const refused = await invoke(['stats', 'usage']);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /refused: check the admin key/);
  });

  test('health reads the public routes unsigned and prints the smoke and log commands with variable names and paths, never a value', async () => {
    const r = await invoke(['stats', 'health']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.requests.map((x) => `${x.method} ${x.path}`), ['GET /api/health', 'GET /api/capabilities']);
    assert.match(r.stdout, /^health=200 ok=true\ncapabilities=200 tier=2 ble_mode=off push_apns=false push_fcm=false\n/);
    // The file the CLI reads (CADDIE_ADMIN_HOME/admin-token here) is always named, single-quoted,
    // never a value.
    assert.ok(r.stdout.includes(`smoke=BASE_URL='${stub.url}' SMOKE_API=worker ADMIN_TOKEN_FILE=${shellPath(join(home, 'admin-token'))} node scripts/smoke.mjs`), r.stdout);
    assert.ok(!r.stdout.split('\n').find((l) => l.startsWith('smoke=')).includes('"'), 'nothing double-quoted, so nothing in the line expands but a leading ~/');
    assert.ok(r.stdout.includes('logs=(cd worker && npx wrangler tail --format json) | node /path/to/scratch/tail-filter.mjs'), r.stdout);
    assert.match(r.stdout, /never run wrangler tail unfiltered/);
    const file = await invoke(['stats', 'health'], { env: { ADMIN_TOKEN_FILE: '/srv/caddie/admin-token' } });
    assert.ok(file.stdout.includes(`SMOKE_API=worker ADMIN_TOKEN_FILE='/srv/caddie/admin-token' node scripts/smoke.mjs`), file.stdout);
  });

  // The printed smoke command, pasted into bash -c with HOME set to a temporary directory and nothing
  // else from this environment, finds the token file: the smoke stops at "at least 32 characters"
  // on the fake short token it read, before any request (BASE_URL is never contacted).
  test('health: the printed smoke command, pasted into bash, resolves and reads the token file', { timeout: 120_000 }, async () => {
    const API = 'https://caddie-worker.example.test';
    const viaStub = (url, init) => realFetch(String(url).replace(API, stub.url), init);
    const SHORT = 'fake-short-token-not-a-secret';
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'caddie-tok-paste-')));
    const realHome = process.env.HOME;
    const put = (file, text) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { mode: 0o600 });
    };
    const paste = (command, HOME) => new Promise((done) => {
      const child = spawn('bash', ['-c', command], { cwd: ROOT, env: { PATH: process.env.PATH, HOME }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', () => {});
      child.on('close', (code) => done({ code, stdout }));
    });
    let n = 0;
    // One case: a fresh HOME, the CLI run with that HOME and `env`, the token put at `tokenAt(home)`.
    const check = async (label, { env = {}, tokenAt, configAt, expect }) => {
      const caseHome = join(tmp, `home ${++n}`);
      mkdirSync(caseHome);
      const config = configAt(caseHome);
      put(join(config, 'config.json'), JSON.stringify({ default: 'live', backends: { live: { tier: 2, api: API } } }));
      put(tokenAt(caseHome), `${SHORT}\n`);
      process.env.HOME = caseHome;
      let r;
      try {
        r = await invoke(['stats', 'health', '--json'], { fetch: viaStub, env: { CADDIE_ADMIN_HOME: undefined, XDG_CONFIG_HOME: undefined, ...env(caseHome) } });
      } finally {
        process.env.HOME = realHome;
      }
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      const { smoke } = r.json().result.commands;
      assert.equal(smoke, expect(caseHome), label);
      const run = await paste(smoke, caseHome);
      assert.equal(run.code, 1, `${label}: ${run.stdout}`);
      assert.ok(run.stdout.includes('FAIL config: the admin token must have at least 32 characters'), `${label}: the smoke did not read the token file\n${run.stdout}`);
      assert.ok(!run.stdout.includes(SHORT), `${label}: the token is never printed`);
    };
    const configHome = (h) => join(h, '.config', 'conference-caddie');
    try {
      await check('the default file: named as ~/ outside single quotes', {
        env: () => ({}),
        configAt: configHome,
        tokenAt: (h) => join(configHome(h), 'admin-token'),
        expect: () => `BASE_URL='${API}' SMOKE_API=worker ADMIN_TOKEN_FILE=~/'.config/conference-caddie/admin-token' node scripts/smoke.mjs`,
      });
      await check('ADMIN_TOKEN_FILE under HOME with a space, a quote and a $: ~/ outside the quotes', {
        env: (h) => ({ ADMIN_TOKEN_FILE: join(h, "my dir", "it's $HOME", 'admin-token') }),
        configAt: configHome,
        tokenAt: (h) => join(h, "my dir", "it's $HOME", 'admin-token'),
        expect: () => `BASE_URL='${API}' SMOKE_API=worker ADMIN_TOKEN_FILE=~/'my dir/it'\\''s $HOME/admin-token' node scripts/smoke.mjs`,
      });
      await check('XDG_CONFIG_HOME under HOME: its file is named, so any shell finds it', {
        env: (h) => ({ XDG_CONFIG_HOME: join(h, 'xdg') }),
        configAt: (h) => join(h, 'xdg', 'conference-caddie'),
        tokenAt: (h) => join(h, 'xdg', 'conference-caddie', 'admin-token'),
        expect: () => `BASE_URL='${API}' SMOKE_API=worker ADMIN_TOKEN_FILE=~/'xdg/conference-caddie/admin-token' node scripts/smoke.mjs`,
      });
      await check('CADDIE_ADMIN_HOME outside HOME: an absolute single-quoted path', {
        env: (h) => ({ CADDIE_ADMIN_HOME: join(dirname(h), `cah ${n}`) }),
        configAt: (h) => join(dirname(h), `cah ${n}`),
        tokenAt: (h) => join(dirname(h), `cah ${n}`, 'admin-token'),
        expect: (h) => `BASE_URL='${API}' SMOKE_API=worker ADMIN_TOKEN_FILE='${join(dirname(h), `cah ${n}`, 'admin-token')}' node scripts/smoke.mjs`,
      });
    } finally {
      process.env.HOME = realHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
