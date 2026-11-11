// The push nudge (server/nudge.mjs) when a channel is off: without the VAPID keys the rule still
// runs for receivers with a native registration; a registration for a platform this server does
// not push to (never configured, or turned off at runtime after five authentication failures in a
// row) makes nobody a receiver and is never sent to; and a channel turned off at runtime is
// advertised false by GET /api/capabilities and refused by PUT /api/push/native.
//
// Run with `npm test`. It uses the in-memory stand-in for Elasticsearch in test/lib/fake-es.mjs.
// native-push.mjs reads PUSH_TRANSPORT=stub when it is imported, so APNs pushes are recorded
// instead of sent; nudge.mjs reads it only at its first push, and by then it is unset and there
// are no VAPID keys, so Web Push is off. APNs is configured with a key generated for this run;
// FCM_PROJECT_ID is not set, so FCM is off. Nothing reaches the network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fake, EVENT, FUTURE, PUSH_HOST, newDevice, request, profileBody } from './lib/fake-es.mjs';
import { writeKeyFile } from './helpers/apns-key.mjs';

Object.assign(process.env, {
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  APNS_KEY_FILE: writeKeyFile(),
});
for (const k of ['APNS_BUNDLE_ID', 'FCM_PROJECT_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];

const { handlePeopleApi } = await import('../server/people.mjs');
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };
const { handlePushApi, registrationId } = await import('../server/push.mjs');
const { NATIVE_PUSH, AUTH_FAILURES_MAX } = await import('../server/native-push.mjs');
const { currentCapabilities, handleCapabilities } = await import('../server/capabilities.mjs');
delete process.env.PUSH_TRANSPORT;

// APNs tokens the stub refuses as the production host would refuse a revoked key.
const refused = new Set();
const recorded = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host === PUSH_HOST && init.body) {
    const entry = JSON.parse(init.body);
    if (entry.platform === 'apns' && refused.has(entry.path.split('/').pop())) {
      fake.pushes.push(entry);
      return new Response(JSON.stringify({ reason: 'InvalidProviderToken' }), { status: 403 });
    }
  }
  return recorded(input, init);
};

const CONF = { slug: EVENT, timeZone: 'UTC', visibleUntil: FUTURE };
const docOf = (d) => fake.doc('caddie-people', `${EVENT}:${d.profileId}`);
const put = (d, name, o) => request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody(name, o));
const apnsToken = () => crypto.randomBytes(32).toString('hex');
const fcmToken = () => `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
const records = () => [...fake.store('caddie-people-nudges').values()].map((r) => r.source);
const addressOf = (p) => (p.platform === 'apns' ? `apns:${p.path.split('/').pop()}` : p.platform === 'fcm' ? `fcm:${p.payload.message.token}` : `web:${p.endpoint}`);

// Puts a person around in Hall A with the given Web Push subscription and native registrations.
function around(d, { web = false, apns = null, fcm = null } = {}) {
  const id = `${EVENT}:${d.profileId}`;
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_since: new Date().toISOString(), presence_until: until });
  if (web) fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://push.example.test/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
  for (const [platform, token] of [['apns', apns], ['fcm', fcm]]) {
    if (token) fake.put('caddie-people-push', registrationId(EVENT, d.profileId, platform), { event_id: EVENT, profile_id: d.profileId, platform, token, ...(platform === 'apns' ? { environment: 'production' } : {}), expires_at: FUTURE });
  }
}

// The trigger T and two strong matches, V and W, each with the channels given.
async function trio(tOpts, vOpts, wOpts) {
  fake.reset();
  const [t, v, w] = [newDevice(), newDevice(), newDevice()];
  assert.equal((await put(t, 'Harry Trigger', { expertise: 'eBPF probes in production', speak: ['ebpf'] })).status, 200);
  assert.equal((await put(v, 'Vic Match', { expertise: 'Postgres operators', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
  assert.equal((await put(w, 'Wanda Third', { expertise: 'Kafka', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
  around(t, tOpts);
  around(v, vOpts);
  around(w, wOpts);
  return { t, v, w, me: { ...docOf(t) } };
}

async function quietNudge(me) {
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
  } finally {
    console.error = error;
  }
  return lines;
}

// GET /api/capabilities through the real handler.
function capabilitiesAnswer() {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = { host: 'caddie.test' };
  req.socket = { remoteAddress: '10.9.0.1' };
  const res = { status: 0, text: '', writeHead(status) { this.status = status; }, end(chunk) { this.text = String(chunk ?? ''); } };
  handleCapabilities(req, res);
  return { status: res.status, body: JSON.parse(res.text) };
}

describe('push nudge with a channel off', () => {
  test('without the VAPID keys the rule still runs for native receivers, and Web Push and FCM receivers are left out', async () => {
    assert.deepEqual([NATIVE_PUSH.apns, NATIVE_PUSH.fcm], [true, false]);
    const vApns = apnsToken();
    const wFcm = fcmToken();
    // T has only a Web Push subscription, V an APNs registration, W only an FCM one (FCM is off).
    const { t, v, w, me } = await trio({ web: true }, { apns: vApns }, { fcm: wFcm });
    const lines = await quietNudge(me);
    assert.deepEqual(fake.pushes.map(addressOf), [`apns:${vApns}`], 'only the APNs registration was pushed');
    assert.deepEqual(lines, ['Web Push nudges are off: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not all set']);
    const byPair = (id) => records().find((r) => r.profile_ids.includes(id));
    assert.deepEqual(byPair(v.profileId).receivers, [v.profileId], 'T, with Web Push off, is no receiver; V is');
    assert.deepEqual(byPair(w.profileId).receivers, [], 'W, whose only registration is on FCM, is no receiver');
    assert.ok(!byPair(v.profileId).receivers.includes(t.profileId));
    assert.equal(fake.store('caddie-people-push').size, 3, 'nothing was deleted');
  });

  test('APNs turned off at runtime: capabilities say so, registering is refused, and an APNs registration makes nobody a receiver', async () => {
    const lines = [];
    const error = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const token = apnsToken();
      refused.add(token);
      for (let i = 0; i < AUTH_FAILURES_MAX; i++) assert.equal(await NATIVE_PUSH.send({ platform: 'apns', token, environment: 'production' }), 'failed');
    } finally {
      console.error = error;
    }
    assert.equal(lines.at(-1), 'APNs push is off: 5 authentication failures in a row.');
    assert.equal(NATIVE_PUSH.apns, false);
    assert.deepEqual(currentCapabilities().push, { apns: false, fcm: false, webpush: false });
    const answer = capabilitiesAnswer();
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.push, { apns: false, fcm: false, webpush: false }, 'GET /api/capabilities answers false from now on');

    const vApns = apnsToken();
    const { v, me } = await trio({}, { apns: vApns }, {});
    assert.deepEqual(await request(handlePushApi, 'PUT', '/api/push/native', v, { event: EVENT, platform: 'apns', token: apnsToken() }), { status: 404, body: { error: 'push_unavailable' } });
    assert.equal(fake.store('caddie-people-push').get(registrationId(EVENT, v.profileId, 'apns')).source.token, vApns, 'the stored registration is kept, untouched');
    assert.deepEqual(await request(handlePushApi, 'DELETE', '/api/push/native', v, { event: EVENT, platform: 'apns', token: vApns }), { status: 200, body: { ok: true } }, 'removing one still works');
    around(v, { apns: vApns });
    fake.pushes.length = 0;
    await quietNudge(me);
    assert.equal(fake.pushes.length, 0, 'nothing is sent on a channel that is off');
    assert.ok(records().every((r) => r.receivers.length === 0), 'and its registrations make nobody a receiver');
  });
});
