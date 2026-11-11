// The push service allowlist of tier 3 (sec-1 in REVIEW_NOTES_FREE.md): PUT /api/push/subscription
// stores an endpoint only on a known browser push service host, and pushTargetsFor skips a stored
// subscription that is not on one, so a profile can never make the server POST to a host of its
// choosing. The list and the rule must stay the same as the Worker's (worker/src/push/webpush.js):
// the hosts are compared here and both rules are run on every case below.
//
// Run with `npm test`. Nothing reaches the network: fetch is replaced by the in-memory stand-in
// for Elasticsearch before the server modules are imported, and PUSH_TRANSPORT=stub without
// PUSH_STUB_URL makes any push fail locally.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, addPerson, request, quietly } from './helpers/fake-es.mjs';
import { PUSH_SERVICE_HOSTS, isPushServiceEndpoint } from '../server/push-hosts.mjs';
import * as workerPush from '../worker/src/push/webpush.js';

for (const k of ['PUSH_STUB_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
process.env.PUSH_TRANSPORT = 'stub';

const { handlePushApi, subscriptionId, pushTargetsFor } = await import('../server/push.mjs');
const { webPushOptions, PUSH_TIMEOUT_MS } = await import('../server/nudge.mjs');

before(() => bootPurgeDone());

// Endpoints a browser push service hands out, in the shapes each one uses.
const ACCEPTED = [
  'https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ',
  'https://android.googleapis.com/gcm/send/dGVzdA:APA91b',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
  'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bdGVzdA%3d%3d',
  'https://web.push.apple.com/QGuQyavXutnMH9kz1dVzWd',
  'https://api.push.apple.com/3/device/abc',
  // The URL parser lowercases the scheme and the host, so these are the same hosts.
  'HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/x',
  'https://Updates.Push.Services.Mozilla.Com/wpush/v2/x',
  // :443 is the default port, which the parser drops.
  'https://fcm.googleapis.com:443/fcm/send/x',
  // Full-width letters map to the same ASCII host under IDNA, so the request goes to FCM itself.
  'https://ｆｃｍ.googleapis.com/fcm/send/x',
];

// Bypass attempts and other hosts. Every one of these must be refused.
const REFUSED = [
  // An allowed host as a prefix, a path, a query or a fragment of another host.
  'https://fcm.googleapis.com.evil.com/fcm/send/x',
  'https://evil.com/fcm.googleapis.com',
  'https://evil.com/?h=fcm.googleapis.com',
  'https://evil.com#fcm.googleapis.com',
  'https://notify.windows.com.evil.com/w/',
  'https://web.push.apple.com.evil.com/x',
  // A suffix entry matches subdomains only, at a label boundary.
  'https://push.services.mozilla.com/wpush/v2/x',
  'https://evilpush.services.mozilla.com/wpush/v2/x',
  'https://notify.windows.com/w/',
  'https://evilpush.apple.com/x',
  'https://googleapis.com/fcm/send/x',
  'https://evil-fcm.googleapis.com.example/x',
  // User info: the allowed name before @ is a user name, and the host is evil.com.
  'https://fcm.googleapis.com@evil.com/fcm/send/x',
  'https://fcm.googleapis.com:443@evil.com/x',
  'https://user:pass@fcm.googleapis.com/fcm/send/x',
  'https://user@fcm.googleapis.com/fcm/send/x',
  // A backslash is a path separator for https, so the host is evil.com.
  'https://evil.com\\@fcm.googleapis.com/x',
  // Encoded and hidden characters in the host decode to another host.
  'https://fcm.googleapis.com%2Eevil.com/x',
  'https://fcm.googleapis.com\t.evil.com/x',
  // Trailing dot, also with uppercase.
  'https://fcm.googleapis.com./fcm/send/x',
  'HTTPS://FCM.GOOGLEAPIS.COM./fcm/send/x',
  'https://updates.push.services.mozilla.com./wpush/v2/x',
  // Non-default ports.
  'https://fcm.googleapis.com:8443/fcm/send/x',
  'https://fcm.googleapis.com:80/fcm/send/x',
  'https://fcm.googleapis.com:0/fcm/send/x',
  // Punycode and look-alikes: a Greek omicron, a Cyrillic a, an explicit xn-- label.
  'https://fcm.googleapis.cοm/fcm/send/x',
  'https://web.push.аpple.com/x',
  'https://xn--fcm-googleapis-com-9ma.evil/x',
  'https://fcm.xn--googleapis-com-z3b/x',
  // IP literals, IPv4 in every spelling the parser accepts, and localhost.
  'https://[::1]/push',
  'https://[2001:db8::1]/push',
  'https://[::ffff:8.8.8.8]/push',
  'https://192.0.2.10/push',
  'https://127.0.0.1/push',
  'https://2130706433/push',
  'https://0x7f.1/push',
  'https://localhost/push',
  // Other schemes and malformed values.
  'http://fcm.googleapis.com/fcm/send/x',
  'HTTP://FCM.GOOGLEAPIS.COM/fcm/send/x',
  'wss://fcm.googleapis.com/fcm/send/x',
  'ftp://fcm.googleapis.com/x',
  '//fcm.googleapis.com/fcm/send/x',
  'fcm.googleapis.com/fcm/send/x',
  'not a url',
  '',
  null,
  undefined,
  42,
  {},
];

describe('the push service rule', () => {
  test('the host list is the Worker\'s, entry for entry', () => {
    assert.deepEqual([...PUSH_SERVICE_HOSTS], [...workerPush.PUSH_SERVICE_HOSTS]);
    assert.ok(Object.isFrozen(PUSH_SERVICE_HOSTS));
  });

  test('known push service endpoints are accepted', () => {
    for (const e of ACCEPTED) assert.equal(isPushServiceEndpoint(e), true, e);
  });

  test('bypass attempts, IP literals, other ports and other schemes are refused', () => {
    for (const e of REFUSED) assert.equal(isPushServiceEndpoint(e), false, String(e));
  });

  test('tier 3 and the Worker give the same answer on every case', () => {
    for (const e of [...ACCEPTED, ...REFUSED]) assert.equal(isPushServiceEndpoint(e), workerPush.isPushServiceEndpoint(e), String(e));
  });
});

const keys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};
const subscribe = (device, endpoint) => request(handlePushApi, 'PUT', '/api/push/subscription', device, { event: EVENT, subscription: { endpoint, keys: keys(), expirationTime: null } });
const unsubscribe = (device, endpoint) => request(handlePushApi, 'DELETE', '/api/push/subscription', device, { event: EVENT, endpoint });

function setup() {
  const cluster = useCluster(new FakeES());
  const device = newDevice();
  addPerson(cluster, device);
  return { cluster, device };
}

// A new device with a profile, so a long list of cases stays under the per-device write bucket.
const person = (cluster) => {
  const device = newDevice();
  addPerson(cluster, device);
  return device;
};

// Runs fn with console.warn captured.
async function warnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = original;
  }
}

describe('PUT /api/push/subscription', () => {
  test('refuses an endpoint off the list with 400 "endpoint must be a push service URL" and stores nothing', async () => {
    const { cluster } = setup();
    const offList = REFUSED.filter((e) => typeof e === 'string' && /^https:/i.test(e) && !/\s/.test(e));
    assert.ok(offList.length > 30);
    for (const endpoint of offList) {
      const { result } = await warnings(() => subscribe(person(cluster), endpoint));
      assert.deepEqual(result, { status: 400, body: { error: 'endpoint must be a push service URL' } }, endpoint);
    }
    assert.equal(cluster.ids(INDEX.push).length, 0);
  });

  test('an http endpoint keeps its own message', async () => {
    const { cluster, device } = setup();
    assert.deepEqual(await subscribe(device, 'http://fcm.googleapis.com/fcm/send/x'), { status: 400, body: { error: 'endpoint must be a https URL' } });
    assert.equal(cluster.ids(INDEX.push).length, 0);
  });

  test('a refusal logs the host, never the endpoint', async () => {
    const { device } = setup();
    const secretPath = `/fcm/send/${crypto.randomBytes(12).toString('base64url')}`;
    const { lines } = await warnings(() => subscribe(device, `https://fcm.googleapis.com.evil.com${secretPath}`));
    assert.deepEqual(lines, ['Push subscription refused: host fcm.googleapis.com.evil.com']);
    assert.ok(!lines.join('\n').includes(secretPath));
  });

  test('accepts each kind of push service endpoint, stored by the hash of the endpoint as sent', async () => {
    const { cluster } = setup();
    for (const endpoint of ACCEPTED) {
      assert.deepEqual(await subscribe(person(cluster), endpoint), { status: 200, body: { ok: true } }, endpoint);
      assert.equal(cluster.source(INDEX.push, subscriptionId(endpoint)).endpoint, endpoint);
    }
    assert.equal(cluster.ids(INDEX.push).length, ACCEPTED.length);
  });
});

describe('a subscription stored before the rule', () => {
  const legacy = 'https://push.example.test/stored-before-the-rule';
  const allowed = 'https://fcm.googleapis.com/fcm/send/kept';
  const store = (cluster, device, endpoint) => cluster.put(INDEX.push, subscriptionId(endpoint), {
    event_id: EVENT, profile_id: device.profileId, endpoint, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE,
  });

  test('can still be removed by its owner', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    assert.deepEqual(await unsubscribe(device, legacy), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, subscriptionId(legacy)), null);
  });

  test('is skipped by pushTargetsFor, so no nudge is sent to it, with one log line that names no endpoint or host', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    store(cluster, device, allowed);
    store(cluster, device, 'https://192.0.2.10/push');
    const { result: targets, lines } = await quietly(() => pushTargetsFor(EVENT, [device.profileId]));
    assert.deepEqual(targets.map((t) => t.subscription?.endpoint), [allowed]);
    assert.deepEqual(lines, ['Push targets skipped: 2 stored subscription(s) not on a known push service host']);
    assert.ok(cluster.source(INDEX.push, subscriptionId(legacy)), 'skipped, not deleted: the purge removes it with the conference');
  });

  test('a person whose only subscription is off the list is no push target at all', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    const { result: targets } = await quietly(() => pushTargetsFor(EVENT, [device.profileId]));
    assert.deepEqual(targets, []);
  });
});

test('a Web Push request carries a 10 second timeout that web-push accepts', async () => {
  const mod = await import('web-push');
  const webpush = mod.default ?? mod;
  const vapid = webpush.generateVAPIDKeys();
  const vapidDetails = { subject: 'mailto:test@example.org', publicKey: vapid.publicKey, privateKey: vapid.privateKey };
  const options = webPushOptions({ TTL: 600, urgency: 'normal' }, vapidDetails);
  assert.equal(PUSH_TIMEOUT_MS, 10_000);
  assert.deepEqual(options, { TTL: 600, urgency: 'normal', vapidDetails, timeout: 10_000 });
  const details = webpush.generateRequestDetails({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() }, '{}', options);
  assert.equal(details.timeout, 10_000);
  assert.equal(details.endpoint, 'https://fcm.googleapis.com/fcm/send/x');
});
