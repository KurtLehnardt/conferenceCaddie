// server/people-delete.mjs, the profile delete the server and the caddie-admin CLI share: it has
// no side effect at import, and its factory refuses a client it cannot run with. The order and
// the retry safety of the delete itself are the business of test/delete-profile.test.mjs, which
// runs the server's routes; the CLI's parity with them is checked in test/admin-es.test.mjs.
//
// Run with `npm test`. Nothing here reaches the network: fetch is replaced by a function that
// fails the test if called, before the module is imported, and no server module is imported.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.fetch = async (...args) => {
  calls.push(args);
  throw new Error('fetch must not be called at import');
};
const timers = [];
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  timers.push(args);
  return originalSetInterval(...args);
};

const mod = await import('../server/people-delete.mjs');

globalThis.setInterval = originalSetInterval;

describe('ATT-6 import purity', () => {
  test('importing the module makes no request and starts no timer', () => {
    assert.deepEqual(calls, []);
    assert.deepEqual(timers, []);
  });

  test('exports the factory and the constants the server and the tests read', () => {
    assert.equal(typeof mod.createProfileDelete, 'function');
    assert.equal(typeof mod.ownBlocksQuery, 'function');
    assert.equal(mod.HIDE_RETRIES, 3);
    assert.equal(mod.HIDE_FOR_DELETE.open_to_meet, false);
    assert.deepEqual(mod.HIDE_FOR_DELETE.shared_talk_ids, []);
    assert.equal(mod.HIDE_FOR_DELETE.presence_zone, null);
    assert.equal(mod.HIDE_FOR_DELETE.ble_token, null);
  });
});

describe('createProfileDelete', () => {
  const indices = { people: 'p', meets: 'm', push: 'u', nudges: 'n', blocks: 'b' };
  const deps = { people: async () => ({ status: 200, json: {} }), withPreference: (p) => p, peoplePreference: () => 'x', indices };

  test('refuses a missing transport or index name', () => {
    assert.throws(() => mod.createProfileDelete({ ...deps, people: undefined }), /people transport/);
    for (const name of Object.keys(indices)) {
      assert.throws(() => mod.createProfileDelete({ ...deps, indices: { ...indices, [name]: '' } }), new RegExp(`indices\\.${name}`));
    }
  });

  test('returns the five steps and builds bulkOne and deleteDoc from the transport when absent', async () => {
    const seen = [];
    const people = async (method, path, body, opts) => {
      seen.push({ method, path, body, opts });
      if (path.includes('_bulk')) return { status: 200, json: { items: [{ update: { status: 404 } }] } };
      return { status: 200, json: { hits: { hits: [] } } };
    };
    const d = mod.createProfileDelete({ ...deps, people });
    assert.deepEqual(Object.keys(d), ['deleteWhere', 'deleteMeetsPushAndNudges', 'deleteOwnBlocks', 'deleteConnections', 'deleteProfileAndConnections']);
    // A document gone before the hide (item 404) ends the delete after the one Bulk call.
    await d.deleteProfileAndConnections('ev', 'pid');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].path, '/p/_bulk?refresh=wait_for');
    assert.equal(seen[0].opts.ndjson, true);
    const [action, payload] = seen[0].body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(action, { update: { _id: 'ev:pid', retry_on_conflict: 3 } });
    assert.deepEqual(payload, { doc: mod.HIDE_FOR_DELETE });
  });

  test('a failed step throws the injected error class', async () => {
    class Boom extends Error {}
    const people = async (method, path) => (path.includes('_bulk') ? { status: 200, json: { items: [{ update: { status: 500 } }] } } : { status: 200, json: {} });
    const d = mod.createProfileDelete({ ...deps, people, UpstreamError: Boom });
    await assert.rejects(() => d.deleteProfileAndConnections('ev', 'pid'), (err) => err instanceof Boom && err.message === 'bulk item status 500');
  });
});
