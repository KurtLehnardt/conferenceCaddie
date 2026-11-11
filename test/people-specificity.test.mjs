// The specificity rule and the semantic floor of the people ranking, run against the in-memory
// stand-in for Elasticsearch in test/lib/fake-es.mjs, whose rrf explanations have the shape
// Elasticsearch 9.5.6 returns on the people index (test/lib/rrf-explanation.mjs). Run with
// `npm test`; nothing reaches the network.
//
// A live diagnosis on 2026-11-10 found two faults on the tier 3 server. matchedLegs read the top
// level of the explanation as one detail per retriever, but Elasticsearch 9.5 puts the rrf node one
// level down, next to the filter that keeps nested chunk documents out of the hits, so the top
// level always has two details.
// With two legs and the topics leg first, every hit then looked found by topics alone and a person
// found only by their text was dropped as broad; with three legs or more no hit's legs could be
// read and the rule was off, so generic matches were shown, pushed and listed. And the semantic
// legs had no similarity floor, so with the E5 model every profile joined every semantic leg.
// The tests check that
// - matchedLegs reads the legs from the captured explanation, from the rrf node at the top (the
//   older shape) and down to three levels below it, and gives null for anything else, including
//   a detail that names another retriever than the leg at its position;
// - with chips and text (two legs, topics first) a person found only by the text leg is kept, and
//   with three legs a person who shares only a common topic is dropped, in matches, in the push
//   nudge and in Bluetooth sightings alike;
// - when the legs are unknown (the cluster refused the explanation), matches keep every hit while
//   the nudge and the sightings keep only those who share a topic outside the common ones,
//   and that both fallbacks are logged, rarely and without any person's data;
// - each path carries its similarity floor (a search 0.82, matches 0.84, the nudge and the
//   sightings 0.87), a profile under it joins no semantic leg, and the floor variables are read as
//   documented, "off" sending no similarity at all;
// - a semantic chunk is evidence only when the semantic leg on that field found the person;
// - the distance leg counts neither for nor against specificity.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fake, EVENT, FUTURE, newDevice, hashOf, request, esError, advanceClock } from './lib/fake-es.mjs';
import { CAPTURED, rrfExplanation } from './lib/rrf-explanation.mjs';

delete process.env.BLE_MASTER_KEYRING;
for (const k of ['PEOPLE_SEMANTIC_MIN_SIMILARITY', 'PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY', 'PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY']) delete process.env[k];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read from the module object, so that on a server without these exports the tests that use them
// fail one by one instead of the whole file failing to load.
const people = await import('../server/people.mjs');
const { handlePeopleApi, isBroad } = people;
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };
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
  await nudgeAfterPresence(me, CONF, NO_PAUSE);
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

  test('null when a detail names another retriever than the leg at its position', () => {
    assert.equal(people.matchedLegs({ _explanation: CAPTURED }, ['text', 'topics', 'text']), null);
    assert.equal(people.matchedLegs({ _explanation: rrfExplanation([1, 2], ['text-2', 'topics-1']) }, ['topics', 'text']), null);
    assert.deepEqual(people.matchedLegs({ _explanation: rrfExplanation([1, 0], ['topics-1', 'text-2']) }, ['topics', 'text']), [0]);
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

  test('the fallbacks are logged with the conference and the number of legs only, at most once in ten minutes', async () => {
    const lines = [];
    const spy = mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
    try {
      advanceClock(11 * 60_000);
      let s = scene(requester);
      fake.inject = refuse;
      await matchNames(s);
      await nudgedNames(s);
      s = scene(requester);
      fake.explanation = () => ({ value: 1, description: 'sum of:', details: [] });
      await matchNames(s);
      await sightedNames(s);
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(lines, [
      `People search for ${EVENT}: the cluster refused the explanation of a 3-leg query, so the specificity rule falls back (isBroad).`,
      `People search for ${EVENT}: the explanation of a 3-leg query was not recognised, so the specificity rule falls back (isBroad).`,
    ]);
  });

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

describe('the semantic floors', () => {
  test('a search uses 0.82, matches without a query 0.84, and the nudge and the sightings 0.87', async () => {
    const s = scene({ ...REQUESTERS['three legs'], expertise: 'eBPF load balancers' });
    const floors = async (fn) => {
      fake.calls.length = 0;
      await fn();
      return [...new Set(fake.peopleSearches().flatMap((c) => retrieversOf(c).map((r) => r.query.knn).filter(Boolean)).map((k) => k.similarity))];
    };
    assert.deepEqual(people.SEMANTIC_FLOORS, { search: 0.82, profile: 0.84, push: 0.87 });
    assert.deepEqual(await floors(() => matchNames(s)), [0.84]);
    assert.deepEqual(await floors(() => matchNames(s, { when: 'around_now' })), [0.84]);
    assert.deepEqual(await floors(() => matchNames(s, { query: 'kernel tracing' })), [0.82]);
    assert.deepEqual(await floors(() => nudgedNames(s)), [0.87]);
    assert.deepEqual(await floors(() => sightedNames(s)), [0.87]);
    assert.equal(people.semanticFloorsLine(), 'semantic people floors: search 0.82, matches 0.84, nudge and Bluetooth 0.87');
  });

  test('a profile under the floor joins no semantic leg, so sharing a common topic leaves it broad', async () => {
    const s = scene(REQUESTERS['two legs (chips and text)']);
    person('Unrelated', { expertise: 'Sourdough baking and laminated pastry', speak_topics: ['kubernetes'] });
    // The stand-in's cosine: 0.9 for kernel tracing text, 0.8 (the E5 level of unrelated text)
    // for the rest.
    fake.cosine = (_q, passage) => (/kernel|ebpf/i.test(passage) ? 0.9 : 0.8);
    assert.deepEqual(await matchNames(s), ['Rare Topic', 'Text Only']);
    fake.cosine = (_q, passage) => (/kernel|ebpf/i.test(passage) ? 0.9 : 0.84);
    assert.deepEqual(await matchNames(s), ['Rare Topic', 'Text Only', 'Unrelated'], 'at the matches floor it is kept');
  });

  test('a text match between the matches floor and the push floor is shown in matches but neither nudged nor sighted', async () => {
    const s = scene(REQUESTERS['two legs (chips and text)']);
    fake.cosine = (_q, passage) => (/kernel/i.test(passage) ? 0.85 : 0.8);
    assert.deepEqual(await matchNames(s), ['Rare Topic', 'Text Only']);
    assert.deepEqual(await nudgedNames(s), ['Rare Topic']);
    assert.deepEqual(await sightedNames(s), ['Rare Topic']);
  });

  test('floorFrom: unset or empty is the default, "off", "none" and "false" are no floor, and other values warn', () => {
    const { floorFrom } = people;
    for (const v of [undefined, null, '', '  ']) assert.deepEqual(floorFrom(v, 0.84), { floor: 0.84, warning: null }, String(v));
    for (const v of ['off', 'OFF', ' none ', 'false']) assert.deepEqual(floorFrom(v, 0.84), { floor: null, warning: null }, v);
    assert.deepEqual(floorFrom(' 0.9 ', 0.84), { floor: 0.9, warning: null });
    assert.deepEqual(floorFrom('0', 0.84), { floor: 0, warning: null });
    assert.deepEqual(floorFrom('abc', 0.84), { floor: 0.84, warning: 'is not a number or "off", so 0.84 applies' });
    assert.deepEqual(floorFrom('2', 0.84), { floor: 1, warning: 'is outside -1..1, so 1 applies' });
    assert.deepEqual(floorFrom('-3', 0.84), { floor: -1, warning: 'is outside -1..1, so -1 applies' });
  });

  test('set through the environment: "off" sends no similarity at all, and an unusable value warns without quoting it', () => {
    const script = `
      const m = await import('./server/people.mjs');
      const me = { event_id: 'testconf-2099', profile_id: 'me', interests: 'kernel tracing', expertise: 'eBPF' };
      const knns = (q) => q.body.retriever.rrf.retrievers.map((r) => r.standard.query.knn).filter(Boolean);
      const search = knns(m.peopleQuery(me, [], { size: 5, query: 'kernel tracing' }));
      const push = knns(m.peopleQuery(me, [], { size: 5, floor: m.SEMANTIC_FLOORS.push }));
      console.log(JSON.stringify({ floors: m.SEMANTIC_FLOORS, line: m.semanticFloorsLine(), search: search.map((k) => 'similarity' in k), push: push.map((k) => k.similarity) }));`;
    const r = spawnSync(process.execPath, ['--import', './test/lib/fake-es.mjs', '--input-type=module', '-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PEOPLE_SEMANTIC_MIN_SIMILARITY: 'off', PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY: 'zqv-not-a-number', PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY: '2' },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.deepEqual(out.floors, { search: null, profile: 0.84, push: 1 });
    assert.equal(out.line, 'semantic people floors: search off, matches 0.84, nudge and Bluetooth 1');
    assert.deepEqual(out.search, [false, false, false], 'no similarity key on any semantic leg of a search');
    assert.deepEqual(out.push, [1, 1]);
    assert.match(r.stderr, /PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY is not a number or "off", so 0\.84 applies\./);
    assert.match(r.stderr, /PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY is outside -1\.\.1, so 1 applies\./);
    assert.ok(!r.stderr.includes('zqv-not-a-number'), 'the value is not quoted');
  });
});

describe('evidence comes only from a semantic leg that found the person', () => {
  // Rare Chunk is found by its rare topic only (its text is under every floor), so the semantic
  // highlight on its expertise, which Elasticsearch returns anyway, is not evidence. Text Chunk is
  // found by the text leg, so its chunk (the stand-in's last sentence) is.
  const setup = () => {
    const s = scene(REQUESTERS['two legs (chips and text)']);
    s.others.push(person('Rare Chunk', { speak_topics: ['ebpf'], expertise: 'Runs Kubernetes operators at scale. Bakes sourdough on weekends.' }));
    s.others.push(person('Text Chunk', { expertise: 'Ran storage for a bank. Built kernel tracing tools with eBPF.' }));
    s.nameOf = new Map(s.others.map((d) => [d.profileId, d.name]));
    fake.cosine = (_q, passage) => (/kernel/i.test(passage) ? 0.9 : 0.8);
    return s;
  };
  const evidenceIn = (list, name) => list.find((p) => p.display_name === name)?.evidence;

  test('matches', async () => {
    const s = setup();
    const r = await request(handlePeopleApi, 'POST', '/api/people/matches', s.me, { event: EVENT, interested_talk_ids: [] });
    assert.equal(evidenceIn(r.body.results, 'Rare Chunk'), 'Runs Kubernetes operators at scale. Bakes sourdough on weekends');
    assert.equal(evidenceIn(r.body.results, 'Text Chunk'), 'Built kernel tracing tools with eBPF');
  });

  test('Bluetooth sightings', async () => {
    const s = setup();
    const r = await request(handleBleApi, 'POST', '/api/presence/sightings', s.me, { event: EVENT, sightings: s.others.map((d) => ({ token: d.token, rssi: -50 })) });
    assert.equal(evidenceIn(r.body.nearby, 'Rare Chunk'), 'Runs Kubernetes operators at scale. Bakes sourdough on weekends');
    assert.equal(evidenceIn(r.body.nearby, 'Text Chunk'), 'Built kernel tracing tools with eBPF');
  });

  test('the push nudge', async () => {
    const s = setup();
    // Only the two people under test, since a person receives at most three pushes an hour.
    for (const d of s.others.splice(0, 4)) fake.store(PEOPLE).delete(`${EVENT}:${d.profileId}`);
    for (const d of [s.me, ...s.others]) {
      fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://push.example.test/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
    }
    await nudgedNames(s);
    const bodies = fake.pushes.filter((p) => p.endpoint === `https://push.example.test/${s.me.profileId}`).map((p) => p.payload.body);
    assert.ok(bodies.includes("Someone who's worked on Runs Kubernetes operators at scale. Bakes sourdough on weekends is in Hall A right now"), JSON.stringify(bodies));
    assert.ok(bodies.includes("Someone who's worked on Built kernel tracing tools with eBPF is in Hall A right now"), JSON.stringify(bodies));
    assert.ok(!bodies.some((b) => b.includes('Someone who\'s worked on Bakes sourdough')), 'the unrelated chunk is never quoted');
  });
});

describe('the distance leg counts neither way', () => {
  const legs = ['topics', 'text', 'distance'];
  const names = ['topics-1', 'text-2', 'distance-3'];
  const me = { learn_topics: ['kubernetes', 'ebpf'] };
  const common = new Set(['kubernetes']);
  const hit = (ranks, speak) => ({ _explanation: rrfExplanation(ranks, names), _source: { speak_topics: speak } });

  test('isBroad over a captured-shape explanation with a distance leg', () => {
    assert.equal(isBroad(hit([1, 0, 2], ['kubernetes']), legs, me, common), true, 'a common topic and nearby is broad');
    assert.equal(isBroad(hit([0, 0, 1], []), legs, me, common), true, 'nearby alone is broad');
    assert.equal(isBroad(hit([0, 3, 1], []), legs, me, common), false, 'text and nearby is specific');
    assert.equal(isBroad(hit([2, 0, 1], ['ebpf']), legs, me, common), false, 'a rare topic and nearby is specific');
  });

  test('around now and the nudge with a position: nearby people who share only a common topic are broad and never nudged', async () => {
    const cell = { lat: 39.743, lon: -104.995 };
    const s = scene(REQUESTERS['three legs']);
    for (const d of [s.me, ...s.others]) fake.put(PEOPLE, `${EVENT}:${d.profileId}`, { ...fake.doc(PEOPLE, `${EVENT}:${d.profileId}`), presence_cell: cell });
    const r = await request(handlePeopleApi, 'POST', '/api/people/matches', s.me, { event: EVENT, interested_talk_ids: [], when: 'around_now' });
    assert.deepEqual(retrieversOf(fake.peopleSearches().at(-1)).map((x) => x._name), ['topics-1', 'topics-2', 'text-3', 'distance-4']);
    assert.deepEqual(Object.fromEntries(r.body.results.map((p) => [p.display_name, p.broad])), { 'Text Only': false, 'Rare Topic': false, 'Common Topic': true, 'Common Learner': true });
    assert.deepEqual(await nudgedNames(s), ['Rare Topic', 'Text Only']);
  });
});
