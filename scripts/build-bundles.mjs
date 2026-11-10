// Builds the talk bundles of every searchable conference from the committed data under data/, for
// the public GitHub Pages demo (tier 1). No Elasticsearch and no live service is involved.
//
// Usage:
//   node scripts/build-bundles.mjs [--out dist-pages] [--only slug,slug] [--base-url https://.../bundles/]
//                                  [--offline] [--check] [--smoke]
//                                  [--publisher-name "..."] [--takedown https://... | mailto:...]
// Options:
//   --out <dir>        output directory (default dist-pages)
//   --only <slugs>     comma-separated conference slugs; the index then lists only those
//   --base-url <url>   talks.bundle_base written to capabilities.json; https, ends in "/"
//                      (default https://kurtlehnardt.github.io/conferenceCaddie/bundles/)
//   --offline          never use the network; fail when the embedding model is not cached
//   --check            rebuild in memory and compare with the files already under --out; exit 1 on any
//                      difference (conferences.json is compared without its generated_at)
//   --smoke            after building, embed the a-check queries of scripts/smoke.mjs and print where
//                      each expected KubeCon talk lands in the int8 cosine ranking (informational)
// Env: TRANSFORMERS_CACHE (model cache directory, default .cache/transformers), SOURCE_DATE_EPOCH
// (seconds; fixes generated_at so that the whole output is byte-reproducible).
//
// Output under --out:
//   bundles/{slug}/{content_hash[0:16]}/bundle.json and vectors.i8   the immutable bundle
//   bundles/conferences.json                                          the index, at {bundle_base}
//   conferences.json                                                  a byte-identical copy at the site root
//   capabilities.json                                                 the tier 1 (demo) capabilities
// The format is docs/contracts/talk-bundle.md; docs/BUNDLES.md describes this script.
//
// Exit codes: 0 success, 1 build, verification or --check failure, 2 bad arguments.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildBundle, verifyBundle, passageText, decodeVectors, cosine, sha256hex, TALK_FIELDS, VECTOR_KINDS, INDEX_VERSION, BUNDLE_FILE, VECTOR_FILE,
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
export const ATTRIBUTION = Object.freeze({
  licensor: 'The Linux Foundation',
  license: 'CC BY 3.0',
  license_url: 'https://creativecommons.org/licenses/by/3.0/',
  changes: 'Reformatted; speaker data trimmed to names and taglines; talk text embedded for search.',
});

export class UsageError extends Error {}

// ---------- Arguments ----------

/** Parses the command line. Throws UsageError with a one-line reason. */
export function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, only: null, baseUrl: DEFAULT_BASE_URL, offline: false, check: false, smoke: false, publisherName: PUBLISHER.name, takedown: PUBLISHER.takedown };
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
    else if (a === '--publisher-name') opts.publisherName = value();
    else if (a === '--takedown') opts.takedown = value();
    else if (a === '--offline') opts.offline = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--smoke') opts.smoke = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (!/^https:\/\/[^\s]+\/$/.test(opts.baseUrl)) throw new UsageError('--base-url must be an https URL that ends in "/".');
  if (!/^(https:\/\/|mailto:)\S+$/.test(opts.takedown)) throw new UsageError('--takedown must be an https URL or a mailto: address.');
  return opts;
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

/**
 * A talk as a public bundle carries it. Only the fields of the contract survive, and speakers are
 * reduced to their names and one-line taglines: bios, photos and links (speaker_profiles) are
 * dropped, and so are session_id, tag_keys, content_hash and ingested_at.
 */
export function trimTalk(raw) {
  const talk = {};
  for (const f of TALK_FIELDS) if (f in raw) talk[f] = raw[f];
  talk.speakers = (raw.speakers ?? []).map(String);
  // A speaker without a title or organisation has a null tagline; it stays null.
  talk.speaker_taglines = (raw.speaker_taglines ?? []).map((t) => (t == null ? null : String(t)));
  talk.topics = [];
  return talk;
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

// ---------- Building ----------

const byteEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * Builds one conference's bundle.
 *   conference  public conference entry
 *   talks       talk documents; with `topics` given they are used as they are (the talks carry their
 *               topic ids), otherwise the topics are computed from the titles (lib/topics.mjs) and
 *               the talks are trimmed
 *   embedder    { embedDocuments(texts) -> rows of 384 floats }
 * Returns the buildBundle result.
 */
export async function buildConferenceBundle({ conference, talks, embedder, attribution, topics = null, stoplistText = '', fixups = {} }) {
  let docs = talks;
  let topicList = topics;
  if (!topicList) {
    docs = talks.map(trimTalk);
    const computed = buildTopics({ talks: docs.filter((t) => t.kind === 'talk').map((t) => ({ talk_id: t.talk_id, title: t.title })), stoplistText, fixups });
    topicList = computed.topics;
    for (const t of docs) t.topics = computed.talkTopics.get(t.talk_id) ?? [];
  }
  const toEmbed = docs.filter((t) => VECTOR_KINDS.includes(t.kind));
  const rows = await embedder.embedDocuments(toEmbed.map(passageText));
  if (rows.length !== toEmbed.length) throw new Error(`the embedder returned ${rows.length} rows for ${toEmbed.length} texts`);
  const vectors = new Map(toEmbed.map((t, i) => [t.talk_id, rows[i]]));
  return buildBundle({ conference, talks: docs, topics: topicList, vectors, attribution });
}

const bySlugOrder = (a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? '') || a.name.localeCompare(b.name);

/** The conferences.json document: each conference with its bundle entry (or null), sorted like the API. */
export function buildIndex({ conferences, entries, publisher, generatedAt }) {
  return {
    index_version: INDEX_VERSION,
    generated_at: generatedAt,
    publisher: { name: publisher.name, takedown: publisher.takedown },
    conferences: [...conferences].sort(bySlugOrder).map((c) => ({ ...c, bundle: entries.get(c.slug) ?? null })),
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

function checkSchema(name, value, what) {
  const r = validator(name)(value, { closed: true });
  if (!r.valid) throw new Error(`${what} does not match ${name}: ${formatErrors(r.errors)}`);
}

/** Verifies a built bundle with verifyBundle and validates bundle.json against its schema. */
export function validateBuilt(built) {
  const problems = verifyBundle(built.entry, built.files);
  if (problems.length) throw new Error(`${built.entry.path}: ${problems.join('; ')}`);
  checkSchema('talk-bundle.v1', JSON.parse(built.files[BUNDLE_FILE].toString('utf8')), `${built.entry.path}${BUNDLE_FILE}`);
}

/**
 * Builds everything in memory: { bundles: [{ slug, ... buildBundle result, ms }], files: Map(relative path -> Buffer) }.
 * `files` holds every file of the output, keyed by its path under --out.
 */
export async function buildAll({ dataDir, embedder, baseUrl, publisher, attribution = ATTRIBUTION, only = null, generatedAt, log = () => {} }) {
  const stoplistText = readFileSync(path.join(ROOT, 'config', 'topic-stoplist.txt'), 'utf8');
  const sources = loadSearchable(dataDir, only);
  if (sources.length === 0) throw new Error('No searchable conference found.');
  const bundles = [];
  const entries = new Map();
  const files = new Map();
  for (const { conference, talks } of sources) {
    const started = Date.now();
    const kindTalks = talks.filter((t) => t.kind === 'talk').length;
    if (kindTalks !== conference.talk_count) throw new Error(`${conference.slug}: conference.json counts ${conference.talk_count} talks, talks.ndjson has ${kindTalks}.`);
    const built = await buildConferenceBundle({
      conference,
      talks,
      embedder,
      attribution: { ...attribution, takedown: publisher.takedown },
      stoplistText,
      fixups: readFixups(path.join(dataDir, 'topics', `${conference.slug}.json`)),
    });
    validateBuilt(built);
    const ms = Date.now() - started;
    bundles.push({ slug: conference.slug, ...built, ms });
    entries.set(conference.slug, built.entry);
    for (const [name, bytes] of Object.entries(built.files)) files.set(`bundles/${built.dir}${name}`, bytes);
    log(`${conference.slug}: ${built.entry.talk_count} talks, ${built.entry.vector_count} vectors, ${ms} ms`);
  }
  const index = buildIndex({ conferences: sources.map((s) => s.conference), entries, publisher, generatedAt });
  checkSchema('conferences-index.v1', index, 'conferences.json');
  const capabilities = buildCapabilities(baseUrl);
  checkSchema('capabilities.v1', capabilities, 'capabilities.json');
  const indexBytes = serializeIndex(index);
  files.set('bundles/conferences.json', indexBytes);
  files.set('conferences.json', indexBytes);
  files.set('capabilities.json', serializeCapabilities(capabilities));
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

const withoutGeneratedAt = (bytes) => {
  const doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
  delete doc.generated_at;
  return JSON.stringify(doc);
};

/** Compares a fresh build with the files under outDir. Returns a list of differences; empty means identical. */
export function checkOutput(outDir, files) {
  const problems = [];
  for (const [rel, bytes] of files) {
    const target = path.join(outDir, rel);
    if (!existsSync(target)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const existing = readFileSync(target);
    const same = rel.endsWith('conferences.json') ? withoutGeneratedAt(existing) === withoutGeneratedAt(bytes) : byteEqual(existing, bytes);
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

export async function run(opts, { embedder = null, dataDir = path.join(ROOT, 'data'), log = (m) => console.log(m), now = () => new Date() } = {}) {
  const started = Date.now();
  let model = embedder;
  if (!model) {
    const { createEmbedder } = await import('./lib/embedder.mjs');
    const t = Date.now();
    model = await createEmbedder({ offline: opts.offline, log });
    log(`model ${model.info.onnx}@${model.info.revision.slice(0, 8)} ready in ${Date.now() - t} ms (cache ${model.info.cacheDir})`);
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = (epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const publisher = { name: opts.publisherName, takedown: opts.takedown };
  const result = await buildAll({ dataDir, embedder: model, baseUrl: opts.baseUrl, publisher, only: opts.only, generatedAt, log });
  const outDir = path.resolve(opts.out);

  if (opts.check) {
    const problems = checkOutput(outDir, result.files);
    if (problems.length) {
      for (const p of problems) log(`CHECK FAILED ${p}`);
      return { ok: false, ...result };
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
  return { ok: true, ...result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    console.error('Usage: node scripts/build-bundles.mjs [--out dir] [--only slug,...] [--base-url url] [--offline] [--check] [--smoke]');
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
