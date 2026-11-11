// The candidate step of scripts/topics.mjs (tier 3), without Elasticsearch so a test can run it:
// the regular candidates from the terms aggregation, then the merge targets that reach three talks
// with their aliases (mergeTargets, shared with the bundle builder), then the empty guard.
import { mergeTargets } from './topics.mjs';

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
