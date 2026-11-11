// When the welcome guide opens by itself (web/src/guide/state.ts), and the steps it walks through.
//
// Run with `npm --prefix web test`. The dialogs need a browser and are covered by the phone check;
// what runs here is the decision: first visit, finished, skipped, already onboarded, and storage
// that throws. Whatever storage does, the guide must never open twice in one page load.
import './env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFake } from './env.mjs';
import { GUIDE_KEY, claimAutoGuide, claimReplay, isOnboarded, markGuide, readGuideOutcome, resetGuideClaim } from '../src/guide/state.ts';
import { GUIDE_STEPS } from '../src/guide/steps.ts';

const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

/** A storage whose reads, writes or both throw, as a browser with blocked site data does. */
function brokenStorage({ read = true, write = true } = {}) {
  const items = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(key) {
        if (read) throw new DOMException('The operation is insecure.', 'SecurityError');
        return items.has(key) ? items.get(key) : null;
      },
      setItem(key, value) {
        if (write) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        items.set(key, String(value));
      },
    },
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', realStorage);
  resetFake();
  resetGuideClaim();
});

const profile = (over = {}) => ({ display_name: '', interests: '', expertise: '', topics: {}, ...over });

test('a first visit shows the guide, once per page load', () => {
  assert.equal(readGuideOutcome(), null);
  assert.equal(claimAutoGuide(false), true);
  // A second check in the same page load, with nothing saved yet, says no.
  assert.equal(claimAutoGuide(false), false);
});

test('a finished guide is remembered and does not show again', () => {
  markGuide('done');
  assert.equal(readGuideOutcome(), 'done');
  assert.ok(localStorage.getItem(GUIDE_KEY));
  resetGuideClaim(); // a new page load
  assert.equal(claimAutoGuide(false), false);
});

test('a skipped guide is remembered and does not show again', () => {
  markGuide('skipped');
  assert.equal(readGuideOutcome(), 'skipped');
  resetGuideClaim();
  assert.equal(claimAutoGuide(false), false);
});

test('any value under the key counts as seen, even one this version does not understand', () => {
  localStorage.setItem(GUIDE_KEY, 'not json');
  assert.equal(readGuideOutcome(), 'done');
  assert.equal(claimAutoGuide(false), false);
});

test('a device that already has a profile or topics is onboarded: no guide, nothing written', () => {
  assert.equal(claimAutoGuide(true), false);
  assert.equal(localStorage.getItem(GUIDE_KEY), null);
  assert.equal(isOnboarded(null, 0), false);
  assert.equal(isOnboarded(profile(), 0), false);
  assert.equal(isOnboarded(profile({ display_name: 'Sam' }), 0), true);
  assert.equal(isOnboarded(profile({ interests: 'getting Postgres failover under a minute' }), 0), true);
  assert.equal(isOnboarded(profile({ expertise: 'ran Postgres operators' }), 0), true);
  assert.equal(isOnboarded(profile({ topics: { a: { learn: [], speak: [] } } }), 0), false);
  assert.equal(isOnboarded(profile({ topics: { a: { learn: [{ topic_id: 'x' }], speak: [] } } }), 0), true);
  assert.equal(isOnboarded(profile({ topics: { a: { learn: [], speak: [{ topic_id: 'x' }] } } }), 0), true);
  // Talks already marked on this device also mean someone who has used the app.
  assert.equal(isOnboarded(null, 3), true);
});

test('storage that throws on read: shown once per page load, never in a loop', () => {
  brokenStorage({ read: true, write: true });
  assert.equal(readGuideOutcome(), undefined);
  assert.equal(claimAutoGuide(false), true);
  assert.equal(claimAutoGuide(false), false);
  assert.equal(claimAutoGuide(false), false);
  // Finishing cannot be saved, and must not throw or bring the guide back.
  assert.doesNotThrow(() => markGuide('done'));
  assert.equal(claimAutoGuide(false), false);
});

test('storage that reads but cannot write: finishing does not throw and the guide stays done for the page load', () => {
  brokenStorage({ read: false, write: true });
  assert.equal(claimAutoGuide(false), true);
  assert.doesNotThrow(() => markGuide('skipped'));
  assert.equal(readGuideOutcome(), null);
  assert.equal(claimAutoGuide(false), false);
});

test('a replay is allowed whatever was saved, and does not open the guide a second time on its own', () => {
  markGuide('done');
  resetGuideClaim();
  claimReplay();
  assert.equal(claimAutoGuide(false), false);
});

test('the guide walks through the real screens, with no raw ids', () => {
  assert.ok(GUIDE_STEPS.length >= 5 && GUIDE_STEPS.length <= 7);
  assert.equal(new Set(GUIDE_STEPS.map((s) => s.id)).size, GUIDE_STEPS.length);
  const tabs = ['people', 'for-you', 'search', 'interested', 'profile', 'settings'];
  for (const s of GUIDE_STEPS) {
    assert.ok(tabs.includes(s.tab), `${s.id} shows a real screen`);
    assert.ok(s.title.length > 0 && s.body.length > 0);
    assert.ok(!/[0-9a-f]{16}|\b[A-Za-z0-9_-]{22}\b/.test(s.title + s.body), `${s.id} has no raw id`);
  }
  assert.equal(GUIDE_STEPS[0].tab, 'people');
  assert.equal(GUIDE_STEPS.at(-1).tab, 'settings');
  assert.equal(GUIDE_STEPS.at(-1).position, 'top');
});
