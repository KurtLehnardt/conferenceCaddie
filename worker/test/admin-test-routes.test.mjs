// The /admin/test/* fixtures (the smoke's profile, presence-age and meter-restart helpers) are
// served only when the Worker variable ADMIN_TEST_ROUTES is the string "1" (W5). Otherwise a
// correctly signed request answers 404 { "error": "Not found" }, as an unknown path does, before the
// directory lookup (after the signature, the clock and the body hash, like every other admin route's
// 404 for an unknown path); an unsigned request answers the same 404 it always did. With "1" the routes behave as before. The keys are the shared fixture's fake ones; the objects
// are real, on node:sqlite (helpers/harness.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skip, ConferenceDO, DirectoryDO, worker, fakeState, namespace } from './helpers/harness.mjs';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const BASE = 'https://caddie.example';
const SLUG = 'caddie-fixture-2099';
const PROFILE = 'AAAAAAAAAAAAAAAAAAAAAA';
const SECRET_HASH = 'a'.repeat(64);
const conf = (slug) => ({ slug, name: slug, status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC' });

// The four routes: method, path with query, and a body for the ones that take one.
const ROUTES = [
  { name: 'POST /admin/test/profile', method: 'POST', path: `/admin/test/profile?event=${SLUG}`, body: JSON.stringify({ profile_id: PROFILE, secret_hash: SECRET_HASH, visible_until_ms: Date.now() + 3_600_000 }) },
  { name: 'DELETE /admin/test/profile', method: 'DELETE', path: `/admin/test/profile?event=${SLUG}&profile_id=${PROFILE}` },
  { name: 'POST /admin/test/age-presence', method: 'POST', path: `/admin/test/age-presence?event=${SLUG}`, body: JSON.stringify({ profile_id: PROFILE, until_ms: Date.now() + 60_000 }) },
  { name: 'POST /admin/test/meter-restart', method: 'POST', path: `/admin/test/meter-restart?event=${SLUG}`, body: '{}' },
];

function realEnv(extra = {}) {
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
  return { env: { ADMIN_TOKEN: KEY, EMBED_FAKE: '1', CONFERENCE, DIRECTORY, ...extra }, states, CONFERENCE, DIRECTORY };
}

// A fresh signature (and nonce) for every request.
function signedRequest({ method, path, body }, { sign = true } = {}) {
  const headers = { 'CF-Connecting-IP': '2001:db8::91' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let url = `${BASE}${path}`;
  if (sign) {
    const s = signAdminRequest({ method, path, base: BASE, body, key: KEY });
    headers['X-Caddie-Admin'] = s.header;
    url = s.url;
  }
  return new Request(url, { method, headers, body });
}

async function call(env, req) {
  const log = console.log;
  console.log = () => {};
  try {
    const res = await worker.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    console.log = log;
  }
}

async function withConference(ctx) {
  const put = signAdminRequest({ method: 'PUT', path: '/admin/conferences', base: BASE, body: JSON.stringify({ conferences: [conf(SLUG)] }), key: KEY });
  const res = await call(ctx.env, new Request(put.url, { method: 'PUT', headers: { 'X-Caddie-Admin': put.header, 'Content-Type': 'application/json', 'CF-Connecting-IP': '2001:db8::91' }, body: JSON.stringify({ conferences: [conf(SLUG)] }) }));
  assert.equal(res.status, 200);
}

const NOT_FOUND = { error: 'Not found' };
const rows = (ctx, table) => ctx.states.get(`conference:${SLUG}`)?.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n ?? 0;

describe('the /admin/test/* fixtures are gated by ADMIN_TEST_ROUTES', { skip }, () => {
  for (const route of ROUTES) {
    test(`${route.name}: a correctly signed request answers 404 while the variable is unset, and nothing is looked up or run`, async () => {
      const ctx = realEnv();
      await withConference(ctx);
      const directoryCalls = ctx.DIRECTORY.calls.length;
      const conferenceCalls = ctx.CONFERENCE.calls.length;
      const res = await call(ctx.env, signedRequest(route));
      assert.deepEqual([res.status, res.json], [404, NOT_FOUND]);
      // Before the directory lookup: neither object saw the request.
      assert.equal(ctx.DIRECTORY.calls.length, directoryCalls);
      assert.equal(ctx.CONFERENCE.calls.length, conferenceCalls);
      assert.equal(rows(ctx, 'people'), 0);
    });
  }

  test('every value but the string "1" keeps them off: empty, "0", "true", " 1", "1 " and a number', async () => {
    for (const value of ['', '0', 'true', ' 1', '1 ', 'yes', 1, true]) {
      const ctx = realEnv({ ADMIN_TEST_ROUTES: value });
      await withConference(ctx);
      for (const route of ROUTES) {
        const res = await call(ctx.env, signedRequest(route));
        assert.deepEqual([res.status, res.json], [404, NOT_FOUND], `${route.name} with ${JSON.stringify(value)}`);
      }
      assert.equal(rows(ctx, 'people'), 0);
    }
  });

  test('an unsigned request answers the same 404 with the variable unset and with "1"', async () => {
    for (const extra of [{}, { ADMIN_TEST_ROUTES: '1' }]) {
      const ctx = realEnv(extra);
      await withConference(ctx);
      for (const route of ROUTES) {
        const res = await call(ctx.env, signedRequest(route, { sign: false }));
        assert.deepEqual([res.status, res.json], [404, NOT_FOUND], `${route.name} ${JSON.stringify(extra)}`);
      }
    }
  });

  test('the gate comes after the signature, the clock and the body hash, as for every admin route: a tampered body is 401 admin_body, a skewed clock 401 admin_skew', async () => {
    const ctx = realEnv();
    await withConference(ctx);
    const route = ROUTES[0];
    const calls = ctx.CONFERENCE.calls.length;
    const s = signAdminRequest({ method: route.method, path: route.path, base: BASE, body: route.body, key: KEY });
    const tampered = new Request(s.url, { method: 'POST', headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': '2001:db8::91' }, body: '{"tampered":true}' });
    const a = await call(ctx.env, tampered);
    assert.deepEqual([a.status, a.json], [401, { error: 'admin_body' }]);
    const old = signAdminRequest({ method: route.method, path: route.path, base: BASE, body: route.body, key: KEY, now: Date.now() - 400_000 });
    const b = await call(ctx.env, new Request(old.url, { method: 'POST', headers: { 'X-Caddie-Admin': old.header, 'CF-Connecting-IP': '2001:db8::91' }, body: route.body }));
    assert.deepEqual([b.status, b.json], [401, { error: 'admin_skew' }]);
    assert.equal(ctx.CONFERENCE.calls.length, calls, 'neither reached an object');
  });

  test('a request signed with the wrong key answers 404 whatever the variable says', async () => {
    const ctx = realEnv({ ADMIN_TEST_ROUTES: '1' });
    await withConference(ctx);
    const route = ROUTES[3];
    const s = signAdminRequest({ method: route.method, path: route.path, base: BASE, body: route.body, key: fixture.keys.key2 });
    const res = await call(ctx.env, new Request(s.url, { method: 'POST', headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': '2001:db8::92' }, body: route.body }));
    assert.deepEqual([res.status, res.json], [404, NOT_FOUND]);
  });

  test('with "1" the four routes behave as before: create, age, restart and delete the fixture', async () => {
    const ctx = realEnv({ ADMIN_TEST_ROUTES: '1' });
    await withConference(ctx);
    const [create, del, age, restart] = ROUTES;

    // A bad body reaches the handler and gets its own 400, not the gate's 404.
    const bad = await call(ctx.env, signedRequest({ ...create, body: JSON.stringify({ profile_id: 'short', secret_hash: SECRET_HASH, visible_until_ms: 1 }) }));
    assert.equal(bad.status, 400);

    assert.deepEqual(Object.values(await call(ctx.env, signedRequest(create))), [200, { ok: true }]);
    assert.equal(rows(ctx, 'people'), 1);

    // No presence yet: the handler's own 404, with its own body.
    const missing = await call(ctx.env, signedRequest(age));
    assert.deepEqual([missing.status, missing.json], [404, { error: 'not_found' }]);
    // Through the object's own store, so its cache of people sees the presence row.
    ctx.CONFERENCE.objects.get(SLUG).store.setPresence(PROFILE, { until_ms: Date.now() + 3_600_000 });
    assert.deepEqual(Object.values(await call(ctx.env, signedRequest(age))), [200, { ok: true }]);
    const until = ctx.states.get(`conference:${SLUG}`).db.prepare('SELECT until_ms FROM presence WHERE profile_id = ?').get(PROFILE).until_ms;
    assert.ok(until <= Date.now() + 61_000, 'until_ms was aged to the requested value');

    assert.deepEqual(Object.values(await call(ctx.env, signedRequest(restart))), [200, { ok: true }]);

    assert.deepEqual(Object.values(await call(ctx.env, signedRequest(del))), [200, { ok: true }]);
    assert.equal(rows(ctx, 'people'), 0);
  });

  test('the gate does not touch the other admin routes: stats answers with the variable unset', async () => {
    const ctx = realEnv();
    await withConference(ctx);
    const res = await call(ctx.env, signedRequest({ method: 'GET', path: `/admin/stats?event=${SLUG}` }));
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.usage, 'object');
  });
});
