// When semantic matching falls back to keywords, run against the in-memory stand-in for
// Elasticsearch in test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// The tests check that
// - isInferenceFailure (server/semantic.mjs) recognises the errors the inference endpoint causes
//   (status_exception, inference_exception, model_deployment_*, a reason naming inference or a
//   trial limit) and nothing else (a shard failure, a rejected request, a version conflict, a
//   mapping error whose reason quotes the document);
// - people matches, circle members, talk search and recommendations pause semantic queries and
//   answer with keyword legs only after an inference failure, and that any other failure (here a
//   503 whose error type is not an inference one) fails that request alone and pauses nothing;
// - Bluetooth sightings and the push nudge fall back the same way instead of failing (a 502 for
//   every sightings report, a dropped nudge) while inference is down.
//
// Semantic pauses last a minute and live in the module, so the tests that pause run after those
// that must not, and each one moves the clock past the previous pause first.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, FUTURE, newDevice, request, profileBody, esError, json, advanceClock } from './lib/fake-es.mjs';

const { isInferenceFailure, esErrorInfo, SEMANTIC_PAUSE_MS } = await import('../server/semantic.mjs');
const { handlePeopleApi } = await import('../server/people.mjs');
const { handleRecommendationsApi } = await import('../server/recommend.mjs');
const { validate: validateSearch, search } = await import('../server/search.mjs');
const { handleBleApi } = await import('../server/ble.mjs');
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };

// Moves the clock past any semantic pause for the rest of the file.
const skipPause = () => advanceClock(SEMANTIC_PAUSE_MS + 1000);

// Runs fn with console.error silenced; returns its result and the lines it would have logged.
async function quietly(fn) {
  const lines = [];
  const spy = mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}

const semanticBody = (body) => JSON.stringify(body ?? '').includes('query_vector_builder');

describe('isInferenceFailure', () => {
  const err = (error) => esErrorInfo(error);
  for (const [name, error] of [
    ['status_exception (an upstream 429 or 5xx wrapped by the inference service)', { type: 'status_exception', reason: 'Received an unsuccessful status code' }],
    ['inference_exception', { type: 'inference_exception', reason: 'x' }],
    ['a model deployment failure', { type: 'model_deployment_timeout_exception', reason: 'x' }],
    ['a root cause that names inference', { type: 'search_phase_execution_exception', root_cause: [{ type: 'inference_not_found_exception', reason: 'x' }] }],
    ['a caused_by chain ending in status_exception', { type: 'search_phase_execution_exception', caused_by: { type: 'illegal_state_exception', caused_by: { type: 'status_exception' } } }],
    ['a reason naming a trial limit', { type: 'exception', reason: 'You have reached the trial limit' }],
    ['a reason naming inference', { type: 'illegal_argument_exception', reason: 'Exception when running inference id [x] on field [about]' }],
  ]) {
    test(`true for ${name}`, () => assert.equal(isInferenceFailure(err(error)), true));
  }
  for (const [name, error] of [
    ['an injected shard failure', { type: 'injected' }],
    ['a rejected request', { type: 'es_rejected_execution_exception', reason: 'rejected execution of coordinating operation' }],
    ['a version conflict', { type: 'version_conflict_engine_exception', reason: 'version conflict' }],
    ['a mapping error quoting the text', { type: 'document_parsing_exception', reason: "failed to parse field [about]: 'inference trial'" }],
    ['no error object at all', undefined],
  ]) {
    test(`false for ${name}`, () => assert.equal(isInferenceFailure(err(error)), false));
  }
  test('false for a transport error without details', () => assert.equal(isInferenceFailure(new Error('timeout')), false));
});

// Two visible people with text, so every matches query has semantic legs.
async function twoPeople() {
  fake.reset();
  const asker = newDevice();
  const other = newDevice();
  assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', asker, profileBody('Asker', { interests: 'gpu scheduling', learn: ['gpu'] }))).status, 200);
  assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', other, profileBody('Other', { expertise: 'gpu scheduling on kubernetes', speak: ['gpu'], shared: [`${EVENT}:t1`] }))).status, 200);
  assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', asker, profileBody('Asker', { interests: 'gpu scheduling', learn: ['gpu'], shared: [`${EVENT}:t1`] }))).status, 200);
  fake.calls.length = 0;
  return { asker, other };
}
const matchesOf = (d) => request(handlePeopleApi, 'POST', '/api/people/matches', d, { event: EVENT, interested_talk_ids: [] });
const membersOf = (d) => request(handlePeopleApi, 'POST', '/api/circles/members', d, { event: EVENT, talk_id: `${EVENT}:t1` });

describe('people matches and circle members', () => {
  for (const [route, send] of [['matches', matchesOf], ['members', membersOf]]) {
    test(`${route}: a non-inference failure answers 502 and pauses nothing`, async () => {
      skipPause();
      const { asker } = await twoPeople();
      let failed = 0;
      fake.inject = (c) => (c.index === 'caddie-people' && c.body?.retriever && failed++ === 0 ? esError(503, 'injected') : undefined);
      const first = await quietly(() => send(asker));
      assert.equal(first.result.status, 502);
      assert.ok(!first.lines.some((l) => l.includes('Semantic matching paused')), 'no pause was logged');
      const second = await send(asker);
      assert.equal(second.status, 200);
      assert.equal(second.body.degraded, undefined);
      assert.ok(semanticBody(fake.peopleSearches().at(-1).body), 'the next request is semantic again');
    });

    test(`${route}: an inference failure answers with keyword legs and pauses semantic`, async () => {
      skipPause();
      const { asker } = await twoPeople();
      fake.inject = (c) => (c.index === 'caddie-people' && semanticBody(c.body) ? esError(500, 'status_exception', 'inference endpoint unavailable') : undefined);
      const first = await quietly(() => send(asker));
      assert.equal(first.result.status, 200);
      if (route === 'matches') assert.deepEqual(first.result.body.degraded, { semantic: true });
      assert.ok(first.lines.some((l) => l.includes('Semantic matching paused') && l.includes('status_exception')), first.lines.join('\n'));
      const searches = fake.peopleSearches();
      assert.equal(searches.length, 2);
      assert.ok(semanticBody(searches[0].body) && !semanticBody(searches[1].body), 'semantic, then keyword-only');
      fake.calls.length = 0;
      const second = await send(asker);
      assert.equal(second.status, 200);
      assert.equal(fake.peopleSearches().length, 1);
      assert.ok(!semanticBody(fake.peopleSearches()[0].body), 'paused: keyword-only straight away');
    });
  }
});

// The talk indices answer from injection only: a semantic search fails the way the test says, and
// every other search answers with no hits.
function talksInjection(how) {
  const empty = { hits: { total: { value: 0 }, hits: [] }, aggregations: {} };
  return (c) => {
    if (c.index !== 'caddie-talks' && c.index !== 'caddie-topics') return undefined;
    if (c.op === '_msearch') {
      const bodies = String(c.body).split('\n').filter(Boolean).filter((_, i) => i % 2 === 1);
      if (bodies.some((b) => b.includes('query_vector_builder')) && how) {
        return how === 'inference'
          ? json({ responses: bodies.map(() => ({ status: 400, error: { type: 'status_exception', reason: 'inference failed' } })) })
          : esError(503, 'injected');
      }
      return json({ responses: bodies.map(() => ({ status: 200, ...empty })) });
    }
    if (c.op === '_search') {
      if (semanticBody(c.body) && how) return how === 'inference' ? esError(429, 'status_exception', 'trial limit') : esError(503, 'injected');
      return json(empty);
    }
    return undefined;
  };
}

describe('talk search and recommendations', () => {
  const runSearch = async () => {
    try {
      return { ok: true, value: await search(await validateSearch({ conference: EVENT, query: 'gpu scheduling' })) };
    } catch (err) {
      return { ok: false, err };
    }
  };
  const recommend = () => request(handleRecommendationsApi, 'POST', '/api/recommendations', null, { event: EVENT, interests: 'gpu scheduling', learn_topics: [] });

  test('search: a non-inference failure fails the request and pauses nothing', async () => {
    skipPause();
    fake.reset();
    fake.inject = talksInjection('other');
    const { result, lines } = await quietly(runSearch);
    assert.equal(result.ok, false);
    assert.ok(!lines.some((l) => l.includes('Semantic matching paused')));
  });

  test('recommendations: a non-inference failure answers 502 and pauses nothing', async () => {
    skipPause();
    fake.reset();
    fake.inject = talksInjection('other');
    const { result, lines } = await quietly(recommend);
    assert.equal(result.status, 502);
    assert.ok(!lines.some((l) => l.includes('Semantic matching paused')));
  });

  test('search: an inference failure in an msearch item answers keyword-only and says so', async () => {
    skipPause();
    fake.reset();
    fake.inject = talksInjection('inference');
    const { result, lines } = await quietly(runSearch);
    assert.equal(result.ok, true, String(result.err));
    assert.deepEqual(result.value.degraded, { semantic: true });
    assert.ok(lines.some((l) => l.includes('Semantic matching paused')));
  });

  test('recommendations: an inference failure answers keyword-only and says so', async () => {
    skipPause();
    fake.reset();
    fake.inject = talksInjection('inference');
    const { result } = await quietly(recommend);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.degraded, { semantic: true });
  });
});

// Two people around in Hall A with live Bluetooth tokens and a push subscription each. Presence is
// written straight into the stand-in, so no background nudge runs while a test injects failures.
async function twoAround() {
  const { asker, other } = await twoPeople();
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  const around = (d, token) => {
    const id = `${EVENT}:${d.profileId}`;
    fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_since: new Date().toISOString(), presence_until: until, ble_token: token, ble_token_until: until });
    fake.put('caddie-people-push', `push-${token}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  };
  around(asker, 'AAAAAAAAAAAAAAAAAAAAAA');
  around(other, 'BBBBBBBBBBBBBBBBBBBBBB');
  fake.calls.length = 0;
  return { asker, other };
}
const sightings = (d) => request(handleBleApi, 'POST', '/api/presence/sightings', d, { event: EVENT, sightings: [{ token: 'BBBBBBBBBBBBBBBBBBBBBB', rssi: -50 }] });

describe('Bluetooth sightings and the push nudge', () => {
  test('sightings: a non-inference failure still answers 502 and pauses nothing', async () => {
    skipPause();
    const { asker } = await twoAround();
    fake.inject = (c) => (c.index === 'caddie-people' && c.body?.retriever ? esError(503, 'injected') : undefined);
    const { result, lines } = await quietly(() => sightings(asker));
    assert.equal(result.status, 502);
    assert.ok(!lines.some((l) => l.includes('Semantic matching paused')));
  });

  test('sightings: an inference failure answers with keyword legs instead of 502', async () => {
    skipPause();
    const { asker } = await twoAround();
    fake.inject = (c) => (c.index === 'caddie-people' && semanticBody(c.body) ? esError(500, 'status_exception', 'inference unavailable') : undefined);
    const { result } = await quietly(() => sightings(asker));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.nearby.map((p) => p.display_name), ['Other']);
    const searches = fake.peopleSearches();
    assert.ok(searches.length === 2 && semanticBody(searches[0].body) && !semanticBody(searches[1].body), 'semantic, then keyword-only');
  });

  test('nudge: an inference failure still nudges, with keyword legs', async () => {
    skipPause();
    const { asker } = await twoAround();
    fake.inject = (c) => (c.index === 'caddie-people' && semanticBody(c.body) ? esError(500, 'status_exception', 'inference unavailable') : undefined);
    const me = { ...fake.doc('caddie-people', `${EVENT}:${asker.profileId}`), expertise: 'eBPF tracing' };
    await quietly(() => nudgeAfterPresence(me, { slug: EVENT, timeZone: 'UTC', visibleUntil: FUTURE }, NO_PAUSE));
    assert.ok(fake.pushes.length >= 1, 'a push was sent');
    assert.ok(fake.pushes.every((p) => /^Someone who's worked on .+ is in Hall A right now$/.test(p.payload.body)), JSON.stringify(fake.pushes));
    const searches = fake.peopleSearches();
    assert.ok(searches.length === 2 && semanticBody(searches[0].body) && !semanticBody(searches[1].body), 'semantic, then keyword-only');
  });
});
