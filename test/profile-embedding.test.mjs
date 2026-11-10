// Profile writes while the text cannot be embedded, run against the in-memory stand-in for
// Elasticsearch in test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// The tests check that PUT /api/people/profile
// - saves the profile without its text, answers degraded: { semantic: true } and pauses semantic
//   matching when the Bulk item fails because of embedding: a 429 (what the inference service's
//   trial limit answered with), a status_exception or inference_exception, or a reason naming
//   inference;
// - still answers 409 for a version conflict, and 502 for a mapping error or a failed Bulk request
//   that is not an inference failure, without pausing anything or dropping the text;
// - keeps the text of a degraded save in the unindexed pending_* fields, and embeds it on the
//   owner's next write: a profile save (full reindex with the request's text) or a presence write
//   (reembedPending), once semantic matching is available again; until then, and when embedding
//   fails again, the pending text stays and the presence write still succeeds.
//
// A semantic pause lasts a minute and lives in the module, so each test moves the clock past it.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, newDevice, request, profileBody, esError, json, advanceClock } from './lib/fake-es.mjs';

const { SEMANTIC_PAUSE_MS } = await import('../server/semantic.mjs');
const { handlePeopleApi, textHash } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');

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

const presence = (d) => request(handleConnectApi, 'PUT', '/api/presence', d, { event: EVENT, zone: 'Hall A', spot: '' });
// Lets the push nudge that a presence write starts in the background finish.
const settle = () => new Promise((r) => setTimeout(r, 30));
const PENDING = ['pending_about', 'pending_interests', 'pending_expertise', 'text_pending'];

// A profile saved while a 429 item made it degraded; semantic matching is paused afterwards.
async function degradedProfile() {
  advanceClock(SEMANTIC_PAUSE_MS + 1000);
  fake.reset();
  const d = newDevice();
  failTextWriteOnce({ status: 429 });
  const { result } = await quietly(() => put(d, TEXT));
  assert.deepEqual(result.body.degraded, { semantic: true });
  return d;
}

describe('the text of a degraded save', () => {
  test('is kept unindexed in the pending fields', async () => {
    const d = await degradedProfile();
    const doc = docOf(d);
    assert.deepEqual([doc.about, doc.interests, doc.expertise], [undefined, undefined, undefined]);
    assert.deepEqual([doc.pending_about, doc.pending_interests, doc.pending_expertise], [TEXT.about, TEXT.interests, TEXT.expertise]);
    assert.equal(doc.text_hash, null);
  });

  test("is embedded by the owner's next profile save, and the pending fields go", async () => {
    const d = await degradedProfile();
    advanceClock(SEMANTIC_PAUSE_MS + 1000);
    const again = await put(d, TEXT);
    assert.equal(again.status, 200);
    assert.equal(again.body.degraded, undefined);
    const doc = docOf(d);
    assert.equal(doc.expertise, TEXT.expertise);
    assert.equal(doc.text_hash, textHash(TEXT));
    for (const f of PENDING) assert.equal(doc[f], undefined, `${f} is gone`);
  });

  test("is embedded by the owner's next presence write once semantic is back, presence kept", async () => {
    const d = await degradedProfile();
    advanceClock(SEMANTIC_PAUSE_MS + 1000);
    const p = await presence(d);
    await settle();
    assert.equal(p.status, 200);
    const doc = docOf(d);
    assert.deepEqual([doc.about, doc.interests, doc.expertise], [TEXT.about, TEXT.interests, TEXT.expertise]);
    assert.equal(doc.text_hash, textHash(TEXT));
    for (const f of PENDING) assert.equal(doc[f], undefined, `${f} is gone`);
    assert.equal(doc.presence_zone, 'Hall A', 'the presence written just before is kept');
    assert.equal(doc.open_to_meet, true);
  });

  test('stays pending while semantic is paused; the presence write succeeds', async () => {
    const d = await degradedProfile();
    const p = await presence(d);
    await settle();
    assert.equal(p.status, 200);
    const doc = docOf(d);
    assert.equal(doc.pending_expertise, TEXT.expertise);
    assert.equal(doc.expertise, undefined);
    assert.equal(doc.presence_zone, 'Hall A');
  });

  test('stays pending when embedding fails again on the presence write', async () => {
    const d = await degradedProfile();
    advanceClock(SEMANTIC_PAUSE_MS + 1000);
    failTextWriteOnce({ status: 400, error: { type: 'inference_exception', reason: 'x' } });
    const { result } = await quietly(() => presence(d));
    await settle();
    assert.equal(result.status, 200);
    const doc = docOf(d);
    assert.equal(doc.pending_expertise, TEXT.expertise);
    assert.equal(doc.expertise, undefined);
    assert.equal(doc.text_pending, true);
    assert.equal(doc.presence_zone, 'Hall A');
  });
});
