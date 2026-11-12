// The tier 3 topics builder (scripts/topics.mjs) breaks ties with the comparators the bundle builder
// and the Worker's ingest share since #57 (scripts/lib/topics.mjs cmp and compareTopics), through
// commonCasing and rankTopics in scripts/lib/topics-candidates.mjs, instead of ICU's localeCompare.
// On the committed data the switch changes nothing: the live tier 3 lists (contracts/fixtures/
// topics-live, which scripts/topics.mjs built) and the topic lists and label casings the committed
// talk titles give come out the same under both orders. Where the two orders differ (accents, kana,
// labels that differ only in case) tier 3 now agrees with the other two builders. No Elasticsearch:
// the dry run's other steps are unchanged, and these two orders are the only part of its output the
// switch can move.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, buildTopics, compareTopics, readFixups } from '../lib/topics.mjs';
import { commonCasing, rankTopics } from '../lib/topics-candidates.mjs';
import { buildTopics as buildWorkerTopics, loadStoplist } from '../../worker/ingest/topics-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STOPLIST_TEXT = readFileSync(path.join(ROOT, 'config/topic-stoplist.txt'), 'utf8');

// What scripts/topics.mjs did before: ICU localeCompare for the casing tie and for the topic order.
const legacyCasing = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) || a[0].localeCompare(b[0]))[0][0];
const legacyCompare = (a, b) => b.talk_count - a.talk_count || a.label.localeCompare(b.label) || a.topic_id.localeCompare(b.topic_id);

const order = (topics) => topics.map((t) => t.topic_id);
// A fixed shuffle, so neither sort can lean on the input order.
const shuffled = (topics) => topics.map((t, i) => ({ t: { ...t }, k: (i * 7919) % 104729 })).sort((a, b) => a.k - b.k).map((x) => x.t);

const LIVE = path.join(ROOT, 'contracts/fixtures/topics-live');
const liveLists = readdirSync(LIVE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(LIVE, f), 'utf8')));
const committed = readdirSync(path.join(ROOT, 'data'))
  .filter((slug) => existsSync(path.join(ROOT, 'data', slug, 'talks.ndjson')))
  .map((slug) => ({
    slug,
    talks: readFileSync(path.join(ROOT, 'data', slug, 'talks.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((t) => t.kind === 'talk'),
  }));

test('the live tier 3 lists come out in the same order under the old and the new comparator', () => {
  assert.ok(liveLists.length >= 4);
  for (const live of liveLists) {
    assert.ok(live.topics.length > 0, live.event);
    const ranked = rankTopics(shuffled(live.topics), 150);
    assert.deepEqual(order(ranked), order(live.topics), `${live.event}: rankTopics gives the served order`);
    assert.deepEqual(ranked.map((t) => t.rank), live.topics.map((_, i) => i + 1));
    assert.deepEqual(order(shuffled(live.topics).sort(legacyCompare)), order(live.topics), `${live.event}: so did localeCompare`);
  }
});

test('the committed talk titles give the same topic labels and topic order under both', () => {
  assert.ok(committed.length >= 4);
  // The analyzer's stop set (_english_ plus config/topic-stoplist.txt) and, as in the term vectors
  // tier 3 reads, the first occurrence of each term in each title.
  const stop = loadStoplist();
  let checked = 0;
  let differing = 0;
  for (const { slug, talks } of committed) {
    const casings = new Map();
    for (const t of talks) {
      const seen = new Set();
      for (const tok of analyse(t.title ?? '', stop)) {
        if (seen.has(tok.term)) continue;
        seen.add(tok.term);
        const original = t.title.slice(tok.start, tok.end).replace(/\s+/g, ' ').trim();
        const m = casings.get(tok.term) ?? new Map();
        m.set(original, (m.get(original) ?? 0) + 1);
        casings.set(tok.term, m);
      }
    }

    // The topics these titles give (the bundle builder, the Node port of the tier 3 pipeline): every
    // label that comes from a casing is the same under both tie-breaks, and the order is too.
    const fixups = readFixups(path.join(ROOT, 'data/topics', `${slug}.json`));
    const { topics } = buildTopics({ talks, stoplistText: STOPLIST_TEXT, fixups });
    // Terms whose tie the two orders break differently exist, but none is a topic: on 2026-11-11 four
    // KubeCon terms (autonomous ai, authz, distributed ai, ai workloads), each in two titles only.
    const ids = new Set(topics.map((t) => t.topic_id));
    for (const [term, m] of casings) {
      if (commonCasing(m) === legacyCasing(m)) continue;
      differing++;
      assert.ok(!ids.has(term.replace(/ /g, '-')), `${slug}: ${term} is a topic whose label would change`);
    }
    for (const t of topics) {
      const m = casings.get(t.topic_id.replace(/-/g, ' '));
      if (!m || Object.hasOwn(fixups.rename ?? {}, t.topic_id)) continue;
      checked++;
      assert.equal(commonCasing(m), legacyCasing(m), `${slug}: the label of ${t.topic_id}`);
      assert.equal(t.label, commonCasing(m), `${slug}: the bundle builder's label of ${t.topic_id}`);
    }
    assert.deepEqual(order(rankTopics(shuffled(topics), 150)), order(shuffled(topics).sort(legacyCompare)), `${slug}: the topic order`);
  }
  assert.ok(checked > 100, `${checked} labels checked`);
  assert.ok(differing > 0, 'the data has ties the two orders break differently, so the check is not vacuous');
});

test('where the orders differ, tier 3 now breaks ties as the bundle builder and the Worker do', () => {
  const tied = [
    { topic_id: 'b', label: 'Éclair', talk_count: 3 },
    { topic_id: 'a', label: 'éclair', talk_count: 3 },
    { topic_id: 'a', label: 'Zebra', talk_count: 3 },
    { topic_id: 'a', label: 'Éclair', talk_count: 3 },
    { topic_id: 'k', label: 'カ', talk_count: 3 },
    { topic_id: 'h', label: 'か', talk_count: 3 },
  ];
  const now = rankTopics(shuffled(tied), 150).map((t) => `${t.label}/${t.topic_id}`);
  assert.deepEqual(now, [...tied].sort(compareTopics).map((t) => `${t.label}/${t.topic_id}`));
  assert.deepEqual(now, ['Zebra/a', 'Éclair/a', 'Éclair/b', 'éclair/a', 'か/h', 'カ/k']);
  assert.notDeepEqual(now, [...tied].sort(legacyCompare).map((t) => `${t.label}/${t.topic_id}`), 'ICU orders these differently');

  // Two casings of one term, equally common and both with a capital: the first by code unit.
  const casings = new Map([['Kubernetes', 2], ['KUBERNETES', 2], ['kubernetes', 2]]);
  assert.equal(commonCasing(casings), 'KUBERNETES');
  assert.notEqual(legacyCasing(casings), 'KUBERNETES', 'ICU puts lower case first');

  // The same titles through the bundle builder and the Worker's builder give the casing tier 3 now picks.
  const talks = ['KUBERNETES at scale', 'Kubernetes for all', 'KUBERNETES again', 'Kubernetes once more'].map((title, i) => ({ talk_id: `x:${i}`, kind: 'talk', title }));
  const label = (topics) => topics.find((t) => t.topic_id === 'kubernetes')?.label;
  const casingsOf = new Map([['KUBERNETES', 2], ['Kubernetes', 2]]);
  assert.equal(label(buildTopics({ talks, stoplistText: STOPLIST_TEXT }).topics), commonCasing(casingsOf));
  assert.equal(label(buildWorkerTopics(talks, { slug: 'x', stop: loadStoplist() }).topics), commonCasing(casingsOf));
});
