// Writes that only change the position while presence is on (a fix from the geolocation watch, or
// the position turned off) send until: 'keep' where the backend's capabilities say
// people.presence_keep_until, so they never move the end of presence the user chose; elsewhere
// they send the mode as before. Turning presence on and Extend still send the mode. A 'keep' that
// the server refuses with 400 presence_not_active turns presence off on the device too, without a
// request of its own. Each case imports its own copy of presence.ts (the query), so the position
// watch and the capabilities read start fresh; the loader passes the query on to the modules it
// imports, which a case reaches through `storage()`.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calls, deferred, json, onFetch, requests, resetFake, settle } from './env.mjs';
import { effectiveCapabilities } from '../../contracts/js/capabilities.mjs';

const SLUG = 'testconf-2099';
const MIN = 60_000;
const CAPS = new URL('../../contracts/fixtures/capabilities/', import.meta.url);
const fixture = (f) => JSON.parse(readFileSync(new URL(f, CAPS), 'utf8'));
const TIER3 = fixture('tier3-paid.json');
const NOT_ACTIVE = { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." };

let n = 0;
let mod;
async function fresh() {
  n++;
  mod = await import(`../src/people/presence.ts?keep${n}`);
  return mod;
}
const storage = () => import(`../src/people/storage.ts?keep${n}`);
const capabilities = () => import(`../src/people/capabilities.ts?keep${n}`);

function device() {
  localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'p'.repeat(22), secret: 's'.repeat(43) }));
}

function presenceOn({ mode = 'hour', position = true } = {}) {
  localStorage.setItem(`caddie.presence.v1.${SLUG}`, JSON.stringify({
    on: true, zone: 'Hallway', spot: 'Green jacket', until: new Date(Date.now() + 40 * MIN).toISOString(), notice_seen: true,
    position, position_choice: position ? 'yes' : 'no', mode, confirmed_at: new Date().toISOString(), confirm_pending: false, recent_zones: ['Hallway'],
  }));
}

// A geolocation watch the test feeds by hand.
let feed = null;
let cleared = 0;
function geolocation() {
  navigator.geolocation = {
    watchPosition(success) {
      feed = success;
      return 7;
    },
    clearWatch() {
      cleared++;
    },
  };
}
const fix = (lat = 40.76789, lon = -111.89012, accuracy = 12) => feed({ coords: { latitude: lat, longitude: lon, accuracy } });

/** caps: a capabilities document, or a status for GET /api/capabilities to answer with instead. */
function server({ caps = TIER3, presence = (call) => json(200, { ok: true, zone: call.body.zone, until: call.body.until ?? 'hour' }) } = {}) {
  onFetch((call) => {
    if (call.path === '/api/capabilities') return typeof caps === 'number' ? json(caps, { error: 'Not found' }) : json(200, caps);
    if (call.method === 'PUT' && call.path === '/api/presence') return presence(call);
    return json(200, { ok: true });
  });
}
const puts = () => calls.filter((c) => c.method === 'PUT' && c.path === '/api/presence');
const withoutKeep = (doc) => ({ ...doc, people: Object.fromEntries(Object.entries(doc.people).filter(([k]) => k !== 'presence_keep_until')) });
const keepFlag = (doc, value) => ({ ...doc, people: { ...doc.people, presence_keep_until: value } });

beforeEach(() => {
  resetFake();
  delete navigator.geolocation;
  feed = null;
  cleared = 0;
  device();
});

test('turning the position off sends keep where the backend offers it', async () => {
  presenceOn();
  server();
  const p = await fresh();
  await p.sharePosition(SLUG, false);
  await settle();
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence']);
  assert.deepEqual(puts()[0].body, { event: SLUG, zone: 'Hallway', spot: 'Green jacket', until: 'keep' });
});

test('a position fix sends keep where the backend offers it, and its location', async () => {
  presenceOn();
  geolocation();
  server();
  const p = await fresh();
  await p.sharePosition(SLUG, true);
  assert.ok(feed, 'the watch started');
  fix();
  await settle();
  assert.equal(puts().length, 1);
  assert.deepEqual(puts()[0].body, { event: SLUG, zone: 'Hallway', spot: 'Green jacket', location: { lat: 40.76789, lon: -111.89012, accuracy: 12 }, until: 'keep' });
  assert.equal((await storage()).getPresence(SLUG).on, true);
});

test('without the flag, or without a capabilities document, they send the mode as before', async () => {
  for (const [label, caps, mode, until] of [
    ['no flag, hour', withoutKeep(TIER3), 'hour', undefined],
    ['no flag, day', withoutKeep(TIER3), 'day', 'day'],
    // tier2-free.json says true since the Worker takes 'keep', so the false case is written out.
    ['flag false', keepFlag(fixture('tier2-free.json'), false), 'day', 'day'],
    ['no document (404)', 404, 'hour', undefined],
    ['no document (503)', 503, 'day', 'day'],
  ]) {
    resetFake();
    device();
    presenceOn({ mode });
    server({ caps });
    const p = await fresh();
    await p.sharePosition(SLUG, false);
    await settle();
    assert.equal(puts().length, 1, label);
    assert.equal(puts()[0].body.until, until, label);
  }
});

test('the capabilities document is read once for the page', async () => {
  presenceOn();
  geolocation();
  server();
  const p = await fresh();
  await p.sharePosition(SLUG, true);
  fix();
  await settle();
  await p.sharePosition(SLUG, false);
  await settle();
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence', 'PUT /api/presence']);
  assert.deepEqual(puts().map((c) => c.body.until), ['keep', 'keep']);
});

test('turning presence on and Extend still send the mode, never keep', async () => {
  presenceOn({ mode: 'day' });
  server();
  const p = await fresh();
  assert.equal(await p.turnOn(SLUG, 'Expo hall', 'Red scarf', 'hour'), null);
  assert.equal(await p.extend(SLUG), null);
  await p.turnOn(SLUG, 'Expo hall', 'Red scarf', 'day');
  await settle();
  assert.deepEqual(puts().map((c) => c.body.until), [undefined, undefined, 'day']);
  assert.equal(requests().includes('GET /api/capabilities'), false, 'a turn-on does not need the flag');
});

test('a fix refused with presence_not_active turns presence off here, with no request of its own', async () => {
  presenceOn();
  geolocation();
  server({ presence: () => json(400, NOT_ACTIVE) });
  const p = await fresh();
  await p.sharePosition(SLUG, true);
  fix();
  await settle();
  const s = await storage();
  assert.equal(s.getPresence(SLUG).on, false, 'off on the device');
  assert.equal(s.getPresence(SLUG).zone, null);
  assert.equal(cleared, 1, 'the position watch stopped');
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence'], 'no DELETE, no retry');
  fix(41, -111, 12);
  await settle();
  assert.equal(puts().length, 1, 'no more positions are sent');
});

test('turning the position off refused with presence_not_active turns presence off here', async () => {
  presenceOn();
  server({ presence: () => json(400, NOT_ACTIVE) });
  const p = await fresh();
  await p.sharePosition(SLUG, false);
  await settle();
  assert.equal((await storage()).getPresence(SLUG).on, false);
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence']);
});

test('another 400 on a fix leaves presence on and only stops the positions, as before', async () => {
  presenceOn();
  geolocation();
  server({ presence: () => json(400, { error: 'location.lat must be a latitude' }) });
  const p = await fresh();
  await p.sharePosition(SLUG, true);
  fix();
  await settle();
  assert.equal((await storage()).getPresence(SLUG).on, true);
  assert.equal(cleared, 1);
});

test('the flag is read by the contract rules, the same as the reference implementation', async () => {
  server();
  await fresh();
  const { offersKeepUntil } = await capabilities();
  const docs = [
    TIER3,
    fixture('tier3-transition.json'),
    fixture('tier2-free.json'),
    fixture('legacy-effective.json'),
    fixture('tier1-demo.json'),
    withoutKeep(TIER3),
    { ...TIER3, people: { ...TIER3.people, presence_keep_until: 'yes' } },
    { ...TIER3, people: { ...TIER3.people, presence: false } },
    { ...TIER3, people: { ...TIER3.people, reports: false } },
    { ...TIER3, people: { ...TIER3.people, enabled: false } },
    { api_version: 1 },
    null,
    [],
  ];
  for (const doc of docs) {
    const want = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? effectiveCapabilities(doc).people.presence_keep_until : false;
    assert.equal(offersKeepUntil(doc), want, JSON.stringify(doc)?.slice(0, 80));
  }
  assert.equal(offersKeepUntil(TIER3), true);
});

// The order of the writes: a write the person asks for (Extend, a zone) after a refused 'keep'
// must still be recorded, and a turn-on answered after presence was turned off elsewhere must not
// leave presence on at the server that the device does not show.

/** The server's presence after the requests so far: on after a successful PUT, off after a DELETE. */
function serverPresence() {
  let on = true;
  for (const c of calls) {
    if (c.path.startsWith('/api/presence') && c.method === 'DELETE') on = false;
    if (c.path === '/api/presence' && c.method === 'PUT' && c.ok) on = true;
  }
  return on;
}

/** Answers PUT /api/presence with `answer(call)` once `gate` resolves, and records the outcome. */
function heldServer({ keepAnswer, until = new Date(Date.now() + 8 * 60 * MIN).toISOString(), gates = {} } = {}) {
  onFetch(async (call) => {
    if (call.path === '/api/capabilities') return json(200, TIER3);
    if (call.method === 'PUT' && call.path === '/api/presence') {
      const gate = gates[call.body.until ?? 'hour'];
      if (gate) await gate.promise;
      const res = call.body.until === 'keep' ? keepAnswer(call) : json(200, { ok: true, zone: call.body.zone, until: call.body.until ?? 'hour', presence_since: new Date().toISOString(), presence_until: until, located: false });
      call.ok = res.status === 200;
      return res;
    }
    return json(200, { ok: true });
  });
  return until;
}

test('Extend queued behind a refused keep is recorded: device and server both stay on', async () => {
  presenceOn({ mode: 'day' });
  const gate = deferred();
  const until = heldServer({ keepAnswer: () => json(400, NOT_ACTIVE), gates: { keep: gate } });
  const p = await fresh();
  const off = p.sharePosition(SLUG, false); // the keep write, held in flight
  await settle();
  const ext = p.extend(SLUG); // the person taps Extend meanwhile
  await settle();
  gate.resolve(); // the keep is refused: presence had run out on the server
  await off;
  assert.equal(await ext, null);
  await settle();
  assert.deepEqual(puts().map((c) => c.body.until), ['keep', 'day']);
  assert.equal(requests().includes('DELETE /api/presence'), false);
  const s = await storage();
  assert.equal(s.getPresence(SLUG).on, true, 'the Extend answer is recorded');
  assert.equal(s.getPresence(SLUG).until, until);
  assert.equal(serverPresence(), true);
});

test('a turn-on answered after another tab turned presence off tells the server: both end off', async () => {
  presenceOn();
  const gate = deferred();
  heldServer({ gates: { hour: gate } });
  const p = await fresh();
  const s = await storage();
  const unwatch = p.watchPresence(SLUG);
  try {
    const ext = p.extend(SLUG); // Extend's PUT is in flight
    await settle();
    // Another tab turns presence off: it writes the stored state, and this tab hears of it.
    localStorage.setItem(`caddie.presence.v1.${SLUG}`, JSON.stringify({ ...JSON.parse(localStorage.getItem(`caddie.presence.v1.${SLUG}`)), on: false, zone: null, until: null }));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: `caddie.presence.v1.${SLUG}` }));
    assert.equal(s.getPresence(SLUG).on, false);
    gate.resolve(); // this tab's PUT lands after the other tab's DELETE
    assert.equal(await ext, null);
    await settle();
    assert.deepEqual(requests(), ['PUT /api/presence', 'DELETE /api/presence'], 'fail closed: the server is told');
    assert.equal(s.getPresence(SLUG).on, false, 'the answer is not recorded');
    assert.equal(serverPresence(), false);
  } finally {
    unwatch();
  }
});

test('a turn-on answered after this tab turned presence off ends off on both sides', async () => {
  presenceOn();
  const gate = deferred();
  heldServer({ gates: { hour: gate } });
  const p = await fresh();
  const ext = p.extend(SLUG);
  await settle();
  const off = p.turnOff(SLUG);
  gate.resolve();
  await off;
  await ext;
  await settle();
  assert.equal(requests()[0], 'PUT /api/presence');
  assert.equal(requests().at(-1), 'DELETE /api/presence');
  assert.equal((await storage()).getPresence(SLUG).on, false);
  assert.equal(serverPresence(), false);
});

test('a turn-on queued behind the fail-closed delete is not undone by it', async () => {
  presenceOn();
  const gate = deferred();
  heldServer({ gates: { hour: gate } });
  const p = await fresh();
  const s = await storage();
  const unwatch = p.watchPresence(SLUG);
  try {
    const first = p.extend(SLUG);
    await settle();
    localStorage.setItem(`caddie.presence.v1.${SLUG}`, JSON.stringify({ ...JSON.parse(localStorage.getItem(`caddie.presence.v1.${SLUG}`)), on: false, zone: null, until: null }));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: `caddie.presence.v1.${SLUG}` }));
    // The person turns presence on again here before the first answer comes back.
    const again = p.turnOn(SLUG, 'Expo hall', '', 'hour');
    gate.resolve();
    await first;
    assert.equal(await again, null);
    await settle();
    // The fail-closed delete was queued after the second turn-on; presence was on by its turn.
    assert.deepEqual(requests(), ['PUT /api/presence', 'PUT /api/presence']);
    assert.equal(s.getPresence(SLUG).on, true);
    assert.equal(s.getPresence(SLUG).zone, 'Expo hall');
  } finally {
    unwatch();
  }
});

test('a keep refused with another 400 reads the capabilities again, and position off is sent once more with the mode', async () => {
  presenceOn({ mode: 'day' });
  // A backend that no longer takes keep (rolled back), while the page still holds the flag.
  heldServer({ keepAnswer: () => json(400, { error: "until must be 'hour' or 'day'" }) });
  const p = await fresh();
  await p.sharePosition(SLUG, false);
  await settle();
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence', 'PUT /api/presence']);
  assert.deepEqual(puts().map((c) => c.body.until), ['keep', 'day'], 'the stored position is still cleared');
  assert.equal(puts()[1].body.location, undefined);
  assert.equal((await storage()).getPresence(SLUG).on, true);
  // The flag is read again for the next write.
  await p.sharePosition(SLUG, false);
  await settle();
  assert.equal(requests().filter((r) => r === 'GET /api/capabilities').length, 2);
});
