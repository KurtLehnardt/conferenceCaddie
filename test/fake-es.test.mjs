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
