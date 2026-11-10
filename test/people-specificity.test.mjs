// The specificity rule and the semantic floor of the people ranking, run against the in-memory
// stand-in for Elasticsearch in test/lib/fake-es.mjs, whose rrf explanations have the shape
// Elasticsearch 9.5.6 returns on the people index (test/lib/rrf-explanation.mjs). Run with
// `npm test`; nothing reaches the network.
//
// A live diagnosis on 2026-11-10 found two faults on the tier 3 server. matchedLegs read the top
// level of the explanation as one detail per retriever, but Elasticsearch 9.5 puts the rrf node one
// level down, next to the rrf filter's required clause, so the top level always has two details.
// With two legs and the topics leg first, every hit then looked found by topics alone and a person
// found only by their text was dropped as broad; with three legs or more no hit's legs could be
// read and the rule was off, so generic matches were shown, pushed and listed. And the semantic
// legs had no similarity floor, so with the E5 model every profile joined every semantic leg.
// The tests check that
// - matchedLegs reads the legs from the captured explanation, from the rrf node at the top (the
//   older shape) and down to three levels below it, and gives null for anything else;
// - with chips and text (two legs, topics first) a person found only by the text leg is kept, and
//   with three legs a person who shares only a common topic is dropped, in matches, in the push
//   nudge and in Bluetooth sightings alike;
// - when the legs are unknown (the cluster refused the explanation), matches keep every hit while
//   the nudge and the sightings keep only those who share a topic outside the common ones;
// - every semantic leg carries the similarity floor, a profile under it joins no semantic leg,
//   and PEOPLE_SEMANTIC_MIN_SIMILARITY is read as documented.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fake, EVENT, FUTURE, newDevice, hashOf, request, esError } from './lib/fake-es.mjs';
import { CAPTURED } from './lib/rrf-explanation.mjs';

delete process.env.BLE_MASTER_KEYRING;
delete process.env.PEOPLE_SEMANTIC_MIN_SIMILARITY;

// Read from the module object, so that on a server without these exports the tests that use them
// fail one by one instead of the whole file failing to load.
const people = await import('../server/people.mjs');
const { handlePeopleApi, isBroad } = people;
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
const { handleBleApi } = await import('../server/ble.mjs');
const { refFor } = await import('../server/device.mjs');

const PEOPLE = 'caddie-people';
const CONF = { slug: EVENT, timeZone: 'UTC', visibleUntil: FUTURE };
const iso = (ms) => new Date(ms).toISOString();

// A live, visible people document, put straight into the store as the server writes one, around
// in Hall A with a live legacy Bluetooth token.
function person(name, fields = {}) {
  const d = newDevice();
  const now = Date.now();
  d.name = name;
  d.token = crypto.randomBytes(16).toString('base64url');
  fake.put(PEOPLE, `${EVENT}:${d.profileId}`, {
    event_id: EVENT, profile_id: d.profileId, ref: refFor(EVENT, d.profileId), secret_hash: hashOf(d.secret),
    display_name: name, about: '', interests: '', expertise: '', sample: false, learn_topics: [], speak_topics: [],
    open_to_meet: true, shared_talk_ids: [], visible_until: FUTURE,
    presence_zone: 'Hall A', presence_since: iso(now), presence_until: iso(now + 30 * 60_000),
    ble_token: d.token, ble_token_until: iso(now + 10 * 60_000),
    ...fields,
  });
  return d;
}

// The requesters. In the stand-in's topics, kubernetes and ai are among the ten most common and
// ebpf is not.
const REQUESTERS = {
  // Chips and text: the topics leg, then the text leg.
  'two legs (chips and text)': { learn_topics: ['kubernetes', 'ebpf'], interests: 'kernel tracing with eBPF' },
  // Chips on both sides and text: two topics legs and the text leg.
  'three legs': { learn_topics: ['kubernetes', 'ebpf'], speak_topics: ['ai'], interests: 'kernel tracing with eBPF' },
};

// One requester and four people around in Hall A: one found only by the text leg, one who shares
// a rare topic, and two who share only a common topic (kubernetes, which the requester wants to
// learn, and ai, which the three-legged requester speaks to and they want to learn).
function scene(requester) {
  fake.reset();
  const me = person('Me', requester);
  const others = [
    person('Text Only', { expertise: 'Built kernel tracing tools with eBPF for forty clusters' }),
    person('Rare Topic', { speak_topics: ['ebpf'] }),
    person('Common Topic', { speak_topics: ['kubernetes'] }),
    person('Common Learner', { learn_topics: ['ai'] }),
  ];
  fake.calls.length = 0;
  return { me, others, nameOf: new Map(others.map((d) => [d.profileId, d.name])) };
}

const sorted = (names) => [...names].sort();
async function matchNames(s, body = {}) {
  const r = await request(handlePeopleApi, 'POST', '/api/people/matches', s.me, { event: EVENT, interested_talk_ids: [], ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return sorted(r.body.results.map((p) => p.display_name));
}
async function nudgedNames(s) {
  const me = fake.doc(PEOPLE, `${EVENT}:${s.me.profileId}`);
  await nudgeAfterPresence(me, CONF);
  return sorted([...fake.store('caddie-people-nudges').values()].map((n) => s.nameOf.get(n.source.profile_ids.find((id) => id !== s.me.profileId))));
}
async function sightedNames(s) {
  const r = await request(handleBleApi, 'POST', '/api/presence/sightings', s.me, { event: EVENT, sightings: s.others.map((d) => ({ token: d.token, rssi: -50 })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return sorted(r.body.nearby.map((p) => p.display_name));
}
const retrieversOf = (call) => call.body.retriever.rrf?.retrievers.map((r) => r.standard) ?? [call.body.retriever.standard];

describe('matchedLegs reads the rrf node wherever Elasticsearch puts it', () => {
  const legs = ['topics', 'text', 'text'];
  const wrap = (node, levels) => (levels === 0 ? node : { value: node.value, description: 'sum of:', details: [wrap(node, levels - 1)] });

  test('the explanation captured from Elasticsearch 9.5.6: found by the second and third legs', () => {
    assert.deepEqual(people.matchedLegs({ _explanation: CAPTURED }, legs), [1, 2]);
  });

  test('the rrf node at the top, as older versions return it, and down to three levels below it', () => {
    const node = CAPTURED.details[0];
    for (const levels of [0, 1, 2, 3]) assert.deepEqual(people.matchedLegs({ _explanation: wrap(node, levels) }, legs), [1, 2], `${levels} levels down`);
  });

  test('null when the legs cannot be read: no explanation, no rrf node, a node four levels down, or a different number of legs', () => {
    const node = CAPTURED.details[0];
    assert.equal(people.matchedLegs({}, legs), null);
    assert.equal(people.matchedLegs({ _explanation: { value: 1, description: 'sum of:', details: [] } }, legs), null);
    assert.equal(people.matchedLegs({ _explanation: wrap(node, 4) }, legs), null);
    assert.equal(people.matchedLegs({ _explanation: CAPTURED }, ['topics', 'text']), null, 'the old reading: two top-level details for two legs');
    assert.equal(people.matchedLegs({ _explanation: CAPTURED }, ['topics', 'text', 'text', 'text']), null);
  });

  test('isBroad: unknown legs keep the hit with "specific" and judge it by its topics by default', () => {
    const me = { learn_topics: ['kubernetes', 'ebpf'] };
    const common = new Set(['kubernetes']);
    const hit = (speak) => ({ _source: { speak_topics: speak } });
    for (const speak of [[], ['kubernetes'], ['ebpf']]) assert.equal(isBroad(hit(speak), legs, me, common, { unknown: 'specific' }), false, `speak ${speak}`);
    assert.equal(isBroad(hit([]), legs, me, common), true, 'no shared topic');
    assert.equal(isBroad(hit(['kubernetes']), legs, me, common), true, 'a common topic only');
    assert.equal(isBroad(hit(['ebpf']), legs, me, common), false, 'a rare topic');
  });
});

for (const [label, requester] of Object.entries(REQUESTERS)) {
  describe(`the specificity rule with ${label}`, () => {
    const expected = ['Rare Topic', 'Text Only'];

    test('matches keep the text-only and rare-topic matches and drop the common-topic ones', async () => {
      const s = scene(requester);
      assert.deepEqual(await matchNames(s), expected);
      const legs = retrieversOf(fake.peopleSearches()[0]).map((r) => r._name.split('-')[0]);
      assert.deepEqual(legs, label.startsWith('two') ? ['topics', 'text'] : ['topics', 'topics', 'text']);
    });

    test('a text search applies the same rule', async () => {
      const s = scene(requester);
      assert.deepEqual(await matchNames(s, { query: 'kernel tracing' }), expected);
    });

    test('the push nudge reaches the same people', async () => {
      const s = scene(requester);
      assert.deepEqual(await nudgedNames(s), expected);
    });

    test('Bluetooth sightings answer the same people', async () => {
      const s = scene(requester);
      assert.deepEqual(await sightedNames(s), expected);
    });
  });
}

describe('when the cluster refuses the explanation', () => {
  const refuse = (c) => (c.index === PEOPLE && c.op === '_search' && c.body?.retriever && c.body.explain ? esError(400, 'illegal_argument_exception', 'explain refused') : undefined);
  const requester = REQUESTERS['three legs'];

  test('matches keep every hit', async () => {
    const s = scene(requester);
    fake.inject = refuse;
    assert.deepEqual(await matchNames(s), ['Common Learner', 'Common Topic', 'Rare Topic', 'Text Only']);
    assert.equal(fake.peopleSearches().length, 2, 'refused, then run again without the explanation');
  });

  test('the push nudge and Bluetooth sightings keep only a person who shares a rare topic', async () => {
    let s = scene(requester);
    fake.inject = refuse;
    assert.deepEqual(await nudgedNames(s), ['Rare Topic']);
    s = scene(requester);
    fake.inject = refuse;
    assert.deepEqual(await sightedNames(s), ['Rare Topic']);
  });
});

describe('the semantic floor', () => {
  test('every semantic leg of matches, a text search, the nudge and the sightings carries similarity 0.84', async () => {
    const s = scene({ ...REQUESTERS['three legs'], expertise: 'eBPF load balancers' });
    await matchNames(s);
    await matchNames(s, { query: 'kernel tracing' });
    await nudgedNames(s);
    await sightedNames(s);
    const knns = fake.peopleSearches().flatMap((c) => retrieversOf(c).map((r) => r.query.knn).filter(Boolean));
    // Two in matches (interests and expertise), three in the search (the query twice, expertise),
    // two in the nudge and two in the sightings.
    assert.equal(knns.length, 9);
    for (const k of knns) assert.equal(k.similarity, 0.84, k.field);
  });

  test('a profile under the floor joins no semantic leg, so sharing a common topic leaves it broad', async () => {
    const s = scene(REQUESTERS['two legs (chips and text)']);
    person('Unrelated', { expertise: 'Sourdough baking and laminated pastry', speak_topics: ['kubernetes'] });
    s.nameOf.set([...fake.store(PEOPLE).values()].at(-1).source.profile_id, 'Unrelated');
    // The stand-in's cosine: 0.9 for kernel tracing text, 0.8 (the E5 level of unrelated text)
    // for the rest.
    fake.cosine = (_q, passage) => (/kernel|ebpf/i.test(passage) ? 0.9 : 0.8);
    assert.deepEqual(await matchNames(s), ['Rare Topic', 'Text Only']);
    fake.cosine = (_q, passage) => (/kernel|ebpf/i.test(passage) ? 0.9 : 0.84);
    assert.deepEqual(await matchNames(s), ['Rare Topic', 'Text Only', 'Unrelated'], 'at the floor it is kept');
  });

  test('PEOPLE_SEMANTIC_MIN_SIMILARITY: unset, empty or not a number is 0.84, "off" is no floor, others are clamped to -1..1', () => {
    const parse = people.semanticMinSimilarity;
    assert.equal(people.SEMANTIC_MIN_SIMILARITY, 0.84);
    for (const v of [undefined, null, '', '  ', 'abc']) assert.equal(parse(v), 0.84, String(v));
    assert.equal(parse(' 0.9 '), 0.9);
    assert.equal(parse('0'), 0);
    assert.equal(parse('off'), null);
    assert.equal(parse('OFF'), null);
    assert.equal(parse('2'), 1);
    assert.equal(parse('-3'), -1);
  });
});
