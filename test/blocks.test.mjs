// Blocks belong to their blocker. A block lasts until the blocker lifts it, deletes their own
// profile, or the conference ends; the blocked person deleting their profile leaves it in place,
// and the blocker's list still shows it, without a name, so it can be lifted.
//
// Run with `npm test`. The server modules talk to the in-memory stand-in of
// test/helpers/fake-es.mjs through a stubbed fetch; nothing reaches the network.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, personId, refOf, addPerson,
  request, quietly, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';

const { handlePeopleApi } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');

before(() => bootPurgeDone());

const block = (device, ref) => request(handleConnectApi, 'POST', '/api/people/block', device, { event: EVENT, ref });
const unblock = (device, ref) => request(handleConnectApi, 'DELETE', '/api/people/block', device, { event: EVENT, ref });
const list = (device) => request(handleConnectApi, 'GET', `/api/people/blocks?event=${EVENT}`, device);
const deleteProfile = (device) => request(handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device);

function setup() {
  const cluster = useCluster(new FakeES());
  const [blocker, blocked] = [newDevice(), newDevice()];
  addPerson(cluster, blocker, { display_name: 'Blocker' });
  addPerson(cluster, blocked, { display_name: 'Blocked' });
  return { cluster, blocker, blocked, blockId: `${EVENT}:${blocker.profileId}:${blocked.profileId}` };
}

test('a block carries expires_at, the end of its conference, for the purge', async () => {
  const { cluster, blocker, blocked, blockId } = setup();
  const { result } = await quietly(() => block(blocker, refOf(blocked.profileId)));
  assert.equal(result.status, 200);
  assert.equal(cluster.source(INDEX.blocks, blockId).expires_at, FUTURE);
});

test("the blocked person's delete keeps the block, which the blocker's list shows without a name and can lift", async () => {
  const { cluster, blocker, blocked, blockId } = setup();
  const ref = refOf(blocked.profileId);
  await quietly(() => block(blocker, ref));
  const before = await quietly(() => list(blocker));
  assert.deepEqual(before.result.body.blocks.map((b) => [b.ref, b.display_name]), [[ref, 'Blocked']]);

  const del = await quietly(() => deleteProfile(blocked));
  assert.equal(del.result.status, 200);
  assert.equal(cluster.source(INDEX.people, personId(blocked.profileId)), null);
  assert.ok(cluster.source(INDEX.blocks, blockId), 'the block is kept');
  const after = await quietly(() => list(blocker));
  assert.deepEqual(after.result.body.refs, [ref]);
  assert.deepEqual(after.result.body.blocks.map((b) => [b.ref, b.display_name]), [[ref, null]]);

  const lifted = await quietly(() => unblock(blocker, ref));
  assert.equal(lifted.result.status, 200);
  assert.equal(cluster.source(INDEX.blocks, blockId), null);
});

test('while the blocked profile is being deleted, the list shows the block without a name', async () => {
  const { cluster, blocker, blocked } = setup();
  const ref = refOf(blocked.profileId);
  await quietly(() => block(blocker, ref));
  cluster.patch(INDEX.people, personId(blocked.profileId), HIDDEN_FOR_DELETE);
  const { result } = await quietly(() => list(blocker));
  assert.deepEqual(result.body.blocks.map((b) => [b.ref, b.display_name]), [[ref, null]]);
});

test("the blocker's own delete takes the block with it", async () => {
  const { cluster, blocker, blocked, blockId } = setup();
  await quietly(() => block(blocker, refOf(blocked.profileId)));
  const del = await quietly(() => deleteProfile(blocker));
  assert.equal(del.result.status, 200);
  assert.equal(cluster.source(INDEX.blocks, blockId), null);
});
