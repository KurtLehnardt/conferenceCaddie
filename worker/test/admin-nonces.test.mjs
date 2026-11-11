// The nonce table of the Durable Objects that serve admin requests (W2): a ConferenceDO and the
// DirectoryDO each record the nonce the Worker forwards from a verified X-Caddie-Admin header
// before any /admin/* handler runs, refuse one they have seen (401 admin_replay), store the signed
// timestamp, drop nonces older than 15 minutes, and answer 404 to an /admin/* request without
// the forwarded headers. Most tests go through the Worker's fetch handler to real objects on
// node:sqlite (helpers/harness.mjs); the keys are the shared fixture's fake ones.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { skip, ConferenceDO, DirectoryDO, worker, adminRoutes, fakeState, namespace, withClock, withFixedClock } from './helpers/harness.mjs';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const BASE = 'https://caddie.example';
const SLUG = 'caddie-fixture-2099';
const OTHER = 'other-fixture-2099';
const conf = (slug) => ({ slug, name: slug, status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC' });

// The Worker's environment with real objects. Every SQL statement the directory runs is recorded.
function realEnv() {
  const states = new Map();
  const directorySql = [];
  const CONFERENCE = namespace((name) => {
    const state = fakeState();
    states.set(`conference:${name}`, state);
    return new ConferenceDO(state, { EMBED_FAKE: '1' });
  });
  const DIRECTORY = namespace((name) => {
    const state = fakeState({ onExec: (q) => directorySql.push(q) });
    states.set(`directory:${name}`, state);
    return new DirectoryDO(state, {});
  });
  return { env: { ADMIN_TOKEN: KEY, EMBED_FAKE: '1', CONFERENCE, DIRECTORY }, states, directorySql, CONFERENCE, DIRECTORY };
}

// Signs once; build() makes a fresh Request with the same signature each time it is called, as a
// replay would.
function signed(method, path, { body, now, nonce } = {}) {
  const s = signAdminRequest({ method, path, base: BASE, body, key: KEY, now, nonce });
  const build = () => new Request(s.url, {
    method,
    headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': '2001:db8::77', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body,
  });
  return { ...s, build };
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

async function withConferences(ctx, slugs = [SLUG]) {
  const r = await call(ctx.env, signed('PUT', '/admin/conferences', { body: JSON.stringify({ conferences: slugs.map(conf) }) }).build());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { upserted: slugs.length, searchable: slugs.length, synced: slugs.length });
}

const nonces = (state) => state.db.prepare('SELECT nonce, ts_ms FROM admin_nonces ORDER BY ts_ms, nonce').all().map((r) => ({ ...r }));

// Counts the calls of one ConferenceDO admin handler (the route objects are shared with the object).
function countHandler(method, path) {
  const route = adminRoutes.find((r) => r.method === method && r.path === path);
  const original = route.handler;
  const counter = { n: 0, restore: () => { route.handler = original; } };
  route.handler = (...args) => {
    counter.n += 1;
    return original(...args);
  };
  return counter;
}

describe('the admin nonce table', { skip }, () => {
  test('the same nonce twice on a ConferenceDO admin route: 200, then 401 admin_replay without running the handler', async () => {
    const ctx = realEnv();
    await withConferences(ctx);
    const stats = countHandler('GET', '/admin/stats');
    try {
      const req = signed('GET', `/admin/stats?event=${SLUG}`);
      assert.equal((await call(ctx.env, req.build())).status, 200);
      const replay = await call(ctx.env, req.build());
      assert.deepEqual([replay.status, replay.json], [401, { error: 'admin_replay' }]);
      assert.equal(stats.n, 1);
    } finally {
      stats.restore();
    }
    // A write route too: the replayed batch is refused, and a fresh signature of the same body is not.
    const post = signed('POST', `/admin/embed-pending?event=${SLUG}`, { body: '{}' });
    assert.equal((await call(ctx.env, post.build())).status, 200);
    assert.deepEqual(Object.values(await call(ctx.env, post.build())), [401, { error: 'admin_replay' }]);
    assert.equal((await call(ctx.env, signed('POST', `/admin/embed-pending?event=${SLUG}`, { body: '{}' }).build())).status, 200);
  });

  test('the same nonce twice on PUT /admin/conferences: 200, then 401 admin_replay, and the directory upserts and fans out once', async () => {
    const ctx = realEnv();
    const req = signed('PUT', '/admin/conferences', { body: JSON.stringify({ conferences: [conf(SLUG)] }) });
    const upserts = () => ctx.directorySql.filter((q) => q.startsWith('SELECT slug, doc, route_prefix, has_object FROM conferences')).length;
    const fanOut = () => ctx.CONFERENCE.calls.filter((c) => new URL(c.req.url).pathname === '/internal/conference').length;
    const first = await call(ctx.env, req.build());
    assert.deepEqual([first.status, first.json], [200, { upserted: 1, searchable: 1, synced: 1 }]);
    assert.deepEqual([upserts(), fanOut()], [1, 1]);
    const replay = await call(ctx.env, req.build());
    assert.deepEqual([replay.status, replay.json], [401, { error: 'admin_replay' }]);
    assert.deepEqual([upserts(), fanOut()], [1, 1]);
  });

  test('ts_ms is the signed timestamp times 1000, not the object\'s clock', async () => {
    const ctx = realEnv();
    const put = signed('PUT', '/admin/conferences', { body: JSON.stringify({ conferences: [conf(SLUG)] }), now: Date.now() - 200_000 });
    assert.equal((await call(ctx.env, put.build())).status, 200);
    const get = signed('GET', `/admin/stats?event=${SLUG}`, { now: Date.now() + 250_000 });
    assert.equal((await call(ctx.env, get.build())).status, 200);
    assert.deepEqual(nonces(ctx.states.get('directory:global')), [{ nonce: put.nonce, ts_ms: put.ts * 1000 }]);
    assert.deepEqual(nonces(ctx.states.get(`conference:${SLUG}`)), [{ nonce: get.nonce, ts_ms: get.ts * 1000 }]);
  });

  test('nonces are per object: each table holds its own, and the same nonce value is fresh in another object', async () => {
    const ctx = realEnv();
    await withConferences(ctx, [SLUG, OTHER]);
    const nonce = randomBytes(16).toString('base64url');
    for (const slug of [SLUG, OTHER]) assert.equal((await call(ctx.env, signed('GET', `/admin/stats?event=${slug}`, { nonce }).build())).status, 200);
    for (const slug of [SLUG, OTHER]) assert.deepEqual(nonces(ctx.states.get(`conference:${slug}`)).map((r) => r.nonce), [nonce]);
    assert.ok(!nonces(ctx.states.get('directory:global')).some((r) => r.nonce === nonce));
    // A request signed for one conference cannot be sent to the other: the event is in the signed path.
    const forOne = signed('GET', `/admin/stats?event=${SLUG}`);
    const moved = new Request(`${BASE}/admin/stats?event=${OTHER}`, { headers: { 'X-Caddie-Admin': forOne.header, 'CF-Connecting-IP': '2001:db8::78' } });
    assert.equal((await call(ctx.env, moved)).status, 404);
  });

  test('a nonce whose signed time is older than 15 minutes is gone after a later insert, through the index', async () => {
    const state = fakeState();
    const obj = new ConferenceDO(state, { EMBED_FAKE: '1' });
    const send = (nonce, ts) => obj.fetch(new Request(`https://do.internal/admin/stats?event=${SLUG}`, {
      headers: { 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': nonce, 'x-caddie-admin-ts': String(ts) },
    }));
    const T = 1_900_000_000;
    await withFixedClock(T * 1000, async (setNow) => {
      const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(22));
      assert.equal((await send(a, T)).status, 200);
      setNow((T + 500) * 1000);
      assert.equal((await send(b, T + 500)).status, 200);
      setNow((T + 900) * 1000); // a is exactly 15 minutes old: kept
      assert.equal((await send('d'.repeat(22), T + 900)).status, 200);
      assert.deepEqual(nonces(state).map((r) => r.nonce), [a, b, 'd'.repeat(22)]);
      setNow((T + 901) * 1000); // a is 15 min 1 s old
      assert.equal((await send(c, T + 901)).status, 200);
      assert.deepEqual(nonces(state).map((r) => r.ts_ms), [(T + 500) * 1000, (T + 900) * 1000, (T + 901) * 1000]);
    });
    const plan = state.db.prepare('EXPLAIN QUERY PLAN DELETE FROM admin_nonces WHERE ts_ms < ?').all(0).map((r) => r.detail).join(' ');
    assert.match(plan, /admin_nonces_ts/);
  });

  test('each object checks the forwarded timestamp against its own clock: 305 seconds pass, 306 are 401 admin_skew', async () => {
    const T = 1_900_000_000;
    const conference = new ConferenceDO(fakeState(), { EMBED_FAKE: '1' });
    const dirSql = [];
    const directory = new DirectoryDO(fakeState({ onExec: (q) => dirSql.push(q) }), {});
    const stats = countHandler('GET', '/admin/stats');
    let n = 0;
    const nonce = () => `n${String(++n).padStart(21, '0')}`;
    const toConference = (ts) => conference.fetch(new Request(`https://do.internal/admin/stats?event=${SLUG}`, {
      headers: { 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': nonce(), 'x-caddie-admin-ts': String(ts) },
    }));
    const toDirectory = (ts) => directory.fetch(new Request('https://directory.internal/admin/conferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-caddie-admin-nonce': nonce(), 'x-caddie-admin-ts': String(ts) },
      body: JSON.stringify({ conferences: [conf(SLUG)] }),
    }));
    const upserts = () => dirSql.filter((q) => q.startsWith('SELECT slug, doc, route_prefix, has_object FROM conferences')).length;
    try {
      await withFixedClock(T * 1000 + 999, async () => {
        for (const send of [toConference, toDirectory]) {
          for (const off of [-305, 305, 0]) assert.equal((await send(T + off)).status, 200, `${send.name} ${off}`);
          for (const off of [-306, 306, -100_000]) {
            const res = await send(T + off);
            assert.deepEqual([res.status, await res.json()], [401, { error: 'admin_skew' }], `${send.name} ${off}`);
          }
        }
      });
      assert.equal(stats.n, 3);
      assert.equal(upserts(), 3);
    } finally {
      stats.restore();
    }
  });

  // The object's own clock check alone, with no Worker in front: the next test does the same for the
  // DirectoryDO. The end-to-end stalled-body tests below go through the Worker, whose re-check after
  // the body read refuses first, so they guard the two checks together.
  test('a ConferenceDO refuses a nonce whose first use was pruned: the timestamp is past its clock window', async () => {
    const state = fakeState();
    const obj = new ConferenceDO(state, { EMBED_FAKE: '1' });
    const stats = countHandler('GET', '/admin/stats');
    const send = (nonce, ts) => obj.fetch(new Request(`https://do.internal/admin/stats?event=${SLUG}`, {
      headers: { 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': nonce, 'x-caddie-admin-ts': String(ts) },
    }));
    const T = 1_900_000_000;
    const first = 'f'.repeat(22);
    try {
      await withFixedClock(T * 1000, async (setNow) => {
        assert.equal((await send(first, T)).status, 200);
        setNow((T + 1000) * 1000);
        assert.equal((await send('p'.repeat(22), T + 1000)).status, 200); // prunes the first nonce
        assert.ok(!nonces(state).some((r) => r.nonce === first));
        const again = await send(first, T);
        assert.deepEqual([again.status, await again.json()], [401, { error: 'admin_skew' }]);
      });
      assert.equal(stats.n, 2);
    } finally {
      stats.restore();
    }
  });

  test('a DirectoryDO refuses a nonce whose first use was pruned: the timestamp is past its clock window', async () => {
    const sql = [];
    const state = fakeState({ onExec: (q) => sql.push(q) });
    const dir = new DirectoryDO(state, {});
    const upserts = () => sql.filter((q) => q.startsWith('SELECT slug, doc, route_prefix, has_object FROM conferences')).length;
    const send = (nonce, ts) => dir.fetch(new Request('https://directory.internal/admin/conferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-caddie-admin-nonce': nonce, 'x-caddie-admin-ts': String(ts) },
      body: JSON.stringify({ conferences: [conf(SLUG)] }),
    }));
    const T = 1_900_000_000;
    const first = 'f'.repeat(22);
    await withFixedClock(T * 1000, async (setNow) => {
      assert.equal((await send(first, T)).status, 200);
      setNow((T + 1000) * 1000);
      assert.equal((await send('p'.repeat(22), T + 1000)).status, 200); // prunes the first nonce
      assert.ok(!nonces(state).some((r) => r.nonce === first));
      const again = await send(first, T);
      assert.deepEqual([again.status, await again.json()], [401, { error: 'admin_skew' }]);
    });
    assert.equal(upserts(), 2);
  });

  test('a ConferenceDO replay whose body is held back past the nonce retention is refused, and the handler runs once (Worker re-check and object check together)', async () => {
    // Through the Worker: its clock re-check after the body read refuses this request before it
    // reaches the object, so this guards both layers together; the object's check alone is the
    // direct test above.
    const embed = countHandler('POST', '/admin/embed-pending');
    try {
      await withClock(async (setOffset) => {
        const ctx = realEnv();
        await withConferences(ctx);
        const body = '{}';
        const req = signed('POST', `/admin/embed-pending?event=${SLUG}`, { body });
        assert.equal((await call(ctx.env, req.build())).status, 200);
        assert.deepEqual(Object.values(await call(ctx.env, req.build())), [401, { error: 'admin_replay' }]);
        // The replay starts 10 seconds later (inside the window) and its body arrives after
        // 1000 seconds, once another admin request to the same object has pruned the nonce.
        setOffset(10_000);
        const stream = new ReadableStream({
          async pull(c) {
            setOffset(1_000_000);
            assert.equal((await call(ctx.env, signed('GET', `/admin/stats?event=${SLUG}`).build())).status, 200);
            assert.ok(!nonces(ctx.states.get(`conference:${SLUG}`)).some((r) => r.nonce === req.nonce), 'the first use was pruned');
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }, { highWaterMark: 0 });
        const stalled = new Request(req.url, {
          method: 'POST', duplex: 'half', body: stream,
          headers: { 'X-Caddie-Admin': req.header, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.66' },
        });
        assert.deepEqual(Object.values(await call(ctx.env, stalled)), [401, { error: 'admin_skew' }]);
      });
      assert.equal(embed.n, 1);
    } finally {
      embed.restore();
    }
  });

  test('the same on PUT /admin/conferences: a held-back replay is refused, and the directory upserts only for the request that pruned (Worker re-check and object check together)', async () => {
    // Through the Worker, as the ConferenceDO test above; the DirectoryDO's own check alone is the
    // direct pruned-nonce test.
    await withClock(async (setOffset) => {
      const ctx = realEnv();
      const upserts = () => ctx.directorySql.filter((q) => q.startsWith('SELECT slug, doc, route_prefix, has_object FROM conferences')).length;
      const body = JSON.stringify({ conferences: [conf(SLUG)] });
      const req = signed('PUT', '/admin/conferences', { body });
      assert.equal((await call(ctx.env, req.build())).status, 200);
      assert.equal(upserts(), 1);
      setOffset(10_000);
      const stream = new ReadableStream({
        async pull(c) {
          setOffset(1_000_000);
          assert.equal((await call(ctx.env, signed('PUT', '/admin/conferences', { body }).build())).status, 200); // prunes the first nonce
          assert.ok(!nonces(ctx.states.get('directory:global')).some((r) => r.nonce === req.nonce), 'the first use was pruned');
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }, { highWaterMark: 0 });
      const stalled = new Request(req.url, {
        method: 'PUT', duplex: 'half', body: stream,
        headers: { 'X-Caddie-Admin': req.header, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      });
      assert.deepEqual(Object.values(await call(ctx.env, stalled)), [401, { error: 'admin_skew' }]);
      assert.equal(upserts(), 2, 'only the request that pruned upserted');
    });
  });

  test('an object that reached version 3 without the nonce index gets it at its next start', () => {
    const state = fakeState();
    new ConferenceDO(state, { EMBED_FAKE: '1' });
    const indexes = () => state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'admin_nonces' AND name = 'admin_nonces_ts'").all().length;
    assert.equal(indexes(), 1);
    state.db.exec('DROP INDEX admin_nonces_ts');
    assert.equal(state.db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get().v, '3');
    new ConferenceDO(state, { EMBED_FAKE: '1' });
    assert.equal(indexes(), 1);
  });

  test('an /admin/* request without the forwarded nonce and timestamp is 404 in both objects, and no handler runs', async () => {
    const obj = new ConferenceDO(fakeState(), { EMBED_FAKE: '1' });
    const stats = countHandler('GET', '/admin/stats');
    const good = { 'x-caddie-admin-nonce': 'n'.repeat(22), 'x-caddie-admin-ts': String(Math.floor(Date.now() / 1000)) };
    try {
      for (const headers of [{}, { 'x-caddie-admin-nonce': good['x-caddie-admin-nonce'] }, { 'x-caddie-admin-ts': good['x-caddie-admin-ts'] },
        { ...good, 'x-caddie-admin-nonce': 'n'.repeat(21) }, { ...good, 'x-caddie-admin-ts': `0${good['x-caddie-admin-ts']}` },
        { ...good, 'x-caddie-admin-ts': '-1' }, { ...good, 'x-caddie-admin-ts': '1e9' }, { ...good, 'x-caddie-admin-nonce': `${'n'.repeat(21)}=` }]) {
        const res = await obj.fetch(new Request(`https://do.internal/admin/stats?event=${SLUG}`, { headers: { 'x-caddie-slug': SLUG, ...headers } }));
        assert.equal(res.status, 404, JSON.stringify(headers));
        assert.deepEqual(await res.json(), { error: 'Not found' });
      }
      assert.equal(stats.n, 0);
      // Internal routes need no nonce: the cron and the fan-out never use /admin/*.
      const internal = await obj.fetch(new Request('https://do.internal/internal/conference', {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc: conf(SLUG), route_prefix: 'abcdef' }),
      }));
      assert.equal(internal.status, 200);
    } finally {
      stats.restore();
    }

    const sql = [];
    const dir = new DirectoryDO(fakeState({ onExec: (q) => sql.push(q) }), {});
    const before = sql.length;
    const res = await dir.fetch(new Request('https://directory.internal/admin/conferences', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conferences: [conf(SLUG)] }),
    }));
    assert.equal(res.status, 404);
    assert.equal(sql.length, before, 'the directory ran no statement for it');
    assert.equal((await dir.fetch(new Request('https://directory.internal/internal/routes'))).status, 200);
  });

  test('at the daily written-rows limit an admin request answers 503 daily_limit in both objects, reads included', async () => {
    // The nonce insert is the first write; the stand-in throws as the runtime does once the
    // account's limit is reached.
    const limit = (q) => {
      if (q.startsWith('INSERT INTO admin_nonces')) throw new Error('Exceeded the daily limit of rows written');
    };
    const headers = () => ({ 'x-caddie-slug': SLUG, 'x-caddie-admin-nonce': randomBytes(16).toString('base64url'), 'x-caddie-admin-ts': String(Math.floor(Date.now() / 1000)) });
    const stats = countHandler('GET', '/admin/stats');
    const error = console.error;
    console.error = () => {};
    try {
      const obj = new ConferenceDO(fakeState({ onExec: limit }), { EMBED_FAKE: '1' });
      const res = await obj.fetch(new Request(`https://do.internal/admin/stats?event=${SLUG}`, { headers: headers() }));
      assert.deepEqual([res.status, await res.json()], [503, { error: 'daily_limit' }]);
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal(stats.n, 0);
      const dir = new DirectoryDO(fakeState({ onExec: limit }), {});
      const put = await dir.fetch(new Request('https://directory.internal/admin/conferences', {
        method: 'PUT', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ conferences: [conf(SLUG)] }),
      }));
      assert.deepEqual([put.status, await put.json()], [503, { error: 'daily_limit' }]);
      assert.ok(Number(put.headers.get('retry-after')) > 0);
    } finally {
      console.error = error;
      stats.restore();
    }
  });

  test('no internal caller uses an /admin/* path: the cron and the fan-out reach the objects on /internal/* only', async () => {
    const ctx = realEnv();
    await withConferences(ctx, [SLUG, OTHER]);
    const viaAdmin = ctx.CONFERENCE.calls.map((c) => new URL(c.req.url).pathname);
    assert.deepEqual(viaAdmin, ['/internal/conference', '/internal/conference'], 'the PUT /admin/conferences fan-out');
    ctx.CONFERENCE.calls.length = 0;
    ctx.DIRECTORY.calls.length = 0;
    const pending = [];
    const log = console.log;
    console.log = () => {};
    try {
      await worker.scheduled({}, ctx.env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
    } finally {
      console.log = log;
    }
    const paths = [...ctx.CONFERENCE.calls, ...ctx.DIRECTORY.calls].map((c) => new URL(c.req.url).pathname);
    assert.ok(paths.includes('/internal/cron') && paths.includes('/internal/cron-targets') && paths.includes('/internal/usage'), paths.join(' '));
    assert.ok(paths.every((p) => p.startsWith('/internal/')), paths.join(' '));
    // The cron consumed no nonce anywhere.
    for (const [name, state] of ctx.states) if (name.startsWith('conference:')) assert.deepEqual(nonces(state), []);
  });
});
