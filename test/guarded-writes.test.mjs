// Writes to the requester's own people document (the presence write, PUT /api/presence, and the
// Bluetooth token rotation, POST /api/presence/ble/rotate) are guarded by the sequence number of
// the profile read, so one that read the profile before a delete hid it cannot bring presence or
// a token back on the hidden document. Meets treat a person who is not visible conference-wide as
// not around, whatever presence their document still carries.
//
// Run with `npm test`. The server modules talk to the in-memory stand-in of
// test/helpers/fake-es.mjs through a stubbed fetch; nothing reaches the network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, newDevice, personId, addPerson, request,
  quietly, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';

const { handleConnectApi } = await import('../server/connect.mjs');
const { handleBleApi } = await import('../server/ble.mjs');

before(() => bootPurgeDone());

const presence = (device) => request(handleConnectApi, 'PUT', '/api/presence', device, { event: EVENT, zone: 'Hallway', spot: '' });
const rotate = (device) => request(handleBleApi, 'POST', '/api/presence/ble/rotate', device, { event: EVENT });

// The person is around in the Expo hall, so a presence write (to the Hallway) changes presence_zone.
function setup() {
  const device = newDevice();
  const cluster = useCluster(new FakeES());
  addPerson(cluster, device, { presence_zone: 'Expo hall' });
  return { device, cluster, id: personId(device.profileId) };
}

const updateAction = (call) => JSON.parse(call.body.split('\n')[0]).update;

const ROUTES = {
  'PUT /api/presence': { send: presence, field: 'presence_zone' },
  'POST /api/presence/ble/rotate': { send: rotate, field: 'ble_token' },
};

for (const [route, { send, field }] of Object.entries(ROUTES)) {
  describe(route, () => {
    test('writes with if_seq_no and if_primary_term of the profile read', async () => {
      const { device, cluster, id } = setup();
      const seq = cluster.docs(INDEX.people).get(id).seq;
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      const action = updateAction(cluster.calls('update')[0]);
      assert.equal(action.if_seq_no, seq);
      assert.equal(action.if_primary_term, 1);
    });

    test('a write that read the profile before a delete hid it answers profile_required and leaves the document hidden', async () => {
      const { device, cluster, id } = setup();
      cluster.after('get', 1, (c) => c.patch(INDEX.people, id, HIDDEN_FOR_DELETE));
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'profile_required' });
      const p = cluster.source(INDEX.people, id);
      for (const [key, value] of Object.entries(HIDDEN_FOR_DELETE)) assert.deepEqual(p[key], value, `${key} stays as the hide left it`);
      assert.deepEqual(cluster.tags(), ['get', 'update', 'get']);
    });

    test('a write that meets another change to the profile reads it again and succeeds', async () => {
      const { device, cluster, id } = setup();
      const old = cluster.source(INDEX.people, id)[field];
      cluster.after('get', 1, (c) => c.patch(INDEX.people, id, { spot_hidden: false }));
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 200);
      assert.deepEqual(cluster.tags(), ['get', 'update', 'get', 'update']);
      assert.notEqual(cluster.source(INDEX.people, id)[field], old, `${field} was written`);
    });

    test('a write whose document is gone by the second attempt answers profile_required', async () => {
      const { device, cluster, id } = setup();
      cluster.after('get', 1, (c) => c.patch(INDEX.people, id, { spot_hidden: false }));
      cluster.after('get', 2, (c) => c.docs(INDEX.people).delete(id));
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'profile_required' });
      assert.deepEqual(cluster.tags(), ['get', 'update', 'get', 'update']);
    });

    test('a write that conflicts twice answers 409', async () => {
      const { device, cluster, id } = setup();
      cluster.after('get', 1, (c) => c.patch(INDEX.people, id, { spot_hidden: false }));
      cluster.after('get', 2, (c) => c.patch(INDEX.people, id, { spot_hidden: false }));
      const { result } = await quietly(() => send(device));
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: 'The profile changed at the same time; try again' });
    });
  });
}

describe('DELETE /api/presence', () => {
  const clear = (device) => request(handleConnectApi, 'DELETE', `/api/presence?event=${EVENT}`, device);

  test('clears presence with a partial update that Elasticsearch retries on a conflict', async () => {
    const { device, cluster, id } = setup();
    cluster.conflict('update', 1);
    const { result } = await quietly(() => clear(device));
    assert.equal(result.status, 200);
    const action = updateAction(cluster.calls('update')[0]);
    assert.equal(action.retry_on_conflict, 3);
    assert.equal(action.if_seq_no, undefined, 'unguarded: it only clears');
    const p = cluster.source(INDEX.people, id);
    for (const [key, value] of Object.entries(HIDDEN_FOR_DELETE)) {
      if (key.startsWith('presence_') || key.startsWith('ble_')) assert.deepEqual(p[key], value, `${key} is cleared`);
    }
  });
});

describe('meets and a person who is not visible conference-wide', () => {
  // The requester M is visible and around in the Hallway. O shares a talk but is not visible
  // conference-wide, yet their document still carries presence in the Hallway, as an unguarded
  // presence write landing after a hide could have left it.
  function meetSetup(state) {
    const cluster = useCluster(new FakeES());
    const [m, o] = [newDevice(), newDevice()];
    addPerson(cluster, m, { display_name: 'M' });
    addPerson(cluster, o, { display_name: 'O', open_to_meet: false });
    const now = Date.now();
    cluster.put(INDEX.meets, 'meet-mo', {
      event_id: EVENT, meet_id: 'meet-mo', participants: [o.profileId, m.profileId], requester_id: o.profileId,
      state, same_zone: true, rendezvous: state === 'active' ? 'Hallway' : null, note: '', note_pending: false,
      spot_me: {}, spot_me_pending: {}, created_at: new Date(now).toISOString(),
      active_since: state === 'active' ? new Date(now).toISOString() : null, expires_at: new Date(now + 600_000).toISOString(), ended_at: null,
    });
    return { cluster, m, o };
  }

  test('an active meet with such a person is over, and the inbox shows nothing of it', async () => {
    const { cluster, m } = meetSetup('active');
    const { result } = await quietly(() => request(handleConnectApi, 'GET', `/api/meet/inbox?event=${EVENT}`, m));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { incoming: [], outgoing: [] });
    assert.equal(cluster.source(INDEX.meets, 'meet-mo').state, 'expired');
  });

  test('a waiting ask from such a person shows them as not around and without a zone', async () => {
    const { m } = meetSetup('requested');
    const { result } = await quietly(() => request(handleConnectApi, 'GET', `/api/meet/inbox?event=${EVENT}`, m));
    assert.equal(result.status, 200);
    assert.equal(result.body.incoming.length, 1);
    const [card] = result.body.incoming;
    assert.equal(card.other.around, false);
    assert.equal(card.other.zone, null);
  });
});
