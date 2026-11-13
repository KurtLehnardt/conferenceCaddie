// The demo conference on tier 2 (DECISIONS.md, "The demo conference on the Worker"): the same four
// rules as tier 3, on the Worker, and the daily refresh.
// - The label: GET /api/conferences carries demo: true on the demo only, and leaves a demo that is
//   not searchable out; a nudge about the demo says "Demo" in its title and body (the strings of
//   server/nudge.mjs), and a real conference's nudge is unchanged.
// - The budgets: every real conference's meter counts the demo's load, the demo has its own
//   allotment (DEMO_SHARE) on which it slows down and then refuses its public writes, and GET
//   /admin/stats leaves it out of the totals it shows; the cron still visits it for its own purge.
// - The daily refresh: push-ingest.mjs pushes the generated demo for one day and then the next;
//   the talk ids are the same, so finalize deletes nothing, no shared talk is unshared, no profile
//   is deleted and FINALIZE_MAX_DELETE never refuses. With --refresh-only it pushes only while the
//   Worker lists the demo as searchable, and writes it only while its row is still searchable
//   (expect_status), so a refresh never adds, shows or brings back the demo; push-ingest's main()
//   runs as a child process against the Worker for that.
// - The demo's people last DEMO_GRACE_DAYS past its last day, the same number as tier 3's.
// - Switching it off: a hidden demo deletes its presence (with the Bluetooth session), positions,
//   Bluetooth caps, meets, nudges and nudge sends, keeps its profiles, and leaves the public list;
//   a real conference's hide keeps everything; a removed demo leaves no row. A nudge that was
//   sending when the demo was hidden sends nothing more, a cleanup that fails leaves no old Store
//   open, and a fan-out that arrives after a later one is ignored (doc_seq).
// - The tier 2 CLI (scripts/admin/backends/worker.mjs, under the command layer of
//   scripts/admin/commands/conferences.mjs) marks the demo in conferences list and still reaches a
//   hidden demo, which the Worker no longer lists, for hide, unhide and unretire.
//
// Every request goes through the Worker's fetch handler, signed with the shared fixture's fake key,
// to real objects on node:sqlite (helpers/harness.mjs), with fake embeddings (EMBED_FAKE). The demo
// comes from scripts/lib/demo-conference.mjs buildDemo. Nothing here reaches the network: pushes
// are answered by a stand-in for fetch and decrypted here. module.registerHooks needs Node 22.15
// or later; on older versions these tests are skipped.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { skip, worker, ConferenceDO, DirectoryDO, fakeState, namespace, withFixedClock } from './helpers/harness.mjs';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';
import { buildDemo, DEFAULT_DEMO_CONFIG } from '../../scripts/lib/demo-conference.mjs';
import { CONFERENCE_FIELDS } from '../../contracts/js/bundle.mjs';
import { validator } from '../../contracts/js/schemas.mjs';
import { formatErrors } from '../../contracts/js/validate.mjs';
import { listedSearchable, pushEvent, refreshOnly, upsertConferences, upsertRefreshing, workerTalks } from '../ingest/push-ingest.mjs';
import { Meter, demoShareOf } from '../src/lib/meter.js';
import { DEMO_GRACE_DAYS, conferenceVisibleUntilMs, visibleUntilMs } from '../src/lib/time.js';
import { DEMO_GRACE_DAYS as TIER3_DEMO_GRACE_DAYS } from '../../server/people-shared.mjs';
import { loadStoplist } from '../ingest/topics-local.mjs';
import { createWorkerAdapter } from '../../scripts/admin/backends/worker.mjs';
import { withConferenceFiles } from '../../scripts/admin/commands/conferences.mjs';
import { NotFoundError } from '../../scripts/admin/errors.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const BASE = 'https://caddie.example';
const ON = { ...DEFAULT_DEMO_CONFIG, enabled: true };
const DEMO = ON.slug;
const REAL = 'caddie-fixture-2099';
const REAL2 = 'other-fixture-2099';
const DAY = '2026-11-12';
const NEXT = '2026-11-13';
const HOUR = 3600_000;
// 11:00 on DAY in the demo's zone (America/Denver, UTC-7 in November), inside today's programme.
const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(16).toString('base64url');
const rows = (db, sql, ...b) => db.prepare(sql).all(...b).map((r) => ({ ...r }));

// The demo's conference document as scripts/ingest.mjs writes it for day (raw_fetched_at set).
const demoConf = (day, extra = {}) => ({ ...buildDemo(ON, day).conference, raw_fetched_at: `${day}T06:00:00.000Z`, ...extra });
const hiddenDemo = (day = DAY) => demoConf(day, { status: 'unavailable', status_reason: 'operator_hidden' });
const realConf = (slug = REAL, extra = {}) => ({
  slug, name: `Fixture ${slug}`, status: 'searchable', status_reason: null, source: 'sessionize', start_date: '2026-11-11', end_date: '2026-11-14', time_zone: 'UTC',
  official_schedule_url: 'https://example.org/schedule', counts: { talk: 0 }, ...extra,
});

// The Worker's environment with real objects; every waitUntil of a conference object is kept in
// pending, so a test can wait for the nudge a presence write started.
function realEnv(objectEnv = {}) {
  const states = new Map();
  const pending = [];
  const CONFERENCE = namespace((name) => {
    const state = fakeState();
    state.waitUntil = (p) => pending.push(p);
    states.set(`conference:${name}`, state);
    return new ConferenceDO(state, { EMBED_FAKE: '1', ...objectEnv });
  });
  const DIRECTORY = namespace((name) => {
    const state = fakeState();
    states.set(`directory:${name}`, state);
    return new DirectoryDO(state, {});
  });
  const env = { ADMIN_TOKEN: KEY, EMBED_FAKE: '1', CONFERENCE, DIRECTORY };
  return {
    env,
    pending,
    obj: (slug) => CONFERENCE.objects.get(slug),
    db: (name) => states.get(name).db,
    settle: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

// Silences the console while fn runs. Calls may overlap (the bridge server below serves a child
// process while the test sends its own requests), so the console comes back when the last ends.
let quiet = 0;
let loud = null;
async function quietly(fn) {
  if (quiet++ === 0) {
    loud = { log: console.log, error: console.error, warn: console.warn };
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
  }
  try {
    return await fn();
  } finally {
    if (--quiet === 0) Object.assign(console, loud);
  }
}

async function call(env, req) {
  return quietly(async () => {
    const res = await worker.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  });
}

// One signed admin request.
function send(ctx, method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const s = signAdminRequest({ method, path, base: BASE, body: payload, key: KEY });
  return call(ctx.env, new Request(s.url, {
    method,
    headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': '2001:db8::99', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload,
  }));
}

// A public request, as a native app sends it (no Origin), from its own address each time.
let ip = 0;
function api(ctx, method, path, body, device) {
  const headers = { 'CF-Connecting-IP': `192.0.2.${(ip++ % 200) + 1}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (device) headers['X-Caddie-Device'] = `${device.id}.${device.secret}`;
  return call(ctx.env, new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const ok = (r) => assert.ok(r.status >= 200 && r.status < 300, `status ${r.status} ${JSON.stringify(r.json)}`);

async function putConferences(ctx, docs) {
  const r = await send(ctx, 'PUT', '/admin/conferences', { conferences: docs });
  ok(r);
  return r.json;
}

const listed = async (ctx) => {
  const r = await api(ctx, 'GET', '/api/conferences');
  ok(r);
  return r.json.conferences;
};

// The admin client push-ingest.mjs gets (lib.mjs adminClient): the answer's JSON, or an Error with
// the status. Every answer is recorded.
function adminVia(ctx, log = []) {
  return async (method, path, body) => {
    const r = await send(ctx, method, path, body);
    log.push({ method, path: path.split('?')[0], status: r.status, json: r.json });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
      err.status = r.status;
      err.body = r.json;
      throw err;
    }
    return r.json;
  };
}

async function cron(ctx) {
  const pending = [];
  await quietly(async () => {
    await worker.scheduled({}, ctx.env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  });
}

// Every table of a database, without SQLite's own and the FTS5 shadow tables, with its row count.
function counts(db) {
  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name)
    .filter((n) => !/_fts_(data|idx|content|docsize|config)$/.test(n));
  return Object.fromEntries(tables.map((t) => [t, rows(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]));
}

// Puts a row in every live table of an object and in the tables a hide keeps: two people (one
// sharing a talk), presence with a Bluetooth session and a position, a block, a meet, a report, a
// push subscription, a nudge, a nudge send and a Bluetooth caps record.
async function populatePeople(o, slug) {
  const now = Date.now();
  const person = (name, extra) => o.store.insertPerson({ profile_id: newId(), secret_hash: sha(`secret-${name}`), display_name: name, open_to_meet: true, visible_until_ms: now + 48 * HOUR, ...extra });
  const a = await person('Ann', { about: 'kernel things', shared_talk_ids: [`${slug}:d1-a10`] });
  const b = await person('Bob', {});
  o.store.setPresence(a.profile_id, { zone: 'Hallway', spot: 'by the door', since_ms: now, until_ms: now + HOUR, ble_token: 'tok', ble_token_until_ms: now + 600_000, presence_nonce: b64u(randomBytes(16)), ble_master_id: 'k1' });
  o.store.setPresence(b.profile_id, { zone: 'Hallway', since_ms: now, until_ms: now + HOUR });
  o.store.setLocation(a.profile_id, { lat: 40.76789, lon: -111.89012, accuracy: 12 });
  o.store.addBlock(b.profile_id, a.profile_id, a.ref, now + 48 * HOUR);
  o.exec("INSERT INTO meets (meet_id, requester_id, recipient_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, 'requested', ?, ?)", newId(), a.profile_id, b.profile_id, now, now + HOUR);
  o.exec("INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, 'profile', ?, ?, ?, 'spam', ?)", `profile:${b.ref}:${a.profile_id}`, b.ref, b.profile_id, a.profile_id, now);
  o.exec('INSERT INTO push_subs (id, profile_id, endpoint, p256dh, auth, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), a.profile_id, 'https://fcm.googleapis.com/fcm/send/x', 'k', 'a', now, now + HOUR);
  o.exec('INSERT INTO nudges (id, day, a_id, b_id, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)', newId(), DAY, a.profile_id, b.profile_id, now, now + HOUR);
  o.exec('INSERT INTO nudge_sends (receiver_id, sent_at_ms, expires_at_ms) VALUES (?, ?, ?)', a.profile_id, now, now + HOUR);
  o.store.addBleCaps(a.profile_id, [{ id: b.ref, at: now, w: 1 }], now);
  return { a, b };
}

const LIVE = ['presence', 'ble_caps', 'meets', 'nudges', 'nudge_sends'];
const KEPT = ['people', 'people_fts', 'shared_talks', 'blocks', 'reports', 'push_subs'];

// ---------------------------------------------------------------------------------------------

describe('GET /api/conferences and the demo marker', { skip }, () => {
  test('the demo is listed with demo: true, last, while searchable; real entries keep exactly their fields; a hidden demo is left out', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      const unavailable = realConf(REAL2, { status: 'unavailable', status_reason: 'no_schedule_url' });
      await putConferences(ctx, [realConf(), unavailable, demoConf(DAY)]);
      const list = await listed(ctx);
      const check = validator('conferences-index.v1', 'Conference');
      for (const c of list) {
        const v = check(c, { closed: true });
        assert.equal(v.valid, true, formatErrors(v.errors));
      }
      const demo = list.find((c) => c.slug === DEMO);
      assert.deepEqual(Object.keys(demo), [...CONFERENCE_FIELDS, 'demo'], 'the marker comes last');
      assert.equal(demo.demo, true);
      assert.equal(demo.status, 'searchable');
      assert.equal(demo.source, 'demo');
      assert.equal(demo.official_schedule_url, null);
      assert.equal(demo.talk_count, buildDemo(ON, DAY).counts.talk);
      for (const slug of [REAL, REAL2]) assert.deepEqual(Object.keys(list.find((c) => c.slug === slug)), CONFERENCE_FIELDS, `${slug} has no demo key`);

      // Hidden: gone from the list, while a real unavailable conference stays listed.
      assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
      const after = await listed(ctx);
      assert.deepEqual(after.map((c) => c.slug).sort(), [REAL, REAL2].sort());
      assert.equal(after.find((c) => c.slug === REAL2).status, 'unavailable');
      // The Worker no longer routes it: a public request is refused.
      const r = await api(ctx, 'GET', `/api/topics?event=${DEMO}`);
      assert.deepEqual([r.status, r.json], [400, { error: 'event is not available' }]);

      // Shown again.
      await putConferences(ctx, [demoConf(DAY)]);
      assert.ok((await listed(ctx)).some((c) => c.slug === DEMO && c.demo === true && c.status === 'searchable'));
    });
  });
});

// ---------------------------------------------------------------------------------------------

// Decrypts an aes128gcm Web Push body (RFC 8291, one record) with the subscriber's keys.
function decryptPush(body, { ecdh, auth }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const sealed = buf.subarray(21 + idlen);
  const uaPublic = ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'the last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

function vapidEnv() {
  const v = createECDH('prime256v1');
  v.generateKeys();
  const d = v.getPrivateKey();
  return { VAPID_PUBLIC_KEY: b64u(v.getPublicKey()), VAPID_PRIVATE_KEY: b64u(Buffer.concat([Buffer.alloc(32 - d.length), d])), VAPID_SUBJECT: 'mailto:operator@example.invalid' };
}

// Two people of one conference whose texts match each other, each with a profile and a push
// subscription. A nudge between them, once both are around in one zone, pushes to both.
async function nudgePeople(ctx, slug) {
  const people = [
    { device: { id: 'a'.repeat(22), secret: 'a'.repeat(43) }, profile: { display_name: 'Ann', interests: 'eBPF tracing for kernel observability', expertise: 'service mesh traffic routing' } },
    { device: { id: 'b'.repeat(22), secret: 'b'.repeat(43) }, profile: { display_name: 'Bob', interests: 'service mesh traffic routing', expertise: 'eBPF tracing for kernel observability' } },
  ];
  for (const p of people) {
    p.ecdh = createECDH('prime256v1');
    p.ecdh.generateKeys();
    p.auth = randomBytes(16);
    p.endpoint = `https://fcm.googleapis.com/fcm/send/${p.profile.display_name}-${newId()}`;
    ok(await api(ctx, 'PUT', '/api/people/profile', { event: slug, profile: p.profile, open_to_meet: true, shared_talk_ids: [] }, p.device));
    ok(await api(ctx, 'PUT', '/api/push/subscription', { event: slug, subscription: { endpoint: p.endpoint, keys: { p256dh: b64u(p.ecdh.getPublicKey()), auth: b64u(p.auth) } } }, p.device));
  }
  await ctx.settle();
  return people;
}

// Replaces fetch (the push service) for fn: every push is recorded and answered 201, after
// hold(push) resolves when hold is given.
async function withPushService(fn, hold = null) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const push = { url: String(url), body: new Uint8Array(await new Response(init?.body).arrayBuffer()) };
    sent.push(push);
    if (hold) await hold(push);
    return new Response(null, { status: 201 });
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// The two people turn presence on in one zone; the second write's nudge pushes to both. Returns
// the decrypted payloads.
async function nudgePair(slug, doc) {
  const ctx = realEnv(vapidEnv());
  await putConferences(ctx, [doc]);
  const people = await nudgePeople(ctx, slug);
  const sent = await withPushService(async (pushes) => {
    for (const p of people) {
      ok(await api(ctx, 'PUT', '/api/presence', { event: slug, zone: 'Hallway', until: 'hour' }, p.device));
      await quietly(() => ctx.settle());
    }
    return pushes;
  });
  return people.map((p) => {
    const mine = sent.filter((s) => s.url === p.endpoint);
    assert.equal(mine.length, 1, `${p.profile.display_name} gets one push`);
    return decryptPush(mine[0].body, p);
  });
}

describe('nudges', { skip }, () => {
  test('a nudge about the demo says Demo in its title and its body; a real conference\'s nudge is unchanged', async () => {
    await withFixedClock(T0, async () => {
      for (const payload of await nudgePair(DEMO, demoConf(DAY))) {
        assert.deepEqual(Object.keys(payload), ['title', 'body', 'data']);
        assert.equal(payload.title, 'Conference Caddie (Demo)');
        assert.match(payload.body, /^Demo: someone who's worked on \S.* is in Hallway right now$/);
        assert.deepEqual(payload.data, { url: `/e/${DEMO}#/people?around=1` });
      }
      for (const payload of await nudgePair(REAL, realConf())) {
        assert.equal(payload.title, 'Conference Caddie');
        assert.match(payload.body, /^Someone who's worked on \S.* is in Hallway right now$/);
        assert.deepEqual(payload.data, { url: `/e/${REAL}#/people?around=1` });
      }
    });
  });

  test('a nudge that was sending when the demo was hidden sends no further push and writes nothing back', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv(vapidEnv());
      await putConferences(ctx, [demoConf(DAY)]);
      const [ann, bob] = await nudgePeople(ctx, DEMO);
      let release = null;
      let holding = false;
      const sent = await withPushService(async (pushes) => {
        ok(await api(ctx, 'PUT', '/api/presence', { event: DEMO, zone: 'Hallway', until: 'hour' }, ann.device));
        await quietly(() => ctx.settle());
        assert.equal(pushes.length, 0, 'nobody else is around yet');
        // Bob's write starts the nudge, whose first push is held at the push service.
        ok(await api(ctx, 'PUT', '/api/presence', { event: DEMO, zone: 'Hallway', until: 'hour' }, bob.device));
        const settled = quietly(() => ctx.settle());
        while (!holding) await new Promise((r) => setImmediate(r));
        assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
        release();
        await settled;
        return pushes;
      }, () => {
        holding = true;
        return new Promise((r) => { release = r; });
      });
      assert.equal(sent.length, 1, 'only the push already sent; the second one of the pair is never started');
      const db = ctx.db(`conference:${DEMO}`);
      for (const t of LIVE) assert.equal(counts(db)[t], 0, `${t}: nothing written back after the cleanup`);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the budgets: the account\'s and the demo\'s own', { skip }, () => {
  const storedUsage = (ctx) => JSON.parse(rows(ctx.db('directory:global'), "SELECT v FROM meta WHERE k = 'usage'")[0].v);

  test('every real conference\'s meter counts the demo\'s load, while GET /admin/stats leaves the demo out', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv({ DAILY_REQUEST_BUDGET: '1000', DEMO_SHARE: '0.5' });
      await putConferences(ctx, [realConf(), realConf(REAL2), demoConf(DAY)]);
      for (const [slug, n] of [[REAL, 2], [REAL2, 3], [DEMO, 40]]) for (let i = 0; i < n; i++) ok(await api(ctx, 'GET', `/api/topics?event=${slug}`));
      // People in REAL and the demo, so both still hold personal data after the cron's visit.
      await populatePeople(ctx.obj(REAL), REAL);
      await populatePeople(ctx.obj(DEMO), DEMO);
      const targets = await (await ctx.env.DIRECTORY.get({ name: 'global' }).fetch('https://directory.internal/internal/cron-targets')).json();
      assert.ok(targets.targets.some((t) => t.slug === DEMO), 'the cron still visits the demo, for its own purge');

      await cron(ctx);
      const first = storedUsage(ctx);
      assert.deepEqual(Object.keys(first.usage).sort(), [DEMO, REAL, REAL2].sort(), 'the demo\'s usage is stored, for the next run\'s others');
      assert.ok(first.usage[DEMO].requests >= 40);
      const paceBefore = ctx.obj(REAL).meter.pace();
      assert.equal(paceBefore, 1);

      const stats = await send(ctx, 'GET', '/admin/stats');
      ok(stats);
      assert.deepEqual(Object.keys(stats.json.usage).sort(), [REAL, REAL2].sort(), 'the shown totals leave the demo out');
      assert.deepEqual(stats.json.holds, { [REAL]: true }, 'the demo, which holds people too, is not among the holds');
      assert.deepEqual(rows(ctx.db('directory:global'), 'SELECT slug FROM conferences WHERE holds = 1 ORDER BY slug').map((r) => r.slug), [DEMO, REAL].sort(), 'the directory still records that the demo holds data, so the cron keeps purging it');

      await cron(ctx);
      const others = (slug) => ctx.obj(slug).meter.others;
      assert.equal(others(REAL).requests, first.usage[REAL2].requests + first.usage[DEMO].requests, 'a real conference counts the demo\'s load');
      assert.equal(others(REAL).rows_written, first.usage[REAL2].rows_written + first.usage[DEMO].rows_written);
      assert.equal(others(DEMO).requests, first.usage[REAL].requests + first.usage[REAL2].requests, 'the demo counts every real conference');
      assert.ok(ctx.obj(REAL).meter.pace() > paceBefore, 'a real conference\'s pace reacts to the demo\'s load');
    });
  });

  test('the demo slows down on its own allotment, then refuses its public writes with 503 daily_limit; a real conference with the same load does not', async () => {
    await withFixedClock(T0, async () => {
      // An allotment of 10 requests (0.1 of 100).
      const ctx = realEnv({ DAILY_REQUEST_BUDGET: '100', DEMO_SHARE: '0.1' });
      await putConferences(ctx, [realConf(), demoConf(DAY)]);
      const device = { id: 'd'.repeat(22), secret: 'd'.repeat(43) };
      const profile = (slug) => ({ event: slug, profile: { display_name: 'Dee', about: 'kernel things' }, open_to_meet: true, shared_talk_ids: [] });
      for (const slug of [DEMO, REAL]) {
        ok(await api(ctx, 'PUT', '/api/people/profile', profile(slug), device));
        for (let i = 0; i < 9; i++) ok(await api(ctx, 'GET', `/api/topics?event=${slug}`));
      }
      const refused = await api(ctx, 'PUT', '/api/people/profile', profile(DEMO), device);
      assert.deepEqual([refused.status, refused.json], [503, { error: 'daily_limit' }]);
      assert.ok(Number(refused.headers.get('retry-after')) > 0, 'until 00:00 UTC');
      assert.equal((await api(ctx, 'POST', '/api/presence/sightings', { event: DEMO, tokens: [] }, device)).status, 503);
      const read = await api(ctx, 'GET', `/api/topics?event=${DEMO}`);
      assert.equal(read.status, 200, 'reads still answer');
      assert.equal(read.headers.get('x-caddie-pace'), '10', 'at the slowest pace');
      assert.equal((await api(ctx, 'DELETE', `/api/people/profile?event=${DEMO}`, undefined, device)).status, 200, 'a person\'s own delete is never refused');

      // The same eleven requests on a real conference: no allotment of its own, so it keeps
      // writing, and its pace is the account-wide one (it has 89 of 100 requests left).
      ok(await api(ctx, 'PUT', '/api/people/profile', profile(REAL), device));
      const real = await api(ctx, 'GET', `/api/topics?event=${REAL}`);
      assert.ok(Number(real.headers.get('x-caddie-pace')) < 10, real.headers.get('x-caddie-pace'));
    });
  });

  test('the meter\'s allotment: the rows-written and rows-read shares stop nudges and the lexical index, DEMO_SHARE is read with its default', () => {
    assert.equal(demoShareOf({}), 0.1);
    for (const [v, want] of [['0.25', 0.25], ['1', 1], ['0', 0.1], ['-1', 0.1], ['2', 0.1], ['x', 0.1], ['', 0.1]]) assert.equal(demoShareOf({ DEMO_SHARE: v }), want, v);
    const state = fakeState();
    const sql = (q, ...b) => state.storage.sql.exec(q, ...b);
    sql('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const env = { DAILY_REQUEST_BUDGET: '1000', ROWS_READ_SOFT_CAP: '1000', ROWS_WRITTEN_SOFT_CAP: '100' };
    const m = new Meter({ sql, exec: sql, env, now: T0 });
    m.setShare(0.1);
    m.addRows(99, 9, T0);
    assert.deepEqual([m.lexicalAllowed(T0), m.writesAllowed(T0), m.allotmentSpent(T0)], [true, true, false]);
    m.addRows(1, 1, T0);
    assert.deepEqual([m.lexicalAllowed(T0), m.writesAllowed(T0), m.allotmentSpent(T0)], [false, false, true], '100 rows read and 10 written: the shares are used up');
    m.setShare(null);
    assert.deepEqual([m.lexicalAllowed(T0), m.writesAllowed(T0), m.allotmentSpent(T0)], [true, true, false], 'without a share only the account-wide caps apply');
    for (const bad of [0, -0.5, 1.5, Number.NaN]) {
      m.setShare(bad);
      assert.equal(m.share, null, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('the daily refresh', { skip }, () => {
  test('push-ingest takes the demo files as they are: null urls, source demo and demo: true', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      const admin = adminVia(ctx);
      const conf = demoConf(DAY);
      assert.deepEqual(await upsertConferences(admin, [conf], { log: () => {} }), []);
      const stored = JSON.parse(rows(ctx.db('directory:global'), 'SELECT doc FROM conferences WHERE slug = ?', DEMO)[0].doc);
      assert.deepEqual(stored, conf, 'the directory stores the document as it is');
      const { docs } = buildDemo(ON, DAY);
      const line = await quietly(() => pushEvent(conf, workerTalks(DEMO, docs, []), { admin, dryRun: false, generation: 1, rebuild: false, stop: loadStoplist() }));
      assert.match(line, new RegExp(`^${DEMO}: ${docs.length} talks .* deleted 0, unshared 0;`));
      const talks = rows(ctx.db(`conference:${DEMO}`), 'SELECT talk_id, url, slides_url, start FROM talks ORDER BY talk_id');
      assert.equal(talks.length, docs.length);
      assert.ok(talks.every((t) => t.url === null && t.slides_url === null));
      assert.equal(ctx.obj(DEMO).conf.doc.demo, true);
      assert.equal(ctx.obj(DEMO).conf.doc.source, 'demo');
    });
  });

  test('day D then D+1: the same talk ids with new times, finalize deletes nothing, unshares nothing, deletes no profile and is not refused', async () => {
    await withFixedClock(T0, async (at) => {
      const ctx = realEnv();
      const log = [];
      const admin = adminVia(ctx, log);
      const stop = loadStoplist();
      const day0 = buildDemo(ON, DAY);
      await upsertConferences(admin, [demoConf(DAY)], { log: () => {} });
      await quietly(() => pushEvent(demoConf(DAY), workerTalks(DEMO, day0.docs, []), { admin, dryRun: false, generation: 1000, rebuild: false, stop }));
      const db = ctx.db(`conference:${DEMO}`);
      const o = ctx.obj(DEMO);
      // Someone who only shares talks (not open to meet), whom a dropped talk would delete, and
      // someone open to meet who shares one.
      const now = Date.now();
      const sharer = await o.store.insertPerson({ profile_id: newId(), secret_hash: sha('s1'), display_name: 'Sharer', open_to_meet: false, visible_until_ms: now + 48 * HOUR, shared_talk_ids: [`${DEMO}:d1-a10`, `${DEMO}:d0-b07`] });
      const open = await o.store.insertPerson({ profile_id: newId(), secret_hash: sha('s2'), display_name: 'Open', open_to_meet: true, visible_until_ms: now + 48 * HOUR, shared_talk_ids: [`${DEMO}:d2-w1`] });
      const sharesBefore = rows(db, 'SELECT profile_id, talk_id FROM shared_talks ORDER BY profile_id, talk_id');
      assert.equal(sharesBefore.length, 3);
      const topicsBefore = rows(db, 'SELECT topic_id FROM topics ORDER BY topic_id');
      const idsBefore = rows(db, 'SELECT talk_id FROM talks ORDER BY talk_id').map((r) => r.talk_id);

      at(T0 + 24 * HOUR);
      const day1 = buildDemo(ON, NEXT);
      assert.deepEqual(day1.docs.map((d) => d.talk_id).sort(), day0.docs.map((d) => d.talk_id).sort(), 'the generator keeps the ids');
      log.length = 0;
      await upsertConferences(admin, [demoConf(NEXT)], { log: () => {} });
      await quietly(() => pushEvent(demoConf(NEXT), workerTalks(DEMO, day1.docs, []), { admin, dryRun: false, generation: 2000, rebuild: false, stop }));

      const finalize = log.find((e) => e.path === '/admin/talks/finalize');
      assert.equal(finalize.status, 200, 'FINALIZE_MAX_DELETE does not refuse it, without allow_shrink');
      assert.deepEqual(finalize.json, { talks: day1.docs.length, deleted: 0, unshared: 0, profiles_deleted: 0 });
      const batches = log.filter((e) => e.path === '/admin/talks');
      assert.equal(batches.reduce((n, e) => n + e.json.embedded, 0), 0, 'nothing is re-embedded');
      assert.equal(batches.reduce((n, e) => n + e.json.upserted + e.json.unchanged, 0), day1.docs.length);
      assert.ok(batches.reduce((n, e) => n + e.json.upserted, 0) > 0, 'the times moved');

      assert.deepEqual(rows(db, 'SELECT talk_id FROM talks ORDER BY talk_id').map((r) => r.talk_id), idsBefore);
      const starts = new Map(rows(db, 'SELECT talk_id, start FROM talks').map((r) => [r.talk_id, r.start]));
      for (const d of day1.docs) assert.equal(starts.get(d.talk_id), d.start, d.talk_id);
      assert.deepEqual(rows(db, 'SELECT profile_id, talk_id FROM shared_talks ORDER BY profile_id, talk_id'), sharesBefore, 'no shared talk is unshared');
      assert.deepEqual(rows(db, 'SELECT profile_id FROM people ORDER BY profile_id').map((r) => r.profile_id), [sharer.profile_id, open.profile_id].sort(), 'no profile is deleted');
      assert.deepEqual(rows(db, 'SELECT topic_id FROM topics ORDER BY topic_id'), topicsBefore, 'the stored topics are kept (frozen)');
      assert.equal(o.conf.end_date, '2026-11-14');
      assert.ok((await listed(ctx)).some((c) => c.slug === DEMO && c.start_date === DAY && c.end_date === '2026-11-14'));
    });
  });
});

const PUSH_INGEST = fileURLToPath(new URL('../ingest/push-ingest.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

// A loopback HTTP server in front of the Worker of ctx, for push-ingest.mjs run as a child process.
// before(request), when given, runs first and may answer instead (a Response) or let it through
// (null). Every request's method and path is recorded.
async function bridge(ctx, before = null) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const k of ['content-type', 'x-caddie-admin', 'cf-access-client-id', 'cf-access-client-secret']) if (req.headers[k]) headers[k] = req.headers[k];
      const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers, body: body.length ? body : undefined });
      seen.push(`${req.method} ${new URL(request.url).pathname}`);
      const answer = (before && (await before(request))) || (await quietly(() => worker.fetch(request, ctx.env)));
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

// push-ingest.mjs --events-from <report> --refresh-only, as the worker job runs it, in a child
// process with a temporary data folder holding the demo's files for DAY. Its environment is built
// here: the fixture's fake key, no inherited variable, and GITHUB_ACTIONS for the notices.
async function runRefresh(api) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-demo-push-'));
  try {
    const { conference, docs } = buildDemo(ON, DAY);
    mkdirSync(join(dir, 'data', DEMO), { recursive: true });
    writeFileSync(join(dir, 'data', DEMO, 'conference.json'), JSON.stringify({ ...conference, raw_fetched_at: `${DAY}T06:00:00.000Z` }));
    writeFileSync(join(dir, 'data', DEMO, 'talks.ndjson'), `${docs.map((d) => JSON.stringify(d)).join('\n')}\n`);
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ processed: [DEMO] }));
    const child = spawn(process.execPath, [PUSH_INGEST, '--api', api, '--events-from', join(dir, 'report.json'), '--refresh-only'], {
      cwd: REPO,
      env: { PATH: process.env.PATH, HOME: dir, ADMIN_TOKEN: KEY, CADDIE_DATA_DIR: join(dir, 'data'), GITHUB_ACTIONS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { code, out, err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('--refresh-only', { skip }, () => {
  const fetchVia = (ctx) => (url, init) => quietly(() => worker.fetch(new Request(url, init), ctx.env));

  test('a demo hidden between the list check and the write is not written: it is reported as changed and stays hidden', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const admin = adminVia(ctx);
      const { push } = refreshOnly([demoConf(NEXT)], await listedSearchable(BASE, fetchVia(ctx)));
      assert.equal(push.length, 1, 'listed as searchable when the list was read');
      await putConferences(ctx, [hiddenDemo()]);
      const notes = [];
      assert.deepEqual(await upsertRefreshing(admin, push, { log: () => {}, note: (m) => notes.push(m) }), { upserted: 0, changed: [DEMO], skipped: [] });
      assert.deepEqual(notes, [`${DEMO}: skipped, it changed on the Worker during this run and is no longer listed as searchable, so nothing of it was pushed.`]);
      const row = rows(ctx.db('directory:global'), 'SELECT status, doc FROM conferences WHERE slug = ?', DEMO)[0];
      assert.equal(row.status, 'unavailable');
      assert.equal(JSON.parse(row.doc).status_reason, 'operator_hidden', 'the hidden document is untouched');
      assert.equal(ctx.obj(DEMO).conf.status, 'unavailable');
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO));
      // Still searchable, it is written, and the stored document never keeps expect_status.
      await putConferences(ctx, [demoConf(DAY)]);
      assert.deepEqual(await upsertRefreshing(admin, [demoConf(NEXT)], { log: () => {}, note: () => assert.fail('no notice') }), { upserted: 1, changed: [], skipped: [] });
      const stored = JSON.parse(rows(ctx.db('directory:global'), 'SELECT doc FROM conferences WHERE slug = ?', DEMO)[0].doc);
      assert.equal(stored.end_date, '2026-11-14');
      assert.ok(!('expect_status' in stored));
    });
  });

  test('push-ingest main(): never added, a notice and exit 0; listed, the push; hidden during the run, a notice, exit 0 and no talks; an unreadable list, exit 2 and nothing sent', async () => {
    const ctx = realEnv();
    // Never added.
    let b = await bridge(ctx);
    let r = await runRefresh(b.api).finally(() => b.close());
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^::notice::${DEMO}: skipped, the Worker does not list it as searchable \\(never added, hidden or removed\\), and --refresh-only never adds or shows a conference; caddie-admin conferences add, unhide or unretire is the operator's step\\.$`, 'm'));
    assert.match(r.out, /^Nothing to refresh\.$/m);
    assert.deepEqual(b.seen, ['GET /api/conferences'], 'no admin request');
    assert.equal(rows(ctx.db('directory:global'), 'SELECT slug FROM conferences').length, 0);

    // Listed as searchable: pushed.
    await putConferences(ctx, [demoConf(DAY, { end_date: '2026-11-13' })]);
    b = await bridge(ctx);
    r = await runRefresh(b.api).finally(() => b.close());
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /Events pushed: 1, failed: 0/);
    assert.equal(rows(ctx.db(`conference:${DEMO}`), 'SELECT COUNT(*) AS n FROM talks')[0].n, buildDemo(ON, DAY).docs.length);
    assert.equal(b.seen.filter((x) => x === 'PUT /admin/conferences').length, 1);

    // Hidden by the operator while the run goes on: after the list was read, before the write.
    let hidden = false;
    b = await bridge(ctx, async (request) => {
      if (!hidden && request.method === 'PUT' && new URL(request.url).pathname === '/admin/conferences') {
        hidden = true;
        await putConferences(ctx, [hiddenDemo()]);
      }
      return null;
    });
    const talksBefore = rows(ctx.db(`conference:${DEMO}`), 'SELECT talk_id, generation FROM talks ORDER BY talk_id');
    r = await runRefresh(b.api).finally(() => b.close());
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, new RegExp(`^::notice::${DEMO}: skipped, it changed on the Worker during this run and is no longer listed as searchable, so nothing of it was pushed\\.$`, 'm'));
    assert.match(r.out, /Events pushed: 0, failed: 0/);
    assert.ok(!b.seen.some((x) => x.startsWith('POST /admin/talks')), 'no talk is pushed');
    assert.deepEqual(rows(ctx.db(`conference:${DEMO}`), 'SELECT talk_id, generation FROM talks ORDER BY talk_id'), talksBefore);
    assert.equal(ctx.obj(DEMO).conf.status, 'unavailable', 'it stays hidden');

    // The list cannot be read: nothing is sent and the run fails.
    await putConferences(ctx, [demoConf(DAY)]);
    b = await bridge(ctx, async (request) => (new URL(request.url).pathname === '/api/conferences' ? new Response('{}', { status: 500 }) : null));
    r = await runRefresh(b.api).finally(() => b.close());
    assert.equal(r.code, 2, r.out);
    assert.match(r.err, /--refresh-only: GET \/api\/conferences could not be read, so nothing was pushed\./);
    assert.ok(!b.seen.some((x) => x.includes('/admin/')), 'no admin request');
  });

  test('the demo is pushed only while the Worker lists it as searchable: never added, hidden and removed are skipped', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      const conf = demoConf(DAY);
      const plan = async () => refreshOnly([conf], await listedSearchable(BASE, fetchVia(ctx)));
      assert.deepEqual(await plan(), { push: [], skipped: [DEMO] }, 'never added');
      await putConferences(ctx, [realConf(), demoConf(DAY)]);
      assert.deepEqual(await listedSearchable(BASE, fetchVia(ctx)), new Set([REAL, DEMO]));
      assert.deepEqual(await plan(), { push: [conf], skipped: [] }, 'listed as searchable');
      await putConferences(ctx, [hiddenDemo()]);
      assert.deepEqual(await plan(), { push: [], skipped: [DEMO] }, 'hidden');
      await putConferences(ctx, [demoConf(DAY)]);
      ok(await send(ctx, 'DELETE', `/admin/conference?event=${DEMO}`));
      assert.deepEqual(await plan(), { push: [], skipped: [DEMO] }, 'removed');
      // A real conference the Worker lists as unavailable is skipped too.
      await putConferences(ctx, [realConf(REAL, { status: 'unavailable', status_reason: 'operator_hidden' })]);
      assert.deepEqual(refreshOnly([realConf()], await listedSearchable(BASE, fetchVia(ctx))).skipped, [REAL]);
    });
  });

  test('a list that cannot be read pushes nothing: listedSearchable is null and refreshOnly throws', async () => {
    const answers = [
      () => new Response('{}', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ conferences: 'no' }), { status: 200 }),
      () => new Response(JSON.stringify({ conferences: [] }), { status: 301, headers: { Location: 'https://elsewhere.example/' } }),
      () => { throw new TypeError('fetch failed'); },
    ];
    for (const answer of answers) assert.equal(await listedSearchable(BASE, async () => answer()), null);
    assert.throws(() => refreshOnly([demoConf(DAY)], null), /could not be read, so nothing was pushed/);
    // Only well-formed slugs are taken from the list.
    const odd = await listedSearchable(BASE, async () => new Response(JSON.stringify({ conferences: [{ slug: 'Bad Slug', status: 'searchable' }, { slug: DEMO, status: 'searchable' }, { slug: REAL, status: 'unavailable' }] }), { status: 200 }));
    assert.deepEqual(odd, new Set([DEMO]));
  });
});

describe('the demo grace', { skip }, () => {
  test('the demo\'s profiles and push subscriptions last DEMO_GRACE_DAYS past its last day; a real conference\'s do not', async () => {
    await withFixedClock(T0, async () => {
      assert.equal(DEMO_GRACE_DAYS, 7);
      const ctx = realEnv();
      await putConferences(ctx, [realConf(), demoConf(DAY)]);
      // 23:59:59 on 2026-11-20 in America/Denver (UTC-7): the last day, 2026-11-13, plus seven days.
      const graceEnd = Date.parse('2026-11-21T06:59:59Z');
      assert.equal(ctx.obj(DEMO).conf.visible_until_ms, graceEnd);
      assert.equal(conferenceVisibleUntilMs(demoConf(DAY)), graceEnd);
      assert.equal(ctx.obj(REAL).conf.visible_until_ms, Date.parse('2026-11-14T23:59:59Z'), 'a real conference ends at its last day');
      assert.equal(conferenceVisibleUntilMs({ ...demoConf(DAY), demo: undefined }), visibleUntilMs('2026-11-13', 'America/Denver'));
      // Across a month's end.
      assert.equal(conferenceVisibleUntilMs({ end_date: '2026-11-28', time_zone: 'UTC', demo: true }), Date.parse('2026-12-05T23:59:59Z'));

      for (const [slug, end] of [[DEMO, graceEnd], [REAL, Date.parse('2026-11-14T23:59:59Z')]]) {
        const device = { id: 'g'.repeat(22), secret: 'g'.repeat(43) };
        ok(await api(ctx, 'PUT', '/api/people/profile', { event: slug, profile: { display_name: 'Gus', about: 'kernel things' }, open_to_meet: true, shared_talk_ids: [] }, device));
        const ecdh = createECDH('prime256v1');
        ecdh.generateKeys();
        ok(await api(ctx, 'PUT', '/api/push/subscription', { event: slug, subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${newId()}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } } }, device));
        const db = ctx.db(`conference:${slug}`);
        assert.deepEqual(rows(db, 'SELECT visible_until_ms FROM people'), [{ visible_until_ms: end }], slug);
        assert.deepEqual(rows(db, 'SELECT expires_at_ms FROM push_subs'), [{ expires_at_ms: end }], slug);
      }
      // The cron's purge keeps the demo's profile past its last day, until the grace ends.
      await quietly(async () => {
        const purge = (at) => ctx.obj(DEMO).store.purge(at);
        assert.equal(purge(Date.parse('2026-11-15T12:00:00Z')).people, 0);
        assert.equal(purge(graceEnd + 1000).people, 1);
      });
      await ctx.settle();
    });
  });

  test('tier 3 and the Worker give the demo the same grace', () => {
    assert.equal(DEMO_GRACE_DAYS, TIER3_DEMO_GRACE_DAYS);
  });
});

// ---------------------------------------------------------------------------------------------

describe('switching the demo off', { skip }, () => {
  test('a hidden demo deletes its presence, Bluetooth session, positions, caps, meets, nudges and nudge sends, keeps its profiles, and leaves the list', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      await putConferences(ctx, [realConf(), demoConf(DAY)]);
      const o = ctx.obj(DEMO);
      const { a } = await populatePeople(o, DEMO);
      await populatePeople(ctx.obj(REAL), REAL);
      const db = ctx.db(`conference:${DEMO}`);
      const before = counts(db);
      for (const t of [...LIVE, ...KEPT]) assert.ok(before[t] > 0, `the setup put no row in ${t}`);
      const realBefore = counts(ctx.db(`conference:${REAL}`));
      const store = o.store;
      const wipes = o.wipes;

      assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
      const after = counts(db);
      for (const t of LIVE) assert.equal(after[t], 0, `${t} after the hide`);
      for (const t of KEPT) assert.equal(after[t], before[t], `${t} is kept`);
      assert.equal(after.talks, before.talks, 'the talks are kept');
      assert.equal(o.conf.status, 'unavailable');
      assert.equal(o.store.locations.size, 0, 'no position is held');
      assert.equal(o.store.person(a.profile_id).presence, null, 'the person is not around');
      // A request that was waiting on an await cannot write back or read a cached person.
      assert.notEqual(o.store, store);
      assert.equal(store.closed, true);
      assert.equal(o.wipes, wipes + 1);
      assert.throws(() => store.sql('SELECT 1'), (err) => err.status === 400);

      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO), 'gone from GET /api/conferences');
      const write = await api(ctx, 'PUT', '/api/presence', { event: DEMO, zone: 'Hallway', until: 'hour' }, { id: 'c'.repeat(22), secret: 'c'.repeat(43) });
      assert.deepEqual([write.status, write.json], [400, { error: 'conference is not available' }]);
      assert.deepEqual(counts(ctx.db(`conference:${REAL}`)), realBefore, 'the real conference is untouched');

      // Sent again (a repeated hide): nothing left, no error.
      assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
      assert.deepEqual(counts(db), after);
      // Shown again: the profiles are there, nobody is around.
      await putConferences(ctx, [demoConf(DAY)]);
      assert.equal(o.conf.status, 'searchable');
      assert.equal(counts(db).people, before.people);
      assert.equal(counts(db).presence, 0);
    });
  });

  test('a fan-out that arrives after a later one is ignored: the hidden demo stays hidden (doc_seq)', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const o = ctx.obj(DEMO);
      await populatePeople(o, DEMO);
      // Holds the next fan-out of a document to the demo's object until released.
      const ns = ctx.env.CONFERENCE;
      const get = ns.get;
      let release = null;
      ns.get = (id) => {
        const stub = get(id);
        return {
          fetch: async (url, init) => {
            if (!release && new URL(url).pathname === '/internal/conference') await new Promise((r) => { release = r; });
            return stub.fetch(url, init);
          },
        };
      };
      const earlier = send(ctx, 'PUT', '/admin/conferences', { conferences: [demoConf(NEXT)] });
      while (!release) await new Promise((r) => setImmediate(r));
      ns.get = get;
      assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
      assert.equal(o.conf.status, 'unavailable');
      release();
      assert.deepEqual((await earlier).json, { upserted: 1, searchable: 1, synced: 1, skipped_retired: [] });
      assert.equal(o.conf.status, 'unavailable', 'the earlier, searchable document arrived last and was ignored');
      assert.equal(o.conf.end_date, '2026-11-13', 'the hidden document is the one held');
      for (const t of LIVE) assert.equal(counts(ctx.db(`conference:${DEMO}`))[t], 0, t);
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO));
      const dirSeq = rows(ctx.db('directory:global'), 'SELECT doc_seq FROM conferences WHERE slug = ?', DEMO)[0].doc_seq;
      assert.equal(Number(rows(ctx.db(`conference:${DEMO}`), "SELECT v FROM meta WHERE k = 'doc_seq'")[0].v), dirSeq, 'the object holds the number of the directory\'s last write');
    });
  });

  test('the object takes a document only when it is not older than the last one; without a number, as before', async () => {
    const o = new ConferenceDO(fakeState(), { EMBED_FAKE: '1' });
    const put = async (doc, docSeq) => {
      const res = await o.fetch(new Request('https://do.internal/internal/conference', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-caddie-slug': DEMO },
        body: JSON.stringify({ doc, route_prefix: 'abcdef', ...(docSeq === undefined ? {} : { doc_seq: docSeq }) }),
      }));
      return [res.status, await res.json()];
    };
    assert.deepEqual(await put(demoConf(DAY), 5), [200, { ok: true }]);
    assert.deepEqual(await put(hiddenDemo(), 3), [200, { ok: true }]);
    assert.equal(o.conf.status, 'searchable', 'number 3 is older than 5: ignored');
    assert.deepEqual(await put(hiddenDemo(), 5), [200, { ok: true }]);
    assert.equal(o.conf.status, 'unavailable', 'the same number again is applied');
    assert.deepEqual(await put(demoConf(DAY)), [200, { ok: true }]);
    assert.equal(o.conf.status, 'searchable', 'a fan-out without the number is applied');
    for (const bad of [0, -1, 1.5, '6']) assert.deepEqual(await put(demoConf(DAY), bad), [400, { error: 'doc_seq must be a positive integer' }]);
  });

  test('a cleanup that fails still leaves no old Store open, and the next hide finishes it', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const o = ctx.obj(DEMO);
      await populatePeople(o, DEMO);
      const store = o.store;
      const wipes = o.wipes;
      const proto = Object.getPrototypeOf(store);
      const clear = proto.clearLiveActivity;
      proto.clearLiveActivity = () => {
        throw new Error('the delete failed');
      };
      try {
        assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 0, skipped_retired: [] });
      } finally {
        proto.clearLiveActivity = clear;
      }
      assert.equal(store.closed, true, 'the old Store is closed before the delete runs');
      assert.notEqual(o.store, store);
      assert.equal(o.wipes, wipes + 1);
      assert.ok(counts(ctx.db(`conference:${DEMO}`)).presence > 0, 'the failed delete left the rows');
      assert.deepEqual(await putConferences(ctx, [hiddenDemo()]), { upserted: 1, searchable: 0, synced: 1, skipped_retired: [] });
      for (const t of LIVE) assert.equal(counts(ctx.db(`conference:${DEMO}`))[t], 0, `${t} after the repeated hide`);
    });
  });

  test('a real conference\'s hide keeps all of its data', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      await putConferences(ctx, [realConf()]);
      const o = ctx.obj(REAL);
      await populatePeople(o, REAL);
      const db = ctx.db(`conference:${REAL}`);
      const before = counts(db);
      const store = o.store;
      await putConferences(ctx, [realConf(REAL, { status: 'unavailable', status_reason: 'operator_hidden' })]);
      assert.deepEqual(counts(db), before);
      assert.equal(o.store, store);
      assert.equal(o.store.locations.size, 1, 'the position is kept until it runs out');
      assert.ok((await listed(ctx)).some((c) => c.slug === REAL && c.status === 'unavailable' && !('demo' in c)), 'a hidden real conference stays listed as unavailable');
    });
  });

  test('a removed demo leaves no row in any table but the nonces and the kept meta rows', async () => {
    await withFixedClock(T0, async () => {
      const ctx = realEnv();
      const admin = adminVia(ctx);
      await upsertConferences(admin, [demoConf(DAY)], { log: () => {} });
      await quietly(() => pushEvent(demoConf(DAY), workerTalks(DEMO, buildDemo(ON, DAY).docs, []), { admin, dryRun: false, generation: 1, rebuild: false, stop: loadStoplist() }));
      await populatePeople(ctx.obj(DEMO), DEMO);
      ok(await send(ctx, 'GET', `/admin/stats?event=${DEMO}`)); // the meter writes usage_days
      const db = ctx.db(`conference:${DEMO}`);
      for (const [t, n] of Object.entries(counts(db))) assert.ok(n > 0, `the setup put no row in ${t}`);
      const r = await send(ctx, 'DELETE', `/admin/conference?event=${DEMO}`);
      ok(r);
      assert.equal(r.json.directory, 1);
      for (const [t, n] of Object.entries(counts(db))) {
        if (t === 'admin_nonces') continue;
        assert.equal(n, t === 'meta' ? 3 : 0, `${t} after the removal`);
      }
      assert.deepEqual(rows(db, 'SELECT k FROM meta ORDER BY k').map((x) => x.k), ['retired_at', 'schema_version', 'wipe_seq']);
      assert.deepEqual(rows(ctx.db('directory:global'), 'SELECT slug FROM conferences'), []);
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO));
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the tier 2 CLI and a demo the Worker does not list', { skip }, () => {
  const adapterFor = (ctx) => createWorkerAdapter({ name: 't2', tier: 2, api: BASE }, {
    credential: KEY,
    env: {},
    fetch: (url, init) => quietly(() => worker.fetch(new Request(url, init), ctx.env)),
  });

  // The CLI signs with the real clock, so these tests do not fix it; the Worker does not read the
  // demo's dates for these routes.
  test('list marks the demo; hide, a repeated hide and unhide reach the hidden demo; a slug the Worker does not hold is still not found', async () => {
    {
      const ctx = realEnv();
      await putConferences(ctx, [realConf(), demoConf(DAY)]);
      const adapter = adapterFor(ctx);
      const all = await adapter.listConferences({ options: { all: true } });
      assert.deepEqual(all.items.find((c) => c.slug === DEMO), { slug: DEMO, name: ON.name, start_date: '2026-11-11', end_date: '2026-11-13', status: 'searchable', talks: buildDemo(ON, DAY).counts.talk, demo: true });
      assert.ok(!('demo' in all.items.find((c) => c.slug === REAL)));

      const first = await adapter.hideConference({ event: DEMO, slug: DEMO, mode: 'run', doc: hiddenDemo() });
      assert.match(first.summary, /was searchable; 1 object synced/);
      const again = await adapter.hideConference({ event: DEMO, slug: DEMO, mode: 'run', doc: hiddenDemo() });
      assert.match(again.summary, /was unavailable; 1 object synced/);
      assert.ok(!(await adapter.listConferences({ options: { all: true } })).items.some((c) => c.slug === DEMO));
      await adapter.unhideConference({ event: DEMO, slug: DEMO, mode: 'run', doc: demoConf(DAY) });
      assert.ok((await listed(ctx)).some((c) => c.slug === DEMO && c.status === 'searchable'));

      const unknown = 'nowhere-demo-conference';
      await assert.rejects(adapter.hideConference({ event: unknown, slug: unknown, mode: 'run', doc: { ...hiddenDemo(), slug: unknown } }), NotFoundError);
      await assert.rejects(adapter.hideConference({ event: REAL2, slug: REAL2, mode: 'run', doc: realConf(REAL2, { status: 'unavailable' }) }), NotFoundError);
    }
  });

  test('conferences hide, hide again and unhide of the demo from a clone without its data folder, after the switch is off', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'caddie-demo-tier2-'));
    const configFile = join(tmp, 'demo-config.json');
    writeFileSync(configFile, JSON.stringify({ enabled: false }));
    const saved = { config: process.env.CADDIE_DEMO_CONFIG, today: process.env.CADDIE_DEMO_TODAY };
    process.env.CADDIE_DEMO_CONFIG = configFile;
    process.env.CADDIE_DEMO_TODAY = DAY;
    try {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const o = ctx.obj(DEMO);
      await populatePeople(o, DEMO);
      // The command layer over the tier 2 adapter, as caddie-admin runs it: hide and unhide take the
      // generator's document for the demo's slug, which carries demo: true.
      const cli = withConferenceFiles(adapterFor(ctx), { root: tmp, tier: 2 });
      const hidden = await cli.hideConference({ event: DEMO, slug: DEMO, reason: 'other', mode: 'run' });
      assert.match(hidden.summary, /was searchable; 1 object synced/);
      assert.deepEqual(hidden.files, ['data/conference-operator.json'], 'only the operator file is to be committed');
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO));
      for (const t of LIVE) assert.equal(counts(ctx.db(`conference:${DEMO}`))[t], 0, t);
      const again = await cli.hideConference({ event: DEMO, slug: DEMO, reason: 'other', mode: 'run' });
      assert.match(again.summary, /was unavailable; 1 object synced/);
      const shown = await cli.unhideConference({ event: DEMO, slug: DEMO, mode: 'run' });
      assert.match(shown.summary, /restored searchable/);
      assert.ok((await listed(ctx)).some((c) => c.slug === DEMO && c.status === 'searchable' && c.demo === true));
      assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'data/conference-operator.json'), 'utf8')).hidden, {});
    } finally {
      for (const [k, v] of [['CADDIE_DEMO_CONFIG', saved.config], ['CADDIE_DEMO_TODAY', saved.today]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('conferences unretire of the demo from a clone without its data folder sends the generator\'s document, unavailable and operator_removed, on both tiers', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'caddie-demo-unretire-'));
    const configFile = join(tmp, 'demo-config.json');
    writeFileSync(configFile, JSON.stringify({ enabled: false }));
    const saved = { config: process.env.CADDIE_DEMO_CONFIG, today: process.env.CADDIE_DEMO_TODAY };
    process.env.CADDIE_DEMO_CONFIG = configFile;
    process.env.CADDIE_DEMO_TODAY = DAY;
    try {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const cli = withConferenceFiles(adapterFor(ctx), { root: tmp, tier: 2 });
      await cli.removeConference({ event: DEMO, slug: DEMO, reason: 'other', mode: 'run', options: {} });
      assert.deepEqual(rows(ctx.db('directory:global'), 'SELECT slug FROM conferences'), []);
      const back = await cli.unretireConference({ event: DEMO, slug: DEMO, mode: 'run' });
      assert.match(back.summary, /sent unavailable \(operator_removed\) \(Worker was not listed\) with unretire: true and expect_status: null/);
      const row = rows(ctx.db('directory:global'), 'SELECT status, doc FROM conferences WHERE slug = ?', DEMO)[0];
      const doc = JSON.parse(row.doc);
      assert.deepEqual([row.status, doc.demo, doc.status_reason, doc.start_date], ['unavailable', true, 'operator_removed', '2026-11-11']);
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO), 'back, but not listed until a refresh');
      assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'data/conference-operator.json'), 'utf8')).removed, {});
      // A repeat (the repair after a lost answer) expects the hidden row, not no row.
      const again = await cli.unretireConference({ event: DEMO, slug: DEMO, mode: 'run' });
      assert.match(again.summary, /expect_status: "unavailable"/);

      // Tier 3: the same document reaches the adapter, which ignores it.
      writeFileSync(join(tmp, 'data/conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [DEMO]: { since: '2026-11-12T00:00:00Z' } } }));
      let seen = null;
      const tier3 = withConferenceFiles({ unretireConference: async (args) => { seen = args; return { backend: 'none', summary: 'nothing to do on tier 3' }; } }, { root: tmp, tier: 3 });
      await tier3.unretireConference({ event: DEMO, slug: DEMO, mode: 'run' });
      assert.deepEqual([seen.doc.slug, seen.doc.demo, seen.doc.status, seen.doc.status_reason], [DEMO, true, 'unavailable', 'operator_removed']);
    } finally {
      for (const [k, v] of [['CADDIE_DEMO_CONFIG', saved.config], ['CADDIE_DEMO_TODAY', saved.today]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unretire expects the row of a removed demo that is back but hidden, rather than no row', async () => {
    {
      const ctx = realEnv();
      await putConferences(ctx, [demoConf(DAY)]);
      const adapter = adapterFor(ctx);
      await adapter.removeConference({ event: DEMO, slug: DEMO, mode: 'run', options: {} });
      const retired = demoConf(DAY, { status: 'unavailable', status_reason: 'operator_removed' });
      // No row: expects null.
      const firstUnretire = await adapter.unretireConference({ event: DEMO, slug: DEMO, mode: 'run', doc: retired });
      assert.match(firstUnretire.summary, /expect_status: null/);
      // The row is back, unavailable, and not listed: the repeat expects "unavailable" and applies.
      assert.ok(!(await listed(ctx)).some((c) => c.slug === DEMO));
      const repeat = await adapter.unretireConference({ event: DEMO, slug: DEMO, mode: 'run', doc: retired });
      assert.match(repeat.summary, /expect_status: "unavailable"/);
    }
  });
});
