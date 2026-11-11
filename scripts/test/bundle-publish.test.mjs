// The publishing rule of the talk bundles (finding cor-4): the ingest run publishes the bundles from
// the schedule it pushed to the Worker, and a build from the older committed data/ keeps those live
// bundles instead of replacing them (scripts/lib/bundle-sources.mjs, build-bundles.mjs --live), plus
// the staging of the pushed files (scripts/stage-ingest-data.mjs). Hermetic: a stub embedder, two
// small real conferences copied to a temporary data directory, and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DIMS, verifyBundle } from '../../contracts/js/bundle.mjs';
import { parseArgs, run, UsageError, loadLiveSite } from '../build-bundles.mjs';
import { planBuild, parseSources, serializeSources, takedownsMatching, sourceSha256, SOURCES_FILE, FUTURE_SKEW_MS } from '../lib/bundle-sources.mjs';
import { stagePlan } from '../stage-ingest-data.mjs';
import { selectSlugs } from '../../worker/ingest/push-ingest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'pytorch-day-japan-2026';
const B = 'grpconf-india-2026';
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const H = (c) => c.repeat(64);

function hashEmbedder() {
  const e = {
    identity: { stub: 1 },
    texts: 0,
    embedDocuments: async (texts) => {
      e.texts += texts.length;
      return texts.map((t) => {
        const h = crypto.createHash('sha256').update(t).digest();
        return Array.from({ length: DIMS }, (_, i) => (h[i % 32] - 127.5) / 128 + (i % 7) * 0.01);
      });
    },
    embedQueries: async (texts) => e.embedDocuments(texts),
  };
  return e;
}

async function withTemp(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'caddie-publish-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A data directory with the two conferences, as committed.
function seedData(root, name = 'data') {
  const dir = path.join(root, name);
  for (const slug of [A, B]) cpSync(path.join(ROOT, 'data', slug), path.join(dir, slug), { recursive: true });
  return dir;
}

// Changes one conference the way a later upstream fetch would: a new fetch time and a new title.
function refetch(dataDir, slug, fetchedAt, title = 'A retitled talk from a later fetch') {
  const confFile = path.join(dataDir, slug, 'conference.json');
  writeFileSync(confFile, `${JSON.stringify({ ...readJson(confFile), raw_fetched_at: fetchedAt }, null, 2)}\n`);
  const talksFile = path.join(dataDir, slug, 'talks.ndjson');
  const talks = readFileSync(talksFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const i = talks.findIndex((t) => t.kind === 'talk');
  talks[i] = { ...talks[i], title };
  writeFileSync(talksFile, `${talks.map((t) => JSON.stringify(t)).join('\n')}\n`);
}

function setStatus(dataDir, slug, fields) {
  const confFile = path.join(dataDir, slug, 'conference.json');
  writeFileSync(confFile, `${JSON.stringify({ ...readJson(confFile), ...fields }, null, 2)}\n`);
}

const build = (args, dataDir, log = () => {}, extra = {}) => run(parseArgs(['--reuse-from', 'none', ...args]), { embedder: hashEmbedder(), dataDir, log, now: () => new Date('2026-11-20T00:00:00Z'), ...extra });
const indexOf = (out) => readJson(path.join(out, 'bundles/conferences.json'));
const pathOf = (out, slug) => indexOf(out).conferences.find((c) => c.slug === slug)?.bundle?.path ?? null;

test('planBuild: a newer live source is kept, a failed fetch keeps the live bundle, and data/ wins otherwise', () => {
  const live = (slug, hash, fetched) => ({
    conferences: [{ conference: { slug }, bundle: { content_hash: hash, path: `${slug}/${hash.slice(0, 16)}/` } }],
    sources: new Map([[slug, { content_hash: hash, raw_fetched_at: fetched, source_sha256: null }]]),
  });
  const doc = (fetched, status = 'searchable', reason = null) => ({ status, status_reason: reason, raw_fetched_at: fetched });
  const plan = (local, l) => Object.fromEntries([...planBuild({ local: new Map(Object.entries(local)), live: l })].map(([k, v]) => [k, v.action]));

  assert.deepEqual(plan({ x: doc('2026-11-09T00:00:00Z') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'keep' });
  assert.deepEqual(plan({ x: doc('2026-11-10T00:00:00Z') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'build' }, 'equal times build from data/');
  assert.deepEqual(plan({ x: doc('2026-11-11T00:00:00Z') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'build' });
  assert.deepEqual(plan({}, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'keep' }, 'a live bundle with a record and nothing in data/ stays');
  assert.deepEqual(plan({ x: doc('2026-11-11T00:00:00Z', 'unavailable', 'fetch_failed') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'keep' });
  assert.deepEqual(plan({ x: doc('2026-11-11T00:00:00Z', 'unavailable', 'no_sched_config') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'drop' });
  assert.deepEqual(plan({ x: doc('2026-11-09T00:00:00Z', 'unavailable', 'no_sched_config') }, live('x', H('a'), '2026-11-10T00:00:00Z')), { x: 'keep' }, 'an older unavailable state does not drop a newer bundle');
  // A record for another bundle than the live one counts for nothing, nor does a site without records.
  const stale = live('x', H('a'), '2026-11-10T00:00:00Z');
  stale.sources.set('x', { content_hash: H('b'), raw_fetched_at: '2026-11-10T00:00:00Z' });
  assert.deepEqual(plan({ x: doc('2026-11-09T00:00:00Z') }, stale), { x: 'build' });
  assert.deepEqual(plan({}, { ...live('x', H('a'), null), sources: new Map() }), { x: 'drop' });
  assert.deepEqual(plan({ x: doc('2026-11-09T00:00:00Z'), y: doc(null, 'unavailable') }, null), { x: 'build' }, 'no live site: data/ as before');
});

test('planBuild: a record dated in the future counts for nothing, and a fresh slug always follows data/', () => {
  const now = Date.parse('2026-11-16T09:30:00Z');
  const live = (fetched) => ({
    conferences: [{ conference: { slug: 'x' }, bundle: { content_hash: H('a'), path: `x/${H('a').slice(0, 16)}/` } }],
    sources: new Map([['x', { content_hash: H('a'), raw_fetched_at: fetched, source_sha256: null }]]),
  });
  const doc = (fetched, status = 'searchable', reason = null) => ({ status, status_reason: reason, raw_fetched_at: fetched });
  const plan = (local, l, extra = {}) => Object.fromEntries([...planBuild({ local: new Map(Object.entries(local)), live: l, now, ...extra })].map(([k, v]) => [k, v.action]));

  // A record pinned far ahead, against a fresh ingest: the ingest wins.
  assert.deepEqual(plan({ x: doc('2026-11-16T09:20:00Z') }, live('9999-12-31T00:00:00Z')), { x: 'build' });
  assert.deepEqual(plan({}, live('9999-12-31T00:00:00Z')), { x: 'drop' }, 'nor does it keep a bundle data/ does not have');
  // Within the clock-skew allowance it still counts; just past it, it does not.
  const within = new Date(now + FUTURE_SKEW_MS).toISOString();
  const past = new Date(now + FUTURE_SKEW_MS + 1000).toISOString();
  assert.deepEqual(plan({ x: doc('2026-11-16T09:20:00Z') }, live(within)), { x: 'keep' });
  assert.deepEqual(plan({ x: doc('2026-11-16T09:20:00Z') }, live(past)), { x: 'build' });

  // A fresh slug (staged by this ingest run) follows data/ even when the live record is newer...
  assert.deepEqual(plan({ x: doc('2026-11-09T00:00:00Z') }, live('2026-11-10T00:00:00Z'), { fresh: new Set(['x']) }), { x: 'build' });
  // ...and is left out when this run found it unavailable, also after a failed fetch, as the Worker now does.
  assert.deepEqual(plan({ x: doc('2026-11-16T09:20:00Z', 'unavailable', 'fetch_failed') }, live('2026-11-10T00:00:00Z'), { fresh: new Set(['x']) }), { x: 'drop' });
  assert.deepEqual(plan({ x: doc('2026-11-16T09:20:00Z', 'unavailable', 'fetch_failed') }, live('2026-11-10T00:00:00Z')), { x: 'keep' }, 'not fresh: a failed fetch keeps the live bundle');
});

test('sources.json: round trip, and malformed records are ignored', () => {
  const records = new Map([['b-conf', { content_hash: H('b'), raw_fetched_at: '2026-11-10T00:00:00Z', source_sha256: H('c') }], ['a-conf', { content_hash: H('a'), raw_fetched_at: null, source_sha256: null }]]);
  const bytes = serializeSources(records);
  const doc = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(doc.conferences), ['a-conf', 'b-conf']);
  assert.deepEqual(parseSources(doc), new Map([...records].sort()));
  assert.equal(parseSources({ sources_version: 2, conferences: {} }).size, 0);
  assert.equal(parseSources(null).size, 0);
  assert.deepEqual([...parseSources({ sources_version: 1, conferences: { 'Bad Slug': { content_hash: H('a') }, ok: { content_hash: 'short' }, fine: { content_hash: H('d'), raw_fetched_at: 'not a time' } } })], [['fine', { content_hash: H('d'), raw_fetched_at: null, source_sha256: null }]]);
  assert.notEqual(sourceSha256({ slug: 'x' }, 'a\n'), sourceSha256({ slug: 'x' }, 'b\n'));
  // The build's generated_at is written next to the records, which still parse the same.
  const stamped = JSON.parse(serializeSources(records, '2026-11-11T00:00:00Z').toString('utf8'));
  assert.equal(stamped.generated_at, '2026-11-11T00:00:00Z');
  assert.deepEqual(parseSources(stamped), parseSources(doc));
});

test('takedownsMatching finds a talk or a speaker that a kept bundle still holds', () => {
  const talks = [{ talk_id: 'x:1', speakers: ['Ada Lovelace'] }, { talk_id: 'x:2', speakers: ['Grace Hopper'] }];
  assert.equal(takedownsMatching('x', talks, [{ slug: 'x', talk_id: 'x:1' }]).length, 1);
  assert.equal(takedownsMatching('x', talks, [{ slug: 'x', talk_id: 'x:9' }]).length, 0);
  assert.equal(takedownsMatching('x', talks, [{ slug: 'x', speaker: 'ADA LOVELACE' }]).length, 1);
  assert.equal(takedownsMatching('x', talks, [{ slug: 'x', talk_id: 'x:2', speaker: 'Ada Lovelace' }]).length, 0);
  assert.equal(takedownsMatching('y', talks, [{ slug: 'x', talk_id: 'x:1' }]).length, 0);
});

test('--live: an ingest build publishes the fresh schedule, and a later build from the older seed keeps it', async () => withTemp(async (root) => {
  assert.throws(() => parseArgs(['--live', 'https://example.org/bundles/', '--only', A]), UsageError);
  assert.throws(() => parseArgs(['--live', 'http://example.org/bundles/']), UsageError);
  assert.equal(parseArgs(['--live', 'none']).live, null);

  // 1. The site as it is today: built from the committed seed, no live site to compare with.
  const seed = seedData(root);
  const site0 = path.join(root, 'site0');
  assert.ok((await build(['--out', site0], seed)).ok);
  const records0 = parseSources(readJson(path.join(site0, 'bundles', SOURCES_FILE)));
  assert.deepEqual([...records0.keys()], [B, A].sort());
  assert.equal(records0.get(A).raw_fetched_at, readJson(path.join(seed, A, 'conference.json')).raw_fetched_at);
  assert.equal(records0.get(A).content_hash, indexOf(site0).conferences.find((c) => c.slug === A).bundle.content_hash);

  // 2. An ingest run: A was fetched again and changed; the staged files are laid over the seed.
  const fresh = seedData(root, 'fresh');
  refetch(fresh, A, '2026-11-11T09:20:00.000Z');
  const site1 = path.join(root, 'site1');
  const log1 = [];
  assert.ok((await build(['--out', site1, '--live', site0], fresh, (m) => log1.push(m))).ok);
  assert.notEqual(pathOf(site1, A), pathOf(site0, A), 'A is rebuilt from the fresh fetch');
  assert.equal(pathOf(site1, B), pathOf(site0, B), 'B is rebuilt from the same data, to the same bundle');
  assert.ok(log1.some((m) => m.includes(`${A}: build`)));
  const bundleA = readJson(path.join(site1, 'bundles', pathOf(site1, A), 'bundle.json'));
  assert.ok(bundleA.talks.some((t) => t.title === 'A retitled talk from a later fetch'));

  // 3. A push to main or the weekly run: built from the older committed seed, against the live site.
  const site2 = path.join(root, 'site2');
  const log2 = [];
  const r2 = await build(['--out', site2, '--live', site1], seed, (m) => log2.push(m));
  assert.ok(r2.ok);
  assert.equal(pathOf(site2, A), pathOf(site1, A), 'the newer ingest bundle is kept, not replaced by the seed');
  assert.equal(pathOf(site2, B), pathOf(site1, B));
  assert.deepEqual(r2.bundles.map((b) => b.slug), [B], 'only B is built; A is kept');
  assert.ok(log2.some((m) => m.includes(`${A}: keep the live bundle`)));
  const entryA = indexOf(site2).conferences.find((c) => c.slug === A);
  const files = Object.fromEntries(['bundle.json', 'vectors.i8'].map((n) => [n, readFileSync(path.join(site2, 'bundles', entryA.bundle.path, n))]));
  assert.deepEqual(verifyBundle(entryA.bundle, files), [], 'the kept bundle is written to --out and verifies');
  assert.deepEqual(indexOf(site2).conferences.find((c) => c.slug === A), indexOf(site1).conferences.find((c) => c.slug === A));
  assert.deepEqual(parseSources(readJson(path.join(site2, 'bundles', SOURCES_FILE))).get(A), parseSources(readJson(path.join(site1, 'bundles', SOURCES_FILE))).get(A));
  // The same build again from the result is stable.
  const site3 = path.join(root, 'site3');
  await build(['--out', site3, '--live', site2], seed);
  assert.deepEqual(readFileSync(path.join(site3, 'bundles/conferences.json')).toString().replace(/"generated_at": "[^"]+"/, ''), readFileSync(path.join(site2, 'bundles/conferences.json')).toString().replace(/"generated_at": "[^"]+"/, ''));

  // 4. A later ingest whose fetch of A failed keeps A's live bundle; one that finds A gone drops it.
  const failed = seedData(root, 'failed');
  setStatus(failed, A, { status: 'unavailable', status_reason: 'fetch_failed', raw_fetched_at: '2026-11-18T09:20:00.000Z' });
  const site4 = path.join(root, 'site4');
  await build(['--out', site4, '--live', site2], failed);
  assert.equal(pathOf(site4, A), pathOf(site1, A));
  const gone = seedData(root, 'gone');
  setStatus(gone, A, { status: 'unavailable', status_reason: 'no_sched_config', raw_fetched_at: '2026-11-18T09:20:00.000Z' });
  const site5 = path.join(root, 'site5');
  await build(['--out', site5, '--live', site2], gone);
  assert.equal(pathOf(site5, A), null);
  assert.ok(!parseSources(readJson(path.join(site5, 'bundles', SOURCES_FILE))).has(A));

  // 5. A takedown that still matches a kept bundle: it is rebuilt from data/ instead (the takedown wins).
  const takedownSeed = seedData(root, 'takedown');
  const victim = readFileSync(path.join(takedownSeed, A, 'talks.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((t) => t.kind === 'talk' && t.title !== 'A retitled talk from a later fetch');
  writeFileSync(path.join(takedownSeed, 'takedowns.json'), JSON.stringify([{ slug: A, talk_id: victim.talk_id, reason: 'test', date: '2026-11-11' }]));
  // conference.json counts the talks before the takedown; the builder adjusts talk_count itself.
  const site6 = path.join(root, 'site6');
  const log6 = [];
  await build(['--out', site6, '--live', site2], takedownSeed, (m) => log6.push(m));
  assert.ok(log6.some((m) => m.includes('a takedown matches the live bundle')));
  const rebuilt = readJson(path.join(site6, 'bundles', pathOf(site6, A), 'bundle.json'));
  assert.ok(!rebuilt.talks.some((t) => t.talk_id === victim.talk_id));
}));

test('--live over https: a 404 is the first deploy, any other failure stops the build', async () => withTemp(async (root) => {
  const seed = seedData(root);
  const site0 = path.join(root, 'site0');
  await build(['--out', site0], seed);
  const base = 'https://pages.example.org/site/bundles/';
  const serveDir = (dir) => async (url) => {
    const rel = new URL(url).pathname.replace('/site/bundles/', '');
    const file = path.join(dir, 'bundles', rel);
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(file));
  };
  const live = await loadLiveSite({ source: base, fetchFn: serveDir(site0) });
  assert.equal(live.conferences.length, 2);
  assert.equal(live.sources.size, 2);
  const empty = path.join(root, 'empty');
  mkdirSync(path.join(empty, 'bundles'), { recursive: true });
  assert.equal(await loadLiveSite({ source: base, fetchFn: serveDir(empty) }), null);
  await assert.rejects(loadLiveSite({ source: base, fetchFn: async () => new Response('busy', { status: 503 }) }), /could not read the live conferences.json/);
  await assert.rejects(loadLiveSite({ source: base, fetchFn: async () => { throw new Error('offline'); } }), /could not read the live conferences.json/);
  await assert.rejects(loadLiveSite({ source: base, offline: true }), UsageError);
  // A live site built before the sidecar existed: nothing is newer, everything is built from data/.
  rmSync(path.join(site0, 'bundles', SOURCES_FILE));
  const old = await loadLiveSite({ source: base, fetchFn: serveDir(site0) });
  assert.equal(old.sources.size, 0);
  const site1 = path.join(root, 'site1');
  const r = await build(['--out', site1, '--live', base], seed, () => {}, { fetchFn: serveDir(site0) });
  assert.deepEqual(r.bundles.map((b) => b.slug).sort(), [A, B].sort());
}));

test('--live-since: a CDN copy older than the latest deployment, or a mixed one, is read again, then fails', async () => withTemp(async (root) => {
  assert.throws(() => parseArgs(['--live-since', '2026-11-11T00:00:00Z']), UsageError, '--live-since needs --live');
  assert.throws(() => parseArgs(['--live', 'none', '--fresh', A]), UsageError);
  assert.throws(() => parseArgs(['--live', 'https://example.org/bundles/', '--live-since', 'yesterday']), UsageError);
  assert.throws(() => parseArgs(['--live', 'https://example.org/bundles/', '--fresh', 'Bad Slug']), UsageError);
  assert.deepEqual(parseArgs(['--live', 'https://example.org/bundles/', '--fresh', `${A},${B}`]).fresh, [A, B]);

  const seed = seedData(root);
  const oldSite = path.join(root, 'old');
  const newSite = path.join(root, 'new');
  await build(['--out', oldSite], seed, () => {}, { now: () => new Date('2026-11-10T00:00:00Z') });
  refetch(seed, A, '2026-11-11T09:20:00.000Z');
  await build(['--out', newSite], seed);
  const since = '2026-11-11T09:40:00Z';
  const OLD = 'Wed, 11 Nov 2026 09:00:05 GMT';
  const NEW = 'Wed, 11 Nov 2026 09:40:07 GMT';
  const base = 'https://pages.example.org/site/bundles/';
  // `plan(n)` says, per read of conferences.json, which deploy each file comes from.
  const server = (plan) => {
    let reads = 0;
    const fn = async (url) => {
      const rel = new URL(url).pathname.replace('/site/bundles/', '');
      if (rel === 'conferences.json') reads++;
      const which = plan(reads)[rel === SOURCES_FILE ? 'sources' : 'index'];
      const dir = which === 'new' ? newSite : oldSite;
      const file = path.join(dir, 'bundles', rel);
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(readFileSync(file), { headers: { 'last-modified': which === 'new' ? NEW : OLD } });
    };
    fn.reads = () => reads;
    return fn;
  };
  const wait = { waitMs: 90_000, retryMs: 30_000, sleep: async () => {} };
  const newSources = parseSources(readJson(path.join(newSite, 'bundles', SOURCES_FILE)));

  // The CDN serves the old deploy twice, then the new one: three reads, and the new records.
  const lagging = server((n) => (n < 3 ? { index: 'old', sources: 'old' } : { index: 'new', sources: 'new' }));
  const log = [];
  const live = await loadLiveSite({ source: base, fetchFn: lagging, since, log: (m) => log.push(m), ...wait });
  assert.equal(lagging.reads(), 3);
  assert.deepEqual(live.sources, newSources);
  assert.ok(log.some((m) => m.includes('older than the latest deployment')));

  // A new index with the old sidecar, with no Last-Modified to go by: the generated_at check catches it.
  const mixed = path.join(root, 'mixed');
  cpSync(newSite, mixed, { recursive: true });
  cpSync(path.join(oldSite, 'bundles', SOURCES_FILE), path.join(mixed, 'bundles', SOURCES_FILE));
  await assert.rejects(loadLiveSite({ source: mixed, ...wait }), /from another build than conferences.json/);

  // Never current within the wait: the build fails instead of building from the old deploy.
  const stuck = server(() => ({ index: 'old', sources: 'old' }));
  await assert.rejects(loadLiveSite({ source: base, fetchFn: stuck, since, ...wait }), /older than the latest deployment.*still after 4 reads/);
  // Without --live-since the old Last-Modified is not looked at.
  assert.ok(await loadLiveSite({ source: base, fetchFn: server(() => ({ index: 'old', sources: 'old' })), ...wait }));
  // A 404 although a deployment exists is a CDN miss, not a first deploy.
  await assert.rejects(loadLiveSite({ source: base, fetchFn: async () => new Response('', { status: 404 }), since, ...wait }), /no conferences.json although a deployment exists/);
}));

// Finding 1 of the PR #53 review: ended events drop off the LF upcoming list, so data/ holds their
// committed seed while the Worker and the live bundles hold a newer ingest. The ingest must push and
// publish only what it fetched in this run.
test('an ended conference: its seed is neither pushed nor staged, and its newer live bundle stays', async () => withTemp(async (root) => {
  // Last week's ingest fetched A and B; the live site carries those bundles.
  const seed = seedData(root);
  const lastWeek = seedData(root, 'last-week');
  refetch(lastWeek, A, '2026-11-10T09:20:00.000Z');
  refetch(lastWeek, B, '2026-11-10T09:20:00.000Z', 'Another retitled talk');
  const site0 = path.join(root, 'site0');
  await build(['--out', site0, '--live', 'none'], lastWeek);

  // This week A has ended and is no longer on the upcoming list: ingest.mjs fetches only B.
  const ingestReport = { processed: [B] };
  const thisWeek = seedData(root, 'this-week');
  refetch(thisWeek, B, '2026-11-16T09:20:00.000Z', 'A third title');
  assert.deepEqual(selectSlugs({ ingestReport, all: () => [A, B] }), [B], 'the push takes the fetched conferences only');
  assert.deepEqual(selectSlugs({ ingestReport: { processed: [] }, all: () => [A, B] }), [], 'an empty run pushes nothing');
  assert.deepEqual(selectSlugs({ all: () => [A, B] }), [A, B], 'with neither, every folder (a manual push)');
  assert.deepEqual(selectSlugs({ events: [B, B] }), [B]);
  assert.throws(() => selectSlugs({ events: [A], ingestReport }), /not both/);
  assert.throws(() => selectSlugs({ ingestReport: { processed: ['../x'] } }), /processed/);
  assert.throws(() => selectSlugs({ ingestReport: {} }), /processed/);

  // Staging refuses a pushed conference that was not fetched: the Worker would have got the seed.
  const readConf = (dir) => (slug) => readJson(path.join(dir, slug, 'conference.json'));
  assert.throws(() => stagePlan({ upserted: [A, B], pushed: [A, B] }, readConf(thisWeek), ingestReport.processed), new RegExp(`not fetched in this run.*${A}`));
  assert.throws(() => stagePlan({ upserted: [B], pushed: [B] }, readConf(thisWeek), 'missing'), /processed/);
  const staged = stagePlan({ upserted: [B], pushed: [B] }, readConf(thisWeek), ingestReport.processed);
  assert.deepEqual(staged, [{ slug: B, files: ['conference.json', 'talks.ndjson'] }]);

  // The called pages.yml lays the staged B over the checked-out data/ (A stays the seed there) and
  // rebuilds B (--fresh); A's live bundle is newer than its seed and stays as it is.
  const checkout = seedData(root, 'checkout');
  for (const f of staged[0].files) cpSync(path.join(thisWeek, B, f), path.join(checkout, B, f));
  const site1 = path.join(root, 'site1');
  const log = [];
  const r = await build(['--out', site1, '--live', site0, '--fresh', B], checkout, (m) => log.push(m), { now: () => new Date('2026-11-16T09:40:00Z') });
  assert.deepEqual(r.bundles.map((b) => b.slug), [B]);
  assert.equal(pathOf(site1, A), pathOf(site0, A), 'the ended conference keeps the bundle of its last real fetch');
  assert.notEqual(pathOf(site1, B), pathOf(site0, B));
  assert.ok(readJson(path.join(site1, 'bundles', pathOf(site1, B), 'bundle.json')).talks.some((t) => t.title === 'A third title'));
  assert.ok(log.some((m) => m.includes(`${B}: build (fetched and pushed to the Worker in this ingest run)`)));

  // The weekly pages.yml run from the seed afterwards changes neither.
  const site2 = path.join(root, 'site2');
  await build(['--out', site2, '--live', site1], seed, () => {}, { now: () => new Date('2026-11-16T11:50:00Z') });
  assert.equal(pathOf(site2, A), pathOf(site1, A));
  assert.equal(pathOf(site2, B), pathOf(site1, B));
}));

test('stage-ingest-data stages exactly what reached the Worker', async () => withTemp(async (root) => {
  const docs = { a: { status: 'searchable' }, b: { status: 'searchable' }, c: { status: 'unavailable', status_reason: 'no_sched_config' }, d: { status: 'unavailable', status_reason: 'fetch_failed' }, e: { status: 'searchable' } };
  const plan = stagePlan({ upserted: ['a', 'b', 'c', 'e'], kept: ['d'], pushed: ['a'], failed: ['b'], not_attempted: ['e'] }, (s) => docs[s] ?? null);
  assert.deepEqual(plan, [{ slug: 'a', files: ['conference.json', 'talks.ndjson'] }, { slug: 'c', files: ['conference.json'] }]);
  assert.deepEqual(stagePlan({}, () => null), []);
  assert.throws(() => stagePlan({ upserted: ['../x'] }, () => null), /list of slugs/);
  assert.throws(() => stagePlan({ upserted: ['zz'] }, () => null), /no conference.json/);

  // The script itself, as ingest.yml runs it.
  const data = seedData(root);
  const report = path.join(root, 'report.json');
  writeFileSync(report, JSON.stringify({ upserted: [A, B], kept: [], pushed: [A], failed: [B], not_attempted: [] }));
  const out = path.join(root, 'staged');
  const outputFile = path.join(root, 'github-output');
  writeFileSync(outputFile, '');
  const fetched = path.join(root, 'ingest-report.json');
  writeFileSync(fetched, JSON.stringify({ processed: [A, B] }));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/stage-ingest-data.mjs'), '--report', report, '--fetched', fetched, '--out', out, '--data', data], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(outputFile, 'utf8'), 'staged=1\n');
  assert.deepEqual(readFileSync(path.join(out, A, 'talks.ndjson')), readFileSync(path.join(data, A, 'talks.ndjson')));
  assert.ok(!existsSync(path.join(out, B)));
}));
