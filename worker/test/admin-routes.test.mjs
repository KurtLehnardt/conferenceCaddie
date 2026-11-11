// The operator's admin routes (W6, W7): people search and view, the operator's block, moderation
// hide and the unhide fix, the conference removal with its tombstone and unretire, and the
// cross-conference stats. Every request goes through the Worker's fetch handler, signed with the
// shared fixture's fake key, to real objects on node:sqlite (helpers/harness.mjs), unless a test
// says it calls an object directly. Each route is also applied twice with a fresh signature, as the
// clients retry, and must answer success both times and leave the same stored state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { skip, ConferenceDO, DirectoryDO, worker, adminRoutes, fakeState, namespace, withFixedClock } from './helpers/harness.mjs';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const BASE = 'https://caddie.example';
const SLUG = 'caddie-fixture-2099';
const OTHER = 'other-fixture-2099';
const conf = (slug, extra = {}) => ({ slug, name: slug, status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC', ...extra });
const HOUR = 3600_000;
const NO_REF = '0123456789abcdef';
const q64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(16).toString('base64url');

// The keys no admin answer may ever carry, at any depth.
const FORBIDDEN_KEYS = new Set([
  'profile_id', 'secret_hash', 'reporter_id', 'target_profile_id', 'endpoint', 'p256dh', 'auth', 'zone', 'location', 'lat', 'lon',
  'accuracy', 'cell', 'ble_token', 'ble_token_until_ms', 'presence_nonce', 'ble_master_id', 'ble_rotated', 'ble_key', 'ble_key_id',
  'text_hash', 'vec', 'vec_about', 'vec_interests', 'vec_expertise', 'requester_id', 'recipient_id', 'blocker_id', 'blocked_id', 'note',
  'rendezvous', 'spot_me', 'since_ms', 'until_ms',
]);

function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

// The Worker's environment with real objects, as in admin-nonces.test.mjs.
function realEnv() {
  const states = new Map();
  const CONFERENCE = namespace((name) => {
    const state = fakeState();
    states.set(`conference:${name}`, state);
    return new ConferenceDO(state, { EMBED_FAKE: '1' });
  });
  const DIRECTORY = namespace((name) => {
    const state = fakeState();
    states.set(`directory:${name}`, state);
    return new DirectoryDO(state, {});
  });
  const env = { ADMIN_TOKEN: KEY, EMBED_FAKE: '1', CONFERENCE, DIRECTORY };
  return { env, states, CONFERENCE, DIRECTORY, obj: (slug = SLUG) => CONFERENCE.objects.get(slug), db: (name) => states.get(name).db };
}

// Signs once; build() makes a fresh Request with that signature each time, as a replay would.
function signed(method, path, { body, now, nonce } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const s = signAdminRequest({ method, path, base: BASE, body: payload, key: KEY, now, nonce });
  const build = () => new Request(s.url, {
    method,
    headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': '2001:db8::99', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload,
  });
  return { ...s, build };
}

async function call(env, req) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    const res = await worker.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// A Durable Object namespace whose first call matching `match(path, method)` fails: it answers
// respond() when given, or throws as a network failure would (the Worker's callDo turns that into
// a 502). Every later call goes through to the same objects.
function failOnce(ns, match, respond = null) {
  let failed = false;
  return {
    ...ns,
    get: (id) => {
      const stub = ns.get(id);
      return {
        fetch: async (url, init) => {
          if (!failed && match(new URL(url).pathname, init?.method ?? 'GET')) {
            failed = true;
            if (respond) return respond();
            throw new Error('network failure');
          }
          return stub.fetch(url, init);
        },
      };
    },
  };
}
const dailyLimit = () => new Response(JSON.stringify({ error: 'daily_limit' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } });

// An admin request sent straight to an object, with the headers the Worker forwards.
const toObject = (o, method, path, body) => o.fetch(new Request(`https://do.internal${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': newId(), 'x-caddie-admin-ts': String(Math.floor(Date.now() / 1000)) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

// One signed request, signed afresh (a retry is a new signature).
const send = (ctx, method, path, body) => call(ctx.env, signed(method, path, { body }).build());
const pair = (r) => [r.status, r.json];
const ok = (r) => assert.ok(r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`);

async function withConferences(ctx, slugs = [SLUG]) {
  const r = await send(ctx, 'PUT', '/admin/conferences', { conferences: slugs.map((s) => conf(s)) });
  assert.deepEqual([r.status, r.json], [200, { upserted: slugs.length, searchable: slugs.length, synced: slugs.length, skipped_retired: [] }]);
}

async function person(o, { name = 'Someone', id = newId(), ...rest } = {}) {
  return o.store.insertPerson({ profile_id: id, secret_hash: sha(`secret-${id}`), display_name: name, open_to_meet: true, visible_until_ms: Date.now() + 48 * HOUR, ...rest });
}

const rows = (db, sql, ...b) => db.prepare(sql).all(...b).map((r) => ({ ...r }));

// Every table of a database, without SQLite's own and the FTS5 shadow tables.
function tablesOf(db) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name)
    .filter((n) => !/_fts_(data|idx|content|docsize|config)$/.test(n));
}

// The stored state of a database, for the twice-applied tests: every row of every table except
// the nonces (a retry is a new nonce) and the meter's usage_days (every request counts).
function snapshot(db) {
  const out = {};
  for (const t of tablesOf(db)) {
    if (t === 'admin_nonces' || t === 'usage_days') continue;
    out[t] = rows(db, `SELECT * FROM ${t}`).map((r) => JSON.stringify(r, (k, v) => (v instanceof Uint8Array ? [...v] : v))).sort();
  }
  return out;
}
const state = (ctx, slugs = [SLUG]) => ({ directory: snapshot(ctx.db('directory:global')), ...Object.fromEntries(slugs.map((s) => [s, snapshot(ctx.db(`conference:${s}`))])) });

// Applies the same request twice with fresh signatures: both answer 200, the stored state after
// the second is the state after the first, and (unless told otherwise) the answers are equal.
async function twice(ctx, method, path, body, { slugs = [SLUG], sameAnswer = true } = {}) {
  const first = await send(ctx, method, path, body);
  ok(first);
  const after = state(ctx, slugs);
  const second = await send(ctx, method, path, body);
  ok(second);
  assert.deepEqual(state(ctx, slugs), after, `${method} ${path}: the second application changed the stored state`);
  if (sameAnswer) assert.deepEqual(second.json, first.json);
  return [first.json, second.json];
}

describe('people search (W7.1)', { skip }, () => {
  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    const o = ctx.obj();
    const target = await person(o, { name: 'Ann 50% Lee' });
    const decoys = [];
    for (const name of ['Ann 50 Lee', 'Bob 500 Lake', 'a_b', 'axb', 'back\\slash', 'backslash', 'Zed']) decoys.push(await person(o, { name }));
    const hidden = await person(o, { name: 'ann 50% lee hidden', hidden: true });
    return { ctx, o, target, hidden, decoys };
  }
  const names = (r) => r.json.people.map((p) => p.display_name);

  test('q64 of a text holding % and a space finds that person and nobody else, case-insensitive for ASCII', async () => {
    const { ctx, target } = await setup();
    const r = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('50% L')}`);
    ok(r);
    assert.deepEqual(r.json, {
      people: [{ ref: target.ref, display_name: 'Ann 50% Lee', hidden: false, spot_hidden: false, open_to_meet: true, sample: false, visible_until: new Date(target.visible_until_ms).toISOString() }],
      matched: 1,
    });
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('50% l')}`)), ['Ann 50% Lee']);
    // _ and \ match themselves too.
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('_')}`)), ['a_b']);
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('\\')}`)), ['back\\slash']);
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('%')}`)), ['Ann 50% Lee']);
  });

  test('hidden people only with include_hidden=1; ordered by display_name; limit and matched', async () => {
    const { ctx } = await setup();
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('50% L')}&include_hidden=1`)), ['Ann 50% Lee', 'ann 50% lee hidden']);
    assert.deepEqual(names(await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('50% L')}&include_hidden=0`)), ['Ann 50% Lee']);
    const all = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('a')}&limit=2`);
    assert.deepEqual([all.json.people.length, all.json.matched], [2, 7]);
    assert.deepEqual(names(all), ['Ann 50 Lee', 'Ann 50% Lee']);
    const none = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('nobody by this name')}`);
    assert.deepEqual([none.status, none.json], [200, { people: [], matched: 0 }]);
  });

  test('ref finds that one person, hidden or not; an unknown ref is 404', async () => {
    const { ctx, hidden } = await setup();
    const r = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&ref=${hidden.ref}`);
    assert.deepEqual([r.status, names(r), r.json.people[0].hidden, r.json.matched], [200, ['ann 50% lee hidden'], true, 1]);
    const missing = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&ref=${NO_REF}`);
    assert.deepEqual([missing.status, missing.json], [404, { error: 'not_found' }]);
  });

  test('rows carry exactly the seven fields, never a profile_id', async () => {
    const { ctx, target, hidden, decoys } = await setup();
    const r = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('a')}&include_hidden=1&limit=200`);
    for (const row of r.json.people) assert.deepEqual(Object.keys(row).sort(), ['display_name', 'hidden', 'open_to_meet', 'ref', 'sample', 'spot_hidden', 'visible_until']);
    const text = JSON.stringify(r.json);
    for (const p of [target, hidden, ...decoys]) assert.ok(!text.includes(p.profile_id) && !text.includes(p.secret_hash));
  });

  test('bad input is 400: q64 and ref together or neither, bad base64url, more than 200 bytes, bad UTF-8, bad limit, unknown or repeated keys', async () => {
    const { ctx } = await setup();
    const exact = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('a'.repeat(200))}`);
    assert.deepEqual([exact.status, exact.json.matched], [200, 0], 'exactly 200 bytes is accepted');
    for (const query of [
      '', `q64=${q64('a')}&ref=${NO_REF}`, 'q64=', 'q64=ab.c', 'q64=abcde', `q64=${q64('a'.repeat(201))}`, `q64=${q64('é'.repeat(101))}`,
      `q64=${Buffer.from([0xff, 0xfe]).toString('base64url')}`, `q64=${q64('a')}&limit=0`, `q64=${q64('a')}&limit=201`, `q64=${q64('a')}&limit=1.5`,
      `q64=${q64('a')}&limit=010`, `q64=${q64('a')}&include_hidden=true`, `q64=${q64('a')}&name=x`, `q64=${q64('a')}&q64=${q64('b')}`, 'ref=ABCDEF0123456789',
      'q64=AA', `q64=${q64('Spam\u0000mer')}`, `ref=${NO_REF}&limit=0`, `ref=${NO_REF}&limit=500`, `ref=${NO_REF}&include_hidden=yes`,
    ]) {
      const r = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}${query ? `&${query}` : ''}`);
      assert.equal(r.status, 400, `${query} -> ${JSON.stringify(r.json)}`);
    }
  });

  test('a stored name with a NUL in it is still found past the NUL; a q64 of a NUL is 400, never everyone', async () => {
    const { ctx, o } = await setup();
    // Written straight to SQL: every write path now strips controls, but older rows may hold one.
    const id = newId();
    o.exec("INSERT INTO people (profile_id, ref, secret_hash, display_name, visible_until_ms, updated_at_ms) VALUES (?, 'aaaabbbbccccdddd', ?, ?, ?, ?)",
      id, sha(id), 'Nice\u0000Spammer McSpam', Date.now() + HOUR, Date.now());
    o.store.invalidatePeople();
    await person(o, { name: 'Spammer Two' });
    const r = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('spammer')}`);
    assert.deepEqual([r.status, r.json.matched, r.json.people.map((p) => p.ref).includes('aaaabbbbccccdddd')], [200, 2, true]);
    const nul = await send(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=AA`);
    assert.equal(nul.status, 400);
    assert.match(nul.json.error, /no NUL/);
  });

  test('applied twice: the same answer and no change', async () => {
    const { ctx } = await setup();
    await twice(ctx, 'GET', `/admin/people/search?event=${SLUG}&q64=${q64('50% L')}&include_hidden=1`);
  });
});

describe('people view (W7.2)', { skip }, () => {
  const BASE_KEYS = ['counts', 'display_name', 'hidden', 'open_to_meet', 'presence', 'ref', 'sample', 'spot_hidden', 'updated_at', 'visible_until'];
  const TEXT_KEYS = ['about', 'contact_note', 'expertise', 'interests', 'pending', 'spot'];
  const SENTINELS = ['Hall-SENTINEL', 'BLETOKENSENTINEL', 'NONCESENTINEL', 'MASTERSENTINEL', 'push.example', 'P256SENTINEL', 'AUTHSENTINEL', '12.345678', '98.765432', 'MEETNOTESENTINEL', 'RENDEZVOUSSENTINEL'];

  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    const o = ctx.obj();
    const now = Date.now();
    const a = await person(o, {
      name: 'Ann Example', about: 'About Ann.', interests: 'x'.repeat(400), expertise: `${'y'.repeat(299)}😀tail`, contact_note: 'Find me at the booth',
      linkedin_url: 'https://www.linkedin.com/in/ann-example', shared_talk_ids: [`${SLUG}:1`, `${SLUG}:2`],
    });
    const b = await person(o, { name: 'Bob Example' });
    const c = await person(o, { name: 'Cy Example' });
    const d = await person(o, { name: 'Di Example' });
    o.store.setPresence(a.profile_id, {
      zone: 'Hall-SENTINEL', spot: 'by the coffee', since_ms: now, until_ms: now + HOUR, ble_token: 'BLETOKENSENTINEL', ble_token_until_ms: now + HOUR,
      presence_nonce: 'NONCESENTINEL', ble_master_id: 'MASTERSENTINEL',
    });
    o.store.setLocation(a.profile_id, { lat: 12.345678, lon: 98.765432, accuracy: 5 });
    const meet = (state, expires, other = b, extra = '') => o.exec(
      'INSERT INTO meets (meet_id, requester_id, recipient_id, state, note, rendezvous, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `${extra}${newId()}`.slice(0, 22), a.profile_id, other.profile_id, state, 'MEETNOTESENTINEL', 'RENDEZVOUSSENTINEL', now, expires,
    );
    meet('requested', now + HOUR);
    meet('requested', now - 1); // ran out: ended
    meet('active', now + HOUR);
    meet('declined', now - 1);
    meet('cancelled', now - 1);
    meet('expired', now - 1);
    meet('found', now - 1); // a meet that worked
    meet('accepted', now + HOUR); // a state older versions stored
    meet('weird', now + HOUR, c);
    o.store.addBlock(a.profile_id, b.profile_id, b.ref, now + HOUR);
    o.store.addBlock(c.profile_id, a.profile_id, a.ref, now + HOUR);
    o.store.addBlock(d.profile_id, a.profile_id, a.ref, now - 1); // run out
    const push = (expires) => o.exec(
      'INSERT INTO push_subs (id, profile_id, endpoint, p256dh, auth, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(), a.profile_id, `https://push.example/${newId()}`, 'P256SENTINEL', 'AUTHSENTINEL', now, expires,
    );
    push(now + HOUR);
    push(now + HOUR);
    push(now - 1);
    const report = (kind, target, reporter, reason) => o.exec(
      'INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      `${kind}:${target}:${reporter.profile_id}`, kind, target, a.profile_id, reporter.profile_id, reason, now,
    );
    report('profile', a.ref, b, 'spam');
    report('spot', a.ref, c, 'harassment');
    const meetId = o.exec('SELECT meet_id FROM meets WHERE state = ?', 'active').one().meet_id;
    report('meet', meetId, b, 'other');
    o.exec('INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      `profile:${b.ref}:${a.profile_id}`, 'profile', b.ref, b.profile_id, a.profile_id, 'spam', now); // about Bob, not Ann
    assert.equal((await send(ctx, 'POST', `/admin/people/block?event=${SLUG}`, { ref: a.ref, action: 'block' })).status, 200);
    return { ctx, o, a, b, c, d };
  }

  test('the default view: identity, flags, presence on or off, and the counts', async () => {
    const { ctx, a } = await setup();
    const r = await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${a.ref}`);
    ok(r);
    assert.deepEqual(Object.keys(r.json), ['person']);
    const p = r.json.person;
    assert.deepEqual(Object.keys(p).sort(), BASE_KEYS);
    assert.deepEqual(
      { ...p, updated_at: typeof p.updated_at },
      {
        ref: a.ref, display_name: 'Ann Example', hidden: true, spot_hidden: false, open_to_meet: true, sample: false,
        visible_until: new Date(a.visible_until_ms).toISOString(), updated_at: 'string', presence: 'on',
        counts: {
          shared_talks: 2,
          meets: { requested: 1, accepted: 1, declined: 1, ended: 5, other: 1 },
          blocks_made: 1,
          blocks_received: 1,
          push: { web: 2 },
          reports: { total: 4, reasons: { harassment: 1, operator: 1, other: 1, spam: 1 } },
        },
      },
    );
  });

  test('text and contact add their fields, each cut to 300 characters; the spot line only while around', async () => {
    const { ctx, o, a, b } = await setup();
    const both = (await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${a.ref}&fields=text,contact`)).json.person;
    assert.deepEqual(Object.keys(both).sort(), [...BASE_KEYS, ...TEXT_KEYS, 'linkedin_url'].sort());
    assert.equal(both.about, 'About Ann.');
    assert.equal(both.interests, 'x'.repeat(300));
    assert.equal(both.expertise, 'y'.repeat(299), 'a surrogate pair is never cut in half');
    assert.deepEqual([both.contact_note, both.spot, both.pending, both.linkedin_url], ['Find me at the booth', 'by the coffee', {}, 'https://www.linkedin.com/in/ann-example']);
    // A held spot line goes under pending; no presence gives presence off and no spot line.
    o.store.setPresence(a.profile_id, { spot_pending: true });
    const held = (await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${a.ref}&fields=text`)).json.person;
    assert.deepEqual([held.spot, held.pending], [null, { spot: 'by the coffee' }]);
    const bob = (await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${b.ref}&fields=text`)).json.person;
    assert.deepEqual([bob.presence, bob.spot, bob.pending, bob.contact_note], ['off', null, {}, null]);
  });

  test('no fields mode ever returns a forbidden key, an internal id or a position', async () => {
    const { ctx, a, b, c, d } = await setup();
    for (const fields of [null, '', 'text', 'contact', 'text,contact', 'contact,text,text']) {
      const r = await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${a.ref}${fields === null ? '' : `&fields=${fields}`}`);
      ok(r);
      const keys = keysOf(r.json);
      for (const k of keys) assert.ok(!FORBIDDEN_KEYS.has(k), `fields=${fields}: ${k}`);
      const text = JSON.stringify(r.json);
      for (const p of [a, b, c, d]) assert.ok(!text.includes(p.profile_id) && !text.includes(p.secret_hash), `fields=${fields}: an internal id`);
      for (const s of SENTINELS) assert.ok(!text.includes(s), `fields=${fields}: ${s}`);
    }
  });

  test('an unknown ref is 404; a bad ref, a bad fields list or an unknown key is 400', async () => {
    const { ctx, a } = await setup();
    const missing = await send(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${NO_REF}`);
    assert.deepEqual([missing.status, missing.json], [404, { error: 'not_found' }]);
    for (const q of ['', 'ref=xyz', `ref=${a.ref}&fields=text,secret`, `ref=${a.ref}&fields=profile_id`, `ref=${a.ref}&q64=${q64('a')}`, `ref=${a.ref}&ref=${a.ref}`]) {
      assert.equal((await send(ctx, 'GET', `/admin/people/view?event=${SLUG}${q ? `&${q}` : ''}`)).status, 400, q);
    }
  });

  test('applied twice: the same answer and no change', async () => {
    const { ctx, a } = await setup();
    await twice(ctx, 'GET', `/admin/people/view?event=${SLUG}&ref=${a.ref}&fields=text,contact`);
  });
});

describe('the operator block (W7.3) and the hide rule', { skip }, () => {
  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    return { ctx, o: ctx.obj() };
  }
  const block = (ctx, ref, action = 'block') => send(ctx, 'POST', `/admin/people/block?event=${SLUG}`, { ref, action });
  const hiddenOf = (o, id) => o.store.person(id)?.hidden;
  const storedHidden = (ctx, id) => rows(ctx.db(`conference:${SLUG}`), 'SELECT hidden FROM people WHERE profile_id = ?', id)[0]?.hidden;

  test('block files the operator report once and hides the profile; applied twice it leaves the same state', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    const [first] = await twice(ctx, 'POST', `/admin/people/block?event=${SLUG}`, { ref: p.ref, action: 'block' });
    assert.deepEqual(first, { ok: true, hidden: true });
    assert.deepEqual(rows(ctx.db(`conference:${SLUG}`), 'SELECT id, target_kind, target_id, target_profile_id, reporter_id, reason FROM reports'), [
      { id: `profile:${p.ref}:operator`, target_kind: 'profile', target_id: p.ref, target_profile_id: p.profile_id, reporter_id: 'operator', reason: 'operator' },
    ]);
    assert.deepEqual([hiddenOf(o, p.profile_id), storedHidden(ctx, p.profile_id)], [true, 1]);
  });

  test('a blocked profile stays hidden after insertPerson of the same profile_id, a profile write and a re-creation from the same device', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    ok(await block(ctx, p.ref));
    // insertPerson with a document that says not hidden (a migration re-run, a fixture).
    await o.store.insertPerson({ profile_id: p.profile_id, secret_hash: p.secret_hash, display_name: 'Pat again', hidden: false, visible_until_ms: Date.now() + HOUR });
    assert.deepEqual([hiddenOf(o, p.profile_id), storedHidden(ctx, p.profile_id)], [true, 1]);

    // The owner's own writes, through the people API of the object.
    const id = newId();
    const secret = randomBytes(32).toString('base64url');
    const api = (method, body) => o.fetch(new Request(`https://do.internal/api/people/profile${method === 'DELETE' ? `?event=${SLUG}` : ''}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-ip': '192.0.2.7', 'x-caddie-device': `${id}.${secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const put = async () => {
      const r = await api('PUT', { event: SLUG, profile: { display_name: 'Owner' }, open_to_meet: true, shared_talk_ids: [] });
      assert.equal(r.status, 200);
      return (await r.json()).hidden_for_owner;
    };
    assert.equal(await put(), false);
    const ref = o.store.person(id).ref;
    ok(await block(ctx, ref));
    assert.equal(await put(), true, 'a profile write keeps the hide');
    assert.equal((await api('DELETE')).status, 200);
    assert.equal(o.store.person(id), null);
    assert.equal(await put(), true, 'a re-creation from the same device is hidden again');
    // Unblocking lifts it: the next re-creation is visible.
    assert.deepEqual((await block(ctx, ref, 'unblock')).json, { ok: true, hidden: false, found: true, removed: true });
    assert.equal((await api('DELETE')).status, 200);
    assert.equal(await put(), false);
  });

  test('one operator report hides on its own, also through the public report count', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    ok(await block(ctx, p.ref));
    assert.deepEqual([o.store.reportHides('profile', p.ref), o.store.reportFlags(p.ref)], [true, { hidden: true, spot_hidden: false }]);
    // A single report from a device does not hide; the operator's does.
    const q = await person(o, { name: 'Quinn' });
    o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)",
      `profile:${q.ref}:${p.profile_id}`, q.ref, q.profile_id, p.profile_id, Date.now());
    assert.equal(o.store.reportHides('profile', q.ref), false);
  });

  test('unblock removes only the operator report; the profile stays hidden while two other people reported it; a retry is 404 no_operator_block and changes nothing', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    const others = [await person(o, { name: 'R1' }), await person(o, { name: 'R2' })];
    ok(await block(ctx, p.ref));
    const fileReport = (r) => o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)",
      `profile:${p.ref}:${r.profile_id}`, p.ref, p.profile_id, r.profile_id, Date.now());
    fileReport(others[0]);
    const one = await block(ctx, p.ref, 'unblock');
    assert.deepEqual(pair(one), [200, { ok: true, hidden: false, found: true, removed: true }], 'one other reporter is not enough');
    const after = state(ctx);
    assert.deepEqual(pair(await block(ctx, p.ref, 'unblock')), [404, { error: 'no_operator_block' }], 'the retry of a lost answer');
    assert.deepEqual(state(ctx), after);
    assert.deepEqual(rows(ctx.db(`conference:${SLUG}`), 'SELECT reporter_id FROM reports').map((r) => r.reporter_id), [others[0].profile_id]);
    ok(await block(ctx, p.ref));
    fileReport(others[1]);
    assert.deepEqual((await block(ctx, p.ref, 'unblock')).json, { ok: true, hidden: true, found: true, removed: true }, 'two other reporters keep it hidden');
    assert.equal(storedHidden(ctx, p.profile_id), 1);
  });

  test('unblock of a profile with no operator report is 404 no_operator_block and changes nothing, also a hide from elsewhere', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat', hidden: true });
    const r1 = await person(o, { name: 'R1' });
    o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)",
      `profile:${p.ref}:${r1.profile_id}`, p.ref, p.profile_id, r1.profile_id, Date.now());
    const before = state(ctx);
    assert.deepEqual(pair(await block(ctx, p.ref, 'unblock')), [404, { error: 'no_operator_block' }]);
    assert.deepEqual(state(ctx), before);
    assert.equal(storedHidden(ctx, p.profile_id), 1);
  });

  test('unblock of a deleted profile removes only its stale operator report: hidden null, found false; a retry is 404 not_found', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    const r1 = await person(o, { name: 'R1' });
    ok(await block(ctx, p.ref));
    o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)",
      `profile:${p.ref}:${r1.profile_id}`, p.ref, p.profile_id, r1.profile_id, Date.now());
    assert.equal(o.store.deletePersonEverywhere(p.profile_id), true);
    assert.deepEqual(pair(await block(ctx, p.ref, 'unblock')), [200, { ok: true, hidden: null, found: false, removed: true }]);
    // The user's own report stays (unhide would have deleted it too).
    assert.deepEqual(rows(ctx.db(`conference:${SLUG}`), 'SELECT reporter_id FROM reports').map((r) => r.reporter_id), [r1.profile_id]);
    assert.deepEqual(pair(await block(ctx, p.ref, 'unblock')), [404, { error: 'not_found' }]);
    // A re-creation from the same device is no longer hidden by the operator (one user report is not enough).
    await o.store.insertPerson({ profile_id: p.profile_id, secret_hash: p.secret_hash, display_name: 'Pat', visible_until_ms: Date.now() + HOUR });
    assert.equal(o.store.person(p.profile_id).hidden, false);
    // block of a ref without a person is 404 and files nothing.
    assert.deepEqual(pair(await block(ctx, NO_REF)), [404, { error: 'not_found' }]);
  });

  test('an unknown ref is 404 for both actions; a bad body is 400', async () => {
    const { ctx, o } = await setup();
    for (const action of ['block', 'unblock']) assert.deepEqual(pair(await block(ctx, NO_REF, action)), [404, { error: 'not_found' }]);
    const p = await person(o, { name: 'Pat' });
    for (const body of [{ ref: p.ref }, { ref: p.ref, action: 'hide' }, { ref: 'x', action: 'block' }, { ref: p.ref, action: 'block', reason: 'spam' }]) {
      assert.equal((await send(ctx, 'POST', `/admin/people/block?event=${SLUG}`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(rows(ctx.db(`conference:${SLUG}`), 'SELECT COUNT(*) AS n FROM reports')[0].n, 0);
  });
});

describe('moderation hide (W7.6) and unhide (W6)', { skip }, () => {
  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    return { ctx, o: ctx.obj() };
  }
  const mod = (ctx, body) => send(ctx, 'POST', `/admin/moderation?event=${SLUG}`, body);
  const reportsOf = (ctx) => rows(ctx.db(`conference:${SLUG}`), 'SELECT id FROM reports ORDER BY id').map((r) => r.id);
  const stale = (o, kind, target, n) => {
    for (let i = 0; i < n; i++) {
      o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, ?, ?, NULL, ?, 'spam', ?)",
        `${kind}:${target}:r${i}${'x'.repeat(20)}`, kind, target, `r${i}${'x'.repeat(20)}`, Date.now());
    }
  };

  test('hide of a profile files the operator report and hides it; applied twice it leaves the same state', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    const [first] = await twice(ctx, 'POST', `/admin/moderation?event=${SLUG}`, { action: 'hide', kind: 'profile', id: p.ref });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(reportsOf(ctx), [`profile:${p.ref}:operator`]);
    assert.equal(o.store.person(p.profile_id).hidden, true);
  });

  test('hide of a spot line clears it, sets spot_hidden, and survives a re-creation', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    o.store.setPresence(p.profile_id, { zone: 'Hallway', spot: 'by the door', until_ms: Date.now() + HOUR });
    const [first] = await twice(ctx, 'POST', `/admin/moderation?event=${SLUG}`, { action: 'hide', kind: 'spot', id: p.ref });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(reportsOf(ctx), [`spot:${p.ref}:operator`]);
    assert.deepEqual([o.store.person(p.profile_id).spot_hidden, o.store.person(p.profile_id).presence.spot, o.store.person(p.profile_id).hidden], [true, null, false]);
    await o.store.insertPerson({ profile_id: p.profile_id, secret_hash: p.secret_hash, display_name: 'Pat', visible_until_ms: Date.now() + HOUR });
    assert.deepEqual([o.store.person(p.profile_id).spot_hidden, o.store.person(p.profile_id).hidden], [true, false]);
  });

  test('hide: an unknown ref is 404, kind meet is 400, a bad id is 400', async () => {
    const { ctx } = await setup();
    assert.deepEqual(pair(await mod(ctx, { action: 'hide', kind: 'profile', id: NO_REF })), [404, { error: 'not_found' }]);
    assert.equal((await mod(ctx, { action: 'hide', kind: 'meet', id: 'A'.repeat(22) })).status, 400);
    assert.equal((await mod(ctx, { action: 'hide', kind: 'spot', id: 'nope' })).status, 400);
    assert.deepEqual(reportsOf(ctx), []);
  });

  test('unhide of an unknown ref with no reports deletes nothing and is 404', async () => {
    const { ctx, o } = await setup();
    stale(o, 'profile', 'aaaaaaaaaaaaaaaa', 2);
    const before = reportsOf(ctx);
    assert.deepEqual(pair(await mod(ctx, { action: 'unhide', kind: 'profile', id: NO_REF })), [404, { error: 'not_found' }]);
    assert.deepEqual(pair(await mod(ctx, { action: 'unhide', kind: 'spot', id: 'aaaaaaaaaaaaaaaa' })), [404, { error: 'not_found' }], 'another kind of the same ref');
    assert.deepEqual(pair(await mod(ctx, { action: 'unhide', kind: 'meet', id: 'M'.repeat(22) })), [404, { error: 'not_found' }]);
    assert.deepEqual(reportsOf(ctx), before);
  });

  test('unhide of a gone target with two stale reports deletes them: found false, removed 2', async () => {
    const { ctx, o } = await setup();
    stale(o, 'profile', 'bbbbbbbbbbbbbbbb', 2);
    stale(o, 'profile', 'cccccccccccccccc', 1);
    assert.deepEqual(pair(await mod(ctx, { action: 'unhide', kind: 'profile', id: 'bbbbbbbbbbbbbbbb' })), [200, { ok: true, found: false, removed: 2 }]);
    assert.equal(reportsOf(ctx).length, 1, 'only that target\'s reports went');
    // Nothing is left, so a retry is the 404 of an unknown target (an exception to idempotency
    // the README names).
    assert.equal((await mod(ctx, { action: 'unhide', kind: 'profile', id: 'bbbbbbbbbbbbbbbb' })).status, 404);
  });

  test('unhide of a found target answers found true, lifts an operator hide, and applied twice leaves the same state', async () => {
    const { ctx, o } = await setup();
    const p = await person(o, { name: 'Pat' });
    ok(await mod(ctx, { action: 'hide', kind: 'profile', id: p.ref }));
    const [first, second] = await twice(ctx, 'POST', `/admin/moderation?event=${SLUG}`, { action: 'unhide', kind: 'profile', id: p.ref }, { sameAnswer: false });
    assert.deepEqual([first, second], [{ ok: true, found: true, removed: 1 }, { ok: true, found: true, removed: 0 }]);
    assert.equal(o.store.person(p.profile_id).hidden, false);
    await o.store.insertPerson({ profile_id: p.profile_id, secret_hash: p.secret_hash, display_name: 'Pat', visible_until_ms: Date.now() + HOUR });
    assert.equal(o.store.person(p.profile_id).hidden, false, 'the operator report is gone with the unhide');
  });
});

describe('conference removal (W7.4), the tombstone and unretire (W7.7)', { skip }, () => {
  // Puts at least one row in every table of the object: talks (with their FTS rows and vectors),
  // topics and facets through the admin routes, people, shared talks, presence, blocks, meets,
  // reports, push subscriptions, nudges, nudge sends and the Bluetooth caps through the store or
  // SQL, the meter's usage_days through any request, and meta.
  async function populate(ctx, slug = SLUG) {
    const talk = (n) => ({ talk_id: `${slug}:${n}`, conference: slug, title: `Talk ${n} on eBPF`, abstract: `Abstract ${n}`, speakers: ['Ada'], start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z', room: 'Hall A' });
    ok(await send(ctx, 'POST', `/admin/talks?event=${slug}`, { generation: 1, talks: [talk(1), talk(2)] }));
    ok(await send(ctx, 'POST', `/admin/talks/finalize?event=${slug}`, { generation: 1 }));
    ok(await send(ctx, 'PUT', `/admin/topics?event=${slug}`, { topics: [{ topic_id: 'ebpf', label: 'eBPF', talk_count: 2, rank: 1 }] }));
    ok(await send(ctx, 'PUT', `/admin/facets?event=${slug}`, { facets: [{ id: 'room:hall-a', kind: 'room', label: 'Hall A', talks: 2 }] }));
    const o = ctx.obj(slug);
    const now = Date.now();
    const a = await person(o, { name: 'Ann', about: 'kernel things', shared_talk_ids: [`${slug}:1`] });
    const b = await person(o, { name: 'Bob' });
    o.store.setPresence(a.profile_id, { zone: 'Hall A', until_ms: now + HOUR });
    o.store.addBlock(a.profile_id, b.profile_id, b.ref, now + HOUR);
    o.exec("INSERT INTO meets (meet_id, requester_id, recipient_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, 'requested', ?, ?)", newId(), a.profile_id, b.profile_id, now, now + HOUR);
    o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)", `profile:${b.ref}:${a.profile_id}`, b.ref, b.profile_id, a.profile_id, now);
    o.exec('INSERT INTO push_subs (id, profile_id, endpoint, p256dh, auth, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), a.profile_id, 'https://push.example/x', 'k', 'a', now, now + HOUR);
    o.exec('INSERT INTO nudges (id, day, a_id, b_id, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)', newId(), '2099-06-01', a.profile_id, b.profile_id, now, now + HOUR);
    o.exec('INSERT INTO nudge_sends (receiver_id, sent_at_ms, expires_at_ms) VALUES (?, ?, ?)', a.profile_id, now, now + HOUR);
    o.store.addBleCaps(a.profile_id, [{ id: b.ref, at: now, w: 1 }], now);
    ok(await send(ctx, 'GET', `/admin/stats?event=${slug}`)); // the meter writes usage_days
    return { o, a, b };
  }

  const counts = (db) => Object.fromEntries(tablesOf(db).map((t) => [t, rows(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]));
  const retiredOf = (ctx) => rows(ctx.db('directory:global'), 'SELECT slug, at_ms FROM retired ORDER BY slug');
  const directoryRows = (ctx) => rows(ctx.db('directory:global'), 'SELECT slug FROM conferences ORDER BY slug').map((r) => r.slug);

  test('the removal empties every table but admin_nonces, keeps the nonce in both objects, marks the object retired, removes the directory row and leaves a tombstone', async () => {
    const ctx = realEnv();
    await withConferences(ctx, [SLUG, OTHER]);
    await populate(ctx);
    await populate(ctx, OTHER);
    const db = ctx.db(`conference:${SLUG}`);
    const before = counts(db);
    for (const [t, n] of Object.entries(before)) assert.ok(n > 0, `the setup put no row in ${t}`);
    const otherBefore = counts(ctx.db(`conference:${OTHER}`));
    const del = signed('DELETE', `/admin/conference?event=${SLUG}`);
    const r = await call(ctx.env, del.build());
    ok(r);
    const expected = Object.fromEntries(Object.entries(before).filter(([t]) => t !== 'admin_nonces').map(([t, n]) => [t, t === 'meta' ? n - 1 : n]));
    assert.deepEqual(r.json, { ok: true, deleted: expected, directory: 1, retired: true, already_retired_at: null });
    const after = counts(db);
    for (const [t, n] of Object.entries(after)) {
      if (t === 'admin_nonces') continue;
      assert.equal(n, t === 'meta' ? 2 : 0, `${t} after the wipe`);
    }
    assert.deepEqual(rows(db, 'SELECT k FROM meta ORDER BY k').map((x) => x.k), ['retired_at', 'schema_version'], 'meta keeps the schema version and gets the marker');
    assert.ok(Math.abs(Number(rows(db, "SELECT v FROM meta WHERE k = 'retired_at'")[0].v) - Date.now()) < 60_000);
    assert.ok(rows(db, 'SELECT nonce, ts_ms FROM admin_nonces').some((x) => x.nonce === del.nonce && x.ts_ms === del.ts * 1000), 'the wipe recorded its nonce');
    assert.ok(rows(ctx.db('directory:global'), 'SELECT nonce FROM admin_nonces').some((x) => x.nonce === del.nonce), 'the tombstone step recorded it too');
    assert.deepEqual(directoryRows(ctx), [OTHER]);
    assert.deepEqual(retiredOf(ctx).map((x) => x.slug), [SLUG]);
    assert.deepEqual(counts(ctx.db(`conference:${OTHER}`)).talks, otherBefore.talks, 'the other conference is untouched');
    assert.equal(counts(ctx.db(`conference:${OTHER}`)).people, otherBefore.people);
    // The object has no document: a public request is 400, as is an admin request for the slug.
    const o = ctx.obj();
    assert.equal(o.conf, null);
    const pub = await o.fetch(new Request(`https://do.internal/api/topics?event=${SLUG}`, { headers: { 'x-caddie-slug': SLUG } }));
    assert.deepEqual([pub.status, await pub.json()], [400, { error: 'conference is not available' }]);
    assert.deepEqual(pair(await send(ctx, 'GET', `/admin/stats?event=${SLUG}`)), [400, { error: 'conference is not available' }]);
  });

  test('the wipe applied twice: 200 with zero counts, the same state, the tombstone refreshed', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    await populate(ctx);
    const T = Date.now();
    await withFixedClock(T, async (setNow) => {
      const [first, second] = await twice(ctx, 'DELETE', `/admin/conference?event=${SLUG}`, undefined, { sameAnswer: false });
      assert.ok(Object.values(first.deleted).some((n) => n > 0));
      assert.ok(Object.values(second.deleted).every((n) => n === 0), JSON.stringify(second.deleted));
      assert.deepEqual(Object.keys(second.deleted), Object.keys(first.deleted));
      assert.deepEqual([second.ok, second.directory, second.retired], [true, 0, true]);
      assert.deepEqual([first.already_retired_at, second.already_retired_at], [null, new Date(T).toISOString()], 'a retry says the removal had already happened');
      setNow(T + 60_000);
      const third = await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`);
      assert.equal(third.json.already_retired_at, new Date(T).toISOString());
      assert.deepEqual(retiredOf(ctx), [{ slug: SLUG, at_ms: T + 60_000 }]);
    });
  });

  test('a replayed wipe is 401 admin_replay and deletes nothing, also after the conference came back', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    const del = signed('DELETE', `/admin/conference?event=${SLUG}`);
    ok(await call(ctx.env, del.build()));
    // The conference comes back, with a person in it.
    const back = await send(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(SLUG), unretire: true }] });
    assert.deepEqual(back.json, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [] });
    const p = await person(ctx.obj(), { name: 'Pat' });
    const replay = await call(ctx.env, del.build());
    assert.deepEqual([replay.status, replay.json], [401, { error: 'admin_replay' }]);
    assert.equal(ctx.obj().store.person(p.profile_id)?.display_name, 'Pat');
    assert.deepEqual([directoryRows(ctx), retiredOf(ctx)], [[SLUG], []]);
  });

  test('an unknown conference still has its object wiped and gets a tombstone; bad requests are refused', async () => {
    const ctx = realEnv();
    const r = await send(ctx, 'DELETE', '/admin/conference?event=never-added-2099');
    ok(r);
    assert.equal(r.json.directory, 0);
    assert.equal(r.json.retired, true);
    assert.ok(Object.values(r.json.deleted).every((n) => n === 0));
    assert.deepEqual(retiredOf(ctx).map((x) => x.slug), ['never-added-2099']);
    assert.deepEqual(pair(await send(ctx, 'GET', `/admin/conference?event=${SLUG}`)), [405, { error: 'Method not allowed' }]);
    assert.deepEqual(pair(await send(ctx, 'DELETE', '/admin/conference')), [400, { error: 'event must be a conference slug' }]);
    assert.equal((await send(ctx, 'DELETE', '/admin/conference?event=Bad_Slug')).status, 400);
    // Unsigned, it is the 404 of every admin path and reaches no object.
    const calls = ctx.CONFERENCE.calls.length + ctx.DIRECTORY.calls.length;
    const unsigned = await call(ctx.env, new Request(`${BASE}/admin/conference?event=${SLUG}`, { method: 'DELETE', headers: { 'CF-Connecting-IP': '203.0.113.50' } }));
    assert.deepEqual([unsigned.status, unsigned.json], [404, { error: 'Not found' }]);
    assert.equal(ctx.CONFERENCE.calls.length + ctx.DIRECTORY.calls.length, calls);
  });

  test('/internal/wipe without the forwarded nonce is 404 and deletes nothing; with a used nonce it is 401', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    const { a } = await populate(ctx);
    const o = ctx.obj();
    const wipe = (headers) => o.fetch(new Request('https://do.internal/internal/wipe', { method: 'POST', headers: { 'x-caddie-slug': SLUG, ...headers } }));
    const ts = String(Math.floor(Date.now() / 1000));
    for (const headers of [{}, { 'x-caddie-admin-nonce': 'n'.repeat(22) }, { 'x-caddie-admin-ts': ts }, { 'x-caddie-admin-nonce': 'n'.repeat(21), 'x-caddie-admin-ts': ts }]) {
      const r = await wipe(headers);
      assert.deepEqual([r.status, await r.json()], [404, { error: 'Not found' }], JSON.stringify(headers));
    }
    const old = await wipe({ 'x-caddie-admin-nonce': 'o'.repeat(22), 'x-caddie-admin-ts': String(Number(ts) - 400) });
    assert.deepEqual([old.status, await old.json()], [401, { error: 'admin_skew' }]);
    // A nonce the object already served for another admin request.
    const used = signed('GET', `/admin/stats?event=${SLUG}`);
    ok(await call(ctx.env, used.build()));
    const replay = await wipe({ 'x-caddie-admin-nonce': used.nonce, 'x-caddie-admin-ts': String(used.ts) });
    assert.deepEqual([replay.status, await replay.json()], [401, { error: 'admin_replay' }]);
    assert.equal(o.store.person(a.profile_id)?.display_name, 'Ann');
    assert.ok(counts(ctx.db(`conference:${SLUG}`)).talks > 0);
    // GET is not the wipe.
    const get = await o.fetch(new Request('https://do.internal/internal/wipe', { headers: { 'x-caddie-admin-nonce': 'g'.repeat(22), 'x-caddie-admin-ts': ts } }));
    assert.equal(get.status, 404);
  });

  test('a request in flight when the wipe runs writes nothing afterwards, through ctx.sql or the store, and reads no cached person', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    const { a } = await populate(ctx);
    const route = adminRoutes.find((r) => r.method === 'GET' && r.path === '/admin/topics');
    const original = route.handler;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    const attempts = [];
    route.handler = async (c) => {
      assert.equal(c.store.personByRef(a.ref)?.display_name, 'Ann'); // warms the cache
      started();
      await gate;
      for (const fn of [
        () => c.sql.exec("INSERT INTO reports (id, target_kind, target_id, reporter_id, reason, created_at_ms) VALUES ('x', 'profile', 'y', 'z', 'spam', 1)"),
        () => c.store.personByRef(a.ref),
        () => c.store.addBlock(a.profile_id, 'B'.repeat(22), 'ffffffffffffffff', Date.now() + HOUR),
      ]) {
        try {
          fn();
          attempts.push('wrote');
        } catch (err) {
          attempts.push(`${err.status} ${err.body?.error}`);
        }
      }
      await assert.rejects(c.store.insertPerson({ profile_id: a.profile_id, secret_hash: a.secret_hash, display_name: 'Ann', visible_until_ms: Date.now() + HOUR }), (err) => err.status === 400);
      return original(c);
    };
    const error = console.error;
    console.error = () => {};
    try {
      const pending = send(ctx, 'GET', `/admin/topics?event=${SLUG}`);
      await running;
      ok(await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`));
      release();
      const r = await pending;
      assert.deepEqual([r.status, r.json], [400, { error: 'conference is not available' }]);
    } finally {
      route.handler = original;
      console.error = error;
    }
    assert.deepEqual(attempts, Array(3).fill('400 conference is not available'));
    const db = ctx.db(`conference:${SLUG}`);
    for (const t of ['reports', 'people', 'blocks']) assert.equal(counts(db)[t], 0, t);
  });

  test('PUT /admin/conferences skips a retired slug and reports it; "unretire": true brings it back without storing the key', async () => {
    const ctx = realEnv();
    await withConferences(ctx, [SLUG, OTHER]);
    ok(await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`));
    const fanOut = () => ctx.CONFERENCE.calls.filter((c) => c.name === SLUG && new URL(c.req.url).pathname === '/internal/conference').length;
    const sentBefore = fanOut();
    const skipped = await send(ctx, 'PUT', '/admin/conferences', { conferences: [conf(SLUG), conf(OTHER)] });
    assert.deepEqual([skipped.status, skipped.json], [200, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [SLUG] }]);
    assert.deepEqual(directoryRows(ctx), [OTHER]);
    assert.equal(fanOut(), sentBefore, 'the removed object is not given its document back');
    assert.equal(ctx.obj().conf, null);
    // A flag that is not a boolean refuses the whole request before anything is written.
    const bad = await send(ctx, 'PUT', '/admin/conferences', { conferences: [conf(OTHER, { name: 'renamed' }), { ...conf(SLUG), unretire: 'yes' }] });
    assert.deepEqual([bad.status, bad.json], [400, { error: 'unretire must be a boolean' }]);
    assert.equal(JSON.parse(rows(ctx.db('directory:global'), 'SELECT doc FROM conferences WHERE slug = ?', OTHER)[0].doc).name, OTHER);
    // false is the same as no flag.
    assert.deepEqual((await send(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(SLUG), unretire: false }] })).json.skipped_retired, [SLUG]);
    // unretire, applied twice: the second is an ordinary upsert of an unchanged document.
    const [first] = await twice(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(SLUG), unretire: true }] }, { slugs: [SLUG, OTHER] });
    assert.deepEqual(first, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [] });
    assert.deepEqual([directoryRows(ctx), retiredOf(ctx)], [[SLUG, OTHER], []]);
    const stored = JSON.parse(rows(ctx.db('directory:global'), 'SELECT doc FROM conferences WHERE slug = ?', SLUG)[0].doc);
    assert.ok(!('unretire' in stored) && !('unretire' in ctx.obj().conf.doc), 'the flag is never stored');
    assert.equal(ctx.obj().conf.status, 'searchable');
    // On a slug that is not retired the flag is stripped and the document upserted as usual.
    ok(await send(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(OTHER, { name: 'renamed' }), unretire: true }] }));
    const other = JSON.parse(rows(ctx.db('directory:global'), 'SELECT doc FROM conferences WHERE slug = ?', OTHER)[0].doc);
    assert.deepEqual([other.name, 'unretire' in other], ['renamed', false]);
  });
});

describe('removal order, failures and the retired marker (review round 1)', { skip }, () => {
  const peopleIn = (ctx) => rows(ctx.db(`conference:${SLUG}`), 'SELECT COUNT(*) AS n FROM people')[0].n;
  const retiredOf = (ctx) => rows(ctx.db('directory:global'), 'SELECT slug FROM retired').map((x) => x.slug);
  const directoryRows = (ctx) => rows(ctx.db('directory:global'), 'SELECT slug FROM conferences ORDER BY slug').map((r) => r.slug);
  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    await person(ctx.obj(), { name: 'Ann' });
    return ctx;
  }

  test('the tombstone step fails: its answer as it is, nothing changed; the retry removes', async () => {
    const ctx = await setup();
    const env = { ...ctx.env, DIRECTORY: failOnce(ctx.DIRECTORY, (p) => p === '/admin/conference/retire', dailyLimit) };
    const r = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    assert.deepEqual(pair(r), [503, { error: 'daily_limit' }]);
    assert.deepEqual([retiredOf(ctx), peopleIn(ctx), ctx.obj().conf?.status, directoryRows(ctx)], [[], 1, 'searchable', [SLUG]]);
    const retry = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    assert.deepEqual([retry.status, retry.json.directory, retry.json.deleted.people, retry.json.already_retired_at], [200, 1, 1, null]);
  });

  test('the wipe fails after the tombstone: removal_incomplete, the next ingest skips the slug, and the retry finishes', async () => {
    const ctx = await setup();
    const env = { ...ctx.env, CONFERENCE: failOnce(ctx.CONFERENCE, (p) => p === '/internal/wipe') };
    const r = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    assert.deepEqual(pair(r), [502, { error: 'removal_incomplete', step: 'wipe', retired: true, wiped: false, cause: 'Service is temporarily unavailable' }]);
    assert.deepEqual([retiredOf(ctx), peopleIn(ctx), directoryRows(ctx)], [[SLUG], 1, [SLUG]]);
    const weekly = await send(ctx, 'PUT', '/admin/conferences', { conferences: [conf(SLUG)] });
    assert.deepEqual(weekly.json, { upserted: 0, searchable: 0, synced: 0, skipped_retired: [SLUG] });
    const retry = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    ok(retry);
    assert.deepEqual([retry.json.deleted.people, retry.json.directory, typeof retry.json.already_retired_at], [1, 1, 'string']);
    assert.deepEqual([peopleIn(ctx), directoryRows(ctx), retiredOf(ctx)], [0, [], [SLUG]]);
  });

  test('the directory row delete fails after the wipe: removal_incomplete with the counts and Retry-After; admin writes are refused meanwhile; the retry finishes', async () => {
    const ctx = await setup();
    const env = { ...ctx.env, DIRECTORY: failOnce(ctx.DIRECTORY, (p, m) => p === `/internal/conference/${SLUG}` && m === 'DELETE', dailyLimit) };
    const r = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '60');
    assert.deepEqual({ ...r.json, deleted: r.json.deleted.people }, { error: 'removal_incomplete', step: 'directory', retired: true, wiped: true, deleted: 1, cause: 'daily_limit' });
    assert.deepEqual([retiredOf(ctx), peopleIn(ctx), directoryRows(ctx)], [[SLUG], 0, [SLUG]]);
    // The directory still lists the slug, so admin requests reach the wiped object: a write is
    // refused there (a migration landing now would otherwise leave people no cron ever purges).
    const late = await send(ctx, 'POST', `/admin/people?event=${SLUG}`, { people: [{ profile_id: newId(), secret_hash: sha('x'), display_name: 'Late', visible_until: new Date(Date.now() + HOUR).toISOString() }] });
    assert.deepEqual(pair(late), [400, { error: 'conference is not available' }]);
    for (const [path, body] of [[`/admin/people/block?event=${SLUG}`, { ref: NO_REF, action: 'block' }], [`/admin/talks?event=${SLUG}`, { generation: 1, talks: [] }], [`/admin/embed-pending?event=${SLUG}`, {}]]) {
      assert.deepEqual(pair(await send(ctx, 'POST', path, body)), [400, { error: 'conference is not available' }], path);
    }
    assert.equal(peopleIn(ctx), 0);
    ok(await send(ctx, 'GET', `/admin/stats?event=${SLUG}`)); // reads still answer
    const retry = await call(env, signed('DELETE', `/admin/conference?event=${SLUG}`).build());
    ok(retry);
    // Only the meter's row, which the stats read above wrote again, is left to delete.
    assert.deepEqual(Object.entries(retry.json.deleted).filter(([, n]) => n > 0), [['usage_days', 1]]);
    assert.deepEqual([retry.json.directory, typeof retry.json.already_retired_at, directoryRows(ctx)], [1, 'string', []]);
  });

  test('a fan-out that left the Worker before the removal cannot make the wiped object searchable again; unretire can', async () => {
    const ctx = await setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const held = {
      ...ctx.CONFERENCE,
      get: (id) => {
        const stub = ctx.CONFERENCE.get(id);
        return {
          fetch: async (url, init) => {
            if (new URL(url).pathname === '/internal/conference') {
              started();
              await gate;
            }
            return stub.fetch(url, init);
          },
        };
      },
    };
    const pendingPut = call({ ...ctx.env, CONFERENCE: held }, signed('PUT', '/admin/conferences', { body: { conferences: [conf(SLUG, { name: 'renamed' })] } }).build());
    await waiting;
    ok(await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`));
    release();
    const put = await pendingPut;
    assert.deepEqual(pair(put), [200, { upserted: 1, searchable: 1, synced: 0, skipped_retired: [] }]);
    const o = ctx.obj();
    assert.deepEqual([o.conf, typeof o.retiredAt], [null, 'number']);
    const late = await o.fetch(new Request('https://do.internal/internal/conference', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc: conf(SLUG), route_prefix: 'abcdef' }),
    }));
    assert.deepEqual([late.status, await late.json()], [409, { error: 'conference_retired' }]);
    assert.equal(o.conf, null);
    // A public request still answers 400 from the object.
    const pub = await o.fetch(new Request(`https://do.internal/api/topics?event=${SLUG}`, { headers: { 'x-caddie-slug': SLUG } }));
    assert.equal(pub.status, 400);
    // Unretire gives the document back and drops the marker.
    const back = await send(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(SLUG), unretire: true }] });
    assert.deepEqual(back.json, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [] });
    assert.deepEqual([o.conf?.status, o.retiredAt, rows(ctx.db(`conference:${SLUG}`), "SELECT COUNT(*) AS n FROM meta WHERE k = 'retired_at'")[0].n], ['searchable', null, 0]);
  });

  test('unretire with an unavailable document still clears the marker, so a later searchable upsert reaches the object', async () => {
    const ctx = await setup();
    ok(await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`));
    const back = await send(ctx, 'PUT', '/admin/conferences', { conferences: [{ ...conf(SLUG, { status: 'unavailable', status_reason: 'operator_removed' }), unretire: true }] });
    assert.deepEqual(back.json, { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
    const o = ctx.obj();
    assert.deepEqual([o.conf?.status, o.retiredAt], ['unavailable', null]);
    assert.equal(rows(ctx.db('directory:global'), 'SELECT has_object FROM conferences WHERE slug = ?', SLUG)[0].has_object, 1);
    const refresh = await send(ctx, 'PUT', '/admin/conferences', { conferences: [conf(SLUG)] });
    assert.deepEqual(refresh.json, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [] });
    assert.equal(o.conf?.status, 'searchable');
  });

  test('a slug sent twice in one batch, plain then with unretire, is unretired once and never reported as skipped', async () => {
    const ctx = await setup();
    ok(await send(ctx, 'DELETE', `/admin/conference?event=${SLUG}`));
    const r = await send(ctx, 'PUT', '/admin/conferences', { conferences: [conf(SLUG), { ...conf(SLUG), unretire: true }] });
    assert.deepEqual([r.json.upserted, r.json.skipped_retired, r.json.synced], [2, [], 2]);
    assert.deepEqual([retiredOf(ctx), directoryRows(ctx), ctx.obj().conf?.status], [[], [SLUG], 'searchable']);
  });

  test('an object without its conference document takes no admin write, reads still answer; the wipe clears the rate-limit buckets', async () => {
    const o = new ConferenceDO(fakeState(), { EMBED_FAKE: '1' });
    assert.deepEqual([(await toObject(o, 'POST', `/admin/people?event=${SLUG}`, { people: [] })).status, (await toObject(o, 'GET', `/admin/stats?event=${SLUG}`)).status], [400, 200]);
    assert.equal((await o.fetch(new Request('https://do.internal/internal/conference', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc: conf(SLUG), route_prefix: 'abcdef' }),
    }))).status, 200);
    assert.equal((await toObject(o, 'POST', `/admin/people?event=${SLUG}`, { people: [] })).status, 200);
    o.buckets.set('people-read:ip:198.51.100.7', { tokens: 1, at: Date.now() });
    const wipe = await o.fetch(new Request('https://do.internal/internal/wipe', {
      method: 'POST', headers: { 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': newId(), 'x-caddie-admin-ts': String(Math.floor(Date.now() / 1000)) },
    }));
    assert.equal(wipe.status, 200);
    assert.equal(o.buckets.size, 0);
    assert.equal((await toObject(o, 'POST', `/admin/people?event=${SLUG}`, { people: [] })).status, 400);
  });

  test('GET /admin/stats without event refuses any query key, so a misspelt event never answers the totals', async () => {
    const ctx = await setup();
    for (const q of ['evnt=x', 'foo=1', 'event2=x']) assert.equal((await send(ctx, 'GET', `/admin/stats?${q}`)).status, 400, q);
    ok(await send(ctx, 'GET', '/admin/stats'));
  });
});

describe('people text drops control characters (review round 1)', { skip }, () => {
  async function setup() {
    const ctx = realEnv();
    await withConferences(ctx);
    const o = ctx.obj();
    const id = newId();
    const secret = randomBytes(32).toString('base64url');
    const put = (profile) => o.fetch(new Request('https://do.internal/api/people/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-ip': '192.0.2.9', 'x-caddie-device': `${id}.${secret}` },
      body: JSON.stringify({ event: SLUG, profile, open_to_meet: true, shared_talk_ids: [] }),
    }));
    return { ctx, o, id, put };
  }

  test('a profile write strips NUL, ESC, an OSC sequence\'s controls, C1 (0x9B) and DEL, turns CR into newlines, and keeps tabs, newlines and bidi marks', async () => {
    const { o, id, put } = await setup();
    const r = await put({
      display_name: 'A\u0000B\u001b[31mC\u001b]0;t\u0007D\u009bE\u007fF',
      about: 'one\r\ntwo\rthree\tfour\nfive',
      interests: 'שלום‏ עולם',
      expertise: '⁧abc⁩ é 😀',
      contact_note: '\u0085note\u0080',
    });
    assert.equal(r.status, 200);
    const p = o.store.person(id);
    assert.deepEqual([p.display_name, p.about, p.interests, p.expertise, p.contact_note], ['AB[31mC]0;tDEF', 'one\ntwo\nthree\tfour\nfive', 'שלום‏ עולם', '⁧abc⁩ é 😀', 'note']);
    // A name of controls only is empty, so it is refused as missing.
    const empty = await put({ display_name: '\u0000\u001b\u009b' });
    assert.deepEqual([empty.status, await empty.json()], [400, { error: 'display_name is required' }]);
  });

  test('the web app\'s ordinary writes are stored as they are', async () => {
    const { o, id, put } = await setup();
    const profile = {
      display_name: 'Zoë O\'Brien-Ångström', about: 'Kubernetes & eBPF — “quotes”, emoji 🚀\nsecond line', interests: 'tabs\tare kept', expertise: 'C++, Go, Rust',
      contact_note: 'Find me at booth 12', linkedin_url: 'https://www.linkedin.com/in/zoe-example',
    };
    assert.equal((await put(profile)).status, 200);
    const p = o.store.person(id);
    for (const [k, v] of Object.entries(profile)) assert.equal(p[k], v, k);
  });

  test('every store write path strips too: insertPerson, savePerson and the spot line', async () => {
    const { o } = await setup();
    const p = await o.store.insertPerson({ profile_id: newId(), secret_hash: sha('s'), display_name: 'X\u001bY', about: 'a\u0000b', contact_note: '\u0007', visible_until_ms: Date.now() + HOUR });
    assert.deepEqual([p.display_name, p.about, p.contact_note], ['XY', 'ab', null]);
    await o.store.savePerson(p.profile_id, { display_name: 'Q\u009bR', contact_note: 'c\u0001d' });
    assert.deepEqual([o.store.person(p.profile_id).display_name, o.store.person(p.profile_id).contact_note], ['QR', 'cd']);
    o.store.setPresence(p.profile_id, { zone: 'Hallway', spot: 'by\u0000 the\r\ndoor', until_ms: Date.now() + HOUR });
    assert.equal(o.store.person(p.profile_id).presence.spot, 'by the\ndoor');
  });

  test('a spot line or meet note is stripped before the word filter, so a control cannot split a listed word', async () => {
    const { line } = await import('../src/connect/common.js');
    assert.deepEqual(line('meet\u0000 me by\r\nthe door\u009b', 'spot', 120), { text: 'meet me by\nthe door', pending: false });
    assert.throws(() => line('fu\u0000ck', 'spot', 120), (err) => err.status === 400 && err.body?.error === 'filtered');
    assert.throws(() => line('fu\u001bck', 'note', 120), (err) => err.status === 400);
  });
});

describe('GET /admin/stats without event (W7.5) on the DirectoryDO', { skip }, () => {
  async function cron(env) {
    const pending = [];
    const log = console.log;
    console.log = () => {};
    try {
      await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
    } finally {
      console.log = log;
    }
  }

  test('the usage per conference and the holds the cron stored; replayed, it is 401 admin_replay', async () => {
    const ctx = realEnv();
    await withConferences(ctx, [SLUG, OTHER]);
    const before = await send(ctx, 'GET', '/admin/stats');
    // Until the cron looked, every object is assumed to hold data.
    assert.deepEqual([before.status, before.json], [200, { day: null, usage: {}, holds: { [SLUG]: true, [OTHER]: true } }]);
    await person(ctx.obj(), { name: 'Pat' });
    await cron(ctx.env);
    const get = signed('GET', '/admin/stats');
    const r = await call(ctx.env, get.build());
    ok(r);
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(Object.keys(r.json).sort(), ['day', 'holds', 'usage']);
    assert.equal(r.json.day, day);
    assert.deepEqual(r.json.holds, { [SLUG]: true }, 'only the object that still holds a person');
    assert.deepEqual(Object.keys(r.json.usage).sort(), [SLUG, OTHER]);
    for (const u of Object.values(r.json.usage)) {
      assert.deepEqual(Object.keys(u).sort(), ['requests', 'rows_read', 'rows_written']);
      for (const v of Object.values(u)) assert.ok(Number.isInteger(v) && v >= 0);
    }
    assert.ok(rows(ctx.db('directory:global'), 'SELECT nonce FROM admin_nonces').some((x) => x.nonce === get.nonce), 'the directory recorded the nonce');
    const replay = await call(ctx.env, get.build());
    assert.deepEqual([replay.status, replay.json], [401, { error: 'admin_replay' }]);
    // A stored total of another day is left out rather than shown under this one.
    ctx.db('directory:global').prepare("UPDATE meta SET v = ? WHERE k = 'usage'").run(JSON.stringify({ day, usage: { [SLUG]: { day: '2000-01-01', requests: 5, rows_read: 1, rows_written: 1 } } }));
    assert.deepEqual((await send(ctx, 'GET', '/admin/stats')).json.usage, {});
  });

  test('with event the route is still the conference\'s own; another method is 405', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    const r = await send(ctx, 'GET', `/admin/stats?event=${SLUG}`);
    assert.ok(r.status === 200 && 'people' in r.json && 'usage' in r.json);
    assert.equal((await send(ctx, 'POST', '/admin/stats', '{}')).status, 405);
  });

  test('applied twice: the same answer and no change', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    await cron(ctx.env);
    await twice(ctx, 'GET', '/admin/stats');
  });
});
