// The time zone override table (data/conference-overrides.json) and the operator file's shape. The
// overrides are read only by scripts/lib/zones.mjs; the operator file is read only by ingest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZoneTables, resolveTimeZone } from '../lib/zones.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const SLUG = 'pytorch-day-japan-2026';

test('an override resolves the zone without an api-data zone', () => {
  const zones = loadZoneTables(ROOT);
  const r = resolveTimeZone(SLUG, null, zones);
  assert.equal(r.time_zone, 'Asia/Tokyo');
  assert.equal(r.reason, null);
});

test('an override wins over an unmapped api-data zone', () => {
  const zones = loadZoneTables(ROOT);
  const r = resolveTimeZone(SLUG, { timezone: 'Not A Real Windows Zone' }, zones);
  assert.equal(r.time_zone, 'Asia/Tokyo');
  assert.ok(r.message, 'a message names the mismatch');
});

test('conference-overrides.json keeps its documented shape', () => {
  assert.deepEqual(readJson('data/conference-overrides.json'), { [SLUG]: { time_zone: 'Asia/Tokyo' } });
});

test('conference-operator.json has hidden and removed objects', () => {
  const doc = readJson('data/conference-operator.json');
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  assert.ok(plain(doc));
  assert.ok(plain(doc.hidden));
  assert.ok(plain(doc.removed));
});
