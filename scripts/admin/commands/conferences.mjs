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
// - data/conference-operator.json records the state: { "hidden": { "<slug>": { "reason", "since" } },
//   "removed": { "<slug>": { "since" } } }. scripts/ingest.mjs reads it: a hidden slug is written
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
import { AdminError, NotFoundError } from '../errors.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OPERATOR_FILE = 'data/conference-operator.json';
const HIDDEN = 'operator_hidden';
const REMOVED = 'operator_removed';

export function adminRoot(env = {}) {
  return env.CADDIE_ADMIN_ROOT ? resolve(env.CADDIE_ADMIN_ROOT) : REPO_ROOT;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    throw new AdminError(`${relative(root, path)} is not valid JSON`);
  }
}

const COMMIT_NOTE = (files) => `commit ${files.join(' and ')}`;

export function withConferenceFiles(adapter, { root, now = () => new Date() } = {}) {
  const rel = (path) => relative(root, path);
  const files = (slug) => [rel(confPath(root, slug)), OPERATOR_FILE];

  return {
    ...adapter,

    async hideConference({ event, slug, reason, mode }) {
      const local = readConference(root, slug);
      if (!local) throw new NotFoundError(`no ${rel(confPath(root, slug))}; run conferences refresh --event ${slug} first`);
      const operator = readOperatorFile(root);
      const since = now().toISOString();
      const doc = { ...local, status: 'unavailable', status_reason: HIDDEN, raw_fetched_at: since };
      const backend = await adapter.hideConference({ event, slug, reason, mode, doc });
      const items = [...(backend.items ?? []), { file: rel(confPath(root, slug)), status: 'unavailable', status_reason: HIDDEN }, { file: OPERATOR_FILE, hidden: slug }];
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would rewrite ${files(slug).join(' and ')}` };
      writeJson(confPath(root, slug), doc);
      operator.hidden[slug] = { reason: reason ?? 'other', since };
      writeJson(join(root, OPERATOR_FILE), operator);
      return { ...backend, items, files: files(slug), summary: `${backend.summary}; ${COMMIT_NOTE(files(slug))}; the next pages.yml build drops ${slug} from the bundle index` };
    },

    async unhideConference({ event, slug, mode }) {
      const local = readConference(root, slug);
      const operator = readOperatorFile(root);
      if (!local && !operator.hidden[slug]) throw new NotFoundError(`${slug} is not hidden (no ${OPERATOR_FILE} entry and no ${rel(confPath(root, slug))})`);
      const since = now().toISOString();
      const hasTalks = existsSync(talksPath(root, slug));
      const base = local ?? { slug };
      const doc = hasTalks
        ? { ...base, status: 'searchable', status_reason: null, raw_fetched_at: since }
        : { ...base, raw_fetched_at: since };
      const backend = local ? await adapter.unhideConference({ event, slug, mode, doc }) : { summary: `no ${rel(confPath(root, slug))} to restore` };
      const items = [...(backend.items ?? []), { file: rel(confPath(root, slug)), status: doc.status ?? null, status_reason: doc.status_reason ?? null }, { file: OPERATOR_FILE, hidden: null }];
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would rewrite ${files(slug).join(' and ')}` };
      if (local) writeJson(confPath(root, slug), doc);
      delete operator.hidden[slug];
      writeJson(join(root, OPERATOR_FILE), operator);
      const next = hasTalks ? `run conferences refresh --event ${slug} to re-check the schedule` : `the talk file is missing, so the status stays ${doc.status ?? 'unavailable'} until conferences refresh --event ${slug}`;
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

    async unretireConference({ event, slug, mode }) {
      const operator = readOperatorFile(root);
      if (!operator.removed[slug]) throw new NotFoundError(`${slug} is not removed (no entry in ${OPERATOR_FILE})`);
      const local = readConference(root, slug);
      const backend = await adapter.unretireConference({ event, slug, mode, doc: local ?? { slug } });
      const items = [...(backend.items ?? []), { file: OPERATOR_FILE, removed: null }];
      if (mode === 'dry-run') return { ...backend, items, summary: `${backend.summary}; would drop the removed entry of ${OPERATOR_FILE}` };
      delete operator.removed[slug];
      writeJson(join(root, OPERATOR_FILE), operator);
      return { ...backend, items, files: [OPERATOR_FILE], summary: `${backend.summary}; ${COMMIT_NOTE([OPERATOR_FILE])}; run conferences refresh --event ${slug} next` };
    },
  };
}
