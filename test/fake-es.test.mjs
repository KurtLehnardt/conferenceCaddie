// The in-memory stand-in of test/helpers/fake-es.mjs refuses what Elasticsearch refuses, so the
// other tests cannot pass on a write that the real cluster would answer differently.
//
// Run with `npm test`. Nothing here reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeES, INDEX, ES_HOST } from './helpers/fake-es.mjs';

const call = async (cluster, method, path, body) => {
  const res = await cluster.handle(method, new URL(`https://${ES_HOST}${path}`), body);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const ndjson = (...lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

test('a guarded delete of a missing document answers 409, an unguarded one 404', async () => {
  const cluster = new FakeES();
  assert.equal((await call(cluster, 'DELETE', `/${INDEX.people}/_doc/gone?if_seq_no=3&if_primary_term=1`)).status, 409);
  assert.equal((await call(cluster, 'DELETE', `/${INDEX.people}/_doc/gone`)).status, 404);
});

test('a guarded Bulk index of a missing document is item 409', async () => {
  const cluster = new FakeES();
  const { status, json } = await call(cluster, 'POST', `/${INDEX.people}/_bulk`, ndjson({ index: { _id: 'gone', if_seq_no: 3, if_primary_term: 1 } }, { a: 1 }));
  assert.equal(status, 200);
  assert.equal(json.items[0].index.status, 409);
  assert.equal(cluster.source(INDEX.people, 'gone'), null);
});

test('a Bulk action with both if_seq_no and retry_on_conflict fails the whole request with 400', async () => {
  const cluster = new FakeES();
  cluster.put(INDEX.people, 'p', { a: 1 });
  const { status } = await call(cluster, 'POST', `/${INDEX.people}/_bulk`, ndjson({ update: { _id: 'p', if_seq_no: 2, if_primary_term: 1, retry_on_conflict: 3 } }, { doc: { a: 2 } }));
  assert.equal(status, 400);
  assert.equal(cluster.source(INDEX.people, 'p').a, 1);
});

test('a terms aggregation gives each bucket its own top_hits: sorted, sized, with the asked fields, and _seq_no only when asked', async () => {
  const cluster = new FakeES();
  const at = (minute) => new Date(Date.UTC(2099, 0, 1, 0, minute)).toISOString();
  cluster.put(INDEX.push, 'a1', { profile_id: 'a', created_at: at(1), token: 'x' });
  cluster.put(INDEX.push, 'a2', { profile_id: 'a', created_at: at(3), token: 'y' });
  cluster.put(INDEX.push, 'a3', { profile_id: 'a', created_at: at(2), token: 'z' });
  cluster.put(INDEX.push, 'b1', { profile_id: 'b', created_at: at(0), token: 'w' });
  cluster.put(INDEX.push, 'c1', { profile_id: 'c', created_at: at(9), token: 'v' });
  const top = (extra = {}) => ({ size: 2, sort: [{ created_at: { order: 'desc', unmapped_type: 'date' } }], _source: ['profile_id', 'token'], ...extra });
  const body = (extra) => JSON.stringify({ size: 0, query: { terms: { profile_id: ['a', 'b'] } }, aggs: { people: { terms: { field: 'profile_id', size: 5 }, aggs: { newest: { top_hits: top(extra) } } } } });
  const { status, json } = await call(cluster, 'POST', `/${INDEX.push}/_search`, body({ seq_no_primary_term: true }));
  assert.equal(status, 200);
  assert.deepEqual(json.hits.hits, [], 'size 0');
  const [a, b] = json.aggregations.people.buckets;
  assert.deepEqual([a.key, a.doc_count, b.key, b.doc_count], ['a', 3, 'b', 1]);
  assert.deepEqual(a.newest.hits.hits.map((h) => h._id), ['a2', 'a3'], 'newest first, two of three');
  assert.equal(a.newest.hits.total.value, 3);
  assert.deepEqual(a.newest.hits.hits[0]._source, { profile_id: 'a', token: 'y' });
  assert.equal(a.newest.hits.hits[0]._seq_no, cluster.docs(INDEX.push).get('a2').seq);
  assert.equal(a.newest.hits.hits[0]._primary_term, 1);
  assert.deepEqual(b.newest.hits.hits.map((h) => h._id), ['b1']);
  const plain = (await call(cluster, 'POST', `/${INDEX.push}/_search`, body())).json;
  assert.equal(plain.aggregations.people.buckets[0].newest.hits.hits[0]._seq_no, undefined, 'no _seq_no unless asked');
  const one = (await call(cluster, 'POST', `/${INDEX.push}/_search`, JSON.stringify({ size: 0, aggs: { people: { terms: { field: 'profile_id', size: 1 } } } }))).json;
  assert.deepEqual(one.aggregations.people.buckets, [{ key: 'a', doc_count: 3 }], 'the terms size cuts the buckets, the biggest first');
});
