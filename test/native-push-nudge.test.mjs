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
//
// The clock. Every nudge here runs on one pinned clock, passed to nudgeAfterPresence and to a
// native push channel made with it, except in the two tests of the defaults. Nothing depends on
// the wall clock: a run that crosses midnight cannot change the day of the once-per-pair rule
// between two calls, and the APNs expiry is an exact number.

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
const { createNativePush } = await import('../server/native-push.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };
const { registrationId } = await import('../server/push.mjs');
const { refFor } = await import('../server/device.mjs');

// The pinned clock starts 1 ms before midnight UTC, in the test conference's year, at every pair();
// clock.set moves it. nativePush is a channel made with it, from the settings above.
const JUST_BEFORE_MIDNIGHT = Date.parse('2099-12-30T23:59:59.999Z');
const MIDNIGHT = JUST_BEFORE_MIDNIGHT + 1;
function pinnedClock(ms) {
  let t = ms;
  const now = () => t;
  now.set = (next) => {
    t = next;
  };
  return now;
}
let clock = pinnedClock(JUST_BEFORE_MIDNIGHT);
let nativePush = createNativePush(process.env, { now: clock });
// nudgeAfterPresence's options for the pinned clock: the clock, the channel made with it and no
// pause, unless more replaces one of them.
const pinned = (more = {}) => ({ now: clock, nativePush, ...NO_PAUSE, ...more });
const iso = (ms) => new Date(ms).toISOString();

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
// platform: apns and fcm are tokens). The presence starts at the pinned clock and lasts 30 minutes.
function around(d, { web = false, apns = null, fcm = null } = {}) {
  const id = `${EVENT}:${d.profileId}`;
  fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_spot: SPOT, presence_since: iso(clock()), presence_until: iso(clock() + 30 * 60_000), presence_location: { lat: 61.5, lon: 102.5 } });
  if (web) fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://fcm.googleapis.com/fcm/send/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  for (const [platform, token] of [['apns', apns], ['fcm', fcm]]) {
    if (token) fake.put('caddie-people-push', registrationId(EVENT, d.profileId, platform), { event_id: EVENT, profile_id: d.profileId, platform, token, ...(platform === 'apns' ? { environment: 'production' } : {}), expires_at: FUTURE });
  }
}

// The trigger T (expertise eBPF) and a strong match V (wants to learn eBPF), around from 1 ms
// before midnight UTC on a fresh pinned clock.
async function pair(tOpts, vOpts) {
  fake.reset();
  answers.clear();
  clock = pinnedClock(JUST_BEFORE_MIDNIGHT);
  nativePush = createNativePush(process.env, { now: clock });
  const t = newDevice();
  const v = newDevice();
  assert.equal((await put(t, 'Harry Trigger', { expertise: 'eBPF probes in production', speak: ['ebpf'] })).status, 200);
  assert.equal((await put(v, 'Vic Match', { expertise: 'Postgres operators', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
  around(t, tOpts);
  around(v, vOpts);
  fake.calls.length = 0;
  return { t, v, me: { ...docOf(t) } };
}

// Moves the pinned clock to ms and writes presence again at that time for each person, as the app
// does before a nudge runs. Returns the first person's document, the nudge's me.
function later(ms, ...people) {
  clock.set(ms);
  for (const d of people) around(d);
  return { ...docOf(people[0]) };
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
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF, pinned());
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
    // position. The position's numbers are ones no ISO time can hold (it has a "." only after its
    // seconds, 00 to 59), so an ISO time added to a payload later cannot match them. They have one
    // decimal, so they also catch a position rounded to one decimal.
    const sent = JSON.stringify(fake.pushes.map((p) => p.payload));
    for (const leak of ['Harry', 'Vic', 'Trigger', 'Match', refFor(EVENT, t.profileId), refFor(EVENT, v.profileId), t.profileId, v.profileId, SPOT, 'coffee', 'distance', 'profile_id', '"ref"', '61.5', '102.5']) {
      assert.ok(!sent.includes(leak), `${leak} reached a push`);
    }
    const apns = fake.pushes.find((p) => p.platform === 'apns');
    assert.equal(apns.origin, 'https://api.push.apple.com');
    assert.equal(apns.headers['apns-topic'], 'app.conferencecaddie');
    assert.equal(apns.headers['apns-priority'], '5');
    assert.equal(apns.headers.authorization, undefined, 'the recorder never holds the provider token');
    assert.equal(apns.headers['apns-expiration'], String(Math.floor(JUST_BEFORE_MIDNIGHT / 1000) + 600), 'expires with the Web Push TTL, 600 s');
    assert.deepEqual(fake.pushes.find((p) => p.platform === 'fcm').payload.message.android, { ttl: '600s', priority: 'normal', notification: { tag: 'caddie-nudge' } });
    assert.equal(fake.pushes.find((p) => !p.platform).options.TTL, 600, 'Web Push is unchanged');

    // Once per pair per day, whichever channels.
    fake.pushes.length = 0;
    await nudgeAfterPresence(me, CONF, pinned());
    assert.equal(fake.pushes.length, 0);
    assert.equal(records().length, 1);
  });

  test('the hourly limit covers the channels together and counts a receiver once per nudge', async () => {
    const tApns = apnsToken();
    const tFcm = fcmToken();
    const { t, v, me } = await pair({ web: true, apns: tApns, fcm: tFcm }, { apns: apnsToken() });
    // T was nudged twice in the last hour already.
    for (const i of [1, 2]) {
      fake.put('caddie-people-nudges', `earlier-${i}`, { event_id: EVENT, day: 'x', profile_ids: [t.profileId, `someone${i}`], receivers: [t.profileId], created_at: iso(clock() - i * 60_000), expires_at: FUTURE });
    }
    await nudgeAfterPresence(me, CONF, pinned());
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
    await nudgeAfterPresence({ ...docOf(t) }, CONF, pinned());
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
    fake.put('caddie-people-nudges', 'earlier', { event_id: EVENT, day: 'x', profile_ids: [t.profileId, 'someone'], receivers: [t.profileId], created_at: iso(clock() - 60_000), expires_at: FUTURE });
    fake.put('caddie-people-nudges', 'earlier-2', { event_id: EVENT, day: 'x', profile_ids: [t.profileId, 'someone-2'], receivers: [t.profileId], created_at: iso(clock() - 120_000), expires_at: FUTURE });
    const pauses = [];
    await nudgeAfterPresence(me, CONF, pinned({ pause: async () => pauses.push(fake.pushes.map(addressOf).sort()) }));
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
    await nudgeAfterPresence(me, CONF, pinned());
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
    await nudgeAfterPresence(me, CONF, pinned());
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
      await nudgeAfterPresence(me, CONF, pinned());
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
    answers.set(goneApns, { status: 410, body: { reason: 'Unregistered', timestamp: clock() } });
    answers.set(goneFcm, { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED') });
    answers.set(badApns, { status: 400, body: { reason: 'BadDeviceToken' } });
    answers.set(keptFcm, { status: 503, body: fcmError(503, 'UNAVAILABLE') });
    answers.set(topicApns, { status: 400, body: { reason: 'DeviceTokenNotForTopic' } });
    answers.set(busyFcm, { status: 429, body: fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED') });
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await nudgeAfterPresence(me, CONF, pinned());
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
      fake.put('caddie-people-push', id, { ...fake.doc('caddie-people-push', id), token, created_at: iso(clock()) });
    };
    answers.set(oldApns, { status: 410, body: { reason: 'Unregistered', timestamp: clock() }, meanwhile: rotate(t, 'apns', newApns) });
    answers.set(oldFcm, { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), meanwhile: rotate(v, 'fcm', newFcm) });
    await nudgeAfterPresence(me, CONF, pinned());
    assert.equal(fake.pushes.length, 2);
    assert.equal(fake.doc('caddie-people-push', registrationId(EVENT, t.profileId, 'apns'))?.token, newApns, 'APNs: the new token stays');
    assert.equal(fake.doc('caddie-people-push', registrationId(EVENT, v.profileId, 'fcm'))?.token, newFcm, 'FCM: the new token stays');
    assert.equal(fake.calls.filter((c) => c.index === 'caddie-people-push' && c.method === 'DELETE').length, 2, 'both deletes were tried, and refused');
  });

  test('the once-per-pair day is the conference\'s: across midnight UTC a conference in UTC nudges the pair again, one in Los Angeles only after its own midnight', async () => {
    const [tApns, vFcm] = [apnsToken(), fcmToken()];
    // In UTC, 23:59:59.999 and the next millisecond are two conference days.
    let { t, v, me } = await pair({ apns: tApns }, { fcm: vFcm });
    await nudgeAfterPresence(me, CONF, pinned());
    clock.set(MIDNIGHT);
    await nudgeAfterPresence(me, CONF, pinned());
    assert.deepEqual(fake.pushes.map(addressOf), [`apns:${tApns}`, `fcm:${vFcm}`, `apns:${tApns}`, `fcm:${vFcm}`], 'nudged on both days');
    assert.deepEqual(records().map((r) => [r.day, r.created_at]).sort(), [['2099-12-30', '2099-12-30T23:59:59.999Z'], ['2099-12-31', '2099-12-31T00:00:00.000Z']]);

    // In Los Angeles (UTC-8 in December) the same two instants are 15:59:59.999 and 16:00 on
    // 30 December, one conference day, so the second nudge is refused.
    const la = { ...CONF, timeZone: 'America/Los_Angeles' };
    ({ t, v, me } = await pair({ apns: tApns }, { fcm: vFcm }));
    await nudgeAfterPresence(me, la, pinned());
    clock.set(MIDNIGHT);
    await nudgeAfterPresence(me, la, pinned());
    assert.equal(fake.pushes.length, 2, 'nudged once');
    assert.deepEqual(records().map((r) => r.day), ['2099-12-30']);
    // Its own midnight is 08:00 UTC: 1 ms before it the pair is still refused, at it nudged again.
    await nudgeAfterPresence(later(Date.parse('2099-12-31T07:59:59.999Z'), t, v), la, pinned());
    assert.equal(fake.pushes.length, 2, 'still 30 December in Los Angeles');
    await nudgeAfterPresence(later(Date.parse('2099-12-31T08:00:00.000Z'), t, v), la, pinned());
    assert.equal(fake.pushes.length, 4, '31 December in Los Angeles');
    assert.deepEqual(records().map((r) => [r.day, r.created_at]).sort(), [['2099-12-30', '2099-12-30T23:59:59.999Z'], ['2099-12-31', '2099-12-31T08:00:00.000Z']]);
  });

  test('a conference with no time zone keeps its days in UTC-12, as dayBounds and visible_until do', async () => {
    const [tApns, vFcm] = [apnsToken(), fcmToken()];
    const noZone = { ...CONF, timeZone: null };
    const { t, v, me } = await pair({ apns: tApns }, { fcm: vFcm });
    await nudgeAfterPresence(me, noZone, pinned());
    assert.equal(fake.pushes.length, 2);
    // Midnight in UTC-12 is 12:00 UTC: 1 ms before it the pair is still refused, at it nudged again.
    await nudgeAfterPresence(later(Date.parse('2099-12-31T11:59:59.999Z'), t, v), noZone, pinned());
    assert.equal(fake.pushes.length, 2, 'still 30 December in UTC-12');
    await nudgeAfterPresence(later(Date.parse('2099-12-31T12:00:00.000Z'), t, v), noZone, pinned());
    assert.equal(fake.pushes.length, 4, '31 December in UTC-12');
    assert.deepEqual(records().map((r) => [r.day, r.created_at]).sort(), [['2099-12-30', '2099-12-30T23:59:59.999Z'], ['2099-12-31', '2099-12-31T12:00:00.000Z']]);
  });

  test('the hourly limit counts the nudges of the hour before the nudge\'s clock, its first millisecond included', async () => {
    for (const [edge, pushed] of [[60 * 60_000 + 1, true], [60 * 60_000, false]]) {
      const tApns = apnsToken();
      const { t, me } = await pair({ apns: tApns }, { apns: apnsToken() });
      // T was nudged one minute, two minutes and edge ms before the pinned clock.
      for (const [i, ago] of [60_000, 120_000, edge].entries()) {
        fake.put('caddie-people-nudges', `earlier-${i}`, { event_id: EVENT, day: 'x', profile_ids: [t.profileId, `someone${i}`], receivers: [t.profileId], created_at: iso(clock() - ago), expires_at: FUTURE });
      }
      await nudgeAfterPresence(me, CONF, pinned());
      assert.equal(fake.pushes.map(addressOf).includes(`apns:${tApns}`), pushed, `a nudge ${edge} ms earlier ${pushed ? 'is not' : 'is'} in the hour`);
    }
  });

  test('under a pinned clock each APNs push expires 600 s after the time that clock gives when the push is sent', async () => {
    const [tApns, vApns] = [apnsToken(), apnsToken()];
    const { me } = await pair({ apns: tApns }, { apns: vApns });
    // The pause between the two people of the pair moves the clock on by 2.5 s.
    await nudgeAfterPresence(me, CONF, pinned({ pause: async () => clock.set(clock() + 2500) }));
    const seconds = Math.floor(JUST_BEFORE_MIDNIGHT / 1000);
    const expiry = Object.fromEntries(fake.pushes.map((p) => [addressOf(p), p.headers['apns-expiration']]));
    assert.deepEqual(expiry, { [`apns:${tApns}`]: String(seconds + 600), [`apns:${vApns}`]: String(seconds + 3 + 600) }, 'the second push was sent at 00:00:02.499');
    assert.equal(records()[0].created_at, '2099-12-30T23:59:59.999Z', 'the record has the time the nudge ran');
  });

  test('a presence that has run out by the nudge\'s clock counts as gone, even while Elasticsearch\'s clock still sees it', async () => {
    // The stand-in for Elasticsearch compares presence_until with the wall clock, decades before
    // these presences end, so only the nudge's own reads of its clock can leave them out.
    const { t, me } = await pair({ web: true }, { web: true });
    clock.set(Date.parse(me.presence_until));
    await nudgeAfterPresence(me, CONF, pinned());
    assert.equal(fake.peopleSearches().length, 0, 'the trigger is no longer around: no query');
    // The trigger writes presence again; the match's, written 30 minutes earlier, has just run out.
    await nudgeAfterPresence(later(clock(), t), CONF, pinned());
    assert.equal(fake.peopleSearches().length, 1);
    assert.equal(fake.pushes.length, 0);
    assert.equal(records().length, 0);
  });

  // Keep this test last: while Date.now is mocked, NATIVE_PUSH's FCM access token and the topics
  // cache are stamped in 2099, so they look fresh to any later test in this file.
  test('with no clock and no channel given, the rule and NATIVE_PUSH read Date.now when they run', async (t) => {
    const [tApns, vFcm] = [apnsToken(), fcmToken()];
    const { me } = await pair({ apns: tApns }, { fcm: vFcm });
    // Date.now replaced after the server modules were imported; the stand-in reads it too.
    const now = Date.parse('2099-12-30T12:34:56.789Z');
    t.mock.method(Date, 'now', () => now);
    try {
      await nudgeAfterPresence(me, CONF, NO_PAUSE);
    } finally {
      t.mock.restoreAll();
    }
    assert.deepEqual(records().map((r) => [r.day, r.created_at]), [['2099-12-30', '2099-12-30T12:34:56.789Z']]);
    assert.deepEqual(fake.pushes.map(addressOf), [`apns:${tApns}`, `fcm:${vFcm}`]);
    assert.equal(fake.pushes[0].headers['apns-expiration'], String(Math.floor(now / 1000) + 600));
  });
});

// The demo conference (invented data) labels every push it causes, on every channel, so a demo push
// is never taken for a real conference's; a real conference's pushes are unchanged (above).
describe('push nudge about the demo conference', () => {
  test('every channel says Demo: the Web Push title and body, and the native demo alert', async () => {
    const { NATIVE_ALERT_DEMO, APNS_BODY_DEMO } = await import('../server/native-push.mjs');
    const { DEMO_TITLE } = await import('../server/nudge.mjs');
    const tApns = apnsToken();
    const vFcm = fcmToken();
    const { t, me } = await pair({ web: true, apns: tApns }, { web: true, fcm: vFcm });
    await nudgeAfterPresence(me, { ...CONF, demo: true }, pinned());
    const words = new Map(fake.pushes.map((p) => [addressOf(p), wordsOf(p)]));
    assert.equal(words.size, 4, 'both people, every channel');
    const web = words.get(`web:https://fcm.googleapis.com/fcm/send/${t.profileId}`);
    assert.equal(web.title, DEMO_TITLE);
    assert.equal(web.title, 'Conference Caddie (Demo)');
    assert.match(web.body, /^Demo: someone who's worked on .+ is in Hall A right now$/);
    const DEMO_ALERT = { title: NATIVE_ALERT_DEMO.title, body: NATIVE_ALERT_DEMO.body, link: NATIVE_ALERT_DEMO.deepLink };
    assert.match(DEMO_ALERT.title, /Demo/);
    assert.equal(DEMO_ALERT.title, 'Conference Caddie (Demo)', 'one title rule for every demo notification (docs/contracts/talk-bundle.md)');
    assert.match(DEMO_ALERT.body, /^Demo: /);
    assert.equal(DEMO_ALERT.link, ALERT.link);
    for (const address of [`apns:${tApns}`, `fcm:${vFcm}`]) assert.deepEqual(words.get(address), DEMO_ALERT, address);
    const apns = fake.pushes.find((p) => p.platform === 'apns');
    assert.equal(JSON.stringify(apns.payload), APNS_BODY_DEMO);
    const nativeText = JSON.stringify(fake.pushes.filter((p) => p.platform).map((p) => p.payload));
    for (const leak of ['Hall A', 'eBPF', EVENT]) assert.ok(!nativeText.includes(leak), `${leak} reached a native push`);
  });
});
