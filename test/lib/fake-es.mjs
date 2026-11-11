// An in-memory stand-in for the Elasticsearch calls of the people modules, shared by the tests in
// test/. Importing it sets dummy environment values and replaces fetch before any server module is
// imported, so nothing reaches the network: Elasticsearch calls are answered from memory, the stub
// push transport is recorded, and a call to any other host fails the test. Keys and URLs are dummy
// values.
//
// It understands the subset of the query DSL the server sends (bool, term, terms, ids, exists,
// range, match_all, knn, multi_match, distance_feature, standard and rrf retrievers, a terms
// aggregation with top_hits under its buckets) well enough to exercise the routes; it ranks
// nothing. `fake.inject` lets a test
// answer one call itself, to inject a failure.
//
// A knn query matches every document whose source field has text, at a cosine of 1, unless a
// test sets `fake.cosine(modelText, passage)`; a knn `similarity` then keeps only the documents
// at or above it, as Elasticsearch does. With `explain: true` an rrf search explains each hit in
// the shape Elasticsearch 9.5.6 returns on the people index (test/lib/rrf-explanation.mjs), or
// with `fake.explanation(ranks, names)` when a test sets it. A highlight asked for on a
// semantic_text field comes back for every hit whose source field has text, whether or not the
// semantic leg found it, as on 9.5.6; its chunk is the field's last sentence.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { rrfExplanation } from './rrf-explanation.mjs';

export const ES_HOST = 'es.caddie.test';
export const PUSH_HOST = 'push.caddie.test';
export const EVENT = 'testconf-2099';
export const FUTURE = '2099-12-31T23:59:59.000Z';

Object.assign(process.env, {
  ES_URL: `https://${ES_HOST}`,
  ES_PEOPLE_API_KEY: 'test-people-key',
  ES_API_KEY: 'test-read-key',
  PUSH_TRANSPORT: 'stub',
  PUSH_STUB_URL: `https://${PUSH_HOST}/record`,
  MOD_CLASSIFIER: 'off',
});

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const toMs = (v) => (v === 'now' ? Date.now() : typeof v === 'string' && /^now-(\d+)d$/.test(v) ? Date.now() - Number(v.slice(4, -1)) * 86400_000 : typeof v === 'string' ? Date.parse(v) : Number(v));
const SEMANTIC_BASE = { expertise_semantic: 'expertise', about_semantic: 'about', interests_semantic: 'interests' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export function matches(q, id, src) {
  if (!q || q.match_all) return true;
  if (q.bool) {
    const b = q.bool;
    if (!asArray(b.filter).every((c) => matches(c, id, src))) return false;
    if (!asArray(b.must).every((c) => matches(c, id, src))) return false;
    if (asArray(b.must_not).some((c) => matches(c, id, src))) return false;
    const should = asArray(b.should);
    if (should.length) {
      const min = b.minimum_should_match ?? (b.filter || b.must || b.must_not ? 0 : 1);
      if (should.filter((c) => matches(c, id, src)).length < min) return false;
    }
    return true;
  }
  if (q.term) {
    const [f, v] = Object.entries(q.term)[0];
    return asArray(get(src, f)).includes(typeof v === 'object' && v !== null ? v.value : v);
  }
  if (q.terms) {
    const [f, vs] = Object.entries(q.terms)[0];
    const have = asArray(get(src, f));
    return vs.some((v) => have.includes(v));
  }
  if (q.ids) return q.ids.values.includes(id);
  if (q.exists) return get(src, q.exists.field) !== undefined && get(src, q.exists.field) !== null;
  if (q.range) {
    const [f, r] = Object.entries(q.range)[0];
    const v = get(src, f);
    if (v === undefined || v === null) return false;
    const x = toMs(v);
    return !((r.gt !== undefined && !(x > toMs(r.gt))) || (r.gte !== undefined && !(x >= toMs(r.gte))) || (r.lt !== undefined && !(x < toMs(r.lt))) || (r.lte !== undefined && !(x <= toMs(r.lte))));
  }
  if (q.knn) {
    const passage = src[SEMANTIC_BASE[q.knn.field]];
    if ((q.knn.filter && !matches(q.knn.filter, id, src)) || !passage) return false;
    const model = q.knn.query_vector_builder?.text_embedding?.model_text ?? '';
    return q.knn.similarity === undefined || (fake.cosine ? fake.cosine(model, passage) : 1) >= q.knn.similarity;
  }
  if (q.multi_match) {
    const words = q.multi_match.query.toLowerCase().split(/\W+/).filter(Boolean);
    return q.multi_match.fields.some((f) => words.some((w) => String(src[f] ?? '').toLowerCase().includes(w)));
  }
  if (q.distance_feature) return get(src, q.distance_feature.field) !== undefined && get(src, q.distance_feature.field) !== null;
  throw new Error(`fake-es: unsupported query ${JSON.stringify(q).slice(0, 120)}`);
}

const pick = (src, spec) => (spec === false ? undefined : Array.isArray(spec) ? Object.fromEntries(spec.filter((f) => src[f] !== undefined).map((f) => [f, src[f]])) : src);

// Sorts [id, doc] entries by a search's sort ([{ field: { order } }] or [{ field: order }]): a
// document without the field comes last, whichever the order, as in Elasticsearch.
function sorted(entries, sort) {
  const specs = asArray(sort).map((x) => {
    const [[field, o]] = Object.entries(typeof x === 'string' ? { [x]: 'asc' } : x);
    return [field, (typeof o === 'string' ? o : o?.order) === 'desc' ? -1 : 1];
  });
  if (!specs.length) return entries;
  return [...entries].sort(([, a], [, b]) => {
    for (const [field, dir] of specs) {
      const x = get(a.source, field);
      const y = get(b.source, field);
      if (x === y) continue;
      if (x === undefined || x === null) return 1;
      if (y === undefined || y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  });
}

// The aggregations of a search over its matching [id, doc] entries: terms buckets (as before, by
// first appearance, include honoured), each with its own sub-aggregations, and top_hits (size 3 by
// default, sort, _source, and _seq_no and _primary_term only with seq_no_primary_term).
function aggregate(name, entries, aggs) {
  const out = {};
  for (const [k, a] of Object.entries(aggs)) {
    if (a.top_hits) {
      const { size = 3, sort, _source: source, seq_no_primary_term: withSeq } = a.top_hits;
      const hits = sorted(entries, sort).slice(0, size).map(([id, d]) => ({ _index: name, _id: id, _source: pick(d.source, source), ...(withSeq === true ? { _seq_no: d.seq, _primary_term: 1 } : {}) }));
      out[k] = { hits: { total: { value: entries.length, relation: 'eq' }, hits } };
      continue;
    }
    const groups = new Map();
    for (const e of entries) {
      for (const v of asArray(e[1].source[a.terms.field])) {
        if (a.terms.include && !a.terms.include.includes(v)) continue;
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(e);
      }
    }
    out[k] = { buckets: [...groups].map(([key, docs]) => ({ key, doc_count: docs.length, ...(a.aggs ? aggregate(name, docs, a.aggs) : {}) })) };
  }
  return out;
}

export const fake = {
  indices: new Map(), // name -> Map id -> { source, seq }
  calls: [], // { method, index, op, id, body }
  pushes: [], // { endpoint, payload }
  inject: null, // (call) => Response | undefined
  cosine: null, // (modelText, passage) => the cosine a knn query sees; null for 1 everywhere
  explanation: null, // (ranks, names) => the explanation of an rrf hit; null for rrfExplanation
  seq: 1,
  store(name) {
    if (!this.indices.has(name)) this.indices.set(name, new Map());
    return this.indices.get(name);
  },
  doc(name, id) {
    return this.store(name).get(id)?.source;
  },
  put(name, id, source) {
    this.store(name).set(id, { source, seq: this.seq++ });
  },
  /** Clears every index and the logs, then seeds one live conference with topics and two rooms. */
  reset() {
    this.indices.clear();
    this.calls.length = 0;
    this.pushes.length = 0;
    this.inject = null;
    this.cosine = null;
    this.explanation = null;
    this.put('caddie-conferences', EVENT, { slug: EVENT, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' });
    for (const [i, t] of ['kubernetes', 'ai', 'cloud', 'security', 'observability', 'platform', 'gitops', 'networking', 'storage', 'wasm', 'ebpf', 'gpu', 'postgres'].entries()) {
      this.put('caddie-topics', `${EVENT}:${t}`, { conference: EVENT, topic_id: t, label: t, talk_count: 100 - i });
    }
    this.put('caddie-talks', `${EVENT}:t1`, { talk_id: `${EVENT}:t1`, conference: EVENT, kind: 'talk', title: 'Talk One', room: 'Hall A' });
    this.put('caddie-talks', `${EVENT}:t2`, { talk_id: `${EVENT}:t2`, conference: EVENT, kind: 'talk', title: 'Talk Two', room: 'Room 201' });
  },
  /** The people-index searches that carried a semantic (knn) leg, and those that did not. */
  peopleSearches() {
    return this.calls.filter((c) => c.index === 'caddie-people' && c.op === '_search' && c.body?.retriever);
  },
};

function search(name, body) {
  let filterQ = body.query;
  let legs = null;
  let names = [];
  if (body.retriever) {
    if (body.retriever.rrf) {
      filterQ = body.retriever.rrf.filter;
      legs = body.retriever.rrf.retrievers.map((r) => r.standard.query);
      names = body.retriever.rrf.retrievers.map((r, i) => r.standard._name ?? `${i}`);
    } else {
      filterQ = body.retriever.standard.filter;
      legs = [body.retriever.standard.query];
    }
  }
  let hits = [...fake.store(name)].filter(([id, d]) => matches(filterQ, id, d.source));
  if (legs) hits = hits.filter(([id, d]) => legs.some((q) => matches(q, id, d.source)));
  // Each retriever's ranks, in store order, for the explanation.
  const ranksOf = legs ? legs.map((q) => new Map(hits.filter(([id, d]) => matches(q, id, d.source)).map(([id], i) => [id, i + 1]))) : [];
  const from = body.from ?? 0;
  const page = hits.slice(from, from + (body.size ?? 10)).map(([id, d]) => {
    const hit = { _id: id, _source: pick(d.source, body._source), _seq_no: d.seq, _primary_term: 1 };
    if (body.explain && legs && body.retriever.rrf) hit._explanation = (fake.explanation ?? rrfExplanation)(ranksOf.map((m) => m.get(id) ?? 0), names);
    else if (body.explain && legs) hit._explanation = { value: 1, description: 'sum of:', details: [] };
    const highlight = {};
    for (const f of Object.keys(body.highlight?.fields ?? {})) {
      const text = SEMANTIC_BASE[f] ? d.source[SEMANTIC_BASE[f]] : undefined;
      if (text) highlight[f] = [String(text).split(/(?<=\.)\s+/).filter(Boolean).at(-1)];
    }
    if (Object.keys(highlight).length) hit.highlight = highlight;
    return hit;
  });
  const res = { hits: { total: { value: hits.length }, hits: page } };
  if (body.aggs) res.aggregations = aggregate(name, hits, body.aggs);
  return res;
}

function write(name, id, source, { create = false, ifSeq } = {}) {
  const cur = fake.store(name).get(id);
  if (create && cur) return 409;
  if (ifSeq !== undefined && ifSeq !== null && (!cur || cur.seq !== Number(ifSeq))) return 409;
  fake.put(name, id, source);
  return cur ? 200 : 201;
}

function bulk(name, text) {
  const lines = String(text).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const [op, meta] = Object.entries(lines[i])[0];
    if (op === 'delete') {
      items.push({ delete: { status: fake.store(name).delete(meta._id) ? 200 : 404 } });
      continue;
    }
    const payload = lines[++i];
    if (op === 'update') {
      const cur = fake.store(name).get(meta._id);
      if (!cur) items.push({ update: { status: 404 } });
      else if (meta.if_seq_no !== undefined && cur.seq !== meta.if_seq_no) items.push({ update: { status: 409 } });
      else {
        fake.put(name, meta._id, { ...cur.source, ...payload.doc });
        items.push({ update: { status: 200 } });
      }
    } else {
      items.push({ [op]: { status: write(name, meta._id, payload, { create: op === 'create', ifSeq: meta.if_seq_no }) } });
    }
  }
  return { items };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  if (url.host === PUSH_HOST) {
    fake.pushes.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  const [index, op, id] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let body;
  try {
    body = init.body && op !== '_bulk' ? JSON.parse(init.body) : init.body;
  } catch {
    body = init.body;
  }
  const call = { method, index, op, id, body, params: url.searchParams };
  // The purge the server starts on import is answered but not recorded.
  const purge = op === '_delete_by_query' || op === '_update_by_query' || url.searchParams.get('preference') === 'caddie-people-purge';
  if (purge) return op === '_search' ? json({ hits: { hits: [] } }) : json({ deleted: 0, updated: 0 });
  fake.calls.push(call);
  const injected = fake.inject?.(call);
  if (injected) return injected;
  if (op === '_search' && body?.query?.percolate) return json({ error: { type: 'index_not_found_exception' } }, 404);
  if (op === '_search') return json(search(index, body ?? {}));
  if (op === '_count') return json({ count: [...fake.store(index)].filter(([i, d]) => matches(body?.query, i, d.source)).length });
  if (op === '_bulk') return json(bulk(index, body));
  if (op === '_mget') {
    return json({ docs: (body.docs ?? []).map((d) => {
      const cur = fake.store(index).get(d._id);
      return cur ? { _id: d._id, found: true, _source: pick(cur.source, d._source) } : { _id: d._id, found: false };
    }) });
  }
  if (op === '_doc' && method === 'GET') {
    const cur = fake.store(index).get(id);
    if (!cur) return json({ found: false }, 404);
    const inc = url.searchParams.get('_source_includes');
    return json({ found: true, _id: id, _source: pick(cur.source, inc ? inc.split(',') : undefined), _seq_no: cur.seq, _primary_term: 1 });
  }
  if (op === '_doc' && method === 'PUT') {
    const s = write(index, id, body, { ifSeq: url.searchParams.get('if_seq_no') });
    return json({ result: s === 409 ? 'conflict' : 'ok' }, s === 409 ? 409 : 200);
  }
  if (op === '_doc' && method === 'DELETE') {
    const had = fake.store(index).delete(id);
    return json({ result: had ? 'deleted' : 'not_found' }, had ? 200 : 404);
  }
  if (op === '_create') {
    const s = write(index, id, body, { create: true });
    return json({ result: s === 409 ? 'conflict' : 'created' }, s === 409 ? 409 : 201);
  }
  if (op === '_update') {
    const cur = fake.store(index).get(id);
    if (!cur) return json({ error: { type: 'document_missing_exception' } }, 404);
    fake.put(index, id, { ...cur.source, ...body.doc });
    return json({ result: 'updated' });
  }
  throw new Error(`fake-es: unsupported ${method} ${url.pathname}`);
};

// The clock the server sees. advanceClock moves Date.now forward for the rest of the test file,
// for example past a semantic pause; the stand-in's 'now' moves with it.
let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;
export function advanceClock(ms) {
  clockOffset += ms;
}

/** A fresh device credential in the client's format. */
export function newDevice() {
  return { profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') };
}

export const hashOf = (secret) => crypto.createHash('sha256').update(secret, 'utf8').digest('hex');

let ipCounter = 0;

/** Runs one request through a route handler (handlePeopleApi and the like); returns { status, body }. */
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
  req.socket = { remoteAddress: `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` };
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
  if (handled !== true) throw new Error(`no route for ${method} ${path}`);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}

/** A profile body for PUT /api/people/profile. */
export const profileBody = (name, o = {}, open = true) => ({
  event: EVENT,
  profile: { display_name: name, about: o.about ?? '', interests: o.interests ?? '', expertise: o.expertise ?? '', learn_topics: o.learn ?? [], speak_topics: o.speak ?? [], linkedin_url: null, contact_note: null },
  open_to_meet: open,
  shared_talk_ids: o.shared ?? [],
});

/** An Elasticsearch error response. */
export const esError = (status, type, reason = 'error') => json({ error: { root_cause: [{ type, reason }], type, reason }, status }, status);
export { json, rrfExplanation };
