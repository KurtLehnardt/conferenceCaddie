// The Worker's topic list must keep the builder's order after a re-ingest. The fake admin below
// stands in for the Worker's PUT and GET /admin/topics routes and orders rows the way the Worker's
// store does (ORDER BY rank, label_exact), which is also the order GET /api/topics serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFrozen, buildTopics, compareTopics, loadStoplist, resolveTopics } from '../ingest/topics-local.mjs';

const SLUG = 'order-test-2026';
const stop = loadStoplist();

// Filler words are unique per title, so only the marker words reach three talks.
let fillerCount = 0;
const filler = () => `filler${++fillerCount}x`;
function talksWith(markers) {
  fillerCount = 0;
  const talks = [];
  for (const [word, n] of Object.entries(markers)) {
    for (let i = 0; i < n; i++) talks.push({ talk_id: `t-${word}-${i}`, kind: 'talk', title: `${word} ${filler()}` });
  }
  return talks;
}

function fakeWorker() {
  let rows = [];
  const admin = async (method, path, body) => {
    assert.ok(path.includes(`event=${SLUG}`));
    if (method === 'GET') {
      return { topics: [...rows].sort((a, b) => a.rank - b.rank || a.label_exact.localeCompare(b.label_exact)).map((t) => ({ ...t })) };
    }
    assert.equal(method, 'PUT');
    rows = body.topics.map((t) => ({ ...t }));
    return { topics: rows.length };
  };
  const served = () => [...rows].sort((a, b) => a.rank - b.rank).map((t) => t.topic_id);
  return { admin, served };
}

async function ingest(worker, talks) {
  const result = await resolveTopics(talks, { slug: SLUG, admin: worker.admin, stop });
  await worker.admin('PUT', `/admin/topics?event=${SLUG}`, { topics: result.topics });
  return result;
}

const builderOrder = (talks) => buildTopics(talks, { slug: SLUG, stop }).topics.map((t) => t.topic_id);

test('a re-ingest after count changes serves the topics in the builder order', async () => {
  const worker = fakeWorker();
  const first = await ingest(worker, talksWith({ alpha: 5, beta: 4, gamma: 3 }));
  assert.equal(first.mode, 'built');
  assert.deepEqual(worker.served(), ['alpha', 'beta', 'gamma']);

  // gamma overtakes both; the stored ranks were alpha 1, beta 2, gamma 3.
  const changed = talksWith({ alpha: 5, beta: 4, gamma: 7 });
  const second = await ingest(worker, changed);
  assert.equal(second.mode, 'frozen');
  assert.deepEqual(worker.served(), builderOrder(changed));
  assert.deepEqual(worker.served(), ['gamma', 'alpha', 'beta']);

  const stored = (await worker.admin('GET', `/admin/topics?event=${SLUG}`)).topics;
  assert.deepEqual(stored.map((t) => t.rank), [1, 2, 3]);
  assert.deepEqual(stored.map((t) => t.talk_count), [7, 5, 4]);
});

test('ties in count are ordered by label, as the builder does, and ranks stay unique', async () => {
  const worker = fakeWorker();
  await ingest(worker, talksWith({ alpha: 6, beta: 4, gamma: 3 }));
  const changed = talksWith({ alpha: 3, beta: 4, gamma: 4 });
  await ingest(worker, changed);
  assert.deepEqual(worker.served(), builderOrder(changed));
  assert.deepEqual(worker.served(), ['beta', 'gamma', 'alpha']);
});

test('topic ids, labels and aliases stay as stored, and a topic that loses all talks goes last', async () => {
  const worker = fakeWorker();
  await ingest(worker, talksWith({ alpha: 5, beta: 4, gamma: 3 }));
  const before = (await worker.admin('GET', `/admin/topics?event=${SLUG}`)).topics;
  await ingest(worker, talksWith({ beta: 4, gamma: 3, delta: 2 }));
  const after = (await worker.admin('GET', `/admin/topics?event=${SLUG}`)).topics;
  assert.deepEqual(after.map((t) => t.topic_id), ['beta', 'gamma', 'alpha']);
  assert.deepEqual(after.map((t) => t.talk_count), [4, 3, 0]);
  assert.deepEqual(after.map((t) => t.rank), [1, 2, 3]);
  for (const t of after) {
    const old = before.find((b) => b.topic_id === t.topic_id);
    assert.equal(t.label, old.label);
    assert.deepEqual(t.aliases, old.aliases);
  }
});

test('each talk lists its topic ids in the new rank order', () => {
  const talks = [
    { talk_id: 'a', title: 'alpha gamma filler1x' },
    { talk_id: 'b', title: 'gamma filler2x' },
  ];
  const frozen = [
    { topic_id: 'alpha', label: 'alpha', label_exact: 'alpha', aliases: [], rank: 1 },
    { topic_id: 'gamma', label: 'gamma', label_exact: 'gamma', aliases: [], rank: 2 },
  ];
  const { topics, assignments } = assignFrozen(talks, frozen, { slug: SLUG, stop });
  assert.deepEqual(topics.map((t) => [t.topic_id, t.rank, t.talk_count]), [['gamma', 1, 2], ['alpha', 2, 1]]);
  assert.deepEqual(assignments.get('a'), ['gamma', 'alpha']);
  assert.deepEqual(assignments.get('b'), ['gamma']);
});

test('compareTopics is the order buildTopics sorts by', () => {
  const talks = talksWith({ alpha: 5, beta: 5, gamma: 3 });
  const { topics } = buildTopics(talks, { slug: SLUG, stop });
  assert.deepEqual([...topics].reverse().sort(compareTopics).map((t) => t.topic_id), topics.map((t) => t.topic_id));
});
