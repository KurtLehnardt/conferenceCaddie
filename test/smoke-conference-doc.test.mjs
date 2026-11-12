import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conferenceForWorker } from '../scripts/lib/smoke-conference-doc.mjs';

test('conferenceForWorker drops unretire and expect_status and keeps the rest, without mutating', () => {
  const doc = { slug: 'a', status: 'available', unretire: true, expect_status: 'available', name: 'A' };
  assert.deepEqual(conferenceForWorker(doc), { slug: 'a', status: 'available', name: 'A' });
  assert.equal(doc.unretire, true);
});
