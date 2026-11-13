// The source sidecar of the published talk bundles, bundles/sources.json, and the rule that decides,
// conference by conference, whether a build publishes a bundle rebuilt from data/ or keeps the bundle
// the live site already serves.
//
// Two workflows publish the same Pages site: ingest.yml, which builds bundles from the schedules it
// has just fetched and pushed to the Worker, and pages.yml, which builds them from the committed
// data/ (a seed that changes only when someone commits). The frozen v1 formats (conferences.json and
// bundle.json) have no place for when a bundle's schedule was fetched, so every build writes this
// sidecar next to them:
//
//   { "sources_version": 1,
//     "generated_at": "<the generated_at of the conferences.json written with it>",
//     "conferences": { "<slug>": { "content_hash": "<the bundle's content_hash>",
//                                  "raw_fetched_at": "<conference.json raw_fetched_at, or null>",
//                                  "source_sha256": "<SHA-256 of the conference and talk inputs>" } } }
//
// A record counts only for the bundle whose content_hash it names, so a sidecar that does not match
// the live index is ignored. A record whose raw_fetched_at lies in the future (beyond FUTURE_SKEW_MS)
// counts for nothing either, so a bad deploy cannot pin a bundle by claiming a fetch time no seed or
// ingest will ever pass. Clients never read this file; only the bundle builder and the smoke do.

import { createHash } from 'node:crypto';
import { normalizeKey } from '../../contracts/js/bundle.mjs';

export const SOURCES_FILE = 'sources.json';
export const SOURCES_VERSION = 1;
const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
/** How far a record's raw_fetched_at may lie ahead of the build's clock (clock skew) and still count. */
export const FUTURE_SKEW_MS = 10 * 60 * 1000;

/** The SHA-256 (hex) of a conference's build inputs: its public entry as JSON, a newline, then the bytes of talks.ndjson. */
export function sourceSha256(publicEntry, talksBytes) {
  return createHash('sha256').update(`${JSON.stringify(publicEntry)}\n`).update(Buffer.from(talksBytes ?? '')).digest('hex');
}

/** Milliseconds since the epoch of an ISO time, or null when there is none or it does not parse. */
export function fetchedMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads a sources.json document. Returns Map(slug -> { content_hash, raw_fetched_at, source_sha256 })
 * with only the well-formed records; anything else (a missing or malformed file) is an empty map.
 */
export function parseSources(doc) {
  const out = new Map();
  if (!doc || typeof doc !== 'object' || doc.sources_version !== SOURCES_VERSION || !doc.conferences || typeof doc.conferences !== 'object') return out;
  for (const [slug, r] of Object.entries(doc.conferences)) {
    if (!SLUG_RE.test(slug) || !r || typeof r !== 'object' || !HASH_RE.test(r.content_hash ?? '')) continue;
    out.set(slug, {
      content_hash: r.content_hash,
      raw_fetched_at: fetchedMs(r.raw_fetched_at) === null ? null : r.raw_fetched_at,
      source_sha256: HASH_RE.test(r.source_sha256 ?? '') ? r.source_sha256 : null,
    });
  }
  return out;
}

/**
 * The sources.json bytes for Map(slug -> record), with the slugs in code-unit order. `generatedAt` is
 * the generated_at of the conferences.json written in the same build, so a reader can tell a sidecar
 * and an index from two different deploys apart.
 */
export function serializeSources(records, generatedAt = null) {
  const conferences = {};
  for (const slug of [...records.keys()].sort()) {
    const r = records.get(slug);
    conferences[slug] = { content_hash: r.content_hash, raw_fetched_at: r.raw_fetched_at ?? null, source_sha256: r.source_sha256 ?? null };
  }
  const doc = generatedAt ? { sources_version: SOURCES_VERSION, generated_at: generatedAt, conferences } : { sources_version: SOURCES_VERSION, conferences };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/**
 * Decides, for every conference that data/ or the live index knows, what this build publishes:
 *   local   Map(slug -> conference.json document), every conference under data/ (any status)
 *   live    null (no live site to compare with), or { conferences: [{ conference, bundle }] from
 *           readConferenceIndex with a usable bundle, sources: Map from parseSources }
 *   fresh   the slugs whose data/ files an ingest run fetched and pushed to the Worker in this very
 *           run (pages.yml passes the staged ones): they always follow data/, whatever the live
 *           record says, because the Worker now serves exactly that data
 *   now     the build's clock in milliseconds; a record dated more than FUTURE_SKEW_MS after it is ignored
 * Returns Map(slug -> { action: 'build' | 'keep' | 'drop', reason }). A slug that is neither built
 * nor kept is left out of the index.
 *
 * A fresh slug is built when data/ has it as searchable and dropped otherwise, as the Worker now
 * does. For every other slug the rules, in order:
 *   1. The live bundle was built from a schedule fetched later than data/ holds (its sidecar record
 *      names the live bundle's content hash and a later raw_fetched_at, or data/ has no such
 *      conference at all): keep the live bundle. This is what stops a build from committed data
 *      from replacing a bundle the ingest built from a fresher fetch.
 *   2. data/ says the latest fetch of a conference with a live bundle failed (status_reason
 *      fetch_failed): keep the live bundle, as push-ingest.mjs keeps the Worker's searchable document.
 *   3. data/ has the conference as searchable: build it.
 *   4. Otherwise (unavailable in data/, or a live bundle with no sidecar record and nothing in
 *      data/): drop it, as builds did before the sidecar existed.
 */
export function planBuild({ local, live, fresh = new Set(), now = Date.now() }) {
  const plan = new Map();
  const liveBySlug = new Map((live?.conferences ?? []).filter((c) => c.bundle).map((c) => [c.conference.slug, c]));
  const slugs = [...new Set([...local.keys(), ...liveBySlug.keys()])].sort();
  for (const slug of slugs) {
    const doc = local.get(slug) ?? null;
    const liveEntry = liveBySlug.get(slug) ?? null;
    const record = liveEntry ? live.sources.get(slug) : null;
    const recordMs = record && record.content_hash === liveEntry.bundle.content_hash ? fetchedMs(record.raw_fetched_at) : null;
    const usableMs = recordMs !== null && recordMs <= now + FUTURE_SKEW_MS ? recordMs : null;
    const localMs = doc ? fetchedMs(doc.raw_fetched_at) : null;
    // A live demo conference (demo: true, regenerated by every build) is never kept from an earlier
    // build: its dates would freeze. Outside --fresh (a build that did not prepare it, or a slug the
    // configuration no longer names) it follows data/: built when searchable there, dropped otherwise.
    if (!fresh.has(slug) && liveEntry?.conference?.demo === true) {
      if (doc?.status === 'searchable') plan.set(slug, { action: 'build', reason: 'a demo conference is always rebuilt' });
      else plan.set(slug, { action: 'drop', reason: 'a demo conference is never kept from an earlier build' });
      continue;
    }
    if (fresh.has(slug)) {
      if (doc?.status === 'searchable') plan.set(slug, { action: 'build', reason: 'fetched and pushed to the Worker in this ingest run' });
      else if (liveEntry || doc) plan.set(slug, { action: 'drop', reason: doc ? `this ingest run found it ${doc.status}${doc.status_reason ? ` (${doc.status_reason})` : ''}` : 'not in data/' });
      continue;
    }
    if (liveEntry && usableMs !== null && (doc === null || localMs === null || usableMs > localMs)) {
      plan.set(slug, { action: 'keep', reason: doc ? `the live bundle's schedule (fetched ${record.raw_fetched_at}) is newer than data/ (${doc.raw_fetched_at ?? 'no fetch time'})` : 'data/ does not have this conference' });
    } else if (liveEntry && doc && doc.status !== 'searchable' && doc.status_reason === 'fetch_failed') {
      plan.set(slug, { action: 'keep', reason: 'the latest schedule fetch failed; the live bundle stays' });
    } else if (doc?.status === 'searchable') {
      plan.set(slug, { action: 'build', reason: liveEntry ? 'data/ is at least as new as the live bundle' : 'not live yet' });
    } else if (liveEntry) {
      plan.set(slug, { action: 'drop', reason: doc ? `data/ has it as ${doc.status}${doc.status_reason ? ` (${doc.status_reason})` : ''}` : 'not in data/ and the live bundle has no usable source record' });
    }
  }
  return plan;
}

/**
 * The takedown entries of one conference that still match a bundle's talks: an entry with only a
 * talk_id matches that talk, an entry with a speaker matches that name (compared with normalizeKey)
 * on the talk named by talk_id, or on any talk when there is none. A kept live bundle must have none,
 * because keeping it would republish what a later takedown removed.
 */
export function takedownsMatching(slug, talks, takedowns) {
  return takedowns.filter((e) => e.slug === slug).filter((e) => {
    const scope = e.talk_id === undefined ? talks : talks.filter((t) => t.talk_id === e.talk_id);
    if (e.speaker === undefined) return scope.length > 0;
    const key = normalizeKey(e.speaker);
    return scope.some((t) => (t.speakers ?? []).some((s) => normalizeKey(s) === key));
  });
}
