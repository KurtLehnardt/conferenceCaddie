// Start-up with an unfinished profile delete left by an earlier run of the app. This file runs in
// its own process, so the app modules are imported fresh, after the device state is in place, as
// they are when the app opens. See delete-safety.test.mjs for the rest.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, onFetch, requests } from './env.mjs';

const SLUG = 'testconf-2099';

// What the earlier run left: "Delete my profile" was answered with a 502, so the server copy may
// be hidden but is not deleted, and the device still holds its key.
localStorage.setItem('caddie.device.v1', JSON.stringify({ profile_id: 'p'.repeat(22), secret: 's'.repeat(43) }));
localStorage.setItem('caddie.profile.v1', JSON.stringify({ display_name: 'Sam', about: '', interests: '', expertise: '', linkedin_url: '', contact_note: '', topics: {} }));
localStorage.setItem(`caddie.visibility.v1.${SLUG}`, JSON.stringify({ open_to_meet: true, on_server: true }));
localStorage.setItem(`caddie.delete-pending.v1.${SLUG}`, JSON.stringify({ wipe: true }));
onFetch(() => json(200, { ok: true }));

const storage = await import('../src/people/storage.ts');
const sync = await import('../src/people/sync.ts');

test('An unfinished "Delete my profile" is finished at start-up, and only then clears the device', async () => {
  // Before the retry nothing may write the profile again.
  sync.scheduleProfileSync();
  assert.deepEqual(requests(), []);

  sync.startDeleteRetries();
  assert.equal(await sync.finishPendingDeletes(), true);
  assert.deepEqual(requests(), ['DELETE /api/people/profile']);
  assert.equal(storage.getDeletePending(SLUG), null, 'the mark is gone');
  assert.equal(localStorage.getItem(`caddie.delete-pending.v1.${SLUG}`), null);
  assert.equal(storage.getDevice(), null, 'the device data went once the server confirmed');
  assert.equal(storage.getProfile(), null);
});
