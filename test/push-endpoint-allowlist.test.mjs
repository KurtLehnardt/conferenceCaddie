// The push service allowlist of tier 3 (sec-1 in REVIEW_NOTES_FREE.md): PUT /api/push/subscription
// stores an endpoint only on a known browser push service host, and pushTargetsFor skips a stored
// subscription that is not on one, so a profile can never make the server POST to a host of its
// choosing. The list and the rule must stay the same as the Worker's (worker/src/push/webpush.js):
// the hosts and the functions' source are compared here, and both rules are run on every case
// below. The real web-push transport is also run with https.request stubbed, to check that the
// host it sends to is the host the rule checked and that the timeout reaches the request.
//
// Run with `npm test`. Nothing reaches the network: fetch is replaced by the in-memory stand-in
// for Elasticsearch before the server modules are imported, PUSH_TRANSPORT=stub without
// PUSH_STUB_URL makes any push fail locally, and https.request is stubbed where web-push sends.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, addPerson, request, quietly } from './helpers/fake-es.mjs';
import { PUSH_SERVICE_HOSTS, isPushServiceEndpoint } from '../server/push-hosts.mjs';
import * as workerPush from '../worker/src/push/webpush.js';

for (const k of ['PUSH_STUB_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
process.env.PUSH_TRANSPORT = 'stub';

const { handlePushApi, subscriptionId, pushTargetsFor, TARGETS_PER_PROFILE, TARGETS_READ_PER_PROFILE, SUBS_PER_PROFILE } = await import('../server/push.mjs');
const { loadTransport, PUSH_TIMEOUT_MS } = await import('../server/nudge.mjs');

before(() => bootPurgeDone());

// Endpoints a browser push service hands out, in the shapes each one uses.
const ACCEPTED = [
  'https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ',
  'https://android.googleapis.com/gcm/send/dGVzdA:APA91b',
  // Chrome Beta, Dev and Canary, and unbranded Chromium.
  'https://jmt17.google.com/fcm/send/x',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
  'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bdGVzdA%3d%3d',
  'https://web.push.apple.com/QGuQyavXutnMH9kz1dVzWd',
  // Not a browser endpoint (it is the APNs API host), but an Apple host the .push.apple.com entry
  // covers, as it does on the Worker.
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
  // jmt17.google.com is an exact host: no subdomain, no suffix, not its parent domain.
  'https://x.jmt17.google.com/x',
  'https://jmt17.google.com.evil.com/x',
  'https://google.com/x',
  'https://jmt17.google.com:8443/fcm/send/x',
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
  test('the host list holds the Worker\'s hosts, each once', () => {
    // Compared as sets, so a different order alone does not fail; both lists must be free of
    // duplicates, so equal sets mean equal lists up to order.
    assert.equal(new Set(PUSH_SERVICE_HOSTS).size, PUSH_SERVICE_HOSTS.length, 'no duplicate host');
    assert.equal(new Set(workerPush.PUSH_SERVICE_HOSTS).size, workerPush.PUSH_SERVICE_HOSTS.length, 'no duplicate host on the Worker');
    assert.deepEqual(new Set(PUSH_SERVICE_HOSTS), new Set(workerPush.PUSH_SERVICE_HOSTS));
    assert.ok(Object.isFrozen(PUSH_SERVICE_HOSTS));
  });

  test('the rule is the Worker\'s function, character for character apart from whitespace', () => {
    const source = (f) => f.toString().replace(/\s+/g, ' ').trim();
    assert.equal(source(isPushServiceEndpoint), source(workerPush.isPushServiceEndpoint));
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

// A conference that ended in 2020, beside the helpers' live one. The server caches the conference
// list on its first read, so every cluster of this file holds it.
const ENDED = 'endedconf-2020';

function setup() {
  const cluster = useCluster(new FakeES());
  cluster.put(INDEX.conferences, ENDED, { slug: ENDED, status: 'searchable', end_date: '2020-01-02', time_zone: 'UTC' });
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
    assert.deepEqual(lines, ['push subscription refused: host fcm.googleapis.com.evil.com']);
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

// The web app's re-sync (resyncPush in web/src/people/push.ts) turns a conference's nudge switch off
// for good on 403 profile_required, or on a 400 whose error starts "conference has ended" or
// "conference is not available" (conferenceRefuses). An endpoint off the list must not look like
// either, and tier 3 must give those two messages where the Worker does.
// The 400 pattern conferenceRefuses in web/src/people/push.ts switches off on, read from that file
// rather than copied, so a change there is a change here. The root tests cannot import TypeScript.
function webSwitchOff400() {
  const source = readFileSync(new URL('../web/src/people/push.ts', import.meta.url), 'utf8');
  const fn = /function conferenceRefuses\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  const m = /err\.status === 400\) return \/((?:[^/\\\n]|\\.)+)\/([a-z]*)\.test\(/.exec(fn);
  assert.ok(m, 'the 400 pattern of conferenceRefuses in web/src/people/push.ts');
  return new RegExp(m[1], m[2]);
}

describe('the answers the web app\'s re-sync tells apart', () => {
  const SWITCH_OFF_400 = webSwitchOff400();

  test('the pattern read from the web app is the one these tests expect', () => {
    assert.equal(String(SWITCH_OFF_400), String(/^conference (has ended|is not available)/));
  });

  test('an endpoint off the list is a 400 the re-sync does not take as the end of the conference', async () => {
    const { device } = setup();
    const { result } = await warnings(() => subscribe(device, 'https://push.example.test/off-list'));
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.body.error, SWITCH_OFF_400);
  });

  test('an unknown conference is 400 "conference is not available"', async () => {
    const { device } = setup();
    const r = await request(handlePushApi, 'PUT', '/api/push/subscription', device, { event: 'nosuchconf-2099', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() } });
    assert.deepEqual(r, { status: 400, body: { error: 'conference is not available' } });
    assert.match(r.body.error, SWITCH_OFF_400);
  });

  test('an ended conference is 400 "conference has ended" for someone with a profile there', async () => {
    const { cluster, device } = setup();
    const mine = cluster.source(INDEX.people, `${EVENT}:${device.profileId}`);
    cluster.put(INDEX.people, `${ENDED}:${device.profileId}`, { ...mine, event_id: ENDED });
    const r = await request(handlePushApi, 'PUT', '/api/push/subscription', device, { event: ENDED, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() } });
    assert.deepEqual(r, { status: 400, body: { error: 'conference has ended' } });
    assert.match(r.body.error, SWITCH_OFF_400);
  });

  test('an unknown or ended conference wins over an endpoint off the list', async () => {
    const { cluster, device } = setup();
    const mine = cluster.source(INDEX.people, `${EVENT}:${device.profileId}`);
    cluster.put(INDEX.people, `${ENDED}:${device.profileId}`, { ...mine, event_id: ENDED });
    const offList = { endpoint: 'https://push.example.test/off-list', keys: keys() };
    const unknown = await request(handlePushApi, 'PUT', '/api/push/subscription', device, { event: 'nosuchconf-2099', subscription: offList });
    assert.deepEqual(unknown, { status: 400, body: { error: 'conference is not available' } });
    const ended = await request(handlePushApi, 'PUT', '/api/push/subscription', device, { event: ENDED, subscription: offList });
    assert.deepEqual(ended, { status: 400, body: { error: 'conference has ended' } });
    const strangerEnded = await request(handlePushApi, 'PUT', '/api/push/subscription', newDevice(), { event: ENDED, subscription: offList });
    assert.match(strangerEnded.body.error, SWITCH_OFF_400, 'no profile at an ended conference is still a switch-off answer');
  });

  test('no profile at the conference is 403 profile_required', async () => {
    const { cluster } = setup();
    const stranger = newDevice();
    const r = await request(handlePushApi, 'PUT', '/api/push/subscription', stranger, { event: EVENT, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() } });
    assert.deepEqual(r, { status: 403, body: { error: 'profile_required' } });
    assert.equal(cluster.ids(INDEX.push).length, 0);
  });
});

describe('a profile keeps at most ten subscriptions at a conference, as on the Worker', () => {
  const storeAt = (cluster, device, endpoint, createdAt) => cluster.put(INDEX.push, subscriptionId(endpoint), {
    event_id: EVENT, profile_id: device.profileId, endpoint, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), created_at: createdAt, expires_at: FUTURE,
  });
  const past = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

  test('a new subscription removes the oldest beyond ten, with guarded deletes; registrations and other people stay', async () => {
    const { cluster, device } = setup();
    const other = person(cluster);
    for (let i = 0; i < 12; i++) storeAt(cluster, device, `https://fcm.googleapis.com/fcm/send/old-${i}`, past(i));
    storeAt(cluster, other, 'https://fcm.googleapis.com/fcm/send/someone-else', past(0));
    cluster.put(INDEX.push, 'reg-apns', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: 'ab'.repeat(32), environment: 'production', created_at: past(0), expires_at: FUTURE });
    const fresh = 'https://fcm.googleapis.com/fcm/send/fresh';
    assert.deepEqual(await subscribe(device, fresh), { status: 200, body: { ok: true } });
    const mine = cluster.ids(INDEX.push).map((id) => cluster.source(INDEX.push, id)).filter((d) => d.profile_id === device.profileId && d.endpoint).map((d) => d.endpoint).sort();
    assert.equal(mine.length, SUBS_PER_PROFILE);
    assert.deepEqual(mine, [fresh, ...Array.from({ length: 9 }, (_, i) => `https://fcm.googleapis.com/fcm/send/old-${i + 3}`)].sort());
    assert.ok(cluster.source(INDEX.push, 'reg-apns'), 'a native registration is not counted and not touched');
    assert.ok(cluster.source(INDEX.push, subscriptionId('https://fcm.googleapis.com/fcm/send/someone-else')), "another person's subscription stays");
    const bulk = cluster.log.filter((e) => e.path === `/${INDEX.push}/_bulk`);
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].params.get('refresh'), 'wait_for', 'no refresh privilege needed');
    const items = bulk[0].body.split('\n').filter(Boolean).map((l) => JSON.parse(l).delete);
    assert.equal(items.length, 3);
    assert.ok(items.every((d) => Number.isInteger(d.if_seq_no) && Number.isInteger(d.if_primary_term)), 'every delete is guarded');
  });

  test('ten or fewer subscriptions are left alone, with no delete sent', async () => {
    const { cluster, device } = setup();
    for (let i = 0; i < 8; i++) storeAt(cluster, device, `https://fcm.googleapis.com/fcm/send/old-${i}`, past(i));
    assert.equal((await subscribe(device, 'https://fcm.googleapis.com/fcm/send/fresh')).status, 200);
    assert.equal(cluster.ids(INDEX.push).length, 9);
    assert.equal(cluster.log.filter((e) => e.path === `/${INDEX.push}/_bulk`).length, 0);
  });

  test('an endpoint may be 1,000 characters long, as on the Worker, and no longer', async () => {
    const { cluster } = setup();
    const base = 'https://fcm.googleapis.com/fcm/send/';
    const longest = base + 'a'.repeat(1000 - base.length);
    assert.equal((await subscribe(person(cluster), longest)).status, 200);
    assert.deepEqual(await subscribe(person(cluster), `${longest}a`), { status: 400, body: { error: 'endpoint must be a push service URL' } });
  });
});

describe('a subscription stored before the rule', () => {
  const legacy = 'https://push.example.test/stored-before-the-rule';
  const allowed = 'https://fcm.googleapis.com/fcm/send/kept';
  const store = (cluster, device, endpoint, createdAt = '2099-01-01T00:00:00.000Z') => cluster.put(INDEX.push, subscriptionId(endpoint), {
    event_id: EVENT, profile_id: device.profileId, endpoint, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), created_at: createdAt, expires_at: FUTURE,
  });

  test('can still be removed by its owner', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    assert.deepEqual(await unsubscribe(device, legacy), { status: 200, body: { ok: true } });
    assert.equal(cluster.source(INDEX.push, subscriptionId(legacy)), null);
  });

  // pushTargetsFor with console.warn and console.error captured.
  const targetsOf = async (device, options) => {
    const { result: { result: targets, lines: errors }, lines: warns } = await warnings(() => quietly(() => pushTargetsFor(EVENT, [device.profileId], options)));
    return { targets, errors, warns };
  };
  const at = (day, minute) => new Date(Date.UTC(2099, 0, day, 0, minute)).toISOString();

  test('is skipped by pushTargetsFor, so no nudge is sent to it, with one line per receiver that names hosts only', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    store(cluster, device, allowed);
    store(cluster, device, 'https://192.0.2.10/push');
    store(cluster, device, 'https://push.example.test/another');
    const { targets, errors, warns } = await targetsOf(device);
    assert.deepEqual(targets.map((t) => t.subscription?.endpoint), [allowed]);
    assert.equal(warns.length, 1, 'one line for the receiver, not one per row');
    assert.match(warns[0], /^push skipped: endpoint host not allowed: /);
    assert.deepEqual(warns[0].replace(/^push skipped: endpoint host not allowed: | \(.*\)$/g, '').split(', ').sort(), ['192.0.2.10', 'push.example.test']);
    assert.match(warns[0], /\(3 subscriptions of one receiver\)$/);
    assert.deepEqual(errors, []);
    assert.ok(!warns.join('\n').includes('stored-before-the-rule') && !warns.join('\n').includes('another'), 'never a path');
    assert.ok(cluster.source(INDEX.push, subscriptionId(legacy)), 'skipped, not deleted: the purge removes it with the conference');
  });

  test('the skip line names at most five hosts', async () => {
    const { cluster, device } = setup();
    for (let i = 0; i < 7; i++) store(cluster, device, `https://host${i}.example.test/x`);
    const { warns } = await targetsOf(device);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /, and 2 more \(7 subscriptions of one receiver\)$/);
    assert.equal(warns[0].match(/host\d\.example\.test/g).length, 5);
  });

  test('takes none of the ten places a receiver has: off-list rows are dropped before the cut', async () => {
    const { cluster, device } = setup();
    // Three usable subscriptions, then twelve newer rows stored before the rule.
    const good = [0, 1, 2].map((i) => `https://fcm.googleapis.com/fcm/send/older-${i}`);
    good.forEach((e, i) => store(cluster, device, e, at(1, i)));
    for (let i = 0; i < 12; i++) store(cluster, device, `https://push.example.test/newer-${i}`, at(2, i));
    const { targets, errors } = await targetsOf(device);
    assert.deepEqual(targets.map((t) => t.subscription.endpoint), [...good].reverse());
    assert.deepEqual(errors, [], 'not over the cap: only usable rows count toward it');
  });

  test('with more usable targets than places, the newest ten are kept and the cap is logged', async () => {
    const { cluster, device } = setup();
    for (let i = 0; i < 12; i++) store(cluster, device, `https://fcm.googleapis.com/fcm/send/n-${i}`, at(1, i));
    const { targets, errors } = await targetsOf(device);
    assert.equal(targets.length, TARGETS_PER_PROFILE);
    assert.deepEqual(targets.map((t) => t.subscription.endpoint), Array.from({ length: 10 }, (_, i) => `https://fcm.googleapis.com/fcm/send/n-${11 - i}`));
    assert.deepEqual(errors, ['Push targets capped: one receiver has 12, the newest 10 are used']);
  });

  test('a receiver whose read window holds fewer than ten usable targets gets its own log line', async () => {
    const { cluster, device } = setup();
    store(cluster, device, allowed, at(1, 0));
    for (let i = 0; i < TARGETS_READ_PER_PROFILE + 1; i++) store(cluster, device, `https://push.example.test/flood-${i}`, at(2, i));
    const { targets, errors } = await targetsOf(device);
    assert.deepEqual(targets, [], 'the one usable row is older than the window');
    assert.deepEqual(errors, [`Push targets cut short: one receiver has ${TARGETS_READ_PER_PROFILE + 2}, the newest ${TARGETS_READ_PER_PROFILE} were read and 0 of them are used`]);
  });

  test('the caller\'s channel filter applies before the cut, so a target on a channel that is off takes no place', async () => {
    const { cluster, device } = setup();
    const apns = 'ab'.repeat(32);
    cluster.put(INDEX.push, 'reg-apns', { event_id: EVENT, profile_id: device.profileId, platform: 'apns', token: apns, environment: 'production', created_at: at(1, 0), expires_at: FUTURE });
    for (let i = 0; i < 12; i++) store(cluster, device, `https://fcm.googleapis.com/fcm/send/web-${i}`, at(2, i));
    const nativeOnly = await targetsOf(device, { usable: (t) => Boolean(t.native) });
    assert.deepEqual(nativeOnly.targets.map((t) => t.native?.token), [apns], 'Web Push off: the older registration is still a target');
    assert.deepEqual(nativeOnly.errors, []);
    const webOnly = await targetsOf(device, { usable: (t) => !t.native });
    assert.equal(webOnly.targets.length, TARGETS_PER_PROFILE);
    assert.ok(webOnly.targets.every((t) => t.subscription));
  });

  test('a person whose only subscription is off the list is no push target at all', async () => {
    const { cluster, device } = setup();
    store(cluster, device, legacy);
    const { result: { result: targets } } = await warnings(() => quietly(() => pushTargetsFor(EVENT, [device.profileId])));
    assert.deepEqual(targets, []);
  });
});

// Runs the real Web Push transport of nudge.mjs (loadTransport, with web-push 4.0.0 and VAPID keys
// made for this run) with https.request stubbed, and returns the options web-push gave it: what
// would go on the wire. Every stubbed request is answered 201.
async function sendThroughWebPush(endpoints) {
  const mod = await import('web-push');
  const webpush = mod.default ?? mod;
  const vapid = webpush.generateVAPIDKeys();
  const saved = Object.fromEntries(['PUSH_TRANSPORT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].map((k) => [k, process.env[k]]));
  delete process.env.PUSH_TRANSPORT;
  Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.org' });
  const calls = [];
  const original = https.request;
  https.request = (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    req.write = () => true;
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 201;
      res.headers = {};
      onResponse(res);
      setImmediate(() => res.emit('end'));
    };
    return req;
  };
  try {
    const send = await loadTransport();
    for (const endpoint of endpoints) await send({ endpoint, keys: keys() }, '{}', { TTL: 600, urgency: 'normal' });
  } finally {
    https.request = original;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return calls;
}

test('web-push sends to the host the rule checked, on the default port', async () => {
  const calls = await sendThroughWebPush(ACCEPTED);
  assert.equal(calls.length, ACCEPTED.length);
  ACCEPTED.forEach((endpoint, i) => {
    const checked = new URL(endpoint).hostname.toLowerCase();
    assert.equal(calls[i].hostname, checked, endpoint);
    assert.ok(PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('.') ? checked.endsWith(h) : checked === h)), endpoint);
    assert.equal(calls[i].port, '', endpoint);
    assert.equal(calls[i].method, 'POST');
  });
});

test('every Web Push request carries the 10 second timeout', async () => {
  assert.equal(PUSH_TIMEOUT_MS, 10_000);
  const [call] = await sendThroughWebPush(['https://fcm.googleapis.com/fcm/send/timeout-check']);
  assert.equal(call.timeout, PUSH_TIMEOUT_MS);
});
