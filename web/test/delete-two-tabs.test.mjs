// Two tabs of the app on one device: tab A is web/src as imported normally, tab B a second copy
// of the same modules (imported with `?tab=b`, see loader.mjs), with its own in-memory state. They
// share localStorage, fetch and Web Locks, as tabs do. No storage events are sent between them, so
// tab B's in-memory copies stay as old as they can get: the writes below must hold up without them.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, installLocks, json, onFetch, putAnswer, requests, resetFake, runTimers, settle } from './env.mjs';

const A = await import('../src/people/sync.ts');
const B = await import('../src/people/sync.ts?tab=b');
const As = await import('../src/people/storage.ts');
const Bs = await import('../src/people/storage.ts?tab=b');

const SLUG = 'testconf-2099';
const VIS_KEY = `caddie.visibility.v1.${SLUG}`;

/** A profile on the server, as both tabs have read it. */
function publishedInBothTabs() {
  As.ensureDevice();
  As.setProfile({ ...As.EMPTY_PROFILE, display_name: 'Sam' });
  As.setVisibility(SLUG, { open_to_meet: true, on_server: true });
  // Tab B reads the same state now and keeps it in memory from here on.
  assert.equal(Bs.getVisibility(SLUG).on_server, true);
  assert.ok(Bs.getDevice());
  assert.equal(Bs.getProfile()?.display_name, 'Sam');
}

function editInTabB(name) {
  Bs.setProfile({ ...Bs.getProfile(), display_name: name });
  B.scheduleProfileSync();
}

beforeEach(() => {
  resetFake();
  As.clearAllPeopleData();
  // Both tabs start from storage, as a freshly opened tab does: a storage event with no key (all
  // storage cleared) drops every in-memory copy.
  window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
  onFetch((c) => (c.method === 'PUT' ? putAnswer(c) : json(200, { ok: true })));
});

test('Tab A turns visibility off while the lock is busy: tab B finds the mark and sends nothing', async () => {
  const locks = installLocks();
  publishedInBothTabs();
  // Something (a third tab) holds the write lock for a moment.
  const release = await locks.hold('caddie-people-writes');
  const off = A.changeVisibility(SLUG, { open_to_meet: false });
  await settle();
  editInTabB('Sam Q');
  const syncing = runTimers();
  await settle();
  release();
  assert.equal(await off, null);
  await syncing;
  await settle();
  assert.deepEqual(requests(), ['DELETE /api/people/profile'], 'no PUT from tab B, before or after the delete');
  assert.equal(As.getVisibility(SLUG).on_server, false);
});

test('Tab B queued a write before tab A turned visibility off: the write is dropped under the lock', async () => {
  const locks = installLocks();
  publishedInBothTabs();
  const release = await locks.hold('caddie-people-writes');
  // Tab B passes its checks first and waits for the lock.
  editInTabB('Sam Q');
  const syncing = runTimers();
  await settle();
  // Then tab A turns visibility off; it marks the conference before it waits for the lock.
  const off = A.changeVisibility(SLUG, { open_to_meet: false });
  await settle();
  release();
  assert.equal(await off, null);
  await syncing;
  await settle();
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);
});

test('A write waiting for the lock reads the visibility from storage, not from its tab', async () => {
  const locks = installLocks();
  publishedInBothTabs();
  const release = await locks.hold('caddie-people-writes');
  editInTabB('Sam Q');
  const syncing = runTimers();
  await settle();
  // Meanwhile the profile was removed at this conference in another tab and its mark is gone
  // (for example a tab whose wait for the lock ran out), so only storage knows it is off now.
  localStorage.setItem(VIS_KEY, JSON.stringify({ open_to_meet: false, shared_talk_ids: [], on_server: false }));
  assert.equal(Bs.getVisibility(SLUG).on_server, true, "tab B's own copy is out of date");
  release();
  await syncing;
  await settle();
  assert.deepEqual(requests(), [], 'nothing was sent: the profile stays removed');
});

test('After tab A turned visibility off, an edit in tab B with an out-of-date copy sends nothing', async () => {
  publishedInBothTabs();
  assert.equal(await A.changeVisibility(SLUG, { open_to_meet: false }), null);
  assert.equal(Bs.getVisibility(SLUG).on_server, true, "tab B's own copy is out of date");
  calls.length = 0;
  editInTabB('Sam Q');
  await runTimers();
  await settle();
  assert.deepEqual(requests(), []);
});

test('Tab B queued a write before tab A started "Delete my profile": nothing is written back', async () => {
  const locks = installLocks();
  publishedInBothTabs();
  const release = await locks.hold('caddie-people-writes');
  editInTabB('Sam Q');
  const syncing = runTimers();
  await settle();
  const deleting = A.deleteMyProfile();
  await settle();
  release();
  assert.equal((await deleting).done, true);
  await syncing;
  await settle();
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);
  assert.equal(localStorage.getItem('caddie.device.v1'), null);
});

test('Tab A replaced the device key: tab B drops its write instead of sending it under the old key', async () => {
  publishedInBothTabs();
  localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'q'.repeat(22), secret: 't'.repeat(43) }));
  editInTabB('Sam Q');
  await runTimers();
  await settle();
  assert.deepEqual(requests(), []);
});

test('Turning visibility off in a tab whose copy predates the profile still deletes it', async () => {
  // Tab B read the conference before the profile was made visible in tab A.
  assert.equal(Bs.getVisibility(SLUG).on_server, false);
  As.ensureDevice();
  As.setProfile({ ...As.EMPTY_PROFILE, display_name: 'Sam' });
  As.setVisibility(SLUG, { open_to_meet: true, on_server: true });
  assert.equal(await B.changeVisibility(SLUG, { open_to_meet: false }), null);
  assert.deepEqual(requests(), ['DELETE /api/people/profile'], 'tab B read the stored state, so the server copy went');
});

test('A visibility write waiting for the lock sends the choices stored when it gets the lock', async () => {
  const locks = installLocks();
  publishedInBothTabs();
  const release = await locks.hold('caddie-people-writes');
  const sharing = B.changeVisibility(SLUG, { shared_talk_ids: ['t1'] });
  await settle();
  // Meanwhile another tab turned conference-wide visibility off and kept the profile for a talk.
  localStorage.setItem(VIS_KEY, JSON.stringify({ open_to_meet: false, shared_talk_ids: ['t9'], on_server: true }));
  release();
  assert.equal(await sharing, null);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.open_to_meet, false, "the other tab's choice is not undone");
  assert.deepEqual(put.body.shared_talk_ids, ['t1']);
});
