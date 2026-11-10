// People API v1 against today's server: requests run through the real route handlers in server/
// with an in-memory stand-in for Elasticsearch, and every answer is checked against the route's
// schema definition in producer (closed) mode. This is what "frozen" means: if a handler's
// response shape drifts from contracts/schema/people-api.v1.schema.json, this test fails.
//
// Nothing here reaches the network: fetch is replaced before the server modules are imported and
// a call to any other host fails the test. The keys, URL and device credentials are dummy values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ES_HOST = 'es.contracts.test';
Object.assign(process.env, {
  ES_URL: `https://${ES_HOST}`,
  ES_PEOPLE_API_KEY: 'test-people-key',
  ES_API_KEY: 'test-read-key',
  ES_INDEX: 'caddie-talks',
  ES_TOPICS_INDEX: 'caddie-topics',
  ES_CONFERENCES_INDEX: 'caddie-conferences',
  ES_PEOPLE_INDEX: 'caddie-people',
  ES_PEOPLE_BLOCKS_INDEX: 'caddie-people-blocks',
  ES_PEOPLE_MEETS_INDEX: 'caddie-people-meets',
  ES_PEOPLE_REPORTS_INDEX: 'caddie-people-reports',
  ES_PEOPLE_PUSH_INDEX: 'caddie-people-push',
  ES_PEOPLE_NUDGES_INDEX: 'caddie-people-nudges',
  ES_RULES_INDEX: 'caddie-people-rules',
  MOD_CLASSIFIER: 'off',
});
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.BLE_NEAR_RSSI;

const EVENT = 'contracts-conf-2099';
const TALK = `${EVENT}:5001`;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const ndjsonLines = (body) => String(body).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The stand-in cluster: people documents in a Map, every other index empty, plus the conference,
// two topics and one talk in Hall A.
const people = new Map();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  const method = init.method ?? 'GET';
  const [index, op, key] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const body = init.body === undefined ? undefined : String(init.body);
  if (op === '_delete_by_query' || op === '_update_by_query') return json({ deleted: 0, updated: 0 });
  if (index === 'caddie-conferences') return json({ hits: { hits: [{ _source: { slug: EVENT, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' } }] } });
  if (index === 'caddie-topics') {
    return json({ hits: { hits: [{ _source: { topic_id: 'kubernetes', label: 'Kubernetes', talk_count: 5 } }, { _source: { topic_id: 'ebpf', label: 'eBPF', talk_count: 3 } }] } });
  }
  if (index === 'caddie-talks') {
    const q = JSON.parse(body ?? '{}');
    if (q.aggs?.rooms) return json({ hits: { hits: [] }, aggregations: { rooms: { buckets: [{ key: 'Hall A', doc_count: 1 }] } } });
    const wanted = JSON.stringify(q).includes(TALK);
    return json({ hits: { hits: wanted ? [{ _id: TALK, _source: { talk_id: TALK, title: 'A talk', start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z', url: 'https://example.org/t', speaker_profiles: [] } }] : [] } });
  }
  if (index === 'caddie-people') {
    if (op === '_doc' && method === 'GET') {
      const s = people.get(key);
      return s ? json({ found: true, _seq_no: 1, _primary_term: 1, _source: structuredClone(s) }) : json({ found: false }, 404);
    }
    if (op === '_doc' && method === 'DELETE') return json({ result: people.delete(key) ? 'deleted' : 'not_found' }, 200);
    if (op === '_bulk') {
      const lines = ndjsonLines(body);
      const items = [];
      for (let i = 0; i < lines.length; i++) {
        const [action, meta] = Object.entries(lines[i])[0];
        if (action === 'delete') {
          items.push({ delete: { status: people.delete(meta._id) ? 200 : 404 } });
          continue;
        }
        const doc = lines[++i];
        if (action === 'create' && people.has(meta._id)) items.push({ create: { status: 409 } });
        else if (action === 'update' && !people.has(meta._id)) items.push({ update: { status: 404 } });
        else {
          people.set(meta._id, action === 'update' ? { ...people.get(meta._id), ...doc.doc } : doc);
          items.push({ [action]: { status: action === 'create' ? 201 : 200 } });
        }
      }
      return json({ items });
    }
    if (op === '_mget') return json({ docs: [] });
    if (op === '_search') {
      const q = JSON.parse(body ?? '{}');
      if (q.aggs?.talks) {
        const n = [...people.values()].filter((s) => (s.shared_talk_ids ?? []).includes(TALK)).length;
        return json({ hits: { hits: [] }, aggregations: { talks: { buckets: n ? [{ key: TALK, doc_count: n }] : [] } } });
      }
      return json({ hits: { hits: [] } });
    }
  }
  if (op === '_search') return json({ hits: { hits: [] } });
  if (op === '_count') return json({ count: 0 });
  if (op === '_bulk') return json({ items: [] });
  return json({ error: 'not in the stand-in' }, 404);
};

const { handlePeopleApi } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');
const { handleBleApi } = await import('../server/ble.mjs');
const { handleReportApi } = await import('../server/report.mjs');
const { handlePushApi } = await import('../server/push.mjs');
const { validator } = await import('../contracts/js/schemas.mjs');
const { formatErrors } = await import('../contracts/js/validate.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = JSON.parse(readFileSync(path.join(ROOT, 'contracts/routes/people-api.v1.json'), 'utf8'));
const HANDLERS = [handlePeopleApi, handleConnectApi, handleBleApi, handleReportApi, handlePushApi];

const newDevice = () => ({ profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') });
let ip = 0;

async function call(method, pathAndQuery, { device, body, headers = {} } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {
    host: 'caddie.test',
    ...(device ? { 'x-caddie-device': `${device.profileId}.${device.secret}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }),
    ...headers,
  };
  ip++;
  req.socket = { remoteAddress: `10.9.${Math.floor(ip / 250)}.${ip % 250}` };
  const res = {
    headersSent: false, status: 0, text: '', headers: {},
    writeHead(status, h) { this.status = status; this.headers = h ?? {}; this.headersSent = true; },
    end(chunk) { this.text = chunk === undefined ? '' : String(chunk); },
    destroy() { this.destroyed = true; },
  };
  const url = new URL(pathAndQuery, 'http://caddie.test');
  let handled = false;
  for (const h of HANDLERS) if ((handled = await h(req, res, url))) break;
  assert.ok(handled, `no handler for ${method} ${url.pathname}`);
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null };
}

// Finds the route a request belongs to and checks the answer against its definition.
function conforms(method, pathname, r) {
  const route = table.routes.find((x) => x.method === method && new RegExp(`^${x.path.replace('{meet_id}', '[A-Za-z0-9_-]{22}')}$`).test(pathname));
  assert.ok(route, `${method} ${pathname} is not in the route table`);
  if (r.status === 200) {
    const result = validator('people-api.v1', route.response)(r.body, { closed: true });
    assert.equal(result.valid, true, `${route.id}\n${formatErrors(result.errors)}\n${JSON.stringify(r.body)}`);
  } else {
    assert.equal(validator('people-api.v1', 'ErrorBody')(r.body, { closed: true }).valid, true, `${route.id} error ${JSON.stringify(r.body)}`);
    const listed = [...table.common_errors, ...route.errors].some((e) => e.status === r.status && (e.error === r.body.error || e.error === '*'));
    assert.ok(listed, `${route.id}: ${r.status} ${r.body.error} is not listed`);
  }
  return route;
}

const me = newDevice();
const other = newDevice();
const profileBody = (over = {}) => ({ event: EVENT, profile: { display_name: 'Conformance Tester', about: 'Testing the contract.', interests: 'eBPF', expertise: 'Kubernetes upgrades', learn_topics: ['ebpf'], speak_topics: ['kubernetes'], linkedin_url: null, contact_note: null }, open_to_meet: true, shared_talk_ids: [TALK], ...over });

test('profile writes answer the frozen shape', async () => {
  const created = await call('PUT', '/api/people/profile', { device: me, body: profileBody() });
  assert.equal(created.status, 200);
  conforms('PUT', '/api/people/profile', created);
  const again = await call('PUT', '/api/people/profile', { device: me, body: profileBody({ shared_talk_ids: [] }) });
  assert.equal(again.status, 200);
  conforms('PUT', '/api/people/profile', again);
  const second = await call('PUT', '/api/people/profile', { device: other, body: profileBody() });
  conforms('PUT', '/api/people/profile', second);
});

test('presence with Bluetooth (server-rotate today), rotation and sightings answer the frozen shapes', async () => {
  const on = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A', spot: null, location: { lat: 40.1, lon: -111.9, accuracy: 20 }, until: 'hour', ble: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  conforms('PUT', '/api/presence', on);
  assert.match(on.body.ble.token, /^[A-Za-z0-9_-]{22}$/, 'today the server is in server-rotate mode');
  assert.equal(on.body.ble_key, undefined, 'ble_key arrives with derived-v1 in Phase 4');
  const zoneOnly = await call('PUT', '/api/presence', { device: other, body: { event: EVENT, zone: 'Expo hall' } });
  conforms('PUT', '/api/presence', zoneOnly);

  const rotated = await call('POST', '/api/presence/ble/rotate', { device: me, body: { event: EVENT } });
  assert.equal(rotated.status, 200);
  conforms('POST', '/api/presence/ble/rotate', rotated);

  const weak = await call('POST', '/api/presence/sightings', { device: me, body: { event: EVENT, sightings: [{ token: 'A'.repeat(22), rssi: -90 }] } });
  assert.deepEqual(weak.body, { nearby: [] });
  conforms('POST', '/api/presence/sightings', weak);
  const notBroadcasting = await call('POST', '/api/presence/sightings', { device: other, body: { event: EVENT, sightings: [] } });
  assert.equal(notBroadcasting.status, 403);
  assert.equal(notBroadcasting.body.error, 'ble_required');
  conforms('POST', '/api/presence/sightings', notBroadcasting);
});

test('reads answer the frozen shapes', async () => {
  const blocks = await call('GET', `/api/people/blocks?event=${EVENT}`, { device: me });
  assert.equal(blocks.status, 200);
  conforms('GET', '/api/people/blocks', blocks);
  const inbox = await call('GET', `/api/meet/inbox?event=${EVENT}`, { device: me });
  assert.equal(inbox.status, 200);
  conforms('GET', '/api/meet/inbox', inbox);
  const counts = await call('POST', '/api/circles/counts', { body: { event: EVENT, talk_ids: [TALK] } });
  assert.equal(counts.status, 200);
  conforms('POST', '/api/circles/counts', counts);
  assert.equal(counts.body.counts[TALK], 1);
  const vapid = await call('GET', '/api/push/vapid');
  assert.deepEqual(vapid.body, { publicKey: null });
  conforms('GET', '/api/push/vapid', vapid);
  const members = await call('POST', '/api/circles/members', { device: me, body: { event: EVENT, talk_id: TALK } });
  assert.equal(members.status, 403);
  assert.equal(members.body.error, 'share_required');
  conforms('POST', '/api/circles/members', members);
  const missingMeet = await call('GET', `/api/meet/${'A'.repeat(22)}`, { device: me });
  assert.equal(missingMeet.status, 404);
  conforms('GET', `/api/meet/${'A'.repeat(22)}`, missingMeet);
});

test('error envelopes and status codes are the frozen ones', async () => {
  const noDevice = await call('PUT', '/api/presence', { body: { event: EVENT, zone: 'Hall A' } });
  assert.deepEqual([noDevice.status, noDevice.body], [403, { error: 'forbidden' }]);
  conforms('PUT', '/api/presence', noDevice);
  const wrongSecret = await call('PUT', '/api/people/profile', { device: { ...me, secret: crypto.randomBytes(32).toString('base64url') }, body: profileBody() });
  assert.deepEqual([wrongSecret.status, wrongSecret.body], [403, { error: 'forbidden' }]);
  const unknownKey = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A', mood: 'fine' } });
  assert.equal(unknownKey.status, 400);
  conforms('PUT', '/api/presence', unknownKey);
  const badZone = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'The moon' } });
  assert.equal(badZone.status, 400);
  const wrongType = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A' }, headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  conforms('PUT', '/api/presence', wrongType);
  const wrongMethod = await call('PATCH', '/api/presence', { device: me });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, 'PUT, DELETE');
  const crossOrigin = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A' }, headers: { origin: 'https://evil.example' } });
  assert.deepEqual([crossOrigin.status, crossOrigin.body], [403, { error: 'cross-origin request' }]);
  const tooBig = await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A', spot: 'x'.repeat(9000) } });
  assert.equal(tooBig.status, 413);
});

test('ending presence and deleting the profile answer { ok: true }', async () => {
  const off = await call('DELETE', `/api/presence?event=${EVENT}`, { device: me });
  assert.deepEqual([off.status, off.body], [200, { ok: true }]);
  conforms('DELETE', '/api/presence', off);
  const gone = await call('DELETE', `/api/people/profile?event=${EVENT}`, { device: me });
  assert.deepEqual([gone.status, gone.body], [200, { ok: true }]);
  conforms('DELETE', '/api/people/profile', gone);
  const noProfile = await call('GET', `/api/people/blocks?event=${EVENT}`, { device: me });
  assert.deepEqual([noProfile.status, noProfile.body], [403, { error: 'profile_required' }]);
});
