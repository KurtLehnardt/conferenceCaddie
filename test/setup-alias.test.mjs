// The alias decision of the setup scripts (scripts/lib/alias.mjs).
//
// Run with `npm test`. A setup script given a development index name used to point the live
// aliases (caddie-people, caddie-people-blocks, caddie-people-meets, caddie-talks, ...) at it.
// These tests check that the default alias is used only for the default index or <alias>-v<N>,
// that an explicit --alias always wins, and that "" still means no alias.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAlias, isVersionOf } from '../scripts/lib/alias.mjs';

const people = { defaultIndex: 'caddie-people-v2', defaultAlias: 'caddie-people' };

test('the default index and <alias>-v<N> get the default alias', () => {
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-people-v2' }), { alias: 'caddie-people', hint: '' });
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-people-v3' }), { alias: 'caddie-people', hint: '' });
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-people-v12' }), { alias: 'caddie-people', hint: '' });
  assert.equal(chooseAlias({ index: 'caddie-talks-v3', defaultIndex: 'caddie-talks-v3', defaultAlias: 'caddie-talks' }).alias, 'caddie-talks');
  assert.equal(chooseAlias({ index: 'caddie-people-rules-v2', defaultIndex: 'caddie-people-rules-v1', defaultAlias: 'caddie-people-rules' }).alias, 'caddie-people-rules');
});

test('any other index name gets no alias and a hint', () => {
  for (const index of ['caddie-dev-x', 'caddie-people-dev', 'caddie-people-v2-test', 'caddie-people-vx', 'caddie-people-blocks-v1', 'caddie-talks-v3']) {
    const { alias, hint } = chooseAlias({ ...people, index });
    assert.equal(alias, '', index);
    assert.match(hint, /--alias caddie-people/, index);
    assert.ok(hint.includes(index), index);
  }
});

test('an explicit alias always wins, and "" means none', () => {
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-dev-x', explicit: 'caddie-people' }), { alias: 'caddie-people', hint: '' });
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-dev-x', explicit: 'caddie-dev-alias' }), { alias: 'caddie-dev-alias', hint: '' });
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-people-v2', explicit: '' }), { alias: '', hint: '' });
  assert.deepEqual(chooseAlias({ ...people, index: 'caddie-people-v3', explicit: '' }), { alias: '', hint: '' });
});

test('isVersionOf matches only <alias>-v<digits>', () => {
  assert.ok(isVersionOf('caddie-people-v1', 'caddie-people'));
  assert.ok(!isVersionOf('caddie-people-blocks-v1', 'caddie-people'));
  assert.ok(!isVersionOf('xcaddie-people-v1', 'caddie-people'));
  assert.ok(!isVersionOf('caddie-people-v1x', 'caddie-people'));
  // The alias is matched literally: "." in a name is not a wildcard.
  assert.ok(!isVersionOf('caddie-aXb-v1', 'caddie-a.b'));
  assert.ok(isVersionOf('caddie-a.b-v1', 'caddie-a.b'));
});
