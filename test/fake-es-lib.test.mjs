// The in-memory stand-in of test/lib/fake-es.mjs answers the calls the push nudge relies on the
// way Elasticsearch does: top_hits under a terms bucket (sorted, sized, with the asked fields, and
// _seq_no only when asked), and a guarded delete that refuses a document changed since it was
// read, or a missing one.
//
// Run with `npm test`. Nothing here reaches the network: fetch is the stand-in's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, ES_HOST } from './lib/fake-es.mjs';

const call = async (method, path, body) => {
  const res = await fetch(`https://${ES_HOST}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json() };
};

test('top_hits under a terms bucket: newest first, sized, with the asked fields, and _seq_no only when asked', async () => {
  fake.reset();
  const at = (minute) => new Date(Date.UTC(2099, 0, 1, 0, minute)).toISOString();
  fake.put('caddie-people-push', 'a1', { profile_id: 'a', created_at: at(1), token: 'x' });
  fake.put('caddie-people-push', 'a2', { profile_id: 'a', created_at: at(3), token: 'y' });
  fake.put('caddie-people-push', 'a0', { profile_id: 'a', token: 'no date' });
  fake.put('caddie-people-push', 'b1', { profile_id: 'b', created_at: at(0), token: 'w' });
  const top = (extra) => ({ size: 2, sort: [{ created_at: { order: 'desc', unmapped_type: 'date' } }], _source: ['profile_id', 'token'], ...extra });
  const search = (extra) => call('POST', '/caddie-people-push/_search', { size: 0, query: { terms: { profile_id: ['a', 'b'] } }, aggs: { people: { terms: { field: 'profile_id', size: 5 }, aggs: { newest: { top_hits: top(extra) } } } } });
  const { status, json } = await search({ seq_no_primary_term: true });
  assert.equal(status, 200);
  const [a, b] = json.aggregations.people.buckets;
  assert.deepEqual([a.key, a.doc_count, b.key, b.doc_count], ['a', 3, 'b', 1]);
  assert.deepEqual(a.newest.hits.hits.map((h) => h._id), ['a2', 'a1'], 'newest first; a document without the field comes last');
  assert.deepEqual(a.newest.hits.hits[0]._source, { profile_id: 'a', token: 'y' });
  assert.equal(a.newest.hits.hits[0]._seq_no, fake.store('caddie-people-push').get('a2').seq);
  assert.equal(a.newest.hits.hits[0]._primary_term, 1);
  assert.deepEqual(b.newest.hits.hits.map((h) => h._id), ['b1']);
  const plain = (await search({})).json;
  assert.equal(plain.aggregations.people.buckets[0].newest.hits.hits[0]._seq_no, undefined, 'no _seq_no unless asked');
});

test('a guarded delete refuses a document changed since it was read, or a missing one, with 409', async () => {
  fake.reset();
  fake.put('caddie-people-push', 'r', { token: 'old' });
  const read = fake.store('caddie-people-push').get('r').seq;
  fake.put('caddie-people-push', 'r', { token: 'new' });
  assert.equal((await call('DELETE', `/caddie-people-push/_doc/r?if_seq_no=${read}&if_primary_term=1`)).status, 409);
  assert.equal(fake.doc('caddie-people-push', 'r').token, 'new');
  const now = fake.store('caddie-people-push').get('r').seq;
  assert.equal((await call('DELETE', `/caddie-people-push/_doc/r?if_seq_no=${now}&if_primary_term=2`)).status, 409, 'another primary term');
  assert.equal((await call('DELETE', `/caddie-people-push/_doc/r?if_seq_no=${now}&if_primary_term=1`)).status, 200);
  assert.equal(fake.doc('caddie-people-push', 'r'), undefined);
  assert.equal((await call('DELETE', `/caddie-people-push/_doc/r?if_seq_no=${now}&if_primary_term=1`)).status, 409, 'missing, guarded');
  assert.equal((await call('DELETE', '/caddie-people-push/_doc/r')).status, 404, 'missing, unguarded');
});
