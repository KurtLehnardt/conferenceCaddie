// Every contract schema compiles under the strict validator, and every fixture validates against
// its schema in producer (closed) mode. Negative fixtures must fail. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, validator } from '../contracts/js/schemas.mjs';
import { compile, formatErrors } from '../contracts/js/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'contracts/fixtures');
const readJson = (...p) => JSON.parse(readFileSync(path.join(...p), 'utf8'));
const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

function assertValid(result, label) {
  assert.equal(result.valid, true, `${label}\n${formatErrors(result.errors)}`);
}

test('every schema is draft 2020-12, has a raw.githubusercontent.com $id matching its file, and compiles strictly', () => {
  const schemas = loadSchemas();
  assert.ok(schemas.size >= 7);
  for (const [name, s] of schemas) {
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(s.$id, `https://raw.githubusercontent.com/KurtLehnardt/conferenceCaddie/main/contracts/schema/${name}.schema.json`, name);
    assert.doesNotThrow(() => compile(s, { schemas: [...schemas.values()].filter((o) => o !== s) }), name);
  }
});

test('capabilities fixtures for every tier validate in closed mode', () => {
  const check = validator('capabilities.v1');
  for (const f of ['tier1-demo.json', 'tier2-free.json', 'tier3-paid.json', 'tier3-transition.json', 'legacy-effective.json']) {
    assertValid(check(readJson(FIX, 'capabilities', f), { closed: true }), f);
  }
});

test('invalid capabilities fixtures fail, and the closed-only one passes in consumer mode', () => {
  const check = validator('capabilities.v1');
  for (const f of jsonFiles(path.join(FIX, 'capabilities/invalid'))) {
    const doc = readJson(FIX, 'capabilities/invalid', f);
    assert.equal(check(doc, { closed: true }).valid, false, `${f} should fail in closed mode`);
    if (f === 'unknown-field-closed-only.json') assert.equal(check(doc).valid, true, `${f} should pass in consumer mode`);
    else assert.equal(check(doc).valid, false, `${f} should fail in consumer mode`);
  }
});

test('the conference index and the fixture bundle validate in closed mode', () => {
  const index = readJson(FIX, 'bundle/conferences.json');
  assertValid(validator('conferences-index.v1')(index, { closed: true }), 'conferences.json');
  const checkBundle = validator('talk-bundle.v1');
  for (const c of index.conferences.filter((c) => c.bundle)) {
    const bundle = readJson(FIX, 'bundle', c.bundle.path, 'bundle.json');
    assertValid(checkBundle(bundle, { closed: true }), c.bundle.path);
  }
});

test('an unavailable conference may not carry a bundle', () => {
  const index = readJson(FIX, 'bundle/conferences.json');
  const broken = structuredClone(index);
  const unavailable = broken.conferences.find((c) => c.status === 'unavailable');
  unavailable.bundle = broken.conferences.find((c) => c.bundle).bundle;
  assert.equal(validator('conferences-index.v1')(broken).valid, false);
});

test('the conference index is a superset of the GET /api/conferences entry shape', () => {
  const index = readJson(FIX, 'bundle/conferences.json');
  const check = validator('conferences-index.v1', 'Conference');
  for (const c of index.conferences) {
    const { bundle, ...entry } = c;
    assertValid(check(entry, { closed: true }), c.slug);
  }
});

test('BLE golden vectors and resolution cases match their schemas', () => {
  assertValid(validator('ble-fixtures.v1', 'GoldenVectors')(readJson(FIX, 'ble/golden-vectors.v1.json'), { closed: true }), 'golden-vectors');
  assertValid(validator('ble-fixtures.v1', 'ResolutionCases')(readJson(FIX, 'ble/resolution-cases.v1.json'), { closed: true }), 'resolution-cases');
  assertValid(validator('ble-fixtures.v1')(readJson(FIX, 'ble/golden-vectors.v1.json')), 'root oneOf');
});

// Every live topic snapshot is a response of the tier 3 service, where scripts/topics.mjs builds the lists.
const SNAPSHOT_HOST = 'https://conference-caddie-265846417372.us-west1.run.app';

test('live topic snapshots match the snapshot schema and the topics API rules', () => {
  const check = validator('topics-snapshot.v1');
  const files = jsonFiles(path.join(FIX, 'topics-live'));
  assert.deepEqual(files, [
    'grpconf-india-2026.json',
    'kubecon-cloudnativecon-north-america-2026.json',
    'mcp-dev-summit-nairobi-2026.json',
    'pytorch-day-japan-2026.json',
  ]);
  for (const f of files) {
    const snap = readJson(FIX, 'topics-live', f);
    assertValid(check(snap, { closed: true }), f);
    assert.equal(`${snap.event}.json`, f);
    // Taken on 2026-11-10; a snapshot refreshed for newer data says when.
    assert.equal(snap.snapshot.taken_on, snap.snapshot.fetched_at.slice(0, 10), `${f} taken_on`);
    assert.ok(snap.snapshot.taken_on >= '2026-11-10', `${f} taken_on`);
    assert.equal(snap.snapshot.source, `GET ${SNAPSHOT_HOST}/api/topics?event=${snap.event}`, `${f} source`);
    // Sorted by rank: talk_count descending (CONTRACT.md: ties by label).
    for (let i = 1; i < snap.topics.length; i++) assert.ok(snap.topics[i - 1].talk_count >= snap.topics[i].talk_count, `${f} order at ${i}`);
    assert.equal(new Set(snap.topics.map((t) => t.topic_id)).size, snap.topics.length, `${f} duplicate topic`);
  }
});

test('the route table matches its schema', () => {
  assertValid(validator('route-table.v1')(readJson(ROOT, 'contracts/routes/people-api.v1.json'), { closed: true }), 'people-api.v1 routes');
});
