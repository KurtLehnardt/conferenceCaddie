// Builds the golden talk bundle under contracts/fixtures/bundle/ from the hand-written inputs in
// contracts/fixtures/bundle-inputs/. The tests rebuild it and compare bytes, so the committed
// files are always exactly what the reference builder produces. After a deliberate change to the
// bundle format, regenerate with:
//
//   node contracts/js/fixtures.mjs --write

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildBundle, DIMS, INDEX_VERSION } from './bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '../fixtures');
const INPUTS = path.join(FIXTURES, 'bundle-inputs');
export const BUNDLE_OUT = path.join(FIXTURES, 'bundle');
export const GENERATED_AT = '2026-11-10T00:00:00Z';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Dense float rows from the sparse vectors.json of a fixture conference. */
export function denseVectors(file) {
  const src = readJson(file);
  if (src.dims !== DIMS) throw new Error(`fixture dims ${src.dims}, expected ${DIMS}`);
  return new Map(Object.entries(src.rows).map(([id, pairs]) => {
    const row = new Array(DIMS).fill(0);
    for (const [i, v] of pairs) row[i] = v;
    return [id, row];
  }));
}

/** The fixture bundle(s) and the conferences.json that indexes them. */
export function buildFixtureBundles() {
  const conferences = readJson(path.join(INPUTS, 'conferences.json'));
  const bundles = [];
  const index = { index_version: INDEX_VERSION, generated_at: GENERATED_AT, conferences: [] };
  for (const conference of conferences) {
    if (conference.status !== 'searchable') {
      index.conferences.push({ ...conference, bundle: null });
      continue;
    }
    const dir = path.join(INPUTS, conference.slug);
    const built = buildBundle({
      conference,
      talks: readJson(path.join(dir, 'talks.json')),
      topics: readJson(path.join(dir, 'topics.json')),
      vectors: denseVectors(path.join(dir, 'vectors.json')),
    });
    bundles.push(built);
    index.conferences.push({ ...conference, bundle: built.entry });
  }
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return { bundles, index, indexBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const { bundles, indexBytes } = buildFixtureBundles();
  rmSync(BUNDLE_OUT, { recursive: true, force: true });
  mkdirSync(BUNDLE_OUT, { recursive: true });
  writeFileSync(path.join(BUNDLE_OUT, 'conferences.json'), indexBytes);
  for (const b of bundles) {
    const dir = path.join(BUNDLE_OUT, b.dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(b.files)) writeFileSync(path.join(dir, name), bytes);
    console.log(`wrote ${path.relative(process.cwd(), dir)} (${b.entry.content_hash})`);
  }
}
