// The second review of the device's profile deletes (web/src/people/sync.ts, api.ts, storage.ts).
// These tests check that
// - presence, Bluetooth, push and asks stop when a delete starts and stay refused until it is done;
// - only the API's own 403 `forbidden` counts as a refused device key, and a 404 is a failure;
// - "Stop trying" is offered after three refused keys, five failures of any kind or a day, with
//   copy that says what stays on the server;
// - a request that never answers times out, a save gives up waiting for the lock, and neither
//   leaves the app stuck;
// - saves take the write lock, a removed or replaced device key stops a save, the retry timer
//   retries by itself, and a stored retry time or Retry-After cannot stop the retries.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calls,
  debounces,
  deferred,
  flush,
  installLocks,
  json,
  onFetch,
  putAnswer,
  requests,
  resetFake,
  runRetryTimer,
  runTimers,
  settle,
} from './env.mjs';
import {
  clearAllPeopleData,
  EMPTY_PROFILE,
  ensureDevice,
  getDeleteAll,
  getDeletePending,
  getDevice,
  getPresence,
  getProfile,
  getVisibility,
  setPresence,
  setProfile,
  setVisibility,
} from '../src/people/storage.ts';
import { PeopleApiError, putPresence, putPresenceBle, putPushSubscription, requestMeet, rotateBleToken } from '../src/people/api.ts';
import {
  changeVisibility,
  deleteMyProfile,
  finishPendingDeletes,
  getPendingDeleteDetail,
  getSyncStatus,
  registerRuntimeStop,
  scheduleProfileSync,
  startDeleteRetries,
  stopTryingReason,
} from '../src/people/sync.ts';

const SLUG = 'testconf-2099';
const OTHER = 'otherconf-2099';
const DELETE = 'DELETE /api/people/profile';
const HOUR = 60 * 60_000;

function published(...slugs) {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  for (const slug of slugs) setVisibility(slug, { open_to_meet: true, on_server: true });
}

function edit(name) {
  setProfile({ ...(getProfile() ?? EMPTY_PROFILE), display_name: name });
  scheduleProfileSync();
}

function later(t, ms) {
  const now = Date.now() + ms;
  t.mock.method(Date, 'now', () => now);
}

const proxy403 = () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });

beforeEach(() => {
  resetFake();
  clearAllPeopleData();
  registerRuntimeStop(async () => undefined);
});

/* ---------- Presence, Bluetooth, push and asks ---------- */

test('Delete my profile stops presence and Bluetooth before its first request, and ends presence on the server', async () => {
  published(SLUG);
  setPresence(SLUG, { on: true, zone: 'Expo hall', until: new Date(Date.now() + HOUR).toISOString() });
  const stops = [];
  registerRuntimeStop(async (slug) => void stops.push(slug));
  onFetch(() => json(200, { ok: true }));
  assert.equal((await deleteMyProfile()).done, true);
  assert.deepEqual(stops, [null], 'Bluetooth, every presence timer and the position watch stopped');
  assert.deepEqual(requests(), ['DELETE /api/presence', DELETE], 'presence ends first; a DELETE can create nothing');
});

test('Turning both choices off stops Bluetooth for that conference and ends its presence first', async () => {
  published(SLUG);
  setPresence(SLUG, { on: true, zone: 'Expo hall', until: new Date(Date.now() + HOUR).toISOString() });
  const stops = [];
  registerRuntimeStop(async (slug) => void stops.push(slug));
  onFetch(() => json(502, { error: 'x' }));
  await changeVisibility(SLUG, { open_to_meet: false });
  assert.deepEqual(stops, [SLUG]);
  assert.deepEqual(requests(), ['DELETE /api/presence', DELETE]);
  assert.equal(getPresence(SLUG).on, false, 'presence is off on the device even though the delete failed');
});

test('A refused delete that changed nothing says that presence was turned off, only when it was on', async () => {
  for (const presenceOn of [true, false]) {
    clearAllPeopleData();
    published(SLUG);
    if (presenceOn) setPresence(SLUG, { on: true, zone: 'Expo hall', until: new Date(Date.now() + HOUR).toISOString() });
    onFetch(() => json(429, { error: 'Too many requests' }));
    const message = await changeVisibility(SLUG, { open_to_meet: false });
    assert.match(message, /^Too many requests right now, so nothing changed\./);
    assert.equal(getVisibility(SLUG).open_to_meet, true, 'the switch stays on');
    assert.equal(getDeletePending(SLUG), null, 'nothing is left to retry');
    if (presenceOn) assert.match(message, /Your presence was turned off\. You can turn it on again\.$/);
    else assert.doesNotMatch(message, /presence/);
  }
});

test('A refused "Delete my profile" says that presence is off until the delete is done', async () => {
  published(SLUG);
  setPresence(SLUG, { on: true, zone: 'Expo hall', until: new Date(Date.now() + HOUR).toISOString() });
  onFetch((call) => (call.path.startsWith('/api/presence') ? json(200, { ok: true }) : json(429, { error: 'Too many requests' })));
  const result = await deleteMyProfile();
  assert.match(result.message, /^Too many requests right now, so your profile was not deleted yet\..*Your presence was turned off until the delete is done\.$/);
  assert.equal(getPresence(SLUG).on, false);
});

test('While a delete is unfinished, presence, Bluetooth, push and asks are refused without a request', async () => {
  published(SLUG);
  onFetch(() => json(502, { error: 'x' }));
  await deleteMyProfile();
  calls.length = 0;
  const attempts = [
    putPresence(SLUG, 'Expo hall', ''),
    putPresenceBle(SLUG, 'Expo hall', '', true),
    rotateBleToken(SLUG),
    putPushSubscription(SLUG, { endpoint: 'https://push.example/e', keys: { p256dh: 'p', auth: 'a' } }),
    requestMeet(SLUG, 'ref-1', null, 'Hi'),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, (err) => err instanceof PeopleApiError && err.status === 403 && err.code === 'delete_pending' && /has not finished/.test(err.message));
  }
  assert.deepEqual(requests(), []);
});

/* ---------- What counts as what ---------- */

test('A 403 that is not the API\'s own (a proxy page) is not a refused key: no "Stop trying" after three', async () => {
  published(SLUG);
  onFetch(proxy403);
  const result = await deleteMyProfile();
  assert.match(result.message, /may be partly deleted/);
  await finishPendingDeletes();
  await finishPendingDeletes();
  assert.equal(getDeleteAll().forbidden, 0);
  assert.equal(stopTryingReason(), null);
  assert.equal(getPendingDeleteDetail(), null, 'no "not allowed" line');
});

test('The count of refused keys starts again after any other failure', async () => {
  published(SLUG);
  onFetch(() => json(403, { error: 'forbidden' }));
  await deleteMyProfile();
  await finishPendingDeletes();
  assert.equal(getDeleteAll().forbidden, 2);
  onFetch(() => json(502, { error: 'x' }));
  await finishPendingDeletes();
  assert.equal(getDeleteAll().forbidden, 0);
  onFetch(() => json(403, { error: 'forbidden' }));
  await finishPendingDeletes();
  assert.equal(getDeleteAll().forbidden, 1);
  assert.equal(stopTryingReason(), null, 'not three in a row, and only four attempts');
});

test('"Stop trying" is offered after five failures of any kind', async () => {
  published(SLUG);
  onFetch(() => json(400, { error: 'event must be a conference slug' }));
  await deleteMyProfile();
  for (let i = 0; i < 3; i++) await finishPendingDeletes();
  assert.equal(stopTryingReason(), null);
  await finishPendingDeletes();
  assert.equal(stopTryingReason(), 'failing');
  assert.ok(getDevice(), 'the device keeps its key until the user stops');
});

test('"Stop trying" is offered after a day of trying', async (t) => {
  published(SLUG);
  onFetch(() => json(502, { error: 'x' }));
  await deleteMyProfile();
  assert.equal(stopTryingReason(), null);
  later(t, 25 * HOUR);
  assert.equal(stopTryingReason(), 'failing');
});

test('A refusal after other conferences were deleted says the delete has not finished, not that nothing was deleted', async () => {
  published(SLUG, OTHER);
  onFetch((call) => (call.path.includes(SLUG) ? json(200, { ok: true }) : json(429, { error: 'Too many requests' })));
  const result = await deleteMyProfile();
  assert.match(result.message, /^Too many requests right now, so deleting your profile has not finished\. Wait a minute/);
  assert.doesNotMatch(result.message, /not deleted|partly/);
  assert.equal(getVisibility(SLUG).open_to_meet, false, 'the switch at the deleted conference is off');
  assert.deepEqual(getVisibility(SLUG).shared_talk_ids, []);
});

/* ---------- Nothing hangs ---------- */

test('A delete that never answers times out after 20 seconds, and an edit for another conference then goes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installLocks();
  published(SLUG, OTHER);
  const never = deferred();
  onFetch((call) => (call.method === 'DELETE' ? never.promise : putAnswer(call)));
  const off = changeVisibility(SLUG, { open_to_meet: false });
  await settle();
  assert.deepEqual(requests(), [DELETE]);
  setProfile({ ...getProfile(), display_name: 'Sam Q' });
  scheduleProfileSync(OTHER);
  const syncing = runTimers();
  await settle();
  assert.deepEqual(requests(), [DELETE], 'the edit waits for the lock the delete holds');

  t.mock.timers.tick(20_000);
  const message = await off;
  assert.match(message, /may already be hidden from others at this conference, but removing it did not finish/);
  assert.ok(getDeletePending(SLUG), 'a delete without an answer stays unfinished');
  await syncing;
  await settle();
  assert.deepEqual(
    calls.map((c) => (c.body ? `${c.method} ${c.body.event}` : c.method)),
    ['DELETE', `PUT ${OTHER}`],
    'the edit reached the other conference once the delete gave up',
  );
  assert.equal(getSyncStatus().state, 'saved');
});

test('A delete whose answer stops halfway also times out after 20 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  published(SLUG);
  // The headers arrive, then the body stops after a few bytes; only the request's signal ends it.
  onFetch(
    (call) =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"ok":'));
            call.signal?.addEventListener('abort', () => stream.error(new DOMException('The operation was aborted.', 'AbortError')));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), [DELETE]);
  t.mock.timers.tick(20_000);
  const result = await deleting;
  assert.equal(result.done, false);
  assert.match(result.message, /may be partly deleted/);
  assert.ok(getDeleteAll(), 'the delete is tried again');
  assert.ok(getDevice(), 'and the device keeps its key');
});

test('A save gives up waiting for the lock after 25 seconds with a message to try again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const locks = installLocks();
  published(SLUG);
  onFetch((call) => putAnswer(call));
  await locks.hold('caddie-people-writes');
  edit('Sam Q');
  const syncing = runTimers();
  await settle();
  assert.equal(getSyncStatus().state, 'saving');
  t.mock.timers.tick(25_000);
  await syncing;
  assert.deepEqual(requests(), []);
  assert.equal(getSyncStatus().state, 'error');
  assert.match(getSyncStatus().message, /had to wait too long.*Try again/);
});

/* ---------- Saves, keys and the retry timer ---------- */

test('A save takes the write lock: it waits while another tab writes', async () => {
  const locks = installLocks();
  published(SLUG);
  onFetch((call) => putAnswer(call));
  const release = await locks.hold('caddie-people-writes');
  edit('Sam Q');
  const syncing = runTimers();
  await settle();
  assert.deepEqual(requests(), []);
  release();
  await syncing;
  assert.deepEqual(requests(), ['PUT /api/people/profile']);
});

test('A save stops when another tab removed the device key, or replaced it', async () => {
  for (const change of [
    () => localStorage.removeItem('caddie.device.v1'),
    () => localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'q'.repeat(22), secret: 't'.repeat(43) })),
  ]) {
    clearAllPeopleData();
    calls.length = 0;
    published(SLUG);
    onFetch((call) => putAnswer(call));
    edit('Sam Q');
    change();
    await runTimers();
    await settle();
    assert.deepEqual(requests(), []);
  }
});

test('The retry timer retries by itself once the wait is over', async (t) => {
  startDeleteRetries();
  published(SLUG);
  onFetch(() => json(502, { error: 'x' }));
  await changeVisibility(SLUG, { open_to_meet: false });
  calls.length = 0;
  onFetch(() => json(200, { ok: true }));
  later(t, HOUR);
  runRetryTimer();
  await flush();
  assert.deepEqual(requests(), [DELETE], 'the timer started the retry');
  await settle();
  assert.equal(getDeletePending(SLUG), null);
});

test('A huge Retry-After waits an hour at most, and a corrupt stored retry time is brought back to an hour', async () => {
  published(SLUG);
  onFetch(() => json(429, { error: 'Too many requests' }, { 'Retry-After': '999999' }));
  await deleteMyProfile();
  // As written, before the clamp that applies when it is read back.
  const stored = JSON.parse(localStorage.getItem('caddie.delete-all.v1'));
  assert.ok(stored.next_at <= Date.now() + HOUR + 1000);
  assert.ok(getDeleteAll().next_at <= Date.now() + HOUR + 1000);

  localStorage.setItem(`caddie.delete-pending.v1.${OTHER}`, JSON.stringify({ attempts: 1, next_at: 1e15, forbidden: 0, last: 'partial', since: 1 }));
  assert.ok(getDeletePending(OTHER).next_at <= Date.now() + HOUR + 1000);
});

test('Nothing from a delete leaves the save status on "Saving"', async () => {
  published(SLUG);
  onFetch(() => json(502, { error: 'x' }));
  edit('Sam Q');
  assert.equal(debounces(), 1);
  await deleteMyProfile();
  assert.notEqual(getSyncStatus().state, 'saving');
});
