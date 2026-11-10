// Bluetooth derived tokens v1 on the tier 3 server (server/ble.mjs, docs/contracts/ble-tokens.md),
// with the master keyring configured: the key issued with a presence write, parity with the golden
// vectors, resolution of the windows w - 1, w and w + 1, the store check, co-location, the caps on
// the final answer, ble_rekey, the per-instance token table, and the legacy tokens of the old APK
// resolving under the same mitigations.
//
// Run with `npm test`. The server talks to the in-memory stand-in of test/lib/fake-es.mjs through a
// stubbed fetch, with its clock set to the request time of contracts/fixtures/ble and moved forward
// by the tests; nothing reaches the network. The masters are the fake fixed ones of
// contracts/fixtures/ble/resolution-cases.v1.json.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fake, EVENT, FUTURE, newDevice, hashOf, request, profileBody, advanceClock, json } from './lib/fake-es.mjs';
import * as B from '../contracts/js/ble-token.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import { formatErrors } from '../contracts/js/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = (f) => JSON.parse(readFileSync(path.join(ROOT, 'contracts/fixtures/ble', f), 'utf8'));
const cases = fixtures('resolution-cases.v1.json');
const golden = fixtures('golden-vectors.v1.json');
const MASTERS = new Map(Object.entries(cases.masters).map(([id, hex]) => [id, Buffer.from(hex, 'hex')]));
assert.equal(MASTERS.get('m1').toString('base64url'), golden.key_derivation.master_secret.base64url);

process.env.BLE_MASTER_KEYRING = JSON.stringify({ current: 'm1', keys: Object.fromEntries([...MASTERS].map(([id, b]) => [id, b.toString('base64url')])) });
for (const k of ['BLE_NEAR_RSSI', 'TALKS_BUNDLE_BASE', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'REF_SALT']) delete process.env[k];

// The server's clock: the fixtures' request time, 2026-11-10T12:05:00Z, halfway through a window.
const at = (unixSeconds) => advanceClock(unixSeconds * 1000 - Date.now());
const T_FIXTURE = Number(cases.cases[0].server_unix_seconds);
at(T_FIXTURE);

const { handlePeopleApi } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');
const { handleBleApi } = await import('../server/ble.mjs');
const { CAPABILITIES } = await import('../server/capabilities.mjs');
const { refFor } = await import('../server/device.mjs');

fake.reset();

const iso = (ms) => new Date(ms).toISOString();
const PEOPLE = 'caddie-people';
// A profile_id in the device format the server accepts (16 bytes, 22 base64url characters), named
// after a readable label so that each test's people are distinct.
const pid = (label) => crypto.createHash('sha256').update(label, 'utf8').digest().subarray(0, 16).toString('base64url');
// A legacy server-minted token (16 bytes) that the store holds for one person.
const LEGACY_CELL_TOKEN = Buffer.from('legacy-cell-tok1').toString('base64url');
const devices = new Map(); // profile_id -> device
const deviceFor = (profileId) => {
  if (!devices.has(profileId)) devices.set(profileId, { profileId, secret: newDevice().secret });
  return devices.get(profileId);
};
const docOf = (profileId) => fake.doc(PEOPLE, `${EVENT}:${profileId}`);
const ref = (profileId) => refFor(EVENT, profileId);

// A live, visible people document that is around, put straight into the store, as the server
// writes one. Everyone speaks to eBPF and the requesters want to learn about it, a topic too rare
// to be broad, so every resolved person is a strong match.
function person(profileId, fields = {}) {
  const now = Date.now();
  fake.put(PEOPLE, `${EVENT}:${profileId}`, {
    event_id: EVENT, profile_id: profileId, ref: ref(profileId), secret_hash: hashOf(deviceFor(profileId).secret),
    display_name: `Person ${profileId.slice(0, 6)}`, about: '', interests: '', expertise: '', sample: false,
    learn_topics: ['ebpf'], speak_topics: ['ebpf'], open_to_meet: true, shared_talk_ids: [], visible_until: FUTURE,
    presence_zone: 'Hall A', presence_since: iso(now), presence_until: iso(now + 3 * 3600_000), presence_cell: null,
    ...fields,
  });
  return deviceFor(profileId);
}
const patch = (profileId, fields) => fake.put(PEOPLE, `${EVENT}:${profileId}`, { ...docOf(profileId), ...fields });

// A derived session under a master, with a fresh nonce; returns its key.
function session(profileId, masterId = 'm1') {
  const nonce = B.newPresenceNonce();
  patch(profileId, { presence_nonce: nonce.toString('base64url'), ble_master_id: masterId });
  return MASTERS.has(masterId) ? B.deriveBleKey(MASTERS.get(masterId), profileId, nonce) : null;
}
const tokenNow = (key, offsetWindows = 0) => B.encodeToken(B.deriveToken(key, B.windowOf(Math.floor(Date.now() / 1000)) + BigInt(offsetWindows)));

const checkDef = (def, body) => {
  const r = validator('people-api.v1', def)(body, { closed: true });
  assert.equal(r.valid, true, `${def}\n${formatErrors(r.errors)}\n${JSON.stringify(body)}`);
};

// One sightings report, ten seconds after the previous one (the device's sightings bucket allows
// six a minute, as the capabilities document's ten-second interval does).
async function sight(device, sightings, { step = 10 } = {}) {
  advanceClock(step * 1000);
  const r = await request(handleBleApi, 'POST', '/api/presence/sightings', device, { event: EVENT, sightings });
  if (r.status === 200) checkDef(r.body.ble_key_id ? 'SightingsResponseDerived' : 'SightingsResponse', r.body);
  else checkDef('ErrorBody', r.body);
  return r;
}
const refsOf = (r) => r.body.nearby.map((p) => p.ref).sort();
const tableBuilds = () => fake.calls.filter((c) => c.index === PEOPLE && c.op === '_search' && c.body?.sort?.[0]?.profile_id).length;

test('the capabilities document advertises derived-v1', () => {
  assert.equal(CAPABILITIES.ble.mode, 'derived-v1');
  assert.equal(CAPABILITIES.ble.colocation_required, true);
  assert.equal(CAPABILITIES.ble.window_s, 600);
  const r = validator('capabilities.v1')(CAPABILITIES, { closed: true });
  assert.equal(r.valid, true, formatErrors(r.errors));
});

describe('the resolution cases of contracts/fixtures/ble, through the real handler', () => {
  // The fixture's store and requester, as people documents. The fixture's requester id is not in
  // the device format (it is 23 characters), so the requester here has a 22-character id with the
  // fixture requester's session, and the tokens of the fixture requester's key in a report are
  // replaced by the same windows' tokens of this requester's key.
  const fixtureRequester = cases.people.find((p) => p.profile_id === cases.requester.profile_id);
  const REQUESTER = pid('fixture-requester');
  const idOf = (profileId) => (profileId === cases.requester.profile_id ? REQUESTER : profileId);
  for (const p of cases.people) {
    person(idOf(p.profile_id), { presence_zone: p.zone, presence_cell: p.cell, presence_until: p.presence_until, presence_nonce: p.presence_nonce, ble_master_id: p.ble_master_id });
  }
  const requester = deviceFor(REQUESTER);
  const requesterNonce = Buffer.from(fixtureRequester.presence_nonce, 'base64url');
  const fixtureKey = B.deriveBleKey(MASTERS.get(fixtureRequester.ble_master_id), cases.requester.profile_id, requesterNonce);
  const requesterKey = B.deriveBleKey(MASTERS.get(fixtureRequester.ble_master_id), REQUESTER, requesterNonce);
  const requesterKeyId = B.keyId(requesterKey);
  const ownTokens = new Map();
  for (const c of cases.cases) {
    const w = B.windowOf(Number(c.server_unix_seconds));
    for (let d = -2n; d <= 2n; d++) ownTokens.set(B.encodeToken(B.deriveToken(fixtureKey, w + d)), B.encodeToken(B.deriveToken(requesterKey, w + d)));
  }
  const reportOf = (c) => c.sightings.map((s) => ({ ...s, token: ownTokens.get(s.token) ?? s.token }));
  const zoneOf = new Map(cases.people.map((p) => [ref(idOf(p.profile_id)), p.zone]));

  // Runs one case and checks the people it answers with: those the fixture expects (steps 1 to 4),
  // all strong matches here, each with a zone only when it is the requester's own.
  async function run(c, expected = c.expected) {
    const overrides = c.current_overrides ?? [];
    const saved = overrides.map((o) => [o.profile_id, docOf(o.profile_id)]);
    for (const o of overrides) patch(o.profile_id, { presence_until: o.presence_until });
    try {
      const r = await sight(requester, reportOf(c));
      assert.equal(r.status, 200, `${c.name}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(refsOf(r), expected.map((e) => ref(idOf(e.profile_id))).sort(), c.name);
      assert.equal(r.body.ble_key_id, requesterKeyId, 'every derived-v1 answer carries the requester\'s key id');
      for (const p of r.body.nearby) assert.equal(p.zone, zoneOf.get(p.ref) === cases.requester.zone ? cases.requester.zone : null, `${c.name}: zone only within the requester's zone`);
    } finally {
      for (const [id, doc] of saved) fake.put(PEOPLE, `${EVENT}:${id}`, doc);
    }
  }

  const inWindow = cases.cases.filter((c) => c.server_unix_seconds === String(T_FIXTURE));
  for (const c of inWindow) {
    if (c.table_people) continue; // run last, below, because it needs a stale table
    if (c.retired_masters) continue; // this server holds both masters; a retired one is tested below
    if (c.colocation_required === false) {
      // This server always applies the rule, so the same report resolves nobody here.
      test(`${c.name} (the rule is always on here: nobody)`, () => run(c, []));
      continue;
    }
    test(c.name, () => run(c));
  }

  test('a cached table entry from a replaced nonce does not resolve', async () => {
    const c = inWindow.find((x) => x.table_people);
    const real = c.table_people.map((p) => [p.profile_id, docOf(p.profile_id)]);
    // The table is built while the store holds the old nonce: a miss once the table is older than
    // 30 seconds rebuilds it. Then the nonce is replaced, and the cached entry must not resolve.
    for (const p of c.table_people) patch(p.profile_id, { presence_nonce: p.presence_nonce, ble_master_id: p.ble_master_id });
    const before = tableBuilds();
    await sight(requester, [{ token: 'A'.repeat(22), rssi: -50 }], { step: 31 });
    assert.equal(tableBuilds(), before + 1, 'the table was rebuilt from the old nonce');
    for (const [id, doc] of real) fake.put(PEOPLE, `${EVENT}:${id}`, doc);
    await run(c);
    assert.equal(tableBuilds(), before + 1, 'the stale entry was found in the cached table');
  });

  test('at the window boundary the server accepts the old and the new token', async () => {
    const c = cases.cases.find((x) => x.server_unix_seconds !== String(T_FIXTURE));
    at(Number(c.server_unix_seconds) - 10);
    await run(c);
  });

  test('the requester\'s own token is translated into this requester\'s key', () => {
    const c = inWindow.find((x) => x.name === 'the requester\'s own token is left out');
    assert.ok(reportOf(c).some((s) => !c.sightings.some((t) => t.token === s.token)), 'the own-token case reports this requester\'s own token');
  });

  test('golden-vector parity: a stored session under the vectors\' master answers with the vector\'s key id', async () => {
    // The golden master is m1 of the resolution cases (checked at the top of this file).
    for (const k of golden.key_derivation.cases) {
      const saved = docOf(k.profile_id);
      patch(k.profile_id, { presence_nonce: k.presence_nonce_base64url, ble_master_id: 'm1' });
      try {
        const r = await sight(deviceFor(k.profile_id), [], { step: 1 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.ble_key_id, k.ble_key_id, k.profile_id);
        // A vector's token for a window the server accepts resolves to that person (31 seconds on,
        // so the cached table is rebuilt with the vector's nonce).
        const w = B.windowOf(Math.floor((Date.now() + 31_000) / 1000));
        const vector = k.tokens.find((t) => BigInt(t.w) >= w - 1n && BigInt(t.w) <= w + 1n);
        assert.ok(vector, 'the vectors hold a token for a window around the fixtures\' request time');
        const seen = await sight(requester, [{ token: vector.token_base64url, rssi: -50 }], { step: 31 });
        assert.deepEqual(refsOf(seen), [ref(k.profile_id)], `${k.profile_id} at w = ${vector.w}`);
      } finally {
        fake.put(PEOPLE, `${EVENT}:${k.profile_id}`, saved);
      }
    }
  });
});

describe('PUT /api/presence with ble: true issues the key once', () => {
  const device = newDevice();
  const here = { lat: 40.76752, lon: -111.89036, accuracy: 10 };
  const presence = (body) => request(handleConnectApi, 'PUT', '/api/presence', device, { event: EVENT, zone: 'Hall A', location: here, ...body });

  test('a fresh nonce under the current master is stored; the key goes back once and is never stored', async () => {
    advanceClock(1000);
    const made = await request(handlePeopleApi, 'PUT', '/api/people/profile', device, profileBody('Key Holder', { learn: ['ebpf'], speak: ['ebpf'] }));
    assert.equal(made.status, 200);
    const on = await presence({ ble: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    checkDef('PresencePutResponseDerived', on.body);
    assert.match(on.body.ble.token, /^[A-Za-z0-9_-]{22}$/, 'the legacy token is served too, for old apps');
    const doc = docOf(device.profileId);
    assert.match(doc.presence_nonce, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(doc.ble_master_id, 'm1');
    const key = B.deriveBleKey(MASTERS.get('m1'), device.profileId, Buffer.from(doc.presence_nonce, 'base64url'));
    assert.equal(on.body.ble_key, B.encodeKey(key), 'the reference derives the same key from the stored nonce');
    assert.equal(on.body.ble_key_id, B.keyId(key));
    const stored = JSON.stringify(doc);
    assert.ok(!stored.includes(on.body.ble_key) && !stored.includes(key.toString('hex')) && !stored.includes(key.toString('base64')), 'the key is not stored');

    const again = await presence({ ble: true });
    assert.notEqual(again.body.ble_key, on.body.ble_key, 'every write with ble: true mints a new session');
    assert.notEqual(docOf(device.profileId).presence_nonce, doc.presence_nonce);

    const moved = await presence({});
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ble_key, undefined, 'the key is returned only by the write that minted it');
    assert.equal(moved.body.ble, undefined);
    assert.equal(docOf(device.profileId).presence_nonce, docOf(device.profileId).presence_nonce);
    assert.ok(docOf(device.profileId).presence_nonce, 'a write without ble keeps the session');

    const off = await presence({ ble: false });
    assert.equal(off.status, 200);
    assert.equal(docOf(device.profileId).presence_nonce, null);
    assert.equal(docOf(device.profileId).ble_master_id, null);
    assert.equal(docOf(device.profileId).ble_token, null);
  });

  test('presence off, a new presence session without ble, and visibility off clear the session; the caps record stays', async () => {
    await presence({ ble: true });
    patch(device.profileId, { ble_caps: [{ ref: '0123456789abcdef', at: Date.now(), w: 1 }] });
    const cleared = await request(handleConnectApi, 'DELETE', `/api/presence?event=${EVENT}`, device);
    assert.equal(cleared.status, 200);
    let doc = docOf(device.profileId);
    assert.equal(doc.presence_nonce, null);
    assert.equal(doc.ble_master_id, null);
    assert.equal(doc.ble_caps.length, 1, 'turning presence off does not reset the caps');

    // A session left on a document whose presence ran out (before the purge cleared it) does not
    // come back with a new presence session that does not ask for Bluetooth.
    await presence({ ble: true });
    patch(device.profileId, { presence_until: iso(Date.now() - 1000) });
    await presence({});
    doc = docOf(device.profileId);
    assert.equal(doc.presence_nonce, null, 'one nonce is one presence session');
    assert.equal(doc.ble_token, null);

    await presence({ ble: true });
    const hidden = await request(handlePeopleApi, 'PUT', '/api/people/profile', device, profileBody('Key Holder', { learn: ['ebpf'], speak: ['ebpf'], shared: [`${EVENT}:t1`] }, false));
    assert.equal(hidden.status, 200);
    doc = docOf(device.profileId);
    assert.equal(doc.presence_nonce, null, 'visibility off clears the session');
    assert.equal(doc.ble_caps.length, 1, 'and keeps the caps record');

    const gone = await request(handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device);
    assert.equal(gone.status, 200);
    assert.equal(docOf(device.profileId), undefined, 'the caps record goes with the profile');
  });
});

describe('requesters: ble_required, ble_rekey and legacy sessions', () => {
  test('a requester whose session was issued under a retired master gets ble_rekey; one with none gets ble_required', async () => {
    advanceClock(60_000);
    const retired = person(pid('retired-requester'), { presence_zone: 'Hall A' });
    session(retired.profileId, 'gone');
    assert.deepEqual((await sight(retired, [])).body, { error: 'ble_rekey' });

    const none = person(pid('no-session-at-all'), { presence_zone: 'Hall A' });
    assert.deepEqual((await sight(none, [])).body, { error: 'ble_required' });

    const away = person(pid('not-around-anymore'), { presence_until: iso(Date.now() - 1000) });
    session(away.profileId);
    assert.deepEqual((await sight(away, [])).body, { error: 'ble_required' }, 'not around: the device stops, it does not re-key');
  });

  test('an old app with a live legacy token keeps working whatever its stored nonce, without a key id', async () => {
    const old = person(pid('old-app-requester'), { ble_token: 'b2xkLWFwcC10b2tlbi0xNg', ble_token_until: iso(Date.now() + 600_000) });
    session(old.profileId, 'gone');
    const r = await sight(old, []);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { nearby: [] });
  });

  test('a session under a retired master resolves nobody', async () => {
    const me = person(pid('requester-retired'), { presence_zone: 'Room 201' });
    session(me.profileId);
    const other = person(pid('sighted-retired-1'), { presence_zone: 'Room 201' });
    const retiredKey = B.deriveBleKey(Buffer.alloc(32, 7), other.profileId, B.newPresenceNonce());
    session(other.profileId, 'gone');
    const r = await sight(me, [{ token: tokenNow(retiredKey), rssi: -50 }], { step: 31 });
    assert.deepEqual(r.body.nearby, []);
  });
});

describe('legacy server-minted tokens (the old APK) under the same mitigations', () => {
  test('the rotate route still works, keeps the derived session, and its token resolves only when co-located', async () => {
    advanceClock(60_000);
    const oldApp = newDevice();
    assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', oldApp, profileBody('Old App', { learn: ['ebpf'], speak: ['ebpf'] }))).status, 200);
    const on = await request(handleConnectApi, 'PUT', '/api/presence', oldApp, { event: EVENT, zone: 'Room 201', ble: true });
    assert.equal(on.status, 200);
    const nonce = docOf(oldApp.profileId).presence_nonce;
    const rotated = await request(handleBleApi, 'POST', '/api/presence/ble/rotate', oldApp, { event: EVENT });
    assert.equal(rotated.status, 200);
    checkDef('BleRotateResponse', rotated.body);
    assert.notEqual(rotated.body.ble.token, on.body.ble.token);
    assert.equal(docOf(oldApp.profileId).presence_nonce, nonce, 'rotation leaves the derived session alone');

    const near = person(pid('legacy-seer-in-201'), { presence_zone: 'Room 201' });
    session(near.profileId);
    const far = person(pid('legacy-seer-expo-1'), { presence_zone: 'Expo hall' });
    session(far.profileId);
    const seen = await sight(near, [{ token: rotated.body.ble.token, rssi: -60 }], { step: 31 });
    assert.deepEqual(refsOf(seen), [ref(oldApp.profileId)]);
    assert.equal(seen.body.nearby[0].zone, 'Room 201');
    const notHere = await sight(far, [{ token: rotated.body.ble.token, rssi: -60 }]);
    assert.deepEqual(notHere.body.nearby, [], 'a legacy token resolves only for a co-located requester');
    const stale = await sight(near, [{ token: on.body.ble.token, rssi: -60 }]);
    assert.deepEqual(stale.body.nearby, [], 'the replaced legacy token resolves nobody');
  });

  test('a legacy token in a neighbouring cell resolves with no zone', async () => {
    advanceClock(60_000);
    const me = person(pid('legacy-cell-requester'), { presence_zone: 'Hallway', presence_cell: { lat: 40.76752, lon: -111.89036 } });
    session(me.profileId);
    const them = person(pid('legacy-cell-them-1'), { presence_zone: 'Outside', presence_cell: { lat: 40.76852, lon: -111.89036 }, ble_token: LEGACY_CELL_TOKEN, ble_token_until: iso(Date.now() + 600_000) });
    const r = await sight(me, [{ token: LEGACY_CELL_TOKEN, rssi: -60 }]);
    assert.deepEqual(refsOf(r), [ref(them.profileId)]);
    assert.equal(r.body.nearby[0].zone, null, 'their zone is not the requester\'s');
  });
});

describe('the token table, cached per instance', () => {
  test('a session minted after the table was built resolves once the table is older than 30 seconds', async () => {
    at(Math.floor(Date.now() / 1000 / 600) * 600 + 600 + 120); // two minutes into the next window
    const me = person(pid('table-cache-requester'), { presence_zone: 'Room 201' });
    session(me.profileId);
    const before = tableBuilds();
    await sight(me, [{ token: 'B'.repeat(22), rssi: -50 }], { step: 0 });
    assert.equal(tableBuilds(), before + 1, 'a new window builds the table');

    const late = person(pid('table-cache-late-1'), { presence_zone: 'Room 201' });
    const key = session(late.profileId);
    const soon = await sight(me, [{ token: tokenNow(key), rssi: -50 }], { step: 10 });
    assert.deepEqual(soon.body.nearby, [], 'not yet in this instance\'s table');
    assert.equal(tableBuilds(), before + 1, 'a table younger than 30 seconds is not rebuilt');
    const later = await sight(me, [{ token: tokenNow(key), rssi: -50 }], { step: 21 });
    assert.deepEqual(refsOf(later), [ref(late.profileId)]);
    assert.equal(tableBuilds(), before + 2, 'rebuilt on a token it could not find');
    await sight(me, [{ token: tokenNow(key), rssi: -50 }], { step: 31 });
    assert.equal(tableBuilds(), before + 2, 'a token it finds needs no rebuild, however old the table');
  });
});

describe('the caps, on the final answer', () => {
  // 35 people in Room 201 with live sessions, and a requester there. The store returns them in the
  // order they were stored, which is the ranking order here.
  const W = 600;
  const ids = Array.from({ length: 35 }, (_, i) => Buffer.from(`caps-person-${String(i + 1).padStart(4, '0')}`).toString('base64url').slice(0, 22));
  const keys = new Map();
  let me;
  let start;
  const report = (from, to) => ids.slice(from - 1, to).map((id) => ({ token: tokenNow(keys.get(id)), rssi: -60 }));
  const refsRange = (from, to) => ids.slice(from - 1, to).map(ref).sort();
  const capsWrites = () => fake.calls.filter((c) => c.index === PEOPLE && c.op === '_bulk' && String(c.body).includes(`${EVENT}:${me.profileId}`) && String(c.body).includes('ble_caps')).length;

  test('at most 10 new people per window, and the same people again within it', async () => {
    start = (Math.floor(Date.now() / 1000 / W) + 2) * W + 300; // halfway through a later window
    at(start);
    me = person(pid('caps-requester-01'), { presence_zone: 'Room 201', presence_until: iso((start + 4 * 3600) * 1000) });
    session(me.profileId);
    for (const id of ids) {
      person(id, { presence_zone: 'Room 201', presence_until: iso((start + 4 * 3600) * 1000) });
      keys.set(id, session(id));
    }
    const first = await sight(me, report(1, 35), { step: 0 });
    assert.equal(first.status, 200);
    assert.deepEqual(refsOf(first), refsRange(1, 10));
    const record = docOf(me.profileId).ble_caps;
    assert.equal(record.length, 10);
    assert.ok(record.every((e) => /^[0-9a-f]{16}$/.test(e.ref) && e.w === Math.floor(Date.now() / 1000 / W) && e.at === record[0].at), 'the record holds { ref, at, w } entries only');
    const writes = capsWrites();
    const again = await sight(me, report(1, 35));
    assert.deepEqual(refsOf(again), refsRange(1, 10), 'people already returned in this window keep being returned');
    assert.equal(capsWrites(), writes, 'an answer that adds nobody new writes nothing');
  });

  test('at most 30 people per rolling hour, counted from when they were returned', async () => {
    at(start + W);
    assert.deepEqual(refsOf(await sight(me, report(11, 35), { step: 0 })), refsRange(11, 20));
    at(start + 2 * W);
    assert.deepEqual(refsOf(await sight(me, report(21, 35), { step: 0 })), refsRange(21, 30));
    at(start + 3 * W);
    const full = await sight(me, report(31, 35), { step: 0 });
    assert.equal(full.status, 200, 'over a cap is not an error');
    assert.deepEqual(full.body.nearby, [], '30 people in the last hour: nobody new');
    assert.deepEqual(refsOf(await sight(me, [...report(1, 1), ...report(31, 35)])), refsRange(1, 1), 'someone returned within the hour still is');
    // An hour after the first answer its ten people leave the count, so new people fit again.
    at(start + 6 * W + 30);
    assert.deepEqual(refsOf(await sight(me, report(31, 35), { step: 0 })), refsRange(31, 35));
    assert.ok(docOf(me.profileId).ble_caps.every((e) => e.at > Date.now() - 3600_000), 'the record is pruned to the last hour');
  });

  test('when the record cannot be written, only people already returned in this window are answered', async () => {
    at(start + 8 * W);
    const fresh = person(pid('caps-conflicted-0'), { presence_zone: 'Room 201', presence_until: iso((start + 12 * W + 3600) * 1000) });
    session(fresh.profileId);
    const w = Math.floor(Date.now() / 1000 / W);
    patch(fresh.profileId, { ble_caps: [{ ref: ref(ids[0]), at: Date.now() - 5000, w }] });
    fake.inject = (call) => (call.op === '_bulk' && String(call.body).includes(`${EVENT}:${fresh.profileId}`) ? json({ items: [{ update: { status: 409 } }] }) : undefined);
    try {
      const r = await sight(fresh, report(1, 2), { step: 0 });
      assert.equal(r.status, 200);
      assert.deepEqual(refsOf(r), refsRange(1, 1));
    } finally {
      fake.inject = null;
    }
  });
});
