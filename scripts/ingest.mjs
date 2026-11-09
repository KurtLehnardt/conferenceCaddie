// Discovers Linux Foundation events, imports their Sessionize schedules and indexes the talks.
//
// Usage:
//   node scripts/ingest.mjs --list
//   node scripts/ingest.mjs --event <slug> [--event <slug> ...] [options]
//   node scripts/ingest.mjs --all-upcoming [options]
// Options:
//   --index <name>              talks index or alias (default ES_INDEX or caddie-talks)
//   --conferences-index <name>  conferences index or alias (default ES_CONFERENCES_INDEX or caddie-conferences)
//   --dry-run                   fetch, build and write files; index nothing
//   --no-fetch                  build from the committed data/raw files; no network call at all
//   --skip-topics               do not run scripts/topics.mjs after an event is indexed
// Env: ES_URL, ES_API_KEY or ELASTISEARCH_API_KEY (needed only to index, or to show dry-run counts).
//
// Exit codes: 0 when every event ended searchable or unavailable for a non-error reason; 1 on a fatal
// error; 2 when the run stopped at the embedding limit or an event ended partial_index or fetch_failed.
// Node built-ins only.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchOnce, networkCalls } from './lib/http.mjs';
import { LF_LIST_URL, deriveEvents, extractSchedConfig, locationLabel } from './lib/lf.mjs';
import { feedIds, viewAllUrl, apiDataUrl, parseViewAll } from './lib/sessionize.mjs';
import { loadZoneTables, resolveTimeZone } from './lib/zones.mjs';
import { buildTalks } from './lib/classify.mjs';
import { hasKey, es, existingHashes, runBulk } from './lib/es.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class Fatal extends Error {}
function fail(message) {
  throw new Fatal(message);
}

// ---------- Arguments ----------
const argv = process.argv.slice(2);
const opts = {
  modes: [],
  events: [],
  index: process.env.ES_INDEX || 'caddie-talks',
  confIndex: process.env.ES_CONFERENCES_INDEX || 'caddie-conferences',
  dryRun: false,
  noFetch: false,
  skipTopics: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) usage(`${a} needs a value.`);
    return v;
  };
  if (a === '--list' || a === '--all-upcoming') opts.modes.push(a);
  else if (a === '--event') { opts.modes.push(a); opts.events.push(value()); }
  else if (a === '--index') opts.index = value();
  else if (a === '--conferences-index') opts.confIndex = value();
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--no-fetch') opts.noFetch = true;
  else if (a === '--skip-topics') opts.skipTopics = true;
  else usage(`Unknown argument: ${a}`);
}
const mode = [...new Set(opts.modes)];
if (mode.length !== 1) usage('Choose exactly one of --list, --event <slug> or --all-upcoming.');

function usage(message) {
  console.error(message);
  console.error('Usage: node scripts/ingest.mjs --list | --event <slug> [--event <slug> ...] | --all-upcoming');
  console.error('       [--index name] [--conferences-index name] [--dry-run] [--no-fetch] [--skip-topics]');
  process.exit(1);
}

// ---------- Raw file access ----------
const writeFile = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

// Returns { text } on success or { error } on a failed fetch. With --no-fetch it reads the committed
// raw file instead, and a missing file is fatal.
async function getRaw(url, rawPath) {
  if (opts.noFetch) {
    if (!existsSync(rawPath)) fail(`--no-fetch: the raw file ${rawPath.slice(root.length + 1)} is missing.`);
    return { text: readFileSync(rawPath, 'utf8') };
  }
  const res = await fetchOnce(url);
  if (!res.ok) return { error: `${url}: ${res.error}` };
  writeFile(rawPath, res.text);
  return { text: res.text };
}

// ---------- Event processing ----------
const zones = loadZoneTables(root);
const feedOwner = new Map(); // apiCode -> slug of the first event in this run that used it

function emptyCounts() {
  return { sessions: 0, talk: 0, ambient: 0, break: 0, housekeeping: 0, with_slides: 0, sponsor: 0 };
}

function previousRawFetchedAt(slug, rawDir) {
  try {
    const prev = JSON.parse(readFileSync(join(root, 'data', slug, 'conference.json'), 'utf8'));
    if (prev.raw_fetched_at) return prev.raw_fetched_at;
  } catch { /* no previous document */ }
  try {
    return statSync(join(rawDir, 'lf-event.json')).mtime.toISOString();
  } catch {
    return null;
  }
}

// Returns { conf, summary, stop } where stop is true when the embedding limit was hit.
async function processEvent(ev) {
  const rawDir = join(root, 'data/raw', ev.slug);
  const outDir = join(root, 'data', ev.slug);
  const lines = [];
  const conf = {
    slug: ev.slug,
    name: ev.name,
    status: 'unavailable',
    status_reason: null,
    source: 'sessionize',
    start_date: ev.start_date,
    end_date: ev.end_date,
    time_zone: null,
    time_zone_windows: null,
    location: ev.location,
    sessionize_api_code: null,
    sessionize_public_slug: null,
    sessionize_site_published: false,
    lf_event_id: ev.lf_event_id,
    lf_url: ev.lf_url,
    official_schedule_url: ev.official_schedule_url,
    parent_slug: null,
    category_mapping: null,
    counts: emptyCounts(),
    ingested_at: null,
    raw_fetched_at: opts.noFetch ? previousRawFetchedAt(ev.slug, rawDir) : new Date().toISOString(),
  };
  if (!opts.noFetch) writeJson(join(rawDir, 'lf-event.json'), ev.raw);

  const unavailable = (reason, detail) => {
    conf.status = 'unavailable';
    conf.status_reason = reason;
    if (detail) lines.push(`  ${detail}`);
    // Built talks from an earlier run would no longer match this event's state.
    rmSync(join(outDir, 'talks.ndjson'), { force: true });
    return { conf, lines, stop: false };
  };

  if (!ev.cta_schedule_url) return unavailable('no_schedule_url', 'The LF list has no schedule URL for this event.');

  const page = await getRaw(ev.cta_schedule_url, join(rawDir, 'schedule-page.html'));
  if (page.error) return unavailable('fetch_failed', page.error);
  let config;
  try {
    config = extractSchedConfig(page.text);
  } catch (e) {
    return unavailable('fetch_failed', `The schedule page has a data-sched-config that does not parse: ${e.message}`);
  }
  if (!config) return unavailable('no_sched_config', 'The schedule page has no data-sched-config (not a Sessionize embed).');
  if (!opts.noFetch) writeJson(join(rawDir, 'sched-config.json'), config);

  const ids = feedIds(config);
  if (!ids) return unavailable('no_sched_config', 'The data-sched-config has no usable sessionizeApiCode and sessionizePublicSlug.');
  conf.sessionize_api_code = ids.apiCode;
  conf.sessionize_public_slug = ids.publicSlug;

  if (feedOwner.has(ids.apiCode)) {
    conf.parent_slug = feedOwner.get(ids.apiCode);
    return unavailable('shares_feed', `Shares its Sessionize feed with ${conf.parent_slug}.`);
  }
  feedOwner.set(ids.apiCode, ev.slug);

  const viewAll = await getRaw(viewAllUrl(ids.apiCode), join(rawDir, 'view-all.json'));
  if (viewAll.error) return unavailable('fetch_failed', viewAll.error);
  let feed;
  try {
    feed = parseViewAll(viewAll.text);
  } catch (e) {
    return unavailable('fetch_failed', `view/All does not parse: ${e.message}`);
  }

  const apiData = await getRaw(apiDataUrl(ids.publicSlug), join(rawDir, 'api-data.json'));
  if (apiData.error) return unavailable('fetch_failed', apiData.error);
  let apiDataJson;
  try {
    apiDataJson = JSON.parse(apiData.text);
  } catch (e) {
    return unavailable('fetch_failed', `api/data does not parse: ${e.message}`);
  }

  const tz = resolveTimeZone(ev.slug, apiDataJson, zones);
  conf.time_zone = tz.time_zone;
  conf.time_zone_windows = tz.time_zone_windows;
  conf.sessionize_site_published = tz.published;
  if (tz.reason) return unavailable(tz.reason, tz.message);
  if (tz.message) lines.push(`  ${tz.message}`);

  const built = buildTalks(feed, config, conf);
  if (built.unresolved.length) {
    fail(`${ev.slug}: ${built.unresolved.length} feed ids do not resolve, for example ${built.unresolved.slice(0, 3).join('; ')}.`);
  }
  conf.category_mapping = built.mapping;
  conf.counts = built.counts;
  writeFile(join(outDir, 'talks.ndjson'), built.docs.map((d) => JSON.stringify(d)).join('\n') + '\n');

  const c = built.counts;
  lines.push(
    `  feed ${ids.apiCode}: ${c.sessions} sessions (talk ${c.talk}, ambient ${c.ambient}, break ${c.break}, housekeeping ${c.housekeeping}), slides ${c.with_slides}, sponsor ${c.sponsor}`
  );
  const m = built.mapping;
  lines.push(`  groups: track "${m.track_group}", level ${m.level_group ? `"${m.level_group}"` : 'none'}, tags [${m.tag_groups.join(', ')}], hidden [${m.hidden_groups.join(', ')}], slides question ${m.slides_question ? `"${m.slides_question}"` : 'none'}`);

  // Plan against what the index already holds, so unchanged sessions are never re-embedded.
  let existing = null;
  if (!opts.dryRun) {
    existing = await existingHashes(opts.index, ev.slug);
    if (existing === null) fail(`The index ${opts.index} does not exist. Create it with scripts/es-setup.mjs first.`);
  } else if (hasKey()) {
    try {
      existing = await existingHashes(opts.index, ev.slug);
    } catch (e) {
      lines.push(`  (index ${opts.index} not readable: ${e.message})`);
    }
  }

  conf.status = 'searchable';
  conf.status_reason = null;
  if (existing === null) {
    lines.push('  index: not compared (dry run without a readable index)');
    return { conf, lines, stop: false };
  }

  const plan = planOps(built.docs, existing);
  const p = plan.counts;
  const verb = opts.dryRun ? 'would index' : 'index';
  lines.push(`  ${verb}: ${p.new} new, ${p.updated} updated, ${p.unchanged} unchanged, ${p.deleted} deleted`);
  lines.push(`  bulk ops: ${plan.ops.filter((o) => o.action === 'index').length} index (model calls), ${plan.ops.filter((o) => o.action === 'update').length} update (no model call), ${p.deleted} delete`);
  if (opts.dryRun) return { conf, lines, stop: false };

  const now = new Date().toISOString();
  for (const op of plan.ops) if (op.doc) op.doc.ingested_at = now;
  const result = await runBulk(opts.index, plan.ops);
  await es('POST', `/${encodeURIComponent(opts.index)}/_refresh`);
  conf.ingested_at = now;
  for (const f of result.failures.slice(0, 10)) lines.push(`  failed ${f.action} ${f.id} (${f.status}) ${f.reason}`);
  if (result.limit) {
    conf.status = 'unavailable';
    conf.status_reason = 'embedding_limit';
    lines.push(`  stopped: ${result.limit}`);
    lines.push(`  done before the stop: ${result.ok.index} index, ${result.ok.update} update, ${result.ok.delete} delete`);
    return { conf, lines, stop: true };
  }
  if (result.failures.length) {
    conf.status = 'unavailable';
    conf.status_reason = 'partial_index';
    lines.push(`  ${result.failures.length} operations failed`);
  }
  return { conf, lines, stop: false };
}

// Per document: absent -> index; same content_hash -> skip; same text_hash only -> bulk partial
// update without title and abstract (reuses the stored embeddings); otherwise -> index.
// Stored ids missing from the feed -> delete.
function planOps(docs, existing) {
  const ops = [];
  const counts = { new: 0, updated: 0, unchanged: 0, deleted: 0 };
  const seen = new Set();
  for (const doc of docs) {
    seen.add(doc.talk_id);
    const prev = existing.get(doc.talk_id);
    if (!prev) {
      counts.new++;
      ops.push({ action: 'index', id: doc.talk_id, doc: { ...doc } });
    } else if (prev.content_hash === doc.content_hash) {
      counts.unchanged++;
    } else if (prev.text_hash === doc.text_hash) {
      counts.updated++;
      const { title, abstract, ...rest } = doc;
      ops.push({ action: 'update', id: doc.talk_id, doc: rest });
    } else {
      counts.updated++;
      ops.push({ action: 'index', id: doc.talk_id, doc: { ...doc } });
    }
  }
  for (const id of existing.keys()) {
    if (!seen.has(id)) {
      counts.deleted++;
      ops.push({ action: 'delete', id });
    }
  }
  return { ops, counts };
}

async function writeConference(conf) {
  writeJson(join(root, 'data', conf.slug, 'conference.json'), conf);
  if (opts.dryRun) return;
  const { status, json } = await es('PUT', `/${encodeURIComponent(opts.confIndex)}/_doc/${encodeURIComponent(conf.slug)}?refresh=wait_for`, conf);
  if (status >= 300) fail(`Writing the conference document for ${conf.slug} to ${opts.confIndex} failed with status ${status}: ${json?.error?.type ?? ''}`);
}

// ======================= TOPICS HOOK =======================
// After an event is indexed and searchable, the topic list for that conference is rebuilt by
// "node scripts/topics.mjs --event <slug> --talks-index <index>", where the index is the one this run
// wrote to. A topics failure prints a warning and does not change the exit code.
// Pass --skip-topics to leave it out.
function runTopicsHook(slug) {
  const script = join(root, 'scripts/topics.mjs');
  if (opts.skipTopics) return '  topics: skipped (--skip-topics)';
  if (!existsSync(script)) return '  topics: skipped, scripts/topics.mjs is not present';
  const res = spawnSync(process.execPath, [script, '--event', slug, '--talks-index', opts.index], {
    stdio: 'inherit',
    env: { ...process.env, ES_INDEX: opts.index },
  });
  return res.status === 0 ? '  topics: rebuilt' : `  topics: scripts/topics.mjs failed with exit code ${res.status}`;
}
// ===========================================================

// ---------- Main ----------
async function main() {
  if (!opts.dryRun && mode[0] !== '--list' && !hasKey()) fail('Set ES_API_KEY or ELASTISEARCH_API_KEY to index, or pass --dry-run.');

  const listPath = join(root, 'data/raw/lf-events-upcoming.json');
  const listRaw = await getRaw(LF_LIST_URL, listPath);
  if (listRaw.error) fail(`Fetching the LF event list failed: ${listRaw.error}`);
  let events;
  try {
    events = deriveEvents(JSON.parse(listRaw.text));
  } catch (e) {
    fail(e.message);
  }

  if (mode[0] === '--list') {
    for (const ev of events) {
      console.log(`${ev.slug} | ${ev.start_date}..${ev.end_date} | ${locationLabel(ev.location)} | schedule: ${ev.cta_schedule_url ? 'yes' : 'no'}`);
    }
    return 0;
  }

  let selected;
  if (mode[0] === '--event') {
    const known = new Set(events.map((e) => e.slug));
    const unknown = opts.events.filter((s) => !known.has(s));
    if (unknown.length) fail(`Not in the upcoming LF list: ${unknown.join(', ')}. Run --list to see the slugs.`);
    const wanted = new Set(opts.events);
    selected = events.filter((e) => wanted.has(e.slug)); // list order
  } else {
    selected = events;
  }

  const results = [];
  const missing = [];
  let stopped = false;
  for (const ev of selected) {
    if (stopped) { missing.push(ev.slug); continue; }
    const r = await processEvent(ev);
    await writeConference(r.conf);
    console.log(`${ev.slug}  ${ev.name}  ${ev.start_date}..${ev.end_date}  ${r.conf.time_zone ?? "no time zone"}`);
    for (const l of r.lines) console.log(l);
    if (!opts.dryRun && r.conf.status === 'searchable') console.log(runTopicsHook(ev.slug));
    console.log(`  status: ${r.conf.status}${r.conf.status_reason ? ` (${r.conf.status_reason})` : ''}`);
    results.push(r.conf);
    if (r.stop) { stopped = true; missing.push(ev.slug); }
  }

  const unavailable = results.filter((c) => c.status !== 'searchable');
  console.log(`Searchable: ${results.length - unavailable.length}  Unavailable: ${unavailable.length}`);
  for (const c of unavailable) console.log(`  ${c.slug}: ${c.status_reason}`);
  if (stopped) console.log(`Stopped at the embedding limit. Missing events: ${missing.join(', ')}`);
  console.log(`Network calls this run: ${networkCalls()}`);

  const errorReasons = new Set(['embedding_limit', 'partial_index', 'fetch_failed']);
  return stopped || unavailable.some((c) => errorReasons.has(c.status_reason)) ? 2 : 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof Fatal) {
    console.error(`Fatal: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
