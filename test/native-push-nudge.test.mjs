// The push nudge (server/nudge.mjs) with native push on: one nudge reaches every Web Push
// subscription and every APNs and FCM registration of each receiver, with the same words and
// nothing else; the once-per-pair-per-day record and the limit of 3 pushes per receiver per hour
// cover the channels together, counting a receiver once per nudge; and a registration APNs or FCM
// reports gone is deleted while other failures keep it.
//
// Run with `npm test`. It uses the in-memory stand-in for Elasticsearch in test/lib/fake-es.mjs,
// which sets PUSH_TRANSPORT=stub, so every push (Web Push, APNs and FCM) is recorded instead of
// sent; nothing reaches the network. Both native channels are configured with keys generated for
// this run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fake, EVENT, FUTURE, PUSH_HOST, newDevice, request, profileBody } from './lib/fake-es.mjs';

Object.assign(process.env, {
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_P8: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    project_id: 'caddie-test-project',
    private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'push@caddie-test-project.iam.gserviceaccount.com',
  }),
});
for (const k of ['APNS_BUNDLE_ID', 'FCM_PROJECT_ID']) delete process.env[k];

const { handlePeopleApi } = await import('../server/people.mjs');
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
const { registrationId } = await import('../server/push.mjs');
const { refFor } = await import('../server/device.mjs');

// Answers the stub gives for particular tokens ({ status, body }); every other push gets 201.
const answers = new Map();
const recorded = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host === PUSH_HOST && init.body) {
    const entry = JSON.parse(init.body);
    const token = entry.platform === 'apns' ? entry.path.split('/').pop() : entry.payload?.message?.token;
    const answer = token ? answers.get(token) : undefined;
    if (answer) {
      fake.pushes.push(entry);
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
  }
  return recorded(input, init);
};

const CONF = { slug: EVENT, timeZone: 'UTC', visibleUntil: FUTURE };
const SPOT = 'blue cap by the coffee';
const docOf = (d) => fake.doc('caddie-people', `${EVENT}:${d.profileId}`);
const put = (d, name, o) => request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody(name, o));
const apnsToken = () => crypto.randomBytes(32).toString('hex');
const fcmToken = () => `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;

// Puts a person around in Hall A with a spot line, straight into the stand-in, with the given
// Web Push subscription (web: true) and native registrations.
function around(d, { web = false, apns = [], fcm = [] } = {}) {
  const id = `${EVENT}:${d.profileId}`;
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_spot: SPOT, presence_since: new Date().toISOString(), presence_until: until, presence_location: { lat: 1.5, lon: 2.5 } });
  if (web) fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://push.example.test/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  for (const [platform, tokens] of [['apns', apns], ['fcm', fcm]]) {
    for (const token of tokens) {
      fake.put('caddie-people-push', registrationId(EVENT, platform, token), { event_id: EVENT, profile_id: d.profileId, platform, token, ...(platform === 'apns' ? { environment: 'production' } : {}), expires_at: FUTURE });
    }
  }
}

// The trigger T (expertise eBPF) and a strong match V (wants to learn eBPF).
async function pair(tOpts, vOpts) {
  fake.reset();
  answers.clear();
  const t = newDevice();
  const v = newDevice();
  assert.equal((await put(t, 'Harry Trigger', { expertise: 'eBPF probes in production', speak: ['ebpf'] })).status, 200);
  assert.equal((await put(v, 'Vic Match', { expertise: 'Postgres operators', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
  around(t, tOpts);
  around(v, vOpts);
  fake.calls.length = 0;
  return { t, v, me: { ...docOf(t) } };
}

const records = () => [...fake.store('caddie-people-nudges').values()].map((r) => r.source);
// Who a recorded push went to, by its address.
const addressOf = (p) => (p.platform === 'apns' ? `apns:${p.path.split('/').pop()}` : p.platform === 'fcm' ? `fcm:${p.payload.message.token}` : `web:${p.endpoint}`);
// The words of a recorded push, whatever its channel.
const wordsOf = (p) => {
  if (p.platform === 'apns') return { title: p.payload.aps.alert.title, body: p.payload.aps.alert.body, url: p.payload.data.url };
  if (p.platform === 'fcm') return { title: p.payload.message.notification.title, body: p.payload.message.notification.body, url: p.payload.message.data.url };
  return { title: p.payload.title, body: p.payload.body, url: p.payload.data.url };
};

describe('push nudge with native push', () => {
  test('one nudge reaches every subscription and registration of both people, with the same words and nothing else', async () => {
    const tApns = apnsToken();
    const vApns = apnsToken();
    const vFcm = fcmToken();
    const { t, v, me } = await pair({ web: true, apns: [tApns] }, { apns: [vApns], fcm: [vFcm] });
    const before = Date.now();
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF);
    } finally {
      console.error = error;
    }
    assert.deepEqual(lines, [], 'every push was accepted');
    assert.deepEqual(fake.pushes.map(addressOf).sort(), [`apns:${tApns}`, `apns:${vApns}`, `fcm:${vFcm}`, `web:https://push.example.test/${t.profileId}`].sort());
    assert.equal(records().length, 1);
    assert.deepEqual(records()[0].receivers.sort(), [t.profileId, v.profileId].sort(), 'a person with only native registrations is a receiver');

    const words = new Map(fake.pushes.map((p) => [addressOf(p), wordsOf(p)]));
    const toT = words.get(`web:https://push.example.test/${t.profileId}`);
    const toV = words.get(`apns:${vApns}`);
    assert.deepEqual(words.get(`apns:${tApns}`), toT, 'Web Push and APNs carry the same nudge');
    assert.deepEqual(words.get(`fcm:${vFcm}`), toV, 'APNs and FCM carry the same nudge');
    for (const w of [toT, toV]) {
      assert.equal(w.title, 'Conference Caddie');
      assert.match(w.body, /^Someone who's worked on .+ is in Hall A right now$/);
      assert.equal(w.url, `/e/${EVENT}#/people?around=1`);
    }
    assert.notDeepEqual(toT.body, toV.body, 'each hears about the other');

    // Nothing about either person but the passage: no name, ref, profile_id, spot line or distance.
    const sent = JSON.stringify(fake.pushes.map((p) => p.payload));
    for (const leak of ['Harry', 'Vic', 'Trigger', 'Match', refFor(EVENT, t.profileId), refFor(EVENT, v.profileId), t.profileId, v.profileId, SPOT, 'coffee', 'distance', 'profile_id', '"ref"', '1.5', '2.5']) {
      assert.ok(!sent.includes(leak), `${leak} reached a push`);
    }
    const apns = fake.pushes.find((p) => p.platform === 'apns');
    assert.equal(apns.origin, 'https://api.push.apple.com');
    assert.equal(apns.headers['apns-topic'], 'app.conferencecaddie');
    assert.equal(apns.headers['apns-priority'], '5');
    assert.equal(apns.headers.authorization, undefined, 'the recorder never holds the provider token');
    const expires = Number(apns.headers['apns-expiration']);
    assert.ok(expires >= Math.floor(before / 1000) + 600 && expires <= Math.floor(Date.now() / 1000) + 600, 'expires with the Web Push TTL, 600 s');
    assert.deepEqual(fake.pushes.find((p) => p.platform === 'fcm').payload.message.android, { ttl: '600s', priority: 'normal', notification: { tag: 'caddie-nudge' } });
    assert.equal(fake.pushes.find((p) => !p.platform).options.TTL, 600, 'Web Push is unchanged');

    // Once per pair per day, whichever channels.
    fake.pushes.length = 0;
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
    assert.equal(records().length, 1);
  });

  test('the hourly limit covers the channels together and counts a receiver once per nudge', async () => {
    const tApns = apnsToken();
    const tFcm = fcmToken();
    const { t, v, me } = await pair({ web: true, apns: [tApns], fcm: [tFcm] }, { apns: [apnsToken()] });
    // T was nudged twice in the last hour already.
    for (const i of [1, 2]) {
      fake.put('caddie-people-nudges', `earlier-${i}`, { event_id: EVENT, day: 'x', profile_ids: [t.profileId, `someone${i}`], receivers: [t.profileId], created_at: new Date(Date.now() - i * 60_000).toISOString(), expires_at: FUTURE });
    }
    await nudgeAfterPresence(me, CONF);
    const toT = fake.pushes.filter((p) => [`apns:${tApns}`, `fcm:${tFcm}`, `web:https://push.example.test/${t.profileId}`].includes(addressOf(p)));
    assert.equal(toT.length, 3, 'the third nudge of the hour reaches all three of T\'s channels');
    const pairRecord = records().find((r) => r.profile_ids.includes(v.profileId));
    assert.deepEqual(pairRecord.receivers.sort(), [t.profileId, v.profileId].sort(), 'and counts once');

    // A new match W: T is at 3 nudges this hour, so only W is pushed.
    const w = newDevice();
    assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
    const wFcm = fcmToken();
    around(w, { fcm: [wFcm] });
    fake.pushes.length = 0;
    await nudgeAfterPresence({ ...docOf(t) }, CONF);
    assert.deepEqual(fake.pushes.map(addressOf), [`fcm:${wFcm}`]);
    assert.deepEqual(records().find((r) => r.profile_ids.includes(w.profileId)).receivers, [w.profileId]);
  });

  test('a registration APNs or FCM reports gone is deleted; a refusal for another reason keeps it', async () => {
    const goneApns = apnsToken();
    const badApns = apnsToken();
    const busyApns = apnsToken();
    const goneFcm = fcmToken();
    const keptFcm = fcmToken();
    const { me } = await pair({ apns: [goneApns, busyApns], fcm: [goneFcm] }, { apns: [badApns], fcm: [keptFcm] });
    answers.set(goneApns, { status: 410, body: { reason: 'Unregistered', timestamp: Date.now() } });
    answers.set(badApns, { status: 400, body: { reason: 'BadDeviceToken' } });
    answers.set(busyApns, { status: 429, body: { reason: 'TooManyRequests' } });
    answers.set(goneFcm, { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } });
    answers.set(keptFcm, { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } });
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF);
    } finally {
      console.error = error;
    }
    assert.equal(fake.pushes.length, 5, 'every registration was tried');
    const store = fake.store('caddie-people-push');
    assert.equal(store.has(registrationId(EVENT, 'apns', goneApns)), false, 'APNs 410: deleted');
    assert.equal(store.has(registrationId(EVENT, 'apns', badApns)), false, 'APNs 400 BadDeviceToken: deleted');
    assert.equal(store.has(registrationId(EVENT, 'fcm', goneFcm)), false, 'FCM 404 UNREGISTERED: deleted');
    assert.equal(store.has(registrationId(EVENT, 'apns', busyApns)), true, 'APNs 429: kept');
    assert.equal(store.has(registrationId(EVENT, 'fcm', keptFcm)), true, 'FCM 503: kept');
    assert.deepEqual(lines.sort(), ['Native push failed: apns 429 TooManyRequests', 'Native push failed: fcm 503 UNAVAILABLE']);
  });
});
