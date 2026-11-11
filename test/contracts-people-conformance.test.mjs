// People API v1 against today's server: requests run through the real route handlers in server/
// with an in-memory stand-in for Elasticsearch, and every answer is checked against the route's
// schema definition in producer (closed) mode. This is what "frozen" means: if a handler's
// response shape drifts from contracts/schema/people-api.v1.schema.json, this test fails.
//
// The stand-in is a small document store, not a canned reply per request: it keeps documents per
// index with sequence numbers, and evaluates the filters the server sends (bool, term, terms,
// range, ids, exists, match_all, and the filter of a retriever) and terms aggregations. Scoring
// clauses (knn, multi_match, distance_feature) match everything, so ranking is not under test
// here, only shapes; with `explain: true` an rrf search explains every hit as found by every
// retriever, in the shape Elasticsearch 9.5.6 returns (test/lib/rrf-explanation.mjs). All 26
// routes run, and every list the schema describes comes back non-empty at least once, so Person,
// MeetView, the inbox items, circle members and the rest are checked against real handler output.
//
// Nothing here reaches the network: fetch is replaced before the server modules are imported and
// a call to any other host fails the test. The keys, URL and device credentials are dummy values.
// The APNs channel is configured with a key generated for this run, so the optional native push
// routes answer 200 for apns, and FCM is left off, so they answer 404 push_unavailable for fcm;
// PUSH_TRANSPORT=stub without PUSH_STUB_URL makes every push a nudge might attempt fail locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rrfExplanation } from './lib/rrf-explanation.mjs';
import { writeKeyFile } from './helpers/apns-key.mjs';

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
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'BLE_NEAR_RSSI', 'BLE_MASTER_KEYRING', 'TALKS_BUNDLE_BASE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_FILE', 'APNS_BUNDLE_ID', 'FCM_PROJECT_ID', 'PUSH_STUB_URL']) delete process.env[k];
Object.assign(process.env, {
  PUSH_TRANSPORT: 'stub',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_FILE: writeKeyFile(),
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENT = 'contracts-conf-2099';
const TALK = `${EVENT}:5001`;

// ---------------------------------------------------------------------------------------------
// The in-memory store.

const indices = new Map(); // index name -> Map(_id -> { source, seq })
let seqCounter = 0;
const store = (index) => {
  if (!indices.has(index)) indices.set(index, new Map());
  return indices.get(index);
};
const put = (index, id, source) => store(index).set(id, { source: structuredClone(source), seq: ++seqCounter });

// A searchable conference in the shape the ingestion CLI indexes (data/*/conference.json).
const confDoc = JSON.parse(readFileSync(path.join(ROOT, 'data/pytorch-day-japan-2026/conference.json'), 'utf8'));
put('caddie-conferences', EVENT, { ...confDoc, slug: EVENT, name: 'Contracts Conference', start_date: '2099-06-01', end_date: '2099-12-31', time_zone: 'UTC', status: 'searchable', status_reason: null });
put('caddie-topics', `${EVENT}:kubernetes`, { conference: EVENT, topic_id: 'kubernetes', label: 'Kubernetes', label_exact: 'Kubernetes', talk_count: 5, rank: 1, aliases: [] });
put('caddie-topics', `${EVENT}:ebpf`, { conference: EVENT, topic_id: 'ebpf', label: 'eBPF', label_exact: 'eBPF', talk_count: 3, rank: 2, aliases: [] });
put('caddie-talks', TALK, {
  talk_id: TALK, conference: EVENT, kind: 'talk', title: 'eBPF at scale', abstract: 'Load balancing with eBPF.', room: 'Hall A',
  start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z', url: 'https://example.org/t/5001',
  speaker_profiles: [{ name: 'Speaker Example', tagline: null, links: [{ title: 'Website', url: 'Https://example.org/speaker' }] }],
});

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const fieldValues = (doc, field) => {
  const v = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
};
const time = (v) => {
  if (v === 'now') return Date.now();
  const m = /^now-(\d+)([dhm])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]];
  return typeof v === 'number' ? v : Date.parse(v);
};

function matches(doc, q) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    const b = q.bool;
    if (!asList(b.filter).every((c) => matches(doc, c))) return false;
    if (!asList(b.must).every((c) => matches(doc, c))) return false;
    if (asList(b.must_not).some((c) => matches(doc, c))) return false;
    const should = asList(b.should);
    const min = b.minimum_should_match ?? (b.filter || b.must ? 0 : 1);
    return !should.length || should.filter((c) => matches(doc, c)).length >= min;
  }
  if (q.term) {
    const [field, raw] = Object.entries(q.term)[0];
    const want = raw !== null && typeof raw === 'object' ? raw.value : raw;
    return fieldValues(doc, field).some((v) => v === want);
  }
  if (q.terms) {
    const [field, want] = Object.entries(q.terms)[0];
    return fieldValues(doc, field).some((v) => want.includes(v));
  }
  if (q.ids) return q.ids.values.includes(doc._id);
  if (q.exists) return fieldValues(doc, q.exists.field).length > 0;
  if (q.range) {
    const [field, r] = Object.entries(q.range)[0];
    return fieldValues(doc, field).some((raw) => {
      const v = typeof raw === 'number' ? raw : Date.parse(raw);
      return (r.gt === undefined || v > time(r.gt)) && (r.gte === undefined || v >= time(r.gte))
        && (r.lt === undefined || v < time(r.lt)) && (r.lte === undefined || v <= time(r.lte));
    });
  }
  // Scoring clauses (knn, multi_match, distance_feature, match) do not filter here.
  return true;
}

// The filter a search applies: its query, or the filter of its retriever.
function searchFilter(body) {
  if (body.query) return body.query;
  const r = body.retriever ?? {};
  const inner = r.rrf ?? r.standard ?? null;
  if (!inner) return null;
  return inner.filter ?? inner.query ?? null;
}

const pickSource = (source, spec) => {
  if (spec === false) return undefined;
  if (!Array.isArray(spec)) return structuredClone(source);
  return Object.fromEntries(spec.filter((f) => f in source).map((f) => [f, structuredClone(source[f])]));
};

function search(index, body) {
  const docs = [...store(index)].map(([_id, d]) => ({ _id, ...d.source, __seq: d.seq })).filter((d) => matches(d, searchFilter(body)));
  for (const s of [...asList(body.sort)].reverse()) {
    const [field, dir] = typeof s === 'string' ? [s, 'asc'] : Object.entries(s).map(([f, o]) => [f, typeof o === 'string' ? o : o.order])[0];
    docs.sort((a, b) => {
      const x = a[field];
      const y = b[field];
      const c = x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1;
      return dir === 'desc' ? -c : c;
    });
  }
  const from = body.from ?? 0;
  const size = body.size ?? 10;
  const retrievers = body.explain ? body.retriever?.rrf?.retrievers : undefined;
  const hits = docs.slice(from, from + size).map(({ _id, __seq, ...source }, i) => ({
    _id, _seq_no: __seq, _primary_term: 1, _source: pickSource(source, body._source),
    ...(retrievers ? { _explanation: rrfExplanation(retrievers.map(() => from + i + 1), retrievers.map((r) => r.standard._name)) } : {}),
  }));
  const aggregations = {};
  for (const [name, agg] of Object.entries(body.aggs ?? {})) {
    if (!agg.terms) continue;
    const counts = new Map();
    for (const d of docs) for (const v of new Set(fieldValues(d, agg.terms.field))) {
      if (agg.terms.include && !agg.terms.include.includes(v)) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    aggregations[name] = { buckets: [...counts].sort((a, b) => b[1] - a[1]).slice(0, agg.terms.size ?? 10).map(([key, doc_count]) => ({ key, doc_count })) };
  }
  return { hits: { total: { value: docs.length }, hits }, aggregations };
}

function write(index, op, id, source, params) {
  const s = store(index);
  const existing = s.get(id);
  const guard = params.if_seq_no;
  if (guard !== undefined && guard !== null && (!existing || String(existing.seq) !== String(guard))) return 409;
  if (op === 'create' && existing) return 409;
  if (op === 'update') {
    if (!existing) return 404;
    put(index, id, { ...existing.source, ...source });
    return 200;
  }
  if (op === 'delete') return s.delete(id) ? 200 : 404;
  put(index, id, source);
  return existing ? 200 : 201;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  const method = init.method ?? 'GET';
  const [index, op, id] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(url.searchParams);
  const raw = init.body === undefined ? '' : String(init.body);
  const body = raw && op !== '_bulk' ? JSON.parse(raw) : {};
  if (op === '_search') return json(search(index, body));
  if (op === '_count') return json({ count: search(index, { ...body, size: 0 }).hits.total.value });
  if (op === '_mget') {
    return json({ docs: body.docs.map((d) => {
      const doc = store(index).get(d._id);
      return doc ? { _id: d._id, found: true, _seq_no: doc.seq, _source: pickSource(doc.source, d._source) } : { _id: d._id, found: false };
    }) });
  }
  if (op === '_bulk') {
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const [action, meta] = Object.entries(lines[i])[0];
      const doc = action === 'delete' ? null : lines[++i];
      const status = write(index, action, meta._id, action === 'update' ? doc.doc : doc, meta);
      items.push({ [action]: { _id: meta._id, status } });
    }
    return json({ errors: items.some((it) => Object.values(it)[0].status >= 300), items });
  }
  if (op === '_doc' && method === 'GET') {
    const doc = store(index).get(id);
    const includes = params._source_includes ? params._source_includes.split(',') : true;
    return doc ? json({ _id: id, found: true, _seq_no: doc.seq, _primary_term: 1, _source: pickSource(doc.source, includes) }) : json({ _id: id, found: false }, 404);
  }
  if (op === '_doc' && method === 'DELETE') {
    const status = write(index, 'delete', id, null, params);
    return json({ result: status === 200 ? 'deleted' : 'not_found' }, status);
  }
  if ((op === '_doc' || op === '_create') && (method === 'PUT' || method === 'POST')) {
    const status = write(index, op === '_create' ? 'create' : 'index', id, body, params);
    return json({ _id: id, result: status === 201 ? 'created' : 'updated' }, status === 409 ? 409 : status);
  }
  if (op === '_update' && method === 'POST') {
    const status = write(index, 'update', id, body.doc, params);
    return json({ _id: id }, status);
  }
  if (op === '_delete_by_query' || op === '_update_by_query') return json({ deleted: 0, updated: 0 });
  return json({ error: 'not in the stand-in' }, 404);
};

const { handlePeopleApi } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');
const { handleBleApi } = await import('../server/ble.mjs');
const { handleReportApi } = await import('../server/report.mjs');
const { handlePushApi } = await import('../server/push.mjs');
const { publicConferences } = await import('../server/conferences.mjs');
const { handleCapabilities } = await import('../server/capabilities.mjs');
const { validator } = await import('../contracts/js/schemas.mjs');
const { formatErrors } = await import('../contracts/js/validate.mjs');

const table = JSON.parse(readFileSync(path.join(ROOT, 'contracts/routes/people-api.v1.json'), 'utf8'));
const HANDLERS = [handlePeopleApi, handleConnectApi, handleBleApi, handleReportApi, handlePushApi];

const newDevice = () => ({ profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') });
let ip = 0;

// The body of the last request, so conforms() can check it against the route's request schema.
let lastBody;

async function call(method, pathAndQuery, { device, body, headers = {} } = {}) {
  lastBody = body;
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

// Routes exercised with a 200, by route id, and the request bodies checked against their schema.
const covered = new Set();
let requestChecks = 0;

// Finds the route a request belongs to and checks the answer against its definition.
function conforms(method, pathname, r, expectStatus = 200) {
  const route = table.routes.find((x) => x.method === method && new RegExp(`^${x.path.replace('{meet_id}', '[A-Za-z0-9_-]{22}')}$`).test(pathname));
  assert.ok(route, `${method} ${pathname} is not in the route table`);
  assert.equal(r.status, expectStatus, `${route.id}: ${JSON.stringify(r.body)}`);
  if (r.status === 200) {
    const result = validator('people-api.v1', route.response)(r.body, { closed: true });
    assert.equal(result.valid, true, `${route.id}\n${formatErrors(result.errors)}\n${JSON.stringify(r.body)}`);
    covered.add(route.id);
    // Every body the server accepted is one the request schema accepts too.
    if (lastBody !== undefined) {
      assert.ok(route.request, `${route.id} took a body the contract does not define`);
      const req = validator('people-api.v1', route.request)(lastBody, { closed: true });
      assert.equal(req.valid, true, `${route.id} request\n${formatErrors(req.errors)}`);
      requestChecks++;
    }
  } else {
    assert.equal(validator('people-api.v1', 'ErrorBody')(r.body, { closed: true }).valid, true, `${route.id} error ${JSON.stringify(r.body)}`);
    const listed = [...table.common_errors, ...route.errors].some((e) => e.status === r.status && (e.error === r.body.error || e.error === '*'));
    assert.ok(listed, `${route.id}: ${r.status} ${r.body.error} is not listed`);
  }
  return r.body;
}

const me = newDevice();
const other = newDevice();
const third = newDevice();
const profileBody = (name, over = {}) => ({
  event: EVENT,
  profile: { display_name: name, about: `${name} tests the contract.`, interests: 'eBPF in production', expertise: 'Built eBPF load balancing for 40 clusters.', learn_topics: ['ebpf'], speak_topics: ['kubernetes'], linkedin_url: null, contact_note: 'Find me at the booth.' },
  open_to_meet: true,
  shared_talk_ids: [TALK],
  ...over,
});
const here = { lat: 40.76789, lon: -111.89012, accuracy: 10 };
const refs = {};

test('GET /api/conferences entries are exactly the conferences.json Conference shape', async () => {
  const list = await publicConferences();
  assert.equal(list.length, 1);
  const check = validator('conferences-index.v1', 'Conference');
  for (const c of list) {
    const r = check(c, { closed: true });
    assert.equal(r.valid, true, formatErrors(r.errors));
  }
});

test('profiles: create, update, matches and circles', async () => {
  for (const [d, name] of [[me, 'Me Tester'], [other, 'Other Tester'], [third, 'Third Tester']]) {
    conforms('PUT', '/api/people/profile', await call('PUT', '/api/people/profile', { device: d, body: profileBody(name) }));
  }
  conforms('PUT', '/api/people/profile', await call('PUT', '/api/people/profile', { device: me, body: profileBody('Me Tester', { profile: { ...profileBody('x').profile, display_name: 'Me Tester', about: 'Changed text.' } }) }));

  const found = conforms('POST', '/api/people/matches', await call('POST', '/api/people/matches', { device: me, body: { event: EVENT, interested_talk_ids: [TALK], query: null, when: 'anyone', from: 0, size: 20 } }));
  assert.equal(found.results.length, 2, 'two people to meet');
  for (const p of found.results) refs[p.display_name] = p.ref;
  assert.ok(refs['Other Tester'] && refs['Third Tester']);
  const searched = conforms('POST', '/api/people/matches', await call('POST', '/api/people/matches', { device: me, body: { event: EVENT, query: 'load balancing' } }));
  assert.ok(searched.results.length > 0);
  assert.ok(searched.results.every((p) => typeof p.evidence === 'string'));

  const counts = conforms('POST', '/api/circles/counts', await call('POST', '/api/circles/counts', { body: { event: EVENT, talk_ids: [TALK] } }));
  assert.equal(counts.counts[TALK], 3);
  const members = conforms('POST', '/api/circles/members', await call('POST', '/api/circles/members', { device: me, body: { event: EVENT, talk_id: TALK } }));
  assert.equal(members.members.length, 2);
  assert.equal(members.speakers.length, 1);
});

test('GET /api/capabilities answers a closed-valid capabilities document', async () => {
  const res = {
    status: 0, headers: {}, text: '',
    writeHead(status, h) { this.status = status; this.headers = h ?? {}; },
    end(chunk) { this.text = chunk === undefined ? '' : String(chunk); },
  };
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', headers: { host: 'caddie.test' }, socket: { remoteAddress: '10.9.255.1' } });
  handleCapabilities(req, res);
  assert.equal(res.status, 200);
  const doc = JSON.parse(res.text);
  const result = validator('capabilities.v1')(doc, { closed: true });
  assert.equal(result.valid, true, formatErrors(result.errors));
  // Without a master keyring the server is in transition: the legacy tokens, with the mitigations.
  // This run has no VAPID keys, so no Web Push either, and an APNs key but no FCM project.
  const want = JSON.parse(readFileSync(path.join(ROOT, 'contracts/fixtures/capabilities/tier3-transition.json'), 'utf8'));
  want.ble.colocation_required = true;
  want.push.webpush = false;
  want.push.apns = true;
  assert.deepEqual(doc, want);
});

test('presence with Bluetooth (server-rotate without a master keyring), rotation and sightings', async () => {
  const on = conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: me, body: { event: EVENT, zone: 'Hall A', spot: null, location: here, until: 'hour', ble: true } }));
  assert.match(on.ble.token, /^[A-Za-z0-9_-]{22}$/, 'without a keyring the server is in server-rotate mode');
  assert.equal(on.ble_key, undefined, 'ble_key comes only from a server with the master keyring (derived-v1)');
  assert.equal(on.located, true);
  const theirs = conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: other, body: { event: EVENT, zone: 'Hall A', location: here, ble: true } }));
  conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: third, body: { event: EVENT, zone: 'Expo hall', until: 'day' } }));

  conforms('POST', '/api/presence/ble/rotate', await call('POST', '/api/presence/ble/rotate', { device: me, body: { event: EVENT } }));

  const near = conforms('POST', '/api/presence/sightings', await call('POST', '/api/presence/sightings', { device: me, body: { event: EVENT, sightings: [{ token: theirs.ble.token, rssi: -60 }, { token: 'A'.repeat(22), rssi: -50 }] } }));
  assert.equal(near.nearby.length, 1, 'the other phone resolves');
  assert.equal(near.nearby[0].ref, refs['Other Tester']);
  const weak = conforms('POST', '/api/presence/sightings', await call('POST', '/api/presence/sightings', { device: me, body: { event: EVENT, sightings: [{ token: theirs.ble.token, rssi: -90 }] } }));
  assert.deepEqual(weak.nearby, []);
  conforms('POST', '/api/presence/sightings', await call('POST', '/api/presence/sightings', { device: third, body: { event: EVENT, sightings: [] } }), 403);

  const around = conforms('POST', '/api/people/matches', await call('POST', '/api/people/matches', { device: me, body: { event: EVENT, when: 'around_now' } }));
  assert.ok(around.results.some((p) => p.proximity === 'same_zone' && p.zone === 'Hall A'));
});

let meetId;

test('an ask, from request to found: inbox, read, details, accept, found', async () => {
  const asked = conforms('POST', '/api/meet', await call('POST', '/api/meet', { device: me, body: { event: EVENT, ref: refs['Other Tester'], topic_id: 'ebpf', note: "I'm in Hall A too — want to talk shop?" } }));
  meetId = asked.meet_id;
  assert.equal(asked.state, 'requested');
  conforms('POST', '/api/meet', await call('POST', '/api/meet', { device: me, body: { event: EVENT, ref: refs['Other Tester'] } }), 409);

  const mine = conforms('GET', '/api/meet/inbox', await call('GET', `/api/meet/inbox?event=${EVENT}`, { device: me }));
  assert.equal(mine.outgoing.length, 1);
  const theirs = conforms('GET', '/api/meet/inbox', await call('GET', `/api/meet/inbox?event=${EVENT}`, { device: other }));
  assert.equal(theirs.incoming.length, 1);
  assert.equal(theirs.incoming[0].from.ref, (await call('POST', '/api/people/matches', { device: other, body: { event: EVENT } })).body.results.find((p) => p.display_name === 'Me Tester').ref);

  conforms(`GET`, `/api/meet/${meetId}`, await call('GET', `/api/meet/${meetId}`, { device: me }));
  conforms('PUT', `/api/meet/${meetId}/details`, await call('PUT', `/api/meet/${meetId}/details`, { device: me, body: { spot_me: 'Red scarf', rendezvous: 'Hall A' } }));
  conforms('POST', `/api/meet/${meetId}/accept`, await call('POST', `/api/meet/${meetId}/accept`, { device: me }), 403);
  const accepted = conforms('POST', `/api/meet/${meetId}/accept`, await call('POST', `/api/meet/${meetId}/accept`, { device: other, body: {} }));
  assert.equal(accepted.state, 'active');

  const read = conforms('GET', `/api/meet/${meetId}`, await call('GET', `/api/meet/${meetId}`, { device: me }));
  assert.equal(read.state, 'active');
  assert.equal(read.other.distance_m, 0, 'both sent the same position');
  assert.equal(typeof read.other.bearing_deg, 'number');
  assert.equal(read.other.spot_me, null);
  const theirView = conforms('GET', `/api/meet/${meetId}`, await call('GET', `/api/meet/${meetId}`, { device: other }));
  assert.equal(theirView.other.spot_me, 'Red scarf');

  const done = conforms('POST', `/api/meet/${meetId}/found`, await call('POST', `/api/meet/${meetId}/found`, { device: me }));
  assert.equal(done.state, 'found');
  conforms('GET', `/api/meet/${meetId}`, await call('GET', `/api/meet/${meetId}`, { device: me }), 410);
});

test('a declined ask and a cancelled ask', async () => {
  const again = conforms('POST', '/api/meet', await call('POST', '/api/meet', { device: me, body: { event: EVENT, ref: refs['Other Tester'], topic_id: null, note: '' } }));
  const declined = conforms('POST', `/api/meet/${again.meet_id}/decline`, await call('POST', `/api/meet/${again.meet_id}/decline`, { device: other }));
  assert.equal(declined.state, 'declined');
  const waiting = conforms('GET', '/api/meet/inbox', await call('GET', `/api/meet/inbox?event=${EVENT}`, { device: me }));
  assert.equal(waiting.outgoing[0].state, 'requested', 'a decline is silent');
  const withdrawn = conforms('POST', `/api/meet/${again.meet_id}/cancel`, await call('POST', `/api/meet/${again.meet_id}/cancel`, { device: me }));
  assert.equal(withdrawn.state, 'cancelled');

  const third_ = conforms('POST', '/api/meet', await call('POST', '/api/meet', { device: me, body: { event: EVENT, ref: refs['Third Tester'] } }));
  const cancelled = conforms('POST', `/api/meet/${third_.meet_id}/cancel`, await call('POST', `/api/meet/${third_.meet_id}/cancel`, { device: me }));
  assert.equal(cancelled.state, 'cancelled');
  conforms('POST', `/api/meet/${third_.meet_id}/found`, await call('POST', `/api/meet/${third_.meet_id}/found`, { device: me }), 410);
});

test('reports, blocks and push subscriptions', async () => {
  const first = conforms('POST', '/api/people/report', await call('POST', '/api/people/report', { device: me, body: { event: EVENT, ref: refs['Third Tester'], context: { kind: 'profile', id: refs['Third Tester'] }, reason: 'spam' } }));
  assert.equal(first.hidden, false);
  const second = conforms('POST', '/api/people/report', await call('POST', '/api/people/report', { device: other, body: { event: EVENT, ref: refs['Third Tester'], context: { kind: 'profile', id: refs['Third Tester'] }, reason: 'other' } }));
  assert.equal(second.hidden, true, 'two reporters hide the profile');
  const meetReport = conforms('POST', '/api/people/report', await call('POST', '/api/people/report', { device: me, body: { event: EVENT, ref: refs['Other Tester'], context: { kind: 'meet', id: meetId }, reason: 'harassment' } }));
  assert.equal(meetReport.hidden, false);

  conforms('POST', '/api/people/block', await call('POST', '/api/people/block', { device: me, body: { event: EVENT, ref: refs['Third Tester'] } }));
  const blocks = conforms('GET', '/api/people/blocks', await call('GET', `/api/people/blocks?event=${EVENT}`, { device: me }));
  assert.deepEqual(blocks.refs, [refs['Third Tester']]);
  assert.equal(blocks.blocks[0].display_name, 'Third Tester');
  conforms('DELETE', '/api/people/block', await call('DELETE', '/api/people/block', { device: me, body: { event: EVENT, ref: refs['Third Tester'] } }));
  assert.deepEqual(conforms('GET', '/api/people/blocks', await call('GET', `/api/people/blocks?event=${EVENT}`, { device: me })).refs, []);

  // A block outlives the blocked profile: listed with display_name null, and still liftable by ref.
  const leaving = newDevice();
  conforms('PUT', '/api/people/profile', await call('PUT', '/api/people/profile', { device: leaving, body: profileBody('Blocked Then Gone') }));
  const leavingRef = (await call('POST', '/api/people/matches', { device: other, body: { event: EVENT } })).body.results.find((p) => p.display_name === 'Blocked Then Gone').ref;
  conforms('POST', '/api/people/block', await call('POST', '/api/people/block', { device: other, body: { event: EVENT, ref: leavingRef } }));
  conforms('DELETE', '/api/people/profile', await call('DELETE', `/api/people/profile?event=${EVENT}`, { device: leaving }));
  const orphan = conforms('GET', '/api/people/blocks', await call('GET', `/api/people/blocks?event=${EVENT}`, { device: other }));
  assert.deepEqual(orphan.blocks.map((b) => [b.ref, b.display_name]), [[leavingRef, null]]);
  conforms('DELETE', '/api/people/block', await call('DELETE', '/api/people/block', { device: other, body: { event: EVENT, ref: leavingRef } }));

  assert.deepEqual(conforms('GET', '/api/push/vapid', await call('GET', '/api/push/vapid')), { publicKey: null });
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/contracts', keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }, expirationTime: null };
  conforms('PUT', '/api/push/subscription', await call('PUT', '/api/push/subscription', { device: me, body: { event: EVENT, subscription } }));
  assert.equal(store('caddie-people-push').size, 1);
  conforms('DELETE', '/api/push/subscription', await call('DELETE', '/api/push/subscription', { device: me, body: { event: EVENT, endpoint: subscription.endpoint } }));
  assert.equal(store('caddie-people-push').size, 0);

  // The optional native push routes: APNs is configured in this run, FCM is not.
  const apns = crypto.randomBytes(32).toString('hex');
  const fcm = `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
  conforms('PUT', '/api/push/native', await call('PUT', '/api/push/native', { device: other, body: { event: EVENT, platform: 'apns', token: apns } }));
  conforms('PUT', '/api/push/native', await call('PUT', '/api/push/native', { device: other, body: { event: EVENT, platform: 'apns', token: apns.toUpperCase(), environment: 'sandbox' } }));
  assert.equal(store('caddie-people-push').size, 1, 'the same token in either case is one registration');
  assert.equal([...store('caddie-people-push').values()][0].source.environment, 'sandbox');
  assert.deepEqual(conforms('PUT', '/api/push/native', await call('PUT', '/api/push/native', { device: other, body: { event: EVENT, platform: 'fcm', token: fcm } }), 404), { error: 'push_unavailable' });
  conforms('PUT', '/api/push/native', await call('PUT', '/api/push/native', { device: other, body: { event: EVENT, platform: 'apns', token: 'abc' } }), 400);
  conforms('DELETE', '/api/push/native', await call('DELETE', '/api/push/native', { device: other, body: { event: EVENT, platform: 'fcm', token: fcm } }));
  assert.equal(store('caddie-people-push').size, 1);
  conforms('DELETE', '/api/push/native', await call('DELETE', '/api/push/native', { device: other, body: { event: EVENT, platform: 'apns', token: apns } }));
  assert.equal(store('caddie-people-push').size, 0);
});

test('error envelopes and status codes are the frozen ones', async () => {
  const stranger = newDevice();
  const noDevice = conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { body: { event: EVENT, zone: 'Hall A' } }), 403);
  assert.deepEqual(noDevice, { error: 'forbidden' });
  assert.deepEqual(conforms('PUT', '/api/people/profile', await call('PUT', '/api/people/profile', { device: { ...other, secret: crypto.randomBytes(32).toString('base64url') }, body: profileBody('x') }), 403), { error: 'forbidden' });
  assert.deepEqual(conforms('POST', '/api/people/matches', await call('POST', '/api/people/matches', { device: stranger, body: { event: EVENT } }), 403), { error: 'visibility_required' });
  assert.deepEqual(conforms('GET', '/api/people/blocks', await call('GET', `/api/people/blocks?event=${EVENT}`, { device: stranger }), 403), { error: 'profile_required' });
  const share = conforms('POST', '/api/circles/members', await call('POST', '/api/circles/members', { device: stranger, body: { event: EVENT, talk_id: TALK } }), 403);
  assert.deepEqual(share, { error: 'share_required', count: 2 }, 'the hidden profile no longer counts');
  conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: stranger, body: { event: EVENT, zone: 'Hall A', mood: 'fine' } }), 400);
  conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: stranger, body: { event: EVENT, zone: 'Hall A' }, headers: { 'content-type': 'text/plain' } }), 415);
  const wrongMethod = await call('PATCH', '/api/presence', { device: stranger });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, 'PUT, DELETE');
  assert.deepEqual(conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: stranger, body: { event: EVENT, zone: 'Hall A' }, headers: { origin: 'https://evil.example' } }), 403), { error: 'cross-origin request' });
  conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: stranger, body: { event: EVENT, zone: 'Hall A', spot: 'x'.repeat(9000) } }), 413);
  conforms('GET', `/api/meet/${'A'.repeat(22)}`, await call('GET', `/api/meet/${'A'.repeat(22)}`, { device: stranger }), 404);
  conforms('POST', '/api/people/block', await call('POST', '/api/people/block', { device: other, body: { event: EVENT, ref: '0123456789abcdef' } }), 404);
});

test('ending presence and deleting the profile', async () => {
  // A device of its own, so the write buckets of the devices above do not run out.
  const leaver = newDevice();
  conforms('PUT', '/api/people/profile', await call('PUT', '/api/people/profile', { device: leaver, body: profileBody('Leaving Tester') }));
  conforms('PUT', '/api/presence', await call('PUT', '/api/presence', { device: leaver, body: { event: EVENT, zone: 'Hallway', ble: true } }));
  conforms('DELETE', '/api/presence', await call('DELETE', `/api/presence?event=${EVENT}`, { device: leaver }));
  conforms('POST', '/api/presence/ble/rotate', await call('POST', '/api/presence/ble/rotate', { device: leaver, body: { event: EVENT } }), 403);
  conforms('DELETE', '/api/people/profile', await call('DELETE', `/api/people/profile?event=${EVENT}`, { device: leaver }));
  assert.equal(store('caddie-people').has(`${EVENT}:${leaver.profileId}`), false);
  assert.deepEqual(conforms('GET', '/api/people/blocks', await call('GET', `/api/people/blocks?event=${EVENT}`, { device: leaver }), 403), { error: 'profile_required' });
  conforms('DELETE', '/api/people/profile', await call('DELETE', `/api/people/profile?event=${EVENT}`, { device: leaver }));
});

test('all 26 routes answered 200 at least once and were validated', (t) => {
  const all = table.routes.map((r) => r.id);
  assert.equal(all.length, 26);
  assert.deepEqual(all.filter((id) => !covered.has(id)), []);
  t.diagnostic(`request bodies checked against their schema: ${requestChecks}`);
  assert.ok(requestChecks >= 36, `only ${requestChecks} request bodies were checked`);
});
