import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mergeTargets, TOPIC_ID } from '../lib/topics.mjs';
import { candidatesWithTargets, checkNotShrinking, checkWorkIndexCount } from '../lib/topics-candidates.mjs';

const merge = { pipelines: 'pipeline' };
const sets = (...rows) => rows.map((r) => new Set(r));
const counts = (termSets) => {
  const m = new Map();
  for (const s of termSets) for (const t of s) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};
const run = (termSets, mg = merge, already = new Set()) => mergeTargets(termSets, counts(termSets), mg, already);

test('a talk that holds both the target and an alias counts once', () => {
  // 2 talks hold both words, 1 holds only the alias: 3 talks, but a sum would give 5.
  assert.deepEqual(run(sets(['pipeline', 'pipelines'], ['pipeline', 'pipelines'], ['pipelines'])), [{ term: 'pipeline', count: 3 }]);
  // 1 talk holds both, 1 holds the target only: 2 talks, a sum would give 3 and wrongly keep it.
  assert.deepEqual(run(sets(['pipeline', 'pipelines'], ['pipeline'])), []);
});

test('the boundary: 1 + 2 = 3 talks is kept, 1 + 1 = 2 is not', () => {
  assert.deepEqual(run(sets(['pipeline'], ['pipelines'], ['pipelines'])), [{ term: 'pipeline', count: 3 }]);
  assert.deepEqual(run(sets(['pipeline'], ['pipelines'])), []);
});

test('a target that is already a candidate is skipped', () => {
  assert.deepEqual(run(sets(['pipeline'], ['pipelines'], ['pipelines']), merge, new Set(['pipeline'])), []);
});

test('several targets come back ordered by term', () => {
  const mg = { zebras: 'zebra', pipelines: 'pipeline', apps: 'app' };
  const termSets = sets(['zebra'], ['zebras'], ['zebras'], ['pipeline'], ['pipelines'], ['pipelines'], ['app'], ['apps'], ['apps']);
  assert.deepEqual(run(termSets, mg).map((c) => c.term), ['app', 'pipeline', 'zebra']);
});

test('a target that occurs in no title is not created; the alias stands alone', () => {
  const termSets = sets(['pipelines'], ['pipelines'], ['pipelines'], ['pipelines']);
  assert.deepEqual(run(termSets), []);
  const got = candidatesWithTargets({
    termBuckets: [{ key: 'pipelines', doc_count: 4 }],
    aliasBuckets: [{ key: 'pipelines', doc_count: 4 }],
    talkTerms: termSets,
    merge,
  });
  assert.deepEqual(got, [{ term: 'pipelines', count: 4 }]);
});

test('tier 3 candidates add a target below three talks that its aliases lift to three', () => {
  const termSets = sets(['pipeline'], ['pipeline', 'pipelines'], ['pipelines'], ['pipelines'], ['ai'], ['ai'], ['ai']);
  const got = candidatesWithTargets({
    termBuckets: [{ key: 'ai', doc_count: 3 }, { key: 'pipelines', doc_count: 3 }],
    aliasBuckets: [{ key: 'pipelines', doc_count: 3 }, { key: 'pipeline', doc_count: 2 }],
    talkTerms: termSets,
    merge,
  });
  assert.deepEqual(got.map((c) => c.term), ['ai', 'pipelines', 'pipeline']);
});

test('a small conference gives no candidates, with or without a merge file', () => {
  for (const mg of [{}, merge]) {
    assert.deepEqual(candidatesWithTargets({ termBuckets: [], aliasBuckets: [], talkTerms: [], merge: mg }), []);
  }
  assert.deepEqual(candidatesWithTargets({ termBuckets: [], aliasBuckets: [{ key: 'pipelines', doc_count: 1 }], talkTerms: sets(['pipelines']), merge }), []);
});

test('the work index count must equal the talks and be above zero', () => {
  checkWorkIndexCount(484, 484);
  assert.throws(() => checkWorkIndexCount(484, 0), /holds 0 documents, expected 484/);
  assert.throws(() => checkWorkIndexCount(484, 483), /expected 484/);
  assert.throws(() => checkWorkIndexCount(484, 485), /expected 484/);
  assert.throws(() => checkWorkIndexCount(0, 0), /expected 0/);
});

test('an empty result refuses to replace stored topics unless --allow-empty', () => {
  assert.throws(() => checkNotShrinking(0, 96, {}), /Refusing to delete .*--allow-empty/);
  checkNotShrinking(0, 96, { allowEmpty: true });
  checkNotShrinking(0, 0, {});
  checkNotShrinking(5, 96 - 91 + 5, {});
});

test('the shrink guard needs more than 10 topics and more than 10% fewer', () => {
  assert.throws(() => checkNotShrinking(80, 96, {}), /pass --allow-shrink/);
  checkNotShrinking(80, 96, { allowShrink: true });
  checkNotShrinking(80, 96, { allowEmpty: true });
  checkNotShrinking(86, 96, {}); // 10 fewer is not more than 10
  checkNotShrinking(90, 96, {}); // fewer than 10% and 10
  checkNotShrinking(200, 96, {}); // growth
  checkNotShrinking(15, 20, {}); // 5 fewer
  checkNotShrinking(0, 8, { allowEmpty: true });
  assert.throws(() => checkNotShrinking(1, 100, {}), /Refusing to shrink/);
});

// A committed no-op: "don't-have" can never be a topic id (an apostrophe), so the script ignores it
// with a warning. Reported to the owner of the data instead of changed here.
const KNOWN_INVALID = new Set(["kubecon-cloudnativecon-north-america-2026.json:don't-have"]);

test('every data/topics fixup file is well formed', () => {
  const dir = new URL('../../data/topics/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  for (const f of files) {
    const fx = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const mg = fx.merge ?? {};
    const canonicals = new Set(Object.values(mg));
    const ids = [...Object.keys(mg), ...Object.values(mg), ...(fx.remove ?? []), ...Object.keys(fx.rename ?? {})];
    for (const id of ids) assert.ok(TOPIC_ID.test(id) || KNOWN_INVALID.has(`${f}:${id}`), `${f}: ${JSON.stringify(id)} is not a valid topic id`);
    for (const id of fx.remove ?? []) assert.ok(!Object.keys(mg).includes(id) && !canonicals.has(id), `${f}: ${id} is both removed and merged`);
    for (const [alias, canonical] of Object.entries(mg)) {
      assert.ok(text(alias) && text(canonical), `${f}: ${JSON.stringify([alias, canonical])} must be non-empty strings`);
      assert.notEqual(alias, canonical, `${f}: ${alias} merges into itself`);
      assert.ok(!canonicals.has(alias), `${f}: ${alias} is an alias and also a merge target (chain)`);
    }
    for (const id of fx.remove ?? []) assert.ok(text(id), `${f}: remove holds a non-string id`);
    for (const [id, label] of Object.entries(fx.rename ?? {})) assert.ok(text(id) && text(label), `${f}: rename ${id}`);
  }
});
