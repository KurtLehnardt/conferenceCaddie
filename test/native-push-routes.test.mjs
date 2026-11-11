// The optional native push registration routes of server/push.mjs (PUT and DELETE
// /api/push/native), run against the in-memory stand-in for Elasticsearch in
// test/helpers/fake-es.mjs: what a registration stores, the closed bodies and token formats, the
// device and profile checks (a pending delete included), the people-write bucket, and that a
// profile delete, visibility off, the hourly purge and the finishing of a pending delete remove
// native registrations exactly as they remove Web Push subscriptions. Also what nudge.mjs reads
// back (pushTargetsFor), and the capabilities this configuration advertises.
//
// Run with `npm test`. Nothing reaches the network: fetch is replaced before the server modules
// are imported, APNs is configured with a key generated for this run and FCM with a project id, and
// PUSH_TRANSPORT=stub without PUSH_STUB_URL makes any push fail locally.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, personId, addPerson,
  addConnections, request, quietly, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';

for (const k of ['APNS_BUNDLE_ID', 'PUSH_STUB_URL']) delete process.env[k];
Object.assign(process.env, {
  PUSH_TRANSPORT: 'stub',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_P8: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  FCM_PROJECT_ID: 'caddie-test-project',
});

const people = await import('../server/people.mjs');
const { handlePushApi, registrationId, subscriptionId, pushTargetsFor } = await import('../server/push.mjs');
const { CAPABILITIES } = await import('../server/capabilities.mjs');
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
  test('one token keeps a registration at each conference it is used at', async () => {
    const { cluster, device } = setup();
    const OTHER = 'otherconf-2099';
    cluster.put(INDEX.conferences, OTHER, { slug: OTHER, status: 'searchable', end_date: '2099-12-31', time_zone: 'UTC' });
    addPerson(cluster, device);
    cluster.put(INDEX.people, `${OTHER}:${device.profileId}`, { ...cluster.source(INDEX.people, personId(device.profileId)), event_id: OTHER });
    const token = apnsToken();
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token })).status, 200);
    assert.equal((await put(device, { event: OTHER, platform: 'apns', token })).status, 200);
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, 'apns', token)).event_id, EVENT);
    assert.equal(cluster.source(INDEX.push, registrationId(OTHER, 'apns', token)).event_id, OTHER);
    // Removing it at one conference leaves the other.
    assert.equal((await del(device, { event: OTHER, platform: 'apns', token })).status, 200);
    assert.equal(cluster.source(INDEX.push, registrationId(OTHER, 'apns', token)), null);
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, 'apns', token)));
  });

  test('stores an APNs token (lowercase, production unless sandbox) and an FCM token under sha256(event:platform:token)', async () => {
    const { cluster, device } = setup();
    const apns = apnsToken();
    const fcm = fcmToken();
    assert.deepEqual(await put(device, { event: EVENT, platform: 'apns', token: apns.toUpperCase() }), { status: 200, body: { ok: true } });
    assert.deepEqual(await put(device, { event: EVENT, platform: 'fcm', token: fcm }), { status: 200, body: { ok: true } });
    const a = cluster.source(INDEX.push, registrationId(EVENT, 'apns', apns));
    const { created_at: createdA, ...restA } = a;
    assert.deepEqual(restA, { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: apns, environment: 'production', expires_at: FUTURE });
    assert.ok(Date.parse(createdA) <= Date.now());
    const f = cluster.source(INDEX.push, registrationId(EVENT, 'fcm', fcm));
    const { created_at: createdF, ...restF } = f;
    assert.deepEqual(restF, { event_id: EVENT, profile_id: device.profileId, platform: 'fcm', token: fcm, expires_at: FUTURE });
    assert.equal(registrationId(EVENT, 'apns', apns), crypto.createHash('sha256').update(`${EVENT}:apns:${apns}`).digest('hex'));
    const write = cluster.log.find((e) => e.method === 'PUT' && e.path.startsWith(`/${INDEX.push}/_doc/`));
    assert.equal(write.params.get('refresh'), 'wait_for');

    // The same token again overwrites its document: here it moves to the sandbox.
    assert.equal((await put(device, { event: EVENT, platform: 'apns', token: apns, environment: 'sandbox' })).status, 200);
    assert.equal(cluster.ids(INDEX.push).length, 2);
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, 'apns', apns)).environment, 'sandbox');
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
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, 'apns', token)), "another profile's request changes nothing");
    assert.deepEqual(await del(device, { event: EVENT, platform: 'fcm', token: fcmToken() }), { status: 200, body: { ok: true } }, 'nothing to remove');
    assert.deepEqual(await del(device, { event: EVENT, platform: 'apns', token: token.toUpperCase() }), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, 'apns', token)), null);
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
  cluster.put(INDEX.push, subscriptionId('https://push.example.test/sub'), { event_id: EVENT, profile_id: device.profileId, endpoint: 'https://push.example.test/sub', keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  assert.equal((await put(device, { event: EVENT, platform: 'apns', token: tokens.apns })).status, 200);
  assert.equal((await put(device, { event: EVENT, platform: 'fcm', token: tokens.fcm })).status, 200);
  assert.equal((await put(other, { event: EVENT, platform: 'apns', token: tokens.others })).status, 200);
  return { cluster, device, other, tokens };
}

describe('registrations go with the profile and the conference, like Web Push subscriptions', () => {
  test('DELETE /api/people/profile removes them', async () => {
    const { cluster, device, tokens } = await withRegistrations();
    assert.deepEqual(await request(people.handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device), { status: 200, body: { ok: true } });
    assert.deepEqual(cluster.ids(INDEX.push), [registrationId(EVENT, 'apns', tokens.others)]);
  });

  test('turning visibility and every shared talk off (which deletes the profile) removes them', async () => {
    const { cluster, device, tokens } = await withRegistrations();
    const r = await request(people.handlePeopleApi, 'PUT', '/api/people/profile', device, { event: EVENT, profile: { display_name: 'Test person' }, open_to_meet: false, shared_talk_ids: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(cluster.ids(INDEX.push), [registrationId(EVENT, 'apns', tokens.others)]);
  });

  test('the purge finishes a pending delete with them', async () => {
    const { cluster, device, tokens } = await withRegistrations();
    cluster.patch(INDEX.people, personId(device.profileId), HIDDEN_FOR_DELETE);
    await quietly(() => people.finishPendingDeletes());
    assert.equal(cluster.source(INDEX.people, personId(device.profileId)), null);
    assert.deepEqual(cluster.ids(INDEX.push), [registrationId(EVENT, 'apns', tokens.others)]);
  });

  test('the hourly purge deletes those whose conference has ended', async () => {
    const { cluster, tokens } = await withRegistrations();
    const ended = apnsToken();
    cluster.put(INDEX.push, registrationId(EVENT, 'apns', ended), { event_id: 'old-conf-2020', profile_id: 'x', platform: 'apns', token: ended, environment: 'production', expires_at: PAST });
    await quietly(() => people.purgeExpired());
    assert.equal(cluster.source(INDEX.push, registrationId(EVENT, 'apns', ended)), null);
    assert.equal(cluster.ids(INDEX.push).length, 4, 'live ones are kept');
    assert.ok(cluster.source(INDEX.push, registrationId(EVENT, 'fcm', tokens.fcm)));
  });

  test('turning presence off keeps them, as it keeps Web Push subscriptions', async () => {
    const { cluster, device } = await withRegistrations();
    const { handleConnectApi } = await import('../server/connect.mjs');
    assert.equal((await request(handleConnectApi, 'DELETE', `/api/presence?event=${EVENT}`, device)).status, 200);
    assert.equal(cluster.ids(INDEX.push).length, 4);
  });
});

test('pushTargetsFor reads subscriptions and registrations back for nudge.mjs, and skips what it cannot use', async () => {
  const { cluster, device, other, tokens } = await withRegistrations();
  cluster.put(INDEX.push, 'bad-token', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: 'not-hex', expires_at: FUTURE });
  cluster.put(INDEX.push, 'bad-platform', { event_id: EVENT, profile_id: device.profileId, platform: 'webos', token: tokens.apns, expires_at: FUTURE });
  cluster.put(INDEX.push, 'expired', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: apnsToken(), expires_at: PAST });
  cluster.put(INDEX.push, 'sandbox', { event_id: EVENT, profile_id: other.profileId, platform: 'apns', token: 'ab'.repeat(32), environment: 'sandbox', expires_at: FUTURE });
  const targets = await pushTargetsFor(EVENT, [device.profileId, other.profileId]);
  const byId = Object.fromEntries(targets.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), [subscriptionId('https://push.example.test/sub'), registrationId(EVENT, 'apns', tokens.apns), registrationId(EVENT, 'fcm', tokens.fcm), registrationId(EVENT, 'apns', tokens.others), 'sandbox'].sort());
  assert.deepEqual(byId[subscriptionId('https://push.example.test/sub')].subscription, { endpoint: 'https://push.example.test/sub', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
  assert.deepEqual(byId[registrationId(EVENT, 'apns', tokens.apns)], { id: registrationId(EVENT, 'apns', tokens.apns), profile_id: device.profileId, native: { platform: 'apns', token: tokens.apns, environment: 'production' } });
  assert.deepEqual(byId[registrationId(EVENT, 'fcm', tokens.fcm)].native, { platform: 'fcm', token: tokens.fcm, environment: 'production' });
  assert.equal(byId.sandbox.native.environment, 'sandbox');
});

test('this configuration advertises push.apns and push.fcm, and the document stays valid in closed mode', () => {
  assert.deepEqual(CAPABILITIES.push, { apns: true, fcm: true, webpush: false });
  const result = validator('capabilities.v1')(CAPABILITIES, { closed: true });
  assert.equal(result.valid, true);
});
