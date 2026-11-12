// PUT /api/presence with until: 'keep' (people.presence_keep_until): the write keeps the stored
// presence_until, so a Bluetooth write (ble: true or false, the automatic re-key included) or a
// zone, spot or position change never makes someone visible for longer than they chose. It needs
// live presence and never starts it; it is refused with 400 presence_not_active otherwise, and it
// is judged against the profile read that guards the write, so a presence that ended between the
// read and the write is never brought back. 'hour' and 'day' are unchanged.
//
// Run with `npm test`. The server modules talk to the in-memory stand-in of
// test/helpers/fake-es.mjs through a stubbed fetch; nothing reaches the network. The master keyring
// is generated for this run, so the server is in derived-v1 mode and a re-key returns a ble_key.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, personId, addPerson, request, quietly,
} from './helpers/fake-es.mjs';
import { effectiveCapabilities, LEGACY } from '../contracts/js/capabilities.mjs';

process.env.BLE_MASTER_KEYRING = JSON.stringify({ current: 'k1', keys: { k1: crypto.randomBytes(32).toString('base64url') } });

const { handleConnectApi } = await import('../server/connect.mjs');
const { dayBounds, PRESENCE_OFF } = await import('../server/people.mjs');
const { currentCapabilities } = await import('../server/capabilities.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => JSON.parse(readFileSync(path.join(ROOT, 'contracts/fixtures/capabilities', f), 'utf8'));

before(() => bootPurgeDone());

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const NOT_ACTIVE = { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." };

const put = (device, body) => quietly(() => request(handleConnectApi, 'PUT', '/api/presence', device, { event: EVENT, zone: 'Hallway', ...body }));

// A person who is around until `untilMs` (20 minutes from now by default), with a live Bluetooth
// session, plus any other stored fields.
function setup(fields = {}, untilMs = Date.now() + 20 * MIN) {
  const device = newDevice();
  const cluster = useCluster(new FakeES());
  const since = iso(Date.now() - 40 * MIN);
  addPerson(cluster, device, {
    presence_since: since,
    presence_until: iso(untilMs),
    presence_nonce: Buffer.alloc(16, 7).toString('base64url'),
    ble_master_id: 'k1',
    ...fields,
  });
  const id = personId(device.profileId);
  // A copy: the stand-in updates its stored source in place.
  return { device, cluster, id, since, doc: () => structuredClone(cluster.source(INDEX.people, id)) };
}

describe("until: 'keep'", () => {
  test('keeps the stored end exactly, and since, while the zone, spot and position change', async () => {
    const { device, cluster, doc, since } = setup();
    const stored = doc().presence_until;
    const { result } = await put(device, { zone: 'Expo hall', spot: 'Red scarf', location: { lat: 1.23457, lon: 2.34568, accuracy: 10 }, until: 'keep' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.until, 'keep');
    assert.equal(result.body.presence_until, stored);
    assert.equal(result.body.presence_since, since);
    assert.equal(result.body.zone, 'Expo hall');
    assert.equal(result.body.located, true);
    const p = doc();
    assert.equal(p.presence_until, stored, 'the end is written back unchanged');
    assert.equal(p.presence_since, since);
    assert.equal(p.presence_zone, 'Expo hall');
    assert.equal(p.presence_spot, 'Red scarf');
    assert.deepEqual(p.presence_location, { lat: 1.23457, lon: 2.34568 });
    assert.equal(cluster.calls('update').length, 1);
  });

  test('with ble: false ends the Bluetooth session and keeps the end', async () => {
    const { device, doc } = setup();
    const stored = doc().presence_until;
    const { result } = await put(device, { until: 'keep', ble: false });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.presence_until, stored);
    assert.equal(result.body.ble_key, undefined);
    const p = doc();
    assert.equal(p.presence_until, stored);
    for (const k of ['ble_token', 'ble_token_until', 'ble_rotated', 'presence_nonce', 'ble_master_id']) assert.equal(p[k], null, `${k} is cleared`);
  });

  test('with ble: true (a re-key) issues a new key for the same end', async () => {
    const { device, doc } = setup();
    const before = doc();
    const { result } = await put(device, { until: 'keep', ble: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.presence_until, before.presence_until);
    assert.match(result.body.ble_key, /^[A-Za-z0-9_-]{43}$/);
    assert.match(result.body.ble_key_id, /^[A-Za-z0-9_-]{11}$/);
    const p = doc();
    assert.equal(p.presence_until, before.presence_until);
    assert.notEqual(p.presence_nonce, before.presence_nonce, 'a new presence session');
    assert.ok(Date.parse(p.ble_token_until) <= Date.parse(p.presence_until), 'the token never outlives the kept end');
  });

  test('a re-key 3 minutes before the end gets a token that ends with the presence', async () => {
    const { device, doc } = setup({}, Date.now() + 3 * MIN);
    const stored = doc().presence_until;
    const { result } = await put(device, { until: 'keep', ble: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const p = doc();
    assert.equal(p.presence_until, stored);
    assert.equal(p.ble_token_until, p.presence_until, 'the ten-minute token is cut to the kept end');
    assert.equal(result.body.ble.rotate_at <= p.presence_until, true);
  });

  test('without ble leaves the Bluetooth session as it is', async () => {
    const { device, doc } = setup();
    const before = doc();
    const { result } = await put(device, { until: 'keep' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const p = doc();
    assert.equal(p.presence_until, before.presence_until);
    for (const k of ['ble_token', 'ble_token_until', 'presence_nonce', 'ble_master_id']) assert.equal(p[k], before[k], `${k} is kept`);
  });

  test('never past the end of the conference', async () => {
    const { device, doc } = setup({}, Date.parse(FUTURE) + 24 * 60 * MIN);
    const stored = doc().presence_until;
    const { result } = await put(device, { until: 'keep' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(Date.parse(result.body.presence_until) <= Date.parse(FUTURE), result.body.presence_until);
    assert.ok(Date.parse(result.body.presence_until) < Date.parse(stored), 'only ever shortened');
    assert.equal(doc().presence_until, result.body.presence_until);
  });

  for (const [label, fields, ble] of [
    ['no presence stored', PRESENCE_OFF, undefined],
    ['no presence stored, with ble: true', PRESENCE_OFF, true],
    ['presence that has run out', { presence_until: iso(Date.now() - MIN) }, undefined],
    ['presence that has run out, with ble: false', { presence_until: iso(Date.now() - MIN) }, false],
  ]) {
    test(`with ${label} answers 400 presence_not_active and writes nothing`, async () => {
      const { device, cluster, doc } = setup(fields);
      const before = doc();
      const { result } = await put(device, { until: 'keep', ...(ble === undefined ? {} : { ble }) });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, NOT_ACTIVE);
      assert.deepEqual(cluster.tags(), ['get'], 'refused on the profile read: no filter, no write; keep never starts presence');
      assert.deepEqual(doc(), before);
    });
  }

  test('without live presence it is refused before the spot line reaches the filter', async () => {
    const { device, cluster, doc } = setup(PRESENCE_OFF);
    const before = doc();
    // A spot the filter refuses: the answer is presence_not_active, so the filter never ran.
    const { result } = await put(device, { spot: 'see https://example.com', location: { lat: 1.23457, lon: 2.34568, accuracy: 10 }, until: 'keep', ble: true });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, NOT_ACTIVE);
    assert.deepEqual(cluster.tags(), ['get']);
    assert.deepEqual(doc(), before);
  });

  test('with live presence the spot line still goes through the filter', async () => {
    const { device, cluster, doc } = setup();
    const before = doc();
    const filtered = await put(device, { spot: 'see https://example.com', until: 'keep' });
    assert.equal(filtered.result.status, 400);
    assert.equal(filtered.result.body.error, 'filtered');
    assert.deepEqual(cluster.tags(), ['get'], 'read, filtered, nothing written');
    assert.deepEqual(doc(), before);
  });

  test('a presence that runs out after the guarded read stores no new position or session', async () => {
    const { device, cluster, id, doc } = setup({}, Date.now() + 2 * MIN);
    // Another write lands after the first read, so the guarded write conflicts and reads again;
    // by then the clock has passed the stored end.
    cluster.after('get', 1, (c) => c.patch(INDEX.people, id, { spot_hidden: false }));
    const realNow = Date.now;
    cluster.after('get', 2, () => {
      const skew = 5 * MIN;
      Date.now = () => realNow() + skew;
    });
    let result;
    try {
      ({ result } = await put(device, { location: { lat: 1.23457, lon: 2.34568, accuracy: 10 }, until: 'keep', ble: true }));
    } finally {
      Date.now = realNow;
    }
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, NOT_ACTIVE);
    assert.deepEqual(cluster.tags(), ['get', 'update', 'get']);
    const p = doc();
    assert.deepEqual(p.presence_location, { lat: 1.23456, lon: 2.34567 }, 'the old position is untouched');
    assert.equal(p.presence_nonce, Buffer.alloc(16, 7).toString('base64url'), 'no new session');
  });

  test('a presence that ended between the read and the write is not brought back', async () => {
    const { device, cluster, id, doc } = setup();
    // DELETE /api/presence (or the purge) lands after the profile read and before the write.
    cluster.after('get', 1, (c) => c.patch(INDEX.people, id, PRESENCE_OFF));
    const { result } = await put(device, { until: 'keep', ble: false });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, NOT_ACTIVE);
    assert.deepEqual(cluster.tags(), ['get', 'update', 'get'], 'the guarded write conflicted, the profile was read again and nothing more was written');
    const p = doc();
    for (const [k, v] of Object.entries(PRESENCE_OFF)) assert.deepEqual(p[k], v, `${k} stays as the delete left it`);
  });

  test('a presence that was shortened between the read and the write keeps the new end', async () => {
    const { device, cluster, id, doc } = setup();
    const shorter = iso(Date.now() + 5 * MIN);
    cluster.after('get', 1, (c) => c.patch(INDEX.people, id, { presence_until: shorter }));
    const { result } = await put(device, { until: 'keep', ble: false });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.presence_until, shorter);
    assert.deepEqual(cluster.tags(), ['get', 'update', 'get', 'update']);
    assert.equal(doc().presence_until, shorter);
  });

  test('writes with if_seq_no and if_primary_term of the profile read', async () => {
    const { device, cluster, id } = setup();
    const seq = cluster.docs(INDEX.people).get(id).seq;
    const { result } = await put(device, { until: 'keep' });
    assert.equal(result.status, 200);
    const action = JSON.parse(cluster.calls('update')[0].body.split('\n')[0]).update;
    assert.equal(action.if_seq_no, seq);
    assert.equal(action.if_primary_term, 1);
  });

  for (const until of ['week', 'KEEP', 'Keep', ' keep', '', 0, 1, true, false, [], {}, ['keep']]) {
    test(`until: ${JSON.stringify(until)} is 400 before anything is read or filtered`, async () => {
      const { device, cluster } = setup();
      // A spot the filter would refuse: the mode is checked first.
      const { result } = await put(device, { spot: 'see https://example.com', until });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: "until must be 'hour', 'day' or 'keep'" });
      assert.deepEqual(cluster.tags(), []);
    });
  }

  test('a malformed ble is 400 before the spot line is filtered', async () => {
    const { device, cluster } = setup();
    const { result } = await put(device, { spot: 'see https://example.com', until: 'keep', ble: 'off' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'ble must be a boolean' });
    assert.deepEqual(cluster.tags(), []);
  });
});

describe("'hour' and 'day' are unchanged", () => {
  test("'hour' (and no until, and null) restart the hour from now and keep since", async () => {
    for (const until of ['hour', undefined, null]) {
      const { device, doc, since } = setup();
      const t0 = Date.now();
      const { result } = await put(device, until === undefined ? { ble: false } : { until, ble: false });
      const t1 = Date.now();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.until, 'hour');
      const end = Date.parse(result.body.presence_until);
      assert.ok(end >= t0 + 60 * MIN && end <= t1 + 60 * MIN, `${String(until)}: an hour from now`);
      assert.equal(result.body.presence_since, since);
      assert.equal(doc().presence_until, result.body.presence_until);
    }
  });

  test("'day' runs to the end of the conference day", async () => {
    const { device, doc } = setup();
    const { result } = await put(device, { until: 'day' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.until, 'day');
    assert.equal(result.body.presence_until, iso(dayBounds(Date.now(), 'UTC').end));
    assert.equal(doc().presence_until, result.body.presence_until);
  });

  test("'hour' and 'day' still turn presence on when none is live", async () => {
    for (const until of ['hour', 'day']) {
      const { device, doc } = setup(PRESENCE_OFF);
      const t0 = Date.now();
      const { result } = await put(device, { until });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(Date.parse(result.body.presence_since) >= t0, `${until}: a new presence session`);
      assert.ok(Date.parse(doc().presence_until) > Date.now());
    }
  });
});

describe('capabilities', () => {
  test('tier 3 advertises people.presence_keep_until', () => {
    const doc = currentCapabilities();
    assert.equal(doc.people.presence_keep_until, true);
    assert.equal(effectiveCapabilities(doc).people.presence_keep_until, true);
  });

  test('missing, not true, or without presence, it is off; the legacy server does not have it', () => {
    const tier2 = fixture('tier2-free.json');
    const { presence_keep_until: _omit, ...without } = tier2.people;
    assert.equal(effectiveCapabilities({ ...tier2, people: without }).people.presence_keep_until, false);
    assert.equal(effectiveCapabilities({ ...tier2, people: { ...tier2.people, presence_keep_until: 'yes' } }).people.presence_keep_until, false);
    assert.equal(effectiveCapabilities({ ...tier2, people: { ...tier2.people, presence: false, presence_keep_until: true } }).people.presence_keep_until, false);
    assert.equal(effectiveCapabilities({ ...tier2, people: { ...tier2.people, presence_keep_until: true } }).people.presence_keep_until, true);
    assert.equal(LEGACY.people.presence_keep_until, false);
  });
});
