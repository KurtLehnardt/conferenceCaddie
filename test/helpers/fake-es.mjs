// An in-memory stand-in for the parts of Elasticsearch the people server and its CLI scripts use,
// for the tests under test/. Importing this module sets dummy env values and replaces fetch, so it
// must be imported before anything under server/. Nothing here reaches the network: a request to
// any host but the dummy one fails the test, and the CLI tests talk to the same stand-in through
// a loopback HTTP server (serve()).
//
// The stand-in keeps documents per index with a sequence number each, evaluates the queries the
// server sends (bool, term, terms, ids, exists, range with "now" date math, match_all), and
// answers _doc, _create, _update, _search (with terms aggregations), _mget, _count, _bulk,
// _delete_by_query, _update_by_query (no script, or the setup's expires_at backfill script),
// _mapping and index creation. Writes honour if_seq_no/if_primary_term the way Elasticsearch does:
// a guarded delete or index of a missing document is a 409, and a Bulk action that combines
// if_seq_no with retry_on_conflict fails the whole request with 400. A people search by retriever
// (matches, nudges) finds nobody. Every call is logged with a tag (see tagOf),
// and a test can make a call fail, run a hook before or after it, or hold calls at a barrier.

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

export const ES_HOST = 'es.caddie.test';
export const EVENT = 'testconf-2099';
export const FUTURE = '2099-12-31T23:59:59.000Z';
export const INDEX = {
  people: 'caddie-people',
  blocks: 'caddie-people-blocks',
  meets: 'caddie-people-meets',
  push: 'caddie-people-push',
  nudges: 'caddie-people-nudges',
  reports: 'caddie-people-reports',
  conferences: 'caddie-conferences',
  talks: 'caddie-talks',
  topics: 'caddie-topics',
};
const SHORT = Object.fromEntries(Object.entries(INDEX).map(([k, v]) => [v, k]));

export const TEST_ENV = {
  ES_URL: `https://${ES_HOST}`,
  ES_PEOPLE_API_KEY: 'test-people-key',
  ES_API_KEY: 'test-read-key',
  ES_PEOPLE_INDEX: INDEX.people,
  ES_PEOPLE_BLOCKS_INDEX: INDEX.blocks,
  ES_PEOPLE_MEETS_INDEX: INDEX.meets,
  ES_PEOPLE_PUSH_INDEX: INDEX.push,
  ES_PEOPLE_NUDGES_INDEX: INDEX.nudges,
  ES_PEOPLE_REPORTS_INDEX: INDEX.reports,
  ES_CONFERENCES_INDEX: INDEX.conferences,
  ES_INDEX: INDEX.talks,
  ES_TOPICS_INDEX: INDEX.topics,
  ES_RULES_INDEX: 'caddie-people-rules',
  MOD_CLASSIFIER: 'off',
};
for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'REF_SALT', 'ELASTISEARCH_API_KEY']) delete process.env[key];
Object.assign(process.env, TEST_ENV);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

function valuesOf(source, field) {
  const v = source?.[field];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined);
}

function dateMath(value, now) {
  if (typeof value === 'number') return value;
  const m = /^now(?:([+-])(\d+)([dhms]))?$/.exec(value);
  if (!m) return Date.parse(value);
  if (!m[1]) return now;
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[m[3]];
  return now + (m[1] === '+' ? 1 : -1) * Number(m[2]) * unit;
}

// True when the document matches the query, as Elasticsearch would decide for these query types.
export function matches(source, id, query, now = Date.now()) {
  const [[kind, spec]] = Object.entries(query);
  switch (kind) {
    case 'match_all':
      return true;
    case 'term': {
      const [[field, raw]] = Object.entries(spec);
      const value = isPlainObject(raw) ? raw.value : raw;
      return valuesOf(source, field).some((x) => x === value);
    }
    case 'terms': {
      const [[field, values]] = Object.entries(spec);
      return valuesOf(source, field).some((x) => values.includes(x));
    }
    case 'ids':
      return spec.values.includes(id);
    case 'exists':
      return valuesOf(source, spec.field).length > 0;
    case 'range': {
      const [[field, cond]] = Object.entries(spec);
      return valuesOf(source, field).some((x) => {
        const t = typeof x === 'number' ? x : Date.parse(x);
        if (cond.lt !== undefined && !(t < dateMath(cond.lt, now))) return false;
        if (cond.lte !== undefined && !(t <= dateMath(cond.lte, now))) return false;
        if (cond.gt !== undefined && !(t > dateMath(cond.gt, now))) return false;
        if (cond.gte !== undefined && !(t >= dateMath(cond.gte, now))) return false;
        return true;
      });
    }
    case 'bool': {
      const required = [...list(spec.filter), ...list(spec.must)];
      if (!required.every((c) => matches(source, id, c, now))) return false;
      if (list(spec.must_not).some((c) => matches(source, id, c, now))) return false;
      const should = list(spec.should);
      const min = spec.minimum_should_match ?? (required.length || !should.length ? 0 : 1);
      return should.filter((c) => matches(source, id, c, now)).length >= min;
    }
    default:
      throw new Error(`fake Elasticsearch: unsupported query ${kind}`);
  }
}

function pick(source, spec) {
  if (spec === false) return undefined;
  if (spec === undefined || spec === true) return clone(source);
  if (Array.isArray(spec) || typeof spec === 'string') {
    const fields = list(spec);
    return Object.fromEntries(Object.entries(source).filter(([k]) => fields.includes(k)).map(([k, v]) => [k, clone(v)]));
  }
  const patterns = list(spec.excludes).map((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`));
  return Object.fromEntries(Object.entries(source).filter(([k]) => !patterns.some((re) => re.test(k))).map(([k, v]) => [k, clone(v)]));
}

function sortSpecs(sort) {
  return list(sort).map((s) => {
    if (typeof s === 'string') return [s, 'asc'];
    const [[field, order]] = Object.entries(s);
    return [field, typeof order === 'string' ? order : order?.order ?? 'asc'];
  });
}

export class FakeES {
  constructor() {
    this.indices = new Map();
    this.nextSeq = 1;
    this.log = [];
    this.failures = [];
    this.counts = new Map();
    this.hooks = [];
    this.conflicts = new Map();
    this.held = null;
    this.put(INDEX.conferences, EVENT, { slug: EVENT, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' });
  }

  docs(index) {
    if (!this.indices.has(index)) this.indices.set(index, new Map());
    return this.indices.get(index);
  }

  put(index, id, source) {
    const doc = { source: clone(source), seq: this.nextSeq++, term: 1 };
    this.docs(index).set(id, doc);
    return doc;
  }

  // Merges fields into a stored document, as a partial update does, and bumps its sequence number.
  patch(index, id, fields) {
    const doc = this.docs(index).get(id);
    if (!doc) throw new Error(`no document ${index}/${id}`);
    Object.assign(doc.source, clone(fields));
    doc.seq = this.nextSeq++;
    return doc;
  }

  source(index, id) {
    return this.docs(index).get(id)?.source ?? null;
  }

  ids(index) {
    return [...this.docs(index).keys()];
  }

  tags() {
    return this.log.map((e) => e.tag);
  }

  calls(tag) {
    return this.log.filter((e) => e.tag === tag);
  }

  // Makes one call fail: { tag, nth = 1, how } where how is 503 (HTTP status), 'network' (fetch
  // rejects), 'timeout' (fetch rejects with a TimeoutError), 'item<status>' (a Bulk answer of 200
  // whose every item carries that status) or 'partial<status>' (only the last item fails).
  fail(...failures) {
    this.failures.push(...failures);
    return this;
  }

  // Runs fn(this) before or after the nth call with this tag (after: once its answer is computed).
  before(tag, nth, fn) {
    this.hooks.push({ when: 'before', tag, nth, fn });
    return this;
  }

  after(tag, nth, fn) {
    this.hooks.push({ when: 'after', tag, nth, fn });
    return this;
  }

  // The next people update with this tag meets `times` concurrent writes to the same document.
  // Elasticsearch retries the update itself up to retry_on_conflict times, so the update succeeds
  // only when times <= retry_on_conflict and answers item 409 otherwise.
  conflict(tag, times) {
    this.conflicts.set(tag, times);
    return this;
  }

  // Holds every call with one of these tags until all of them have arrived, or until timeoutMs
  // has passed, which sets barrierTimedOut. Calls that run one after another never all arrive.
  barrier(tags, timeoutMs = 300) {
    let release;
    const all = new Promise((resolve) => {
      release = resolve;
    });
    this.held = { tags: new Set(tags), seen: new Set(), all, release, timeoutMs };
    this.barrierTimedOut = false;
    return this;
  }

  tagOf(method, index, op, docKey, params, body) {
    const short = SHORT[index] ?? index;
    if (index === INDEX.people) {
      if (op === '_doc' && method === 'GET') return 'get';
      if (op === '_doc' && method === 'DELETE') return 'delete-doc';
      if (op === '_search' && params.get('seq_no_primary_term') === 'true') return 'search:pending';
      if (op === '_bulk') {
        const [action, payload] = String(body).split('\n').filter(Boolean).map((l) => JSON.parse(l));
        if (action.update && payload?.doc?.open_to_meet === false && Array.isArray(payload.doc.shared_talk_ids) && !payload.doc.shared_talk_ids.length) return 'hide';
        if (action.update) return 'update';
        if (action.create) return 'create';
        return 'bulk:people';
      }
    }
    return `${(op ?? 'index').replace(/^_/, '')}:${short}`;
  }

  failure(tag) {
    const n = (this.counts.get(tag) ?? 0) + 1;
    this.counts.set(tag, n);
    const f = this.failures.find((x) => x.tag === tag && (x.nth ?? 1) === n);
    if (!f) return { n, failure: null };
    this.failures.splice(this.failures.indexOf(f), 1);
    if (f.how === 'network') throw new TypeError('fetch failed');
    if (f.how === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    return { n, failure: f.how };
  }

  async runHooks(when, tag, n) {
    for (const h of this.hooks.filter((x) => x.when === when && x.tag === tag && x.nth === n)) await h.fn(this);
  }

  async handle(method, url, rawBody) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [index, op, docKey] = parts;
    const params = url.searchParams;
    const tag = this.tagOf(method, index, op, docKey, params, rawBody);
    let body;
    if (rawBody !== undefined && rawBody !== null && op !== '_bulk') body = JSON.parse(String(rawBody));
    this.log.push({ tag, method, path: url.pathname, params: new URLSearchParams(params), body: op === '_bulk' ? String(rawBody) : body });
    if (this.held?.tags.has(tag)) {
      const held = this.held;
      held.seen.add(tag);
      if ([...held.tags].every((t) => held.seen.has(t))) held.release();
      const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), held.timeoutMs));
      if ((await Promise.race([held.all, timer])) === 'timeout') this.barrierTimedOut = true;
    }
    const { n, failure } = this.failure(tag);
    await this.runHooks('before', tag, n);
    let response;
    if (typeof failure === 'number') response = new Response('{}', { status: failure });
    else response = this.answer(method, index, op, docKey, params, body, rawBody, tag, failure);
    await this.runHooks('after', tag, n);
    return response;
  }

  answer(method, index, op, docKey, params, body, rawBody, tag, failure) {
    if (method === 'HEAD') return new Response(null, { status: this.indices.has(index) ? 200 : 404 });
    if (op === '_mapping' && method === 'PUT') {
      this.mappings = [...(this.mappings ?? []), { index, properties: body?.properties ?? {} }];
      return json({ acknowledged: true });
    }
    if (op === undefined && method === 'PUT') {
      if (this.indices.has(index)) return json({ error: { type: 'resource_already_exists_exception' } }, 400);
      this.docs(index);
      return json({ acknowledged: true, index });
    }
    const docs = this.docs(index);
    if ((op === '_doc' || op === '_create') && (method === 'PUT' || method === 'POST')) {
      const existing = docs.get(docKey);
      if (op === '_create' && existing) return json({ error: { type: 'version_conflict_engine_exception' } }, 409);
      if (params.has('if_seq_no') && (!existing || existing.seq !== Number(params.get('if_seq_no')))) return json({ error: { type: 'version_conflict_engine_exception' } }, 409);
      this.put(index, docKey, body);
      return json({ result: existing ? 'updated' : 'created' }, existing ? 200 : 201);
    }
    if (op === '_doc' && method === 'GET') {
      const doc = docs.get(docKey);
      if (!doc) return json({ found: false }, 404);
      const includes = params.get('_source_includes');
      return json({ found: true, _id: docKey, _seq_no: doc.seq, _primary_term: doc.term, _source: pick(doc.source, includes ? includes.split(',') : undefined) });
    }
    if (op === '_doc' && method === 'DELETE') {
      const doc = docs.get(docKey);
      if (!doc && params.has('if_seq_no')) return json({ error: { type: 'version_conflict_engine_exception' } }, 409);
      if (!doc) return json({ result: 'not_found' }, 404);
      if (params.has('if_seq_no') && (doc.seq !== Number(params.get('if_seq_no')) || doc.term !== Number(params.get('if_primary_term')))) {
        return json({ error: { type: 'version_conflict_engine_exception' } }, 409);
      }
      docs.delete(docKey);
      return json({ result: 'deleted' });
    }
    if (op === '_update') {
      if (!docs.has(docKey)) return json({ error: { type: 'document_missing_exception' } }, 404);
      this.patch(index, docKey, body.doc ?? {});
      return json({ result: 'updated' });
    }
    if (op === '_bulk') return this.bulk(index, String(rawBody), tag, failure);
    if (op === '_search') return this.search(index, params, body ?? {});
    if (op === '_count') return json({ count: this.find(index, body?.query).length });
    if (op === '_mget') {
      return json({
        docs: (body.docs ?? []).map((d) => {
          const doc = docs.get(d._id);
          return doc ? { _id: d._id, found: true, _source: pick(doc.source, d._source) } : { _id: d._id, found: false };
        }),
      });
    }
    if (op === '_delete_by_query') {
      const found = this.find(index, body.query);
      for (const [id] of found) docs.delete(id);
      return json({ deleted: found.length });
    }
    if (op === '_update_by_query') return this.updateByQuery(index, body ?? {});
    throw new Error(`fake Elasticsearch: unexpected ${method} /${index}/${op ?? ''}`);
  }

  find(index, query = { match_all: {} }) {
    const now = Date.now();
    return [...this.docs(index)].filter(([id, doc]) => matches(doc.source, id, query, now));
  }

  // Terms aggregations ({ terms: { field, size, include } }) over every matching document; any
  // other aggregation answers no buckets.
  aggregate(found, aggs) {
    return Object.fromEntries(Object.entries(aggs).map(([name, spec]) => {
      if (!spec.terms) return [name, { buckets: [] }];
      const counts = new Map();
      for (const [, doc] of found) {
        for (const v of valuesOf(doc.source, spec.terms.field)) {
          if (spec.terms.include && !spec.terms.include.includes(v)) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      const buckets = [...counts].map(([key, doc_count]) => ({ key, doc_count })).sort((a, b) => b.doc_count - a.doc_count);
      return [name, { buckets: buckets.slice(0, spec.terms.size ?? 10) }];
    }));
  }

  // Without a script, every matching document is written again as it is. The one script the stand-in
  // runs sets a field from params unless the document already has it (the setup's backfill); any
  // other script (the purge's scrub of declined meets) changes nothing.
  updateByQuery(index, body) {
    const found = this.find(index, body.query);
    this.updates = [...(this.updates ?? []), { index, body }];
    if (!body.script) {
      for (const [id] of found) this.patch(index, id, {});
      return json({ updated: found.length });
    }
    const m = /^if \(ctx\._source\.(\w+) == null\) \{ ctx\._source\.\1 = params\.(\w+); \}/.exec(body.script.source ?? '');
    if (!m) return json({ updated: 0 });
    let updated = 0;
    for (const [id, doc] of found) {
      if (doc.source[m[1]] !== undefined && doc.source[m[1]] !== null) continue;
      this.patch(index, id, { [m[1]]: body.script.params[m[2]] });
      updated++;
    }
    return json({ updated, noops: found.length - updated });
  }

  search(index, params, body) {
    const empty = { hits: { total: { value: 0 }, hits: [] }, aggregations: Object.fromEntries(Object.keys(body.aggs ?? {}).map((k) => [k, { buckets: [] }])) };
    // Ranked people searches (matches, nudges, members) go through a retriever: nobody is found.
    if (body.retriever) return json(empty);
    let found = this.find(index, body.query);
    const aggregations = this.aggregate(found, body.aggs ?? {});
    const specs = sortSpecs(body.sort);
    // Compares two lists of sort values in the order the sort asks for.
    const compare = (xs, ys) => {
      for (let i = 0; i < specs.length; i++) {
        const x = xs[i] ?? '';
        const y = ys[i] ?? '';
        if (x === y) continue;
        return (x < y ? -1 : 1) * (specs[i][1] === 'desc' ? -1 : 1);
      }
      return 0;
    };
    const sortValues = (doc) => specs.map(([f]) => doc.source[f] ?? null);
    if (specs.length) found.sort(([, a], [, b]) => compare(sortValues(a), sortValues(b)));
    // As in Elasticsearch, a page starts after the given sort values, whether or not the document
    // that had them still exists.
    if (body.search_after) found = found.filter(([, d]) => compare(sortValues(d), body.search_after) > 0);
    const from = body.from ?? 0;
    const size = body.size ?? 10;
    const withSeq = params.get('seq_no_primary_term') === 'true';
    const hits = found.slice(from, from + size).map(([id, doc]) => ({
      _index: index,
      _id: id,
      ...(body._source === false ? {} : { _source: pick(doc.source, body._source) }),
      ...(withSeq ? { _seq_no: doc.seq, _primary_term: doc.term } : {}),
      ...(specs.length ? { sort: specs.map(([f]) => doc.source[f] ?? null) } : {}),
    }));
    return json({ aggregations, hits: { total: { value: found.length }, hits } });
  }

  bulk(index, raw, tag, failure) {
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ops = [];
    for (let i = 0; i < lines.length; i++) {
      const [[type, meta]] = Object.entries(lines[i]);
      ops.push({ type, meta, payload: type === 'delete' ? undefined : lines[++i] });
    }
    if (ops.some(({ meta }) => meta.if_seq_no !== undefined && meta.retry_on_conflict !== undefined)) {
      return json({ error: { type: 'action_request_validation_exception', reason: 'compare and write operations can not be used with retry_on_conflict' } }, 400);
    }
    const forced = typeof failure === 'string' ? /^(item|partial)(\d+)$/.exec(failure) : null;
    const docs = this.docs(index);
    const items = ops.map(({ type, meta, payload }, i) => {
      const result = (status) => ({ [type]: { _id: meta._id, status } });
      if (forced && (forced[1] === 'item' || i === ops.length - 1)) return result(Number(forced[2]));
      const doc = docs.get(meta._id);
      const casFails = meta.if_seq_no !== undefined && (!doc || doc.seq !== meta.if_seq_no || doc.term !== meta.if_primary_term);
      if (type === 'delete') {
        if (!doc) return result(404);
        if (casFails) return result(409);
        docs.delete(meta._id);
        return result(200);
      }
      if (type === 'create') {
        if (doc) return result(409);
        this.put(index, meta._id, payload);
        return result(201);
      }
      if (type === 'index') {
        if (casFails) return result(409);
        this.put(index, meta._id, payload);
        return result(doc ? 200 : 201);
      }
      if (type === 'update') {
        if (!doc) return result(404);
        if (casFails) return result(409);
        const concurrent = this.conflicts.get(tag) ?? 0;
        if (concurrent) {
          this.conflicts.delete(tag);
          doc.seq = this.nextSeq++;
          if (concurrent > (meta.retry_on_conflict ?? 0)) return result(409);
        }
        this.patch(index, meta._id, payload.doc ?? {});
        return result(200);
      }
      throw new Error(`fake Elasticsearch: unexpected bulk action ${type}`);
    });
    return json({ errors: items.some((it) => Object.values(it)[0].status > 299), items });
  }
}

// The cluster the stubbed fetch answers from. A default one answers the import-time work of the
// server modules (the hourly purge's first run, the moderation probe).
export const boot = new FakeES();
let current = boot;
export const useCluster = (cluster) => {
  current = cluster;
  return cluster;
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  return current.handle(init.method ?? 'GET', url, init.body);
};

// Waits until the purge that server/people.mjs runs on import has made its last call to the
// default cluster (its delete of expired blocks), so it can never act on a test's cluster. A
// server/ from before blocks expired ends with the nudge records instead; that is accepted once
// the default cluster has been quiet for a second, so these tests can also run against it.
export async function bootPurgeDone() {
  const deadline = Date.now() + 10_000;
  let seen = -1;
  let quietSince = Date.now();
  for (;;) {
    const tags = boot.tags();
    if (boot.log.length !== seen) {
      seen = boot.log.length;
      quietSince = Date.now();
    } else if (tags.includes('delete_by_query:blocks') || (tags.includes('delete_by_query:nudges') && Date.now() - quietSince > 1000)) {
      return;
    }
    if (Date.now() > deadline) throw new Error('the import-time purge did not finish');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

// ---------------------------------------------------------------------------------------------
// Devices and profiles.

export function newDevice() {
  return { profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') };
}
export const hashOf = (secret) => crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
export const refOf = (profileId) => crypto.createHash('sha256').update(`${EVENT}:${profileId}:conference-caddie-ref-v1`, 'utf8').digest('hex').slice(0, 16);
export const personId = (profileId) => `${EVENT}:${profileId}`;

// A live, visible profile that is around (with a Bluetooth token), stored in the cluster.
export function addPerson(cluster, device, fields = {}) {
  const now = Date.now();
  return cluster.put(INDEX.people, personId(device.profileId), {
    event_id: EVENT,
    profile_id: device.profileId,
    ref: refOf(device.profileId),
    secret_hash: hashOf(device.secret),
    display_name: 'Test person',
    about: 'About me',
    open_to_meet: true,
    shared_talk_ids: [`${EVENT}:talk1`],
    visible_until: FUTURE,
    updated_at: new Date(now).toISOString(),
    presence_zone: 'Hallway',
    presence_spot: 'by the coffee',
    presence_spot_pending: false,
    presence_since: new Date(now).toISOString(),
    presence_until: new Date(now + 3600_000).toISOString(),
    presence_location: { lat: 1.23456, lon: 2.34567 },
    presence_accuracy: 12,
    ble_token: 'dGVzdC10b2tlbi0xNi1i',
    ble_token_until: new Date(now + 600_000).toISOString(),
    ...fields,
  });
}

// What a delete's first step leaves on the document (HIDE_FOR_DELETE in server/people.mjs).
export const HIDDEN_FOR_DELETE = {
  open_to_meet: false,
  shared_talk_ids: [],
  presence_zone: null,
  presence_spot: null,
  presence_spot_pending: null,
  presence_since: null,
  presence_until: null,
  presence_location: null,
  presence_accuracy: null,
  ble_token: null,
  ble_token_until: null,
};

// The documents that connect one person to others: two meets, a push subscription and a nudge
// record of theirs, two blocks they made, one block someone else made of them, and an unrelated
// meet and block between two other people. Returns the ids by kind.
export function addConnections(cluster, profileId) {
  const future = new Date(Date.now() + 15 * 60_000).toISOString();
  const ids = {
    meets: ['meet-one', 'meet-two'],
    push: ['push-one'],
    nudges: ['nudge-one'],
    ownBlocks: [`${EVENT}:${profileId}:other1`, `${EVENT}:${profileId}:other3`],
    blockedBy: `${EVENT}:other2:${profileId}`,
    unrelatedMeet: 'meet-unrelated',
    unrelatedBlock: `${EVENT}:other4:other5`,
  };
  for (const [id, other] of [['meet-one', 'other1'], ['meet-two', 'other2']]) {
    cluster.put(INDEX.meets, id, { event_id: EVENT, meet_id: id, participants: [profileId, other], requester_id: other, state: 'requested', expires_at: future, created_at: new Date().toISOString() });
  }
  cluster.put(INDEX.meets, ids.unrelatedMeet, { event_id: EVENT, meet_id: ids.unrelatedMeet, participants: ['other4', 'other5'], requester_id: 'other4', state: 'requested', expires_at: future });
  cluster.put(INDEX.push, 'push-one', { event_id: EVENT, profile_id: profileId, expires_at: FUTURE });
  cluster.put(INDEX.nudges, 'nudge-one', { event_id: EVENT, profile_ids: [profileId, 'other1'], receivers: [profileId], expires_at: FUTURE });
  const block = (blocker, blocked) => ({ event_id: EVENT, blocker_id: blocker, blocked_id: blocked, blocked_ref: refOf(blocked), created_at: new Date().toISOString(), expires_at: FUTURE });
  cluster.put(INDEX.blocks, ids.ownBlocks[0], block(profileId, 'other1'));
  cluster.put(INDEX.blocks, ids.ownBlocks[1], block(profileId, 'other3'));
  cluster.put(INDEX.blocks, ids.blockedBy, block('other2', profileId));
  cluster.put(INDEX.blocks, ids.unrelatedBlock, block('other4', 'other5'));
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Requests.

let ipCounter = 0;

// Runs one request through a route handler (handlePeopleApi, handleConnectApi or handleBleApi)
// and returns { status, body }.
export async function request(handler, method, path, device, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {
    host: 'caddie.test',
    ...(device ? { 'x-caddie-device': `${device.profileId}.${device.secret}` } : {}),
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
  const handled = await handler(req, res, new URL(path, 'http://caddie.test'));
  assert.equal(handled, true);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}

// Runs fn with console.error and console.log silenced, and returns its result and the lines.
export async function quietly(fn) {
  const lines = [];
  const original = { error: console.error, log: console.log };
  console.error = (...args) => lines.push(args.join(' '));
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
}

// Serves a cluster over loopback HTTP for the CLI scripts. Returns { url, close }.
export async function serve(cluster) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    try {
      const answer = await cluster.handle(req.method, new URL(req.url, 'http://127.0.0.1'), raw);
      const text = await answer.text();
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
