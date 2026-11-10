// scripts/build-bundles.mjs: hermetic tests with a stub embedder and no network. The builder is run
// on the contract's fixture inputs and must reproduce the committed fixture bundle byte for byte;
// the rest covers the flags, speaker trimming, the capabilities document, the topics port and a
// whole run (write, check, tamper) on a temporary data directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, passageText, DIMS } from '../contracts/js/bundle.mjs';
import { denseVectors, GENERATED_AT, FIXTURES, BUNDLE_OUT } from '../contracts/js/fixtures.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import {
  parseArgs, UsageError, trimTalk, publicConference, buildConferenceBundle, buildIndex, serializeIndex, buildCapabilities, loadSearchable,
  run, checkOutput, readSmokeQueries, DEFAULT_BASE_URL, DEFAULT_OUT, ATTRIBUTION,
} from '../scripts/build-bundles.mjs';
import { buildTopics, readFixups } from '../scripts/lib/topics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = path.join(FIXTURES, 'bundle-inputs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SLUG = 'caddie-fixture-2099';

// An embedder that answers from a table of passage text -> row, like a model would from its weights.
function tableEmbedder(rowsByText) {
  return {
    embedDocuments: async (texts) => texts.map((t) => {
      const row = rowsByText.get(t);
      if (!row) throw new Error(`stub embedder: no row for ${JSON.stringify(t)}`);
      return row;
    }),
    embedQueries: async (texts) => texts.map(() => new Array(DIMS).fill(0)),
  };
}
// An embedder with a stable pseudo-random row per text, for runs on data without known vectors.
const hashEmbedder = {
  embedDocuments: async (texts) => texts.map((t) => {
    const h = crypto.createHash('sha256').update(t).digest();
    return Array.from({ length: DIMS }, (_, i) => (h[i % 32] - 127.5) / 128 + (i % 7) * 0.01);
  }),
  embedQueries: async (texts) => hashEmbedder.embedDocuments(texts),
};

function fixtureInputs() {
  const conferences = readJson(path.join(INPUTS, 'conferences.json'));
  const { publisher, ...attribution } = readJson(path.join(INPUTS, 'attribution.json'));
  const dir = path.join(INPUTS, SLUG);
  const talks = readJson(path.join(dir, 'talks.json'));
  const dense = denseVectors(path.join(dir, 'vectors.json'));
  const rowsByText = new Map(talks.filter((t) => dense.has(t.talk_id)).map((t) => [passageText(t), dense.get(t.talk_id)]));
  return { conferences, publisher, attribution: { ...attribution, takedown: publisher.takedown }, talks, topics: readJson(path.join(dir, 'topics.json')), rowsByText };
}

test('the builder reproduces the committed fixture bundle and index byte for byte', async () => {
  const f = fixtureInputs();
  const conference = f.conferences.find((c) => c.slug === SLUG);
  const built = await buildConferenceBundle({ conference, talks: f.talks, topics: f.topics, embedder: tableEmbedder(f.rowsByText), attribution: f.attribution });
  const index = readJson(path.join(BUNDLE_OUT, 'conferences.json'));
  const entry = index.conferences.find((c) => c.slug === SLUG).bundle;
  assert.equal(built.dir, entry.path);
  for (const name of Object.keys(entry.files)) {
    assert.deepEqual(built.files[name], readFileSync(path.join(BUNDLE_OUT, entry.path, name)), `${name} differs from the committed fixture`);
  }
  assert.deepEqual(built.entry, entry);
  assert.deepEqual(verifyBundle(built.entry, built.files), []);
  const rebuilt = buildIndex({ conferences: f.conferences, entries: new Map([[SLUG, built.entry]]), publisher: f.publisher, generatedAt: GENERATED_AT });
  assert.deepEqual(serializeIndex(rebuilt), readFileSync(path.join(BUNDLE_OUT, 'conferences.json')));
});

test('parseArgs: defaults, every flag, and refusals', () => {
  const d = parseArgs([]);
  assert.equal(d.out, DEFAULT_OUT);
  assert.equal(d.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual([d.only, d.offline, d.check, d.smoke], [null, false, false, false]);
  const o = parseArgs(['--out', 'x', '--only', 'a-1, b-2', '--base-url', 'https://e.org/b/', '--offline', '--check', '--smoke', '--takedown', 'mailto:t@e.org']);
  assert.deepEqual([o.out, o.only, o.baseUrl, o.offline, o.check, o.smoke, o.takedown], ['x', ['a-1', 'b-2'], 'https://e.org/b/', true, true, true, 'mailto:t@e.org']);
  for (const bad of [['--bogus'], ['--out'], ['--out', '--check'], ['--only', ' , '], ['--base-url', 'http://e.org/b/'], ['--base-url', 'https://e.org/b'], ['--takedown', 'ftp://x']]) {
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
  }
  assert.match(DEFAULT_BASE_URL, /^https:\/\/kurtlehnardt\.github\.io\/conferenceCaddie\/bundles\/$/);
});

test('trimTalk keeps names and taglines only: no profiles, links, bios or internal fields', () => {
  const raw = readJson(path.join(INPUTS, SLUG, 'talks.json')).find((t) => t.speaker_profiles?.length);
  const talk = trimTalk({ ...raw, bio: 'long bio', photo: 'https://e.org/p.jpg', content_hash: 'x', ingested_at: 't', tag_keys: ['k'] });
  assert.equal('speaker_profiles' in talk, false);
  for (const f of ['bio', 'photo', 'content_hash', 'ingested_at', 'tag_keys', 'session_id', 'conference']) assert.equal(f in talk, false, f);
  assert.deepEqual(talk.speakers, raw.speakers);
  assert.deepEqual(talk.speaker_taglines, raw.speaker_taglines, 'a null tagline stays null');
  assert.ok(talk.speaker_taglines.includes(null));
  assert.doesNotMatch(JSON.stringify(talk), /https:\/\/example\.org\/ada/);
  assert.deepEqual(talk.topics, []);
});

test('speaker links of the committed data never reach a built bundle', async () => {
  const [conf] = loadSearchable(path.join(ROOT, 'data'), ['mcp-dev-summit-nairobi-2026']);
  assert.ok(conf.talks.some((t) => t.speaker_profiles?.some((p) => p.links?.length)), 'the input has speaker links');
  const stop = readFileSync(path.join(ROOT, 'config/topic-stoplist.txt'), 'utf8');
  const built = await buildConferenceBundle({ conference: conf.conference, talks: conf.talks, embedder: hashEmbedder, attribution: { ...ATTRIBUTION, takedown: 'https://e.org/t' }, stoplistText: stop });
  const text = built.files['bundle.json'].toString('utf8');
  assert.ok(!text.includes('speaker_profiles'));
  const links = conf.talks.flatMap((t) => (t.speaker_profiles ?? []).flatMap((p) => (p.links ?? []).map((l) => l.url)));
  assert.ok(links.length > 0);
  assert.deepEqual(links.filter((url) => text.includes(url)), [], 'no speaker link URL appears in the bundle');
  assert.deepEqual(verifyBundle(built.entry, built.files), []);
});

test('capabilities.json is the tier 1 demo document and valid in closed mode', () => {
  const caps = buildCapabilities(DEFAULT_BASE_URL);
  const r = validator('capabilities.v1')(caps, { closed: true });
  assert.ok(r.valid, JSON.stringify(r.errors));
  const fixture = readJson(path.join(FIXTURES, 'capabilities/tier1-demo.json'));
  assert.deepEqual({ ...caps, talks: { ...caps.talks, bundle_base: fixture.talks.bundle_base } }, fixture);
  assert.equal(caps.people.enabled, false);
  assert.equal(caps.talks.bundle_base, 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/');
});

test('the topics port gives the live lists of the four searchable conferences', () => {
  for (const slug of ['kubecon-cloudnativecon-north-america-2026', 'mcp-dev-summit-nairobi-2026', 'pytorch-day-japan-2026', 'grpconf-india-2026']) {
    const [c] = loadSearchable(path.join(ROOT, 'data'), [slug]);
    const talks = c.talks.filter((t) => t.kind === 'talk');
    const { topics } = buildTopics({ talks, stoplistText: readFileSync(path.join(ROOT, 'config/topic-stoplist.txt'), 'utf8'), fixups: readFixups(path.join(ROOT, 'data/topics', `${slug}.json`)) });
    const live = readJson(path.join(FIXTURES, 'topics-live', `${slug}.json`)).topics;
    assert.deepEqual(topics.map((t) => [t.topic_id, t.label, t.talk_count]), live.map((t) => [t.topic_id, t.label, t.talk_count]), slug);
  }
});

test('publicConference has the fields of GET /api/conferences and nothing internal', () => {
  const doc = readJson(path.join(ROOT, 'data/pytorch-day-japan-2026/conference.json'));
  const pub = publicConference(doc);
  assert.deepEqual(Object.keys(pub), ['slug', 'name', 'start_date', 'end_date', 'time_zone', 'location', 'status', 'official_schedule_url', 'source', 'has_level', 'track_group', 'tag_groups', 'talk_count']);
  assert.equal(pub.has_level, false);
});

test('readSmokeQueries reads the five a-check queries of scripts/smoke.mjs', () => {
  const q = readSmokeQueries();
  assert.equal(q.length, 5);
  assert.ok(q.every((x) => x.query && x.title));
});

// A data directory in the layout of scripts/ingest.mjs, made from the fixture inputs.
function fixtureDataDir(root) {
  const f = fixtureInputs();
  const dataDir = path.join(root, 'data');
  for (const c of f.conferences) {
    mkdirSync(path.join(dataDir, c.slug), { recursive: true });
    const { has_level, track_group, tag_groups, talk_count, ...rest } = c;
    writeFileSync(path.join(dataDir, c.slug, 'conference.json'), JSON.stringify({ ...rest, category_mapping: has_level ? { level_group: 'L', track_group, tag_groups } : null, counts: { talk: talk_count } }));
    if (c.slug === SLUG) writeFileSync(path.join(dataDir, c.slug, 'talks.ndjson'), `${f.talks.map((t) => JSON.stringify(t)).join('\n')}\n`);
  }
  return dataDir;
}

test('a whole run: files, validation, --check, tampering and --only', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'caddie-bundles-'));
  try {
    const dataDir = fixtureDataDir(root);
    const out = path.join(root, 'dist-pages');
    const opts = { ...parseArgs(['--out', out]) };
    const lines = [];
    const deps = { embedder: hashEmbedder, dataDir, log: (m) => lines.push(m), now: () => new Date('2026-11-10T12:00:00.123Z') };
    const res = await run(opts, deps);
    assert.ok(res.ok);
    assert.equal(res.bundles.length, 1, 'only the searchable conference is built');

    const index = readJson(path.join(out, 'bundles/conferences.json'));
    assert.equal(index.generated_at, '2026-11-10T12:00:00Z');
    assert.deepEqual(readFileSync(path.join(out, 'conferences.json')), readFileSync(path.join(out, 'bundles/conferences.json')));
    assert.equal(index.conferences.length, 1);
    assert.deepEqual(index.publisher, { name: opts.publisherName, takedown: opts.takedown });
    assert.ok(validator('conferences-index.v1')(index, { closed: true }).valid);
    const entry = index.conferences[0].bundle;
    assert.deepEqual(Object.keys(entry.files).sort(), ['bundle.json', 'vectors.i8']);
    const dir = path.join(out, 'bundles', entry.path);
    assert.deepEqual(readdirSync(dir).sort(), ['bundle.json', 'vectors.i8']);
    const files = Object.fromEntries(Object.keys(entry.files).map((n) => [n, readFileSync(path.join(dir, n))]));
    assert.deepEqual(verifyBundle(entry, files), []);
    const bundle = JSON.parse(files['bundle.json'].toString('utf8'));
    assert.ok(validator('talk-bundle.v1')(bundle, { closed: true }).valid);
    assert.equal(bundle.attribution.license, 'CC BY 3.0');
    assert.equal(bundle.attribution.takedown, index.publisher.takedown);
    assert.ok(validator('capabilities.v1')(readJson(path.join(out, 'capabilities.json')), { closed: true }).valid);

    // Building again from the same inputs is byte-identical, even at another time.
    const again = await run({ ...opts, check: true }, { ...deps, now: () => new Date('2027-01-01T00:00:00Z') });
    assert.ok(again.ok, lines.join('\n'));

    // A changed byte, a missing file and a different base URL are all differences.
    writeFileSync(path.join(dir, 'vectors.i8'), Buffer.alloc(files['vectors.i8'].length));
    assert.match(checkOutput(out, res.files).join('\n'), /vectors\.i8: differs/);
    writeFileSync(path.join(dir, 'vectors.i8'), files['vectors.i8']);
    rmSync(path.join(out, 'capabilities.json'));
    assert.match(checkOutput(out, res.files).join('\n'), /capabilities\.json: missing/);

    await assert.rejects(run({ ...opts, only: ['nope'] }, deps), UsageError);
    assert.ok(!existsSync(path.join(out, 'bundles', 'nope')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
