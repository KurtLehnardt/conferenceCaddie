// Profile deletes on the device (web/src/people/sync.ts), run against a fake fetch.
//
// Run with `npm --prefix web test`. Nothing here reaches the network: env.mjs replaces fetch,
// window, document and localStorage before any app module is imported. The tests check that
// - a delete drops a profile edit still waiting for its debounce, waits for a profile write
//   already sent (for 15 seconds at most), waits for another tab's write lock, and stops new
//   writes, so no write can bring a deleted profile back;
// - an edit held back by a delete that the server refused is sent afterwards;
// - the device keeps its data, its key included, until the server has confirmed every delete;
// - "Delete my profile" stays stored until it is done, so a refusal at one conference is retried
//   too, and while it is stored no edit, share or automatic share goes anywhere;
// - the retries start by themselves when the app comes back to the foreground and when the
//   connection returns (delete-retry-launch.test.mjs covers start-up), wait longer after each
//   failure and as long as Retry-After asks, and run in one tab only;
// - each kind of failure gets its own message, and a refusal (400, 403, 429) changes nothing.
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
  getPush,
  getVisibility,
  newRetry,
  setDeletePending,
  setPresence,
  setProfile,
  setPush,
  setVisibility,
} from '../src/people/storage.ts';
import {
  canStopTrying,
  changeVisibility,
  DELETE_PENDING_MESSAGE,
  DELETED_HERE_MESSAGE,
  DELETED_MESSAGE,
  DELETED_NO_KEY_MESSAGE,
  deleteMyProfile,
  finishPendingDeletes,
  getPendingDeleteDetail,
  getSyncStatus,
  hasUnfinishedDelete,
  onInterestedChanged,
  registerRuntimeReset,
  scheduleProfileSync,
  shareForTalks,
  startDeleteRetries,
  stopTrying,
} from '../src/people/sync.ts';

const SLUG = 'testconf-2099';
const OTHER = 'otherconf-2099';
const DELETE = 'DELETE /api/people/profile';
const PUT = 'PUT /api/people/profile';
const HOUR = 60 * 60_000;

/** A device whose profile is on the server for the given conferences. */
function published(...slugs) {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  for (const slug of slugs) setVisibility(slug, { open_to_meet: true, on_server: true });
}

/** The API's own error body for a status: its 403 is `forbidden`, as for a wrong device key. */
function apiError(status) {
  return { error: status === 403 ? 'forbidden' : status === 429 ? 'Too many requests' : 'x' };
}

/** Answers DELETE with `status` and every PUT with what it asked for. */
function server(deleteStatus = 200) {
  onFetch((call) => (call.method === 'PUT' ? putAnswer(call) : json(deleteStatus, deleteStatus === 200 ? { ok: true } : apiError(deleteStatus))));
}

function edit(name) {
  setProfile({ ...(getProfile() ?? EMPTY_PROFILE), display_name: name });
  scheduleProfileSync();
}

/** Moves the clock on, as if the app had been away for that long. */
function later(t, ms) {
  const now = Date.now() + ms;
  t.mock.method(Date, 'now', () => now);
}

function foreground() {
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  resetFake();
  clearAllPeopleData();
});

/* ---------- No write may bring a deleted profile back ---------- */

test('Delete my profile drops a profile edit still waiting for its debounce', async () => {
  published(SLUG);
  server();
  edit('Sam Q');
  assert.equal(debounces(), 1, 'the edit waits for its debounce');

  assert.deepEqual(await deleteMyProfile(), { done: true, message: DELETED_MESSAGE });
  assert.equal(debounces(), 0, 'the waiting edit was dropped');
  await runTimers();
  assert.deepEqual(requests(), [DELETE], 'no PUT was sent, before or after the delete');
  assert.equal(getDevice(), null);
  assert.equal(getProfile(), null);
  assert.equal(getDeleteAll(), null, 'the stored request went with the device data');
});

test('Delete my profile waits for a profile write already sent, then deletes', async () => {
  published(SLUG);
  const put = deferred();
  onFetch((call) => (call.method === 'PUT' ? put.promise.then(() => putAnswer(call)) : json(200, { ok: true })));
  edit('Sam Q');
  const syncing = runTimers();
  await flush();
  assert.deepEqual(requests(), [PUT], 'the edit is on its way');

  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), [PUT], 'the DELETE waits for the PUT to be answered');
  edit('Sam R');
  assert.equal(debounces(), 0, 'an edit made during the delete is not scheduled');

  put.resolve();
  await syncing;
  assert.equal((await deleting).done, true);
  assert.deepEqual(requests(), [PUT, DELETE], 'the DELETE is the last word');
  assert.equal(getDevice(), null);
});

test('A write that never answers holds the delete back for 15 seconds only; the delete then runs again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  published(SLUG);
  const put = deferred();
  onFetch((call) => (call.method === 'PUT' ? put.promise.then(() => putAnswer(call)) : json(200, { ok: true })));
  edit('Sam Q');
  const syncing = runTimers();
  await flush();
  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), [PUT]);

  t.mock.timers.tick(15_000);
  await settle();
  assert.deepEqual(requests(), [PUT, DELETE], 'the DELETE went after 15 seconds');
  const result = await deleting;
  assert.equal(result.done, false);
  assert.match(result.message, /deletes it once more/);
  assert.ok(getDeletePending(SLUG), 'the PUT may still land, so the delete stays unconfirmed');
  assert.ok(getDevice(), 'and the key stays for the next attempt');

  put.resolve();
  await syncing;
  assert.equal(await finishPendingDeletes(), true);
  assert.deepEqual(requests(), [PUT, DELETE, DELETE]);
  assert.equal(getDevice(), null);
});

test('A profile write never starts while a delete runs, for any conference it covers', async () => {
  published(SLUG, OTHER);
  const del = deferred();
  onFetch((call) => (call.method === 'PUT' ? putAnswer(call) : del.promise.then(() => json(200, { ok: true }))));
  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), [DELETE]);

  edit('Sam Q');
  await runTimers();
  const sharing = shareForTalks(SLUG, ['t1']);
  await settle();
  assert.deepEqual(requests(), [DELETE], 'neither the edit nor the share was sent');

  del.resolve();
  assert.equal((await deleting).done, true);
  // The share waited for the delete, and then found no profile to share.
  assert.equal(await sharing, 'Add your name to your profile first.');
  assert.ok(!requests().includes(PUT));
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
  assert.deepEqual(requests(), [PUT, 'GET /api/topics']);

  const deleting = deleteMyProfile();
  await flush();
  topics.resolve();
  await syncing;
  assert.equal((await deleting).done, true);
  assert.deepEqual(requests(), [PUT, 'GET /api/topics', DELETE], 'the second PUT was never sent');
});

test('Another tab holding the write lock delays the delete until it lets go', async () => {
  const locks = installLocks();
  published(SLUG);
  server(200);
  const release = await locks.hold('caddie-people-writes');
  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), [], 'nothing is sent while the other tab writes');
  release();
  assert.equal((await deleting).done, true);
  assert.deepEqual(requests(), [DELETE]);
});

test('A lock held for too long: after 15 seconds the delete goes anyway and is repeated later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const locks = installLocks();
  published(SLUG);
  server(200);
  const release = await locks.hold('caddie-people-writes');
  const deleting = deleteMyProfile();
  await settle();
  assert.deepEqual(requests(), []);
  t.mock.timers.tick(15_000);
  const result = await deleting;
  assert.deepEqual(requests(), [DELETE]);
  assert.equal(result.done, false, 'another tab may have been writing, so the device keeps its key');
  assert.ok(getDeletePending(SLUG));
  release();
  assert.equal(await finishPendingDeletes(), true);
  assert.equal(getDevice(), null);
});

test('A delete the server refuses lets the profile edit it held back go out afterwards', async () => {
  published(SLUG, OTHER);
  onFetch((call) => (call.method === 'PUT' ? putAnswer(call) : json(429, { error: 'Too many requests' })));
  edit('Sam Q');
  assert.equal(debounces(), 1);
  assert.match(await changeVisibility(SLUG, { open_to_meet: false }), /so nothing changed/);
  assert.equal(debounces(), 1, 'the edit was scheduled again once the delete was over');
  await runTimers();
  assert.deepEqual(
    calls.filter((c) => c.method === 'PUT').map((c) => c.body.event).sort(),
    [OTHER, SLUG].sort(),
    'the edit reached both conferences, the refused one included',
  );
});

test('Turning sharing off waits for a visibility write in flight, and writes instead of deleting when that write made the profile visible', async () => {
  published(SLUG);
  setVisibility(SLUG, { open_to_meet: false, shared_talk_ids: ['t1'] });
  const put = deferred();
  onFetch((call) => (call.method === 'PUT' ? put.promise.then(() => putAnswer(call)) : json(200, { ok: true })));
  const turningOn = changeVisibility(SLUG, { open_to_meet: true });
  await flush();
  const unsharing = changeVisibility(SLUG, { shared_talk_ids: [] });
  await settle();
  assert.deepEqual(requests(), [PUT]);

  put.resolve();
  assert.equal(await turningOn, null);
  assert.equal(await unsharing, null);
  assert.deepEqual(requests(), [PUT, PUT], 'no DELETE: the profile is visible conference-wide');
  assert.equal(getVisibility(SLUG).open_to_meet, true);
  assert.deepEqual(getVisibility(SLUG).shared_talk_ids, []);
});

test('A first share whose answer is lost counts as maybe on the server, and Delete my profile covers it', async () => {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  onFetch((call) => (call.method === 'PUT' ? Promise.reject(new TypeError('Failed to fetch')) : json(200, { ok: true })));
  assert.match(await changeVisibility(SLUG, { open_to_meet: true }), /offline/);
  assert.equal(getVisibility(SLUG).on_server, false);
  assert.equal(getVisibility(SLUG).maybe_on_server, true);

  calls.length = 0;
  assert.equal((await deleteMyProfile()).done, true);
  assert.deepEqual(requests(), [DELETE]);
});

test('A refused share after a lost first write keeps the conference covered by Delete my profile', async () => {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  onFetch(() => Promise.reject(new TypeError('Failed to fetch')));
  await changeVisibility(SLUG, { open_to_meet: true });
  assert.equal(getVisibility(SLUG).maybe_on_server, true);
  // The second try is refused; that says nothing about whether the first one landed.
  onFetch((call) => (call.method === 'PUT' ? json(429, { error: 'Too many requests' }) : json(200, { ok: true })));
  await changeVisibility(SLUG, { open_to_meet: true });
  assert.equal(getVisibility(SLUG).maybe_on_server, true);
  calls.length = 0;
  assert.equal((await deleteMyProfile()).done, true);
  assert.deepEqual(requests(), [DELETE]);
});

test('A first share the server refuses leaves nothing to delete', async () => {
  ensureDevice();
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  onFetch(() => json(400, { error: 'conference is not available' }));
  assert.equal(await changeVisibility(SLUG, { open_to_meet: true }), 'Sharing is not open for this conference.');
  assert.equal(getVisibility(SLUG).maybe_on_server, false);
  calls.length = 0;
  assert.equal((await deleteMyProfile()).done, true);
  assert.deepEqual(requests(), []);
});

test('A confirmed delete ends presence and push for its conference, and the final wipe stops the in-memory state first', async () => {
  published(SLUG);
  const until = new Date(Date.now() + HOUR).toISOString();
  setPresence(SLUG, { on: true, zone: 'Expo hall', until });
  setPush(SLUG, { on: true, endpoint: 'https://push.example/endpoint' });
  server(200);
  assert.equal(await changeVisibility(SLUG, { open_to_meet: false }), null);
  assert.equal(getPresence(SLUG).on, false, 'the server ended presence with the document');
  assert.equal(getPush(SLUG).on, false, 'and deleted the push subscription');

  published(SLUG);
  let storedWhenReset = null;
  registerRuntimeReset(async () => {
    storedWhenReset = getDevice() !== null;
  });
  assert.equal((await deleteMyProfile()).done, true);
  registerRuntimeReset(async () => undefined);
  assert.equal(storedWhenReset, true, 'the runtime reset ran, before the stored data went');
  assert.equal(getDevice(), null);
});

/* ---------- The device keeps what it needs until the server has confirmed ---------- */

test('The device keeps its data and key until the server confirms the delete', async () => {
  published(SLUG);
  server(502);
  const result = await deleteMyProfile();
  assert.equal(result.done, false);
  assert.match(result.message, /may be partly deleted/);
  assert.ok(getDevice(), 'the key stays, so the delete can be finished');
  assert.equal(getProfile()?.display_name, 'Sam');
  assert.ok(getDeletePending(SLUG));
  assert.ok(getDeleteAll(), '"Delete my profile" stays stored');
});

test('The device keeps its key while any conference still holds the profile', async () => {
  published(SLUG, OTHER);
  // The first conference fails part-way; the second refuses the key, now and on the retry.
  onFetch((call) => (call.path.includes(SLUG) ? json(502, { error: 'x' }) : json(403, { error: 'forbidden' })));
  await deleteMyProfile();
  onFetch((call) => (call.path.includes(SLUG) ? json(200, { ok: true }) : json(403, { error: 'forbidden' })));
  assert.equal(await finishPendingDeletes(), false);
  assert.equal(getDeletePending(SLUG), null, 'the first conference is done');
  assert.equal(getVisibility(OTHER).on_server, true);
  assert.ok(getDevice(), 'the key stays: without it the profile at the other conference could never be deleted');
});

test('Without the device key nothing can be deleted from here: the device is cleared and says so', async () => {
  setProfile({ ...EMPTY_PROFILE, display_name: 'Sam' });
  setVisibility(SLUG, { open_to_meet: true, on_server: true });
  setDeletePending(SLUG, newRetry());
  assert.deepEqual(await deleteMyProfile(), { done: true, message: DELETED_NO_KEY_MESSAGE });
  assert.match(DELETED_NO_KEY_MESSAGE, /may stay visible to other attendees until the conference ends/);
  assert.deepEqual(requests(), []);
  assert.equal(hasUnfinishedDelete(), false);
  assert.equal(getProfile(), null);
});

test('A 404 is a failure, from the API or from anything in between: the API answers 200 for a missing profile', async () => {
  for (const answer of [() => json(404, { error: 'Not found' }), () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })]) {
    clearAllPeopleData();
    published(SLUG);
    onFetch(answer);
    const result = await deleteMyProfile();
    assert.equal(result.done, false);
    assert.match(result.message, /could not handle the request/);
    assert.ok(getDevice(), 'the key stays');
    assert.ok(getDeleteAll(), 'and the delete is retried');
  }
});

/* ---------- Unfinished deletes: nothing is undone, and they finish by themselves ---------- */

test('While "Delete my profile" is unfinished, no edit, share or automatic share goes anywhere', async () => {
  published(SLUG, OTHER);
  setVisibility(SLUG, { share_new: true });
  setVisibility(OTHER, { share_new: true });
  // One conference fails part-way, the other refuses; neither may be written to now.
  onFetch((call) => json(call.path.includes(SLUG) ? 502 : 429, { error: 'x' }));
  await deleteMyProfile();
  calls.length = 0;
  server(200);

  edit('Sam Q');
  assert.equal(debounces(), 0, 'the edit is not scheduled');
  for (const slug of [SLUG, OTHER]) {
    assert.equal(await onInterestedChanged(slug, ['t1'], true), null, 'marking a talk shares nothing, quietly');
    assert.equal(await shareForTalks(slug, ['t2']), DELETE_PENDING_MESSAGE);
    assert.equal(await changeVisibility(slug, { open_to_meet: true }), DELETE_PENDING_MESSAGE);
  }
  assert.deepEqual(requests(), [], 'nothing reached the server');
});

test('A 502 at one conference and a 429 at the other: the background retry alone finishes both', async (t) => {
  startDeleteRetries();
  published(SLUG, OTHER);
  onFetch((call) => json(call.path.includes(SLUG) ? 502 : 429, { error: 'x' }));
  const result = await deleteMyProfile();
  assert.equal(result.done, false);
  assert.equal(getDeletePending(OTHER), null, 'nothing was deleted at the second one');

  // Back to the foreground before the wait is over: nothing is sent.
  calls.length = 0;
  foreground();
  await settle();
  assert.deepEqual(requests(), []);

  // An hour later the server answers again. The return to the foreground starts the retry.
  server(200);
  later(t, HOUR);
  foreground();
  await flush();
  assert.ok(requests().includes(DELETE), 'the retry started by itself');
  await settle();
  assert.deepEqual(
    calls.map((c) => new URL(c.path, 'http://x').searchParams.get('event')).sort(),
    [OTHER, SLUG].sort(),
    'both conferences, the refused one included',
  );
  assert.equal(getDevice(), null, 'then the device was cleared');
  assert.equal(hasUnfinishedDelete(), false);
});

test('Turning both choices off: a failed delete is retried when the app is visible again and when back online', async (t) => {
  startDeleteRetries();
  published(SLUG);
  server(502);
  const message = await changeVisibility(SLUG, { open_to_meet: false });
  assert.match(message, /may already be hidden from others/);
  assert.ok(getDeletePending(SLUG));
  assert.equal(getVisibility(SLUG).open_to_meet, false, 'the choice applies on the device');
  assert.equal(getVisibility(SLUG).on_server, true, 'the server may still hold the profile');

  // Back to the foreground once the wait is over: tried again by itself, and the server fails again.
  calls.length = 0;
  later(t, HOUR);
  foreground();
  await flush();
  assert.deepEqual(requests(), [DELETE], 'the retry started by itself');
  await settle();
  assert.ok(getDeletePending(SLUG));

  // Offline, a return to the foreground sends nothing; the connection coming back does.
  calls.length = 0;
  later(t, 2 * HOUR);
  navigator.onLine = false;
  foreground();
  await settle();
  assert.deepEqual(requests(), []);
  navigator.onLine = true;
  server(200);
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.deepEqual(requests(), [DELETE], 'the retry started by itself');
  await settle();
  assert.equal(getDeletePending(SLUG), null, 'the mark is gone');
  assert.equal(getVisibility(SLUG).on_server, false);
  assert.ok(getDevice(), 'only this conference was removed; the device keeps its profile');
  assert.equal(getProfile()?.display_name, 'Sam');
});

test('A retry waits longer after each failure, and at least as long as Retry-After asks', async () => {
  startDeleteRetries();
  published(SLUG);
  server(502);
  await changeVisibility(SLUG, { open_to_meet: false });
  const first = getDeletePending(SLUG);
  assert.equal(first.attempts, 1);
  assert.ok(first.next_at >= Date.now() + 29_000);

  onFetch(() => json(429, { error: 'Too many requests' }, { 'Retry-After': '600' }));
  await finishPendingDeletes();
  const second = getDeletePending(SLUG);
  assert.equal(second.attempts, 2);
  assert.ok(second.next_at >= Date.now() + 599_000);

  calls.length = 0;
  foreground();
  await settle();
  assert.deepEqual(requests(), [], 'a return to the foreground before then sends nothing');
});

test('Only one tab retries: while another holds the retry lock, a return to the foreground sends nothing', async (t) => {
  startDeleteRetries();
  const locks = installLocks();
  published(SLUG);
  server(502);
  await changeVisibility(SLUG, { open_to_meet: false });
  calls.length = 0;
  server(200);
  later(t, HOUR);
  const release = await locks.hold('caddie-people-delete-retry');
  foreground();
  await settle();
  assert.deepEqual(requests(), []);
  release();
  await flush();
  foreground();
  await settle();
  assert.deepEqual(requests(), [DELETE]);
  assert.equal(getDeletePending(SLUG), null);
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
  assert.deepEqual(requests(), [DELETE, PUT]);
});

test('A mark another tab removed while a retry was on its way is not written back', async () => {
  published(SLUG);
  server(502);
  await changeVisibility(SLUG, { open_to_meet: false });
  const del = deferred();
  onFetch(() => del.promise.then(() => json(502, { error: 'x' })));
  const retry = finishPendingDeletes();
  await settle();
  // The other tab finished the delete and removed the mark.
  localStorage.removeItem(`caddie.delete-pending.v1.${SLUG}`);
  del.resolve();
  await retry;
  assert.equal(getDeletePending(SLUG), null);
});

test('After three refusals of the device key in a row, the user may stop trying', async () => {
  published(SLUG);
  server(403);
  await deleteMyProfile();
  await finishPendingDeletes();
  assert.equal(canStopTrying(), false);
  await finishPendingDeletes();
  assert.equal(canStopTrying(), true);
  assert.match(getPendingDeleteDetail(), /not allowed/);
  assert.equal(await stopTrying(), DELETED_HERE_MESSAGE);
  assert.match(DELETED_HERE_MESSAGE, /may stay visible to other attendees until the conference ends, and this phone can no longer delete it/);
  assert.equal(getDevice(), null);
  assert.equal(hasUnfinishedDelete(), false);
});

test('An automatic share queued behind "Delete my profile" ends quietly', async () => {
  published(SLUG);
  setVisibility(SLUG, { share_new: true });
  server(200);
  const sharing = onInterestedChanged(SLUG, ['t1'], true);
  const deleting = deleteMyProfile();
  assert.equal((await deleting).done, true);
  assert.equal(await sharing, null, 'no "Add your name" message for a share nobody asked for any more');
  assert.ok(!requests().includes(PUT));
});

test('The save status does not stay on "Saving" when nothing is left to send', async () => {
  published(SLUG);
  edit('Sam Q');
  assert.equal(getSyncStatus().state, 'saving');
  setDeletePending(SLUG, newRetry());
  edit('Sam R');
  assert.equal(getSyncStatus().state, 'idle');
});

/* ---------- Accurate messages ---------- */

test('A retry that fails for a known reason says so, without claiming nothing was deleted', async () => {
  published(SLUG);
  server(502);
  await deleteMyProfile();
  assert.equal(getPendingDeleteDetail(), null, 'a 502 needs no extra line');
  server(429);
  assert.equal(await finishPendingDeletes(), false);
  assert.ok(getDeletePending(SLUG), 'a refusal after a partial delete keeps the mark');
  assert.match(getPendingDeleteDetail(), /Too many requests/);
  const result = await deleteMyProfile();
  assert.match(result.message, /has not finished. It may be partly deleted/);
  assert.doesNotMatch(result.message, /not deleted/);
});

for (const [status, pattern, pending] of [
  [502, /may be partly deleted.*Try again to finish/, true],
  [503, /may be partly deleted/, true],
  [429, /Too many requests right now, so your profile was not deleted yet. Wait a minute/, false],
  [403, /not allowed to delete your profile, so it was not deleted/, false],
  [400, /could not handle the request, so your profile was not deleted yet/, false],
  [404, /could not handle the request, so your profile was not deleted yet/, false],
]) {
  test(`Delete my profile, answered ${status}: the message fits`, async () => {
    published(SLUG);
    server(status);
    const result = await deleteMyProfile();
    assert.equal(result.done, false);
    assert.match(result.message, pattern);
    if (!pending) assert.doesNotMatch(result.message, /partly/);
    assert.equal(getDeletePending(SLUG) !== null, pending);
    assert.ok(getDeleteAll(), 'the request stays stored and is retried');
    assert.ok(getDevice(), 'nothing is cleared from the device');
  });
}

test('Delete my profile without a connection: may be partly deleted, and marked', async () => {
  published(SLUG);
  onFetch(() => Promise.reject(new TypeError('Failed to fetch')));
  const result = await deleteMyProfile();
  assert.match(result.message, /offline. Your profile may be partly deleted/);
  assert.ok(getDeletePending(SLUG));
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
