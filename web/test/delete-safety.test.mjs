// Profile deletes on the device (web/src/people/sync.ts), run against a fake fetch.
//
// Run with `npm --prefix web test`. Nothing here reaches the network: env.mjs replaces fetch,
// window, document and localStorage before any app module is imported. The tests check that
// - a delete drops a profile edit still waiting for its debounce, waits for a profile write
//   already sent, and stops new ones, so no write can bring a deleted profile back;
// - the device keeps its data, its key included, until the server has confirmed every delete;
// - a delete that may be partly done stays marked, and while it is marked no profile edit, share
//   or automatic share is sent for that conference;
// - the mark leads to a retry when the app comes back to the foreground and when the connection
//   returns, and goes once the server confirms (delete-retry-launch.test.mjs covers start-up);
// - each kind of failure gets its own message, and a refusal (400, 403, 429) changes nothing.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, deferred, flush, json, onFetch, putAnswer, requests, resetFake, runTimers, timers } from './env.mjs';
import {
  clearAllPeopleData,
  EMPTY_PROFILE,
  ensureDevice,
  getDeletePending,
  getDevice,
  getProfile,
  getVisibility,
  setProfile,
  setVisibility,
} from '../src/people/storage.ts';
import {
  changeVisibility,
  DELETE_PENDING_MESSAGE,
  deleteMyProfile,
  finishPendingDeletes,
  getPendingDeleteDetail,
  onInterestedChanged,
  scheduleProfileSync,
  shareForTalks,
  startDeleteRetries,
} from '../src/people/sync.ts';

const SLUG = 'testconf-2099';
const OTHER = 'otherconf-2099';

/** A device whose profile is on the server for the given conferences. */
function published(...slugs) {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  for (const slug of slugs) setVisibility(slug, { open_to_meet: true, on_server: true });
}

/** Answers DELETE with `status` and every PUT with what it asked for. */
function server(deleteStatus = 200) {
  onFetch((call) => (call.method === 'PUT' ? putAnswer(call) : json(deleteStatus, deleteStatus === 200 ? { ok: true } : { error: 'x' })));
}

function edit(name) {
  setProfile({ ...(getProfile() ?? EMPTY_PROFILE), display_name: name });
  scheduleProfileSync();
}

beforeEach(() => {
  resetFake();
  clearAllPeopleData();
});

/* ---------- Finding 1: a pending save must not bring a deleted profile back ---------- */

test('Delete my profile drops a profile edit still waiting for its debounce', async () => {
  published(SLUG);
  server();
  edit('Sam Q');
  assert.equal(timers.size, 1, 'the edit waits for its debounce');

  assert.equal(await deleteMyProfile(), null);
  assert.equal(timers.size, 0, 'the waiting edit was dropped');
  await runTimers();
  assert.deepEqual(requests(), ['DELETE /api/people/profile'], 'no PUT was sent, before or after the delete');
  assert.equal(getDevice(), null);
  assert.equal(getProfile(), null);
});

test('Delete my profile waits for a profile write already sent, then deletes', async () => {
  published(SLUG);
  const put = deferred();
  onFetch((call) => (call.method === 'PUT' ? put.promise.then(() => putAnswer(call)) : json(200, { ok: true })));
  edit('Sam Q');
  const syncing = runTimers();
  await flush();
  assert.deepEqual(requests(), ['PUT /api/people/profile'], 'the edit is on its way');

  const deleting = deleteMyProfile();
  await flush();
  assert.deepEqual(requests(), ['PUT /api/people/profile'], 'the DELETE waits for the PUT to be answered');
  edit('Sam R');
  assert.equal(timers.size, 0, 'an edit made during the delete is not scheduled');

  put.resolve();
  await syncing;
  assert.equal(await deleting, null);
  assert.deepEqual(requests(), ['PUT /api/people/profile', 'DELETE /api/people/profile'], 'the DELETE is the last word');
  assert.equal(getDevice(), null);
});

test('A profile write never starts while a delete runs, for any conference it covers', async () => {
  published(SLUG, OTHER);
  const del = deferred();
  onFetch((call) => (call.method === 'PUT' ? putAnswer(call) : del.promise.then(() => json(200, { ok: true }))));
  const deleting = deleteMyProfile();
  await flush();
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);

  edit('Sam Q');
  await runTimers();
  const sharing = shareForTalks(SLUG, ['t1']);
  await flush();
  assert.deepEqual(requests(), ['DELETE /api/people/profile'], 'neither the edit nor the share was sent');

  del.resolve();
  assert.equal(await deleting, null);
  // The share waited for the delete, and then found no profile to share.
  assert.equal(await sharing, 'Add your name to your profile first.');
  assert.ok(!requests().includes('PUT /api/people/profile'));
});

test('A profile write that needs a second request does not send it once a delete has started', async () => {
  published(SLUG);
  setProfile({ ...getProfile(), topics: { [SLUG]: { learn: [{ topic_id: 'gone', label: 'Gone' }], speak: [] } } });
  const topics = deferred();
  onFetch((call) => {
    // The server no longer offers the topic, so the write is retried without it.
    if (call.method === 'PUT') return json(400, { error: 'learn_topics contains an unknown topic: gone' });
    if (call.path.startsWith('/api/topics')) return topics.promise.then(() => json(200, { topics: [{ topic_id: 'kept', label: 'Kept' }] }));
    return json(200, { ok: true });
  });
  edit('Sam Q');
  const syncing = runTimers();
  await flush();
  assert.deepEqual(requests(), ['PUT /api/people/profile', 'GET /api/topics']);

  const deleting = deleteMyProfile();
  await flush();
  topics.resolve();
  await syncing;
  assert.equal(await deleting, null);
  assert.deepEqual(requests(), ['PUT /api/people/profile', 'GET /api/topics', 'DELETE /api/people/profile'], 'the second PUT was never sent');
});

test('The device keeps its data and key until the server confirms the delete', async () => {
  published(SLUG);
  server(502);
  const message = await deleteMyProfile();
  assert.match(message, /may be partly deleted/);
  assert.ok(getDevice(), 'the key stays, so the delete can be finished');
  assert.equal(getProfile()?.display_name, 'Sam');
  assert.deepEqual(getDeletePending(SLUG), { wipe: true });
});

/* ---------- Finding 2: an unfinished delete is never undone, and is finished later ---------- */

test('While a delete is unfinished, no edit, share or automatic share is sent', async () => {
  published(SLUG);
  setVisibility(SLUG, { share_new: true });
  server(502);
  await deleteMyProfile();
  calls.length = 0;
  server(200);

  edit('Sam Q');
  assert.equal(timers.size, 0, 'the edit is not scheduled');
  await runTimers();
  assert.equal(await onInterestedChanged(SLUG, ['t1'], true), null, 'marking a talk shares nothing, quietly');
  assert.equal(await shareForTalks(SLUG, ['t2']), DELETE_PENDING_MESSAGE);
  assert.equal(await changeVisibility(SLUG, { open_to_meet: true }), DELETE_PENDING_MESSAGE);
  assert.deepEqual(requests(), [], 'nothing reached the server');
});

test('Turning both choices off: a failed delete is retried when the app is visible again and when back online', async () => {
  startDeleteRetries();
  published(SLUG);
  server(502);
  const message = await changeVisibility(SLUG, { open_to_meet: false });
  assert.match(message, /may already be hidden from others/);
  assert.deepEqual(getDeletePending(SLUG), { wipe: false });
  assert.equal(getVisibility(SLUG).open_to_meet, false, 'the choice applies on the device');
  assert.equal(getVisibility(SLUG).on_server, true, 'the server may still hold the profile');

  // Back to the foreground: tried again, and the server fails again.
  calls.length = 0;
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await finishPendingDeletes(), false);
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);
  assert.deepEqual(getDeletePending(SLUG), { wipe: false });

  // Offline, a return to the foreground sends nothing; the connection coming back does.
  calls.length = 0;
  navigator.onLine = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.deepEqual(requests(), []);
  navigator.onLine = true;
  server(200);
  window.dispatchEvent(new Event('online'));
  assert.equal(await finishPendingDeletes(), true);
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);
  assert.equal(getDeletePending(SLUG), null, 'the mark is gone');
  assert.equal(getVisibility(SLUG).on_server, false);
  assert.ok(getDevice(), 'only this conference was removed; the device keeps its profile');
  assert.equal(getProfile()?.display_name, 'Sam');
});

test('After the unfinished delete is done, profile edits and shares are sent again', async () => {
  published(SLUG, OTHER);
  server(502);
  await changeVisibility(SLUG, { open_to_meet: false });
  calls.length = 0;
  server(200);

  edit('Sam Q');
  await runTimers();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.body?.event ?? ''}`),
    [`PUT ${OTHER}`],
    'the edit reaches the other conference only',
  );

  calls.length = 0;
  assert.equal(await finishPendingDeletes(), true);
  assert.equal(await changeVisibility(SLUG, { open_to_meet: true }), null);
  assert.deepEqual(requests(), ['DELETE /api/people/profile', 'PUT /api/people/profile']);
});

test('The device keeps its key while any conference still holds the profile', async () => {
  published(SLUG, OTHER);
  // The first conference fails part-way; the second refuses before changing anything.
  onFetch((call) => json(call.path.includes(SLUG) ? 502 : 429, { error: 'x' }));
  assert.match(await deleteMyProfile(), /may be partly deleted/);
  assert.deepEqual(getDeletePending(SLUG), { wipe: true });
  assert.equal(getDeletePending(OTHER), null, 'nothing was deleted there, so nothing is unfinished');

  server(200);
  assert.equal(await finishPendingDeletes(), true);
  assert.equal(getDeletePending(SLUG), null);
  assert.equal(getVisibility(OTHER).on_server, true);
  assert.ok(getDevice(), 'the key stays: without it the profile at the other conference could never be deleted');

  // Trying "Delete my profile" again finishes the job.
  assert.equal(await deleteMyProfile(), null);
  assert.equal(getDevice(), null);
});

test('A retry that fails for a known reason says so', async () => {
  published(SLUG);
  server(502);
  await deleteMyProfile();
  assert.equal(getPendingDeleteDetail(), null, 'a 502 needs no extra line');
  server(429);
  assert.equal(await finishPendingDeletes(), false);
  assert.deepEqual(getDeletePending(SLUG), { wipe: true }, 'a refusal after a partial delete keeps the mark');
  assert.match(getPendingDeleteDetail(), /Too many requests/);
});

/* ---------- Findings 3 and 4: accurate messages ---------- */

for (const [status, pattern, pending] of [
  [502, /may be partly deleted.*Try again to finish/, true],
  [503, /may be partly deleted/, true],
  [429, /Too many requests right now, so your profile was not deleted. Wait a minute/, false],
  [403, /not allowed to delete your profile, so it was not deleted/, false],
  [400, /could not handle the request, so your profile was not deleted/, false],
]) {
  test(`Delete my profile, answered ${status}: the message fits`, async () => {
    published(SLUG);
    server(status);
    const message = await deleteMyProfile();
    assert.match(message, pattern);
    if (!pending) assert.doesNotMatch(message, /partly/);
    assert.equal(getDeletePending(SLUG) !== null, pending);
    assert.ok(getDevice(), 'nothing is cleared from the device');
  });
}

test('Delete my profile without a connection: may be partly deleted, and marked', async () => {
  published(SLUG);
  onFetch(() => Promise.reject(new TypeError('Failed to fetch')));
  const message = await deleteMyProfile();
  assert.match(message, /offline. Your profile may be partly deleted/);
  assert.deepEqual(getDeletePending(SLUG), { wipe: true });
});

for (const [status, pattern, pending] of [
  [502, /may already be hidden from others at this conference, but removing it did not finish/, true],
  [429, /Too many requests right now, so nothing changed/, false],
  [403, /not allowed to remove your profile, so nothing changed/, false],
  [400, /could not handle the request, so nothing changed/, false],
]) {
  test(`Turning both choices off, answered ${status}: the message fits`, async () => {
    published(SLUG);
    server(status);
    const message = await changeVisibility(SLUG, { open_to_meet: false });
    assert.match(message, pattern);
    assert.equal(getDeletePending(SLUG) !== null, pending);
    // After a refusal nothing changed on the server, so the switch goes back on.
    assert.equal(getVisibility(SLUG).open_to_meet, !pending);
  });
}
