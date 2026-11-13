// The local-file steps of `conferences hide`, `unhide`, `remove` and `unretire`, shared by every
// backend tier. A hidden or removed conference needs a record the weekly ingest and the Pages
// bundle build can read, because both rewrite data/<slug>/conference.json for every upcoming
// Linux Foundation event (docs/BUNDLES.md, "Retiring a conference"):
//
// - data/<slug>/conference.json is rewritten on disk: hide sets status 'unavailable' with
//   status_reason 'operator_hidden'; remove sets 'operator_removed' and keeps the file, so the
//   next pages.yml build drops the conference from the bundle index; unhide restores 'searchable'
//   when the talk file is present. Each write carries raw_fetched_at now, which is later than the
//   live record, as the bundle rule requires.
// - data/conference-operator.json records the state: { "hidden": { "<slug>": { "reason", "since",
//   "previous": { "status", "status_reason" } } }, "removed": { "<slug>": { "since" } } }; unhide
//   restores the status the conference had before the hide. scripts/ingest.mjs reads it: a hidden slug is written
//   as operator_hidden again, a removed slug is skipped until `conferences unretire`.
// - data/conference-overrides.json (time zones, scripts/lib/zones.mjs) is never read or written here.
//
// withConferenceFiles(adapter, { root, now }) wraps a tier adapter: the local files are read and
// validated first (a malformed file stops the command before anything is touched), then the
// backend call is the adapter's, then the files are written, only in mode 'run', and only after
// the backend call succeeded, so a failed backend write leaves the repository untouched.
// CADDIE_ADMIN_ROOT points the tests at a temporary repository root.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminError, NotFoundError, UsageError } from '../errors.mjs';
import { readDemoConfig, buildDemo, demoToday } from '../../lib/demo-conference.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OPERATOR_FILE = 'data/conference-operator.json';
const HIDDEN = 'operator_hidden';
const REMOVED = 'operator_removed';

export function adminRoot(env = {}) {
  return env.CADDIE_ADMIN_ROOT ? resolve(env.CADDIE_ADMIN_ROOT) : REPO_ROOT;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A key that PUT /admin/conferences reads as an instruction rather than a conference field:
// "unretire" or "expect_status", or one that differs from either only in letter case or
// surrounding whitespace, which the Worker refuses with 400 ("the key must be written exactly as
// ..."; worker/src/directory.js #upsert). A conference document never carries one on purpose.
export const isControlKey = (key) => ['unretire', 'expect_status'].includes(key.trim().toLowerCase());
// The document without its control keys. The local files are read through it, so no rewrite of
// data/<slug>/conference.json (hide, unhide, remove) keeps one and no backend call is given one;
// the tier 2 adapter drops them again from what it sends and adds its own flag and precondition.
export const withoutControlKeys = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !isControlKey(key)));

export function readOperatorFile(root) {
  const path = join(root, OPERATOR_FILE);
  if (!existsSync(path)) return { hidden: {}, removed: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AdminError(`${OPERATOR_FILE} is not valid JSON`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.hidden) || !isPlainObject(parsed.removed)) {
    throw new AdminError(`${OPERATOR_FILE} must be { "hidden": {}, "removed": {} }`);
  }
  return { hidden: { ...parsed.hidden }, removed: { ...parsed.removed } };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const confPath = (root, slug) => join(root, 'data', slug, 'conference.json');
const talksPath = (root, slug) => join(root, 'data', slug, 'talks.ndjson');
const rawDir = (root, slug) => join(root, 'data', 'raw', slug);

function readConference(root, slug) {
  const path = confPath(root, slug);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(parsed) ? withoutControlKeys(parsed) : null;
  } catch {
    throw new AdminError(`${relative(root, path)} is not valid JSON`);
  }
}

const COMMIT_NOTE = (files) => `commit ${files.join(' and ')}`;

// The demo conference's document as the generator gives it today, when `slug` is the demo's
// (config/demo-conference.json), else null. Its data/<slug>/ folder is generated and ignored by git,
// so a fresh clone has none; hide and unhide take this document instead of refusing. It is read
// whether the demo is switched on or not, so it can be hidden after the switch is turned off.
function generatedDemo(root, slug) {
  let config;
  try {
    config = readDemoConfig(root);
  } catch {
    return null;
  }
  if (config.slug !== slug) return null;
  return buildDemo(config, demoToday(config)).conference;
}

export function withConferenceFiles(adapter, { root, now = () => new Date(), tier = 3 } = {}) {
  const rel = (path) => relative(root, path);
  // The demo's conference file is generated and git-ignored, so only the operator file is committed.
  const files = (slug) => (generatedDemo(root, slug) ? [OPERATOR_FILE] : [rel(confPath(root, slug)), OPERATOR_FILE]);

  // The refusal of a removed slug, exit 2; under --dry-run it is the preview of that refusal.
  const removedError = (slug, mode) => new UsageError(`${mode === 'dry-run' ? 'would refuse: ' : ''}${slug} is removed (data/conference-operator.json); run conferences unretire --event ${slug} first`);
  // A status the operator set is not a status to restore: after remove, unretire, hide and unhide
  // the conference must come back by the talk-file rule, not as operator_removed.
  const operatorSet = (statusReason) => typeof statusReason === 'string' && statusReason.startsWith('operator_');

  return {
    ...adapter,

    // A removed conference stays removed until an explicit unretire: ingest.mjs would skip it and
    // the backend would hold it again, so add and refresh refuse it.
    async addConference(args) {
      if (readOperatorFile(root).removed[args.slug]) throw removedError(args.slug, args.mode);
      return adapter.addConference(args);
    },

    async refreshConference(args) {
      if (readOperatorFile(root).removed[args.slug]) throw removedError(args.slug, args.mode);
      return adapter.refreshConference(args);
    },

    async hideConference({ event, slug, reason, mode }) {
      // The demo's document is always the generator's: its local file is generated and git-ignored.
      const local = generatedDemo(root, slug) ?? readConference(root, slug);
      if (!local) throw new NotFoundError(`no ${rel(confPath(root, slug))}; run conferences refresh --event ${slug} first`);
      const operator = readOperatorFile(root);
      if (operator.removed[slug]) throw removedError(slug, mode);
      const since = now().toISOString();
      const doc = { ...local, status: 'unavailable', status_reason: HIDDEN, raw_fetched_at: since };
      const backend = await adapter.hideConference({ event, slug, reason, mode, doc });
      const items = [...(backend.items ?? []), { file: rel(confPath(root, slug)), status: 'unavailable', status_reason: HIDDEN }, { file: OPERATOR_FILE, hidden: slug }];
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would rewrite ${files(slug).join(' and ')}` };
      writeJson(confPath(root, slug), doc);
      // The status before the hide, restored by unhide; a second hide keeps the first record. A
      // status the operator set (operator_removed left by a remove, operator_hidden) is not one.
      const previous = operator.hidden[slug]?.previous
        ?? (operatorSet(local.status_reason) ? null : { status: local.status ?? null, status_reason: local.status_reason ?? null });
      operator.hidden[slug] = { reason: reason ?? 'other', since, previous };
      writeJson(join(root, OPERATOR_FILE), operator);
      return { ...backend, items, files: files(slug), summary: `${backend.summary}; ${COMMIT_NOTE(files(slug))}; the next pages.yml build drops ${slug} from the bundle index` };
    },

    async unhideConference({ event, slug, mode }) {
      const generated = generatedDemo(root, slug);
      const local = generated ?? readConference(root, slug);
      const operator = readOperatorFile(root);
      if (!local && !operator.hidden[slug]) throw new NotFoundError(`${slug} is not hidden (no ${OPERATOR_FILE} entry and no ${rel(confPath(root, slug))})`);
      const since = now().toISOString();
      // The demo's talks are generated, so they always exist.
      const hasTalks = Boolean(generated) || existsSync(talksPath(root, slug));
      const base = local ?? { slug };
      // The status from before the hide when the operator file recorded one (a conference that
      // was partial_index stays partial_index); searchable needs the talk file to be present.
      const previous = operator.hidden[slug]?.previous;
      const restored = previous && typeof previous.status === 'string' && !operatorSet(previous.status_reason) && (previous.status !== 'searchable' || hasTalks)
        ? { status: previous.status, status_reason: previous.status_reason ?? null }
        : hasTalks ? { status: 'searchable', status_reason: null } : null;
      const doc = restored ? { ...base, ...restored, raw_fetched_at: since } : { ...base, raw_fetched_at: since };
      const backend = local ? await adapter.unhideConference({ event, slug, mode, doc }) : { summary: `no ${rel(confPath(root, slug))} to restore` };
      const items = [...(backend.items ?? []), { file: rel(confPath(root, slug)), status: doc.status ?? null, status_reason: doc.status_reason ?? null }, { file: OPERATOR_FILE, hidden: null }];
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would rewrite ${files(slug).join(' and ')}` };
      if (local) writeJson(confPath(root, slug), doc);
      delete operator.hidden[slug];
      writeJson(join(root, OPERATOR_FILE), operator);
      const next = restored ? `restored ${restored.status}${restored.status_reason ? ` (${restored.status_reason})` : ''}; run conferences refresh --event ${slug} to re-check the schedule` : `the talk file is missing, so the status stays ${doc.status ?? 'unavailable'} until conferences refresh --event ${slug}`;
      return { ...backend, items, files: files(slug), summary: `${backend.summary}; ${COMMIT_NOTE(files(slug))}; ${next}` };
    },

    async removeConference({ event, slug, reason, mode, options }) {
      const local = readConference(root, slug);
      const operator = readOperatorFile(root);
      const backend = await adapter.removeConference({ event, slug, reason, mode, options });
      const since = now().toISOString();
      const items = [...(backend.items ?? [])];
      const touched = [OPERATOR_FILE];
      if (local) {
        items.push({ file: rel(confPath(root, slug)), status: 'unavailable', status_reason: REMOVED, kept: true });
        touched.unshift(rel(confPath(root, slug)));
      } else {
        items.push({ file: rel(confPath(root, slug)), missing: true });
      }
      items.push({ file: OPERATOR_FILE, removed: slug });
      const purge = [];
      if (options?.purgeLocal) {
        if (existsSync(rawDir(root, slug))) purge.push(rel(rawDir(root, slug)));
        if (existsSync(talksPath(root, slug))) purge.push(rel(talksPath(root, slug)));
        for (const path of purge) items.push({ delete: path });
      }
      const followUps = `${COMMIT_NOTE(touched)}; the next pages.yml build drops ${slug} from the bundle index and carries its bundle forward for one day; ${slug} stays removed across the weekly ingest until conferences unretire --event ${slug}`;
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would retire ${rel(confPath(root, slug))}${purge.length ? ` and delete ${purge.join(', ')}` : ''}` };
      if (local) writeJson(confPath(root, slug), { ...local, status: 'unavailable', status_reason: REMOVED, raw_fetched_at: since });
      delete operator.hidden[slug];
      operator.removed[slug] = { since };
      writeJson(join(root, OPERATOR_FILE), operator);
      if (options?.purgeLocal) {
        rmSync(rawDir(root, slug), { recursive: true, force: true });
        rmSync(talksPath(root, slug), { force: true });
      }
      return { ...backend, items, files: touched, summary: `${backend.summary}; retired ${slug}${purge.length ? `; deleted ${purge.join(', ')}` : ''}; ${followUps}` };
    },

    // On tier 3 the operator file is the only record of a removal, so an unretire needs its entry.
    // On tier 2 the Worker holds the retired state too (a tombstone, or a wiped object after a
    // removal that an unretire overtook or an unretire whose fan-out failed), and the documented
    // repair is to run the unretire again; so it is sent without a local entry too, but then only
    // with the local conference document (the slug alone would be stored as an unavailable
    // conference), and the tier 2 adapter refuses a slug the Worker lists with another status and
    // sends the status it read as expect_status, which the Worker checks (409 status_mismatch).
    // The local entry is dropped when there is one, and only after the Worker took the unretire.
    async unretireConference({ event, slug, mode }) {
      const operator = readOperatorFile(root);
      const recorded = !!operator.removed[slug];
      if (!recorded && tier !== 2) throw new NotFoundError(`${slug} is not removed (no entry in ${OPERATOR_FILE})`);
      // The demo's document is the generator's, as for hide and unhide (a fresh clone has no local
      // file), written as a remove leaves a conference's file: unavailable, operator_removed. So on
      // tier 2 the unretire brings its row back unlisted, as the Worker lists no hidden demo, and
      // `conferences refresh` makes it searchable, as for any conference; the document carries
      // demo: true, so the tier 2 adapter can tell that row from no row. Tier 3 ignores the
      // document.
      const generated = generatedDemo(root, slug);
      const local = generated ? { ...generated, status: 'unavailable', status_reason: REMOVED } : readConference(root, slug);
      if (!recorded && !local) throw new NotFoundError(`${slug} has no removed entry in ${OPERATOR_FILE} and no ${rel(confPath(root, slug))}; check the slug`);
      const backend = await adapter.unretireConference({ event, slug, mode, doc: local ?? { slug } });
      const items = [...(backend.items ?? []), { file: OPERATOR_FILE, removed: null, recorded }];
      const fileNote = recorded ? `drop the removed entry of ${OPERATOR_FILE}` : `${OPERATOR_FILE} has no removed entry for ${slug}, so it is left as it is`;
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would ${recorded ? fileNote : `send it anyway (${fileNote})`}` };
      if (recorded) {
        delete operator.removed[slug];
        writeJson(join(root, OPERATOR_FILE), operator);
      }
      return { ...backend, items, files: recorded ? [OPERATOR_FILE] : [], summary: `${backend.summary}; ${recorded ? COMMIT_NOTE([OPERATOR_FILE]) : fileNote}; run conferences refresh --event ${slug} next` };
    },
  };
}
