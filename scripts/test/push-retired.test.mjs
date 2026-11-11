// worker/ingest/push-ingest.mjs and the Worker's tombstones (W7.7, W8): PUT /admin/conferences
// answers the slugs it skipped because the operator removed them (skipped_retired), and the push
// logs each one by name, so an operator sees why a conference did not come back. A recording
// stand-in for the admin routes; no network, no Worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertConferences } from '../../worker/ingest/push-ingest.mjs';

// A stand-in for the admin routes that records every call and answers PUT /admin/conferences with
// `answer`.
function fakeAdmin(answer) {
  const calls = [];
  const admin = async (method, url, body) => {
    calls.push({ method, url, body });
    return answer;
  };
  return { admin, calls };
}

const docs = [{ slug: 'kept-fixture-2099', status: 'searchable' }, { slug: 'gone-fixture-2099', status: 'searchable' }, { slug: 'also-gone-2099', status: 'unavailable' }];

test('each slug the Worker skipped as retired is logged by name and returned', async () => {
  const { admin, calls } = fakeAdmin({ upserted: 1, searchable: 1, synced: 1, skipped_retired: ['gone-fixture-2099', 'also-gone-2099'] });
  const lines = [];
  const skipped = await upsertConferences(admin, docs, (l) => lines.push(l));
  assert.deepEqual(calls, [{ method: 'PUT', url: '/admin/conferences', body: { conferences: docs } }]);
  assert.deepEqual(skipped, ['gone-fixture-2099', 'also-gone-2099']);
  assert.equal(lines[0], 'Conferences upserted: 1.');
  assert.equal(lines.length, 3);
  for (const slug of skipped) {
    const line = lines.find((l) => l.startsWith(`${slug}: skipped`));
    assert.ok(line, `no line for ${slug}`);
    assert.match(line, /removed/);
    assert.ok(line.includes(`conferences unretire --event ${slug}`), line);
  }
  assert.ok(!lines.some((l) => l.startsWith('kept-fixture-2099')), 'a stored conference is not reported as skipped');
});

test('an answer without skipped_retired (a Worker from before tombstones) skips nothing and logs only the count', async () => {
  for (const answer of [{ upserted: 3, searchable: 2, synced: 2 }, { upserted: 3, skipped_retired: [] }, { upserted: 3, skipped_retired: null }]) {
    const lines = [];
    assert.deepEqual(await upsertConferences(fakeAdmin(answer).admin, docs, (l) => lines.push(l)), []);
    assert.deepEqual(lines, ['Conferences upserted: 3.']);
  }
});

test('only well-formed slugs are logged or returned, each once', async () => {
  const lines = [];
  const skipped = await upsertConferences(
    fakeAdmin({ upserted: 0, skipped_retired: ['gone-fixture-2099', 'gone-fixture-2099', 'Bad Slug', 'x\nFAKE LOG LINE', '../etc', 42, null, { slug: 'y' }] }).admin,
    docs,
    (l) => lines.push(l),
  );
  assert.deepEqual(skipped, ['gone-fixture-2099']);
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.includes('FAKE LOG LINE') || l.includes('Bad Slug') || l.includes('../etc')));
});
