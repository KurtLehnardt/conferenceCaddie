// The profile delete in server/people.mjs, run against an in-memory stand-in for Elasticsearch.
//
// Run with `npm test`. Nothing here reaches the network: fetch is replaced before server/people.mjs
// is imported, every Elasticsearch call is answered from memory, and a call to any other host
// fails the test. The keys and the URL below are dummy values.
//
// Both routes that delete a profile are covered: DELETE /api/people/profile, and PUT with both
// visibility choices off. For each the tests check that
// - the profile is hidden first, then meets, push subscriptions and nudge records are deleted,
//   then blocks, and the document last, followed by a second pass over the connections;
// - when any step after the hide fails, the request answers 502, no block and no document has
//   been deleted, and the profile stays hidden with its secret hash, so a retry can authenticate;
// - trying again after such a failure finishes the delete;
// - a failure in the second pass, once the document is gone, still answers 200 and is logged.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const ES_HOST = 'es.caddie.test';
Object.assign(process.env, {
  ES_URL: `https://${ES_HOST}`,
  ES_PEOPLE_API_KEY: 'test-people-key',
  ES_API_KEY: 'test-read-key',
  ES_PEOPLE_INDEX: 'caddie-people',
  ES_PEOPLE_BLOCKS_INDEX: 'caddie-people-blocks',
  ES_PEOPLE_MEETS_INDEX: 'caddie-people-meets',
  ES_PEOPLE_PUSH_INDEX: 'caddie-people-push',
  ES_PEOPLE_NUDGES_INDEX: 'caddie-people-nudges',
  ES_CONFERENCES_INDEX: 'caddie-conferences',
});

const EVENT = 'testconf-2099';
const FUTURE = '2099-12-31T23:59:59.000Z';
// The connection indices by the short name the call log uses.
const CONNECTIONS = { blocks: 'caddie-people-blocks', meets: 'caddie-people-meets', push: 'caddie-people-push', nudges: 'caddie-people-nudges' };
const INDEX_NAMES = Object.fromEntries(Object.entries(CONNECTIONS).map(([k, v]) => [v, k]));

// One stand-in cluster per test, set by fakeCluster(). The hourly purge that server/people.mjs
// starts on import is answered but never recorded, so it cannot disturb a test.
let cluster = null;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const ndjsonLines = (body) => String(body).split('\n').filter(Boolean).map((l) => JSON.parse(l));

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  const method = init.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [index, op] = parts;
  const isPurge = op === '_delete_by_query' || op === '_update_by_query' || url.searchParams.get('preference') === 'caddie-people-purge';
  if (isPurge) return op === '_search' ? json({ hits: { hits: [] } }) : json({ deleted: 0, updated: 0 });
  if (index === 'caddie-conferences' && op === '_search') {
    return json({ hits: { hits: [{ _source: { slug: EVENT, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' } }] } });
  }
  if (!cluster) throw new Error(`no stand-in cluster for ${method} ${url.pathname}`);
  return cluster.handle(method, index, op, parts[2], init.body);
};

const { handlePeopleApi, PRESENCE_OFF } = await import('../server/people.mjs');

// A fresh device credential in the client's format.
function newDevice() {
  return { profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') };
}
const hashOf = (secret) => crypto.createHash('sha256').update(secret, 'utf8').digest('hex');

// An in-memory cluster holding one live, visible, present profile and some documents in each
// connection index. failures lists the calls that fail, by log tag (hide, search:<index>,
// bulk:<index>, delete-doc) and occurrence: { tag, nth = 1, how } where how is 503 (HTTP status),
// network (fetch rejects), timeout (fetch rejects with a TimeoutError) or item429 / item500 /
// item404 (the Bulk answer is 200 and its item carries that status).
function fakeCluster(device, { failures = [] } = {}) {
  const id = `${EVENT}:${device.profileId}`;
  const now = Date.now();
  const state = {
    log: [],
    failures: [...failures],
    profile: {
      event_id: EVENT,
      profile_id: device.profileId,
      secret_hash: hashOf(device.secret),
      display_name: 'Test person',
      open_to_meet: true,
      shared_talk_ids: [`${EVENT}:talk1`],
      visible_until: FUTURE,
      presence_zone: 'Hallway',
      presence_spot: 'by the coffee',
      presence_spot_pending: false,
      presence_since: new Date(now).toISOString(),
      presence_until: new Date(now + 3600_000).toISOString(),
      presence_location: { lat: 1.23456, lon: 2.34567 },
      presence_accuracy: 12,
      ble_token: 'dGVzdC10b2tlbi0xNi1i',
      ble_token_until: new Date(now + 600_000).toISOString(),
    },
    docs: {
      blocks: new Set([`${EVENT}:${device.profileId}:other1`, `${EVENT}:other2:${device.profileId}`]),
      meets: new Set(['meet-one', 'meet-two']),
      push: new Set(['push-one']),
      nudges: new Set(['nudge-one']),
    },
  };
  const counts = new Map();
  // Returns the Response a failing call answers with, or throws for a transport failure, or
  // returns null when this call does not fail.
  const failure = (tag) => {
    const n = (counts.get(tag) ?? 0) + 1;
    counts.set(tag, n);
    const f = state.failures.find((x) => x.tag === tag && (x.nth ?? 1) === n);
    if (!f) return null;
    state.failures.splice(state.failures.indexOf(f), 1);
    if (f.how === 'network') throw new TypeError('fetch failed');
    if (f.how === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    if (f.how === 503) return new Response('{}', { status: 503 });
    const item = Number(String(f.how).replace('item', ''));
    return json({ errors: true, items: [{ [tag === 'hide' ? 'update' : 'delete']: { status: item } }] });
  };
  state.handle = async (method, index, op, docKey, body) => {
    if (index === 'caddie-people' && op === '_doc' && method === 'GET') {
      state.log.push('get');
      if (docKey !== id || !state.profile) return json({ found: false }, 404);
      return json({ found: true, _seq_no: 7, _primary_term: 1, _source: { ...state.profile } });
    }
    if (index === 'caddie-people' && op === '_bulk') {
      const [action, payload] = ndjsonLines(body);
      if (!action.update || action.update._id !== id) throw new Error(`unexpected people bulk ${JSON.stringify(action)}`);
      state.log.push('hide');
      const failed = failure('hide');
      if (failed) return failed;
      if (!state.profile) return json({ items: [{ update: { status: 404 } }] });
      Object.assign(state.profile, payload.doc);
      return json({ items: [{ update: { status: 200 } }] });
    }
    if (index === 'caddie-people' && op === '_doc' && method === 'DELETE') {
      state.log.push('delete-doc');
      const failed = failure('delete-doc');
      if (failed) return failed;
      const found = docKey === id && state.profile !== null;
      if (found) state.profile = null;
      return json({ result: found ? 'deleted' : 'not_found' }, found ? 200 : 404);
    }
    const name = INDEX_NAMES[index];
    if (name && op === '_search') {
      state.log.push(`search:${name}`);
      const failed = failure(`search:${name}`);
      if (failed) return failed;
      return json({ hits: { hits: [...state.docs[name]].map((_id) => ({ _id })) } });
    }
    if (name && op === '_bulk') {
      state.log.push(`bulk:${name}`);
      const failed = failure(`bulk:${name}`);
      if (failed) return failed;
      const items = ndjsonLines(body).map((line) => {
        const removed = state.docs[name].delete(line.delete._id);
        return { delete: { status: removed ? 200 : 404 } };
      });
      return json({ items });
    }
    throw new Error(`unexpected ${method} /${index}/${op ?? ''}`);
  };
  return state;
}

let ipCounter = 0;

// Runs one request through the people routes and returns { status, body }.
async function request(method, path, device, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {
    host: 'caddie.test',
    'x-caddie-device': `${device.profileId}.${device.secret}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }),
  };
  ipCounter++;
  req.socket = { remoteAddress: `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` };
  const res = {
    headersSent: false,
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(chunk) {
      this.text = chunk === undefined ? '' : String(chunk);
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const handled = await handlePeopleApi(req, res, new URL(path, 'http://caddie.test'));
  assert.equal(handled, true);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}

// The two routes that delete a profile.
const ROUTES = {
  'DELETE /api/people/profile': (device) => request('DELETE', `/api/people/profile?event=${EVENT}`, device),
  'PUT /api/people/profile with both choices off': (device) => request('PUT', '/api/people/profile', device, {
    event: EVENT,
    profile: { display_name: 'Test person' },
    open_to_meet: false,
    shared_talk_ids: [],
  }),
};

const FIRST_PASS = ['search:meets', 'bulk:meets', 'search:push', 'bulk:push', 'search:nudges', 'bulk:nudges', 'search:blocks', 'bulk:blocks'];
const SECOND_PASS = ['search:meets', 'search:push', 'search:nudges', 'search:blocks'];
// Steps before the blocks: a failure in any of them must leave every block in place.
const BEFORE_BLOCKS = ['search:meets', 'bulk:meets', 'search:push', 'bulk:push', 'search:nudges', 'bulk:nudges'];

// Runs fn with console.error silenced and returns its result and the lines it would have logged.
async function quietly(fn) {
  const lines = [];
  const spy = mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}

function assertHidden(state, device) {
  assert.ok(state.profile, 'the profile document is still stored');
  assert.equal(state.profile.open_to_meet, false);
  assert.deepEqual(state.profile.shared_talk_ids, []);
  for (const field of Object.keys(PRESENCE_OFF)) assert.equal(state.profile[field], null, `${field} is cleared`);
  assert.equal(state.profile.secret_hash, hashOf(device.secret), 'the secret hash survives for a retry');
  assert.equal(state.profile.visible_until, FUTURE, 'visible_until is left alone');
}

function assertAllGone(state) {
  assert.equal(state.profile, null, 'the profile document is deleted');
  for (const [name, ids] of Object.entries(state.docs)) assert.equal(ids.size, 0, `every ${name} document is deleted`);
}

for (const [route, send] of Object.entries(ROUTES)) {
  describe(route, () => {
    test('hides the profile, deletes meets, push and nudges, then blocks, then the document', async () => {
      const device = newDevice();
      const state = fakeCluster(device);
      cluster = state;
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      if (route.startsWith('PUT')) assert.deepEqual(result.body, { ok: true, open_to_meet: false, shared_talk_ids: [] });
      else assert.deepEqual(result.body, { ok: true });
      assert.deepEqual(state.log, ['get', 'hide', ...FIRST_PASS, 'delete-doc', ...SECOND_PASS]);
      assertAllGone(state);
    });

    for (const tag of BEFORE_BLOCKS) {
      const modes = tag.startsWith('bulk:') ? [503, 'network', 'item429'] : [503, 'network', 'timeout'];
      for (const how of modes) {
        test(`a failure at ${tag} (${how}) keeps every block and the hidden document, and a retry finishes`, async () => {
          const device = newDevice();
          const state = fakeCluster(device, { failures: [{ tag, how }] });
          cluster = state;
          const first = await quietly(() => send(device));
          assert.equal(first.result.status, 502);
          assert.ok(!state.log.includes('bulk:blocks'), 'no block was deleted');
          assert.ok(!state.log.includes('delete-doc'), 'the document was not deleted');
          assert.equal(state.docs.blocks.size, 2, 'every block is still stored');
          assertHidden(state, device);

          state.log.length = 0;
          const retry = await quietly(() => send(device));
          assert.equal(retry.result.status, 200);
          assert.deepEqual(state.log.slice(0, 2), ['get', 'hide']);
          assertAllGone(state);
        });
      }
    }

    for (const [tag, how] of [['search:blocks', 503], ['bulk:blocks', 'item429'], ['delete-doc', 503], ['delete-doc', 'timeout']]) {
      test(`a failure at ${tag} (${how}) keeps the hidden document, and a retry finishes`, async () => {
        const device = newDevice();
        const state = fakeCluster(device, { failures: [{ tag, how }] });
        cluster = state;
        const first = await quietly(() => send(device));
        assert.equal(first.result.status, 502);
        assertHidden(state, device);
        state.log.length = 0;
        const retry = await quietly(() => send(device));
        assert.equal(retry.result.status, 200);
        assertAllGone(state);
      });
    }

    for (const how of [503, 'item500']) {
      test(`a failed hide (${how}) answers 502 and deletes nothing`, async () => {
        const device = newDevice();
        const state = fakeCluster(device, { failures: [{ tag: 'hide', how }] });
        cluster = state;
        const { result } = await quietly(() => send(device));
        assert.equal(result.status, 502);
        assert.deepEqual(state.log, ['get', 'hide']);
        assert.equal(state.profile.open_to_meet, true, 'the profile is unchanged');
        assert.equal(state.docs.blocks.size + state.docs.meets.size + state.docs.push.size + state.docs.nudges.size, 6);
      });
    }

    test('a document gone before the hide (404) answers 200 and deletes nothing', async () => {
      const device = newDevice();
      const state = fakeCluster(device, { failures: [{ tag: 'hide', how: 'item404' }] });
      cluster = state;
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.deepEqual(state.log, ['get', 'hide']);
    });

    test('a wrong device secret answers 403 before anything is hidden', async () => {
      const device = newDevice();
      const state = fakeCluster(device);
      cluster = state;
      const { result } = await quietly(() => send({ ...device, secret: newDevice().secret }));
      assert.equal(result.status, 403);
      assert.deepEqual(state.log, ['get']);
      assert.equal(state.profile.open_to_meet, true);
    });

    test('a failure in the second pass, after the document is gone, answers 200 and is logged', async () => {
      const device = newDevice();
      const state = fakeCluster(device, { failures: [{ tag: 'search:meets', nth: 2, how: 503 }] });
      cluster = state;
      const { result, lines } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.equal(state.profile, null);
      assert.deepEqual(lines, ["Deleting a deleted profile's connections again failed: status 503"]);
    });
  });
}
