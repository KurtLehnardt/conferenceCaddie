// The quiet push re-sync at app start (web/src/people/push.ts, resyncPush): once per page load, only
// when notification permission is granted, the nudge switch is On and the browser holds a
// subscription. Each case imports its own copy of the modules (the query), because the function
// runs once per load.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, json, onFetch, resetFake, requests, settle } from './env.mjs';

const SLUG = 'testconf-2099';
const ENDPOINT = 'https://jmt17.google.com/fcm/send/abc';
const KEYS = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };

let n = 0;
function browser({ permission = 'granted', subscription = { endpoint: ENDPOINT, keys: KEYS } } = {}) {
  window.PushManager = class {};
  window.Notification = globalThis.Notification = { permission };
  navigator.serviceWorker = {
    getRegistration: async () => ({ pushManager: { getSubscription: async () => (subscription ? { toJSON: () => subscription } : null) } }),
  };
}

function device() {
  localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'p'.repeat(22), secret: 's'.repeat(43) }));
}

function switchOn(endpoint = ENDPOINT) {
  localStorage.setItem(`caddie.push.v1.${SLUG}`, JSON.stringify({ on: true, endpoint, notice_seen: true }));
}

async function fresh() {
  n++;
  return import(`../src/people/push.ts?case${n}`);
}

beforeEach(() => {
  resetFake();
  device();
});

test('with permission granted, the switch On and a subscription, one PUT restores the row, once per load', async () => {
  browser();
  switchOn();
  const push = await fresh();
  await push.resyncPush();
  await push.resyncPush();
  await settle();
  assert.deepEqual(requests(), ['PUT /api/push/subscription']);
  assert.deepEqual(calls[0].body, { event: SLUG, subscription: { endpoint: ENDPOINT, keys: KEYS } });
});

test('a rotated browser endpoint is sent and remembered', async () => {
  browser();
  switchOn('https://fcm.googleapis.com/fcm/send/old');
  const push = await fresh();
  await push.resyncPush();
  await settle();
  assert.equal(calls[0].body.subscription.endpoint, ENDPOINT);
  assert.equal(JSON.parse(localStorage.getItem(`caddie.push.v1.${SLUG}`)).endpoint, ENDPOINT);
});

test('nothing is sent when permission is not granted', async () => {
  for (const permission of ['default', 'denied']) {
    browser({ permission });
    switchOn();
    const push = await fresh();
    await push.resyncPush();
    await settle();
    assert.deepEqual(requests(), [], permission);
  }
});

test('nothing is sent when the switch is Off', async () => {
  browser();
  const push = await fresh();
  await push.resyncPush();
  await settle();
  assert.deepEqual(requests(), []);
});

test('nothing is sent when the browser holds no subscription, and it never subscribes', async () => {
  browser({ subscription: null });
  switchOn();
  const push = await fresh();
  await push.resyncPush();
  await settle();
  assert.deepEqual(requests(), []);
});

test('a refused or failed PUT leaves the switch as it is and does not throw', async () => {
  browser();
  switchOn();
  onFetch(() => json(403, { error: 'profile_required' }));
  const push = await fresh();
  await push.resyncPush();
  await settle();
  assert.equal(JSON.parse(localStorage.getItem(`caddie.push.v1.${SLUG}`)).on, true);
});
