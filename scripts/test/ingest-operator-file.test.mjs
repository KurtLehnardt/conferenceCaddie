// The operator file in the ingest run: a hidden slug is written unavailable (operator_hidden) and keeps
// its talks, a removed slug is skipped and its conference file left alone. Hermetic: a copy of one real
// conference in a temporary CADDIE_DATA_DIR, --no-fetch --dry-run, no key and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'kubecon-cloudnativecon-north-america-2026';
const text = (p) => readFileSync(p, 'utf8');
const TRACKED = [`data/${SLUG}/conference.json`, 'data/conference-overrides.json'];

function runCase(operator, { breakSchedulePage = false } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'caddie-operator-'));
  const before = TRACKED.map((f) => text(path.join(ROOT, f)));
  try {
    mkdirSync(path.join(tmp, 'raw'), { recursive: true });
    cpSync(path.join(ROOT, 'data/raw/lf-events-upcoming.json'), path.join(tmp, 'raw/lf-events-upcoming.json'));
    cpSync(path.join(ROOT, 'data/raw', SLUG), path.join(tmp, 'raw', SLUG), { recursive: true });
    mkdirSync(path.join(tmp, SLUG), { recursive: true });
    cpSync(path.join(ROOT, 'data', SLUG, 'conference.json'), path.join(tmp, SLUG, 'conference.json'));
    writeFileSync(path.join(tmp, 'conference-operator.json'), JSON.stringify(operator));
    // A schedule page without its data-sched-config makes the event unavailable (no_sched_config).
    if (breakSchedulePage) writeFileSync(path.join(tmp, 'raw', SLUG, 'schedule-page.html'), '<html><body>no config here</body></html>\n');
    const confPath = path.join(tmp, SLUG, 'conference.json');
    const confBefore = text(confPath);
    const run = spawnSync(process.execPath, ['scripts/ingest.mjs', '--event', SLUG, '--no-fetch', '--dry-run', '--skip-topics'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, CADDIE_DATA_DIR: tmp },
      encoding: 'utf8',
      timeout: 120000,
    });
    const out = {
      run,
      conf: JSON.parse(text(confPath)),
      confChanged: text(confPath) !== confBefore,
      talks: existsSync(path.join(tmp, SLUG, 'talks.ndjson')),
    };
    const after = TRACKED.map((f) => text(path.join(ROOT, f)));
    assert.deepEqual(after, before, 'the tracked data files are untouched');
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('a hidden slug is written unavailable with operator_hidden and keeps its talks', () => {
  const r = runCase({ hidden: { [SLUG]: { reason: 'other', since: '2026-11-11T00:00:00Z' } }, removed: {} });
  assert.equal(r.run.status, 0, r.run.stderr + r.run.stdout);
  assert.equal(r.conf.status, 'unavailable');
  assert.equal(r.conf.status_reason, 'operator_hidden');
  assert.ok(r.talks, 'talks.ndjson is kept');
});

test('a removed slug is skipped and its conference file is unchanged', () => {
  const r = runCase({ hidden: {}, removed: { [SLUG]: { since: '2026-11-11T00:00:00Z' } } });
  assert.equal(r.run.status, 0, r.run.stderr + r.run.stdout);
  assert.match(r.run.stdout, /skipped: removed by the operator/);
  assert.match(r.run.stdout, /conferences unretire/);
  assert.equal(r.confChanged, false);
});

test('a hidden slug whose fetch or parse failed keeps its own reason, not operator_hidden', () => {
  const r = runCase({ hidden: { [SLUG]: { reason: 'other', since: '2026-11-11T00:00:00Z' } }, removed: {} }, { breakSchedulePage: true });
  assert.equal(r.run.status, 0, r.run.stderr + r.run.stdout);
  assert.equal(r.conf.status, 'unavailable');
  assert.equal(r.conf.status_reason, 'no_sched_config');
  assert.ok(!r.run.stdout.includes('hidden by the operator'));
});

test('an empty operator file is the normal run', () => {
  const r = runCase({ hidden: {}, removed: {} });
  assert.equal(r.run.status, 0, r.run.stderr + r.run.stdout);
  assert.equal(r.conf.status, 'searchable');
});
