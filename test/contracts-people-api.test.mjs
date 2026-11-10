// People API v1 (docs/contracts/people-api.md), statically: the route table names real schema
// definitions, every route has example fixtures that validate, and every route the contract
// freezes is still mounted by the server with the same methods.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, validator } from '../contracts/js/schemas.mjs';
import { formatErrors } from '../contracts/js/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = JSON.parse(readFileSync(path.join(ROOT, 'contracts/routes/people-api.v1.json'), 'utf8'));
const schema = loadSchemas().get('people-api.v1');
const FIX = path.join(ROOT, 'contracts/fixtures/people-api');
const fixtures = new Map(readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(FIX, f), 'utf8'))]));

test('the route table and the schema agree', () => {
  assert.equal(table.schema, schema.$id);
  const ids = new Set();
  const keys = new Set();
  for (const r of table.routes) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    const key = `${r.method} ${r.path}`;
    assert.ok(!keys.has(key), `duplicate route ${key}`);
    keys.add(key);
    if (r.request !== null) assert.ok(schema.$defs[r.request], `${r.id}: no $defs/${r.request}`);
    assert.ok(schema.$defs[r.response], `${r.id}: no $defs/${r.response}`);
    for (const l of r.limits) assert.ok(table.limits[l], `${r.id}: no limit ${l}`);
    if (r.method === 'GET') assert.equal(r.request, null, `${r.id}: GET has no body`);
    if (r.query.includes('event')) assert.ok(r.method === 'GET' || r.method === 'DELETE', `${r.id}: event in the query only for GET and DELETE`);
  }
});

test('every route has example fixtures, and every fixture names a route', () => {
  const ids = new Set(table.routes.map((r) => r.id));
  for (const id of ids) assert.ok(fixtures.has(id), `no fixture for ${id}`);
  for (const [name, f] of fixtures) {
    assert.equal(f.route, name);
    assert.ok(ids.has(name), `fixture ${name} names no route`);
    assert.ok(Array.isArray(f.examples) && f.examples.length > 0, name);
  }
});

test('example requests and responses validate against the route definitions', () => {
  const errorBody = validator('people-api.v1', 'ErrorBody');
  const device = validator('people-api.v1', 'DeviceHeader');
  for (const r of table.routes) {
    const reqCheck = r.request ? validator('people-api.v1', r.request) : null;
    const resCheck = validator('people-api.v1', r.response);
    const allowed = [...table.common_errors, ...r.errors];
    for (const ex of fixtures.get(r.id).examples) {
      const label = `${r.id}: ${ex.name}`;
      const headers = ex.request.headers ?? {};
      if (r.auth === 'device') {
        const h = headers['X-Caddie-Device'];
        assert.equal(device(h).valid, true, `${label}: device header`);
      } else {
        assert.equal(headers['X-Caddie-Device'], undefined, `${label}: a public route takes no device header`);
      }
      for (const q of Object.keys(ex.request.query ?? {})) assert.ok(r.query.includes(q), `${label}: query ${q}`);
      if (r.path.includes('{meet_id}')) assert.match(ex.request.path_params?.meet_id ?? '', /^[A-Za-z0-9_-]{22}$/, label);
      if (ex.request.body !== undefined) {
        assert.ok(reqCheck, `${label}: this route takes no body`);
        const result = reqCheck(ex.request.body, { closed: true });
        if (ex.invalid_request) assert.equal(result.valid, false, `${label}: the request should be invalid`);
        else assert.equal(result.valid, true, `${label} request\n${formatErrors(result.errors)}`);
      }
      const { status, body } = ex.response;
      if (status >= 200 && status < 300) {
        const result = resCheck(body, { closed: true });
        assert.equal(result.valid, true, `${label} response\n${formatErrors(result.errors)}`);
      } else {
        assert.equal(errorBody(body, { closed: true }).valid, true, `${label}: error body`);
        // A listed code wins over a free-text ("*") entry for the same status.
        const spec = allowed.find((e) => e.status === status && e.error === body.error) ?? allowed.find((e) => e.status === status && e.error === '*');
        assert.ok(spec, `${label}: ${status} ${body.error} is not listed for this route`);
        for (const k of Object.keys(body)) if (k !== 'error') assert.ok((spec.extra ?? []).includes(k), `${label}: unexpected key ${k}`);
        for (const k of spec.extra ?? []) if (spec.error !== '*') assert.ok(k in body, `${label}: missing ${k}`);
      }
    }
  }
});

test('the derived-v1 presence response carries ble_key; the legacy one carries ble; the meet read alone has a distance', () => {
  const presence = fixtures.get('presence.put').examples;
  assert.ok(presence.some((e) => typeof e.response.body.ble_key === 'string' && !e.response.body.ble));
  assert.ok(presence.some((e) => e.response.body.ble && !e.response.body.ble_key));
  // The derived-v1 variants require the key and its id.
  const derivedPresence = validator('people-api.v1', 'PresencePutResponseDerived');
  for (const e of presence.filter((x) => x.response.status === 200)) {
    assert.equal(derivedPresence(e.response.body, { closed: true }).valid, typeof e.response.body.ble_key === 'string', e.name);
  }
  const derivedSightings = validator('people-api.v1', 'SightingsResponseDerived');
  const sightings = fixtures.get('sightings').examples.filter((x) => x.response.status === 200);
  assert.ok(sightings.some((e) => derivedSightings(e.response.body, { closed: true }).valid));
  assert.ok(sightings.some((e) => !derivedSightings(e.response.body).valid), 'a server-rotate answer has no key id');
  assert.equal(validator('people-api.v1', 'Person')({ ...fixtures.get('matches').examples[0].response.body.results[0], contact: { linkedin_url: 'https://evil.example/in/x', contact_note: null } }).valid, false);
  const action = validator('people-api.v1', 'MeetActionResponse');
  const read = fixtures.get('meet.get').examples.find((e) => e.response.status === 200).response.body;
  assert.equal(typeof read.other.distance_m, 'number');
  assert.equal(action({ ok: true, ...read }).valid, false, 'an action response never carries a distance');
  const inbox = validator('people-api.v1', 'InboxResponse');
  assert.equal(inbox({ incoming: [{ ...read, from: { ref: '0123456789abcdef', display_name: 'X', about: '' } }], outgoing: [] }).valid, false, 'the inbox never carries a distance');
});

test('requests that every tier must refuse are invalid', () => {
  const v = (def, body) => validator('people-api.v1', def)(body).valid;
  assert.equal(v('SightingsRequest', { event: 'e', sightings: Array.from({ length: 51 }, () => ({ token: 'A'.repeat(22), rssi: -60 })) }), false, '51 sightings');
  assert.equal(v('SightingsRequest', { event: 'e', sightings: [{ token: 'A'.repeat(22), rssi: -60.5 }] }), false, 'non-integer RSSI');
  assert.equal(v('SightingsRequest', { event: 'e', sightings: [{ token: 'A'.repeat(22), rssi: -60, mac: 'x' }] }), false, 'extra key');
  assert.equal(v('PresencePutRequest', { event: 'e', zone: 'Hallway', location: { lat: 1, lon: 2 } }), false, 'location without accuracy');
  assert.equal(v('PresencePutRequest', { event: 'e', zone: 'Hallway', until: 'week' }), false);
  assert.equal(v('ProfilePutRequest', { event: 'e', profile: { display_name: 'x', linkedin_url: 'https://evil.example/in/x' }, open_to_meet: true }), false);
  assert.equal(v('ReportRequest', { event: 'e', ref: '0123456789abcdef', context: { kind: 'meet', id: '0123456789abcdef' }, reason: 'spam' }), false, 'a meet report names a meet id');
  assert.equal(v('ReportRequest', { event: 'e', ref: '0123456789abcdef', context: { kind: 'profile', id: '0123456789abcdef' }, reason: 'spam' }), true);
  assert.equal(v('MatchesRequest', { event: 'e', size: 21 }), false);
  assert.equal(v('EmptyRequest', { x: 1 }), false);
  assert.equal(v('DeviceHeader', 'abc.def'), false);
});

// ---------------------------------------------------------------------------------------------
// The freeze, checked against the server source: every frozen or legacy route is still mounted
// with the same method. New routes may be added to the server; removing or renaming one of these
// fails here until the contract is changed on purpose.

const SERVER_FILES = ['people.mjs', 'connect.mjs', 'ble.mjs', 'report.mjs', 'push.mjs'].map((f) => readFileSync(path.join(ROOT, 'server', f), 'utf8'));

function mountedRoutes() {
  const mounted = new Set();
  for (const src of SERVER_FILES) {
    const block = /const ROUTES = \{([\s\S]*?)\n\};/.exec(src);
    if (!block) continue;
    for (const m of block[1].matchAll(/'(\/api\/[^']+)':\s*\{([^}]*)\}/g)) {
      for (const method of m[2].matchAll(/\b(GET|PUT|POST|DELETE):/g)) mounted.add(`${method[1]} ${m[1]}`);
    }
  }
  // The meet routes with an id are matched by MEET_PATH_RE in connect.mjs: no action is GET,
  // details is PUT and every other action is POST.
  const connect = SERVER_FILES[1];
  const re = /const MEET_PATH_RE = \/(.*)\/;/.exec(connect)?.[1] ?? '';
  const actions = /\(\?:\\\/\(([a-z|]+)\)\)\?/.exec(re)?.[1]?.split('|') ?? [];
  if (/if \(!name\) route = \{ GET:/.test(connect)) mounted.add('GET /api/meet/{meet_id}');
  for (const a of actions) {
    if (a === 'details' && /name === 'details'\) route = \{ PUT:/.test(connect)) mounted.add('PUT /api/meet/{meet_id}/details');
    else if (a !== 'details' && /else route = \{ POST:/.test(connect)) mounted.add(`POST /api/meet/{meet_id}/${a}`);
  }
  return mounted;
}

test('every frozen and legacy route is mounted by the server with its method', () => {
  const mounted = mountedRoutes();
  assert.ok(mounted.size >= 20, `parsed ${mounted.size} routes`);
  for (const r of table.routes.filter((x) => x.status !== 'new')) {
    assert.ok(mounted.has(`${r.method} ${r.path}`), `${r.method} ${r.path} is frozen but not mounted`);
  }
});

// The other direction is reported, not enforced: a route added to the server is an additive
// change, and it should be added to the contract (as status "new" or "frozen") in the same change.
test('people routes the server mounts beyond the contract are listed', (t) => {
  const contract = new Set(table.routes.map((r) => `${r.method} ${r.path}`));
  const extra = [...mountedRoutes()].filter((m) => !contract.has(m));
  t.diagnostic(extra.length ? `served but not in People API v1: ${extra.join(', ')}` : 'every mounted people route is in the contract');
});

test('the frozen device and token formats match the server', () => {
  const device = readFileSync(path.join(ROOT, 'server/device.mjs'), 'utf8');
  assert.match(device, /PROFILE_ID_RE = \/\^\[A-Za-z0-9_-\]\{22\}\$\//);
  assert.match(device, /SECRET_RE = \/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.match(SERVER_FILES[0], /const MAX_BODY = 8192;/);
  assert.match(SERVER_FILES[2], /TOKEN_RE = \/\^\[A-Za-z0-9_-\]\{22\}\$\//);
  assert.match(SERVER_FILES[2], /const MAX_SIGHTINGS = 50;/);
  assert.match(SERVER_FILES[2], /BLE_SERVICE_UUID = 'e52c391c-b926-4856-9a38-d46c3c10c733'/);
});
