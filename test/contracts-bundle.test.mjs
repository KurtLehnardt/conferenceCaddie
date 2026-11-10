// Talk bundle v1 (docs/contracts/talk-bundle.md): the committed fixture bundle is byte for byte
// what the reference builder makes from its inputs, its vectors and related talks can be checked by
// hand, verification catches tampering, and the committed conference data fits the bundle schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  quantizeRow, encodeVectors, decodeVectors, cosine, relatedTalks, contentHash, verifyBundle, sha256hex, textHash,
  normalizeKey, buildFacets, TALK_FIELDS, DIMS, MODEL,
} from '../contracts/js/bundle.mjs';
import { canonicalJson } from '../contracts/js/canonical-json.mjs';
import { buildFixtureBundles, BUNDLE_OUT } from '../contracts/js/fixtures.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import { formatErrors } from '../contracts/js/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'caddie-fixture-2099';
const A = `${SLUG}:1001`;
const B = `${SLUG}:1002`;
const C = `${SLUG}:1003`;

const index = JSON.parse(readFileSync(path.join(BUNDLE_OUT, 'conferences.json'), 'utf8'));
const entry = index.conferences.find((c) => c.slug === SLUG).bundle;
const readFiles = (e) => Object.fromEntries(Object.keys(e.files).map((name) => [name, readFileSync(path.join(BUNDLE_OUT, e.path, name))]));
const files = readFiles(entry);
const bundle = JSON.parse(files['bundle.json'].toString('utf8'));

test('the committed fixture is exactly what the reference builder produces', () => {
  const { bundles, indexBytes } = buildFixtureBundles();
  assert.equal(bundles.length, 1);
  assert.deepEqual(readFileSync(path.join(BUNDLE_OUT, 'conferences.json')), indexBytes, 'conferences.json differs: run node contracts/js/fixtures.mjs --write after a deliberate format change');
  for (const [name, bytes] of Object.entries(bundles[0].files)) {
    assert.deepEqual(files[name], bytes, `${name} differs from a rebuild`);
  }
  // Only the current bundle directory exists.
  assert.deepEqual(readdirSync(path.join(BUNDLE_OUT, SLUG)), [entry.content_hash.slice(0, 16)]);
});

test('the fixture verifies', () => {
  assert.deepEqual(verifyBundle(entry, files), []);
});

test('vectors.i8: three rows of 384 signed bytes, checkable by hand', () => {
  assert.equal(files['vectors.i8'].length, 3 * DIMS);
  assert.deepEqual(bundle.vectors.rows, [A, B, C]);
  const rows = decodeVectors(files['vectors.i8']);
  const nonZero = (row) => [...row].map((v, i) => [i, v]).filter(([, v]) => v !== 0);
  assert.deepEqual(nonZero(rows[0]), [[0, 127]]);
  assert.deepEqual(nonZero(rows[1]), [[1, 127]]);
  assert.deepEqual(nonZero(rows[2]), [[0, 95], [1, -127]]);
  // Byte offsets: row r starts at r * 384; -127 is 0x81 in two's complement.
  assert.equal(files['vectors.i8'][0], 0x7f);
  assert.equal(files['vectors.i8'][384 + 1], 0x7f);
  assert.equal(files['vectors.i8'][768], 0x5f);
  assert.equal(files['vectors.i8'][769], 0x81);
  // The lunch break has no row.
  assert.ok(!bundle.vectors.rows.includes(`${SLUG}:1000`));
});

test('cosines and related talks, by hand', () => {
  const rows = decodeVectors(files['vectors.i8']);
  const [a, b, c] = rows;
  assert.equal(cosine(a, b), 0);
  assert.equal(cosine(a, c).toFixed(4), (95 / Math.hypot(95, 127)).toFixed(4));
  assert.equal(cosine(a, c).toFixed(4), '0.5990');
  assert.equal(cosine(b, c).toFixed(4), '-0.8008');
  assert.deepEqual(bundle.related, { [A]: [C, B], [B]: [A, C], [C]: [A, B] });
  // A float query against int8 rows ranks by meaning, whatever its scale.
  const query = new Array(DIMS).fill(0);
  query[0] = 0.06;
  query[1] = -0.08;
  const ranked = [A, B, C].map((id, i) => [id, cosine(query, rows[i])]).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  assert.deepEqual(ranked, [C, A, B]);
});

test('quantisation: per-row max-abs scale, half away from zero, never -128', () => {
  assert.deepEqual([...quantizeRow([-2, 1, -1, 0.5, 0])], [-127, 64, -64, 32, 0]);
  assert.deepEqual([...quantizeRow([0.6, -0.8])], [95, -127]);
  assert.deepEqual([...quantizeRow([0, 0, 0])], [0, 0, 0]);
  assert.deepEqual([...quantizeRow([1e-9, -1e-9])], [127, -127]);
  assert.throws(() => quantizeRow([1, Number.NaN]), RangeError);
  for (let i = 0; i < 200; i++) {
    const v = Array.from({ length: DIMS }, () => Math.random() * 2 - 1);
    const q = quantizeRow(v);
    assert.ok(q.every((x) => x >= -127 && x <= 127));
    assert.ok(q.some((x) => Math.abs(x) === 127));
    // int8 cosine stays close to float cosine with itself rotated slightly.
    assert.ok(cosine(v, q) > 0.999);
  }
});

test('related talks break ties by talk_id and never include other kinds', () => {
  const rows = new Map([['s:1', Int8Array.from([127, 0])], ['s:3', Int8Array.from([0, 127])], ['s:2', Int8Array.from([0, 127])], ['s:9', Int8Array.from([127, 0])]]);
  const talks = [{ talk_id: 's:1', kind: 'talk' }, { talk_id: 's:3', kind: 'talk' }, { talk_id: 's:2', kind: 'talk' }, { talk_id: 's:9', kind: 'ambient' }];
  assert.deepEqual(relatedTalks(talks, rows), { 's:1': ['s:2', 's:3'], 's:3': ['s:2', 's:1'], 's:2': ['s:3', 's:1'] });
  const many = Array.from({ length: 8 }, (_, i) => ({ talk_id: `s:${i}`, kind: 'talk' }));
  const r = relatedTalks(many, new Map(many.map((t, i) => [t.talk_id, Int8Array.from([127, i])])));
  assert.ok(Object.values(r).every((list) => list.length === 5));
});

test('the content hash covers every file and names the directory', () => {
  const listing = `caddie-bundle-v1\nbundle.json\t${sha256hex(files['bundle.json'])}\t${files['bundle.json'].length}\nvectors.i8\t${sha256hex(files['vectors.i8'])}\t${files['vectors.i8'].length}\n`;
  assert.equal(contentHash(files), sha256hex(Buffer.from(listing, 'ascii')));
  assert.equal(entry.content_hash, contentHash(files));
  assert.equal(entry.path, `${SLUG}/${entry.content_hash.slice(0, 16)}/`);
  assert.equal(entry.files['bundle.json'].sha256, sha256hex(files['bundle.json']));
});

test('bundle.json is canonical JSON with no floats and no timestamps of its own', () => {
  const text = files['bundle.json'].toString('utf8');
  assert.equal(canonicalJson(JSON.parse(text)), text);
  assert.throws(() => canonicalJson({ x: 0.5 }), TypeError);
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'é\n'] }), '{"a":[true,null,"é\\n"],"b":1}');
  assert.ok(!/built_at|generated_at|ingested_at/.test(text));
});

test('verification catches tampering', () => {
  const flip = (buf, i) => {
    const b = Buffer.from(buf);
    b[i] ^= 0x01;
    return b;
  };
  assert.ok(verifyBundle(entry, { ...files, 'vectors.i8': flip(files['vectors.i8'], 5) }).some((p) => p.includes('sha256')));
  assert.ok(verifyBundle(entry, { 'bundle.json': files['bundle.json'] }).some((p) => p.includes('missing')));
  assert.ok(verifyBundle({ ...entry, content_hash: '0'.repeat(64) }, files).some((p) => p.includes('content_hash')));

  // A consistent but wrong bundle (rehashed after editing) still fails the semantic checks.
  const rehash = (mutate) => {
    const b = structuredClone(bundle);
    mutate(b);
    const f = { 'bundle.json': Buffer.from(canonicalJson(b), 'utf8'), 'vectors.i8': files['vectors.i8'] };
    const e = structuredClone(entry);
    for (const [name, bytes] of Object.entries(f)) e.files[name] = { bytes: bytes.length, sha256: sha256hex(bytes) };
    e.content_hash = contentHash(f);
    e.path = `${SLUG}/${e.content_hash.slice(0, 16)}/`;
    return verifyBundle(e, f);
  };
  assert.ok(rehash((b) => { b.related[A] = [B, C]; }).some((p) => p.includes('differ from the vectors')));
  assert.ok(rehash((b) => { b.related[A] = [A]; }).some((p) => p.includes('itself')));
  assert.ok(rehash((b) => { b.talks.reverse(); }).some((p) => p.includes('sorted')));
  assert.ok(rehash((b) => { b.talks[0].topics = ['nope']; }).some((p) => p.includes('unknown topic')));
  assert.ok(rehash((b) => { b.talks[0].title = 'Changed'; }).some((p) => p.includes('text_hash')));
  assert.ok(rehash((b) => { b.vectors.rows = [B, A, C]; }).some((p) => p.includes('vector rows')));
});

test('a vector file holding -128 is refused', () => {
  const v = Buffer.from(files['vectors.i8']);
  v[10] = 0x80;
  const f = { ...files, 'vectors.i8': v };
  const e = structuredClone(entry);
  e.files['vectors.i8'].sha256 = sha256hex(v);
  e.content_hash = contentHash(f);
  e.path = `${SLUG}/${e.content_hash.slice(0, 16)}/`;
  assert.ok(verifyBundle(e, f).some((p) => p.includes('-128')));
});

test('encodeVectors and decodeVectors round-trip and check dimensions', () => {
  const rows = [Int8Array.from({ length: DIMS }, (_, i) => (i % 255) - 127)];
  assert.deepEqual([...decodeVectors(encodeVectors(rows))[0]], [...rows[0]]);
  assert.throws(() => encodeVectors([new Int8Array(3)]), RangeError);
  assert.throws(() => decodeVectors(Buffer.alloc(DIMS + 1)), RangeError);
});

test('the model is bge-small-en-v1.5 with CLS pooling and the retrieval query prefix', () => {
  assert.deepEqual(bundle.model, { ...MODEL });
  assert.equal(MODEL.dims, 384);
  assert.equal(MODEL.query_prefix, 'Represent this sentence for searching relevant passages: ');
});

test('normalizeKey matches the server and facets match scripts/build-facets.mjs rules', async () => {
  // server/facets.mjs imports the search module, which needs no network to load.
  const { normalizeKey: serverKey } = await import('../server/facets.mjs');
  for (const s of ['Hall A | Room 1', '🔐 Security', 'Café Ünïcode', 'Salt Palace | Level 1 | Hall DE', '  Mixed   CASE ']) {
    assert.equal(normalizeKey(s), serverKey(s), s);
  }
  const security = bundle.facets.find((f) => f.kind === 'track' && f.value === '🔐 Security');
  assert.equal(security.label, 'Security');
  const room = bundle.facets.find((f) => f.kind === 'room' && f.value === 'Hall A | Room 1');
  assert.deepEqual(room.keys, ['hall a room 1', 'room 1']);
  assert.equal(room.label, 'Hall A · Room 1');
  assert.equal(bundle.facets.find((f) => f.value === 'Ada Example').talks, 2);
  assert.ok(!bundle.facets.some((f) => f.value === 'Breaks'), 'only kind talk items give names');
});

// The committed conference data: what the bundle builder will be fed in Phase 1.
const searchable = readdirSync(path.join(ROOT, 'data'))
  .filter((d) => existsSync(path.join(ROOT, 'data', d, 'talks.ndjson')) && existsSync(path.join(ROOT, 'data', d, 'conference.json')))
  .filter((d) => JSON.parse(readFileSync(path.join(ROOT, 'data', d, 'conference.json'), 'utf8')).status === 'searchable');

test('the committed searchable conferences fit the bundle talk schema', () => {
  assert.ok(searchable.length >= 1);
  const check = validator('talk-bundle.v1', 'Talk');
  for (const slug of searchable) {
    const lines = readFileSync(path.join(ROOT, 'data', slug, 'talks.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const t of lines) {
      // text_hash in talks.ndjson is sha256(title + "\n" + abstract): the passage the model embeds.
      assert.equal(textHash(t), t.text_hash, `${t.talk_id} text_hash`);
      const talk = { ...Object.fromEntries(TALK_FIELDS.map((f) => [f, t[f] ?? null])), topics: [], text_hash: textHash(t) };
      const r = check(talk, { closed: true });
      assert.equal(r.valid, true, `${t.talk_id}\n${formatErrors(r.errors)}`);
    }
  }
});

test('the facet builder accepts real conference data', () => {
  for (const slug of searchable) {
    const talks = readFileSync(path.join(ROOT, 'data', slug, 'talks.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const facets = buildFacets(talks);
    assert.ok(facets.length > 0, slug);
    assert.ok(facets.every((f) => f.keys.length && f.talks >= 1));
  }
});
