// ES_URL has no default. Scripts read it when a request is made (so paths that make no request run
// without it) and the server refuses to start without it. Every child runs with ES_URL deleted and
// with dummy keys, so no request can be made: there is no address to send one to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['ES_URL', 'ES_API_KEY', 'ELASTISEARCH_API_KEY', 'ES_PEOPLE_API_KEY', 'ES_ADMIN_API_KEY', 'GC_PROJECT']) {
    if (!(k in extraEnv)) delete env[k];
  }
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
}

test('ingest --no-fetch --dry-run exits 0 with no ES_URL and no key', () => {
  // --no-fetch rewrites the conference's ingested_at even on a dry run, so it runs on a temp copy
  // of the data (CADDIE_DATA_DIR); the tracked files are never touched.
  const slug = 'kubecon-cloudnativecon-north-america-2026';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-ingest-'));
  try {
    fs.cpSync(path.join(ROOT, 'data', slug), path.join(tmp, slug), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'raw'));
    fs.cpSync(path.join(ROOT, 'data', 'raw', slug), path.join(tmp, 'raw', slug), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'raw', 'lf-events-upcoming.json'), path.join(tmp, 'raw', 'lf-events-upcoming.json'));
    const r = run(['scripts/ingest.mjs', '--event', slug, '--no-fetch', '--dry-run', '--skip-topics'], { CADDIE_DATA_DIR: tmp });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Network calls this run: 0/);
    assert.ok(fs.existsSync(path.join(tmp, slug, 'conference.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ingest without --dry-run and without ES_URL says "Set ES_URL." before any download', () => {
  const r = run(['scripts/ingest.mjs', '--all-upcoming'], { ES_API_KEY: 'dummy', CADDIE_DATA_DIR: os.tmpdir() });
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /Set ES_URL\./);
});

test('make-dummy-people without an app address says so', () => {
  const r = run(['scripts/make-dummy-people.mjs'], { ES_API_KEY: 'dummy', ES_URL: 'https://es.invalid:443' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /APP_URL/);
});

test('seed-people and build-facets say "Set ES_URL." rather than a stack trace', () => {
  for (const [script, env] of [['scripts/seed-people.mjs', { ELASTISEARCH_API_KEY: 'dummy' }], ['scripts/build-facets.mjs', { ELASTISEARCH_API_KEY: 'dummy' }]]) {
    const r = run([script], env);
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /Set ES_URL\./, script);
    assert.doesNotMatch(r.stderr, /\n\s+at /, script);
  }
});

test('scripts/lib/es.mjs makes no request at import and fails on the first call', async () => {
  const code = `
    globalThis.fetch = () => { throw new Error('fetch at import'); };
    delete process.env.ES_URL;
    const m = await import('./scripts/lib/es.mjs');
    let message = '';
    try { await m.es('GET', '/'); } catch (e) { message = e.message; }
    console.log(message);
  `;
  const r = run(['--input-type=module', '-e', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Set ES_URL.');
});

test('a script that needs Elasticsearch exits 1 with "Set ES_URL." on its first request', () => {
  const cases = [
    ['scripts/moderation.mjs', ['--hidden', '--event', 'kubecon-cloudnativecon-north-america-2026'], { ELASTISEARCH_API_KEY: 'dummy' }],
    ['scripts/purge-expired-people.mjs', [], { ES_PEOPLE_API_KEY: 'dummy' }],
  ];
  for (const [script, args, env] of cases) {
    const r = run([script, ...args], env);
    assert.equal(r.status, 1, `${script}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Set ES_URL\./, script);
  }
});

test('the scripts that name a Google Cloud project require GC_PROJECT', () => {
  for (const [script, args, env] of [
    ['scripts/create-es-keys.mjs', ['--verify-only'], { ELASTISEARCH_API_KEY: 'dummy', ES_URL: 'https://es.invalid:443' }],
    ['scripts/vapid-keys.mjs', ['--dir', path.join(ROOT, 'node_modules', '.nonexistent-a2')], {}],
    ['scripts/ble-master.mjs', ['--status'], {}],
  ]) {
    const r = run([script, ...args], env);
    assert.notEqual(r.status, 0, script);
    assert.match(r.stderr, /GC_PROJECT/, script);
  }
});

test('the server does not start without ES_URL', () => {
  const r = run(['server/index.mjs'], { PORT: '0' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ES_URL is not set/);
});

test('server/es-url.mjs trims a trailing slash and refuses an empty value', async () => {
  process.env.ES_URL = 'https://es.example.invalid:443/';
  const m = await import('../server/es-url.mjs');
  assert.equal(m.ES_URL, 'https://es.example.invalid:443');
  for (const bad of [undefined, '', '   ']) assert.throws(() => m.esUrlFrom(bad), /ES_URL is not set/);
});
