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
//   and unblock, and the 404-after-retry rule (PEER-6);
// - MOD-2, MOD-4, MOD-5, MOD-6, MOD-7: queue, hide, unhide, delete, purge-reports, and exit 5 for
//   purge-expired and rules;
// - CONF-1, CONF-3, CONF-4, CONF-7, CONF-8, CONF-12: list, add and refresh through gh, hide and
//   unhide through PUT /admin/conferences, remove through DELETE /admin/conference, unretire with
//   the flag in the body;
// - STAT-1 to STAT-3: counts, usage and health, with the smoke and log commands naming variables.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BODYLESS_METHODS, bodyMatches, verifyAdminSignature } from '../scripts/lib/admin-sign.mjs';
import { main } from '../scripts/admin/cli.mjs';

const realFetch = globalThis.fetch;
const TOKEN = 'dummy-worker-admin-token-0123456789-abcdefghijklmnopqrstuvwxyz';
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
  };
  const requests = [];
  const nonces = new Set();
  const problems = [];
  // Answers to force on the next admin requests, in order: { status, body, act } where act runs
  // the handler for its side effects before the forced answer is sent (an answer that was lost).
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
      if (!Array.isArray(b?.conferences)) return [400, { error: 'conferences must be an array' }];
      if (b.conferences.some((d) => d.unretire !== undefined && typeof d.unretire !== 'boolean')) return [400, { error: 'unretire must be a boolean' }];
      const skipped = [];
      let upserted = 0;
      let searchable = 0;
      for (const d of b.conferences) {
        if (state.retired.has(d.slug) && d.unretire !== true) { skipped.push(d.slug); continue; }
        state.retired.delete(d.slug);
        const { unretire, ...doc } = d;
        state.puts.push(doc);
        const i = state.conferences.findIndex((c) => c.slug === doc.slug);
        const row = { ...(i >= 0 ? state.conferences[i] : {}), ...doc, status: doc.status === 'searchable' ? 'searchable' : 'unavailable' };
        if (i >= 0) state.conferences[i] = row; else state.conferences.push(row);
        upserted += 1;
        if (row.status === 'searchable') searchable += 1;
      }
      return [200, { upserted, searchable, synced: upserted, skipped_retired: skipped }];
    }
    if (path === '/admin/conference') {
      if (method !== 'DELETE') return [405, { error: 'Method not allowed' }, { Allow: 'DELETE' }];
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(event ?? '')) return [400, { error: 'event must be a conference slug' }];
      // Tombstone first (its nonce check refuses a replay before any write), then the wipe, then
      // the directory row; a second removal reports already_retired_at.
      const known = state.conferences.some((c) => c.slug === event);
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
      return [200, state.account];
    }
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(event ?? '')) return [400, { error: 'event must be a conference slug' }];
    if (!state.conferences.some((c) => c.slug === event)) return [400, { error: 'conference is not available' }];
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
      const v = verifyAdminSignature({ headerValue: req.headers['x-caddie-admin'] ?? null, method: req.method, pathWithQuery: record.pathWithQuery, keys: [TOKEN] });
      record.nonce = v.nonce ?? null;
      if (!v.ok) {
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
      const force = forced.shift();
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
async function invoke(argv, { spawnResult, env = {}, tolerateProblems = false } = {}) {
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
    fetch: realFetch,
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
    for (const key of r.query) assert.ok(ALLOWED_QUERY_KEYS.has(key), `query key ${key} on ${r.path} (CONF-13: flags travel in the body)`);
    if (r.method === 'GET' || r.method === 'DELETE') assert.equal(r.body, '', `${r.method} ${r.path} carries no body`);
    if (r.path.startsWith('/api/')) {
      assert.equal(r.headers['x-caddie-admin'], undefined, 'public routes are not signed');
      assert.equal(r.headers['cf-access-client-id'], undefined, 'public routes carry no Access headers');
    }
  }
  if (!tolerateProblems) assert.deepEqual(stub.problems, [], 'the stand-in saw a bad admin request');
  for (const child of spawned) {
    assert.ok(!JSON.stringify([child.file, child.args, child.options?.env]).includes(TOKEN), 'the token leaked into a child process');
    assert.equal(child.options?.env?.ADMIN_TOKEN, undefined, 'the child environment has no ADMIN_TOKEN');
  }
  return { code, stdout, stderr, audit: auditLines(), requests, spawned, json: () => JSON.parse(stdout) };
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
    assert.match(admins(r.requests)[0].headers['x-caddie-admin'], /^v1 \d+ [A-Za-z0-9_-]{22} [0-9a-f]{64} [0-9a-f]{64}$/);
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
    assert.match(gone.stderr, /not found, or the admin signature was refused \(the Worker answers 404 to both/);
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
    assert.match(r.stderr, /not found, or the admin signature was refused/);
    assert.deepEqual(stub.problems.map((p) => p.split(': ').at(-1)), ['signature signature']);
    stub.problems.length = 0;
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
    const odd = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'a% _b\\ é&=']);
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
    assert.match(missing.stderr, /profile 0123456789abcdef at testconf-2099: not found, or the admin signature was refused/);
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
    assert.match(gone.stderr, /not found, or the admin signature was refused/);
    const p = person('Lost Answer');
    // The first attempt does the work but its answer is lost (a 503); the retry sees 404.
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const r = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, p.ref], p.ref));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(admins(r.requests).length, 2);
    assert.ok(!stub.state.people.has(p.ref));
    assert.match(r.stdout, /profile .*: already done or never existed \(a retried request answered 404; the first attempt may have succeeded\)/);
    assert.equal(r.audit.at(-1).result, 'ok');
    assert.deepEqual(r.audit.at(-1).counts, { profile: 0 });
    const asJson = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `profile:${p.ref}`, '--json'], `profile:${p.ref}`));
    assert.equal(asJson.code, 4, 'a plain 404 stays exit 4');
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
    // The four answers: no_operator_block after a lost attempt is "already unblocked" (exit 0);
    // not_found stays exit 4 even on a retry; found:true is an unblock; found:false removed a
    // stale report of a deleted profile.
    p.reporters.push({ id: 'operator', reason: 'operator' });
    p.hidden = true;
    stub.forced.push({ status: 503, body: { error: 'lost' }, act: true });
    const lost = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(lost.code, 0, lost.stderr);
    assert.equal(admins(lost.requests).length, 2);
    assert.match(lost.stdout, /the operator block of .*: already unblocked \(a retried request answered 404/);
    assert.equal(lost.audit.at(-1).result, 'ok');
    assert.equal(p.reporters.length, 0);
    stub.forced.push({ status: 503, body: { error: 'lost' } });
    const noPerson = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, '0123456789abcdef'], '0123456789abcdef'));
    assert.equal(noPerson.code, 4, 'not_found on a retry is still exit 4');
    assert.equal(admins(noPerson.requests).length, 2);
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
    assert.match(dryUn.stdout, /would clear the hidden flag of profile .* and remove 1 report/);
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
    assert.match(lost.stdout, /the hidden flag of profile 0123456789abcdef: already done or never existed/);
    assert.equal(lost.audit.at(-1).result, 'ok');
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
    const r = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: { stdout: '✓ Created workflow_dispatch event for ingest.yml at main\n' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.spawned.length, 1);
    const [child] = r.spawned;
    assert.equal(child.file, 'gh');
    assert.deepEqual(child.args, ['workflow', 'run', 'ingest.yml', '-f', `events=${OTHER}`]);
    assert.equal(child.options.cwd, root);
    assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(stub.requests.length, 0, 'no Worker request');
    assert.match(r.stdout, /step=gh line=✓ Created workflow_dispatch event/);
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
    assert.equal(search.code, 1);
    assert.match(search.stderr, /the Worker does not route testconf-2099 \(no conference, or it was removed; after a removal run conferences unretire --event testconf-2099 and then conferences refresh\)/);
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
    assert.equal(stub.requests.length, 0);
    assert.match(dry.stdout, /would send testconf-2099 to PUT \/admin\/conferences with "unretire": true in the body/);
    assert.ok(stub.state.retired.has(EVENT));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const put = admins(r.requests)[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.pathWithQuery, '/admin/conferences');
    assert.deepEqual(put.query, []);
    const doc = JSON.parse(put.body).conferences[0];
    assert.equal(doc.unretire, true);
    assert.equal(doc.slug, EVENT);
    assert.equal(doc.status_reason, null, 'the local document as it is (seeded searchable)');
    assert.ok(!stub.state.retired.has(EVENT), 'the tombstone is gone');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.match(r.stdout, /sent testconf-2099 with unretire: true; the Worker dropped its tombstone \(upserted 1\); commit data\/conference-operator\.json; run conferences refresh --event testconf-2099 next/);
    assert.deepEqual(r.audit.at(-1).counts, { upserted: 1, searchable: 1, synced: 1 });
    assert.equal((await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT))).code, 4);
  });

  test('unretire of an unavailable local document renders the counts as the Worker returns them (synced 1, searchable 0)', async () => {
    seedConferenceFiles(EVENT, { status: 'unavailable', statusReason: 'operator_removed' });
    stub.state.retired.add(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT, '--json'], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.counts, { upserted: 1, searchable: 0, synced: 1 });
    assert.ok(!stub.state.retired.has(EVENT));
  });

  test('unretire without a local file sends the slug alone', async () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [OTHER]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', OTHER], OTHER));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(admins(r.requests)[0].body), { conferences: [{ slug: OTHER, unretire: true }] });
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

  test('health reads the public routes unsigned and prints the smoke and log commands with variable names and paths, never a value', async () => {
    const r = await invoke(['stats', 'health']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.requests.map((x) => `${x.method} ${x.path}`), ['GET /api/health', 'GET /api/capabilities']);
    assert.match(r.stdout, /^health=200 ok=true\ncapabilities=200 tier=2 ble_mode=off push_apns=false push_fcm=false\n/);
    assert.ok(r.stdout.includes(`smoke=BASE_URL="${stub.url}" ADMIN_TOKEN_FILE="~/.config/conference-caddie/admin-token" node scripts/smoke.mjs`), r.stdout);
    assert.ok(r.stdout.includes('logs=(cd worker && npx wrangler tail --format json) | node /path/to/scratch/tail-filter.mjs'), r.stdout);
    assert.match(r.stdout, /never run wrangler tail unfiltered/);
    const file = await invoke(['stats', 'health'], { env: { ADMIN_TOKEN_FILE: '/srv/caddie/admin-token' } });
    assert.ok(file.stdout.includes('ADMIN_TOKEN_FILE="/srv/caddie/admin-token"'));
  });
});
