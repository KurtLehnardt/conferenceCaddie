// An in-memory stand-in for the Elasticsearch calls of the people modules, shared by the tests in
// test/. Importing it sets dummy environment values and replaces fetch before any server module is
// imported, so nothing reaches the network: Elasticsearch calls are answered from memory, the stub
// push transport is recorded, and a call to any other host fails the test. Keys and URLs are dummy
// values.
//
// It understands the subset of the query DSL the server sends (bool, term, terms, ids, exists,
// range, match_all, knn, multi_match, distance_feature, standard and rrf retrievers, a terms
// aggregation) well enough to exercise the routes; it ranks nothing. `fake.inject` lets a test
// answer one call itself, to inject a failure.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

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
  if (q.knn) return (!q.knn.filter || matches(q.knn.filter, id, src)) && Boolean(src[SEMANTIC_BASE[q.knn.field]]);
  if (q.multi_match) {
    const words = q.multi_match.query.toLowerCase().split(/\W+/).filter(Boolean);
    return q.multi_match.fields.some((f) => words.some((w) => String(src[f] ?? '').toLowerCase().includes(w)));
  }
  if (q.distance_feature) return get(src, q.distance_feature.field) !== undefined && get(src, q.distance_feature.field) !== null;
  throw new Error(`fake-es: unsupported query ${JSON.stringify(q).slice(0, 120)}`);
}

const pick = (src, spec) => (spec === false ? undefined : Array.isArray(spec) ? Object.fromEntries(spec.filter((f) => src[f] !== undefined).map((f) => [f, src[f]])) : src);

export const fake = {
  indices: new Map(), // name -> Map id -> { source, seq }
  calls: [], // { method, index, op, id, body }
  pushes: [], // { endpoint, payload }
  inject: null, // (call) => Response | undefined
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
  if (body.retriever) {
    if (body.retriever.rrf) {
      filterQ = body.retriever.rrf.filter;
      legs = body.retriever.rrf.retrievers.map((r) => r.standard.query);
    } else {
      filterQ = body.retriever.standard.filter;
      legs = [body.retriever.standard.query];
    }
  }
  let hits = [...fake.store(name)].filter(([id, d]) => matches(filterQ, id, d.source));
  if (legs) hits = hits.filter(([id, d]) => legs.some((q) => matches(q, id, d.source)));
  const from = body.from ?? 0;
  const page = hits.slice(from, from + (body.size ?? 10)).map(([id, d]) => {
    const hit = { _id: id, _source: pick(d.source, body._source), _seq_no: d.seq, _primary_term: 1 };
    if (body.explain && legs) {
      hit._explanation = { value: 1, details: legs.map((q, i) => (matches(q, id, d.source) ? { value: i + 1, description: `rrf score for rank [${i + 1}]` } : { value: 0, description: 'result not found in query' })) };
    }
    return hit;
  });
  const res = { hits: { total: { value: hits.length }, hits: page } };
  if (body.aggs) {
    res.aggregations = {};
    for (const [k, a] of Object.entries(body.aggs)) {
      const counts = new Map();
      for (const [, d] of hits) for (const v of asArray(d.source[a.terms.field])) if (!a.terms.include || a.terms.include.includes(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
      res.aggregations[k] = { buckets: [...counts].map(([key, doc_count]) => ({ key, doc_count })) };
    }
  }
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
export { json };
