// Builds the talk bundles of every searchable conference from the committed data under data/, for
// the public GitHub Pages demo (tier 1). No Elasticsearch and no live service is involved.
//
// Usage:
//   node scripts/build-bundles.mjs [--out dist-pages] [--only slug,slug] [--base-url https://.../bundles/]
//                                  [--offline] [--check] [--smoke] [--reuse-from <url|dir|none>]
//                                  [--publisher-name "..."] [--takedown https://... | mailto:...]
// Options:
//   --out <dir>        output directory (default dist-pages)
//   --only <slugs>     comma-separated conference slugs; the index then lists only those
//   --base-url <url>   talks.bundle_base written to capabilities.json; https, ends in "/"
//                      (default https://kurtlehnardt.github.io/conferenceCaddie/bundles/)
//   --offline          never use the network (no model download, no --reuse-from URL); fail when the
//                      pinned model files are not in the model directory
//   --no-model-download  fail when the pinned model files are not in the model directory instead of
//                      downloading them; reuse from a URL is still allowed
//   --check            rebuild in memory and compare with the files already under --out; exit 1 on any
//                      difference (conferences.json is compared without its generated_at, and with
//                      --only only for the conferences rebuilt). Vector reuse is off unless --reuse-from
//                      is given explicitly, so that --check tests the embedder itself.
//   --reuse-from <x>   bundles to take int8 rows from instead of embedding again: an https bundle base
//                      URL ending in "/", or a local directory (a bundle base, or a site root holding
//                      bundles/). "none" turns it off. Default: the --base-url bundles (off for --check).
//                      A row is reused only when the previous build used the identical embedding
//                      identity (bundles/build-info.json), the text hash of the talk is the same, and
//                      a sample of the rows equals a fresh embedding (REUSE_MIN_COSINE).
//   --smoke            after building, embed the a-check queries of scripts/smoke.mjs and print where
//                      each expected KubeCon talk lands in the int8 cosine ranking (informational)
// Env: CADDIE_MODEL_CACHE (model directory, resolved against the repository root, default .cache/model),
// SOURCE_DATE_EPOCH (seconds; fixes generated_at so that the whole output is byte-reproducible).
// The embedding library lives in tools/bundles (npm --prefix tools/bundles ci), not in the root package.
//
// Output under --out:
//   bundles/{slug}/{content_hash[0:16]}/bundle.json and vectors.i8   the immutable bundle
//   bundles/conferences.json                                          the index, at {bundle_base}
//   bundles/build-info.json                                           the embedding identity, for vector reuse
//   conferences.json                                                  a byte-identical copy at the site root
//   capabilities.json                                                 the tier 1 (demo) capabilities
// The format is docs/contracts/talk-bundle.md; docs/BUNDLES.md describes this script.
//
// Exit codes: 0 success, 1 build, verification or --check failure, 2 bad arguments.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildBundle, verifyBundle, readConferenceIndex, passageText, textHash, decodeVectors, quantizeRow, cosine, normalizeKey, sha256hex,
  VECTOR_KINDS, INDEX_VERSION, BUNDLE_VERSION, BUNDLE_FILE, BUNDLE_FILES, VECTOR_FILE, QUANTIZATION, MODEL, DIMS,
} from '../contracts/js/bundle.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import { formatErrors } from '../contracts/js/validate.mjs';
import { buildTopics, readFixups } from './lib/topics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASE_URL = 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
export const DEFAULT_OUT = 'dist-pages';
export const PUBLISHER = Object.freeze({
  name: 'Conference Caddie (Kurt Lehnardt)',
  takedown: 'https://github.com/KurtLehnardt/conferenceCaddie/issues',
});
// The bundle contract fixes the shape of the attribution block (licensor, license, license_url,
// source_url, changes, takedown) but not the wording. The licensor line says what the Linux
// Foundation licenses and that the session and speaker content belongs to its authors.
export const ATTRIBUTION = Object.freeze({
  licensor: 'The Linux Foundation (event information, licensed CC BY 3.0). Session and speaker content is copyright the speakers and organizers.',
  license: 'CC BY 3.0',
  license_url: 'https://creativecommons.org/licenses/by/3.0/',
  changes: 'Reformatted; speaker data trimmed to names and short title and organization lines; email addresses removed from abstracts; talk text embedded for search.',
});
export const TAGLINE_MAX = 100;
export const EMAIL_REDACTION = '[email removed]';
export const BUILD_INFO_FILE = 'build-info.json';
const BUNDLE_SCHEMA = `talk-bundle.v${BUNDLE_VERSION}`;
const INDEX_SCHEMA = `conferences-index.v${INDEX_VERSION}`;
// How many published rows per conference are re-embedded to check that a reuse source is honest, the
// lowest cosine accepted between a published row and a fresh one, and the most bytes read per file.
export const REUSE_SAMPLE = 8;
export const REUSE_MIN_COSINE = 0.999;
export const REUSE_MAX_BYTES = { index: 5_000_000, info: 100_000, 'bundle.json': 20_000_000, 'vectors.i8': 5_000_000 };

export class UsageError extends Error {}

// ---------- Arguments ----------

/** Parses the command line. Throws UsageError with a one-line reason. */
export function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT, only: null, baseUrl: DEFAULT_BASE_URL, offline: false, noModelDownload: false, check: false, smoke: false,
    reuseFrom: undefined, publisherName: PUBLISHER.name, takedown: PUBLISHER.takedown,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value.`);
      return v;
    };
    if (a === '--out') opts.out = value();
    else if (a === '--only') {
      opts.only = value().split(',').map((s) => s.trim()).filter(Boolean);
      if (opts.only.length === 0) throw new UsageError('--only needs at least one slug.');
    } else if (a === '--base-url') opts.baseUrl = value();
    else if (a === '--reuse-from') opts.reuseFrom = value();
    else if (a === '--publisher-name') opts.publisherName = value();
    else if (a === '--takedown') opts.takedown = value();
    else if (a === '--offline') opts.offline = true;
    else if (a === '--no-model-download') opts.noModelDownload = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--smoke') opts.smoke = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (!opts.out.trim()) throw new UsageError('--out must not be empty.');
  if (!opts.publisherName.trim()) throw new UsageError('--publisher-name must not be empty.');
  if (!/^https:\/\/[^\s]+\/$/.test(opts.baseUrl)) throw new UsageError('--base-url must be an https URL that ends in "/".');
  if (!/^(https:\/\/|mailto:)\S+$/.test(opts.takedown)) throw new UsageError('--takedown must be an https URL or a mailto: address.');
  if (opts.reuseFrom !== undefined && !opts.reuseFrom.trim()) throw new UsageError('--reuse-from must not be empty.');
  if (opts.reuseFrom !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.reuseFrom) && !/^https:\/\/[^\s]+\/$/.test(opts.reuseFrom)) {
    throw new UsageError('--reuse-from must be "none", a local directory, or an https URL that ends in "/".');
  }
  return opts;
}

/** The reuse source in effect: an explicit --reuse-from, else the bundle base this build publishes to (but not for --check). */
export function effectiveReuseFrom(opts) {
  if (opts.reuseFrom === 'none') return null;
  if (opts.reuseFrom !== undefined) return opts.reuseFrom;
  return opts.check ? null : opts.baseUrl;
}

// ---------- Inputs ----------

/**
 * The public conference entry of a stored conference.json: the fields of GET /api/conferences, as
 * server/conferences.mjs publicConferences() builds them.
 */
export function publicConference(doc) {
  const mapping = doc.category_mapping ?? null;
  const loc = doc.location ?? {};
  return {
    slug: doc.slug,
    name: doc.name ?? '',
    start_date: doc.start_date ?? null,
    end_date: doc.end_date ?? null,
    time_zone: doc.time_zone ?? null,
    location: { city: loc.city ?? '', region: loc.region ?? '', country: loc.country ?? '', virtual: loc.virtual === true },
    status: doc.status === 'searchable' ? 'searchable' : 'unavailable',
    official_schedule_url: doc.official_schedule_url ?? null,
    source: doc.source ?? 'sessionize',
    has_level: Boolean(mapping?.level_group),
    track_group: mapping?.track_group ?? null,
    tag_groups: Array.isArray(mapping?.tag_groups) ? mapping.tag_groups : [],
    talk_count: Number.isInteger(doc.counts?.talk) ? doc.counts.talk : 0,
  };
}

// A domain must end in a letters-only label, so package pins (lodash@4.17.21, actions/checkout@v4.1.1) stay.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
/** Replaces every email address in a text with "[email removed]". */
export const redactEmails = (text) => String(text ?? '').replace(EMAIL_RE, EMAIL_REDACTION);

/**
 * A speaker's one-line tagline for a public bundle: cut at the first " | " (the feed puts a second
 * title or a link text after it), trimmed, at most TAGLINE_MAX characters with an ellipsis when cut,
 * and null when nothing is left.
 */
export function shortTagline(tagline) {
  if (typeof tagline !== 'string') return null;
  let t = tagline.split(' | ')[0].replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = [...t];
  if (chars.length > TAGLINE_MAX) t = `${chars.slice(0, TAGLINE_MAX - 1).join('').trimEnd()}…`;
  return redactEmails(t);
}

/**
 * The taglines of a raw talk, parallel to its speakers (null where a speaker has none). talks.ndjson
 * leaves empty taglines out of speaker_taglines, so the index-aligned speaker_profiles come first;
 * speaker_taglines is used only when it is as long as speakers (then nothing was left out); when
 * neither lines up the taglines are all null, because guessing would credit one person with another's
 * job.
 */
export function alignedTaglines(raw) {
  const speakers = raw.speakers ?? [];
  const profiles = raw.speaker_profiles;
  const tag = (p) => (typeof p?.tagline === 'string' && p.tagline ? p.tagline : null);
  if (Array.isArray(profiles) && profiles.length === speakers.length) {
    // Profiles that carry names must carry the speaker's name at the same index; a profile in the
    // wrong place is looked up by name, and a speaker with no profile of that name gets null.
    return profiles.map((p, i) => {
      if (typeof p?.name !== 'string' || p.name === speakers[i]) return tag(p);
      const byName = profiles.filter((q) => q?.name === speakers[i]);
      return byName.length === 1 ? tag(byName[0]) : null;
    });
  }
  const taglines = raw.speaker_taglines;
  if (Array.isArray(taglines) && taglines.length === speakers.length) return taglines.map((t) => (typeof t === 'string' && t ? t : null));
  return speakers.map(() => null);
}

/**
 * A talk as a public bundle will carry it, in the shape buildBundle (contracts/js/bundle.mjs
 * bundleTalk) takes: speaker data reduced to names and short taglines (carried in index-aligned
 * speaker_profiles stubs that the contract builder consumes and drops, never links or bios), email
 * addresses removed from the abstract, and an empty topics list.
 */
export function trimTalk(raw) {
  const speakers = (raw.speakers ?? []).map(String);
  const taglines = alignedTaglines({ ...raw, speakers }).map(shortTagline);
  return {
    ...raw,
    title: redactEmails(raw.title),
    abstract: redactEmails(raw.abstract),
    speakers,
    speaker_taglines: taglines,
    speaker_profiles: taglines.map((tagline, i) => ({ name: speakers[i], tagline })),
    topics: [],
  };
}

const TAKEDOWN_KEYS = new Set(['slug', 'talk_id', 'speaker', 'reason', 'date']);

/**
 * The takedown list: [{ slug, talk_id?, speaker?, reason, date }]. A missing file is an empty list; a
 * malformed one is an error, including an unknown key, a date that is not a real calendar day, and
 * (when `dataDir` is given) a slug that is not a conference folder, so a typo can never silently
 * leave content published.
 */
export function loadTakedowns(file, { dataDir = null } = {}) {
  if (!existsSync(file)) return [];
  let list;
  try {
    list = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(list)) throw new Error(`${file}: must be a JSON array.`);
  list.forEach((e, i) => {
    const bad = (why) => new Error(`${file}[${i}]: ${why}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('must be an object');
    for (const k of Object.keys(e)) if (!TAKEDOWN_KEYS.has(k)) throw bad(`unknown key "${k}"`);
    if (typeof e.slug !== 'string' || !e.slug) throw bad('slug is required');
    if (dataDir && !existsSync(path.join(dataDir, e.slug, 'conference.json'))) throw bad(`"${e.slug}" is not a conference folder under data/`);
    if (typeof e.reason !== 'string' || !e.reason) throw bad('reason is required');
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(Date.parse(e.date)) || new Date(`${e.date}T00:00:00Z`).toISOString().slice(0, 10) !== e.date) throw bad('date must be a real day, YYYY-MM-DD');
    if (e.talk_id === undefined && e.speaker === undefined) throw bad('talk_id or speaker is required');
    if (e.talk_id !== undefined && (typeof e.talk_id !== 'string' || !e.talk_id.startsWith(`${e.slug}:`))) throw bad('talk_id must be a string starting with "<slug>:"');
    if (e.speaker !== undefined && (typeof e.speaker !== 'string' || !normalizeKey(e.speaker))) throw bad('speaker must be a non-empty name');
  });
  return list;
}

/**
 * Applies the takedowns of one conference to its raw talks. An entry with only talk_id drops that
 * talk. An entry with a speaker removes that name (compared with normalizeKey, so case, accents and
 * punctuation do not matter) and its tagline from the talk named by talk_id, or from every talk of the
 * conference when there is none. An entry that matches nothing is an error: the content it was meant to
 * remove may still be published under another spelling. Returns { talks }.
 */
export function applyTakedowns(slug, talks, takedowns) {
  let out = talks.map((t) => ({ ...t }));
  for (const e of takedowns.filter((x) => x.slug === slug)) {
    let hit = 0;
    if (e.speaker === undefined) {
      const before = out.length;
      out = out.filter((t) => t.talk_id !== e.talk_id);
      hit = before - out.length;
    } else {
      const key = normalizeKey(e.speaker);
      out = out.map((t) => {
        if (e.talk_id !== undefined && t.talk_id !== e.talk_id) return t;
        const speakers = t.speakers ?? [];
        const keep = speakers.map((s) => normalizeKey(s) !== key);
        if (keep.every(Boolean)) return t;
        hit++;
        const taglines = alignedTaglines(t).filter((_, i) => keep[i]);
        const names = speakers.filter((_, i) => keep[i]);
        return { ...t, speakers: names, speaker_taglines: taglines, speaker_profiles: names.map((name, j) => ({ name, tagline: taglines[j] })) };
      });
    }
    if (!hit) throw new Error(`takedown for ${slug} (${e.talk_id ?? ''}${e.speaker ? ` speaker ${JSON.stringify(e.speaker)}` : ''}) matched nothing in the data; fix the entry or the data before publishing`);
  }
  return { talks: out };
}

/** The searchable conferences under dataDir, sorted by slug: [{ conference, talks }] with raw talks. */
export function loadSearchable(dataDir, only = null) {
  const found = [];
  for (const slug of readdirSync(dataDir).sort()) {
    const confFile = path.join(dataDir, slug, 'conference.json');
    const talksFile = path.join(dataDir, slug, 'talks.ndjson');
    if (!existsSync(confFile)) continue;
    const doc = JSON.parse(readFileSync(confFile, 'utf8'));
    if (doc.status !== 'searchable') continue;
    if (!existsSync(talksFile)) throw new Error(`${slug} is searchable but has no talks.ndjson.`);
    const talks = readFileSync(talksFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    found.push({ conference: publicConference(doc), talks });
  }
  if (only) {
    const known = new Set(found.map((f) => f.conference.slug));
    const unknown = only.filter((s) => !known.has(s));
    if (unknown.length) throw new UsageError(`Not a searchable conference: ${unknown.join(', ')}. Searchable: ${[...known].join(', ')}.`);
    return found.filter((f) => only.includes(f.conference.slug));
  }
  return found;
}

// ---------- Vector reuse ----------

const isUrl = (s) => /^https:\/\//.test(s);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Reads at most `cap` bytes of a fetch response; a longer body is an error, not a truncation.
async function readCapped(res, cap) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw new Error(`body of ${declared} bytes exceeds the ${cap} byte cap`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > cap) throw new Error(`body exceeds the ${cap} byte cap`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Takes the int8 rows of the bundles published at `source` (an https bundle base or a local
 * directory) so that unchanged texts need not be embedded again, and the content hashes stay stable
 * whatever CPU the runner has. The source is not trusted: a row is reused only when
 *   - the previous build's build-info.json names exactly the current embedding identity (model,
 *     revision, file hashes, settings, bundle version, quantisation), and
 *   - the entry's path is exactly "{slug}/{content_hash[0:16]}/", only the two bundle files are read,
 *     over a connection that does not follow redirects and with a byte cap per file, and
 *   - the bundle verifies against its entry (sizes, SHA-256, content hash, text hashes) and states the
 *     current bundle version, model, dimensions and quantisation, and
 *   - a fixed sample of its rows (REUSE_SAMPLE per conference, spread evenly) equals a fresh embedding
 *     of the same text, as quantised, to a cosine of at least REUSE_MIN_COSINE. Hashes alone prove
 *     nothing about what a publisher put in the vectors; one bad sampled row discards the whole source.
 *   - the talk's text hash (SHA-256 of the published embedding text) is the same.
 * Any failure to read the source means nothing is reused; it is logged and never fatal.
 * Returns { rows: Map(text_hash -> Int8Array), note }.
 */
export async function loadReusableRows({ source, identity, embedder, offline = false, fetchFn = globalThis.fetch, log = () => {} }) {
  const none = (note, loud = false) => {
    log(`${loud ? 'REUSE REJECTED' : 'reuse'}: ${note}; every text is embedded`);
    return { rows: new Map(), note };
  };
  if (!source) return { rows: new Map(), note: 'reuse is off' };
  if (!identity) return none('the embedder has no identity');
  let readFile;
  if (isUrl(source)) {
    if (offline) return none(`--offline forbids fetching ${source}`);
    const origin = new URL(source).origin;
    readFile = async (rel, cap) => {
      const url = new URL(rel, source);
      if (url.origin !== origin || !url.pathname.startsWith(new URL(source).pathname)) throw new Error(`${rel} leaves the source`);
      const res = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return readCapped(res, cap);
    };
  } else {
    let base = path.resolve(source);
    if (existsSync(path.join(base, 'bundles', 'conferences.json'))) base = path.join(base, 'bundles'); // a site root: its own conferences.json is only a copy
    readFile = async (rel, cap) => {
      const file = path.resolve(base, rel);
      if (!file.startsWith(`${base}${path.sep}`)) throw new Error(`${rel} leaves the source`);
      const bytes = readFileSync(file);
      if (bytes.length > cap) throw new Error(`${rel} exceeds the ${cap} byte cap`);
      return bytes;
    };
  }
  try {
    const info = JSON.parse((await readFile(BUILD_INFO_FILE, REUSE_MAX_BYTES.info)).toString('utf8'));
    if (JSON.stringify(info.embedding) !== JSON.stringify(identity)) return none('the previous build used a different embedding identity');
    const index = readConferenceIndex(JSON.parse((await readFile('conferences.json', REUSE_MAX_BYTES.index)).toString('utf8')));
    if (!index.ok) return none(`conferences.json is not a usable index (${index.reason})`);
    const rows = new Map();
    const usable = index.conferences.filter((c) => c.bundle_status === 'ok').sort((x, y) => (x.conference.slug < y.conference.slug ? -1 : 1));
    for (const { conference, bundle: entry } of usable) {
      const slug = conference.slug;
      try {
        if (!SLUG_RE.test(slug) || entry.path !== `${slug}/${entry.content_hash.slice(0, 16)}/`) throw new Error('the entry path is not {slug}/{content_hash[0:16]}/');
        const files = {};
        for (const name of BUNDLE_FILES) {
          const meta = entry.files?.[name];
          if (!meta || !Number.isInteger(meta.bytes) || meta.bytes > REUSE_MAX_BYTES[name]) throw new Error(`${name} is missing or too large`);
          files[name] = await readFile(`${entry.path}${name}`, REUSE_MAX_BYTES[name]);
        }
        const problems = verifyBundle(entry, files);
        if (problems.length) throw new Error(`does not verify (${problems[0]})`);
        const bundle = JSON.parse(files[BUNDLE_FILE].toString('utf8'));
        const v = bundle.vectors;
        if (bundle.bundle_version !== BUNDLE_VERSION || v.quantization !== QUANTIZATION || v.dtype !== 'int8' || v.dims !== DIMS || bundle.model?.id !== MODEL.id) {
          throw new Error('bundle version, quantisation, dimensions or model differ from the current ones');
        }
        const vecs = decodeVectors(files[VECTOR_FILE], v.dims);
        const byId = new Map(bundle.talks.map((t) => [t.talk_id, t]));
        // The sample check: re-embed evenly spread rows and compare.
        const n = v.rows.length;
        const picks = n <= REUSE_SAMPLE ? [...v.rows.keys()] : Array.from({ length: REUSE_SAMPLE }, (_, i) => Math.floor((i * n) / REUSE_SAMPLE));
        const fresh = await embedder.embedDocuments(picks.map((i) => passageText(byId.get(v.rows[i]))));
        picks.forEach((i, k) => {
          const c = cosine(vecs[i], quantizeRow(fresh[k]));
          if (!(c >= REUSE_MIN_COSINE)) throw Object.assign(new Error(`sampled row ${v.rows[i]} has cosine ${c.toFixed(4)} to a fresh embedding, below ${REUSE_MIN_COSINE}`), { poisoned: true });
        });
        v.rows.forEach((id, i) => {
          const hash = byId.get(id)?.text_hash;
          if (hash && !rows.has(hash)) rows.set(hash, Int8Array.from(vecs[i]));
        });
      } catch (err) {
        if (err.poisoned) return none(`${slug}: ${err.message}. The whole source is discarded`, true);
        log(`reuse: ${slug}: ${err.message}; skipped`);
      }
    }
    log(`reuse: sample check passed; ${rows.size} rows available from ${source}`);
    return { rows, note: `${rows.size} rows available from ${source}` };
  } catch (err) {
    return none(`could not read ${source} (${err.message})`);
  }
}

// ---------- Building ----------

const byteEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * Builds one conference's bundle.
 *   conference  public conference entry
 *   talks       raw talk documents; with `topics` given they are used as they are (they carry their
 *               topic ids), otherwise they are trimmed (trimTalk) and the topics are computed from the
 *               titles (lib/topics.mjs)
 *   embedder    { embedDocuments(texts) -> rows of 384 floats }
 *   reuse       Map(text_hash -> Int8Array) of rows that need no embedding
 * Returns the buildBundle result plus { stats: { reused, embedded } }.
 */
export async function buildConferenceBundle({ conference, talks, embedder, attribution, topics = null, stoplistText = '', fixups = {}, reuse = new Map(), log = () => {} }) {
  let docs = talks;
  let topicList = topics;
  if (!topicList) {
    docs = talks.map(trimTalk);
    const computed = buildTopics({ talks: docs.filter((t) => t.kind === 'talk').map((t) => ({ talk_id: t.talk_id, title: t.title })), stoplistText, fixups, log });
    topicList = computed.topics;
    for (const t of docs) t.topics = computed.talkTopics.get(t.talk_id) ?? [];
  }
  const wanted = docs.filter((t) => VECTOR_KINDS.includes(t.kind));
  const vectors = new Map();
  const pending = [];
  for (const t of wanted) {
    const row = reuse.get(textHash(t));
    if (row) vectors.set(t.talk_id, row);
    else pending.push(t);
  }
  const rows = await embedder.embedDocuments(pending.map(passageText));
  if (rows.length !== pending.length) throw new Error(`the embedder returned ${rows.length} rows for ${pending.length} texts`);
  pending.forEach((t, i) => vectors.set(t.talk_id, rows[i]));
  const built = buildBundle({ conference, talks: docs, topics: topicList, vectors, attribution });
  return { ...built, stats: { reused: wanted.length - pending.length, embedded: pending.length } };
}

// Dates are ISO strings and names plain text: order by code unit, as the API's sort does for dates.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byStartThenName = (a, b) => cmp(a.start_date ?? '', b.start_date ?? '') || cmp(a.name, b.name);

/** The conferences.json document: each conference with its bundle entry (or null), sorted like the API. */
export function buildIndex({ conferences, entries, publisher, generatedAt }) {
  return {
    index_version: INDEX_VERSION,
    generated_at: generatedAt,
    publisher: { name: publisher.name, takedown: publisher.takedown },
    conferences: [...conferences].sort(byStartThenName).map((c) => ({ ...c, bundle: entries.get(c.slug) ?? null })),
  };
}
export const serializeIndex = (index) => Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');

/** The tier 1 (demo) capabilities document, as contracts/fixtures/capabilities/tier1-demo.json. */
export function buildCapabilities(baseUrl) {
  return {
    api_version: 1,
    tier: 'demo',
    talks: { bundle_base: baseUrl, server_search: false },
    people: { enabled: false },
    ble: { mode: 'none' },
    push: { apns: false, fcm: false, webpush: false },
    imports: { github: 'device', schedule: 'device' },
  };
}
export const serializeCapabilities = (doc) => Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
export const serializeBuildInfo = (identity) => Buffer.from(`${JSON.stringify({ build_info_version: 1, embedding: identity }, null, 2)}\n`, 'utf8');

function checkSchema(name, value, what) {
  const r = validator(name)(value, { closed: true });
  if (!r.valid) throw new Error(`${what} does not match ${name}: ${formatErrors(r.errors)}`);
}

/** Verifies a built bundle with verifyBundle (producer mode) and validates bundle.json against its schema. */
export function validateBuilt(built) {
  const problems = verifyBundle(built.entry, built.files, { producer: true });
  if (problems.length) throw new Error(`${built.entry.path}: ${problems.join('; ')}`);
  checkSchema(BUNDLE_SCHEMA, JSON.parse(built.files[BUNDLE_FILE].toString('utf8')), `${built.entry.path}${BUNDLE_FILE}`);
}

/**
 * Builds everything in memory from loaded sources ([{ conference, talks }], see loadSearchable):
 * { bundles: [{ slug, ...buildBundle result, stats, ms }], index, files: Map(path under --out -> Buffer) }.
 */
export async function buildAll({ sources, dataDir, embedder, baseUrl, publisher, attribution = ATTRIBUTION, generatedAt, reuse = new Map(), log = () => {} }) {
  const stoplistText = readFileSync(path.join(ROOT, 'config', 'topic-stoplist.txt'), 'utf8');
  if (sources.length === 0) throw new Error('No searchable conference found.');
  const takedowns = loadTakedowns(path.join(dataDir, 'takedowns.json'), { dataDir });
  const bundles = [];
  const entries = new Map();
  const conferences = [];
  const files = new Map();
  for (const { conference, talks: rawTalks } of sources) {
    const started = Date.now();
    const kindTalks = rawTalks.filter((t) => t.kind === 'talk').length;
    if (kindTalks !== conference.talk_count) throw new Error(`${conference.slug}: conference.json counts ${conference.talk_count} talks, talks.ndjson has ${kindTalks}.`);
    const { talks } = applyTakedowns(conference.slug, rawTalks, takedowns);
    const mine = takedowns.filter((e) => e.slug === conference.slug).length;
    if (mine) log(`${conference.slug}: ${mine} takedown entr${mine === 1 ? 'y' : 'ies'} applied`);
    const publicConf = { ...conference, talk_count: talks.filter((t) => t.kind === 'talk').length };
    const built = await buildConferenceBundle({
      conference: publicConf,
      talks,
      embedder,
      attribution: { ...attribution, takedown: publisher.takedown },
      stoplistText,
      fixups: readFixups(path.join(dataDir, 'topics', `${conference.slug}.json`)),
      reuse,
      log,
    });
    validateBuilt(built);
    const ms = Date.now() - started;
    bundles.push({ slug: conference.slug, ...built, ms });
    entries.set(conference.slug, built.entry);
    conferences.push(publicConf);
    for (const [name, bytes] of Object.entries(built.files)) files.set(`bundles/${built.dir}${name}`, bytes);
    log(`${conference.slug}: ${built.entry.talk_count} talks, ${built.entry.vector_count} vectors (${built.stats.reused} reused, ${built.stats.embedded} embedded), ${ms} ms`);
  }
  const index = buildIndex({ conferences, entries, publisher, generatedAt });
  checkSchema(INDEX_SCHEMA, index, 'conferences.json');
  const capabilities = buildCapabilities(baseUrl);
  checkSchema('capabilities.v1', capabilities, 'capabilities.json');
  const indexBytes = serializeIndex(index);
  files.set('bundles/conferences.json', indexBytes);
  files.set('conferences.json', indexBytes);
  files.set('capabilities.json', serializeCapabilities(capabilities));
  if (embedder.identity) files.set(`bundles/${BUILD_INFO_FILE}`, serializeBuildInfo(embedder.identity));
  return { bundles, index, files };
}

// ---------- Output and --check ----------

export function writeOutput(outDir, files) {
  for (const [rel, bytes] of files) {
    const target = path.join(outDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

// An index compared for --check: without generated_at, and (for --only) only the conferences in `slugs`.
const indexForCheck = (bytes, slugs) => {
  const doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
  delete doc.generated_at;
  if (slugs) doc.conferences = (doc.conferences ?? []).filter((c) => slugs.has(c.slug));
  return JSON.stringify(doc);
};

/** Compares a fresh build with the files under outDir. Returns a list of differences; empty means identical. */
export function checkOutput(outDir, files, { slugs = null } = {}) {
  const problems = [];
  for (const [rel, bytes] of files) {
    const target = path.join(outDir, rel);
    if (!existsSync(target)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const existing = readFileSync(target);
    const same = rel.endsWith('conferences.json') ? indexForCheck(existing, slugs) === indexForCheck(bytes, slugs) : byteEqual(existing, bytes);
    if (!same) problems.push(`${rel}: differs (existing sha256 ${sha256hex(existing).slice(0, 16)}, rebuilt ${sha256hex(bytes).slice(0, 16)})`);
  }
  return problems;
}

// ---------- Quality smoke ----------

/** The { query, title } pairs of the QUERIES list of scripts/smoke.mjs, the a1 to a5 checks. */
export function readSmokeQueries(smokePath = path.join(ROOT, 'scripts', 'smoke.mjs')) {
  const text = readFileSync(smokePath, 'utf8');
  const block = /const QUERIES = \[([\s\S]*?)\n\];/.exec(text);
  if (!block) throw new Error('Could not find the QUERIES list in scripts/smoke.mjs.');
  const pairs = [...block[1].matchAll(/query:\s*'((?:[^'\\]|\\.)*)',\s*title:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => ({ query: m[1].replace(/\\'/g, "'"), title: m[2].replace(/\\'/g, "'") }));
  if (pairs.length === 0) throw new Error('The QUERIES list of scripts/smoke.mjs holds no pairs.');
  return pairs;
}

/** Ranks the kind:talk items of a built bundle against each query (float query, int8 rows, cosine). */
export async function smokeRanks({ built, embedder, queries }) {
  const bundle = JSON.parse(built.files[BUNDLE_FILE].toString('utf8'));
  const rows = decodeVectors(built.files[VECTOR_FILE], bundle.vectors.dims);
  const rowOf = new Map(bundle.vectors.rows.map((id, i) => [id, rows[i]]));
  const talks = bundle.talks.filter((t) => t.kind === 'talk' && rowOf.has(t.talk_id));
  const qvecs = await embedder.embedQueries(queries.map((q) => q.query));
  return queries.map((q, i) => {
    const ranked = talks
      .map((t) => ({ t, s: cosine(qvecs[i], rowOf.get(t.talk_id)) }))
      .sort((a, b) => b.s - a.s || (a.t.talk_id < b.t.talk_id ? -1 : 1));
    const at = ranked.findIndex((r) => r.t.title === q.title);
    return { ...q, rank: at === -1 ? null : at + 1, top: ranked[0].t.title, topScore: ranked[0].s, score: at === -1 ? null : ranked[at].s };
  });
}

// ---------- Main ----------

const fmt = (n) => n.toLocaleString('en-US');

export async function run(opts, { embedder = null, dataDir = path.join(ROOT, 'data'), log = (m) => console.log(m), now = () => new Date(), fetchFn = globalThis.fetch } = {}) {
  const started = Date.now();
  // Inputs first, so that a wrong slug fails before a model is loaded or downloaded.
  const sources = loadSearchable(dataDir, opts.only);
  let model = embedder;
  if (!model) {
    const { createEmbedder } = await import('./lib/embedder.mjs');
    const t = Date.now();
    model = await createEmbedder({ noDownload: opts.offline || opts.noModelDownload, log });
    log(`model ${model.info.onnx}@${model.info.revision.slice(0, 8)} verified and loaded in ${Date.now() - t} ms (${model.info.dir})`);
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = (epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const publisher = { name: opts.publisherName, takedown: opts.takedown };
  const { rows: reuse } = await loadReusableRows({ source: effectiveReuseFrom(opts), identity: model.identity, embedder: model, offline: opts.offline, fetchFn, log });
  const result = await buildAll({ sources, dataDir, embedder: model, baseUrl: opts.baseUrl, publisher, generatedAt, reuse, log });
  const reused = result.bundles.reduce((s, b) => s + b.stats.reused, 0);
  const embedded = result.bundles.reduce((s, b) => s + b.stats.embedded, 0);
  log(`vectors: ${reused} reused, ${embedded} embedded (${reused + embedded ? Math.round((100 * reused) / (reused + embedded)) : 0}% reuse)`);
  const outDir = path.resolve(opts.out);

  if (opts.check) {
    const problems = checkOutput(outDir, result.files, { slugs: opts.only ? new Set(opts.only) : null });
    if (problems.length) {
      for (const p of problems) log(`CHECK FAILED ${p}`);
      return { ok: false, reused, embedded, ...result };
    }
    log(`check ok: ${result.files.size} files under ${opts.out} are identical to a rebuild`);
  } else {
    writeOutput(outDir, result.files);
    let total = 0;
    for (const b of result.bundles) {
      const sizes = Object.entries(b.entry.files).map(([n, m]) => `${n} ${fmt(m.bytes)}`).join(', ');
      const sum = Object.values(b.entry.files).reduce((s, m) => s + m.bytes, 0);
      total += sum;
      log(`${b.entry.path} ${b.entry.content_hash.slice(0, 16)}  ${sizes}  (${fmt(sum)} bytes)`);
    }
    log(`wrote ${result.bundles.length} bundles, ${fmt(total)} bytes, to ${opts.out}/bundles/`);
  }

  if (opts.smoke) {
    const kube = result.bundles.find((b) => b.slug === 'kubecon-cloudnativecon-north-america-2026');
    if (!kube) log('smoke: the KubeCon NA 2026 bundle was not built, skipped.');
    else {
      for (const r of await smokeRanks({ built: kube, embedder: model, queries: readSmokeQueries() })) {
        log(`smoke a: "${r.query}" expected "${r.title}" -> ${r.rank === null ? 'not found' : `rank ${r.rank}`}${r.rank && r.rank <= 5 ? ' (in top 5)' : ' (MISS)'}; top "${r.top}" ${r.topScore.toFixed(4)}`);
      }
    }
  }
  log(`done in ${Date.now() - started} ms`);
  return { ok: true, reused, embedded, ...result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    console.error('Usage: node scripts/build-bundles.mjs [--out dir] [--only slug,...] [--base-url url] [--offline] [--no-model-download] [--check] [--smoke] [--reuse-from url|dir|none]');
    process.exit(2);
  }
  try {
    const { ok } = await run(opts);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(err instanceof UsageError ? err.message : `build-bundles failed: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
