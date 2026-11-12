import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyWindowSkip } from '../scripts/lib/smoke-primary-over.mjs';

test('emptyWindowSkip skips only when the Worker and the data both say empty', () => {
  assert.equal(emptyWindowSkip(0, 0), true);
  assert.equal(emptyWindowSkip(0, 2), false);
  assert.equal(emptyWindowSkip(3, 0), false);
});
