// The optional native push registration routes of server/push.mjs (PUT and DELETE
// /api/push/native), run against the in-memory stand-in for Elasticsearch in
// test/helpers/fake-es.mjs: what a registration stores (one per device, platform and conference),
// the closed bodies and token formats, the device and profile checks (a pending delete included),
// the people-write bucket, the delete's token check, and that a profile delete, visibility off,
// the hourly purge and the finishing of a pending delete remove native registrations exactly as
// they remove Web Push subscriptions. Also what nudge.mjs reads back (pushTargetsFor, one search
// for every receiver), and the capabilities this configuration advertises.
//
// Run with `npm test`. Nothing reaches the network: fetch is replaced before the server modules
// are imported, APNs is configured with a key file generated for this run and FCM with a project id, and
// PUSH_TRANSPORT=stub without PUSH_STUB_URL makes any push fail locally.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, personId, addPerson,
  addConnections, request, quietly, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';
import { writeKeyFile } from './helpers/apns-key.mjs';

for (const k of ['APNS_BUNDLE_ID', 'PUSH_STUB_URL']) delete process.env[k];
Object.assign(process.env, {
  PUSH_TRANSPORT: 'stub',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_FILE: writeKeyFile(),
  FCM_PROJECT_ID: 'caddie-test-project',
});

const people = await import('../server/people.mjs');
const { handlePushApi, registrationId, subscriptionId, pushTargetsFor, deleteRegistrationIfUnchanged, TARGETS_PER_PROFILE, TARGETS_READ_PER_PROFILE } = await import('../server/push.mjs');
const { currentCapabilities } = await import('../server/capabilities.mjs');
const CAPABILITIES = currentCapabilities();
const { validator } = await import('../contracts/js/schemas.mjs');

before(() => bootPurgeDone());

const PAST = new Date(Date.now() - 3600_000).toISOString();
const apnsToken = () => crypto.randomBytes(32).toString('hex');
const fcmToken = () => `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
const put = (device, body) => request(handlePushApi, 'PUT', '/api/push/native', device, body);
const del = (device, body) => request(handlePushApi, 'DELETE', '/api/push/native', device, body);
const putRequest = validator('people-api.v1', 'PushNativePutRequest');
const deleteRequest = validator('people-api.v1', 'PushNativeDeleteRequest');

function setup() {
  const cluster = useCluster(new FakeES());
  const device = newDevice();
  addPerson(cluster, device);
  return { cluster, device };
}

describe('PUT /api/push/native', () => {
  test('a device keeps one registration per platform at each conference it is used at', async () => {
    const { cluster, device } = setup();
    const OTHER = 'otherconf-2099';
    cluster.put(INDEX.conferences, OTHER, { slug: OTHER, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' });
    addPerson(cluster, device);
    cluster.put(INDEX.people, `${OTHER}:${device.profileId}`, { ...cluster.source(INDEX.people, personId(device.profileId)), event_id: OTHER });
    const token = apnsToken();
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token })).status, 200);
    assert.equal((await put(device, { event: OTHER, platform: 'apns', token })).status, 200);
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')).event_id, EVENT);
    assert.equal(cluster.source(INDEX.push, registrationId(OTHER, device.profileId, 'apns')).event_id, OTHER);
    // Removing it at one conference leaves the other.
    assert.equal((await del(device, { event: OTHER, platform: 'apns', token })).status, 200);
    assert.equal(cluster.source(INDEX.push, registrationId(OTHER, device.profileId, 'apns')), null);
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')));
  });

  test('stores an APNs token (lowercase, production unless sandbox) and an FCM token under sha256(event:profile_id:platform)', async () => {
    const { cluster, device } = setup();
    const apns = apnsToken();
    const fcm = fcmToken();
    assert.deepEqual(await put(device, { event: EVENT, platform: 'apns', token: apns.toUpperCase() }), { status: 200, body: { ok: true } });
    assert.deepEqual(await put(device, { event: EVENT, platform: 'fcm', token: fcm }), { status: 200, body: { ok: true } });
    const a = cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns'));
    const { created_at: createdA, ...restA } = a;
    assert.deepEqual(restA, { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: apns, environment: 'production', expires_at: FUTURE });
    assert.ok(Date.parse(createdA) <= Date.now());
    const f = cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm'));
    const { created_at: createdF, ...restF } = f;
    assert.deepEqual(restF, { event_id: EVENT, profile_id: device.profileId, platform: 'fcm', token: fcm, expires_at: FUTURE });
    assert.equal(registrationId(EVENT, device.profileId, 'apns'), crypto.createHash('sha256').update(`${EVENT}:${device.profileId}:apns`).digest('hex'));
    const write = cluster.log.find((e) => e.method === 'PUT' && e.path.startsWith(`/${INDEX.push}/_doc/`));
    assert.equal(write.params.get('refresh'), 'wait_for');

    // The same token again overwrites its document: here it moves to the sandbox.
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token: apns, environment: 'sandbox' })).status, 200);
    assert.equal(cluster.ids(INDEX.push).length, 2);
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')).environment, 'sandbox');
  });

  test('a rotated token replaces the old one, so a device never keeps a token the platform retired', async () => {
    const { cluster, device } = setup();
    const [oldApns, newApns, oldFcm, newFcm] = [apnsToken(), apnsToken(), fcmToken(), fcmToken()];
    for (const [platform, token] of [['apns', oldApns], ['fcm', oldFcm], ['apns', newApns], ['fcm', newFcm]]) {
      assert.equal((await put(device, { event: EVENT, platform, token })).status, 200);
    }
    assert.equal(cluster.ids(INDEX.push).length, 2, 'one registration per platform');
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')).token, newApns);
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm')).token, newFcm);
  });

  test('bodies are closed and tokens must have their platform\'s format', async () => {
    const { cluster, device } = setup();
    const apns = apnsToken();
    const fcm = fcmToken();
    const refused = [
      [{ event: EVENT, platform: 'apns', token: apns, extra: 1 }, 'Unknown key: extra'],
      [{ event: EVENT, platform: 'apns' }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'webpush', token: apns }, 'platform must be apns or fcm'],
      [{ event: EVENT, token: apns }, 'platform must be apns or fcm'],
      [{ event: EVENT, platform: 'apns', token: apns.slice(1) }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'apns', token: 'ab'.repeat(31) }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'apns', token: 'ab'.repeat(101) }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'apns', token: `${apns.slice(2)}zz` }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'apns', token: 123 }, 'token must be an APNs device token in hex'],
      [{ event: EVENT, platform: 'fcm', token: apns.slice(0, 31) }, 'token must be an FCM registration token'],
      [{ event: EVENT, platform: 'fcm', token: `${fcm}/../x` }, 'token must be an FCM registration token'],
      [{ event: EVENT, platform: 'fcm', token: fcm, environment: 'production' }, 'environment is only for apns'],
      [{ event: EVENT, platform: 'apns', token: apns, environment: 'development' }, 'environment must be production or sandbox'],
      [{ event: EVENT, platform: 'apns', token: apns, environment: null }, 'environment must be production or sandbox'],
      [{ event: 'no-such-conference', platform: 'apns', token: apns }, 'conference is not available'],
    ];
    for (const [body, error] of refused) {
      assert.deepEqual(await put(device, body), { status: 400, body: { error } }, JSON.stringify(body).slice(0, 80));
      if (body.event === EVENT) assert.equal(putRequest(body, { closed: true }).valid, false, `the schema refuses it too: ${error}`);
    }
    assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: 'a'.repeat(9000) })).status, 413, 'bodies over 8 KB');
    assert.equal(putRequest({ event: EVENT, platform: 'apns', token: apns.toUpperCase(), environment: 'sandbox' }, { closed: true }).valid, true);
    assert.equal(cluster.ids(INDEX.push).length, 0, 'nothing was stored');
  });

  test('needs the device header and a live profile, and refuses while a profile delete is pending', async () => {
    const { cluster, device } = setup();
    const body = { event: EVENT, platform: 'apns', token: apnsToken() };
    assert.deepEqual(await put(null, body), { status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(await put({ ...device, secret: newDevice().secret }, body), { status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(await put(newDevice(), body), { status: 403, body: { error: 'profile_required' } });
    cluster.patch(INDEX.people, personId(device.profileId), HIDDEN_FOR_DELETE);
    assert.deepEqual(await put(device, body), { status: 403, body: { error: 'profile_required' } });
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token: body.token }), { status: 403, body: { error: 'profile_required' } });
    assert.equal(cluster.ids(INDEX.push).length, 0);
  });

  test('shares the people-write bucket: the 21st write of a device in a minute is 429', async () => {
    const { device } = setup();
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await put(device, { event: EVENT, platform: 'apns', token: apnsToken() })).status);
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
    assert.equal(statuses[20], 429);
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token: apnsToken() }), { status: 429, body: { error: 'Too many requests' } });
  });
});

describe('DELETE /api/push/native', () => {
  test("removes only the requester's own registration and answers ok either way", async () => {
    const { cluster, device } = setup();
    const stranger = newDevice();
    addPerson(cluster, stranger);
    const token = apnsToken();
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token })).status, 200);
    assert.deepEqual(await del(stranger, { event: EVENT, platform: 'apns', token }), { status: 200, body: { ok: true } });
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')), "another profile's request changes nothing, even with the right token");
    assert.deepEqual(await del(device, { event: EVENT, platform: 'fcm', token: fcmToken() }), { status: 200, body: { ok: true } }, 'nothing to remove');
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token: token.toUpperCase() }), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'apns')), null);
  });

  test('a stale token removes nothing: the registration a fresh token replaced it with stays', async () => {
    const { cluster, device } = setup();
    const [stale, fresh] = [fcmToken(), fcmToken()];
    assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: stale })).status, 200);
    assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: fresh })).status, 200);
    assert.deepEqual(await del(device, { event: EVENT, platform: 'fcm', token: stale }), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm')).token, fresh, 'kept');
    assert.ok(!cluster.log.some((e) => e.method === 'DELETE' && e.path.startsWith(`/${INDEX.push}/`)), 'not even attempted');
    assert.deepEqual(await del(device, { event: EVENT, platform: 'fcm', token: fresh }), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm')), null);
    const deleted = cluster.log.find((e) => e.method === 'DELETE' && e.path.startsWith(`/${INDEX.push}/_doc/`));
    assert.ok(deleted.params.has('if_seq_no') && deleted.params.has('if_primary_term'), 'deleted only if unchanged since it was read');
    assert.equal(deleted.params.get('refresh'), 'wait_for');
  });

  test('a registration written between the read and the delete is kept', async () => {
    const { cluster, device } = setup();
    const token = apnsToken();
    const newer = apnsToken();
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token })).status, 200);
    const id = registrationId(EVENT, device.profileId, 'apns');
    // The app registers its new token while the old token's delete is between its read and its
    // delete: the guarded delete answers 409 and changes nothing.
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if ((init.method ?? 'GET') === 'DELETE' && String(input).includes(`/_doc/${id}`)) {
        cluster.patch(INDEX.push, id, { token: newer });
      }
      return fetchBefore(input, init);
    };
    try {
      assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token }), { status: 200, body: { ok: true } });
    } finally {
      globalThis.fetch = fetchBefore;
    }
    assert.equal(cluster.source(INDEX.push, id)?.token, newer);
  });

  test('takes no environment, and checks the token format', async () => {
    const { device } = setup();
    const token = apnsToken();
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token, environment: 'sandbox' }), { status: 400, body: { error: 'Unknown key: environment' } });
    assert.equal(deleteRequest({ event: EVENT, platform: 'apns', token, environment: 'sandbox' }, { closed: true }).valid, false);
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token: 'xyz' }), { status: 400, body: { error: 'token must be an APNs device token in hex' } });
    assert.equal(deleteRequest({ event: EVENT, platform: 'fcm', token: fcmToken() }, { closed: true }).valid, true);
  });
});

// A person with a Web Push subscription, an APNs and an FCM registration, and someone else's
// registration that must survive.
async function withRegistrations() {
  const { cluster, device } = setup();
  const other = newDevice();
  addPerson(cluster, other);
  const tokens = { apns: apnsToken(), fcm: fcmToken(), others: apnsToken() };
  cluster.put(INDEX.push, subscriptionId('https://fcm.googleapis.com/fcm/send/sub'), { event_id: EVENT, profile_id: device.profileId, endpoint: 'https://fcm.googleapis.com/fcm/send/sub', keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  assert.equal((await put(device, { event: EVENT, platform: 'apns', token: tokens.apns })).status, 200);
  assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: tokens.fcm })).status, 200);
  assert.equal((await put(other, { event: EVENT, platform: 'apns', token: tokens.others })).status, 200);
  return { cluster, device, other, tokens, othersId: registrationId(EVENT, other.profileId, 'apns') };
}

describe('registrations go with the profile and the conference, like Web Push subscriptions', () => {
  test('DELETE /api/people/profile removes them', async () => {
    const { cluster, device, othersId } = await withRegistrations();
    assert.deepEqual(await request(people.handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device), { status: 200, body: { ok: true } });
    assert.deepEqual(cluster.ids(INDEX.push), [othersId]);
  });

  test('turning visibility and every shared talk off (which deletes the profile) removes them', async () => {
    const { cluster, device, othersId } = await withRegistrations();
    const r = await request(people.handlePeopleApi, 'PUT', '/api/people/profile', device, { event: EVENT, profile: { display_name: 'Test person' }, open_to_meet: false, shared_talk_ids: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(cluster.ids(INDEX.push), [othersId]);
  });

  test('the purge finishes a pending delete with them', async () => {
    const { cluster, device, othersId } = await withRegistrations();
    cluster.patch(INDEX.people, personId(device.profileId), HIDDEN_FOR_DELETE);
    await quietly(() => people.finishPendingDeletes());
    assert.equal(cluster.source(INDEX.people, personId(device.profileId)), null);
    assert.deepEqual(cluster.ids(INDEX.push), [othersId]);
  });

  test('the hourly purge deletes those whose conference has ended', async () => {
    const { cluster, device } = await withRegistrations();
    const ended = apnsToken();
    cluster.put(INDEX.push, registrationId('old-conf-2020', 'x', 'apns'), { event_id: 'old-conf-2020', profile_id: 'x', platform: 'apns', token: ended, environment: 'production', expires_at: PAST });
    await quietly(() => people.purgeExpired());
    assert.equal(cluster.source(INDEX.push, registrationId('old-conf-2020', 'x', 'apns')), null);
    assert.equal(cluster.ids(INDEX.push).length, 4, 'live ones are kept');
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm')));
  });

  test('turning presence off keeps them, as it keeps Web Push subscriptions', async () => {
    const { cluster, device } = await withRegistrations();
    const { handleConnectApi } = await import('../server/connect.mjs');
    assert.equal((await request(handleConnectApi, 'DELETE', `/api/presence?event=${EVENT}`, device)).status, 200);
    assert.equal(cluster.ids(INDEX.push).length, 4);
  });
});

test('pushTargetsFor reads subscriptions and registrations back for nudge.mjs, and skips what it cannot use', async () => {
  const { cluster, device, other, tokens, othersId } = await withRegistrations();
  cluster.put(INDEX.push, 'bad-token', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: 'not-hex', expires_at: FUTURE });
  cluster.put(INDEX.push, 'bad-platform', { event_id: EVENT, profile_id: device.profileId, platform: 'webos', token: tokens.apns, expires_at: FUTURE });
  cluster.put(INDEX.push, 'expired', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: apnsToken(), expires_at: PAST });
  cluster.put(INDEX.push, 'sandbox', { event_id: EVENT, profile_id: other.profileId, platform: 'apns', token: 'ab'.repeat(32), environment: 'sandbox', expires_at: FUTURE });
  const targets = await pushTargetsFor(EVENT, [device.profileId, other.profileId]);
  const byId = Object.fromEntries(targets.map((t) => [t.id, t]));
  const apnsId = registrationId(EVENT, device.profileId, 'apns');
  const fcmId = registrationId(EVENT, device.profileId, 'fcm');
  assert.deepEqual(Object.keys(byId).sort(), [subscriptionId('https://fcm.googleapis.com/fcm/send/sub'), apnsId, fcmId, othersId, 'sandbox'].sort());
  assert.deepEqual(byId[subscriptionId('https://fcm.googleapis.com/fcm/send/sub')].subscription, { endpoint: 'https://fcm.googleapis.com/fcm/send/sub', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
  const guardOf = (id) => ({ seqNo: cluster.docs(INDEX.push).get(id).seq, primaryTerm: 1 });
  assert.deepEqual(byId[apnsId], { id: apnsId, profile_id: device.profileId, native: { platform: 'apns', token: tokens.apns, environment: 'production' }, guard: guardOf(apnsId) });
  assert.deepEqual(byId[fcmId].native, { platform: 'fcm', token: tokens.fcm, environment: 'production' });
  assert.deepEqual(byId[fcmId].guard, guardOf(fcmId), 'a registration carries the version it was read at');
  assert.equal(byId.sandbox.native.environment, 'sandbox');
  assert.equal(byId[subscriptionId('https://fcm.googleapis.com/fcm/send/sub')].guard, undefined, 'a subscription is deleted by id alone');
});

test('a registration reported gone is deleted only while it is the document that was read', async () => {
  const { cluster, device } = await withRegistrations();
  const apnsId = registrationId(EVENT, device.profileId, 'apns');
  const [read] = (await pushTargetsFor(EVENT, [device.profileId])).filter((t) => t.id === apnsId);
  // The device registers a new token after the push went out: the document is rewritten.
  const fresh = apnsToken();
  assert.equal((await put(device, { event: EVENT, platform: 'apns', token: fresh })).status, 200);
  await deleteRegistrationIfUnchanged(apnsId, read.guard);
  assert.equal(cluster.source(INDEX.push, apnsId)?.token, fresh, 'the new token stays');
  const attempt = cluster.log.findLast((e) => e.method === 'DELETE' && e.path === `/${INDEX.push}/_doc/${apnsId}`);
  assert.equal(attempt.params.get('if_seq_no'), String(read.guard.seqNo));
  assert.equal(attempt.params.get('if_primary_term'), '1');
  // Unchanged since it was read: deleted. Already gone: nothing to do, and no error.
  const [again] = (await pushTargetsFor(EVENT, [device.profileId])).filter((t) => t.id === apnsId);
  await deleteRegistrationIfUnchanged(apnsId, again.guard);
  assert.equal(cluster.source(INDEX.push, apnsId), null);
  await deleteRegistrationIfUnchanged(apnsId, again.guard);
  assert.ok(cluster.source(INDEX.push, registrationId(EVENT, device.profileId, 'fcm')), 'the other platform is untouched');
});

test('a delayed retry of an older PUT is the last write and wins until the device registers again (documented, DECISIONS.md)', async () => {
  // The server can only order requests by arrival: a retry of the old token's PUT that arrives
  // after the new token's is, to the server, the newer registration. The contract has the app
  // send one registration call at a time and register its current token at every start.
  const { cluster, device } = setup();
  const [old, rotated] = [fcmToken(), fcmToken()];
  const id = registrationId(EVENT, device.profileId, 'fcm');
  for (const token of [old, rotated, old]) assert.equal((await put(device, { event: EVENT, platform: 'fcm', token })).status, 200);
  assert.equal(cluster.source(INDEX.push, id).token, old, 'last write wins');
  assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: rotated })).status, 200, 'the next start');
  assert.equal(cluster.source(INDEX.push, id).token, rotated);
  assert.equal(cluster.ids(INDEX.push).length, 1);
});

test('pushTargetsFor reads every receiver in one search, so one receiver with many subscriptions cannot crowd another out', async () => {
  const { cluster, device, other, othersId } = await withRegistrations();
  // 150 subscriptions of one person would fill any shared page of hits.
  for (let i = 0; i < 150; i++) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/flood/${i}`;
    cluster.put(INDEX.push, subscriptionId(endpoint), { event_id: EVENT, profile_id: device.profileId, endpoint, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), created_at: new Date(Date.UTC(2099, 0, 1, 0, i)).toISOString(), expires_at: FUTURE });
  }
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  let targets;
  try {
    targets = await pushTargetsFor(EVENT, [device.profileId, other.profileId, device.profileId, 'nobody']);
  } finally {
    console.error = error;
  }
  assert.ok(targets.some((t) => t.id === othersId), "the other receiver's registration is there");
  const mine = targets.filter((t) => t.profile_id === device.profileId);
  assert.equal(mine.length, TARGETS_PER_PROFILE, 'capped at the newest ten');
  assert.deepEqual(mine.map((t) => t.subscription?.endpoint), Array.from({ length: 10 }, (_, i) => `https://fcm.googleapis.com/fcm/send/flood/${149 - i}`));
  assert.deepEqual(lines, [`Push targets capped: one receiver has 153, the newest ${TARGETS_PER_PROFILE} are used`]);
  const searches = cluster.log.filter((e) => e.path.startsWith(`/${INDEX.push}/_search`));
  assert.equal(searches.length, 1, 'one search for every receiver');
  const { body } = searches[0];
  assert.equal(body.size, 0, 'the hits come from the aggregation only');
  assert.deepEqual(body.query.bool.filter[1], { terms: { profile_id: [device.profileId, other.profileId, 'nobody'] } });
  assert.deepEqual(body.aggs.receivers.terms, { field: 'profile_id', size: 3 }, 'one bucket for each distinct receiver');
  assert.equal(body.aggs.receivers.aggs.newest.top_hits.size, TARGETS_READ_PER_PROFILE, 'reads more than it keeps, so unusable rows are dropped before the cut');
  assert.deepEqual(body.aggs.receivers.aggs.newest.top_hits.sort, [{ created_at: { order: 'desc', unmapped_type: 'date' } }]);
  assert.deepEqual(await pushTargetsFor(EVENT, []), [], 'no receiver, no search');
  assert.equal(cluster.log.filter((e) => e.path.startsWith(`/${INDEX.push}/_search`)).length, 1);
});

test('this configuration advertises push.apns and push.fcm, and the document stays valid in closed mode', () => {
  assert.deepEqual(CAPABILITIES.push, { apns: true, fcm: true, webpush: false });
  const result = validator('capabilities.v1')(CAPABILITIES, { closed: true });
  assert.equal(result.valid, true);
});
