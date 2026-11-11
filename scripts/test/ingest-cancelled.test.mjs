// Cancelled Sessionize sessions are dropped by the shared normaliser (scripts/lib/classify.mjs
// buildTalks), which both the free stack's ingest and the tier 3 ingest run, so they leave the talk
// file and with it the Worker, the bundles and the search index. Fixtures only, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalks, isCancelled } from '../lib/classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'caddie-fixture-2099';
const CONF = { slug: SLUG, time_zone: 'UTC', sessionize_public_slug: 'caddie-fixture', sessionize_site_published: true, official_schedule_url: 'https://example.org/schedule' };
const CONFIG = { primaryFilterTitle: 'Track', hiddenFilterCategories: [] };

function session(id, title, { speakers = [1], status = 'Accepted', description = 'An abstract.' } = {}) {
  return {
    id: String(id), title, description, startsAt: '2099-06-01T10:00:00', endsAt: '2099-06-01T10:30:00',
    isServiceSession: false, isPlenumSession: false, speakers, categoryItems: [10], questionAnswers: [], roomId: 5,
    liveUrl: null, recordingUrl: null, status, isInformed: true, isConfirmed: true,
  };
}

function feed(sessions) {
  return {
    sessions,
    speakers: [{ id: 1, fullName: 'Ada Example', tagLine: 'Engineer', links: [] }],
    questions: [],
    categories: [{ id: 1, title: 'Track', sort: 0, items: [{ id: 10, name: 'Kubernetes', sort: 0 }] }],
    rooms: [{ id: 5, name: 'Hall A' }],
  };
}

test('isCancelled: a cancel marker at the start of the title, or a cancelled status', () => {
  const yes = [
    'CANCELED: Building a Cloud-Native RAG Pipeline', 'CANCELLED - CLBO: ClashLoopBackOff: Demo Night', 'Canceled: x', 'cancelled - x',
    'Cancelled x', '  CANCELLED:x', '[Cancelled] Title', '[CANCELED]: Title', '(Canceled) Title', 'Cancelled', 'CANCELLED—Title',
  ];
  const no = [
    'Cancellation policies for batch jobs', 'Canceling a rollout safely', 'Cancelledness', 'A talk, CANCELLED', 'Uncancelled', '[Cancelled talk] x',
    'Why we cancelled our service mesh', '',
  ];
  for (const title of yes) assert.equal(isCancelled({ title, status: 'Accepted' }), true, title);
  for (const title of no) assert.equal(isCancelled({ title, status: 'Accepted' }), false, title);
  for (const status of ['Cancelled', 'canceled', ' CANCELLED ']) assert.equal(isCancelled({ title: 'A talk', status }), true, status);
  assert.equal(isCancelled({ title: 'A talk', status: 'Accepted' }), false);
  assert.equal(isCancelled({}), false);
});

test('buildTalks drops cancelled sessions of every kind, and the counts leave them out', () => {
  const sessions = [
    session(1, 'Scheduling at scale'),
    session(2, 'CANCELED: Building a Cloud-Native RAG Pipeline from Scratch'), // a cancelled talk
    session(3, 'CANCELLED - CLBO: ClashLoopBackOff: Demo Night', { speakers: [] }), // a cancelled ambient item
    session(4, 'Community showcase', { speakers: [] }),
    session(5, 'A talk the organisers cancelled', { status: 'Cancelled' }),
    session(6, '[Cancelled] Coffee Break', { speakers: [], description: '' }),
    // A cancelled session whose speaker is not in the feed any more: dropped, not an unresolved id.
    session(7, 'Cancelled: gone', { speakers: [99] }),
  ];
  const built = buildTalks(feed(sessions), CONFIG, CONF);
  assert.deepEqual(built.unresolved, []);
  assert.deepEqual(built.cancelled, ['2', '3', '5', '6', '7']);
  assert.deepEqual(built.docs.map((d) => [d.session_id, d.kind]), [['1', 'talk'], ['4', 'ambient']]);
  assert.deepEqual(built.counts, { sessions: 2, talk: 1, ambient: 1, break: 0, housekeeping: 0, with_slides: 0, sponsor: 0 });

  // The same feed before the cancellation: the talk is there, and a re-ingest after it leaves its
  // talk_id out, which the Worker's finalize and Elasticsearch's delete step then remove.
  const before = buildTalks(feed([session(1, 'Scheduling at scale'), session(2, 'Building a Cloud-Native RAG Pipeline from Scratch')]), CONFIG, CONF);
  const after = buildTalks(feed([session(1, 'Scheduling at scale'), session(2, 'CANCELED: Building a Cloud-Native RAG Pipeline from Scratch')]), CONFIG, CONF);
  const gone = before.docs.map((d) => d.talk_id).filter((id) => !after.docs.some((d) => d.talk_id === id));
  assert.deepEqual(gone, [`${SLUG}:2`]);
  assert.equal(after.docs[0].content_hash, before.docs[0].content_hash, 'the other talks are unchanged');
});

test('no committed talk file holds a session that its raw feed marks cancelled', () => {
  // On 2026-11-11 the committed raw feeds held no cancelled session (the KubeCon North America 2026
  // snapshot predates both cancellations seen live); this keeps any later snapshot consistent.
  const raw = path.join(ROOT, 'data', 'raw');
  let feeds = 0;
  for (const slug of readdirSync(raw)) {
    const file = path.join(raw, slug, 'view-all.json');
    const talksFile = path.join(ROOT, 'data', slug, 'talks.ndjson');
    if (!existsSync(file) || !existsSync(talksFile)) continue;
    feeds++;
    const cancelled = new Set(JSON.parse(readFileSync(file, 'utf8')).sessions.filter(isCancelled).map((s) => String(s.id)));
    const kept = readFileSync(talksFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).session_id);
    assert.deepEqual(kept.filter((id) => cancelled.has(id)), [], slug);
  }
  assert.ok(feeds > 0);
});
