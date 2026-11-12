// The push nudge (server/nudge.mjs) with native push on: one nudge reaches every Web Push
// subscription and every APNs and FCM registration of each receiver, with the same words and
// nothing else; the once-per-pair-per-day record and the limit of 3 pushes per receiver per hour
// cover the channels together, counting a receiver once per nudge; and a registration APNs or FCM
// reports gone is deleted while other failures keep it.
//
// Run with `npm test`. It uses the in-memory stand-in for Elasticsearch in test/lib/fake-es.mjs,
// which sets PUSH_TRANSPORT=stub, so every push (Web Push, APNs and FCM) is recorded instead of
// sent; nothing reaches the network. APNs is configured with a key generated for this run, and FCM
// with a project id; the stub answers the metadata server's token request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fake, EVENT, FUTURE, PUSH_HOST, newDevice, request, profileBody } from './lib/fake-es.mjs';
import { writeKeyFile } from './helpers/apns-key.mjs';

Object.assign(process.env, {
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_FILE: writeKeyFile(),
  FCM_PROJECT_ID: 'caddie-test-project',
});
delete process.env.APNS_BUNDLE_ID;

const { handlePeopleApi } = await import('../server/people.mjs');
const { nudgeAfterPresence, pairDelayMs, PAIR_JITTER_MAX_MS } = await import('../server/nudge.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };
const { registrationId } = await import('../server/push.mjs');
const { refFor } = await import('../server/device.mjs');

// Answers the stub gives for particular tokens ({ status, body, meanwhile }); every other push gets
// 201. meanwhile, when set, runs while the push is out, before the answer.
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
      await answer.meanwhile?.();
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
// Web Push subscription (web: true) and native registrations (a device has at most one per
// platform: apns and fcm are tokens).
function around(d, { web = false, apns = null, fcm = null } = {}) {
  const id = `${EVENT}:${d.profileId}`;
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_spot: SPOT, presence_since: new Date().toISOString(), presence_until: until, presence_location: { lat: 61.25, lon: 102.75 } });
  if (web) fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://fcm.googleapis.com/fcm/send/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  for (const [platform, token] of [['apns', apns], ['fcm', fcm]]) {
    if (token) fake.put('caddie-people-push', registrationId(EVENT, d.profileId, platform), { event_id: EVENT, profile_id: d.profileId, platform, token, ...(platform === 'apns' ? { environment: 'production' } : {}), expires_at: FUTURE });
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
  if (p.platform === 'apns') return { title: p.payload.aps.alert.title, body: p.payload.aps.alert.body, link: p.payload.deepLink };
  if (p.platform === 'fcm') return { title: p.payload.message.notification.title, body: p.payload.message.notification.body, link: p.payload.message.data.deepLink };
  return { title: p.payload.title, body: p.payload.body, link: p.payload.data.url };
};
const ALERT = { title: 'Conference Caddie', body: 'Someone whose experience matches yours is in your zone right now', link: 'caddie://people?around=1' };

describe('push nudge with native push', () => {
  test('one nudge reaches every subscription and registration of both people: the Web Push words, and the generic alert natively', async () => {
    const tApns = apnsToken();
    const vApns = apnsToken();
    const vFcm = fcmToken();
    const { t, v, me } = await pair({ web: true, apns: tApns }, { web: true, apns: vApns, fcm: vFcm });
    const before = Date.now();
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF, NO_PAUSE);
    } finally {
      console.error = error;
    }
    assert.deepEqual(lines, [], 'every push was accepted');
    assert.deepEqual(fake.pushes.map(addressOf).sort(), [`apns:${tApns}`, `apns:${vApns}`, `fcm:${vFcm}`, `web:https://fcm.googleapis.com/fcm/send/${t.profileId}`, `web:https://fcm.googleapis.com/fcm/send/${v.profileId}`].sort());
    assert.equal(records().length, 1);
    assert.deepEqual(records()[0].receivers.sort(), [t.profileId, v.profileId].sort());

    // Web Push, end-to-end encrypted to the browser, carries the passage and the zone.
    const words = new Map(fake.pushes.map((p) => [addressOf(p), wordsOf(p)]));
    const toT = words.get(`web:https://fcm.googleapis.com/fcm/send/${t.profileId}`);
    const toV = words.get(`web:https://fcm.googleapis.com/fcm/send/${v.profileId}`);
    for (const w of [toT, toV]) {
      assert.equal(w.title, 'Conference Caddie');
      assert.match(w.body, /^Someone who's worked on .+ is in Hall A right now$/);
      assert.equal(w.link, `/e/${EVENT}#/people?around=1`);
    }
    assert.notDeepEqual(toT.body, toV.body, 'each hears about the other');

    // APNs and FCM, which Apple and Google read in plain text, carry the generic alert: the same
    // bytes for both people, with nothing from either profile, the zone or the conference.
    for (const address of [`apns:${tApns}`, `apns:${vApns}`, `fcm:${vFcm}`]) assert.deepEqual(words.get(address), ALERT, address);
    const native = fake.pushes.filter((p) => p.platform);
    assert.equal(new Set(native.filter((p) => p.platform === 'apns').map((p) => JSON.stringify(p.payload))).size, 1, 'one APNs payload for everyone');
    const nativeText = JSON.stringify(native.map((p) => p.payload));
    for (const leak of ['Hall A', 'Hall', 'eBPF', 'ebpf', 'probes', 'Postgres', 'production', 'worked on', EVENT, '/e/', '"url"', toT.body, toV.body]) {
      assert.ok(!nativeText.includes(leak), `${leak} reached a native push`);
    }

    // Nothing about either person in any push: no name, ref, profile_id, spot line, distance or
    // position. The position's numbers are ones no timestamp can hold (an ISO time has a "." only
    // after its seconds, 00 to 59), so a time added to a payload later cannot match them.
    const sent = JSON.stringify(fake.pushes.map((p) => p.payload));
    for (const leak of ['Harry', 'Vic', 'Trigger', 'Match', refFor(EVENT, t.profileId), refFor(EVENT, v.profileId), t.profileId, v.profileId, SPOT, 'coffee', 'distance', 'profile_id', '"ref"', '61.25', '102.75']) {
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
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(records().length, 1);
  });

  test('the hourly limit covers the channels together and counts a receiver once per nudge', async () => {
    const tApns = apnsToken();
    const tFcm = fcmToken();
    const { t, v, me } = await pair({ web: true, apns: tApns, fcm: tFcm }, { apns: apnsToken() });
    // T was nudged twice in the last hour already.
    for (const i of [1, 2]) {
      fake.put('caddie-people-nudges', `earlier-${i}`, { event_id: EVENT, day: 'x', profile_ids: [t.profileId, `someone${i}`], receivers: [t.profileId], created_at: new Date(Date.now() - i * 60_000).toISOString(), expires_at: FUTURE });
    }
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    const toT = fake.pushes.filter((p) => [`apns:${tApns}`, `fcm:${tFcm}`, `web:https://fcm.googleapis.com/fcm/send/${t.profileId}`].includes(addressOf(p)));
    assert.equal(toT.length, 3, 'the third nudge of the hour reaches all three of T\'s channels');
    const pairRecord = records().find((r) => r.profile_ids.includes(v.profileId));
    assert.deepEqual(pairRecord.receivers.sort(), [t.profileId, v.profileId].sort(), 'and counts once');

    // A new match W: T is at 3 nudges this hour, so only W is pushed.
    const w = newDevice();
    assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
    const wFcm = fcmToken();
    around(w, { fcm: wFcm });
    fake.pushes.length = 0;
    await nudgeAfterPresence({ ...docOf(t) }, CONF, NO_PAUSE);
    assert.deepEqual(fake.pushes.map(addressOf), [`fcm:${wFcm}`]);
    assert.deepEqual(records().find((r) => r.profile_ids.includes(w.profileId)).receivers, [w.profileId]);
  });

  test('the pushes to the second person of a pair wait for the pause after those to the first, on every channel', async () => {
    const [tApns, vFcm] = [apnsToken(), fcmToken()];
    const { t, v, me } = await pair({ web: true, apns: tApns }, { web: true, fcm: vFcm });
    const w = newDevice();
    assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
    around(w, { web: true });
    // T is at two nudges this hour already, so only the first pair reaches T; the second pair
    // reaches W alone and needs no pause.
    fake.put('caddie-people-nudges', 'earlier', { event_id: EVENT, day: 'x', profile_ids: [t.profileId, 'someone'], receivers: [t.profileId], created_at: new Date(Date.now() - 60_000).toISOString(), expires_at: FUTURE });
    fake.put('caddie-people-nudges', 'earlier-2', { event_id: EVENT, day: 'x', profile_ids: [t.profileId, 'someone-2'], receivers: [t.profileId], created_at: new Date(Date.now() - 120_000).toISOString(), expires_at: FUTURE });
    const pauses = [];
    await nudgeAfterPresence(me, CONF, { pause: async () => pauses.push(fake.pushes.map(addressOf).sort()) });
    assert.equal(pauses.length, 1, 'one pause, in the pair with two receivers');
    assert.deepEqual(pauses[0], [`apns:${tApns}`, `web:https://fcm.googleapis.com/fcm/send/${t.profileId}`].sort(), 'all of the first person\'s pushes go out before it');
    const after = fake.pushes.map(addressOf).slice(2);
    assert.deepEqual(after.slice(0, 2).sort(), [`fcm:${vFcm}`, `web:https://fcm.googleapis.com/fcm/send/${v.profileId}`].sort(), 'all of the second person\'s after it');
    assert.deepEqual(after.slice(2), [`web:https://fcm.googleapis.com/fcm/send/${w.profileId}`]);
  });

  test('the pause is a random whole number of milliseconds from 0 to 3000', () => {
    assert.equal(PAIR_JITTER_MAX_MS, 3000);
    const samples = Array.from({ length: 2000 }, () => pairDelayMs());
    assert.ok(samples.every((ms) => Number.isInteger(ms) && ms >= 0 && ms <= 3000));
    assert.ok(Math.min(...samples) < 500 && Math.max(...samples) > 2500, 'spread over the range');
  });

  test('by default the second person\'s pushes wait for a real timer, after the nudge was started', async (t) => {
    const { me } = await pair({ web: true }, { web: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const done = nudgeAfterPresence(me, CONF);
    const deadline = Date.now() + 2000;
    while (fake.pushes.length < 1 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.pushes.length, 1, 'the first push went out, the second waits');
    t.mock.timers.tick(PAIR_JITTER_MAX_MS);
    await done;
    assert.equal(fake.pushes.length, 2);
  });

  test('one search reads the targets of every receiver, however many matches, as Web Push did before native push', async () => {
    const { t, v, me } = await pair({ web: true }, { web: true });
    const w = newDevice();
    assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
    around(w, { web: true });
    fake.calls.length = 0;
    const targetSearches = () => fake.calls.filter((c) => c.index === 'caddie-people-push' && c.op === '_search');
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(targetSearches().length, 1, 'one search for the writer and both matches');
    assert.deepEqual(targetSearches()[0].body.aggs.receivers.terms, { field: 'profile_id', size: 3 });
    // The writer hears about both matches, and each match about the writer: the pushes main sent.
    const sent = fake.pushes.map(addressOf).sort();
    assert.deepEqual(sent, [t, t, v, w].map((d) => `web:https://fcm.googleapis.com/fcm/send/${d.profileId}`).sort());
    assert.equal(records().length, 2);

    // The same day again: both records exist, so the creates answer 409 and nothing is sent; the
    // one search is made first, as before.
    fake.pushes.length = 0;
    fake.calls.length = 0;
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(targetSearches().length, 1);
  });

  test('a receiver with more than ten subscriptions and registrations gets the nudge on the newest ten, and the other receiver still gets theirs', async () => {
    const tApns = apnsToken();
    const { v, me } = await pair({ apns: tApns }, {});
    for (let i = 0; i < 12; i++) {
      fake.put('caddie-people-push', `flood-${i}`, { event_id: EVENT, profile_id: v.profileId, endpoint: `https://fcm.googleapis.com/fcm/send/flood/${i}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), created_at: new Date(Date.UTC(2099, 0, 1, 0, i)).toISOString(), expires_at: FUTURE });
    }
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF, NO_PAUSE);
    } finally {
      console.error = error;
    }
    const toV = fake.pushes.filter((p) => !p.platform).map((p) => p.endpoint).sort();
    assert.deepEqual(toV, Array.from({ length: 10 }, (_, i) => `https://fcm.googleapis.com/fcm/send/flood/${i + 2}`).sort(), 'the newest ten');
    assert.deepEqual(fake.pushes.filter((p) => p.platform).map(addressOf), [`apns:${tApns}`]);
    assert.deepEqual(lines, ['Push targets capped: one receiver has 12, the newest 10 are used']);
  });

  test('a registration APNs or FCM reports gone is deleted; a refusal for another reason keeps it', async () => {
    const [goneApns, goneFcm, badApns, keptFcm, topicApns, busyFcm] = [apnsToken(), fcmToken(), apnsToken(), fcmToken(), apnsToken(), fcmToken()];
    const { t, v, me } = await pair({ apns: goneApns, fcm: goneFcm }, { apns: badApns, fcm: keptFcm });
    const w = newDevice();
    assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
    around(w, { apns: topicApns, fcm: busyFcm });
    const fcmError = (code, status, errorCode) => ({ error: { code, status, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] } });
    answers.set(goneApns, { status: 410, body: { reason: 'Unregistered', timestamp: Date.now() } });
    answers.set(goneFcm, { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED') });
    answers.set(badApns, { status: 400, body: { reason: 'BadDeviceToken' } });
    answers.set(keptFcm, { status: 503, body: fcmError(503, 'UNAVAILABLE') });
    answers.set(topicApns, { status: 400, body: { reason: 'DeviceTokenNotForTopic' } });
    answers.set(busyFcm, { status: 429, body: fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED') });
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF, NO_PAUSE);
    } finally {
      console.error = error;
    }
    assert.equal(fake.pushes.length, 6, 'every registration was tried once');
    const store = fake.store('caddie-people-push');
    assert.equal(store.has(registrationId(EVENT, t.profileId, 'apns')), false, 'APNs 410: deleted');
    assert.equal(store.has(registrationId(EVENT, t.profileId, 'fcm')), false, 'FCM 404 UNREGISTERED: deleted');
    assert.equal(store.has(registrationId(EVENT, v.profileId, 'apns')), false, 'APNs 400 BadDeviceToken: deleted');
    assert.equal(store.has(registrationId(EVENT, v.profileId, 'fcm')), true, 'FCM 503: kept');
    assert.equal(store.has(registrationId(EVENT, w.profileId, 'apns')), true, 'APNs 400 DeviceTokenNotForTopic: kept, since a wrong topic gives it for every token');
    assert.equal(store.has(registrationId(EVENT, w.profileId, 'fcm')), true, 'FCM 429: kept');
    assert.deepEqual(lines.sort(), ['Native push failed: apns 400 DeviceTokenNotForTopic', 'Native push failed: fcm 429 QUOTA_EXCEEDED', 'Native push failed: fcm 503 UNAVAILABLE']);
    const deletes = fake.calls.filter((c) => c.index === 'caddie-people-push' && c.method === 'DELETE');
    assert.equal(deletes.length, 3);
    assert.ok(deletes.every((c) => c.params.has('if_seq_no') && c.params.get('if_primary_term') === '1'), 'each delete is guarded by the version that was read');
  });

  test('a token reported gone after the device registered a new one: the new registration stays', async () => {
    const [oldApns, newApns, oldFcm, newFcm] = [apnsToken(), apnsToken(), fcmToken(), fcmToken()];
    const { t, v, me } = await pair({ apns: oldApns }, { fcm: oldFcm });
    const fcmError = (code, status, errorCode) => ({ error: { code, status, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } });
    // While each push is out, the device registers the token the platform rotated to, and then the
    // platform answers that the old token is gone.
    const rotate = (d, platform, token) => () => {
      const id = registrationId(EVENT, d.profileId, platform);
      fake.put('caddie-people-push', id, { ...fake.doc('caddie-people-push', id), token, created_at: new Date().toISOString() });
    };
    answers.set(oldApns, { status: 410, body: { reason: 'Unregistered', timestamp: Date.now() }, meanwhile: rotate(t, 'apns', newApns) });
    answers.set(oldFcm, { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), meanwhile: rotate(v, 'fcm', newFcm) });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 2);
    assert.equal(fake.doc('caddie-people-push', registrationId(EVENT, t.profileId, 'apns'))?.token, newApns, 'APNs: the new token stays');
    assert.equal(fake.doc('caddie-people-push', registrationId(EVENT, v.profileId, 'fcm'))?.token, newFcm, 'FCM: the new token stays');
    assert.equal(fake.calls.filter((c) => c.index === 'caddie-people-push' && c.method === 'DELETE').length, 2, 'both deletes were tried, and refused');
  });
});
