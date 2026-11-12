// The candidate step of scripts/topics.mjs (tier 3), without Elasticsearch so a test can run it:
// the regular candidates from the terms aggregation, then the merge targets that reach three talks
// with their aliases (mergeTargets, shared with the bundle builder), then the empty guard. Also the
// two orders of its result, the label casing and the topic ranking, which use the bundle builder's
// comparators so that all three builders break ties the same way.
import { cmp, compareTopics, mergeTargets } from './topics.mjs';

/**
 * termBuckets   buckets of the terms aggregation (at least three talks): [{ key, doc_count }]
 * aliasBuckets  buckets of the alias_terms aggregation (alias and target terms, any count)
 * talkTerms     iterable of one Set of wanted terms per talk
 * merge         the fix-up merge map { alias_id: canonical_id }
 * Returns the candidates [{ term, count }]; none means the conference has no topics, as in the bundle
 * builder. The two guards below keep an empty result from wiping stored topics by mistake.
 */
export function candidatesWithTargets({ termBuckets, aliasBuckets = [], talkTerms, merge }) {
  const candidates = termBuckets.map((b) => ({ term: b.key, count: b.doc_count }));
  const docCount = new Map();
  for (const b of termBuckets) docCount.set(b.key, b.doc_count);
  for (const b of aliasBuckets) docCount.set(b.key, b.doc_count);
  candidates.push(...mergeTargets(talkTerms, docCount, merge, new Set(candidates.map((c) => c.term))));
  return candidates;
}

/** The work index must hold exactly the conference's talks (and at least one), or it was clobbered or never filled. */
export function checkWorkIndexCount(expected, actual) {
  if (!(expected > 0) || actual !== expected) {
    throw new Error(`The work index holds ${actual} documents, expected ${expected} (the conference's talks); refusing to compute topics from it.`);
  }
}

/**
 * An empty topic list never replaces a stored non-empty one unless the caller passes --allow-empty.
 * A list that drops more than 10 topics and more than 10% of the stored ones (the Worker's finalize
 * rule) needs --allow-shrink, which --allow-empty implies.
 */
export function checkNotShrinking(computed, stored, { allowEmpty = false, allowShrink = false } = {}) {
  if (computed === 0 && stored > 0 && !allowEmpty) {
    throw new Error(`No topics were computed, but ${stored} are stored for this conference. Refusing to delete them and every talk's topics; pass --allow-empty if that is intended.`);
  }
  const removed = stored - computed;
  if (computed > 0 && removed > 10 && removed > stored * 0.1 && !allowShrink && !allowEmpty) {
    throw new Error(`The computed list has ${computed} topics against ${stored} stored (${removed} fewer). Refusing to shrink it by more than 10 topics and 10%; pass --allow-shrink if that is intended.`);
  }
}

/**
 * The label of a term: its most common original casing in the titles. A tie goes to the casing that
 * has a capital letter, then to the first by UTF-16 code unit (cmp), as in the bundle builder and
 * the Worker's ingest. casings is a Map of original text to count.
 */
export function commonCasing(casings) {
  return [...casings.entries()].sort((a, b) => b[1] - a[1] || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) || cmp(a[0], b[0]))[0][0];
}

/**
 * Sorts a topic list in place by compareTopics (most talks first, then label, then topic id, with no
 * dependence on ICU or the locale), keeps the first max and numbers their rank from 1. Returns it.
 */
export function rankTopics(topics, max) {
  topics.sort(compareTopics);
  topics.splice(max);
  topics.forEach((t, i) => { t.rank = i + 1; });
  return topics;
}
