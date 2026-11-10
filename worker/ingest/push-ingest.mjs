// Pushes the talk files built by scripts/ingest.mjs (the discovery step, run with --dry-run so it
// touches no Elasticsearch) to the Worker's admin routes.
//
// Usage:
//   node worker/ingest/push-ingest.mjs --api <base> [--event <slug> ...] [--dry-run] [--rebuild-topics]
// Env: ADMIN_TOKEN, or ADMIN_TOKEN_FILE naming a file that holds it (not needed with --dry-run).
//
// Steps:
// 1. PUT /admin/conferences with the conference documents of the selected events (all events with
//    a data/{slug}/conference.json when none is named).
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
// Output is counts only. Exit code: 0 when every event was pushed, 2 when one failed, 1 on a
// usage error.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, TALK_BATCH, UsageError, adminClient, chunk, drainPending, isSlug, normalizeApiBase, parseArgs, readAdminToken, readNdjson, withTopics } from './lib.mjs';
import { resolveTopics, loadStoplist } from './topics-local.mjs';
import { buildFacets, countByKind } from './facets-local.mjs';

const DATA = join(ROOT, 'data');

function readConference(slug) {
  const path = join(DATA, slug, 'conference.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allSlugs() {
  return readdirSync(DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSlug(d.name) && existsSync(join(DATA, d.name, 'conference.json')))
    .map((d) => d.name)
    .sort();
}

// Pushes one event. Returns a one-line summary. Throws on the first failure.
async function pushEvent(conf, { admin, dryRun, generation, rebuild, stop }) {
  const slug = conf.slug;
  const talks = readNdjson(join(DATA, slug, 'talks.ndjson'));
  if (talks.length === 0) return `${slug}: skipped, the talk file is empty.`;

  const topicResult = await resolveTopics(talks, { slug, admin, rebuild, stop });
  const payloadTalks = talks.map((t) => withTopics(t, topicResult.assignments.get(t.talk_id)));
  const facets = buildFacets(slug, talks);
  const batches = chunk(payloadTalks, TALK_BATCH);
  const kinds = countByKind(facets);
  const head = `${slug}: ${talks.length} talks in ${batches.length} batches, ${topicResult.topics.length} topics (${topicResult.mode}), ${facets.length} facets (${kinds.track} tracks, ${kinds.room} rooms, ${kinds.speaker} speakers, ${kinds.tag} tags)`;
  if (dryRun) return `${head}; dry run, nothing sent.`;

  const eventQuery = `?event=${encodeURIComponent(slug)}`;
  const total = { upserted: 0, unchanged: 0, embedded: 0, pending: 0 };
  for (const batch of batches) {
    const r = await admin('POST', `/admin/talks${eventQuery}`, { generation, talks: batch });
    for (const k of Object.keys(total)) total[k] += Number(r[k]) || 0;
  }
  const pendingAfter = total.pending > 0 ? await drainPending(admin, slug) : 0;
  const fin = await admin('POST', `/admin/talks/finalize${eventQuery}`, { generation });
  const tp = await admin('PUT', `/admin/topics${eventQuery}`, { topics: topicResult.topics });
  const fc = await admin('PUT', `/admin/facets${eventQuery}`, { facets });
  return `${head}; upserted ${total.upserted}, unchanged ${total.unchanged}, embedded ${total.embedded}, pending ${pendingAfter ?? '?'}; finalized ${fin.talks ?? '?'} talks, deleted ${fin.deleted ?? 0}; topics stored ${tp.topics ?? '?'}, facets stored ${fc.facets ?? '?'}.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'rebuild-topics'], values: ['api'], multi: ['event'] });
  const api = normalizeApiBase(args.api);
  for (const e of args.event) if (!isSlug(e)) throw new UsageError('--event needs a conference slug.');
  const dryRun = args['dry-run'];
  const token = readAdminToken();
  if (!dryRun && !token) throw new UsageError('Set ADMIN_TOKEN (or ADMIN_TOKEN_FILE) to push, or pass --dry-run.');

  const slugs = args.event.length ? [...new Set(args.event)] : allSlugs();
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
  const stop = loadStoplist();
  const generation = Date.now();

  const searchable = confs.filter((c) => c.status === 'searchable' && existsSync(join(DATA, c.slug, 'talks.ndjson')));
  console.log(`Conferences: ${confs.length} selected, ${searchable.length} searchable with a talk file${dryRun ? ' (dry run)' : ''}.`);
  if (!dryRun) {
    const r = await admin('PUT', '/admin/conferences', { conferences: confs });
    console.log(`Conferences upserted: ${r.upserted ?? '?'}.`);
  }

  let pushed = 0;
  let failed = 0;
  for (const conf of searchable) {
    try {
      console.log(await pushEvent(conf, { admin: softAdmin, dryRun, generation, rebuild: args['rebuild-topics'], stop }));
      pushed++;
    } catch (e) {
      failed++;
      console.log(`${conf.slug}: FAILED, ${e.message}`);
      if (e.status === 503) break; // The daily limit is reached; the other events would fail the same way.
    }
  }
  console.log(`Events ${dryRun ? 'checked' : 'pushed'}: ${pushed}, failed: ${failed}, not attempted: ${searchable.length - pushed - failed}.`);
  return failed ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      console.error(e.message);
      process.exitCode = e instanceof UsageError ? 1 : 2;
    },
  );
}
