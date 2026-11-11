// Pushes the talk files built by scripts/ingest.mjs (the discovery step, run with --dry-run so it
// touches no Elasticsearch) to the Worker's admin routes.
//
// Usage:
//   node worker/ingest/push-ingest.mjs --api <base> [--event <slug> ... | --events-from <file>] [--dry-run]
//                                      [--rebuild-topics] [--allow-shrink] [--report <file>]
// --allow-shrink lets finalize delete more than 10 talks and more than 10% of a conference's talks,
// which the Worker otherwise refuses (409) so a short feed cannot erase people's sharing.
// Env: ADMIN_TOKEN, or ADMIN_TOKEN_FILE naming a file that holds it (not needed with --dry-run).
//
// Steps:
// 1. PUT /admin/conferences with the conference documents of the selected events: the --event slugs,
//    or the "processed" list of the scripts/ingest.mjs --report file named by --events-from (the
//    conferences that run fetched), or, when neither is given, every data/{slug}/conference.json.
//    data/ also holds the committed seed of events that have ended and dropped off the upcoming list,
//    so a run after a fetch passes --events-from: pushing every folder would put the old seed back on
//    the Worker for those. An empty --events-from list pushes nothing and succeeds.
// 2. For each searchable event that has a talk file:
//    a. topics: the list stored on the Worker is frozen (GET /admin/topics) and each talk's topics
//       are recomputed against it, unless there is none yet or --rebuild-topics is given, when the
//       list is built from the titles (topics-local.mjs);
//    b. POST /admin/talks in batches of at most 50 talks, all with one generation (the run's
//       timestamp). The Worker embeds only talks whose text changed;
//    c. POST /admin/talks/finalize, which deletes the talks that an earlier generation left behind;
//    d. PUT /admin/topics and PUT /admin/facets.
//    Finalize is skipped for an event whose batches did not all succeed, so a failed run never
//    deletes talks.
// Takedowns: data/takedowns.json is applied to every talk file before anything is computed from it,
// with the bundle builder's own applyTakedowns (scripts/build-bundles.mjs), so a talk taken down is
// not sent (finalize then deletes it from the Worker) and a speaker taken down is removed with their
// tagline and profile, from the talks, the topics and the facets, exactly as in the talk bundles.
// A redacted talk gets a new content_hash, so the Worker stores the change. The conference document's
// counts follow the talks that remain. The file is validated as the bundle build validates it (a bad
// file stops the run before anything is sent), and an entry that matches nothing in a conference's
// talk file fails that conference, as it fails the bundle build. A takedown reaches the Worker the next
// time the conference is pushed: for a conference the ingest no longer fetches, push it with --event
// (docs/FREE_HOSTING.md, Operations runbook).
// Output is counts only. Exit code: 0 when every event was pushed, 2 when one failed, 1 on a
// usage error.
//
// --report <file> writes what reached the Worker as JSON, also when the run fails part way:
//   { "upserted": [slugs whose conference document was stored],
//     "kept": [slugs whose document was held back because the schedule fetch failed],
//     "pushed": [searchable slugs whose talks, topics and facets were all stored],
//     "failed": [searchable slugs whose push failed], "not_attempted": [searchable slugs not tried] }
// ingest.yml stages the talk files of exactly these conferences for the talk bundles
// (scripts/stage-ingest-data.mjs), so the bundles of the conferences this run fetched follow what the
// Worker now serves.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, TALK_BATCH, UsageError, adminClient, chunk, drainPending, isSlug, normalizeApiBase, parseArgs, readAdminToken, readNdjson, withTopics } from './lib.mjs';
import { resolveTopics, loadStoplist } from './topics-local.mjs';
import { buildFacets, countByKind } from './facets-local.mjs';
import { MODEL } from '../../contracts/js/bundle.mjs';
import { CONVENTIONS } from '../src/lib/embed.js';
import { applyTakedowns, loadTakedowns } from '../../scripts/build-bundles.mjs';
import { contentHash } from '../../scripts/lib/hash.mjs';

const DATA = join(ROOT, 'data');

// The model block of the talk bundles (contracts/js/bundle.mjs MODEL) must be the one the Worker
// embeds under (src/lib/embed.js CONVENTIONS), or the Worker's query vectors would not match the
// bundle vectors the phones search. Throws before anything is pushed when they differ.
const MODEL_FIELDS = ['id', 'dims', 'pooling', 'normalize', 'max_tokens', 'truncation', 'document_instruction', 'document_text', 'query_instruction'];
export function assertModelBlock(model = MODEL, conventions = CONVENTIONS) {
  const differ = MODEL_FIELDS.filter((k) => model[k] !== conventions[k]);
  if (differ.length) throw new UsageError(`The Worker's embedding conventions differ from the talk bundle model block in: ${differ.join(', ')}.`);
}

function readConference(slug) {
  const path = join(DATA, slug, 'conference.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The slugs to push: the --event ones, else the "processed" list of an ingest report (the parsed
 * JSON of scripts/ingest.mjs --report), else every conference folder (`all()`). Throws UsageError
 * when both are given or the report is malformed.
 */
export function selectSlugs({ events = [], ingestReport = null, all = allSlugs }) {
  if (events.length && ingestReport) throw new UsageError('Pass --event or --events-from, not both.');
  if (events.length) return [...new Set(events)];
  if (ingestReport) {
    const list = ingestReport?.processed;
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !isSlug(s))) throw new UsageError('The --events-from report must hold a "processed" list of conference slugs.');
    return [...new Set(list)].sort();
  }
  return all();
}

function allSlugs() {
  return readdirSync(DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSlug(d.name) && existsSync(join(DATA, d.name, 'conference.json')))
    .map((d) => d.name)
    .sort();
}

const SPEAKER_FIELDS = ['speakers', 'speaker_taglines', 'speaker_profiles'];

/**
 * The talks of one conference as the Worker gets them: the takedowns of data/takedowns.json applied
 * with applyTakedowns, the function the bundle build uses. A talk whose speakers a takedown changed
 * gets its content_hash recomputed, because the Worker skips a talk whose hash it already holds.
 * Throws when an entry for this conference matches nothing (and is not marked purged).
 * Returns { talks, dropped, redacted, entries }.
 */
export function workerTalks(slug, talks, takedowns) {
  const entries = takedowns.filter((e) => e.slug === slug).length;
  if (!entries) return { talks, dropped: 0, redacted: 0, entries };
  const before = new Map(talks.map((t) => [t.talk_id, t]));
  let redacted = 0;
  const out = applyTakedowns(slug, talks, takedowns).talks.map((t) => {
    const prev = before.get(t.talk_id);
    if (SPEAKER_FIELDS.every((k) => JSON.stringify(prev[k]) === JSON.stringify(t[k]))) return prev;
    redacted++;
    return { ...t, content_hash: contentHash(t) };
  });
  return { talks: out, dropped: talks.length - out.length, redacted, entries };
}

/** The counts block of a conference document, recomputed over the talks that remain after takedowns. */
export function countsAfterTakedowns(counts, talks) {
  const next = { ...counts, sessions: talks.length, with_slides: 0, sponsor: 0 };
  for (const kind of ['talk', 'ambient', 'break', 'housekeeping']) next[kind] = 0;
  for (const t of talks) {
    if (t.kind in next) next[t.kind]++;
    if (t.has_slides) next.with_slides++;
    if (t.sponsor) next.sponsor++;
  }
  return next;
}

// Pushes one event from its prepared talks (workerTalks). Returns a one-line summary. Throws on the
// first failure.
export async function pushEvent(conf, prepared, { admin, dryRun, generation, rebuild, stop, allowShrink = false }) {
  const slug = conf.slug;
  const { talks } = prepared;
  if (talks.length === 0) return `${slug}: skipped, the talk file is empty.`;

  const topicResult = await resolveTopics(talks, { slug, admin, rebuild, stop });
  const payloadTalks = talks.map((t) => withTopics(t, topicResult.assignments.get(t.talk_id)));
  const facets = buildFacets(slug, talks);
  const batches = chunk(payloadTalks, TALK_BATCH);
  const kinds = countByKind(facets);
  const takedown = prepared.entries ? `, takedowns ${prepared.entries} (${prepared.dropped} talks dropped, ${prepared.redacted} redacted)` : '';
  const head = `${slug}: ${talks.length} talks in ${batches.length} batches, ${topicResult.topics.length} topics (${topicResult.mode}), ${facets.length} facets (${kinds.track} tracks, ${kinds.room} rooms, ${kinds.speaker} speakers, ${kinds.tag} tags)${takedown}`;
  if (dryRun) return `${head}; dry run, nothing sent.`;

  const eventQuery = `?event=${encodeURIComponent(slug)}`;
  const total = { upserted: 0, unchanged: 0, embedded: 0, pending: 0 };
  for (const batch of batches) {
    const r = await admin('POST', `/admin/talks${eventQuery}`, { generation, talks: batch });
    for (const k of Object.keys(total)) total[k] += Number(r[k]) || 0;
  }
  const pendingAfter = total.pending > 0 ? await drainPending(admin, slug) : 0;
  const fin = await admin('POST', `/admin/talks/finalize${eventQuery}`, allowShrink ? { generation, allow_shrink: true } : { generation });
  const tp = await admin('PUT', `/admin/topics${eventQuery}`, { topics: topicResult.topics });
  const fc = await admin('PUT', `/admin/facets${eventQuery}`, { facets });
  return `${head}; upserted ${total.upserted}, unchanged ${total.unchanged}, embedded ${total.embedded}, pending ${pendingAfter ?? '?'}; finalized ${fin.talks ?? '?'} talks, deleted ${fin.deleted ?? 0}, unshared ${fin.unshared ?? 0}; topics stored ${tp.topics ?? '?'}, facets stored ${fc.facets ?? '?'}.`;
}

// The slugs the Worker lists as searchable (GET /api/conferences), or an empty set when it cannot
// say, in which case nothing is kept back.
async function liveSearchable(api) {
  try {
    const res = await fetch(`${api}/api/conferences`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return new Set();
    const { conferences } = await res.json();
    return new Set((conferences ?? []).filter((c) => c?.status === 'searchable').map((c) => c.slug));
  } catch {
    return new Set();
  }
}

// What reached the Worker in this run, for --report.
const report = { upserted: [], kept: [], pushed: [], failed: [], not_attempted: [] };

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'rebuild-topics', 'allow-shrink'], values: ['api', 'report', 'events-from'], multi: ['event'] });
  reportFile = args.report ?? null;
  const api = normalizeApiBase(args.api);
  for (const e of args.event) if (!isSlug(e)) throw new UsageError('--event needs a conference slug.');
  const dryRun = args['dry-run'];
  const token = readAdminToken();
  if (!dryRun && !token) throw new UsageError('Set ADMIN_TOKEN (or ADMIN_TOKEN_FILE) to push, or pass --dry-run.');

  const ingestReport = args['events-from'] ? JSON.parse(readFileSync(args['events-from'], 'utf8')) : null;
  const slugs = selectSlugs({ events: args.event, ingestReport });
  if (ingestReport && slugs.length === 0) {
    console.log('The ingest run fetched no conference; nothing to push.');
    return 0;
  }
  const confs = [];
  for (const slug of slugs) {
    const conf = readConference(slug);
    if (!conf) throw new UsageError(`No data/${slug}/conference.json. Run scripts/ingest.mjs --event ${slug} --dry-run first.`);
    confs.push(conf);
  }
  if (!confs.length) throw new UsageError('No conferences to push.');

  // In a dry run the Worker is only asked for the frozen topic list, and only when a token exists;
  // an unreachable Worker then means "build the list from the titles".
  const admin = dryRun ? (token ? adminClient(api, token, { retries: 0, timeoutMs: 10_000 }) : null) : adminClient(api, token);
  const softAdmin = dryRun && admin
    ? async (...a) => {
        try {
          return await admin(...a);
        } catch {
          const err = new Error('unreachable');
          err.status = 404;
          throw err;
        }
      }
    : admin;
  assertModelBlock();
  const stop = loadStoplist();
  const generation = Date.now();
  // Validated before anything is sent, as the bundle build validates it.
  const takedowns = loadTakedowns(join(DATA, 'takedowns.json'), { dataDir: DATA });

  const searchable = confs.filter((c) => c.status === 'searchable' && existsSync(join(DATA, c.slug, 'talks.ndjson')));
  console.log(`Conferences: ${confs.length} selected, ${searchable.length} searchable with a talk file${dryRun ? ' (dry run)' : ''}.`);
  // The talks each conference will get, with the takedowns applied. A conference whose takedown
  // entries do not apply is not pushed (its talks stay as the Worker has them) and counts as failed.
  const prepared = new Map();
  for (const c of searchable) {
    try {
      prepared.set(c.slug, workerTalks(c.slug, readNdjson(join(DATA, c.slug, 'talks.ndjson')), takedowns));
    } catch (e) {
      prepared.set(c.slug, { error: e });
    }
  }
  const forWorker = (c) => {
    const p = prepared.get(c.slug);
    return p?.dropped ? { ...c, counts: countsAfterTakedowns(c.counts ?? {}, p.talks) } : c;
  };
  if (!dryRun) {
    // A schedule that could not be fetched this time (status_reason fetch_failed, which
    // scripts/ingest.mjs records on a transient error) must not take down a conference the Worker
    // serves: its document is left out of the upsert, so the Worker keeps the last good one.
    const live = await liveSearchable(api);
    const kept = confs.filter((c) => c.status !== 'searchable' && c.status_reason === 'fetch_failed' && live.has(c.slug));
    for (const c of kept) console.log(`${c.slug}: the schedule fetch failed; keeping the Worker's searchable document.`);
    const r = await admin('PUT', '/admin/conferences', { conferences: confs.filter((c) => !kept.includes(c)).map(forWorker) });
    console.log(`Conferences upserted: ${r.upserted ?? '?'}.`);
    report.kept = kept.map((c) => c.slug);
    report.upserted = confs.filter((c) => !kept.includes(c)).map((c) => c.slug);
  }

  let pushed = 0;
  let failed = 0;
  for (const conf of searchable) {
    try {
      const p = prepared.get(conf.slug);
      if (p.error) throw p.error;
      console.log(await pushEvent(conf, p, { admin: softAdmin, dryRun, generation, rebuild: args['rebuild-topics'], stop, allowShrink: args['allow-shrink'] }));
      pushed++;
      if (!dryRun) report.pushed.push(conf.slug);
    } catch (e) {
      failed++;
      if (!dryRun) report.failed.push(conf.slug);
      console.log(`${conf.slug}: FAILED, ${e.message}`);
      if (e.status === 503) break; // The daily limit is reached; the other events would fail the same way.
    }
  }
  console.log(`Events ${dryRun ? 'checked' : 'pushed'}: ${pushed}, failed: ${failed}, not attempted: ${searchable.length - pushed - failed}.`);
  if (!dryRun) report.not_attempted = searchable.map((c) => c.slug).filter((s) => !report.pushed.includes(s) && !report.failed.includes(s));
  return failed ? 2 : 0;
}

let reportFile = null;
function writeReport() {
  if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      writeReport();
      process.exitCode = code;
    },
    (e) => {
      writeReport();
      console.error(e.message);
      process.exitCode = e instanceof UsageError ? 1 : 2;
    },
  );
}
