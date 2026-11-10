// scripts/build-bundles.mjs: hermetic tests with a stub embedder, no network and no model. The
// builder is run on the contract's fixture inputs and must reproduce the committed fixture bundle
// byte for byte; the rest covers the flags and exit codes, speaker trimming on the real data, email
// redaction, takedowns, vector reuse, the topics port, the embedder's pinned constants and a whole
// run (write, check, tamper) on a temporary data directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, passageText, bundleTalk, DIMS, MODEL, QUERY_INSTRUCTION } from '../contracts/js/bundle.mjs';
import { denseVectors, GENERATED_AT, FIXTURES, BUNDLE_OUT } from '../contracts/js/fixtures.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import {
  parseArgs, effectiveReuseFrom, UsageError, trimTalk, alignedTaglines, shortTagline, redactEmails, publicConference, buildConferenceBundle, buildIndex, serializeIndex,
  buildCapabilities, loadSearchable, loadTakedowns, applyTakedowns, loadReusableRows, run, checkOutput, readSmokeQueries, DEFAULT_BASE_URL, DEFAULT_OUT, ATTRIBUTION, TAGLINE_MAX,
} from '../scripts/build-bundles.mjs';
import { buildTopics, readFixups, analyse, topicIdOf, TOPIC_ID } from '../scripts/lib/topics.mjs';
import {
  MODEL_FILES, ONNX_REVISION, ONNX_ID, MODEL_ID, modelUrl, ensureModelFiles, embeddingIdentity, DIMS as EMBEDDER_DIMS, QUERY_INSTRUCTION as EMBEDDER_INSTRUCTION, defaultCacheDir, REPO_ROOT,
} from '../scripts/lib/embedder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const INPUTS = path.join(FIXTURES, 'bundle-inputs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SLUG = 'caddie-fixture-2099';
const STOP = readFileSync(path.join(ROOT, 'config/topic-stoplist.txt'), 'utf8');
const SEARCHABLE = ['kubecon-cloudnativecon-north-america-2026', 'mcp-dev-summit-nairobi-2026', 'pytorch-day-japan-2026', 'grpconf-india-2026'];

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
// An embedder with a stable pseudo-random row per text, counting what it is asked to embed.
function hashEmbedder(identity = { stub: 1 }) {
  const e = {
    identity,
    calls: 0,
    texts: 0,
    embedDocuments: async (texts) => {
      e.calls++;
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
  assert.deepEqual(verifyBundle(built.entry, built.files, { producer: true }), []);
  assert.deepEqual(built.stats, { reused: 0, embedded: 3 });
  const rebuilt = buildIndex({ conferences: f.conferences, entries: new Map([[SLUG, built.entry]]), publisher: f.publisher, generatedAt: GENERATED_AT });
  assert.deepEqual(serializeIndex(rebuilt), readFileSync(path.join(BUNDLE_OUT, 'conferences.json')));
});

test('parseArgs: defaults, every flag, and refusals', () => {
  const d = parseArgs([]);
  assert.equal(d.out, DEFAULT_OUT);
  assert.equal(d.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual([d.only, d.offline, d.check, d.smoke, d.reuseFrom], [null, false, false, false, undefined]);
  const o = parseArgs(['--out', 'x', '--only', 'a-1, b-2', '--base-url', 'https://e.org/b/', '--offline', '--check', '--smoke', '--takedown', 'mailto:t@e.org', '--reuse-from', 'none']);
  assert.deepEqual([o.out, o.only, o.baseUrl, o.offline, o.check, o.smoke, o.takedown, o.reuseFrom], ['x', ['a-1', 'b-2'], 'https://e.org/b/', true, true, true, 'mailto:t@e.org', 'none']);
  for (const bad of [
    ['--bogus'], ['--out'], ['--out', '--check'], ['--out', ' '], ['--publisher-name', ''], ['--only', ' , '], ['--base-url', 'http://e.org/b/'], ['--base-url', 'https://e.org/b'],
    ['--takedown', 'ftp://x'], ['--reuse-from', 'http://e.org/'], ['--reuse-from', 'https://e.org/noslash'],
  ]) {
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
  }
  assert.equal(DEFAULT_BASE_URL, 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/');
});

test('reuse source: the published demo by default, off for --check and for "none", explicit wins', () => {
  assert.equal(effectiveReuseFrom(parseArgs([])), DEFAULT_BASE_URL);
  assert.equal(effectiveReuseFrom(parseArgs(['--check'])), null);
  assert.equal(effectiveReuseFrom(parseArgs(['--reuse-from', 'none'])), null);
  assert.equal(effectiveReuseFrom(parseArgs(['--check', '--reuse-from', 'dist-pages'])), 'dist-pages');
});

test('the CLI exits 2 on bad arguments and on an unknown conference, before any model is touched', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-bundles.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 });
  for (const args of [['--bogus'], ['--out', ''], ['--base-url', 'http://x/'], ['--only', 'no-such-conference'], ['--publisher-name', ' ']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.length > 0);
  }
});

test('speaker taglines are aligned with speakers, shortened, and never guessed', () => {
  // The feed leaves empty taglines out of speaker_taglines, so only the profiles are index-aligned.
  const raw = { talk_id: 'x:1', speakers: ['A', 'B'], speaker_taglines: ['Engineer, Org'], speaker_profiles: [{ name: 'A' }, { name: 'B', tagline: 'Engineer, Org' }] };
  assert.deepEqual(alignedTaglines(raw), [null, 'Engineer, Org']);
  // Neither source lines up with the speakers: all null, not a guess.
  assert.deepEqual(alignedTaglines({ speakers: ['A', 'B', 'C'], speaker_taglines: ['x'], speaker_profiles: [] }), [null, null, null]);
  assert.deepEqual(alignedTaglines({ speakers: [], speaker_taglines: [] }), []);
  // Same length means nothing was left out.
  assert.deepEqual(alignedTaglines({ speakers: ['A', 'B'], speaker_taglines: ['x', 'y'] }), ['x', 'y']);

  assert.equal(shortTagline('Maintainer, Org | https://example.org | more'), 'Maintainer, Org');
  assert.equal(shortTagline('  '), null);
  assert.equal(shortTagline(null), null);
  const long = shortTagline(`${'word '.repeat(60)}end`);
  assert.ok([...long].length <= TAGLINE_MAX && long.endsWith('…'));
  assert.equal(shortTagline('x'.repeat(TAGLINE_MAX)), 'x'.repeat(TAGLINE_MAX));
});

test('trimTalk and the contract builder keep names and taglines only: no profiles, links, bios or internal fields', () => {
  const raw = readJson(path.join(INPUTS, SLUG, 'talks.json')).find((t) => t.speaker_profiles?.length);
  const talk = bundleTalk(trimTalk({ ...raw, bio: 'long bio', content_hash: 'x', ingested_at: 't', tag_keys: ['k'] }));
  assert.equal('speaker_profiles' in talk, false);
  for (const f of ['bio', 'content_hash', 'ingested_at', 'tag_keys', 'session_id', 'conference']) assert.equal(f in talk, false, f);
  assert.deepEqual(talk.speakers, raw.speakers);
  assert.equal(talk.speaker_taglines.length, talk.speakers.length);
  assert.ok(talk.speaker_taglines.includes(null));
  assert.doesNotMatch(JSON.stringify(talk), /https:\/\/example\.org\/ada/);
});

test('redactEmails replaces every address and nothing else', () => {
  assert.equal(redactEmails('Mail jane.doe+x@example.co.uk or bob@e.org today. Not @handle or a@b.'), 'Mail [email removed] or [email removed] today. Not @handle or a@b.');
  assert.equal(redactEmails(null), '');
});

test('on the real data every bundle talk has one tagline per speaker, links never appear, emails and long taglines are gone', async () => {
  let checked = 0;
  for (const slug of SEARCHABLE) {
    const [c] = loadSearchable(DATA, [slug]);
    const published = c.talks.map((t) => bundleTalk(trimTalk(t)));
    for (const t of published) {
      assert.equal(t.speaker_taglines.length, t.speakers.length, t.talk_id);
      assert.ok(t.speaker_taglines.every((x) => x === null || ([...x].length <= TAGLINE_MAX && !x.includes(' | '))), t.talk_id);
      assert.doesNotMatch(t.abstract, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/, `${t.talk_id} still has an email address`);
      checked++;
    }
    const links = c.talks.flatMap((t) => (t.speaker_profiles ?? []).flatMap((p) => (p.links ?? []).map((l) => l.url)));
    const text = JSON.stringify(published);
    assert.deepEqual(links.filter((u) => text.includes(u)), [], `${slug}: a speaker link reached the bundle`);
    assert.ok(!text.includes('speaker_profiles'));
  }
  assert.ok(checked > 500);
  const kube = loadSearchable(DATA, ['kubecon-cloudnativecon-north-america-2026'])[0].talks;
  const t = bundleTalk(trimTalk(kube.find((x) => x.talk_id.endsWith(':1289969'))));
  assert.deepEqual(t.speakers, ['Jorge Castro', 'Katherine Druckman']);
  assert.deepEqual(t.speaker_taglines, [null, 'Open Source Evangelist, Intel']);
});

test('a built bundle from the real data verifies, validates and carries the attribution', async () => {
  const [c] = loadSearchable(DATA, ['pytorch-day-japan-2026']);
  const built = await buildConferenceBundle({ conference: c.conference, talks: c.talks, embedder: hashEmbedder(), attribution: { ...ATTRIBUTION, takedown: 'https://e.org/t' }, stoplistText: STOP });
  assert.deepEqual(verifyBundle(built.entry, built.files, { producer: true }), []);
  const bundle = JSON.parse(built.files['bundle.json'].toString('utf8'));
  assert.ok(validator('talk-bundle.v1')(bundle, { closed: true }).valid);
  assert.equal(bundle.attribution.license, 'CC BY 3.0');
  assert.match(bundle.attribution.licensor, /Linux Foundation/);
  assert.match(bundle.attribution.licensor, /copyright the speakers and organizers/);
  assert.equal(bundle.model.id, MODEL.id);
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
  for (const slug of SEARCHABLE) {
    const [c] = loadSearchable(DATA, [slug]);
    const talks = c.talks.filter((t) => t.kind === 'talk');
    const { topics } = buildTopics({ talks, stoplistText: STOP, fixups: readFixups(path.join(DATA, 'topics', `${slug}.json`)) });
    const live = readJson(path.join(FIXTURES, 'topics-live', `${slug}.json`)).topics;
    assert.deepEqual(topics.map((t) => [t.topic_id, t.label, t.talk_count]), live.map((t) => [t.topic_id, t.label, t.talk_count]), slug);
    assert.ok(topics.every((t) => TOPIC_ID.test(t.topic_id)), `${slug}: topic id pattern`);
  }
});

test('topics: merges become aliases, every talk gets its own topics in rank order, ids are valid, contractions are stopped', () => {
  const titles = [
    'Scaling Agents in production', 'Agents on Kubernetes', 'Secure Agents today', 'Agentic workflows for ops', 'Agentic ops basics', 'Why we can\'t trust output', 'Security of the supply chain',
    'Supply chain basics', 'Hardening the supply chain', 'Naïve café routing', 'Café routing at scale', 'Routing for the café crowd',
    'Node.js internals', 'Debugging Node.js', 'Node.js at scale', 'コンパイラ入門', 'コンパイラ最適化', 'コンパイラ設計',
  ];
  const talks = titles.map((title, i) => ({ talk_id: `s:${i}`, title }));
  const log = [];
  const { topics, talkTopics, dropped } = buildTopics({
    talks, stoplistText: STOP, fixups: { merge: { agentic: 'agents' }, rename: { agents: 'Agents (all)' } }, log: (m) => log.push(m),
  });
  const byId = new Map(topics.map((t) => [t.topic_id, t]));
  assert.ok(byId.has('agents'), JSON.stringify(topics.map((t) => t.topic_id)));
  assert.equal(byId.get('agents').label, 'Agents (all)');
  assert.deepEqual(byId.get('agents').aliases, ['agentic']);
  assert.ok(!byId.has('agentic'));
  assert.equal(byId.get('agents').talk_count, 5, 'a talk with an alias term counts for the topic');
  assert.ok(talkTopics.get('s:3').includes('agents'), 'a talk with only the alias term holds the canonical topic');
  assert.ok(byId.has('supply-chain'));
  assert.ok(byId.has('node-js'), 'dots are slugified');
  assert.ok(byId.has('cafe'), 'accents are stripped for the id and kept in the label');
  assert.equal(byId.get('cafe').label.toLowerCase().includes('café'), true);
  assert.ok(topics.every((t) => TOPIC_ID.test(t.topic_id)));
  assert.ok(!topics.some((t) => /can't|cant/.test(t.topic_id)), 'contractions are in the stoplist');
  assert.ok(dropped.includes('コンパイラ'), 'a katakana-only term has no valid id and is dropped');
  assert.ok(log.some((m) => m.includes('コンパイラ')), 'the drop is logged');
  for (const [id, list] of talkTopics) assert.deepEqual(list, topics.filter((t) => list.includes(t.topic_id)).map((t) => t.topic_id), `${id} is in rank order`);
  assert.equal(topicIdOf('a b'), 'a-b');
  assert.equal(topicIdOf('コンパイラ'), null);
  assert.equal(topicIdOf('x'.repeat(101)), null);
});

test('the topic analyser splits Han and Hiragana per character, keeps a katakana run whole and ends a token at a script change', () => {
  const stop = new Set();
  const terms = (title) => analyse(title, stop).map((t) => t.term);
  assert.deepEqual(terms('PyTorch入門'), ['pytorch']);
  assert.deepEqual(terms('Kubernetesコンパイラ'), ['kubernetes', 'コンパイラ', 'kubernetes コンパイラ']);
  assert.deepEqual(terms('機械学習'), [], 'single Han characters are shorter than two characters and dropped, as in the Elasticsearch analyzer');
  assert.deepEqual(terms('cloud 機 native'), ['cloud', 'native'], 'a dropped character leaves a gap, so no bigram spans it');
  assert.deepEqual(terms('スケジューラー と モデル'), ['スケジューラー', 'モデル'], 'a hiragana particle between katakana words is a token of its own, so no bigram spans it');
});

test('the embedder pins its model: constants equal the contract, revision-only URLs, SHA-256 for every file', async () => {
  assert.equal(MODEL_ID, MODEL.id);
  assert.equal(ONNX_ID, MODEL.onnx);
  assert.equal(EMBEDDER_DIMS, MODEL.dims);
  assert.equal(EMBEDDER_INSTRUCTION, MODEL.query_instruction);
  assert.equal(QUERY_INSTRUCTION, MODEL.query_instruction);
  assert.deepEqual([MODEL.pooling, MODEL.normalize, MODEL.max_tokens, MODEL.truncation, MODEL.document_instruction], ['cls', true, 512, 'end', '']);
  assert.match(ONNX_REVISION, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(MODEL_FILES).sort(), ['config.json', 'onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json']);
  for (const [name, meta] of Object.entries(MODEL_FILES)) {
    assert.match(meta.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(meta.bytes > 0);
    assert.equal(modelUrl(name), `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${ONNX_REVISION}/${name}`);
    assert.ok(!modelUrl(name).includes('/main/'));
  }
  const id = embeddingIdentity();
  assert.equal(id.revision, ONNX_REVISION);
  assert.deepEqual(Object.keys(id.files).sort(), Object.keys(MODEL_FILES).sort());
  // Offline with nothing cached: fails closed, touching no network.
  const dir = mkdtempSync(path.join(tmpdir(), 'caddie-model-'));
  try {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('the network must not be used'); };
    try {
      await assert.rejects(ensureModelFiles(dir, { offline: true }), /--offline: .* is not in the model directory/);
      // A present file with the wrong bytes is deleted and refused, offline or not.
      writeFileSync(path.join(dir, 'config.json'), 'tampered');
      await assert.rejects(ensureModelFiles(dir, { offline: true }), /not in the model directory/);
      assert.ok(!existsSync(path.join(dir, 'config.json')), 'the bad file was removed');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(defaultCacheDir().startsWith(REPO_ROOT));
});

test('publicConference has the fields of GET /api/conferences and nothing internal', () => {
  const pub = publicConference(readJson(path.join(DATA, 'pytorch-day-japan-2026/conference.json')));
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
const readBundleOf = (out) => {
  const index = readJson(path.join(out, 'bundles/conferences.json'));
  const entry = index.conferences[0].bundle;
  const dir = path.join(out, 'bundles', entry.path);
  const files = Object.fromEntries(Object.keys(entry.files).map((n) => [n, readFileSync(path.join(dir, n))]));
  return { index, entry, dir, files, bundle: JSON.parse(files['bundle.json'].toString('utf8')) };
};
const withTemp = async (fn) => {
  const root = mkdtempSync(path.join(tmpdir(), 'caddie-bundles-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('a whole run: files, validation, --check, tampering and --only', async () => withTemp(async (root) => {
  const dataDir = fixtureDataDir(root);
  const out = path.join(root, 'dist-pages');
  const opts = { ...parseArgs(['--out', out, '--reuse-from', 'none']) };
  const lines = [];
  const embedder = hashEmbedder();
  const deps = { embedder, dataDir, log: (m) => lines.push(m), now: () => new Date('2026-11-10T12:00:00.123Z') };
  const res = await run(opts, deps);
  assert.ok(res.ok);
  assert.equal(res.bundles.length, 1, 'only the searchable conference is built');

  const { index, entry, dir, files, bundle } = readBundleOf(out);
  assert.equal(index.generated_at, '2026-11-10T12:00:00Z');
  assert.deepEqual(readFileSync(path.join(out, 'conferences.json')), readFileSync(path.join(out, 'bundles/conferences.json')));
  assert.equal(index.conferences.length, 1);
  assert.deepEqual(index.publisher, { name: opts.publisherName, takedown: opts.takedown });
  assert.ok(validator('conferences-index.v1')(index, { closed: true }).valid);
  assert.deepEqual(Object.keys(entry.files).sort(), ['bundle.json', 'vectors.i8']);
  assert.deepEqual(readdirSync(dir).sort(), ['bundle.json', 'vectors.i8']);
  assert.deepEqual(verifyBundle(entry, files, { producer: true }), []);
  assert.ok(validator('talk-bundle.v1')(bundle, { closed: true }).valid);
  assert.equal(bundle.attribution.takedown, index.publisher.takedown);
  assert.ok(validator('capabilities.v1')(readJson(path.join(out, 'capabilities.json')), { closed: true }).valid);
  assert.deepEqual(readJson(path.join(out, 'bundles/build-info.json')), { build_info_version: 1, embedding: embedder.identity });

  const again = await run({ ...opts, check: true }, { ...deps, now: () => new Date('2027-01-01T00:00:00Z') });
  assert.ok(again.ok, lines.join('\n'));
  // --only checks only the conferences rebuilt: the same output passes for the subset.
  const subset = await run({ ...opts, check: true, only: [SLUG] }, deps);
  assert.ok(subset.ok);

  writeFileSync(path.join(dir, 'vectors.i8'), Buffer.alloc(files['vectors.i8'].length));
  assert.match(checkOutput(out, res.files).join('\n'), /vectors\.i8: differs/);
  writeFileSync(path.join(dir, 'vectors.i8'), files['vectors.i8']);
  rmSync(path.join(out, 'capabilities.json'));
  assert.match(checkOutput(out, res.files).join('\n'), /capabilities\.json: missing/);

  await assert.rejects(run({ ...opts, only: ['nope'] }, deps), UsageError);
}));

test('--check --only compares only the subset of conferences.json', async () => withTemp(async (root) => {
  const dataDir = fixtureDataDir(root);
  // A second searchable conference, a copy of the fixture under another slug.
  cpSync(path.join(dataDir, SLUG), path.join(dataDir, 'caddie-two-2099'), { recursive: true });
  const confFile = path.join(dataDir, 'caddie-two-2099/conference.json');
  writeFileSync(confFile, JSON.stringify({ ...readJson(confFile), slug: 'caddie-two-2099', name: 'Two' }));
  writeFileSync(path.join(dataDir, 'caddie-two-2099/talks.ndjson'), readFileSync(path.join(dataDir, SLUG, 'talks.ndjson'), 'utf8').replaceAll(`${SLUG}:`, 'caddie-two-2099:'));
  const out = path.join(root, 'out');
  const deps = { embedder: hashEmbedder(), dataDir, log: () => {}, now: () => new Date('2026-11-10T00:00:00Z') };
  const base = parseArgs(['--out', out, '--reuse-from', 'none']);
  assert.ok((await run(base, deps)).ok);
  assert.ok((await run({ ...base, check: true, only: ['caddie-two-2099'] }, deps)).ok, 'a subset check of a full output passes');
  assert.ok((await run({ ...base, check: true }, deps)).ok);
}));

test('takedowns drop a talk or a speaker, adjust the talk count, and are validated', async () => withTemp(async (root) => {
  const dataDir = fixtureDataDir(root);
  const talks = readJson(path.join(INPUTS, SLUG, 'talks.json'));
  const speakerTalk = talks.find((t) => t.speakers.length > 1);
  const dropTalk = talks.find((t) => t.kind === 'talk' && t !== speakerTalk);
  const [gone] = [speakerTalk.speakers[0]];
  writeFileSync(path.join(dataDir, 'takedowns.json'), JSON.stringify([
    { slug: SLUG, talk_id: dropTalk.talk_id, reason: 'speaker request', date: '2026-11-10' },
    { slug: SLUG, speaker: gone, reason: 'speaker request', date: '2026-11-10' },
    { slug: 'another-conference-2099', talk_id: 'another-conference-2099:1', reason: 'unrelated', date: '2026-11-10' },
  ]));
  const out = path.join(root, 'out');
  const res = await run(parseArgs(['--out', out, '--reuse-from', 'none']), { embedder: hashEmbedder(), dataDir, log: () => {}, now: () => new Date('2026-11-10T00:00:00Z') });
  assert.ok(res.ok);
  const { index, bundle, entry, files } = readBundleOf(out);
  assert.ok(!bundle.talks.some((t) => t.talk_id === dropTalk.talk_id), 'the talk is gone');
  assert.ok(!bundle.vectors.rows.includes(dropTalk.talk_id));
  assert.ok(!JSON.stringify(bundle).includes(gone), 'the speaker name is gone everywhere');
  const t = bundle.talks.find((x) => x.talk_id === speakerTalk.talk_id);
  assert.equal(t.speakers.length, speakerTalk.speakers.length - 1);
  assert.equal(t.speaker_taglines.length, t.speakers.length);
  assert.equal(index.conferences[0].talk_count, entry.talk_count);
  assert.equal(entry.talk_count, talks.filter((x) => x.kind === 'talk').length - 1);
  assert.deepEqual(verifyBundle(entry, files, { producer: true }), []);

  // The unit: entries that match nothing are reported, and bad entries are refused.
  const { notes } = applyTakedowns(SLUG, talks, [{ slug: SLUG, speaker: 'Nobody Here', reason: 'r', date: '2026-01-01' }]);
  assert.equal(notes.length, 1);
  const bad = path.join(root, 'bad.json');
  for (const doc of ['{}', '[{"slug":"a","reason":"r","date":"2026-01-01"}]', '[{"slug":"a","talk_id":"b:1","reason":"r","date":"2026-01-01"}]', '[{"slug":"a","speaker":"x","reason":"r","date":"yesterday"}]', 'nope']) {
    writeFileSync(bad, doc);
    assert.throws(() => loadTakedowns(bad), doc);
  }
  assert.deepEqual(loadTakedowns(path.join(root, 'missing.json')), []);
}));

test('vector reuse: unchanged texts are not embedded again, and a changed identity, a bad bundle or a failed fetch embeds everything', async () => withTemp(async (root) => {
  const dataDir = fixtureDataDir(root);
  const out1 = path.join(root, 'out1');
  const out2 = path.join(root, 'out2');
  const lines = [];
  const deps = (embedder) => ({ embedder, dataDir, log: (m) => lines.push(m), now: () => new Date('2026-11-10T00:00:00Z') });
  const first = hashEmbedder();
  const r1 = await run(parseArgs(['--out', out1, '--reuse-from', 'none']), deps(first));
  assert.equal(r1.reused, 0);
  const embeddedFirst = first.texts;
  assert.ok(embeddedFirst > 0);

  // Second run, reusing the first output (a site root holding bundles/): nothing is embedded, bytes are identical.
  const second = hashEmbedder();
  const r2 = await run(parseArgs(['--out', out2, '--reuse-from', out1]), deps(second));
  assert.equal(second.texts, 0, lines.join('\n'));
  assert.equal(r2.reused, embeddedFirst);
  assert.deepEqual(readBundleOf(out2).files, readBundleOf(out1).files);

  // A different embedding identity: no reuse.
  const other = hashEmbedder({ stub: 2 });
  await run(parseArgs(['--out', path.join(root, 'out3'), '--reuse-from', out1]), deps(other));
  assert.equal(other.texts, embeddedFirst);
  assert.ok(lines.some((m) => /different embedding identity/.test(m)));

  // A reuse source whose bundle was tampered with is skipped.
  const bad = readBundleOf(out1);
  writeFileSync(path.join(bad.dir, 'vectors.i8'), Buffer.alloc(bad.files['vectors.i8'].length, 1));
  const afterBad = hashEmbedder();
  await run(parseArgs(['--out', path.join(root, 'out4'), '--reuse-from', out1]), deps(afterBad));
  assert.equal(afterBad.texts, embeddedFirst);
  assert.ok(lines.some((m) => /does not verify/.test(m)));

  // A network failure embeds everything and is logged, not fatal.
  const failing = hashEmbedder();
  const r5 = await run(parseArgs(['--out', path.join(root, 'out5')]), { ...deps(failing), fetchFn: async () => { throw new Error('offline'); } });
  assert.ok(r5.ok);
  assert.equal(failing.texts, embeddedFirst);
  assert.ok(lines.some((m) => /could not read https:\/\/kurtlehnardt\.github\.io/.test(m)));

  // --offline never fetches a URL source.
  const rows = await loadReusableRows({ source: DEFAULT_BASE_URL, identity: { stub: 1 }, offline: true, fetchFn: () => { throw new Error('no network'); }, log: () => {} });
  assert.equal(rows.rows.size, 0);
}));
