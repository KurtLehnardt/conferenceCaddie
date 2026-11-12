import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryOver, emptyWindowSkip } from '../scripts/lib/smoke-primary-over.mjs';

const now = Date.parse('2026-11-12T23:00:00Z');
test('primaryOver is true only when talks exist and every one has ended', () => {
  assert.equal(primaryOver([{ end: '2026-11-12T22:59:59Z' }, { end: '2026-11-12T23:00:00Z' }], now), true, 'end == now has ended');
  assert.equal(primaryOver([{ end: '2026-11-12T22:00:00Z' }, { end: '2026-11-12T23:00:01Z' }], now), false);
  assert.equal(primaryOver([], now), false, 'no data: the check runs');
});
test('emptyWindowSkip skips only when the Worker and the data both say empty', () => {
  assert.equal(emptyWindowSkip(0, 0), true);
  assert.equal(emptyWindowSkip(0, 2), false);
  assert.equal(emptyWindowSkip(3, 0), false);
});
