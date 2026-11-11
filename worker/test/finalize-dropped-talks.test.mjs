// What happens to people when a re-ingest removes a talk they shared for (a cancelled session or a
// takedown): POST /admin/talks/finalize removes the talk's shared_talks rows, so no circle is left
// for it, and deletes a profile that is then neither open to meet nor sharing for any talk; a later
// profile write that still names the talk drops it instead of failing. The object runs in Node on a
// real SQLite database (node:sqlite) behind a small stand-in for state.storage, with fake embeddings
// (EMBED_FAKE), as in conference-meter.test.mjs.
//
// module.registerHooks needs Node 22.15 or later; on older versions these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';

// crypto.subtle.timingSafeEqual is a Workers extension that Node does not have.
if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a.buffer ?? a), new Uint8Array(b.buffer ?? b));
}

const DURABLE_OBJECT_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const hooks = typeof nodeModule.registerHooks === 'function';
let ConferenceDO = null;
if (hooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') return { url: DURABLE_OBJECT_STUB, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('file:') && url.endsWith('.json')) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  ({ ConferenceDO } = await import('../src/conference.js'));
}
const skip = hooks ? false : 'module.registerHooks needs Node 22.15 or later';

function fakeState() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...args) => {
    // Node 22's node:sqlite binds typed arrays but not an ArrayBuffer (a stored vector); the Workers
    // runtime and newer Node bind both.
    const b = args.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const multi = b.length === 0 && /;\s*\S/.test(q.trim().replace(/;\s*$/, ''));
    let rows = [];
    if (multi) db.exec(q);
    else rows = db.prepare(q).all(...b);
    const writes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q);
    return { toArray: () => rows, one: () => rows[0], rowsRead: 1, rowsWritten: writes ? 1 : 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  return {
    db,
    storage: { sql: { exec }, transactionSync: (fn) => fn() },
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil: () => {},
  };
}

const SLUG = 'caddie-fixture-2099';
const T = (n) => `${SLUG}:${n}`;
let ipCounter = 0;

function request(method, path, body, { device } = {}) {
  const headers = { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-ip': `192.0.2.${(ipCounter++ % 200) + 1}` };
  if (device) headers['x-caddie-device'] = `${device.id}.${device.secret}`;
  return new Request(`https://do.internal${path}?event=${SLUG}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const device = (c) => ({ id: c.repeat(22), secret: c.repeat(43) });

function talk(n, title) {
  return {
    talk_id: T(n), conference: SLUG, session_id: String(n), kind: 'talk', title, abstract: `About ${title}.`,
    speakers: ['Ada Lovelace'], speaker_taglines: [], speaker_profiles: [{ name: 'Ada Lovelace', tagline: null, links: [] }],
    room: 'Room 1', track: 'Track', level: null, tags: [], tag_keys: [], topics: [], sponsor: false, has_slides: false, slides_url: null,
    url: `https://example.org/${n}`, start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z', day: '2099-06-01', start_minutes: 600, end_minutes: 630,
    content_hash: `hash-${n}`, text_hash: `text-${n}`,
  };
}

async function call(obj, method, path, body, opts) {
  const res = await obj.fetch(request(method, path, body, opts));
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function setup() {
  const state = fakeState();
  const obj = new ConferenceDO(state, { EMBED_FAKE: '1' });
  const conf = { slug: SLUG, name: 'Fixture', status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC' };
  const res = await obj.fetch(new Request('https://do.internal/internal/conference', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc: conf, route_prefix: '' }),
  }));
  assert.equal(res.status, 200);
  const first = await call(obj, 'POST', '/admin/talks', { generation: 1, talks: [talk(1, 'Kept talk'), talk(2, 'Cancelled talk')] });
  assert.equal(first.status, 200);
  assert.equal(first.json.upserted, 2);
  return { obj, state };
}

const profile = (name) => ({ display_name: name, about: `${name} works on schedulers.` });
const put = (obj, d, name, open, shared) => call(obj, 'PUT', '/api/people/profile', { event: SLUG, profile: profile(name), open_to_meet: open, shared_talk_ids: shared }, { device: d });
const counts = async (obj) => (await call(obj, 'POST', '/api/circles/counts', { event: SLUG, talk_ids: [T(1), T(2)] })).json.counts;

test('finalize removes the circle of a dropped talk and the profiles left with neither choice', { skip }, async () => {
  const { obj, state } = await setup();
  const onlyDropped = device('a'); // shares for the dropped talk only, not open to meet
  const open = device('b'); // open to meet, shares for both talks
  const both = device('c'); // not open to meet, shares for both talks
  assert.equal((await put(obj, onlyDropped, 'Only Dropped', false, [T(2)])).status, 200);
  assert.equal((await put(obj, open, 'Open Person', true, [T(1), T(2)])).status, 200);
  assert.equal((await put(obj, both, 'Both Talks', false, [T(1), T(2)])).status, 200);
  assert.deepEqual(await counts(obj), { [T(1)]: 2, [T(2)]: 3 });

  // The next ingest no longer sends talk 2: talk 1 comes back unchanged, then finalize.
  const again = await call(obj, 'POST', '/admin/talks', { generation: 2, talks: [talk(1, 'Kept talk')] });
  assert.equal(again.json.unchanged, 1);
  const fin = await call(obj, 'POST', '/admin/talks/finalize', { generation: 2 });
  assert.equal(fin.status, 200);
  assert.deepEqual(fin.json, { talks: 1, deleted: 1, unshared: 3, profiles_deleted: 1 });

  // No circle is left for the dropped talk, and nobody reaches anyone through it.
  assert.deepEqual(await counts(obj), { [T(1)]: 2, [T(2)]: 0 });
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM shared_talks WHERE talk_id = ?').get(T(2)).n, 0);
  const members = await call(obj, 'POST', '/api/circles/members', { event: SLUG, talk_id: T(2) }, { device: open });
  assert.equal(members.status, 403);
  assert.deepEqual(members.json, { error: 'share_required', count: 0 });
  const kept = await call(obj, 'POST', '/api/circles/members', { event: SLUG, talk_id: T(1) }, { device: open });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.count, 2);

  // The profile that shared only for the dropped talk is gone; the others stay.
  const ids = state.db.prepare('SELECT profile_id FROM people ORDER BY profile_id').all().map((r) => r.profile_id);
  assert.deepEqual(ids, [open.id, both.id]);
});

test('a profile write that still names a dropped talk drops it instead of failing', { skip }, async () => {
  const { obj } = await setup();
  const open = device('d');
  const quiet = device('e');
  assert.equal((await put(obj, open, 'Open Person', true, [T(1), T(2)])).status, 200);
  assert.equal((await put(obj, quiet, 'Quiet Person', false, [T(2)])).status, 200);
  await call(obj, 'POST', '/admin/talks', { generation: 2, talks: [talk(1, 'Kept talk')] });
  await call(obj, 'POST', '/admin/talks/finalize', { generation: 2 });

  // The app sends the list it stored, which still holds the dropped talk; the echo is what was stored.
  const w = await put(obj, open, 'Open Person', true, [T(1), T(2)]);
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.shared_talk_ids, [T(1)]);
  // Not open to meet and only the dropped talk: as a write with both choices off, nothing is stored.
  const q = await put(obj, quiet, 'Quiet Person', false, [T(2)]);
  assert.equal(q.status, 200);
  assert.deepEqual(q.json, { ok: true, open_to_meet: false, shared_talk_ids: [] });
  // A talk of another conference is still refused.
  const foreign = await put(obj, open, 'Open Person', true, ['other-conference-2099:1']);
  assert.equal(foreign.status, 400);
  // Search and the schedule never return the dropped talk.
  const sched = await call(obj, 'GET', '/api/schedule');
  assert.equal(sched.status, 200);
  assert.deepEqual(sched.json.talks.map((t) => t.talk_id), [T(1)]);
});

test('a finalize that would delete many talks is refused unless allow_shrink is set, and keeps people as they were', { skip }, async () => {
  const { obj, state } = await setup();
  const many = Array.from({ length: 30 }, (_, i) => talk(i + 1, `Talk ${i + 1}`));
  assert.equal((await call(obj, 'POST', '/admin/talks', { generation: 3, talks: many })).status, 200);
  assert.equal((await call(obj, 'POST', '/admin/talks/finalize', { generation: 3 })).status, 200);
  const sharer = device('f');
  assert.equal((await put(obj, sharer, 'Sharer', false, [T(25)])).status, 200);

  // A short feed: only the first 15 talks come back, so finalize would delete 15 of 30.
  assert.equal((await call(obj, 'POST', '/admin/talks', { generation: 4, talks: many.slice(0, 15) })).status, 200);
  const refused = await call(obj, 'POST', '/admin/talks/finalize', { generation: 4 });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /would delete 15 of 30 talks/);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM talks').get().n, 30);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM shared_talks WHERE talk_id = ?').get(T(25)).n, 1);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM people WHERE profile_id = ?').get(sharer.id).n, 1);

  assert.equal((await call(obj, 'POST', '/admin/talks/finalize', { generation: 4, allow_shrink: 'yes' })).status, 400);
  const allowed = await call(obj, 'POST', '/admin/talks/finalize', { generation: 4, allow_shrink: true });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.deleted, 15);
  assert.equal(allowed.json.profiles_deleted, 1);
});
