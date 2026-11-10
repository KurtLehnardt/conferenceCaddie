// The profile delete in server/people.mjs, run against an in-memory stand-in for Elasticsearch
// (test/helpers/fake-es.mjs).
//
// Run with `npm test`. Nothing here reaches the network: fetch is replaced before server/people.mjs
// is imported, every Elasticsearch call is answered from memory, and a call to any other host
// fails the test. The keys and the URL are dummy values.
//
// Both routes that delete a profile are covered: DELETE /api/people/profile, and PUT with both
// visibility choices off. For each the tests check that
// - the profile is hidden first, by a plain partial update with refresh=wait_for and
//   retry_on_conflict, then meets, push subscriptions and nudge records are deleted concurrently,
//   then the blocks the person made, and the document last, followed by a second pass;
// - blocks other people made of the person are kept, so a profile re-created from the same device
//   is still blocked;
// - when any step after the hide fails, the request answers 502, no block and no document has
//   been deleted (or, for a Bulk that fails part-way, only some of the person's own blocks), and
//   the profile stays hidden with its secret hash, so a retry can authenticate;
// - trying again after such a failure finishes the delete;
// - a hide that meets concurrent writes is retried by Elasticsearch, and one that keeps
//   conflicting answers 502 with nothing deleted;
// - a failure in the second pass, once the document is gone, still answers 200 and is logged.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, hashOf, personId,
  addPerson, addConnections, request, quietly, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';

const people = await import('../server/people.mjs');
const { handlePeopleApi } = people;

before(() => bootPurgeDone());

const ROUTES = {
  'DELETE /api/people/profile': (device) => request(handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device),
  'PUT /api/people/profile with both choices off': (device) => request(handlePeopleApi, 'PUT', '/api/people/profile', device, {
    event: EVENT,
    profile: { display_name: 'Test person' },
    open_to_meet: false,
    shared_talk_ids: [],
  }),
};

// One cluster with one live, visible, present profile and its connections.
function setup(failures = []) {
  const device = newDevice();
  const cluster = useCluster(new FakeES());
  addPerson(cluster, device);
  const ids = addConnections(cluster, device.profileId);
  cluster.fail(...failures);
  return { device, cluster, ids, id: personId(device.profileId) };
}

const THREE = ['meets', 'push', 'nudges'];
// Steps before the blocks: a failure in any of them must leave every block in place.
const BEFORE_BLOCKS = ['search:meets', 'bulk:meets', 'search:push', 'bulk:push', 'search:nudges', 'bulk:nudges'];

// The order: get, hide, the three indices (each searched, then bulk-deleted) in any interleaving,
// then the blocks, then the document, then the second pass.
function assertOrder(tags) {
  assert.deepEqual(tags.slice(0, 2), ['get', 'hide']);
  const docAt = tags.indexOf('delete-doc');
  assert.ok(docAt > 0, 'the document is deleted');
  const first = tags.slice(2, docAt);
  assert.equal(first.length, 8, `first pass: ${first.join(', ')}`);
  for (const name of THREE) {
    assert.ok(first.indexOf(`search:${name}`) < first.indexOf(`bulk:${name}`), `${name} is searched before its bulk delete`);
  }
  assert.deepEqual(first.slice(6), ['search:blocks', 'bulk:blocks'], 'the blocks go after meets, push and nudges');
  const second = tags.slice(docAt + 1);
  assert.deepEqual(new Set(second.slice(0, 3)), new Set(THREE.map((n) => `search:${n}`)));
  assert.deepEqual(second.slice(3), ['search:blocks']);
}

function assertHidden(cluster, id, device) {
  const p = cluster.source(INDEX.people, id);
  assert.ok(p, 'the profile document is still stored');
  for (const [field, value] of Object.entries(HIDDEN_FOR_DELETE)) assert.deepEqual(p[field], value, `${field} is hidden`);
  assert.equal(p.secret_hash, hashOf(device.secret), 'the secret hash survives for a retry');
  assert.equal(p.visible_until, FUTURE, 'visible_until is left alone');
}

// Everything that goes with the profile is gone; blocks others made of the person and documents
// between other people stay.
function assertAllGone(cluster, id, ids) {
  assert.equal(cluster.source(INDEX.people, id), null, 'the profile document is deleted');
  for (const meet of ids.meets) assert.equal(cluster.source(INDEX.meets, meet), null, `${meet} is deleted`);
  assert.equal(cluster.ids(INDEX.push).length, 0, 'the push subscription is deleted');
  assert.equal(cluster.ids(INDEX.nudges).length, 0, 'the nudge record is deleted');
  for (const block of ids.ownBlocks) assert.equal(cluster.source(INDEX.blocks, block), null, 'a block the person made is deleted');
  assert.ok(cluster.source(INDEX.blocks, ids.blockedBy), 'a block someone else made of the person is kept');
  assert.ok(cluster.source(INDEX.meets, ids.unrelatedMeet), 'a meet between two other people is kept');
  assert.ok(cluster.source(INDEX.blocks, ids.unrelatedBlock), 'a block between two other people is kept');
}

for (const [route, send] of Object.entries(ROUTES)) {
  describe(route, () => {
    test('hides the profile first with a plain partial update that waits for the refresh', async () => {
      const { device, cluster } = setup();
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      if (route.startsWith('PUT')) assert.deepEqual(result.body, { ok: true, open_to_meet: false, shared_talk_ids: [] });
      else assert.deepEqual(result.body, { ok: true });
      const [hide] = cluster.calls('hide');
      assert.equal(hide.params.get('refresh'), 'wait_for');
      const [action, payload] = hide.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(action.update, 'an update action');
      assert.equal(action.update.upsert, undefined);
      assert.equal('upsert' in payload, false, 'no upsert document');
      assert.equal('doc_as_upsert' in payload, false, 'no doc_as_upsert');
      assert.deepEqual(payload.doc, HIDDEN_FOR_DELETE);
    });

    test('deletes meets, push and nudges concurrently, then the blocks the person made, then the document', async () => {
      const { device, cluster, ids, id } = setup();
      cluster.barrier(THREE.map((n) => `search:${n}`));
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.equal(cluster.barrierTimedOut, false, 'the three searches were all under way at once');
      assertOrder(cluster.tags());
      assertAllGone(cluster, id, ids);
    });

    test('keeps the blocks other people made of the person', async () => {
      const { device, cluster, ids } = setup();
      await quietly(() => send(device));
      for (const block of ids.ownBlocks) assert.equal(cluster.source(INDEX.blocks, block), null);
      assert.deepEqual(cluster.source(INDEX.blocks, ids.blockedBy)?.blocked_id, device.profileId);
      const blockSearch = cluster.calls('search:blocks')[0].body.query;
      assert.deepEqual(blockSearch, people.ownBlocksQuery(EVENT, device.profileId));
    });

    test('a profile re-created from the same device is still blocked by whoever blocked it', async () => {
      const { device, cluster, ids } = setup();
      await quietly(() => send(device));
      const again = await quietly(() => request(handlePeopleApi, 'PUT', '/api/people/profile', device, {
        event: EVENT,
        profile: { display_name: 'Back again' },
        open_to_meet: true,
        shared_talk_ids: [],
      }));
      assert.equal(again.result.status, 200);
      assert.equal(cluster.source(INDEX.people, personId(device.profileId))?.display_name, 'Back again');
      assert.ok(cluster.source(INDEX.blocks, ids.blockedBy), 'the block is still stored');
      assert.ok((await people.blockedIds(EVENT, 'other2')).has(device.profileId), 'the blocker still has the person blocked');
      assert.ok((await people.blockedIds(EVENT, device.profileId)).has('other2'), 'the person is still kept away from the blocker');
    });

    for (const tag of BEFORE_BLOCKS) {
      const modes = tag.startsWith('bulk:') ? [503, 'network', 'item429'] : [503, 'network', 'timeout'];
      for (const how of modes) {
        test(`a failure at ${tag} (${how}) keeps every block and the hidden document, and a retry finishes`, async () => {
          const { device, cluster, ids, id } = setup([{ tag, how }]);
          const first = await quietly(() => send(device));
          assert.equal(first.result.status, 502);
          assert.ok(!cluster.tags().includes('bulk:blocks'), 'no block was deleted');
          assert.ok(!cluster.tags().includes('delete-doc'), 'the document was not deleted');
          assert.equal(cluster.ids(INDEX.blocks).length, 4, 'every block is still stored');
          assertHidden(cluster, id, device);

          cluster.log.length = 0;
          const retry = await quietly(() => send(device));
          assert.equal(retry.result.status, 200);
          assert.deepEqual(cluster.tags().slice(0, 2), ['get', 'hide']);
          assertAllGone(cluster, id, ids);
        });
      }
    }

    for (const [tag, how] of [['search:blocks', 503], ['bulk:blocks', 'item429'], ['bulk:blocks', 'partial429'], ['delete-doc', 503], ['delete-doc', 'timeout']]) {
      test(`a failure at ${tag} (${how}) keeps the hidden document, and a retry finishes`, async () => {
        const { device, cluster, ids, id } = setup([{ tag, how }]);
        const first = await quietly(() => send(device));
        assert.equal(first.result.status, 502);
        assertHidden(cluster, id, device);
        if (how === 'partial429') {
          const left = ids.ownBlocks.filter((b) => cluster.source(INDEX.blocks, b));
          assert.deepEqual(left, [ids.ownBlocks[1]], 'only the block whose Bulk item failed is left');
        }
        assert.ok(cluster.source(INDEX.blocks, ids.blockedBy), 'the block someone else made is kept');
        cluster.log.length = 0;
        const retry = await quietly(() => send(device));
        assert.equal(retry.result.status, 200);
        assertAllGone(cluster, id, ids);
      });
    }

    for (const times of [1, 3]) {
      test(`a hide that meets ${times} concurrent write${times > 1 ? 's' : ''} is retried by Elasticsearch and the delete finishes`, async () => {
        const { device, cluster, ids, id } = setup();
        cluster.conflict('hide', times);
        const { result } = await quietly(() => send(device));
        assert.equal(result.status, 200);
        assertAllGone(cluster, id, ids);
      });
    }

    test('a hide that keeps conflicting (item 409) answers 502 and deletes nothing', async () => {
      const { device, cluster, id } = setup();
      cluster.conflict('hide', 4);
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 502);
      assert.deepEqual(cluster.tags(), ['get', 'hide']);
      assert.equal(cluster.source(INDEX.people, id).open_to_meet, true, 'the profile is unchanged');
      assert.equal(cluster.ids(INDEX.blocks).length + cluster.ids(INDEX.meets).length + cluster.ids(INDEX.push).length + cluster.ids(INDEX.nudges).length, 9, 'nothing was deleted');
    });

    for (const how of [503, 'item500']) {
      test(`a failed hide (${how}) answers 502 and deletes nothing`, async () => {
        const { device, cluster, id } = setup([{ tag: 'hide', how }]);
        const { result } = await quietly(() => send(device));
        assert.equal(result.status, 502);
        assert.deepEqual(cluster.tags(), ['get', 'hide']);
        assert.equal(cluster.source(INDEX.people, id).open_to_meet, true, 'the profile is unchanged');
        assert.equal(cluster.ids(INDEX.blocks).length + cluster.ids(INDEX.meets).length + cluster.ids(INDEX.push).length + cluster.ids(INDEX.nudges).length, 9, 'nothing was deleted');
      });
    }

    test('a document gone before the hide (404) answers 200 and deletes nothing', async () => {
      const { device, cluster } = setup([{ tag: 'hide', how: 'item404' }]);
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.deepEqual(cluster.tags(), ['get', 'hide']);
    });

    test('a wrong device secret answers 403 before anything is hidden', async () => {
      const { device, cluster, id } = setup();
      const { result } = await quietly(() => send({ ...device, secret: newDevice().secret }));
      assert.equal(result.status, 403);
      assert.deepEqual(cluster.tags(), ['get']);
      assert.equal(cluster.source(INDEX.people, id).open_to_meet, true);
    });

    test('a failure in the second pass, after the document is gone, answers 200 and is logged', async () => {
      const { device, cluster, id } = setup([{ tag: 'search:meets', nth: 2, how: 503 }]);
      const { result, lines } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.equal(cluster.source(INDEX.people, id), null);
      assert.deepEqual(lines, ["Deleting a deleted profile's connections again failed: status 503"]);
    });
  });
}
