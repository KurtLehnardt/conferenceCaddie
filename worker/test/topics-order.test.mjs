// The Worker's topic list must keep the builder's order after a re-ingest. The fake admin below
// stands in for the Worker's PUT and GET /admin/topics routes and orders rows the way the Worker's
// store does (ORDER BY rank, label_exact), which is also the order GET /api/topics serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assignFrozen, buildTopics, compareTopics, loadStoplist, resolveTopics } from '../ingest/topics-local.mjs';
import { buildTopics as buildBundleTopics, compareTopics as bundleCompare, readFixups } from '../../scripts/lib/topics.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STOPLIST_TEXT = readFileSync(`${ROOT}config/topic-stoplist.txt`, 'utf8');

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

// The builder behind the bundles and the contract fixtures (scripts/lib/topics.mjs), run on the
// same talks. Its topics are documents shaped like the ones the Worker stores.
function bundleTopics(talks, fixups = {}) {
  return buildBundleTopics({ talks, stoplistText: STOPLIST_TEXT, fixups }).topics
    .map((t) => ({ conference: SLUG, ...t, label_exact: t.label }));
}

test('the Worker ingest ranks by the comparator of the bundle builder', () => {
  assert.equal(compareTopics, bundleCompare);
});

test('a frozen list of KubeCon topics is ranked in the order the bundle builder gives', () => {
  const slug = 'kubecon-cloudnativecon-north-america-2026';
  const talks = readFileSync(`${ROOT}data/${slug}/talks.ndjson`, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).filter((t) => t.kind === 'talk');
  assert.ok(talks.length > 400);
  const built = buildBundleTopics({ talks, stoplistText: STOPLIST_TEXT, fixups: readFixups(`${ROOT}data/topics/${slug}.json`) }).topics;
  assert.ok(built.length > 50);
  const docs = built.map((t) => ({ conference: slug, ...t, label_exact: t.label }));

  // The whole list, then a list frozen with every third topic gone (topics that were removed since).
  // Counts do not depend on the other topics, so the order is the builder's order of the same ids.
  for (const frozen of [docs, docs.filter((_, i) => i % 3 !== 0)]) {
    const ids = new Set(frozen.map((t) => t.topic_id));
    const expected = built.filter((t) => ids.has(t.topic_id));
    const { topics } = assignFrozen(talks, frozen, { slug, stop });
    assert.deepEqual(topics.map((t) => [t.topic_id, t.talk_count]), expected.map((t) => [t.topic_id, t.talk_count]));
    assert.deepEqual(topics.map((t) => t.rank), expected.map((_, i) => i + 1));
  }
});

test('a frozen topic with a merge alias counts the talks that have only the alias', async () => {
  const worker = fakeWorker();
  const fixups = { merge: { omega: 'alpha' } };
  const first = talksWith({ alpha: 3, omega: 3, beta: 4 });
  const frozen = bundleTopics(first, fixups);
  const alpha = frozen.find((t) => t.topic_id === 'alpha');
  assert.deepEqual(alpha.aliases, ['omega']);
  assert.equal(alpha.talk_count, 6);
  assert.equal(frozen.some((t) => t.topic_id === 'omega'), false);
  await worker.admin('PUT', `/admin/topics?event=${SLUG}`, { topics: frozen });

  // Two more talks hold only the alias word. The re-ingest keeps the list and counts them.
  const changed = talksWith({ alpha: 3, omega: 5, beta: 4 });
  const result = await ingest(worker, changed);
  assert.equal(result.mode, 'frozen');
  const stored = (await worker.admin('GET', `/admin/topics?event=${SLUG}`)).topics;
  assert.deepEqual(stored.map((t) => [t.topic_id, t.talk_count, t.rank]), [['alpha', 8, 1], ['beta', 4, 2]]);
  assert.deepEqual(stored.find((t) => t.topic_id === 'alpha').aliases, ['omega']);
  assert.deepEqual(stored.map((t) => [t.topic_id, t.talk_count]), bundleTopics(changed, fixups).map((t) => [t.topic_id, t.talk_count]));
  for (const t of changed.filter((x) => x.talk_id.startsWith('t-omega-'))) assert.deepEqual(result.assignments.get(t.talk_id), ['alpha']);
  for (const t of changed.filter((x) => x.talk_id.startsWith('t-alpha-'))) assert.deepEqual(result.assignments.get(t.talk_id), ['alpha']);
});

test('ties between accented and kana labels are ordered the same way by both builders', () => {
  // The terms are ASCII (a topic id is), and the labels come from the fix-ups. The counts tie, so
  // only the label decides. By UTF-16 code unit, case-insensitively: "zebra" (U+007A), "éclair"
  // (U+00E9), the hiragana label (U+3072), the katakana label (U+30AB). localeCompare would put
  // "Éclair" before "Zebra" and the katakana label before the hiragana one.
  const rename = { alpha: 'カタカナ', beta: 'ひらがな', gamma: 'Éclair', delta: 'Zebra' };
  const talks = talksWith({ alpha: 3, beta: 3, gamma: 3, delta: 3 });
  const expected = ['delta', 'gamma', 'beta', 'alpha'];

  const bundle = bundleTopics(talks, { rename });
  assert.deepEqual(bundle.map((t) => t.topic_id), expected);
  assert.deepEqual(bundle.map((t) => t.label), ['Zebra', 'Éclair', 'ひらがな', 'カタカナ']);

  const local = buildTopics(talks, { slug: SLUG, stop, fixups: { rename, merge: {}, remove: [] } });
  assert.deepEqual(local.topics.map((t) => t.topic_id), expected);

  // A list frozen in some other order is ranked the same way.
  const frozen = [...bundle].reverse().map((t) => ({ ...t, rank: 0 }));
  const { topics, assignments } = assignFrozen(talks, frozen, { slug: SLUG, stop });
  assert.deepEqual(topics.map((t) => t.topic_id), expected);
  assert.deepEqual(topics.map((t) => t.rank), [1, 2, 3, 4]);
  assert.deepEqual(assignments.get('t-alpha-0'), ['alpha']);

  // The same tie through the comparator, with the topic id as the last resort.
  const tie = (label, topic_id) => ({ label, topic_id, talk_count: 5 });
  const order = [tie('Éclair', 'b'), tie('Zebra', 'a'), tie('éclair', 'a'), tie('Éclair', 'a')];
  assert.deepEqual(order.sort(compareTopics).map((t) => `${t.label}/${t.topic_id}`), ['Zebra/a', 'Éclair/a', 'Éclair/b', 'éclair/a']);
});

test('a merge target that reaches three talks only with its aliases stays the topic, in both builders', () => {
  // "pipeline" occurs in two titles and "pipelines" in four: the merge keeps the id "pipeline",
  // counting all six talks, instead of falling back to "pipelines" (KubeCon after a cancellation).
  const titles = ['Pipeline security for clusters', 'Pipeline caching for clusters', 'Pipelines at scale for clusters', 'Faster pipelines for clusters', 'Pipelines without tears for clusters', 'Pipelines and secrets for clusters'];
  const talks = titles.map((title, i) => ({ talk_id: `fx:${i + 1}`, title }));
  const fixups = { rename: {}, merge: { pipelines: 'pipeline' }, remove: [] };
  const worker = buildTopics(talks, { slug: 'fx', stop, fixups }).topics;
  const bundle = buildBundleTopics({ talks, stoplistText: STOPLIST_TEXT, fixups }).topics;
  for (const list of [worker, bundle]) {
    const ids = list.map((t) => t.topic_id);
    assert.ok(ids.includes('pipeline'), `pipeline kept: ${ids.join(', ')}`);
    assert.ok(!ids.includes('pipelines'), 'the alias is not a topic of its own');
    assert.equal(list.find((t) => t.topic_id === 'pipeline').talk_count, 6);
  }
  // A target that occurs in no title is not created by a merge, and the alias stays a topic of its own.
  const none = talks.slice(2);
  const workerNone = buildTopics(none, { slug: 'fx', stop, fixups }).topics;
  const bundleNone = buildBundleTopics({ talks: none, stoplistText: STOPLIST_TEXT, fixups }).topics;
  for (const list of [workerNone, bundleNone]) {
    const ids = list.map((t) => t.topic_id);
    assert.ok(!ids.includes('pipeline'), `no topic from a merge target that no title holds: ${ids.join(', ')}`);
    assert.equal(list.find((t) => t.topic_id === 'pipelines')?.talk_count, 4, 'pipelines stands alone with its four talks');
  }
});

test('a conference with no shared term gets an empty topic list in both builders', () => {
  const talks = talksWith({ alpha: 2, beta: 2, gamma: 1 });
  // Without fix-ups, and with a merge whose target no title holds (the bundle builder then takes
  // its full path rather than the early return).
  for (const fixups of [{ rename: {}, merge: {}, remove: [] }, { rename: {}, merge: { beta: 'delta' }, remove: [] }]) {
    const worker = buildTopics(talks, { slug: SLUG, stop, fixups });
    assert.deepEqual(worker.topics, []);
    assert.deepEqual([...worker.assignments.values()], talks.map(() => []));
    assert.ok(worker.warnings.some((w) => /no topics/.test(w)), worker.warnings.join(' | '));
    const bundle = buildBundleTopics({ talks, stoplistText: STOPLIST_TEXT, fixups });
    assert.deepEqual(bundle.topics, []);
    assert.deepEqual([...bundle.talkTopics.values()], talks.map(() => []));
  }
});

test('a rebuild that finds no topics never replaces a stored list unless allowEmpty is given', async () => {
  const worker = fakeWorker();
  await ingest(worker, talksWith({ alpha: 5, beta: 4 }));
  assert.deepEqual(worker.served(), ['alpha', 'beta']);
  const tiny = talksWith({ alpha: 1, beta: 2 });
  await assert.rejects(resolveTopics(tiny, { slug: SLUG, admin: worker.admin, rebuild: true, stop }), /would replace the 2 stored topics; nothing was sent/);
  assert.deepEqual(worker.served(), ['alpha', 'beta']);
  // Without --rebuild-topics the stored list stays frozen, with the new counts.
  const frozen = await resolveTopics(tiny, { slug: SLUG, admin: worker.admin, stop });
  assert.equal(frozen.mode, 'frozen');
  assert.deepEqual(frozen.topics.map((t) => [t.topic_id, t.talk_count]), [['beta', 2], ['alpha', 1]]);
  const allowed = await resolveTopics(tiny, { slug: SLUG, admin: worker.admin, rebuild: true, allowEmpty: true, stop });
  assert.equal(allowed.mode, 'built');
  assert.deepEqual(allowed.topics, []);
  // A conference with nothing stored takes the empty list without the flag.
  const fresh = fakeWorker();
  const first = await resolveTopics(tiny, { slug: SLUG, admin: fresh.admin, stop });
  assert.equal(first.mode, 'built');
  assert.deepEqual(first.topics, []);
});
