// data/takedowns.json reaches the Worker: worker/ingest/push-ingest.mjs applies the bundle builder's
// own applyTakedowns (scripts/build-bundles.mjs) to the talks it sends, so a talk or a speaker taken
// down from the bundles is removed from the Worker the same way. Fixtures and a recording stand-in
// for the admin routes; no network, no Worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyTakedowns, loadTakedowns, trimTalk } from '../build-bundles.mjs';
import { contentHash, textHash } from '../lib/hash.mjs';
import { workerTalks, countsAfterTakedowns, pushEvent, selectSlugs } from '../../worker/ingest/push-ingest.mjs';
import { loadStoplist } from '../../worker/ingest/topics-local.mjs';

const SLUG = 'caddie-fixture-2099';
const T = (n) => `${SLUG}:${n}`;
const GONE = 'Grace Hidden';

function talk(n, { kind = 'talk', title = `Talk ${n} about Kubernetes scheduling`, speakers = [], has_slides = false, sponsor = false } = {}) {
  const doc = {
    talk_id: T(n), conference: SLUG, session_id: String(n), kind, title, abstract: `Abstract of talk ${n} on Kubernetes scheduling and eBPF.`,
    speakers: speakers.map((s) => s.name),
    speaker_taglines: speakers.map((s) => s.tagline).filter(Boolean),
    speaker_profiles: speakers.map((s) => ({ name: s.name, tagline: s.tagline ?? null, links: s.links ?? [] })),
    room: 'Hall A', track: 'Kubernetes', level: null, tags: [], tag_keys: [], sponsor, has_slides, slides_url: has_slides ? `https://example.org/${n}.pdf` : null,
    url: `https://example.org/session/${n}`, start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z', day: '2099-06-01', start_minutes: 600, end_minutes: 630,
  };
  doc.text_hash = textHash(doc);
  doc.content_hash = contentHash(doc);
  return doc;
}

const ADA = { name: 'Ada Example', tagline: 'Engineer, Example Org', links: [{ title: 'Website', url: 'https://example.org/ada' }] };
const GRACE = { name: GONE, tagline: 'Maintainer, Hidden Project', links: [{ title: 'Blog', url: 'https://example.org/grace' }] };
const LINUS = { name: 'Linus Example', tagline: null, links: [{ title: 'Code', url: 'https://example.org/linus' }] };

function fixture() {
  return [
    talk(1, { speakers: [ADA, GRACE, LINUS], has_slides: true }),
    talk(2, { speakers: [GRACE] }),
    talk(3, { speakers: [LINUS], sponsor: true }),
    talk(4, { speakers: [ADA] }),
    talk(5, { kind: 'break', title: 'Coffee' }),
  ];
}

const TAKEDOWNS = [
  { slug: SLUG, talk_id: T(4), reason: 'request #1', date: '2026-11-11' },
  { slug: SLUG, speaker: 'grace hidden', reason: 'request #2', date: '2026-11-11' },
  { slug: 'another-conference-2099', talk_id: 'another-conference-2099:1', reason: 'request #3', date: '2026-11-11' },
];

test('workerTalks applies the same takedowns as the bundles and re-hashes what it redacts', () => {
  const talks = fixture();
  const r = workerTalks(SLUG, talks, TAKEDOWNS);
  assert.equal(r.entries, 2);
  assert.equal(r.dropped, 1);
  assert.equal(r.redacted, 2);
  // The same talks and speakers as applyTakedowns gives the bundle build.
  const bundle = applyTakedowns(SLUG, talks, TAKEDOWNS).talks;
  assert.deepEqual(r.talks.map((t) => [t.talk_id, t.speakers]), bundle.map((t) => [t.talk_id, t.speakers]));
  // What the bundle carries of each talk (trimTalk) is the same whichever of the two it is built
  // from; only the Worker's content_hash differs, and bundles do not carry it.
  const view = ({ content_hash, ...rest }) => trimTalk(rest);
  assert.deepEqual(r.talks.map(view), bundle.map(view), 'the bundle view of what the Worker gets is the bundle');
  // The taken-down talk is not sent, and the speaker is nowhere in what is sent.
  assert.ok(!r.talks.some((t) => t.talk_id === T(4)));
  assert.ok(!JSON.stringify(r.talks).includes(GONE));
  assert.ok(!JSON.stringify(r.talks).includes('Hidden Project'));
  assert.ok(!JSON.stringify(r.talks).includes('example.org/grace'));
  // The other speakers keep their taglines and links, in order.
  const one = r.talks.find((t) => t.talk_id === T(1));
  assert.deepEqual(one.speakers, ['Ada Example', 'Linus Example']);
  assert.deepEqual(one.speaker_taglines, ['Engineer, Example Org']);
  assert.deepEqual(one.speaker_profiles, [
    { name: 'Ada Example', tagline: 'Engineer, Example Org', links: ADA.links },
    { name: 'Linus Example', tagline: null, links: LINUS.links },
  ]);
  // A redacted talk gets a new content_hash (the Worker skips a hash it holds); its text is unchanged.
  const before = talks.find((t) => t.talk_id === T(1));
  assert.notEqual(one.content_hash, before.content_hash);
  assert.equal(one.content_hash, contentHash(one));
  assert.equal(one.text_hash, before.text_hash);
  const two = r.talks.find((t) => t.talk_id === T(2));
  assert.deepEqual([two.speakers, two.speaker_taglines, two.speaker_profiles], [[], [], []]);
  // Untouched talks are sent exactly as the talk file has them.
  for (const n of [3, 5]) assert.equal(r.talks.find((t) => t.talk_id === T(n)), talks.find((t) => t.talk_id === T(n)));
});

test('workerTalks without entries for the conference sends the talk file unchanged', () => {
  const talks = fixture();
  const r = workerTalks(SLUG, talks, [TAKEDOWNS[2]]);
  assert.equal(r.talks, talks);
  assert.deepEqual([r.dropped, r.redacted, r.entries], [0, 0, 0]);
});

test('workerTalks fails closed like the bundle build: an entry that matches nothing stops the conference', () => {
  const talks = fixture();
  assert.throws(() => workerTalks(SLUG, talks, [{ slug: SLUG, speaker: 'Nobody Here', reason: 'r', date: '2026-11-11' }]), /matched nothing/);
  assert.throws(() => workerTalks(SLUG, talks, [{ slug: SLUG, talk_id: T(99), reason: 'r', date: '2026-11-11' }]), /matched nothing/);
  // purged: the content is already gone from data/; the entry stays as a guard and applies if it matches again.
  assert.equal(workerTalks(SLUG, talks, [{ slug: SLUG, talk_id: T(99), reason: 'r', date: '2026-11-11', purged: true }]).dropped, 0);
  assert.equal(workerTalks(SLUG, talks, [{ slug: SLUG, talk_id: T(4), reason: 'r', date: '2026-11-11', purged: true }]).dropped, 1);
});

test('countsAfterTakedowns recounts the conference document over the talks that remain', () => {
  const talks = fixture();
  const counts = { sessions: 5, talk: 4, ambient: 0, break: 1, housekeeping: 0, with_slides: 1, sponsor: 1 };
  const { talks: left } = workerTalks(SLUG, talks, TAKEDOWNS);
  assert.deepEqual(countsAfterTakedowns(counts, left), { sessions: 4, talk: 3, ambient: 0, break: 1, housekeeping: 0, with_slides: 1, sponsor: 1 });
  assert.deepEqual(countsAfterTakedowns(counts, talks), counts);
});

test('pushEvent sends the redacted talks, topics and facets, and finalize removes the dropped talk', async () => {
  const calls = [];
  const admin = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { topics: [] };
    if (url.startsWith('/admin/talks/finalize')) return { talks: 4, deleted: 1, unshared: 0 };
    if (url.startsWith('/admin/talks')) return { upserted: body.talks.length, unchanged: 0, embedded: body.talks.length, pending: 0 };
    if (url.startsWith('/admin/topics')) return { topics: body.topics.length };
    return { facets: body.facets.length };
  };
  const prepared = workerTalks(SLUG, fixture(), TAKEDOWNS);
  const line = await pushEvent({ slug: SLUG }, prepared, { admin, dryRun: false, generation: 7, rebuild: false, stop: loadStoplist() });
  assert.match(line, /takedowns 2 \(1 talks dropped, 2 redacted\)/);
  assert.match(line, /deleted 1/);
  const sent = calls.filter((c) => c.method === 'POST' && c.url.startsWith('/admin/talks?'));
  assert.deepEqual(sent.flatMap((c) => c.body.talks.map((t) => t.talk_id)).sort(), [T(1), T(2), T(3), T(5)]);
  assert.ok(calls.some((c) => c.url.startsWith('/admin/talks/finalize') && c.body.generation === 7));
  // Nothing sent anywhere names the speaker: not the talks, not the topics, not the facets.
  for (const c of calls) assert.ok(!JSON.stringify(c.body ?? {}).toLowerCase().includes('grace'), `${c.method} ${c.url}`);
  const facets = calls.find((c) => c.url.startsWith('/admin/facets')).body.facets;
  assert.ok(facets.some((f) => f.kind === 'speaker' && f.value === 'Ada Example'));
});

test('a takedown file is validated as the bundle build validates it, and a not re-fetched conference is pushed by --event', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'caddie-takedowns-'));
  try {
    mkdirSync(path.join(dir, SLUG));
    writeFileSync(path.join(dir, SLUG, 'conference.json'), '{}');
    writeFileSync(path.join(dir, 'takedowns.json'), JSON.stringify(TAKEDOWNS.slice(0, 2)));
    assert.equal(loadTakedowns(path.join(dir, 'takedowns.json'), { dataDir: dir }).length, 2);
    writeFileSync(path.join(dir, 'takedowns.json'), JSON.stringify(TAKEDOWNS));
    assert.throws(() => loadTakedowns(path.join(dir, 'takedowns.json'), { dataDir: dir }), /not a conference folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The operator's command for a conference the ingest no longer fetches: --event selects it from data/.
  assert.deepEqual(selectSlugs({ events: [SLUG] }), [SLUG]);
});
