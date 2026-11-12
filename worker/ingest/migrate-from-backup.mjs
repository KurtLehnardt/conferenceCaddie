// One-time migration of an Elasticsearch backup (data/exports/backup-*, written by the export
// before the move) to the Worker, through the admin routes.
//
// Usage:
//   node worker/ingest/migrate-from-backup.mjs --backup <dir> --api <base>
//        [--only conferences,talks,topics,facets,people,reports,rules] [--dry-run] [--include-real]
// Env: ADMIN_TOKEN, or ADMIN_TOKEN_FILE naming a file that holds it (not needed with --dry-run).
//
// What is copied, and how:
// - conferences from caddie-conferences-v1;
// - talks from caddie-talks-v3 (the live alias target; caddie-talks-v2 is ignored) with their
//   existing topics, one generation per run, then a finalize per conference;
// - topics from caddie-topics-v1 and facets from caddie-facets-v1, as they are, so topic ids stay
//   identical (facets carry their _id as `id`);
// - people from caddie-people-v2 only (caddie-people-v1 is stale and never read), skipping rows
//   whose visible_until has passed. By default only rows with sample: true are copied. The other
//   rows belong to devices on the Cloud Run origin; browser storage is per origin, so no device on
//   the new origin holds their secrets and their owners could never edit or delete them. Pass
//   --include-real to copy them anyway. secret_hash travels with every copied row. Only an allow
//   list of profile fields is sent: presence, location and Bluetooth fields are never copied;
// - reports from caddie-people-reports-v1, only profile and spot reports whose target profile was
//   copied (the Worker re-keys target_id to the new ref). The others are not sent;
// - rules: the rules of caddie-people-rules-v1 are compared with the ones compiled from
//   config/moderation-words.json. Nothing is sent; the word list in the repository stays the source.
// Blocks, meets, push subscriptions and nudges are empty in the backup and are not migrated.
//
// The backup is read from the git-ignored data/exports/ and personal data travels only to the
// admin endpoint. The script prints counts per table only: no names, texts, hashes or emails.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PEOPLE_BATCH, REPORT_BATCH, ROOT, TALK_BATCH, UsageError, adminClient, chunk, drainPending, isSlug, normalizeApiBase,
  parseArgs, readAdminToken, readNdjson, withTopics,
} from './lib.mjs';

const TABLES = ['conferences', 'talks', 'topics', 'facets', 'people', 'reports', 'rules'];

// The only profile fields that leave the backup. Presence, location and Bluetooth fields
// (presence_*, ble_*) and spot_hidden are not in the list on purpose.
const PERSON_FIELDS = [
  'profile_id', 'event_id', 'secret_hash', 'ref', 'display_name', 'about', 'expertise', 'interests', 'speak_topics',
  'learn_topics', 'shared_talk_ids', 'open_to_meet', 'contact_note', 'linkedin_url', 'visible_until', 'updated_at',
  'text_hash', 'sample', 'hidden',
];

export function personPayload(row) {
  const out = {};
  for (const f of PERSON_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

const dropId = ({ _id, ...rest }) => rest;

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// The rule ids that scripts/moderation-rules.mjs derives from config/moderation-words.json: a
// prefix for the kind and the first ten hex digits of the sha256 of the entry.
export function configRuleIds() {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'config', 'moderation-words.json'), 'utf8'));
  const ids = new Set();
  for (const raw of Array.isArray(parsed.words) ? parsed.words : []) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith('re:') && !entry.slice(3).trim()) continue;
    const prefix = entry.startsWith('re:') ? 're' : 'w';
    ids.add(`${prefix}-${createHash('sha256').update(entry).digest('hex').slice(0, 10)}`);
  }
  return ids;
}

// Builds everything that would be sent, from the backup directory. Pure: no network.
export function plan(backup, { include, includeReal, now = Date.now() }) {
  const file = (name, optional = false) => readNdjson(join(backup, `${name}.ndjson`), { optional });
  const out = {};

  if (include.has('conferences')) {
    const rows = file('caddie-conferences-v1');
    out.conferences = { read: rows.length, send: rows.map(dropId) };
  }

  if (include.has('talks')) {
    const rows = file('caddie-talks-v3');
    const byConf = groupBy(rows.map(dropId).map((t) => withTopics(t)), 'conference');
    out.talks = { read: rows.length, send: rows.length, byConf, batches: [...byConf.values()].reduce((n, l) => n + chunk(l, TALK_BATCH).length, 0) };
  }

  if (include.has('topics')) {
    const rows = file('caddie-topics-v1').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    out.topics = { read: rows.length, byConf: groupBy(rows.map(dropId), 'conference') };
  }

  if (include.has('facets')) {
    const rows = file('caddie-facets-v1');
    out.facets = { read: rows.length, byConf: groupBy(rows.map(({ _id, ...rest }) => ({ id: _id, ...rest })), 'conference') };
  }

  // People are always read when reports are wanted, because the reports depend on who is copied.
  let copied = new Set();
  if (include.has('people') || include.has('reports')) {
    const rows = file('caddie-people-v2');
    const live = rows.filter((r) => !(Date.parse(r.visible_until) <= now));
    const wanted = live.filter((r) => includeReal || r.sample === true);
    copied = new Set(wanted.map((r) => `${r.event_id}\0${r.profile_id}`));
    if (include.has('people')) {
      out.people = {
        read: rows.length,
        expired: rows.length - live.length,
        realSkipped: live.length - wanted.length,
        send: wanted.length,
        byEvent: groupBy(wanted.map(personPayload), 'event_id'),
      };
    }
  }

  if (include.has('reports')) {
    const rows = file('caddie-people-reports-v1');
    const send = rows.filter((r) => (r.target_kind === 'profile' || r.target_kind === 'spot') && copied.has(`${r.event_id}\0${r.target_profile_id}`));
    out.reports = { read: rows.length, send: send.length, byEvent: groupBy(send.map(dropId), 'event_id') };
  }

  if (include.has('rules')) {
    const backupIds = new Set(file('caddie-people-rules-v1').map((r) => r._id));
    const config = configRuleIds();
    const matched = [...backupIds].filter((id) => config.has(id)).length;
    out.rules = { backup: backupIds.size, config: config.size, matched, differ: backupIds.size - matched + (config.size - matched) };
  }
  return out;
}

function describePlan(p, { dryRun, includeReal }) {
  const lines = [];
  const verb = dryRun ? 'to send' : 'sending';
  if (p.conferences) lines.push(`conferences: ${p.conferences.read} read, ${p.conferences.send.length} ${verb}`);
  if (p.talks) lines.push(`talks: ${p.talks.read} read, ${p.talks.send} ${verb} for ${p.talks.byConf.size} conferences in ${p.talks.batches} batches of at most ${TALK_BATCH}`);
  if (p.topics) lines.push(`topics: ${p.topics.read} read, ${p.topics.read} ${verb} for ${p.topics.byConf.size} conferences`);
  if (p.facets) lines.push(`facets: ${p.facets.read} read, ${p.facets.read} ${verb} for ${p.facets.byConf.size} conferences`);
  if (p.people) {
    lines.push(`people: ${p.people.read} read, ${p.people.expired} expired, ${p.people.send} ${includeReal ? '' : 'sample '}${verb}, ${p.people.realSkipped} real skipped${includeReal ? ' (--include-real is on)' : ' (--include-real copies them)'}`);
  }
  if (p.reports) lines.push(`reports: ${p.reports.read} read, ${p.reports.send} ${verb}`);
  if (p.rules) lines.push(`rules: ${p.rules.backup} in the backup, ${p.rules.config} in config/moderation-words.json, ${p.rules.matched} matched, ${p.rules.differ} differ`);
  return lines;
}

// Sends the plan. A conference the Worker skipped as removed (skipped_retired in the answer to
// PUT /admin/conferences, a tombstone of DELETE /admin/conference) is logged by name and none of
// its talks, topics, facets, people or reports is sent, because a removal must not be undone by a
// re-run of the migration. A conference whose object answers 400 "conference is not available"
// (it holds no conference document: never searchable, its document did not reach it, or it was
// removed) is likewise logged by name and skipped from then on, and the run carries on with the
// others instead of stopping at the first. Returns the lines to print.
export async function send(p, admin) {
  const generation = Date.now();
  const q = (slug) => `?event=${encodeURIComponent(slug)}`;
  const lines = [];
  const skip = new Set();
  // Runs fn(slug, value) for every entry of the map whose conference is not skipped. A 400
  // "conference is not available" skips that conference for the rest of the run.
  const each = async (map, fn) => {
    for (const [slug, value] of map) {
      if (skip.has(slug)) continue;
      try {
        await fn(slug, value);
      } catch (e) {
        if (!(e?.status === 400 && /conference is not available/.test(String(e.message)))) throw e;
        skip.add(slug);
        lines.push(`${slug}: skipped, the Worker answered that the conference is not available (its object holds no conference document); nothing more of it is sent.`);
      }
    }
  };

  if (p.conferences) {
    const r = await admin('PUT', '/admin/conferences', { conferences: p.conferences.send });
    lines.push(`conferences: upserted ${r.upserted ?? '?'}`);
    for (const slug of Array.isArray(r.skipped_retired) ? r.skipped_retired : []) {
      if (typeof slug !== 'string' || !isSlug(slug) || skip.has(slug)) continue;
      skip.add(slug);
      lines.push(`${slug}: skipped, the Worker holds it as removed (DELETE /admin/conference); nothing of it is sent. To bring it back, run caddie-admin conferences unretire --event ${slug}.`);
    }
  }
  if (p.talks) {
    const sum = { upserted: 0, unchanged: 0, embedded: 0, pending: 0, deleted: 0 };
    await each(p.talks.byConf, async (slug, talks) => {
      for (const batch of chunk(talks, TALK_BATCH)) {
        const r = await admin('POST', `/admin/talks${q(slug)}`, { generation, talks: batch });
        for (const k of ['upserted', 'unchanged', 'embedded', 'pending']) sum[k] += Number(r[k]) || 0;
      }
      if (sum.pending > 0) await drainPending(admin, slug);
      const f = await admin('POST', `/admin/talks/finalize${q(slug)}`, { generation });
      sum.deleted += Number(f.deleted) || 0;
    });
    lines.push(`talks: upserted ${sum.upserted}, unchanged ${sum.unchanged}, embedded ${sum.embedded}, pending ${sum.pending}, deleted by finalize ${sum.deleted}`);
  }
  if (p.topics) {
    let stored = 0;
    await each(p.topics.byConf, async (slug, topics) => {
      stored += Number((await admin('PUT', `/admin/topics${q(slug)}`, { topics })).topics) || 0;
    });
    lines.push(`topics: stored ${stored}`);
  }
  if (p.facets) {
    let stored = 0;
    await each(p.facets.byConf, async (slug, facets) => {
      stored += Number((await admin('PUT', `/admin/facets${q(slug)}`, { facets })).facets) || 0;
    });
    lines.push(`facets: stored ${stored}`);
  }
  if (p.people) {
    const sum = { upserted: 0, skipped: 0, embedded: 0, pending: 0 };
    await each(p.people.byEvent, async (slug, people) => {
      for (const batch of chunk(people, PEOPLE_BATCH)) {
        const r = await admin('POST', `/admin/people${q(slug)}`, { people: batch });
        for (const k of Object.keys(sum)) sum[k] += Number(r[k]) || 0;
      }
      if (sum.pending > 0) await drainPending(admin, slug);
    });
    lines.push(`people: upserted ${sum.upserted}, skipped ${sum.skipped}, embedded ${sum.embedded}, pending ${sum.pending}`);
  }
  if (p.reports) {
    const sum = { inserted: 0, skipped: 0 };
    await each(p.reports.byEvent, async (slug, reports) => {
      for (const batch of chunk(reports, REPORT_BATCH)) {
        const r = await admin('POST', `/admin/reports${q(slug)}`, { reports: batch });
        for (const k of Object.keys(sum)) sum[k] += Number(r[k]) || 0;
      }
    });
    lines.push(`reports: inserted ${sum.inserted}, skipped ${sum.skipped}`);
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'include-real'], values: ['backup', 'api', 'only'] });
  if (!args.backup) throw new UsageError('--backup <dir> is required.');
  const api = normalizeApiBase(args.api);
  const backup = resolve(args.backup);
  if (!existsSync(backup)) throw new UsageError('The backup directory does not exist.');

  const only = args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : TABLES;
  const bad = only.filter((t) => !TABLES.includes(t));
  if (bad.length) throw new UsageError(`Unknown table in --only: ${bad.join(', ')}. Known: ${TABLES.join(', ')}.`);
  const dryRun = args['dry-run'];
  const token = readAdminToken();
  if (!dryRun && !token) throw new UsageError('Set ADMIN_TOKEN (or ADMIN_TOKEN_FILE) to migrate, or pass --dry-run.');

  const p = plan(backup, { include: new Set(only), includeReal: args['include-real'] });
  for (const line of describePlan(p, { dryRun, includeReal: args['include-real'] })) console.log(line);
  if (dryRun) {
    console.log('Dry run: nothing was sent.');
    return 0;
  }
  for (const line of await send(p, adminClient(api, token))) console.log(line);
  console.log('Done.');
  return 0;
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
