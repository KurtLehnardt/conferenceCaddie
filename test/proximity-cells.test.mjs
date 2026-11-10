// Positions, cells and proximity bands, run against the in-memory stand-in for Elasticsearch in
// test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// A review found that the band on a match (near, around, venue) was computed from the requester's
// stored position, which the client can set anywhere, so a stranger could bisect the 300 m edge
// from three directions and compute another person's position to a fraction of a metre. The tests
// check that
// - bands come from ~100 m cells only: 'near' is the same cell, 'around' is cell centres under
//   300 m apart, so two people anywhere in the same cell look the same to every possible
//   requester position, and a precise location without a cell bands as 'venue';
// - PUT /api/presence stores the cell (and the time of the fix) in the same partial update as the
//   position, and DELETE /api/presence clears them with it;
// - a fix that implies a move faster than 7 m/s since a fix of the last ten minutes is stored
//   zone-only, without an error, while walking-speed moves and fixes after ten minutes are kept;
// - the ranking leg is a distance_feature on presence_cell with the requester's cell as origin,
//   and a people search never reads another person's precise presence_location.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, newDevice, request, profileBody, advanceClock } from './lib/fake-es.mjs';

const { handlePeopleApi, cellFor, proximityBand, distanceM, PRESENCE_OFF, CELL_DEG } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');

const M = 111_320;
const move = (p, bearing, d) => {
  const t = (bearing * Math.PI) / 180;
  return { lat: p.lat + (d * Math.cos(t)) / M, lon: p.lon + (d * Math.sin(t)) / (M * Math.cos((p.lat * Math.PI) / 180)) };
};
const until = () => new Date(Date.now() + 30 * 60_000).toISOString();
// A person who is around in their own zone with a position, as a people document carries it.
const at = (p, zone = 'Hall A') => ({ presence_zone: zone, presence_until: until(), presence_location: p, presence_cell: cellFor(p) });

describe('cells', () => {
  const venue = { lat: 39.74312, lon: -104.99541 };

  test('a cell is about 111 m on each side, and its centre is its own cell', () => {
    const c = cellFor(venue);
    // Each row has its own longitude step, so the next row's centres are offset by a few metres.
    const north = cellFor({ lat: c.lat + CELL_DEG, lon: c.lon });
    const east = { lat: c.lat, lon: c.lon + CELL_DEG / Math.cos((c.lat * Math.PI) / 180) };
    assert.ok(Math.abs(distanceM(c, north) - 111) < 5, `north ${distanceM(c, north)}`);
    assert.ok(Math.abs(distanceM(c, cellFor(east)) - 111) < 1, `east ${distanceM(c, cellFor(east))}`);
    assert.deepEqual(cellFor(c), c);
    assert.ok(distanceM(c, venue) < 80, 'a position is within half a diagonal of its cell centre');
  });

  test('longitude stays inside -180..180 and poles do not divide by zero', () => {
    for (const p of [{ lat: 0, lon: 179.99999 }, { lat: 0, lon: -179.99999 }, { lat: 90, lon: 12 }, { lat: -89.99999, lon: -12 }]) {
      const c = cellFor(p);
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lon) <= 180 && Math.abs(c.lat) <= 90, JSON.stringify(c));
    }
  });

  test('bands: the same zone first, then the same cell, then cells under 300 m, else the venue', () => {
    const c = cellFor(venue);
    const me = at(venue, 'Hall A');
    assert.equal(proximityBand(me, at(move(venue, 90, 300), 'Hall A')), 'same_zone');
    assert.equal(proximityBand(me, at({ lat: c.lat + CELL_DEG * 0.4, lon: c.lon }, 'Room 201')), 'near');
    assert.equal(proximityBand(me, at({ lat: c.lat + CELL_DEG * 2, lon: c.lon }, 'Room 201')), 'around');
    assert.equal(proximityBand(me, at({ lat: c.lat + CELL_DEG * 3, lon: c.lon }, 'Room 201')), 'venue');
    // A precise location with no cell (a document from before cells) is never banded closer.
    assert.equal(proximityBand(me, { presence_zone: 'Room 201', presence_until: until(), presence_location: venue }), 'venue');
  });

  test('two people in the same cell look the same from every requester position', () => {
    const c = cellFor(venue);
    // Two victims 70 m apart, both inside one cell.
    const v1 = at({ lat: c.lat - CELL_DEG * 0.45, lon: c.lon - (CELL_DEG * 0.4) / Math.cos((c.lat * Math.PI) / 180) }, 'Room 201');
    const v2 = at({ lat: c.lat + CELL_DEG * 0.45, lon: c.lon + (CELL_DEG * 0.4) / Math.cos((c.lat * Math.PI) / 180) }, 'Room 201');
    assert.deepEqual(v1.presence_cell, v2.presence_cell);
    assert.ok(distanceM(v1.presence_location, v2.presence_location) > 60);
    let probes = 0;
    for (let dy = -600; dy <= 600; dy += 7) {
      for (let dx = -600; dx <= 600; dx += 7) {
        const me = at(move(move(c, 0, dy), 90, dx), 'Hall A');
        assert.equal(proximityBand(me, v1), proximityBand(me, v2), `requester at ${dx}, ${dy}`);
        probes++;
      }
    }
    assert.ok(probes > 25_000);
  });
});

// One visible person, and a presence write for them.
async function person() {
  fake.reset();
  const d = newDevice();
  assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody('Pat', { speak: ['ebpf'], expertise: 'eBPF' }))).status, 200);
  return d;
}
const presence = async (d, location) => {
  const r = await request(handleConnectApi, 'PUT', '/api/presence', d, { event: EVENT, zone: 'Hall A', spot: '', location });
  await new Promise((resolve) => setTimeout(resolve, 20)); // the push nudge runs after the answer
  return r;
};
const docOf = (d) => fake.doc('caddie-people', `${EVENT}:${d.profileId}`);
const HERE = { lat: 39.74312, lon: -104.99541, accuracy: 12 };

describe('PUT /api/presence', () => {
  test('stores the cell and the time of the fix with the position, and DELETE clears them', async () => {
    const d = await person();
    const r = await presence(d, HERE);
    assert.equal(r.status, 200);
    assert.equal(r.body.located, true);
    const doc = docOf(d);
    assert.deepEqual(doc.presence_location, { lat: 39.74312, lon: -104.99541 });
    assert.deepEqual(doc.presence_cell, cellFor(doc.presence_location));
    assert.ok(Math.abs(Date.parse(doc.presence_located_at) - Date.now()) < 5000);
    assert.equal(JSON.stringify(r.body).includes('39.74'), false, 'no coordinate is echoed');
    assert.ok('presence_cell' in PRESENCE_OFF && 'presence_located_at' in PRESENCE_OFF);
    assert.equal((await request(handleConnectApi, 'DELETE', `/api/presence?event=${EVENT}`, d)).status, 200);
    for (const f of ['presence_location', 'presence_accuracy', 'presence_cell', 'presence_located_at']) assert.equal(docOf(d)[f], null, `${f} is cleared`);
  });

  test('a zone-only write clears the cell with the position', async () => {
    const d = await person();
    await presence(d, HERE);
    const r = await presence(d, undefined);
    assert.equal(r.body.located, false);
    assert.equal(docOf(d).presence_cell, null);
    assert.equal(docOf(d).presence_located_at, null);
  });

  test('a jump of kilometres right after a fix is stored zone-only, without an error', async () => {
    const d = await person();
    await presence(d, HERE);
    const far = { ...move(HERE, 45, 5000), accuracy: 5 };
    const r = await presence(d, far);
    assert.equal(r.status, 200);
    assert.equal(r.body.located, false);
    assert.equal(r.body.zone, 'Hall A');
    const doc = docOf(d);
    assert.equal(doc.presence_zone, 'Hall A');
    for (const f of ['presence_location', 'presence_accuracy', 'presence_cell', 'presence_located_at']) assert.equal(doc[f], null, `${f} is null`);
  });

  test('a 300 m jump a few seconds after a fix is dropped; a walk of 40 m in 15 s is kept', async () => {
    const d = await person();
    await presence(d, HERE);
    advanceClock(5000);
    assert.equal((await presence(d, { ...move(HERE, 90, 300), accuracy: 5 })).body.located, false);
    const d2 = await person();
    await presence(d2, HERE);
    advanceClock(15_000);
    const walked = { ...move(HERE, 90, 40), accuracy: 5 };
    assert.equal((await presence(d2, walked)).body.located, true);
    assert.deepEqual(docOf(d2).presence_cell, cellFor(docOf(d2).presence_location));
  });

  test('a fix more than ten minutes after the last one is not checked', async () => {
    const d = await person();
    await presence(d, HERE);
    advanceClock(10 * 60_000 + 1000);
    assert.equal((await presence(d, { ...move(HERE, 180, 2000), accuracy: 5 })).body.located, true);
  });
});

describe('ranking', () => {
  test('the distance leg uses presence_cell with my cell as origin, and no precise location is read', async () => {
    const me = await person();
    const other = newDevice();
    assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', other, profileBody('Ola', { learn: ['ebpf'] }))).status, 200);
    await presence(me, HERE);
    await presence(other, { ...move(HERE, 0, 150), accuracy: 5 });
    fake.calls.length = 0;
    const r = await request(handlePeopleApi, 'POST', '/api/people/matches', me, { event: EVENT, interested_talk_ids: [], when: 'around_now' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((p) => [p.display_name, p.proximity]), [['Ola', 'same_zone']]);
    const body = fake.peopleSearches()[0].body;
    const text = JSON.stringify(body);
    assert.ok(!text.includes('presence_location'), 'the search reads no precise location');
    const leg = body.retriever.rrf.retrievers.find((x) => x.standard._name.startsWith('distance'));
    const df = leg.standard.query.bool.must[0].distance_feature;
    assert.equal(df.field, 'presence_cell');
    assert.deepEqual(df.origin, docOf(me).presence_cell);
  });
});
