// PUT /api/presence with until: 'keep' on the Worker (people.presence_keep_until), the same rules as
// tier 3 (server/connect.mjs, test/presence-keep-until.test.mjs): the write keeps the stored end of
// presence and its start, so a Bluetooth write, a re-key or a zone, spot or position change never
// makes someone visible for longer than they chose. It needs live presence and never starts it; it
// is refused with 400 presence_not_active otherwise, and then nothing is written: no presence row,
// no position and no Bluetooth session.
//
// ConferenceDO runs in Node on node:sqlite (helpers/harness.mjs) with a master keyring generated
// for this run, so a presence write with ble: true starts a derived-v1 session and answers a key.
// module.registerHooks needs Node 22.15 or later; on older versions these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { skip, ConferenceDO, fakeState, withFixedClock } from './helpers/harness.mjs';
import { capabilitiesDocument } from '../src/capabilities.js';
import { effectiveCapabilities } from '../../contracts/js/capabilities.mjs';
import { validator } from '../../contracts/js/schemas.mjs';

const SLUG = 'caddie-fixture-2099';
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
// 10:00 UTC on the first day of a two-day conference in UTC, which is visible until 2099-06-02T23:59:59Z.
const T0 = Date.UTC(2099, 5, 1, 10, 0, 0);
const NOT_ACTIVE = { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." };
const HERE = { lat: 40.76789, lon: -111.89012, accuracy: 12 };
// About 11 metres north of HERE: a walk, never an implausible jump.
const NEAR = { lat: 40.76799, lon: -111.89012, accuracy: 10 };
const ENV = {
  EMBED_FAKE: '1',
  // A random master for this run only; it is never printed.
  BLE_MASTER_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: randomBytes(32).toString('base64url') } }),
};

let ipCounter = 0;
const device = (c) => ({ id: c.repeat(22), secret: c.repeat(43) });

function request(method, path, body, d) {
  const headers = { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-ip': `192.0.2.${(ipCounter++ % 200) + 1}` };
  if (d) headers['x-caddie-device'] = `${d.id}.${d.secret}`;
  return new Request(`https://do.internal${path}?event=${SLUG}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call(obj, method, path, body, d) {
  const res = await obj.fetch(request(method, path, body, d));
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function putConference(obj, endDate) {
  const doc = { slug: SLUG, name: 'Fixture', status: 'searchable', start_date: '2099-06-01', end_date: endDate, time_zone: 'UTC' };
  const res = await obj.fetch(new Request('https://do.internal/internal/conference', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc, route_prefix: '' }),
  }));
  assert.equal(res.status, 200);
}

// A conference object with one person who is visible conference-wide and has no presence yet.
// `writes` lists the statements that wrote the presence table, so a test can tell that no row was
// written; `row()` is the stored presence row and `location()` the position held in memory.
async function setup() {
  const writes = [];
  const state = fakeState({ onExec: (q) => { if (/^\s*(INSERT|UPDATE|DELETE)\b[^;]*\bpresence\b/i.test(q)) writes.push(q); } });
  const obj = new ConferenceDO(state, ENV);
  await putConference(obj, '2099-06-02');
  const me = device('a');
  const profile = await call(obj, 'PUT', '/api/people/profile', {
    event: SLUG, profile: { display_name: 'Ada Lovelace', about: 'Ada works on schedulers.' }, open_to_meet: true, shared_talk_ids: [],
  }, me);
  assert.equal(profile.status, 200);
  const rows = () => state.db.prepare('SELECT * FROM presence').all().map((r) => ({ ...r }));
  return {
    obj,
    writes,
    rows,
    row: () => rows()[0] ?? null,
    location: () => obj.store.locations.get(me.id) ?? null,
    put: (body) => call(obj, 'PUT', '/api/presence', { event: SLUG, zone: 'Hallway', ...body }, me),
  };
}

test("'keep' keeps the stored end and since while the zone and spot change", { skip }, async () => {
  await withFixedClock(T0, async (at) => {
    const s = await setup();
    const on = await s.put({ until: 'hour' });
    assert.equal(on.status, 200);
    assert.equal(on.json.presence_until, iso(T0 + 60 * MIN));

    at(T0 + 30 * MIN);
    const kept = await s.put({ zone: 'Expo hall', spot: 'Green jacket', until: 'keep' });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.until, 'keep');
    assert.equal(kept.json.zone, 'Expo hall');
    assert.equal(kept.json.spot, 'Green jacket');
    assert.equal(kept.json.presence_until, iso(T0 + 60 * MIN), 'the end is kept, not moved to an hour from now');
    assert.equal(kept.json.presence_since, iso(T0), 'since is kept');
    const row = s.row();
    assert.equal(row.until_ms, T0 + 60 * MIN);
    assert.equal(row.since_ms, T0);
    assert.equal(row.zone, 'Expo hall');

    // A 'day' presence is kept the same way: the end of the conference day stays.
    const day = await s.put({ until: 'day' });
    const endOfDay = Date.parse('2099-06-01T23:59:59Z');
    assert.equal(day.json.presence_until, iso(endOfDay));
    at(T0 + 90 * MIN);
    const keptDay = await s.put({ until: 'keep' });
    assert.equal(keptDay.status, 200);
    assert.equal(keptDay.json.presence_until, iso(endOfDay));
    assert.equal(keptDay.json.presence_since, iso(T0));
    assert.equal(s.row().until_ms, endOfDay);
  });
});

test("'keep' without presence, or with presence that has run out, is 400 presence_not_active and writes nothing", { skip }, async () => {
  await withFixedClock(T0, async (at) => {
    const s = await setup();
    // Never turned on.
    s.writes.length = 0;
    for (const body of [
      { until: 'keep', location: HERE, ble: true },
      { until: 'keep', location: HERE, ble: false },
      { until: 'keep' },
      // Refused on the profile read, before the zone is checked, as on tier 3.
      { until: 'keep', zone: 'Nowhere', location: HERE },
    ]) {
      const res = await s.put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.json, NOT_ACTIVE);
    }
    assert.deepEqual(s.rows(), [], 'no presence row');
    assert.equal(s.location(), null, 'no position');
    assert.deepEqual(s.writes, [], 'nothing wrote the presence table');

    // Turned on with a position and a Bluetooth session, then run out.
    const on = await s.put({ until: 'hour', location: HERE, ble: true });
    assert.equal(on.status, 200);
    assert.ok(on.json.ble_key);
    const before = s.row();
    const placeBefore = s.location();
    assert.ok(before.presence_nonce && before.ble_token, 'a live Bluetooth session');
    assert.ok(placeBefore);

    at(T0 + 61 * MIN);
    s.writes.length = 0;
    for (const body of [{ until: 'keep', location: NEAR, ble: true }, { until: 'keep', location: NEAR, ble: false }, { until: 'keep' }]) {
      const res = await s.put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(res.json, NOT_ACTIVE);
    }
    assert.deepEqual(s.row(), before, 'the presence row, its end and its Bluetooth session are unchanged');
    assert.deepEqual(s.location(), placeBefore, 'the position is unchanged');
    assert.deepEqual(s.writes, []);

    // 'hour' still turns it on again.
    const again = await s.put({ until: 'hour' });
    assert.equal(again.status, 200);
    assert.equal(again.json.presence_until, iso(T0 + 121 * MIN));
  });
});

test("'keep' with ble: false ends the Bluetooth session and keeps the end", { skip }, async () => {
  await withFixedClock(T0, async (at) => {
    const s = await setup();
    const on = await s.put({ until: 'hour', ble: true });
    assert.equal(on.status, 200);
    assert.ok(s.row().presence_nonce);

    at(T0 + 20 * MIN);
    const off = await s.put({ until: 'keep', ble: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.until, 'keep');
    assert.equal(off.json.presence_until, iso(T0 + 60 * MIN));
    assert.equal(off.json.ble, undefined);
    assert.equal(off.json.ble_key, undefined);
    const row = s.row();
    assert.equal(row.until_ms, T0 + 60 * MIN);
    assert.equal(row.since_ms, T0);
    assert.equal(row.ble_token, null);
    assert.equal(row.ble_token_until_ms, null);
    assert.equal(row.presence_nonce, null);
    assert.equal(row.ble_master_id, null);
  });
});

test("'keep' with ble: true re-keys a session that ends with the kept end", { skip }, async () => {
  await withFixedClock(T0, async (at) => {
    const s = await setup();
    const on = await s.put({ until: 'hour', ble: true });
    assert.equal(on.status, 200);
    const firstNonce = s.row().presence_nonce;

    // Five minutes before the end: a new legacy token would run 10 minutes, past the presence.
    at(T0 + 55 * MIN);
    const rekey = await s.put({ until: 'keep', ble: true });
    assert.equal(rekey.status, 200);
    assert.equal(rekey.json.until, 'keep');
    assert.equal(rekey.json.presence_until, iso(T0 + 60 * MIN));
    assert.equal(rekey.json.presence_since, iso(T0));
    assert.ok(rekey.json.ble_key);
    assert.notEqual(rekey.json.ble_key, on.json.ble_key, 'a new key');
    assert.equal(rekey.json.ble.rotate_at, iso(T0 + 60 * MIN), 'the session ends with the kept end');
    const row = s.row();
    assert.notEqual(row.presence_nonce, firstNonce, 'a new session');
    assert.equal(row.until_ms, T0 + 60 * MIN);
    assert.equal(row.ble_token_until_ms, T0 + 60 * MIN);
  });
});

test("a 'keep' that changes only the position writes no presence row and leaves the end as it was", { skip }, async () => {
  await withFixedClock(T0, async (at) => {
    const s = await setup();
    const on = await s.put({ until: 'hour', location: HERE });
    assert.equal(on.status, 200);
    assert.equal(on.json.located, true);
    const before = s.row();
    assert.ok(s.writes.length > 0, 'turning presence on wrote the presence table');

    at(T0 + 1 * MIN);
    s.writes.length = 0;
    const fix = await s.put({ until: 'keep', location: NEAR });
    assert.equal(fix.status, 200);
    assert.equal(fix.json.located, true);
    assert.equal(fix.json.until, 'keep');
    assert.equal(fix.json.presence_until, iso(T0 + 60 * MIN));
    assert.deepEqual(s.writes, [], 'no presence row was written');
    assert.deepEqual(s.row(), before);
    assert.equal(s.location().lat, NEAR.lat, 'the position is updated in memory');
  });
});

test("'keep' never extends past the end of the conference, and lowers a kept end to it", { skip }, async () => {
  // 23:30 on the first day: an hour runs to 00:30 on the second day.
  const start = Date.UTC(2099, 5, 1, 23, 30, 0);
  await withFixedClock(start, async (at) => {
    const s = await setup();
    const on = await s.put({ until: 'hour', location: HERE });
    assert.equal(on.status, 200);
    assert.equal(on.json.presence_until, iso(start + 60 * MIN));

    // The operator shortens the conference to one day: it is now visible until 23:59:59 that day.
    await putConference(s.obj, '2099-06-01');
    const cap = Date.parse('2099-06-01T23:59:59Z');

    at(start + 10 * MIN);
    const kept = await s.put({ until: 'keep', location: NEAR });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.presence_until, iso(cap), 'the kept end is lowered to the end of the conference');
    assert.equal(kept.json.presence_since, iso(start));
    assert.equal(s.row().until_ms, cap, 'and stored, although only the position changed');

    // Later writes keep the lowered end; they never bring back the earlier one.
    at(start + 20 * MIN);
    const again = await s.put({ until: 'keep', ble: true });
    assert.equal(again.status, 200);
    assert.equal(again.json.presence_until, iso(cap));
    assert.equal(again.json.ble.rotate_at, iso(cap));
    assert.equal(s.row().until_ms, cap);
  });
});

test("'keep' after the end of the conference is refused as the conference having ended", { skip }, async () => {
  const start = Date.UTC(2099, 5, 1, 23, 30, 0);
  await withFixedClock(start, async (at) => {
    const s = await setup();
    assert.equal((await s.put({ until: 'hour' })).status, 200);
    // Presence runs to 00:30, but the conference now ends at 23:59:59 on the first day.
    await putConference(s.obj, '2099-06-01');
    at(Date.UTC(2099, 5, 2, 0, 10, 0));
    const before = s.row();
    const res = await s.put({ until: 'keep', location: HERE });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'conference has ended');
    assert.deepEqual(s.row(), before);
    assert.equal(s.location(), null);
  });
});

test('an unknown mode names keep', { skip }, async () => {
  await withFixedClock(T0, async () => {
    const s = await setup();
    const res = await s.put({ until: 'week' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "until must be 'hour', 'day' or 'keep'");
    assert.deepEqual(s.rows(), []);
  });
});

test('the capabilities advertise until: keep, as the tier 2 fixture does, and validate in closed mode', () => {
  const tier2 = JSON.parse(readFileSync(new URL('../../contracts/fixtures/capabilities/tier2-free.json', import.meta.url), 'utf8'));
  for (const env of [{}, { BLE_MASTER_KEYRING: ENV.BLE_MASTER_KEYRING }]) {
    const doc = capabilitiesDocument(env);
    assert.equal(doc.people.presence_keep_until, true);
    assert.equal(doc.people.presence_keep_until, tier2.people.presence_keep_until);
    assert.equal(effectiveCapabilities(doc).people.presence_keep_until, true);
    const result = validator('capabilities.v1')(doc, { closed: true });
    assert.equal(result.valid, true, JSON.stringify(result.errors ?? null));
  }
});
