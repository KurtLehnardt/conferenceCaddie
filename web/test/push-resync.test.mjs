// The quiet push re-sync at app start (web/src/people/push.ts, resyncPush): per conference, at most
// once a day unless the browser's endpoint changed, only when notification permission is granted,
// the nudge switch is On and the browser holds a subscription. Each case imports its own copy of
// push.ts (the query), because the function runs once per load; the loader passes the query on, so
// each copy has its own storage module too, which a case reaches through `storage()`.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, json, onFetch, resetFake, requests, settle } from './env.mjs';

const SLUG = 'testconf-2099';
const OTHER = 'otherconf-2099';
const ENDPOINT = 'https://jmt17.google.com/fcm/send/abc';
const KEYS = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };
const DAY = 24 * 60 * 60 * 1000;
const PUT = 'PUT /api/push/subscription';
const DELETE = 'DELETE /api/push/subscription';
// Skips the random wait before the first PUT.
const NOW = { spreadMs: 0 };

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

function switchOn(slug = SLUG, { endpoint = ENDPOINT, synced_at = null } = {}) {
  localStorage.setItem(`caddie.push.v1.${slug}`, JSON.stringify({ on: true, endpoint, notice_seen: true, synced_at }));
}

function stored(slug = SLUG) {
  return JSON.parse(localStorage.getItem(`caddie.push.v1.${slug}`));
}

async function fresh() {
  n++;
  return import(`../src/people/push.ts?case${n}`);
}

/** The storage module that the latest fresh() copy of push.ts uses. */
function storage() {
  return import(`../src/people/storage.ts?case${n}`);
}

beforeEach(() => {
  resetFake();
  device();
});

test('with permission granted, the switch On and a subscription, one PUT restores the row, once per load', async () => {
  browser();
  switchOn();
  const push = await fresh();
  await push.resyncPush(NOW);
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
  assert.deepEqual(calls[0].body, { event: SLUG, subscription: { endpoint: ENDPOINT, keys: KEYS } });
  assert.ok(Math.abs(stored().synced_at - Date.now()) < 5000, 'the time of the send is remembered');
});

test('a conference synced in the last 24 hours with the same endpoint is not sent again', async () => {
  browser();
  switchOn(SLUG, { synced_at: Date.now() - DAY + 60_000 });
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), []);
});

test('a conference last synced more than 24 hours ago is sent again', async () => {
  browser();
  switchOn(SLUG, { synced_at: Date.now() - DAY - 60_000 });
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
  assert.ok(stored().synced_at > Date.now() - 5000);
});

test('a sync time in the future (a clock set back) does not hold the send back', async () => {
  browser();
  switchOn(SLUG, { synced_at: Date.now() + 10 * DAY });
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
});

test('a rotated browser endpoint is sent at once, even right after a sync, and remembered', async () => {
  browser();
  switchOn(SLUG, { endpoint: 'https://fcm.googleapis.com/fcm/send/old', synced_at: Date.now() - 1000 });
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
  assert.equal(calls[0].body.subscription.endpoint, ENDPOINT);
  assert.equal(stored().endpoint, ENDPOINT);
  assert.equal(stored().on, true, 'the switch stays On after the endpoint changed');
});

test('every conference whose switch is On is sent, each one only if it is due', async () => {
  browser();
  switchOn(SLUG);
  switchOn(OTHER, { synced_at: Date.now() - 1000 });
  switchOn('thirdconf-2099');
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT, PUT]);
  assert.deepEqual(calls.map((c) => c.body.event).sort(), [SLUG, 'thirdconf-2099']);
});

test('the first PUT waits a random time of at most the spread', async () => {
  browser();
  switchOn();
  const realSetTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    waits.push(ms);
    return realSetTimeout(fn, 0, ...rest);
  };
  try {
    const push = await fresh();
    await push.resyncPush({ spreadMs: 30_000 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 0 && waits[0] <= 30_000);
  assert.deepEqual(requests(), [PUT]);
});

test('nothing is waited for, or sent, when no conference is due', async () => {
  browser();
  switchOn(SLUG, { synced_at: Date.now() - 1000 });
  const realSetTimeout = globalThis.setTimeout;
  let waited = 0;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    waited++;
    return realSetTimeout(fn, ms, ...rest);
  };
  try {
    const push = await fresh();
    await push.resyncPush();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(waited, 0);
  assert.deepEqual(requests(), []);
});

test('nothing is sent when permission is not granted', async () => {
  for (const permission of ['default', 'denied']) {
    browser({ permission });
    switchOn();
    const push = await fresh();
    await push.resyncPush(NOW);
    await settle();
    assert.deepEqual(requests(), [], permission);
  }
});

test('nothing is sent when the switch is Off', async () => {
  browser();
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), []);
});

test('nothing is sent when the browser holds no subscription, and it never subscribes', async () => {
  browser({ subscription: null });
  switchOn();
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), []);
});

test('an unfinished profile delete (deleteCovers) stops the PUT before it is sent', async () => {
  browser();
  switchOn();
  localStorage.setItem(`caddie.delete-pending.v1.${SLUG}`, JSON.stringify({ attempts: 0, next_at: 0, forbidden: 0, last: null, since: Date.now() }));
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), []);
  assert.equal(stored().on, true, 'the switch is left as it is');
});

test('a failed PUT (server error) leaves the switch On, is not remembered as a sync, and does not throw', async () => {
  browser();
  switchOn();
  onFetch(() => json(500, { error: 'People are temporarily unavailable' }));
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
  assert.equal(stored().on, true);
  assert.equal(stored().synced_at, null, 'a failed send is not remembered as a sync');
});

test('403 profile_required: the PUT was sent, then that conference stops re-syncing and the switch goes Off', async () => {
  browser();
  switchOn();
  onFetch(() => json(403, { error: 'profile_required' }));
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT]);
  assert.equal(stored().on, false);
  assert.equal(stored().endpoint, null);
  // The next load finds no switch On, so it sends nothing.
  calls.length = 0;
  const next = await fresh();
  await next.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), []);
});

test('400 conference has ended, and 400 conference is not available: the switch goes Off', async () => {
  for (const error of ['conference has ended', 'conference is not available']) {
    calls.length = 0;
    browser();
    switchOn();
    onFetch(() => json(400, { error }));
    const push = await fresh();
    await push.resyncPush(NOW);
    await settle();
    assert.deepEqual(requests(), [PUT], error);
    assert.equal(stored().on, false, error);
  }
});

test('a refusal for one conference does not stop the others', async () => {
  browser();
  switchOn(SLUG);
  switchOn(OTHER);
  onFetch((call) => (call.body.event === SLUG ? json(400, { error: 'conference has ended' }) : json(200, { ok: true })));
  const push = await fresh();
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT, PUT]);
  assert.equal(stored(SLUG).on, false);
  assert.equal(stored(OTHER).on, true);
  assert.ok(stored(OTHER).synced_at > 0);
});

test('a switch turned Off after the slug list was read gets no PUT', async () => {
  browser();
  switchOn(SLUG);
  switchOn(OTHER);
  // The first PUT is in flight when the person turns the other conference Off.
  const push = await fresh();
  const { setPush } = await storage();
  onFetch((call) => {
    if (call.method === 'PUT') setPush(call.body.event === SLUG ? OTHER : SLUG, { on: false, endpoint: null });
    return json(200, { ok: true });
  });
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT], 'only one PUT; the conference turned Off was skipped');
  const skipped = calls[0].body.event === SLUG ? OTHER : SLUG;
  assert.equal(stored(skipped).on, false);
  assert.equal(stored(skipped).endpoint, null);
});

test('a switch turned Off while its own PUT is in flight: the row is deleted again and the state stays Off', async () => {
  browser();
  switchOn();
  const push = await fresh();
  const { setPush } = await storage();
  onFetch((call) => {
    if (call.method === 'PUT') setPush(SLUG, { on: false, endpoint: null });
    return json(200, { ok: true });
  });
  await push.resyncPush(NOW);
  await settle();
  assert.deepEqual(requests(), [PUT, DELETE]);
  assert.deepEqual(calls[1].body, { event: SLUG, endpoint: ENDPOINT });
  assert.equal(stored().on, false);
  assert.equal(stored().endpoint, null, 'no endpoint is written into the Off state');
});
