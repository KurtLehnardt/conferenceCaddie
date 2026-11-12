// PUT /api/people/profile and talks that left the schedule, as on the Worker (worker/src/people/
// routes.js checkSharedTalks): an id of this conference that is not one of its talks is dropped
// instead of answering 400, and the answer echoes the list that was stored; every other check on
// shared_talk_ids and on the profile stays. Run against the in-memory Elasticsearch of
// test/helpers/fake-es.mjs; nothing reaches the network.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { FakeES, useCluster, bootPurgeDone, INDEX, EVENT, newDevice, personId, addPerson, addConnections, request } from './helpers/fake-es.mjs';

const { handlePeopleApi } = await import('../server/people.mjs');

before(() => bootPurgeDone());

const T1 = `${EVENT}:talk1`;
const T2 = `${EVENT}:talk2`;
const AMBIENT = `${EVENT}:ambient1`;
const GONE = `${EVENT}:9999999`;

function cluster() {
  const c = useCluster(new FakeES());
  for (const [id, kind] of [[T1, 'talk'], [T2, 'talk'], [AMBIENT, 'ambient']]) {
    c.put(INDEX.talks, id, { talk_id: id, conference: EVENT, kind, title: `Title of ${id}` });
  }
  return c;
}

const put = (device, { open = true, shared, profile = { display_name: 'Test person', about: 'About me' } } = {}) =>
  request(handlePeopleApi, 'PUT', '/api/people/profile', device, { event: EVENT, profile, open_to_meet: open, shared_talk_ids: shared });

test('an unknown talk of this conference is dropped and the answer echoes what was stored', async () => {
  const c = cluster();
  const d = newDevice();
  const r = await put(d, { shared: [T1, GONE, T2] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.shared_talk_ids, [T1, T2]);
  assert.deepEqual(c.source(INDEX.people, personId(d.profileId)).shared_talk_ids, [T1, T2]);

  // The app sends its stored list with every write; a later write that still names the gone talk saves.
  const again = await put(d, { shared: [GONE, T2], profile: { display_name: 'Test person', about: 'Changed' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.shared_talk_ids, [T2]);
  assert.deepEqual(c.source(INDEX.people, personId(d.profileId)).shared_talk_ids, [T2]);
});

test('an id of this conference that is not kind talk is dropped too', async () => {
  const c = cluster();
  const d = newDevice();
  const r = await put(d, { shared: [AMBIENT, T1] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.shared_talk_ids, [T1]);
  assert.deepEqual(c.source(INDEX.people, personId(d.profileId)).shared_talk_ids, [T1]);
});

test('open to meet with only unknown talks keeps the profile, sharing for nothing', async () => {
  const c = cluster();
  const d = newDevice();
  const r = await put(d, { open: true, shared: [GONE] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.open_to_meet, r.body.shared_talk_ids], [true, []]);
  const doc = c.source(INDEX.people, personId(d.profileId));
  assert.deepEqual([doc.open_to_meet, doc.shared_talk_ids], [true, []]);
});

test('not open to meet with only unknown talks is both choices off: the profile and its connections are deleted', async () => {
  const c = cluster();
  const d = newDevice();
  addPerson(c, d, { shared_talk_ids: [GONE] });
  const ids = addConnections(c, d.profileId);
  const r = await put(d, { open: false, shared: [GONE] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, open_to_meet: false, shared_talk_ids: [] });
  assert.equal(c.source(INDEX.people, personId(d.profileId)), null);
  assert.deepEqual(c.ids(INDEX.meets), [ids.unrelatedMeet]);
  assert.deepEqual(c.ids(INDEX.blocks).sort(), [ids.blockedBy, ids.unrelatedBlock].sort());

  // Without a profile it creates nothing.
  const fresh = newDevice();
  const none = await put(fresh, { open: false, shared: [GONE] });
  assert.deepEqual([none.status, none.body], [200, { ok: true, open_to_meet: false, shared_talk_ids: [] }]);
  assert.equal(c.source(INDEX.people, personId(fresh.profileId)), null);
});

test('every other check stays: another conference, malformed ids, too many, unknown topics, a wrong secret', async () => {
  const c = cluster();
  const d = newDevice();
  const cases = [
    [{ shared: [T1, 'other-conference-2099:talk1'] }, 'shared_talk_ids must be talks of this conference'],
    [{ open: false, shared: ['other-conference-2099:talk1'] }, 'shared_talk_ids must be talks of this conference'],
    [{ shared: [T1, 'not a talk id'] }, 'shared_talk_ids must be an array of at most 50 ids'],
    [{ shared: Array.from({ length: 51 }, (_, i) => `${EVENT}:${i}`) }, 'shared_talk_ids must be an array of at most 50 ids'],
    [{ shared: T1 }, 'shared_talk_ids must be an array of at most 50 ids'],
    [{ shared: [T1], profile: { display_name: 'Test person', learn_topics: ['no-such-topic'] } }, 'learn_topics contains an unknown topic'],
  ];
  for (const [input, error] of cases) {
    const r = await put(d, input);
    assert.deepEqual([r.status, r.body], [400, { error }], JSON.stringify(input));
  }
  assert.equal(c.source(INDEX.people, personId(d.profileId)), null, 'nothing was written');

  const owner = newDevice();
  addPerson(c, owner, { shared_talk_ids: [T1] });
  const thief = { profileId: owner.profileId, secret: newDevice().secret };
  const r = await put(thief, { shared: [GONE] });
  assert.deepEqual([r.status, r.body], [403, { error: 'forbidden' }]);
  assert.deepEqual(c.source(INDEX.people, personId(owner.profileId)).shared_talk_ids, [T1]);
});
