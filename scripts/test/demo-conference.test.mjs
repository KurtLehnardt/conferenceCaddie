// The demo conference (config/demo-conference.json, scripts/lib/demo-conference.mjs,
// scripts/demo-conference.mjs and its path through scripts/ingest.mjs and scripts/build-bundles.mjs):
// - the generator is a pure function of the configuration and the day: the same inputs give the same
//   bytes, the window is yesterday, today and tomorrow, a talk is running at every minute from 07:00
//   to 23:00 in the conference's zone (also on DST change days), and the talk ids and texts are the
//   same whatever the day or zone, so a daily regeneration moves times and deletes nothing;
// - its documents satisfy the contracts: the bundle built from them verifies and validates in closed
//   mode, the index entry carries demo: true and the demo attribution;
// - it is off by default, refused by the ingest while off, never part of --all-upcoming, and the
//   operator file applies to it;
// - prepare regenerates it for the bundle build or removes it, and the build then publishes or drops
//   it; status tells a workflow when the live bundles are stale.
// Hermetic: temporary directories, a stub embedder, no key and no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDemo, validateDemoConfig, readDemoConfig, todayIn, addDays, demoDays, demoToday, isCivilDay, inventedNote, DEFAULT_DEMO_CONFIG, DEMO_CONFIG_FILE,
} from '../lib/demo-conference.mjs';
import { makeLocalTime } from '../lib/zones.mjs';
import { deriveEvents } from '../lib/lf.mjs';
import { textHash, contentHash } from '../lib/hash.mjs';
import { validator } from '../../contracts/js/schemas.mjs';
import { formatErrors } from '../../contracts/js/validate.mjs';
import { DIMS, BUNDLE_FILE } from '../../contracts/js/bundle.mjs';
import {
  buildConferenceBundle, validateBuilt, publicConference, buildIndex, parseArgs as bundleArgs, run as buildBundles, DEMO_ATTRIBUTION, ATTRIBUTION,
} from '../build-bundles.mjs';
import { status, prepare, esCheck, liveEntry, outputLines, parseArgs as demoArgs } from '../demo-conference.mjs';
import { planBuild } from '../lib/bundle-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ON = { ...DEFAULT_DEMO_CONFIG, enabled: true };
const SLUG = DEFAULT_DEMO_CONFIG.slug;
const DAY = '2026-11-12';
const STOP = readFileSync(path.join(ROOT, 'config/topic-stoplist.txt'), 'utf8');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// A stable pseudo-random row per text, like the bundle tests' stub.
function hashEmbedder() {
  return {
    identity: { stub: 1 },
    embedDocuments: async (texts) => texts.map((t) => {
      const h = crypto.createHash('sha256').update(t).digest();
      return Array.from({ length: DIMS }, (_, i) => (h[i % 32] - 127.5) / 128 + (i % 7) * 0.01);
    }),
    embedQueries: async (texts) => texts.map(() => Array.from({ length: DIMS }, () => 0.1)),
  };
}

const withTemp = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'caddie-demo-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// The instant of a local wall-clock time in the zone.
const instant = (zone, day, minutes) => Date.parse(makeLocalTime(zone)(`${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`).iso);

describe('the generator', () => {
  test('is a pure function of the configuration and the day: same inputs, same bytes', () => {
    const a = buildDemo(ON, DAY);
    const b = buildDemo(structuredClone(ON), DAY);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.notEqual(JSON.stringify(buildDemo(ON, '2026-11-13')), JSON.stringify(a), 'another day gives other times');
    assert.notEqual(JSON.stringify(buildDemo({ ...ON, time_zone: 'Europe/Berlin' }, DAY)), JSON.stringify(a), 'another zone gives other instants');
  });

  test('the window is yesterday, today and tomorrow, also across a month, a year and a leap day', () => {
    for (const [day, start, end] of [[DAY, '2026-11-11', '2026-11-13'], ['2026-12-31', '2026-12-30', '2027-01-01'], ['2028-03-01', '2028-02-29', '2028-03-02'], ['2027-01-01', '2026-12-31', '2027-01-02']]) {
      const { conference, docs } = buildDemo(ON, day);
      assert.equal(conference.start_date, start, day);
      assert.equal(conference.end_date, end, day);
      assert.deepEqual([...new Set(docs.map((d) => d.day))].sort(), demoDays(day), day);
      assert.ok(docs.filter((d) => d.day === day && d.kind === 'talk').length >= 30, `${day}: today holds a full programme`);
    }
    assert.deepEqual(demoDays(DAY), ['2026-11-11', DAY, '2026-11-13']);
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  test('a talk is running at every minute from 07:00 to 23:00 in the zone, on ordinary and DST change days', () => {
    const cases = [
      ['America/Denver', DAY], ['America/Denver', '2026-11-01'], ['America/Denver', '2027-03-14'], ['Europe/Berlin', '2027-03-28'],
      ['Asia/Kolkata', DAY], ['Pacific/Chatham', '2027-04-04'], ['UTC', DAY], ['Australia/Lord_Howe', '2026-10-04'],
    ];
    for (const [zone, day] of cases) {
      const talks = buildDemo({ ...ON, time_zone: zone }, day).docs.filter((d) => d.kind === 'talk').map((d) => [Date.parse(d.start), Date.parse(d.end)]);
      for (let m = 7 * 60; m <= 23 * 60; m++) {
        const t = instant(zone, day, m);
        assert.ok(talks.some(([s, e]) => s <= t && t < e), `${zone} ${day}: nothing running at minute ${m}`);
      }
    }
  });

  test('every item lasts what its wall clock says, and day and minutes are the local ones', () => {
    for (const zone of ['America/Denver', 'Asia/Kolkata', 'Pacific/Chatham']) {
      for (const day of ['2026-11-01', '2027-03-14', DAY]) {
        for (const d of buildDemo({ ...ON, time_zone: zone }, day).docs) {
          assert.equal((Date.parse(d.end) - Date.parse(d.start)) / 60_000, d.end_minutes - d.start_minutes, `${zone} ${d.talk_id}`);
          assert.ok(d.start_minutes >= 0 && d.end_minutes <= 1440 && d.end_minutes > d.start_minutes, d.talk_id);
          assert.equal(d.start.slice(0, 10), d.day);
        }
      }
    }
  });

  test('the ids and the texts are the same whatever the day or zone, so a daily run only moves times', () => {
    const base = buildDemo(ON, DAY).docs;
    const byId = new Map(base.map((d) => [d.talk_id, d]));
    assert.equal(byId.size, base.length, 'ids are unique');
    for (const [config, day] of [[ON, '2026-11-13'], [ON, '2027-06-30'], [{ ...ON, time_zone: 'Asia/Tokyo' }, '2026-02-01']]) {
      const other = buildDemo(config, day).docs;
      assert.deepEqual(other.map((d) => d.talk_id).sort(), [...byId.keys()].sort(), `${config.time_zone} ${day}: the same ids`);
      for (const d of other) {
        assert.equal(d.text_hash, byId.get(d.talk_id).text_hash, `${d.talk_id}: the same title and abstract`);
        assert.notEqual(d.content_hash, byId.get(d.talk_id).content_hash, `${d.talk_id}: new times`);
      }
    }
  });

  test('the documents have the ingest shape, with hashes as the ingest computes them', () => {
    const real = lines(path.join(ROOT, 'data/kubecon-cloudnativecon-north-america-2026/talks.ndjson'))[0];
    const { docs, conference, counts } = buildDemo(ON, DAY);
    for (const d of docs) {
      assert.deepEqual(Object.keys(d).sort(), Object.keys(real).sort(), d.talk_id);
      assert.equal(d.text_hash, textHash(d));
      assert.equal(d.content_hash, contentHash(d));
      assert.match(d.talk_id, /^caddie-demo-conference:[A-Za-z0-9_-]{1,64}$/);
      assert.equal(d.conference, SLUG);
      assert.equal(d.speakers.length, d.speaker_taglines.length);
    }
    const realConf = readJson(path.join(ROOT, 'data/kubecon-cloudnativecon-north-america-2026/conference.json'));
    assert.deepEqual(Object.keys(conference).filter((k) => k !== 'demo').sort(), Object.keys(realConf).sort());
    assert.equal(conference.demo, true);
    assert.equal(conference.source, 'demo');
    assert.equal(conference.status, 'searchable');
    assert.equal(counts.talk, docs.filter((d) => d.kind === 'talk').length);
    assert.equal(counts.sessions, docs.length);
    const order = docs.map((d) => [Date.parse(d.start), d.talk_id]);
    assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)), 'sorted by start, then id');
  });

  test('everything is invented and says so', () => {
    const { conference, docs } = buildDemo(ON, DAY);
    assert.match(conference.name, /\bDemo\b/);
    assert.equal(conference.official_schedule_url, null);
    const talks = docs.filter((d) => d.kind === 'talk');
    assert.equal(new Set(talks.map((d) => d.title)).size, talks.length, 'every talk title differs');
    for (const d of docs) {
      assert.equal(d.url, null);
      assert.equal(d.slides_url, null);
      assert.equal(d.sponsor, false);
      if (d.kind === 'talk' || d.kind === 'ambient') assert.ok(d.abstract.endsWith(inventedNote(conference.name)), d.talk_id);
      if (d.kind === 'talk') assert.ok(d.speakers.length >= 1);
      for (const p of d.speaker_profiles) assert.deepEqual(p.links, [], 'no links to anyone');
    }
  });
});

describe('the configuration', () => {
  test('is off by default and in the repository', () => {
    assert.equal(DEFAULT_DEMO_CONFIG.enabled, false);
    const committed = readDemoConfig(ROOT, {});
    assert.equal(committed.enabled, false, `${DEMO_CONFIG_FILE} must ship switched off`);
    assert.equal(readDemoConfig(path.join(ROOT, 'no-such-dir'), {}).enabled, false, 'a missing file is off');
  });

  test('refuses a slug without "demo", a name without "Demo", an unknown key, a bad zone or a bad switch', () => {
    for (const [bad, why] of [
      [{ slug: 'kubecon-cloudnativecon-north-america-2026' }, /contains "demo"/],
      [{ name: 'KubeCon' }, /"Demo"/],
      [{ name: 'Demonstration' }, /"Demo"/],
      [{ time_zone: 'Mars/Olympus' }, /IANA/],
      [{ enabled: 'yes' }, /true or false/],
      [{ enable: true }, /unknown key "enable"/],
      [{ location: { city: 'X', planet: 'Y' } }, /unknown key "location.planet"/],
    ]) assert.throws(() => validateDemoConfig(bad), why, JSON.stringify(bad));
    assert.equal(validateDemoConfig({ enabled: true, name: 'My Demo Day', slug: 'my-demo-2026' }).time_zone, DEFAULT_DEMO_CONFIG.time_zone);
  });

  test('today is the civil date in the zone, and CADDIE_DEMO_TODAY pins it', () => {
    const at = Date.parse('2026-11-12T05:30:00Z');
    assert.equal(todayIn('America/Denver', at), '2026-11-11');
    assert.equal(todayIn('Asia/Tokyo', at), '2026-11-12');
    assert.equal(demoToday(ON, { env: {}, nowMs: at }), '2026-11-11');
    assert.equal(demoToday(ON, { env: { CADDIE_DEMO_TODAY: '2030-01-02' }, nowMs: at }), '2030-01-02');
    assert.throws(() => demoToday(ON, { env: { CADDIE_DEMO_TODAY: '2030-02-30' } }), /YYYY-MM-DD/);
    assert.ok(isCivilDay('2028-02-29') && !isCivilDay('2027-02-29') && !isCivilDay('2026-13-01') && !isCivilDay('2026-11-11\n'));
  });
});

describe('the contracts', () => {
  test('a bundle built from the generator verifies, validates closed, carries demo: true and the demo attribution', async () => {
    const { conference: doc, docs } = buildDemo(ON, DAY);
    const conference = publicConference(doc);
    assert.equal(conference.demo, true);
    const check = validator('conferences-index.v1', 'Conference')(conference, { closed: true });
    assert.equal(check.valid, true, formatErrors(check.errors));
    const built = await buildConferenceBundle({ conference, talks: docs, embedder: hashEmbedder(), attribution: { ...DEMO_ATTRIBUTION, takedown: 'https://example.org/takedown' }, stoplistText: STOP });
    validateBuilt(built);
    const bundle = JSON.parse(built.files[BUNDLE_FILE].toString('utf8'));
    assert.equal(bundle.conference.demo, true, 'bundle.json carries the marker');
    assert.equal(bundle.attribution.license, 'CC0 1.0');
    assert.match(bundle.attribution.licensor, /Invented demo data/);
    assert.equal(bundle.attribution.source_url, null);
    assert.ok(bundle.topics.length > 0, 'the titles give topics');
    const index = buildIndex({ conferences: [conference], entries: new Map([[SLUG, built.entry]]), publisher: { name: 'Fixture', takedown: 'https://example.org/takedown' }, generatedAt: '2026-11-12T00:00:00Z' });
    const r = validator('conferences-index.v1')(index, { closed: true });
    assert.equal(r.valid, true, formatErrors(r.errors));
  });

  test('a real conference carries no demo key and keeps the LF attribution', () => {
    const doc = readJson(path.join(ROOT, 'data/pytorch-day-japan-2026/conference.json'));
    assert.ok(!('demo' in publicConference(doc)));
    assert.match(ATTRIBUTION.licensor, /Linux Foundation/);
    assert.ok(!validator('conferences-index.v1', 'Conference')({ ...publicConference(doc), demo: false }, { closed: true }).valid, 'demo is true or absent, never false');
  });

  test('the contract fixtures: an index with a demo entry validates, demo: false never does', () => {
    const fixture = readJson(path.join(ROOT, 'contracts/fixtures/demo/conferences.json'));
    const r = validator('conferences-index.v1')(fixture, { closed: true });
    assert.equal(r.valid, true, formatErrors(r.errors));
    assert.deepEqual(fixture.conferences.filter((c) => c.demo === true).map((c) => c.slug), [SLUG]);
    assert.ok(fixture.conferences.some((c) => !('demo' in c)), 'a real entry has no demo key');
    const bad = readJson(path.join(ROOT, 'contracts/fixtures/demo/invalid-demo-false.json'));
    for (const closed of [true, false]) assert.equal(validator('conferences-index.v1', 'Conference')(bad, { closed }).valid, false);
  });
});

// The ingest, run as the workflows run it, in a temporary data directory and with no key.
function ingest(dataDir, args, { config = ON, today = DAY, extraEnv = {} } = {}) {
  const configFile = path.join(dataDir, '..', `demo-config-${crypto.randomBytes(4).toString('hex')}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const r = spawnSync(process.execPath, ['scripts/ingest.mjs', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, CADDIE_DATA_DIR: dataDir, CADDIE_DEMO_CONFIG: configFile, CADDIE_DEMO_TODAY: today, ...extraEnv },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the ingest', () => {
  test('refuses the demo while it is off and writes nothing', () => withTemp((dir) => {
    const data = path.join(dir, 'data');
    mkdirSync(data);
    const r = ingest(data, ['--event', SLUG, '--dry-run'], { config: DEFAULT_DEMO_CONFIG });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /is the demo conference, which is switched off/);
    assert.ok(!existsSync(path.join(data, SLUG)));
  }));

  test('builds the demo from the generator with no network call, as buildDemo gives it', () => withTemp((dir) => {
    const data = path.join(dir, 'data');
    mkdirSync(data);
    const report = path.join(dir, 'report.json');
    const r = ingest(data, ['--event', SLUG, '--dry-run', '--skip-topics', '--report', report]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Network calls this run: 0/);
    assert.deepEqual(readJson(report), { processed: [SLUG] });
    const expected = buildDemo(ON, DAY);
    const conf = readJson(path.join(data, SLUG, 'conference.json'));
    assert.ok(Date.parse(conf.raw_fetched_at) > 0);
    assert.deepEqual({ ...conf, raw_fetched_at: null }, expected.conference);
    assert.deepEqual(lines(path.join(data, SLUG, 'talks.ndjson')), expected.docs);
  }));

  test('the operator file applies: hidden is written unavailable, removed is skipped', () => withTemp((dir) => {
    const data = path.join(dir, 'data');
    mkdirSync(data);
    writeFileSync(path.join(data, 'conference-operator.json'), JSON.stringify({ hidden: { [SLUG]: { reason: 'other', since: '2026-11-11T00:00:00Z' } }, removed: {} }));
    const hidden = ingest(data, ['--event', SLUG, '--dry-run', '--skip-topics']);
    assert.equal(hidden.status, 0, hidden.out);
    const conf = readJson(path.join(data, SLUG, 'conference.json'));
    assert.equal(conf.status, 'unavailable');
    assert.equal(conf.status_reason, 'operator_hidden');
    rmSync(path.join(data, SLUG), { recursive: true });
    writeFileSync(path.join(data, 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [SLUG]: { since: '2026-11-11T00:00:00Z' } } }));
    const removed = ingest(data, ['--event', SLUG, '--dry-run', '--skip-topics']);
    assert.equal(removed.status, 0, removed.out);
    assert.match(removed.out, /skipped: removed by the operator/);
    assert.ok(!existsSync(path.join(data, SLUG)));
  }));

  test('an explicit --event list may name the demo with LF events, and --list shows it only when on', () => withTemp((dir) => {
    const data = path.join(dir, 'data');
    const one = 'pytorch-day-japan-2026';
    mkdirSync(path.join(data, 'raw'), { recursive: true });
    const list = readJson(path.join(ROOT, 'data/raw/lf-events-upcoming.json'));
    cpSync(path.join(ROOT, 'data/raw', one), path.join(data, 'raw', one), { recursive: true });
    cpSync(path.join(ROOT, 'data', one), path.join(data, one), { recursive: true });
    assert.ok(deriveEvents(list).some((e) => e.slug === one), 'the committed LF list names the test event');
    writeFileSync(path.join(data, 'raw/lf-events-upcoming.json'), JSON.stringify(list));
    const report = path.join(dir, 'report.json');
    const r = ingest(data, ['--event', one, '--event', SLUG, '--no-fetch', '--dry-run', '--skip-topics', '--report', report]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readJson(report).processed.sort(), [one, SLUG].sort(), 'an explicit --event list may name both');
    const listed = ingest(data, ['--list', '--no-fetch']);
    assert.equal(listed.status, 0, listed.out);
    assert.match(listed.out, new RegExp(`${SLUG} \\| 2026-11-11\\.\\.2026-11-13 \\| .* only with --event`));
    const off = ingest(data, ['--list', '--no-fetch'], { config: DEFAULT_DEMO_CONFIG });
    assert.ok(!off.out.includes(SLUG), 'an off demo is not listed');
  }));
});

describe('the all-upcoming selection', () => {
  // A run over the whole committed list would build every event; the selection is checked on a list
  // cut down to one event, with the demo switched on.
  test('leaves the demo out', () => withTemp((dir) => {
    const data = path.join(dir, 'data');
    const one = 'pytorch-day-japan-2026';
    mkdirSync(path.join(data, 'raw'), { recursive: true });
    const raw = readJson(path.join(ROOT, 'data/raw/lf-events-upcoming.json'));
    const cut = raw.filter((e) => deriveEvents([e])[0]?.slug === one);
    assert.equal(cut.length, 1, 'the committed LF list names the test event once');
    writeFileSync(path.join(data, 'raw/lf-events-upcoming.json'), JSON.stringify(cut));
    cpSync(path.join(ROOT, 'data/raw', one), path.join(data, 'raw', one), { recursive: true });
    cpSync(path.join(ROOT, 'data', one), path.join(data, one), { recursive: true });
    const report = path.join(dir, 'report.json');
    const r = ingest(data, ['--all-upcoming', '--no-fetch', '--dry-run', '--skip-topics', '--report', report]);
    assert.equal(r.status, 0, r.out);
    assert.ok(!readJson(report).processed.includes(SLUG), r.out);
    assert.ok(readJson(report).processed.includes(one), r.out);
    assert.ok(!existsSync(path.join(data, SLUG)));
  }));
});

describe('prepare, status and the bundle build', () => {
  const configEnv = (dir, config) => {
    const file = path.join(dir, `config-${crypto.randomBytes(4).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify(config));
    return { PATH: process.env.PATH, CADDIE_DEMO_CONFIG: file, CADDIE_DEMO_TODAY: DAY };
  };
  // A data directory with one small real conference, so a build without the demo has something to build.
  const dataWithReal = (dir) => {
    const data = path.join(dir, 'data');
    mkdirSync(data, { recursive: true });
    cpSync(path.join(ROOT, 'data/pytorch-day-japan-2026'), path.join(data, 'pytorch-day-japan-2026'), { recursive: true });
    return data;
  };
  const build = (data, out, extra = []) => buildBundles(bundleArgs(['--out', out, '--reuse-from', 'none', ...extra]), { embedder: hashEmbedder(), dataDir: data, log: () => {}, now: () => new Date('2026-11-12T12:00:00Z') });

  test('on: prepare generates the demo, the build publishes it with demo: true; off: prepare removes it and a --fresh build drops it', () => withTemp(async (dir) => {
    const data = dataWithReal(dir);
    const log = [];
    prepare({ dataDir: data, env: configEnv(dir, ON), log: (m) => log.push(m) });
    assert.ok(existsSync(path.join(data, SLUG, 'talks.ndjson')), log.join('\n'));
    const first = path.join(dir, 'site-on');
    assert.ok((await build(data, first)).ok);
    const index = readJson(path.join(first, 'bundles/conferences.json'));
    const entry = index.conferences.find((c) => c.slug === SLUG);
    assert.ok(entry?.bundle, 'the demo has a bundle');
    assert.equal(entry.demo, true);
    assert.equal(entry.start_date, '2026-11-11');
    assert.ok(!('demo' in index.conferences.find((c) => c.slug === 'pytorch-day-japan-2026')), 'a real conference has no demo key');
    assert.equal(validator('conferences-index.v1')(index, { closed: true }).valid, true);

    const live = await status({ live: first, root: ROOT, dataDir: data, env: configEnv(dir, ON) });
    assert.equal(live.stale, false, JSON.stringify(live));
    const tomorrow = await status({ live: first, root: ROOT, dataDir: data, env: { ...configEnv(dir, ON), CADDIE_DEMO_TODAY: '2026-11-13' } });
    assert.equal(tomorrow.stale, true, 'the next day the live bundle is stale');

    prepare({ dataDir: data, env: configEnv(dir, DEFAULT_DEMO_CONFIG), log: () => {} });
    assert.ok(!existsSync(path.join(data, SLUG)), 'off: the generated folder is removed');
    const offStatus = await status({ live: first, root: ROOT, dataDir: data, env: configEnv(dir, DEFAULT_DEMO_CONFIG) });
    assert.equal(offStatus.stale, true, 'off but still listed: stale');
    const second = path.join(dir, 'site-off');
    assert.ok((await build(data, second, ['--live', first, '--fresh', SLUG])).ok);
    const after = readJson(path.join(second, 'bundles/conferences.json'));
    assert.ok(!after.conferences.some((c) => c.slug === SLUG), 'off: the demo is absent from the published index');
    assert.ok(after.conferences.some((c) => c.slug === 'pytorch-day-japan-2026'));
    const gone = await status({ live: second, root: ROOT, dataDir: data, env: configEnv(dir, DEFAULT_DEMO_CONFIG) });
    assert.equal(gone.stale, false);
  }));

  test('a hidden demo is generated unavailable and the --fresh build drops it; a staged one is left as staged', () => withTemp(async (dir) => {
    const data = dataWithReal(dir);
    writeFileSync(path.join(data, 'conference-operator.json'), JSON.stringify({ hidden: { [SLUG]: { reason: 'other', since: '2026-11-11T00:00:00Z' } }, removed: {} }));
    prepare({ dataDir: data, env: configEnv(dir, ON), log: () => {} });
    assert.equal(readJson(path.join(data, SLUG, 'conference.json')).status, 'unavailable');
    const out = path.join(dir, 'site');
    assert.ok((await build(data, out, ['--live', path.join(dir, 'no-site'), '--fresh', SLUG])).ok);
    assert.ok(!readJson(path.join(out, 'bundles/conferences.json')).conferences.some((c) => c.slug === SLUG));
    const st = await status({ live: out, root: ROOT, dataDir: data, env: configEnv(dir, ON) });
    assert.equal(st.active, false);
    assert.equal(st.stale, false, 'hidden and absent: nothing to publish');

    writeFileSync(path.join(data, SLUG, 'conference.json'), '{"staged":true}');
    prepare({ dataDir: data, staged: [SLUG], env: configEnv(dir, ON), log: () => {} });
    assert.equal(readFileSync(path.join(data, SLUG, 'conference.json'), 'utf8'), '{"staged":true}');
  }));

  test('an unreadable live site is stale only while the demo is active; the arguments are checked', async () => {
    const failing = async () => { throw new Error('offline'); };
    const off = await status({ live: 'https://example.invalid/bundles/', root: ROOT, env: { CADDIE_DEMO_TODAY: DAY }, fetchFn: failing, log: () => {} });
    assert.equal(off.enabled, false);
    assert.equal(off.stale, false, 'off: a later build drops it anyway');
    await withTemp(async (dir) => {
      const on = await status({ live: 'https://example.invalid/bundles/', root: ROOT, dataDir: path.join(dir, 'none'), env: configEnv(dir, ON), fetchFn: failing, log: () => {} });
      assert.equal(on.stale, true);
      assert.equal(on.live, 'unreadable');
    });
    assert.throws(() => demoArgs(['publish']), /status, prepare, es-check/);
    assert.throws(() => demoArgs(['status', '--data', 'x']), /Unknown argument/);
    assert.deepEqual(demoArgs(['prepare', '--staged', '']).staged, []);
  });
});

describe('the workflows', () => {
  const read = (f) => readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');

  test('pages.yml prepares the demo before any third-party package and always passes its slug in --fresh', () => {
    const y = read('pages.yml');
    const prepareAt = y.indexOf('node scripts/demo-conference.mjs prepare --data data --staged "$STAGED"');
    assert.ok(prepareAt > y.indexOf('name: Lay the ingest data over data/'), 'after the ingest data is laid');
    assert.ok(prepareAt < y.indexOf('npm --prefix tools/bundles ci'), 'before the bundle tools are installed');
    assert.ok(y.includes('DEMO_SLUG: ${{ steps.demo.outputs.slug }}'));
    assert.ok(y.includes('if [ -n "$DEMO_SLUG" ]; then fresh="${fresh:+$fresh,}$DEMO_SLUG"; fi'));
    assert.ok(y.includes("REUSE_FLAG: ${{ github.event_name == 'schedule' && !inputs.demo_refresh && '--reuse-from none' || '' }}"), 'a demo refresh reuses the published vectors');
  });

  test('demo-conference.yml: pinned actions, the key only where the ingest needs it, pages only when stale', () => {
    const y = read('demo-conference.yml');
    for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^(\.\/\.github\/workflows\/pages\.yml|[\w-]+\/[\w-]+@[0-9a-f]{40})$/, m[1]);
    assert.equal(y.match(/secrets\.CADDIE_DEMO_ES_API_KEY/g).length, 2, 'the configuration check and the ingest step');
    assert.ok(!/secrets\.(?!CADDIE_DEMO_ES_API_KEY)/.test(y), 'no other secret');
    assert.ok(y.includes('node scripts/ingest.mjs --event "$SLUG" --skip-topics --refresh-only'), 'the schedule never creates or brings back the demo');
    assert.ok(y.includes('node scripts/demo-conference.mjs es-check'));
    assert.ok(y.includes('environment: demo-refresh'), 'the key lives in an environment only main may use');
    assert.ok(!/npm (ci|install)/.test(y), 'nothing is installed next to the key');
    assert.ok(y.includes("if: needs.check.outputs.stale == 'true' && needs.check.outputs.busy != 'true'"));
    assert.ok(y.includes('demo_refresh: true'));
    assert.match(y, /^permissions:\n {2}contents: read$/m);
  });
});

describe('hardening of the workflow steps', () => {
  const respond = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  test('values from the live site are checked before they reach an output', async () => {
    const tricky = { conferences: [{ slug: SLUG, status: 'searchable\nenabled=true', start_date: '2026-11-11\nslug=x', end_date: '2026-13-01', bundle: {} }] };
    const seen = await liveEntry('https://example.invalid/bundles/', SLUG, { fetchFn: respond(200, tricky) });
    assert.deepEqual(seen, { readable: true, listed: true, status: 'malformed', start_date: null, end_date: null, bundle: true });
    assert.deepEqual(await liveEntry('https://example.invalid/bundles/', SLUG, { fetchFn: respond(404, '') }), { readable: true, listed: false });
    assert.equal((await liveEntry('https://example.invalid/bundles/', SLUG, { fetchFn: respond(500, '') })).readable, false);
    assert.throws(() => outputLines({ live: 'a\nenabled=true' }), /not one plain line/);
    assert.throws(() => outputLines({ slug: 'Not A Slug' }), /not a slug/);
    assert.deepEqual(outputLines({ enabled: true, slug: SLUG }), ['enabled=true', `slug=${SLUG}`]);
  });

  test('a configuration that does not validate turns the demo off with a warning instead of stopping the build', () => withTemp(async (dir) => {
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{"enabled": true, "slug": "kubecon-2026"}');
    const env = { PATH: process.env.PATH, CADDIE_DEMO_CONFIG: bad, CADDIE_DEMO_TODAY: DAY };
    const log = [];
    assert.deepEqual(prepare({ dataDir: path.join(dir, 'data'), env, log: (m) => log.push(m) }), { enabled: false, slug: '' });
    assert.match(log.join('\n'), /::warning::The demo conference is treated as off: .*contains "demo"/);
    assert.equal((await status({ live: path.join(dir, 'none'), env, log: () => {} })).stale, false);
    const data = path.join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const r = spawnSync(process.execPath, ['scripts/ingest.mjs', '--event', 'no-such-demo', '--dry-run'], { cwd: ROOT, env: { ...env, CADDIE_DATA_DIR: data }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /treated as off/);
  }));

  test('es-check warns only when the demo is off but Elasticsearch still holds it searchable', async () => {
    const env = { CADDIE_DEMO_CONFIG: path.join(ROOT, 'config/demo-conference.json'), ES_URL: 'https://es.example.invalid', ES_API_KEY: 'k' };
    const lines = [];
    const held = await esCheck({ env, fetchFn: respond(200, { found: true, _source: { status: 'searchable' } }), log: (m) => lines.push(m) });
    assert.equal(held.backend, 'searchable');
    assert.match(lines.join('\n'), /::warning::The demo conference is switched off .* still holds caddie-demo-conference as searchable/);
    assert.ok(!lines.join('\n').includes('k\n'), 'the key is never printed');
    lines.length = 0;
    assert.equal((await esCheck({ env, fetchFn: respond(404, {}), log: (m) => lines.push(m) })).backend, 'absent');
    assert.equal((await esCheck({ env, fetchFn: respond(200, { found: true, _source: { status: 'unavailable' } }), log: (m) => lines.push(m) })).backend, 'unavailable');
    assert.deepEqual(lines, []);
    await assert.rejects(esCheck({ env, fetchFn: respond(403, {}), log: () => {} }), /status 403/);
  });
});

test('the bundle plan never keeps a live demo conference from an earlier build', () => {
  const hash = 'a'.repeat(64);
  const live = (demo) => ({ conferences: [{ conference: { slug: SLUG, ...(demo ? { demo: true } : {}) }, bundle: { content_hash: hash } }], sources: new Map([[SLUG, { content_hash: hash, raw_fetched_at: '2099-01-01T00:00:00Z' }]]) });
  // A record from the future would keep any other conference; a demo is dropped all the same.
  assert.equal(planBuild({ local: new Map(), live: live(true), now: Date.parse('2099-01-01T00:00:00Z') }).get(SLUG).action, 'drop');
  assert.equal(planBuild({ local: new Map([[SLUG, { status: 'searchable', raw_fetched_at: null }]]), live: live(true) }).get(SLUG).action, 'build');
  assert.equal(planBuild({ local: new Map(), live: live(false), now: Date.parse('2099-01-01T00:00:00Z') }).get(SLUG).action, 'keep', 'a real conference is still kept');
});
