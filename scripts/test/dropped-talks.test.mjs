// scripts/lib/dropped-talks.mjs on its own, against the in-memory Elasticsearch of
// test/helpers/fake-es.mjs (in process, no network): the shrink rule, the people transport, and
// the races the ingest's people cleanup must survive (a concurrent write, an owner who makes the
// profile visible again, a profile deleted meanwhile, one profile's failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeES, INDEX, EVENT, FUTURE, newDevice } from '../../test/helpers/fake-es.mjs';
import { shrinkRefusal, peopleTransport, PeopleError, createDeletedTalkCleanup, MAX_DELETE, MAX_DELETE_SHARE } from '../lib/dropped-talks.mjs';

const GONE = `${EVENT}:gone`;
const KEPT = `${EVENT}:kept`;
const INDICES = { people: INDEX.people, meets: INDEX.meets, push: INDEX.push, nudges: INDEX.nudges, blocks: INDEX.blocks };

const transportFor = (cluster) => peopleTransport(async (method, path, body, { ndjson } = {}) => {
  const res = await cluster.handle(method, new URL(path, 'http://es.test'), body === undefined ? undefined : ndjson ? body : JSON.stringify(body));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
});

function setup(...profiles) {
  const cluster = new FakeES();
  const ids = profiles.map((fields) => {
    const { profileId } = newDevice();
    const id = `${EVENT}:${profileId}`;
    cluster.put(INDEX.people, id, { event_id: EVENT, profile_id: profileId, display_name: 'P', open_to_meet: true, shared_talk_ids: [], visible_until: FUTURE, ...fields });
    return id;
  });
  const lines = [];
  const cleanup = createDeletedTalkCleanup({ people: transportFor(cluster), indices: INDICES, log: (m) => lines.push(m) });
  return { cluster, ids, lines, run: () => cleanup.unshareDeletedTalks(EVENT, [GONE]) };
}

test('the shrink rule is the Worker finalize rule: more than 10 and more than 10%, both', () => {
  assert.equal(MAX_DELETE, 10);
  assert.equal(MAX_DELETE_SHARE, 0.1);
  assert.equal(shrinkRefusal(0, 0), null);
  assert.equal(shrinkRefusal(10, 20), null, '10 is not more than 10, whatever the share');
  assert.ok(shrinkRefusal(11, 20));
  assert.equal(shrinkRefusal(11, 110), null, '11 is not more than 10% of 110');
  assert.ok(shrinkRefusal(11, 109));
  assert.equal(shrinkRefusal(50, 600), null);
  assert.ok(shrinkRefusal(600, 600), 'a feed that came back empty');
  assert.match(shrinkRefusal(11, 109), /would delete 11 of 109 talks, more than 10 and more than 10%/);
});

test('the people transport throws PeopleError without a key or a document id, and honours okStatuses', async () => {
  const people = peopleTransport(async (method, path) => ({ status: path.includes('missing') ? 404 : 403, json: {} }));
  await assert.rejects(people('GET', '/caddie-people/_doc/testconf-2099%3Asecretprofile?x=1'), (err) => err instanceof PeopleError && err.message === 'GET /caddie-people/_doc failed with status 403');
  assert.equal((await people('GET', '/caddie-people/_doc/missing', undefined, { okStatuses: [404] })).status, 404);
  const down = peopleTransport(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down('POST', '/caddie-people/_search'), /POST \/caddie-people\/_search: network error/);
  const garbled = peopleTransport(async () => ({ status: 200, json: null }));
  await assert.rejects(garbled('POST', '/caddie-people/_search'), /invalid response/);
});

test('a write that lands between the search and the unshare is kept: the profile is read again', async () => {
  const s = setup({ open_to_meet: true, shared_talk_ids: [GONE, KEPT] });
  const [id] = s.ids;
  s.cluster.before('update', 1, (c) => c.patch(INDEX.people, id, { presence_zone: 'Hallway', shared_talk_ids: [GONE, KEPT, `${EVENT}:new`] }));
  const r = await s.run();
  assert.deepEqual(r, { unshared: 1, profilesDeleted: 0, failed: 0 });
  const doc = s.cluster.source(INDEX.people, id);
  assert.equal(doc.presence_zone, 'Hallway');
  assert.deepEqual(doc.shared_talk_ids, [KEPT, `${EVENT}:new`]);
  assert.equal(s.cluster.calls('update').length, 2, 'one conflict, one retry');
});

test('a profile its owner makes visible again before the delete is kept', async () => {
  const s = setup({ open_to_meet: false, shared_talk_ids: [GONE] });
  const [id] = s.ids;
  s.cluster.after('update', 1, (c) => c.patch(INDEX.people, id, { open_to_meet: true }));
  const r = await s.run();
  assert.deepEqual(r, { unshared: 1, profilesDeleted: 0, failed: 0 });
  assert.equal(s.cluster.source(INDEX.people, id).open_to_meet, true);
  assert.equal(s.cluster.calls('hide').length, 0, 'the delete never starts');
});

test('a profile its owner makes visible between the read and the hide is kept: the hide is guarded by that read', async () => {
  const s = setup({ open_to_meet: false, shared_talk_ids: [GONE] });
  const [id] = s.ids;
  const profileId = id.slice(EVENT.length + 1);
  s.cluster.put(INDEX.meets, 'meet-own', { event_id: EVENT, meet_id: 'meet-own', participants: [profileId, 'other1'], expires_at: FUTURE });
  s.cluster.put(INDEX.blocks, 'block-own', { event_id: EVENT, blocker_id: profileId, blocked_id: 'other1', expires_at: FUTURE });
  s.cluster.before('hide', 1, (c) => c.patch(INDEX.people, id, { open_to_meet: true }));
  const r = await s.run();
  assert.deepEqual(r, { unshared: 1, profilesDeleted: 0, failed: 0 });
  const doc = s.cluster.source(INDEX.people, id);
  assert.deepEqual([doc.open_to_meet, doc.shared_talk_ids], [true, []], 'the owner\'s write stands');
  assert.deepEqual(s.cluster.ids(INDEX.meets), ['meet-own']);
  assert.deepEqual(s.cluster.ids(INDEX.blocks), ['block-own']);
  const [hide] = s.cluster.calls('hide');
  const action = JSON.parse(hide.body.split('\n')[0]).update;
  assert.equal(typeof action.if_seq_no, 'number');
  assert.equal(action.retry_on_conflict, undefined);
});

test('a profile deleted meanwhile is skipped without a failure', async () => {
  const s = setup({ open_to_meet: false, shared_talk_ids: [GONE] });
  const [id] = s.ids;
  s.cluster.before('update', 1, (c) => c.docs(INDEX.people).delete(id));
  assert.deepEqual(await s.run(), { unshared: 0, profilesDeleted: 0, failed: 0 });
});

test('one profile that fails is counted and logged without its id; the others are cleaned up', async () => {
  const s = setup({ open_to_meet: true, shared_talk_ids: [GONE] }, { open_to_meet: true, shared_talk_ids: [GONE, KEPT] });
  s.cluster.fail({ tag: 'update', nth: 1, how: 'item503' });
  const r = await s.run();
  assert.deepEqual(r, { unshared: 1, profilesDeleted: 0, failed: 1 });
  assert.deepEqual(s.lines, ['A profile that shared for a deleted talk could not be updated: bulk item status 503']);
  assert.equal(s.ids.filter((id) => s.cluster.source(INDEX.people, id).shared_talk_ids.includes(GONE)).length, 1);
});

test('five profiles failing in a row stop the cleanup instead of waiting on every one', async () => {
  const s = setup(...Array.from({ length: 7 }, () => ({ open_to_meet: true, shared_talk_ids: [GONE] })));
  for (let n = 1; n <= 5; n++) s.cluster.fail({ tag: 'update', nth: n, how: 'item503' });
  await assert.rejects(s.run(), (err) => err instanceof PeopleError && err.message === 'stopped after 5 profiles in a row failed');
  assert.equal(s.cluster.calls('update').length, 5);
  assert.equal(s.lines.length, 5);
});

test('a profile that keeps conflicting gives up after three attempts', async () => {
  const s = setup({ open_to_meet: true, shared_talk_ids: [GONE] });
  const [id] = s.ids;
  for (let n = 1; n <= 3; n++) s.cluster.before('update', n, (c) => c.patch(INDEX.people, id, {}));
  const r = await s.run();
  assert.deepEqual(r, { unshared: 0, profilesDeleted: 0, failed: 1 });
  assert.equal(s.cluster.calls('update').length, 3);
  assert.deepEqual(s.cluster.source(INDEX.people, id).shared_talk_ids, [GONE]);
});

test('talk ids of another conference are never looked for', async () => {
  const s = setup({ open_to_meet: false, shared_talk_ids: ['other-2099:gone'] });
  const cleanup = createDeletedTalkCleanup({ people: transportFor(s.cluster), indices: INDICES, log: () => {} });
  assert.deepEqual(await cleanup.unshareDeletedTalks(EVENT, ['other-2099:gone']), { unshared: 0, profilesDeleted: 0, failed: 0 });
  assert.equal(s.cluster.log.length, 0);
});
