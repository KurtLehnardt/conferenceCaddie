// Profile writes while the text cannot be embedded, run against the in-memory stand-in for
// Elasticsearch in test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// The tests check that PUT /api/people/profile
// - saves the profile without its text, answers degraded: { semantic: true } and pauses semantic
//   matching when the Bulk item fails because of embedding: a 429 (what the inference service's
//   trial limit answered with), a status_exception or inference_exception, or a reason naming
//   inference;
// - still answers 409 for a version conflict, and 502 for a mapping error or a failed Bulk request
//   that is not an inference failure, without pausing anything or dropping the text.
//
// A semantic pause lasts a minute and lives in the module, so each test moves the clock past it.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, newDevice, request, profileBody, esError, json, advanceClock } from './lib/fake-es.mjs';

const { SEMANTIC_PAUSE_MS } = await import('../server/semantic.mjs');
const { handlePeopleApi } = await import('../server/people.mjs');

async function quietly(fn) {
  const lines = [];
  const spy = mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}

const put = (d, o, name = 'Nina') => request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody(name, o));
const docOf = (d) => fake.doc('caddie-people', `${EVENT}:${d.profileId}`);
const TEXT = { expertise: 'Kubernetes operators for Postgres', about: 'SRE', interests: 'eBPF', speak: ['postgres'] };

// Fails the first people Bulk write that carries the text fields, once: with this item, or with
// the Response that item() returns when it is a function.
function failTextWriteOnce(item) {
  let done = false;
  fake.inject = (c) => {
    if (done || c.index !== 'caddie-people' || c.op !== '_bulk') return undefined;
    const [action, payload] = String(c.body).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (!payload || !('about' in payload)) return undefined;
    done = true;
    if (typeof item === 'function') return item();
    return json({ errors: true, items: [{ [Object.keys(action)[0]]: item }] });
  };
}

describe('PUT /api/people/profile when embedding fails', () => {
  for (const [name, item] of [
    ['a 429 item with no error type', { status: 429 }],
    ['a 429 status_exception item (the inference trial limit)', { status: 429, error: { type: 'status_exception', reason: 'Received an unsuccessful status code [429]' } }],
    ['a 400 inference_exception item', { status: 400, error: { type: 'inference_exception', reason: 'x' } }],
    ['a 500 item whose reason names inference', { status: 500, error: { type: 'exception', reason: 'Exception when running inference id [caddie-e5-small]' } }],
    ['a failed Bulk request with an inference error', () => esError(500, 'status_exception', 'inference unavailable')],
  ]) {
    for (const existing of [false, true]) {
      test(`${name}, ${existing ? 'full reindex' : 'create'}: saved without text, degraded, semantic paused`, async () => {
        advanceClock(SEMANTIC_PAUSE_MS + 1000);
        fake.reset();
        const d = newDevice();
        if (existing) assert.equal((await put(d, { speak: ['postgres'] })).status, 200);
        failTextWriteOnce(item);
        const { result, lines } = await quietly(() => put(d, TEXT));
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(result.body.degraded, { semantic: true });
        assert.ok(lines.some((l) => l.includes('Semantic matching paused')), 'semantic is paused');
        const doc = docOf(d);
        assert.equal(doc.expertise, undefined, 'the text is not indexed');
        assert.equal(doc.text_hash, null);
        assert.equal(doc.text_pending, true);
        assert.equal(doc.open_to_meet, true, 'the person stays visible');
      });
    }
  }

  test('a version conflict (409 item) answers 409 and pauses nothing', async () => {
    advanceClock(SEMANTIC_PAUSE_MS + 1000);
    fake.reset();
    const d = newDevice();
    assert.equal((await put(d, { speak: ['postgres'] })).status, 200);
    failTextWriteOnce({ status: 409, error: { type: 'version_conflict_engine_exception', reason: 'version conflict' } });
    const { result, lines } = await quietly(() => put(d, TEXT));
    assert.equal(result.status, 409);
    assert.ok(!lines.some((l) => l.includes('Semantic matching paused')));
  });

  for (const [name, item] of [
    ['a mapping error (400 item) whose reason quotes the text', { status: 400, error: { type: 'document_parsing_exception', reason: "failed to parse field [about]: 'inference trial'" } }],
    ['a failed Bulk request that is not an inference failure', () => esError(503, 'injected')],
  ]) {
    test(`${name} answers 502, pauses nothing and keeps the next save's text`, async () => {
      advanceClock(SEMANTIC_PAUSE_MS + 1000);
      fake.reset();
      const d = newDevice();
      assert.equal((await put(d, { speak: ['postgres'] })).status, 200);
      failTextWriteOnce(item);
      const { result, lines } = await quietly(() => put(d, TEXT));
      assert.equal(result.status, 502);
      assert.ok(!lines.some((l) => l.includes('Semantic matching paused')));
      const again = await put(d, TEXT);
      assert.equal(again.status, 200);
      assert.equal(again.body.degraded, undefined);
      assert.equal(docOf(d).expertise, TEXT.expertise);
    });
  }
});
