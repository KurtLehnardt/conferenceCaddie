// The Android companion's Bluetooth writes (web/src/people/ble.ts) while presence is on: turning
// Bluetooth on, and the writes that clear the token without a tap (the 'stale' alarm, the rotate
// timer's not_running, a failed start, a switch of conference), send until: 'keep' where the
// backend's capabilities say people.presence_keep_until, and the mode elsewhere. A 'keep' refused
// with 400 presence_not_active ends presence on the device and starts nothing; another 400 reads
// the capabilities again and sends the write once more with the mode.
//
// The Capacitor bridge is faked before ble.ts loads it: a custom 'android' platform whose CaddieBle
// calls land in `plugin` below. Each case imports its own copy of ble.ts (the query), so the
// session, presence and capabilities modules start fresh; `storage()` reaches that copy's store.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calls, json, onFetch, requests, resetFake, settle } from './env.mjs';

const SLUG = 'testconf-2099';
const MIN = 60_000;
const CAPS = new URL('../../contracts/fixtures/capabilities/', import.meta.url);
const fixture = (f) => JSON.parse(readFileSync(new URL(f, CAPS), 'utf8'));
const TIER3 = fixture('tier3-paid.json');
const NOT_ACTIVE = { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." };

// The fake plugin: every call is recorded, and listeners are kept by event name.
const plugin = { calls: [], listeners: new Map() };
const ANSWERS = {
  isAvailable: { available: true, enabled: true, extended: true, rationale: {} },
  checkPermissions: { granted: true },
  requestPermissions: { granted: true },
  isRunning: { running: false },
};
const METHODS = ['isAvailable', 'checkPermissions', 'requestPermissions', 'start', 'rotate', 'stop', 'isRunning', 'notify', 'removeListener'];
globalThis.CapacitorCustomPlatform = { name: 'android' };
globalThis.Capacitor = {
  PluginHeaders: [{ name: 'CaddieBle', methods: [...METHODS.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }] }],
  nativePromise: async (_name, method, options) => {
    plugin.calls.push(method);
    return ANSWERS[method];
  },
  nativeCallback: (_name, method, options, callback) => {
    plugin.calls.push(`${method}:${options?.eventName}`);
    plugin.listeners.set(options?.eventName, callback);
    return Promise.resolve(String(plugin.calls.length));
  },
};
// ble.ts registers the plugin once per copy; Capacitor warns about the repeats.
console.warn = () => {};

let n = 0;
let ble;
async function fresh() {
  n++;
  ble = await import(`../src/people/ble.ts?ble${n}`);
  return ble;
}
const storage = () => import(`../src/people/storage.ts?ble${n}`);

function device() {
  localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'p'.repeat(22), secret: 's'.repeat(43) }));
}

const UNTIL = new Date(Date.now() + 40 * MIN).toISOString();
function presenceOn({ mode = 'hour' } = {}) {
  localStorage.setItem(`caddie.presence.v1.${SLUG}`, JSON.stringify({
    on: true, zone: 'Hallway', spot: 'Green jacket', until: UNTIL, notice_seen: true,
    position: false, position_choice: 'no', mode, confirmed_at: new Date().toISOString(), confirm_pending: false, recent_zones: ['Hallway'],
  }));
}

const TOKEN = { token: 'A'.repeat(22), rotate_at: new Date(Date.now() + 10 * MIN).toISOString() };
/** keep(call) answers a keep write; everything else succeeds. */
function server({ caps = TIER3, keep = () => null } = {}) {
  onFetch((call) => {
    if (call.path === '/api/capabilities') return json(200, caps);
    if (call.method === 'PUT' && call.path === '/api/presence') {
      const refused = call.body.until === 'keep' ? keep(call) : null;
      if (refused) return refused;
      return json(200, { ok: true, zone: call.body.zone, until: call.body.until ?? 'hour', presence_until: UNTIL, located: false, ...(call.body.ble ? { ble: TOKEN } : {}) });
    }
    return json(200, { ok: true });
  });
}
const puts = () => calls.filter((c) => c.method === 'PUT' && c.path === '/api/presence');
const withoutKeep = (doc) => ({ ...doc, people: Object.fromEntries(Object.entries(doc.people).filter(([k]) => k !== 'presence_keep_until')) });
const keepFlag = (doc, value) => ({ ...doc, people: { ...doc.people, presence_keep_until: value } });

/** The plugin reports that it stopped, as the 11-minute alarm ('stale') does. */
async function stopped(reason) {
  plugin.listeners.get('stopped')({ reason });
  await settle();
}

beforeEach(() => {
  resetFake();
  plugin.calls.length = 0;
  plugin.listeners.clear();
  device();
});

test('turning Bluetooth on, and the stale alarm clearing it, send keep where the backend offers it', async () => {
  presenceOn();
  server();
  const b = await fresh();
  assert.equal(await b.startBle(SLUG), null);
  assert.ok(plugin.calls.includes('start'));
  await stopped('stale');
  assert.deepEqual(puts().map((c) => [c.body.ble, c.body.until]), [[true, 'keep'], [false, 'keep']]);
  assert.equal(requests().filter((r) => r === 'GET /api/capabilities').length, 1);
  const p = (await storage()).getPresence(SLUG);
  assert.equal(p.on, true);
  assert.equal(p.until, UNTIL, 'the end of presence on the device is unchanged');
});

test('without the flag the Bluetooth writes send the mode, as before', async () => {
  for (const [label, caps, mode, until] of [['no flag, day', withoutKeep(TIER3), 'day', 'day'], ['flag false, hour', keepFlag(fixture('tier2-free.json'), false), 'hour', undefined]]) {
    resetFake();
    plugin.calls.length = 0;
    device();
    presenceOn({ mode });
    server({ caps });
    const b = await fresh();
    assert.equal(await b.startBle(SLUG), null, label);
    await stopped('stale');
    assert.deepEqual(puts().map((c) => [c.body.ble, c.body.until]), [[true, until], [false, until]], label);
  }
});

test('turning Bluetooth on refused with presence_not_active ends presence here and starts nothing', async () => {
  presenceOn();
  server({ keep: () => json(400, NOT_ACTIVE) });
  const b = await fresh();
  assert.equal(await b.startBle(SLUG), 'Turn on being around first.');
  assert.equal(plugin.calls.includes('start'), false, 'the plugin never started');
  assert.equal(b.getBle(SLUG).on, false);
  assert.equal((await storage()).getPresence(SLUG).on, false, 'off on the device');
  assert.deepEqual(requests(), ['GET /api/capabilities', 'PUT /api/presence'], 'no DELETE, no retry');
});

test('the stale alarm clearing a token refused with presence_not_active ends presence here', async () => {
  presenceOn();
  let refuse = false;
  server({ keep: () => (refuse ? json(400, NOT_ACTIVE) : null) });
  const b = await fresh();
  assert.equal(await b.startBle(SLUG), null);
  refuse = true; // presence runs out on the server meanwhile
  await stopped('stale');
  assert.deepEqual(puts().map((c) => [c.body.ble, c.body.until]), [[true, 'keep'], [false, 'keep']]);
  assert.equal((await storage()).getPresence(SLUG).on, false);
  assert.equal(b.getBle(SLUG).on, false);
  assert.equal(requests().includes('DELETE /api/presence'), false);
});

test('a keep refused with another 400 is sent once more with the mode, so Bluetooth still starts', async () => {
  presenceOn({ mode: 'day' });
  server({ keep: () => json(400, { error: "until must be 'hour' or 'day'" }) });
  const b = await fresh();
  assert.equal(await b.startBle(SLUG), null);
  assert.deepEqual(puts().map((c) => [c.body.ble, c.body.until]), [[true, 'keep'], [true, 'day']]);
  assert.ok(plugin.calls.includes('start'));
  // The capabilities are read again for the next write.
  await stopped('stale');
  assert.equal(requests().filter((r) => r === 'GET /api/capabilities').length, 2);
});
