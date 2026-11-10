// Reference implementation of the talk bundle contract v1 (docs/contracts/talk-bundle.md):
// int8 vector quantisation and similarity, related talks, the facet names, the bundle builder,
// content hashing and verification. Node built-ins only.
//
// A bundle is two immutable files under {bundle_base}{slug}/{content_hash[0:16]}/:
//   bundle.json  canonical JSON (canonical-json.mjs): conference, attribution, model, vector
//                layout, talks, topics, facets and the top related talks of every talk
//   vectors.i8   count x dims signed bytes, row-major, row i belonging to vectors.rows[i]
// and one mutable index, {bundle_base}conferences.json, whose entry for the conference names the
// current content hash and the size and SHA-256 of each file.

import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';

export const BUNDLE_VERSION = 1;
export const INDEX_VERSION = 1;
export const BUNDLE_FILE = 'bundle.json';
export const VECTOR_FILE = 'vectors.i8';
export const DIMS = 384;
export const RELATED_K = 5;
/** The query instruction of the BGE v1.5 English models, verbatim from the model card. */
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
// The embedding conventions every producer (CI, transformers.js) and every query-side embedder
// (ONNX Runtime on the phones, Workers AI @cf/baai/bge-small-en-v1.5 called with pooling: "cls")
// must follow. docs/contracts/talk-bundle.md, Embedding conventions.
export const MODEL = Object.freeze({
  id: 'BAAI/bge-small-en-v1.5',
  onnx: 'Xenova/bge-small-en-v1.5',
  dims: DIMS,
  pooling: 'cls',
  normalize: true,
  max_tokens: 512,
  truncation: 'end',
  document_instruction: '',
  document_text: 'title + "\\n" + abstract',
  query_instruction: QUERY_INSTRUCTION,
});
export const BUNDLE_FILES = Object.freeze([BUNDLE_FILE, VECTOR_FILE]);
export const QUANTIZATION = 'int8-symmetric-row-maxabs';
/** Kinds that carry a vector: what search covers with "include events" on. */
export const VECTOR_KINDS = Object.freeze(['talk', 'ambient']);
/** Kinds that have related talks and can be related talks. */
export const RELATED_KINDS = Object.freeze(['talk']);
const FACET_KIND_ORDER = ['track', 'room', 'speaker', 'tag'];

export const sha256hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The text a talk is embedded from, with no instruction; the same string text_hash covers. */
export const passageText = (talk) => `${talk.title}\n${talk.abstract}`;
/** The text a search query is embedded from: the BGE query instruction, then the query as typed. */
export const queryText = (query) => `${QUERY_INSTRUCTION}${query}`;
export const textHash = (talk) => sha256hex(Buffer.from(passageText(talk), 'utf8'));

// Rounds half away from zero, the same on every platform (Math.round rounds half up).
const roundHalfAway = (x) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5);

/**
 * Quantises one embedding to int8: scale = 127 / max|v_i|, q_i = round_half_away(v_i * scale),
 * clamped to [-127, 127]. -128 is never produced. A zero vector stays all zeros. The scale is not
 * stored: similarity is cosine over the int8 values, which does not depend on it.
 */
export function quantizeRow(values) {
  if (values.length === 0) throw new RangeError('empty vector');
  let max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) throw new RangeError('vector components must be finite');
    max = Math.max(max, Math.abs(v));
  }
  const out = new Int8Array(values.length);
  if (max === 0) return out;
  const scale = 127 / max;
  for (let i = 0; i < values.length; i++) out[i] = Math.max(-127, Math.min(127, roundHalfAway(values[i] * scale)));
  return out;
}

/** Row-major bytes of int8 rows (two's complement; one byte per component, so no byte order). */
export function encodeVectors(rows, dims = DIMS) {
  const buf = Buffer.alloc(rows.length * dims);
  rows.forEach((row, r) => {
    if (row.length !== dims) throw new RangeError(`row ${r} has ${row.length} components, expected ${dims}`);
    for (let i = 0; i < dims; i++) buf.writeInt8(row[i], r * dims + i);
  });
  return buf;
}

/** The rows of a vectors.i8 file as Int8Array views. */
export function decodeVectors(bytes, dims = DIMS) {
  const b = Buffer.from(bytes);
  if (b.length % dims !== 0) throw new RangeError(`vector file length ${b.length} is not a multiple of ${dims}`);
  const all = new Int8Array(b.buffer, b.byteOffset, b.length);
  const rows = [];
  for (let off = 0; off < all.length; off += dims) rows.push(all.subarray(off, off + dims));
  return rows;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * Cosine similarity of two vectors (int8 rows, or a float query against an int8 row). Integer
 * dot products of two rows stay below 384 * 127 * 127, well inside 32 bits. A zero vector has
 * similarity 0 with everything.
 */
export function cosine(a, b) {
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/**
 * The top-k related talks of every talk of a related kind: the other related-kind talks by cosine
 * similarity, highest first, ties broken by talk_id in ascending code-unit order. No threshold, as
 * GET /api/related has none. Returns { talk_id: [talk_id, ...] } for every such talk with a row.
 */
export function relatedTalks(talks, rowsById, k = RELATED_K) {
  const eligible = talks.filter((t) => RELATED_KINDS.includes(t.kind) && rowsById.has(t.talk_id)).map((t) => t.talk_id);
  const out = {};
  for (const id of eligible) {
    const row = rowsById.get(id);
    out[id] = eligible
      .filter((other) => other !== id)
      .map((other) => ({ other, s: cosine(row, rowsById.get(other)) }))
      .sort((x, y) => y.s - x.s || (x.other < y.other ? -1 : x.other > y.other ? 1 : 0))
      .slice(0, k)
      .map((x) => x.other);
  }
  return out;
}

/** The one normaliser of value matching, identical to normalizeKey in server/facets.mjs. */
export function normalizeKey(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// A room's keys: the whole string and every tail of its " | " parts. Same rule as scripts/build-facets.mjs.
function roomNames(room) {
  const parts = room.split('|').map((p) => p.trim()).filter(Boolean);
  const keys = new Set();
  for (let i = 0; i < parts.length; i++) keys.add(normalizeKey(parts.slice(i).join(' ')));
  return { label: parts.slice(-2).join(' · '), keys: [...keys].filter(Boolean), words: normalizeKey(parts.slice(-2).join(' ')) };
}

/**
 * The value-matching names of a conference (the caddie-facets documents of scripts/build-facets.mjs):
 * tracks, rooms, speakers and tags of its kind:talk items, each with its normalised keys and the
 * number of talks that carry it. Sorted by kind (track, room, speaker, tag), then value, then group.
 */
export function buildFacets(talks) {
  const names = new Map();
  const add = (kind, value, label, keys, words, group = null) => {
    if (!value) return;
    const id = [kind, value, group ?? ''].join('\0');
    const entry = names.get(id) ?? { kind, value, label, group, keys, words, talks: 0 };
    entry.talks++;
    names.set(id, entry);
  };
  for (const t of talks) {
    if (t.kind !== 'talk') continue;
    if (t.track) add('track', t.track, t.track.replace(/^[^\p{L}\p{N}]+/u, ''), [normalizeKey(t.track)], normalizeKey(t.track));
    if (t.room) {
      const r = roomNames(t.room);
      add('room', t.room, r.label, r.keys, r.words);
    }
    for (const s of new Set(t.speakers ?? [])) add('speaker', s, s, [normalizeKey(s)], normalizeKey(s));
    for (const tag of t.tags ?? []) add('tag', tag.value, tag.value, [normalizeKey(tag.value)], normalizeKey(tag.value), tag.group);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...names.values()]
    .filter((e) => e.keys.some(Boolean))
    .map((e) => ({ ...e, keys: e.keys.filter(Boolean) }))
    .sort((a, b) => FACET_KIND_ORDER.indexOf(a.kind) - FACET_KIND_ORDER.indexOf(b.kind) || cmp(a.value, b.value) || cmp(a.group ?? '', b.group ?? ''));
}

// The talk fields a bundle carries, in the order the spec lists them. session_id, content_hash,
// tag_keys (derivable from tags), conference (in the talk_id) and ingested_at are left out, and so
// is speaker_profiles: public bundles carry speaker names and their one-line "title, organisation"
// taglines only, never bios, photos or social links.
export const TALK_FIELDS = Object.freeze([
  'talk_id', 'kind', 'title', 'abstract', 'speakers', 'speaker_taglines', 'room', 'track', 'level',
  'tags', 'sponsor', 'has_slides', 'slides_url', 'url', 'start', 'end', 'day', 'start_minutes', 'end_minutes', 'topics', 'text_hash',
]);
/** What a bundle says about where its content comes from, besides the conference's own source URL. */
export const ATTRIBUTION_FIELDS = Object.freeze(['licensor', 'license', 'license_url', 'changes', 'takedown']);
// The public conference fields, exactly those of a GET /api/conferences entry.
export const CONFERENCE_FIELDS = Object.freeze([
  'slug', 'name', 'start_date', 'end_date', 'time_zone', 'location', 'status', 'official_schedule_url', 'source', 'has_level', 'track_group', 'tag_groups', 'talk_count',
]);

const pick = (o, fields) => Object.fromEntries(fields.map((f) => [f, o[f] ?? null]));
// By the instant start names (offsets can differ within one conference across a DST change), then talk_id.
const byStartThenId = (a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.talk_id < b.talk_id ? -1 : a.talk_id > b.talk_id ? 1 : 0);

/**
 * The content hash of a bundle: SHA-256 (hex) of the ASCII text
 *   "caddie-bundle-v1\n" + for each file in code-unit order of its name: name TAB sha256hex TAB bytes LF
 * It changes exactly when a file changes, and it names the bundle's directory (first 16 hex digits).
 */
export function contentHash(files) {
  const lines = Object.keys(files).sort().map((name) => `${name}\t${sha256hex(files[name])}\t${Buffer.from(files[name]).length}\n`);
  return sha256hex(Buffer.from(`caddie-bundle-v1\n${lines.join('')}`, 'ascii'));
}

/**
 * One talk as a bundle carries it, from a talks.ndjson document plus its topics. speaker_taglines
 * in a bundle is parallel to speakers (null where a speaker has none); talks.ndjson leaves empty
 * taglines out, so they are taken from speaker_profiles, which are index-aligned with speakers,
 * and the profiles themselves are dropped.
 */
export function bundleTalk(t) {
  const speakers = [...(t.speakers ?? [])];
  let taglines;
  if (Array.isArray(t.speaker_profiles) && t.speaker_profiles.length === speakers.length) {
    taglines = t.speaker_profiles.map((p) => (typeof p?.tagline === 'string' && p.tagline ? p.tagline : null));
  } else if (Array.isArray(t.speaker_taglines) && t.speaker_taglines.length === speakers.length) {
    taglines = [...t.speaker_taglines];
  } else if (!speakers.length) {
    taglines = [];
  } else {
    throw new TypeError(`${t.talk_id}: cannot align speaker taglines with speakers`);
  }
  return { ...pick(t, TALK_FIELDS), speakers, speaker_taglines: taglines, topics: [...(t.topics ?? [])], text_hash: textHash(t) };
}

/**
 * The attribution block of a bundle: the licence and licensor of the schedule content, the
 * conference's public schedule as the source, the changes made, and the publisher's takedown
 * contact. CC BY needs all of these to travel with the content.
 */
export function attributionFor(conference, attribution) {
  const a = pick(attribution, ATTRIBUTION_FIELDS);
  for (const f of ATTRIBUTION_FIELDS) if (typeof a[f] !== 'string' || !a[f]) throw new TypeError(`attribution.${f} is required`);
  return { ...a, source_url: conference.official_schedule_url };
}

/**
 * Builds the two files of a bundle and its conferences.json entry.
 *   conference  a public conference entry (CONFERENCE_FIELDS), status searchable
 *   attribution { licensor, license, license_url, changes, takedown } (attributionFor)
 *   talks       talk documents (data/{slug}/talks.ndjson shape) with topics: [topic_id]
 *   topics      [{ topic_id, label, talk_count, rank, aliases }]
 *   vectors     Map talk_id -> Int8Array(384) or float array (quantised here), for every talk of a
 *               VECTOR_KINDS kind
 * Returns { dir, files: { 'bundle.json': Buffer, 'vectors.i8': Buffer }, entry }.
 */
export function buildBundle({ conference, talks, topics, vectors, attribution }) {
  for (const f of CONFERENCE_FIELDS) if (!conference || !(f in conference)) throw new TypeError(`conference.${f} is required`);
  if (conference.status !== 'searchable') throw new TypeError('only a searchable conference has a bundle');
  if (typeof conference.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(conference.slug)) throw new TypeError('conference.slug is not a slug');
  const sorted = [...talks].sort(byStartThenId).map(bundleTalk);
  const rowsById = new Map();
  for (const t of sorted) {
    if (!VECTOR_KINDS.includes(t.kind)) continue;
    const v = vectors.get(t.talk_id);
    if (!v) throw new Error(`no vector for ${t.talk_id}`);
    rowsById.set(t.talk_id, v instanceof Int8Array ? v : quantizeRow(v));
  }
  const rowIds = sorted.filter((t) => rowsById.has(t.talk_id)).map((t) => t.talk_id);
  const vectorBytes = encodeVectors(rowIds.map((id) => rowsById.get(id)));
  const bundle = {
    bundle_version: BUNDLE_VERSION,
    conference: pick(conference, CONFERENCE_FIELDS),
    attribution: attributionFor(conference, attribution),
    model: { ...MODEL },
    vectors: { file: VECTOR_FILE, dtype: 'int8', dims: DIMS, count: rowIds.length, quantization: QUANTIZATION, rows: rowIds },
    talks: sorted,
    topics: [...topics].sort((a, b) => a.rank - b.rank).map((t) => ({ topic_id: t.topic_id, label: t.label, talk_count: t.talk_count, rank: t.rank, aliases: [...(t.aliases ?? [])] })),
    facets: buildFacets(sorted),
    related: relatedTalks(sorted, rowsById),
  };
  const files = { [BUNDLE_FILE]: Buffer.from(canonicalJson(bundle), 'utf8'), [VECTOR_FILE]: vectorBytes };
  const hash = contentHash(files);
  const dir = `${conference.slug}/${hash.slice(0, 16)}/`;
  const entry = {
    bundle_version: BUNDLE_VERSION,
    content_hash: hash,
    path: dir,
    model: MODEL.id,
    dims: DIMS,
    talk_count: sorted.filter((t) => t.kind === 'talk').length,
    vector_count: rowIds.length,
    files: Object.fromEntries(Object.entries(files).map(([name, b]) => [name, { bytes: b.length, sha256: sha256hex(b) }])),
  };
  return { dir, files, entry, bundle };
}

/**
 * Checks downloaded files against their conferences.json entry and against the rules a schema
 * cannot express. Returns a list of problems; empty means the bundle may be used. A client runs
 * this before it replaces the bundle it has. With { producer: true } (the bundle pipeline in CI,
 * before publishing) it also recomputes the related lists from the vectors; clients do not, so a
 * last-digit difference in another platform's floating point can never make a good bundle fail.
 */
export function verifyBundle(entry, files, { producer = false } = {}) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['no index entry'];
  if (typeof entry.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.content_hash)) return ['content_hash missing or malformed'];
  const listed = Object.keys(entry.files ?? {});
  if (listed.length !== BUNDLE_FILES.length || !BUNDLE_FILES.every((name) => listed.includes(name))) problems.push(`the entry must list exactly ${BUNDLE_FILES.join(' and ')}`);
  for (const name of BUNDLE_FILES) {
    const meta = entry.files?.[name];
    const b = files[name];
    if (!meta) continue;
    if (!b) {
      problems.push(`${name}: missing`);
      continue;
    }
    if (b.length !== meta.bytes) problems.push(`${name}: ${b.length} bytes, expected ${meta.bytes}`);
    if (sha256hex(b) !== meta.sha256) problems.push(`${name}: sha256 mismatch`);
  }
  if (problems.length) return problems;
  if (contentHash(Object.fromEntries(BUNDLE_FILES.map((n) => [n, files[n]]))) !== entry.content_hash) problems.push('content_hash mismatch');
  if (!entry.path?.endsWith(`/${entry.content_hash.slice(0, 16)}/`)) problems.push('path does not end in the first 16 hex digits of content_hash');
  let bundle;
  try {
    bundle = JSON.parse(Buffer.from(files[BUNDLE_FILE]).toString('utf8'));
  } catch {
    return [...problems, `${BUNDLE_FILE}: not JSON`];
  }
  if (canonicalJson(bundle) !== Buffer.from(files[BUNDLE_FILE]).toString('utf8')) problems.push(`${BUNDLE_FILE}: not canonical JSON`);
  if (bundle.bundle_version !== entry.bundle_version) problems.push('bundle_version differs from the index entry');
  const v = bundle.vectors ?? {};
  if (v.dims !== entry.dims || bundle.model?.id !== entry.model || bundle.model?.dims !== v.dims) problems.push('model or dims differ from the index entry');
  if (v.count !== v.rows?.length || v.count !== entry.vector_count) problems.push('vector count mismatch');
  if (files[VECTOR_FILE] && files[VECTOR_FILE].length !== v.count * v.dims) problems.push(`${VECTOR_FILE}: length is not count x dims`);
  if (files[VECTOR_FILE] && Buffer.from(files[VECTOR_FILE]).some((byte) => byte === 0x80)) problems.push(`${VECTOR_FILE}: holds -128`);
  const talks = new Map((bundle.talks ?? []).map((t) => [t.talk_id, t]));
  if (talks.size !== (bundle.talks ?? []).length) problems.push('duplicate talk_id');
  if ((bundle.talks ?? []).filter((t) => t.kind === 'talk').length !== entry.talk_count) problems.push('talk_count mismatch');
  const sorted = [...(bundle.talks ?? [])].sort(byStartThenId);
  if (sorted.some((t, i) => t !== bundle.talks[i])) problems.push('talks are not sorted by start, then talk_id');
  if ((bundle.talks ?? []).some((t) => 'speaker_profiles' in t)) problems.push('speaker profiles and their links must not be published');
  for (const t of bundle.talks ?? []) if ((t.speakers ?? []).length !== (t.speaker_taglines ?? []).length) problems.push(`${t.talk_id}: speakers and speaker_taglines differ in length`);
  if (bundle.attribution?.source_url !== bundle.conference?.official_schedule_url) problems.push('attribution.source_url must be the conference schedule URL');
  const prefix = `${bundle.conference?.slug}:`;
  for (const t of bundle.talks ?? []) {
    if (!t.talk_id.startsWith(prefix)) problems.push(`${t.talk_id}: not of this conference`);
  }
  const rowSet = new Set(v.rows ?? []);
  if (rowSet.size !== (v.rows ?? []).length) problems.push('duplicate vector row');
  const expectedRows = (bundle.talks ?? []).filter((t) => VECTOR_KINDS.includes(t.kind)).map((t) => t.talk_id);
  if (expectedRows.join('\n') !== (v.rows ?? []).join('\n')) problems.push('vector rows must be the talk and ambient items, in talks order');
  const topicIds = new Set((bundle.topics ?? []).map((t) => t.topic_id));
  for (const t of bundle.talks ?? []) for (const id of t.topics ?? []) if (!topicIds.has(id)) problems.push(`${t.talk_id}: unknown topic ${id}`);
  for (const t of bundle.talks ?? []) if (textHash(t) !== t.text_hash) problems.push(`${t.talk_id}: text_hash mismatch`);
  const relatedKeys = Object.keys(bundle.related ?? {});
  const relatedExpected = (bundle.talks ?? []).filter((t) => RELATED_KINDS.includes(t.kind) && rowSet.has(t.talk_id)).map((t) => t.talk_id);
  if ([...relatedKeys].sort().join('\n') !== [...relatedExpected].sort().join('\n')) problems.push('related must have one entry per talk with a vector');
  if (producer && !problems.length && files[VECTOR_FILE]) {
    // The related lists must be exactly what the vectors give.
    const rows = decodeVectors(files[VECTOR_FILE], v.dims);
    const rowsById = new Map((v.rows ?? []).map((id, i) => [id, rows[i]]));
    const again = relatedTalks(bundle.talks ?? [], rowsById);
    for (const id of relatedKeys) {
      if ((again[id] ?? []).join('\n') !== (bundle.related[id] ?? []).join('\n')) problems.push(`${id}: related talks differ from the vectors`);
    }
  }
  for (const [id, list] of Object.entries(bundle.related ?? {})) {
    if (list.length > RELATED_K) problems.push(`${id}: more than ${RELATED_K} related talks`);
    if (new Set(list).size !== list.length) problems.push(`${id}: duplicate related talk`);
    for (const other of list) {
      if (other === id) problems.push(`${id}: related to itself`);
      if (!RELATED_KINDS.includes(talks.get(other)?.kind)) problems.push(`${id}: related ${other} is not a talk`);
    }
  }
  return problems;
}
