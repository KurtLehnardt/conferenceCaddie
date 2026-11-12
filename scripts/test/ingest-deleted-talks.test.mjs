// What scripts/ingest.mjs does around the talks it deletes, as the Worker's finalize does
// (worker/src/admin.js finalizeTalks):
// - the shrink guard (FINALIZE_MAX_DELETE): a conference that would lose more than 10 talks and more
//   than 10% of its talks (stored plus new) is refused before anything is written, unless
//   --allow-shrink, and a dry run reports it;
// - the people who shared for a deleted talk: the talk leaves their shared_talk_ids, a profile left
//   with neither choice is deleted with its meets, push registrations, nudge records and blocks, and
//   everyone else is kept.
// The ingest runs as a child process against the in-memory Elasticsearch of test/helpers/fake-es.mjs
// served on loopback, over a copy of the committed KubeCon data in a temporary CADDIE_DATA_DIR with
// --no-fetch and --skip-topics and dummy keys: no network, and the tracked data is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeES, serve, INDEX, FUTURE, newDevice } from '../../test/helpers/fake-es.mjs';
import { shrinkRefusal } from '../lib/dropped-talks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'kubecon-cloudnativecon-north-america-2026';
const INGEST_KEY = 'test-ingest-key';
const PEOPLE_KEY = 'test-people-key';
const COMMITTED = readFileSync(path.join(ROOT, 'data', SLUG, 'talks.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const T = COMMITTED.length;
// The guard refuses n stale talks of T + n when n > 10 and n > (T + n) / 10, that is 9n > T. The
// total is the stored talks plus the new ones, as the Worker counts after its upsert, so it is T + n
// whatever part of the feed is new.
const ALLOWED = Math.floor(T / 9);
const REFUSED = ALLOWED + 1;
const talkId = (session) => `${SLUG}:${session}`;
const stale = (n) => Array.from({ length: n }, (_, i) => talkId(String(99_000_000 + i)));
const kept = COMMITTED.filter((d) => d.kind === 'talk').slice(0, 2).map((d) => d.talk_id);

test('the boundary the end-to-end cases use is the Worker rule on this data', () => {
  assert.ok(T > 100, `${T} committed documents`);
  assert.equal(shrinkRefusal(ALLOWED, T + ALLOWED), null);
  assert.ok(shrinkRefusal(REFUSED, T + REFUSED));
});

// The talks index holds the committed talks (but the first `fresh`, which the run adds as new) plus
// the given stale ones, so the run deletes exactly those.
function clusterWith(staleIds, { fresh = 0 } = {}) {
  const cluster = new FakeES();
  for (const d of COMMITTED.slice(fresh)) cluster.put(INDEX.talks, d.talk_id, d);
  for (const id of staleIds) cluster.put(INDEX.talks, id, { talk_id: id, conference: SLUG, kind: 'talk', title: 'Gone', content_hash: 'c', text_hash: 't' });
  return cluster;
}

function addProfile(cluster, fields) {
  const { profileId } = newDevice();
  const id = `${SLUG}:${profileId}`;
  cluster.put(INDEX.people, id, {
    event_id: SLUG, profile_id: profileId, ref: profileId.slice(0, 16), secret_hash: 'f'.repeat(64), display_name: 'Test person',
    about: 'About me', open_to_meet: true, shared_talk_ids: [], visible_until: FUTURE, updated_at: new Date().toISOString(), ...fields,
  });
  return { id, profileId };
}

// A meet, a push registration, a nudge record and a block of the person, a block someone else made of
// them, and a meet between two other people.
function addConnections(cluster, profileId) {
  const future = new Date(Date.now() + 15 * 60_000).toISOString();
  cluster.put(INDEX.meets, 'meet-own', { event_id: SLUG, meet_id: 'meet-own', participants: [profileId, 'other1'], requester_id: 'other1', state: 'requested', expires_at: future });
  cluster.put(INDEX.meets, 'meet-other', { event_id: SLUG, meet_id: 'meet-other', participants: ['other4', 'other5'], requester_id: 'other4', state: 'requested', expires_at: future });
  cluster.put(INDEX.push, 'push-own', { event_id: SLUG, profile_id: profileId, platform: 'fcm', expires_at: FUTURE });
  cluster.put(INDEX.nudges, 'nudge-own', { event_id: SLUG, profile_ids: [profileId, 'other1'], receivers: [profileId], expires_at: FUTURE });
  cluster.put(INDEX.blocks, 'block-own', { event_id: SLUG, blocker_id: profileId, blocked_id: 'other1', expires_at: FUTURE });
  cluster.put(INDEX.blocks, 'block-of-them', { event_id: SLUG, blocker_id: 'other2', blocked_id: profileId, expires_at: FUTURE });
}

function dataDir() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'caddie-deleted-talks-'));
  mkdirSync(path.join(tmp, 'raw'), { recursive: true });
  cpSync(path.join(ROOT, 'data/raw/lf-events-upcoming.json'), path.join(tmp, 'raw/lf-events-upcoming.json'));
  cpSync(path.join(ROOT, 'data/raw', SLUG), path.join(tmp, 'raw', SLUG), { recursive: true });
  cpSync(path.join(ROOT, 'data', SLUG), path.join(tmp, SLUG), { recursive: true });
  return tmp;
}

// Runs the ingest for the KubeCon slug against the cluster. Asynchronous, so the loopback server in
// this process can answer it.
async function ingest(cluster, extra = []) {
  const tmp = dataDir();
  const { url, close } = await serve(cluster);
  try {
    const files = () => ['talks.ndjson', 'conference.json'].map((f) => readFileSync(path.join(tmp, SLUG, f), 'utf8'));
    const before = files();
    const child = spawn(process.execPath, ['scripts/ingest.mjs', '--event', SLUG, '--no-fetch', '--skip-topics', ...extra], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, CADDIE_DATA_DIR: tmp, ES_URL: url, ES_API_KEY: INGEST_KEY, ES_PEOPLE_API_KEY: PEOPLE_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 120_000);
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timer);
    const after = files();
    return { status, out, filesChanged: before.some((b, i) => b !== after[i]) };
  } finally {
    await close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isPeople = (e) => e.path.startsWith(`/${INDEX.people}`);
const isWrite = (e) => e.method !== 'GET' && !e.path.endsWith('/_search');

// Every request to a people index carries the people key and is one that key may send: no refresh
// privilege, so no _refresh, refresh=true or _delete_by_query. Everything else carries the ingest key.
function assertKeys(cluster) {
  for (const e of cluster.log) {
    const key = e.headers.authorization;
    if (isPeople(e)) {
      assert.equal(key, `ApiKey ${PEOPLE_KEY}`, `${e.method} ${e.path}`);
      const refresh = !e.params.has('refresh') || e.params.get('refresh') === 'wait_for';
      assert.ok(!e.path.endsWith('/_refresh') && !e.path.includes('_delete_by_query') && refresh, `${e.method} ${e.path}?${e.params}`);
    } else {
      assert.equal(key, `ApiKey ${INGEST_KEY}`, `${e.method} ${e.path}`);
    }
  }
}

test('a deleted talk leaves every profile at the conference; a profile left with neither choice is deleted with its connections', async () => {
  const [s1, s2, s3, unshared] = stale(4);
  const cluster = clusterWith([s1, s2, s3, unshared]);
  const visibleBoth = addProfile(cluster, { open_to_meet: true, shared_talk_ids: [s1, kept[0]] });
  const orphan = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [s1, s2] });
  addConnections(cluster, orphan.profileId);
  const sharerStays = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [s3, kept[0]] });
  const visibleOnly = addProfile(cluster, { open_to_meet: true, shared_talk_ids: [s2] });
  const untouched = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [kept[0], kept[1]] });
  // Another conference whose profile names the same ids: never looked at.
  cluster.put(INDEX.people, 'other-2099:p', { event_id: 'other-2099', profile_id: 'p', open_to_meet: false, shared_talk_ids: [s1], visible_until: FUTURE });
  const untouchedSeq = cluster.docs(INDEX.people).get(untouched.id).seq;

  const r = await ingest(cluster);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /index: 0 new, 0 updated, \d+ unchanged, 4 deleted/);
  assert.match(r.out, /people: 4 profiles stopped sharing for the 4 deleted talks; 1 deleted, left neither open to meet nor sharing\n/);
  for (const id of [s1, s2, s3, unshared]) assert.equal(cluster.source(INDEX.talks, id), null, `${id} is deleted`);

  assert.deepEqual(cluster.source(INDEX.people, visibleBoth.id).shared_talk_ids, [kept[0]]);
  assert.deepEqual(cluster.source(INDEX.people, sharerStays.id).shared_talk_ids, [kept[0]]);
  assert.equal(cluster.source(INDEX.people, sharerStays.id).open_to_meet, false);
  const vo = cluster.source(INDEX.people, visibleOnly.id);
  assert.deepEqual([vo.open_to_meet, vo.shared_talk_ids], [true, []], 'open to meet keeps the profile');
  assert.equal(cluster.docs(INDEX.people).get(untouched.id).seq, untouchedSeq, 'a profile sharing no deleted talk is not written');
  assert.deepEqual(cluster.source(INDEX.people, 'other-2099:p').shared_talk_ids, [s1]);

  assert.equal(cluster.source(INDEX.people, orphan.id), null, 'the orphan profile is deleted');
  assert.deepEqual(cluster.ids(INDEX.meets), ['meet-other']);
  assert.deepEqual(cluster.ids(INDEX.push), []);
  assert.deepEqual(cluster.ids(INDEX.nudges), []);
  assert.deepEqual(cluster.ids(INDEX.blocks), ['block-of-them'], 'blocks others made of the person stay, as in a user delete');
  // The user's own delete: hidden first, guarded by the read before it, the document last.
  const tags = cluster.tags();
  assert.ok(tags.indexOf('hide') >= 0 && tags.indexOf('hide') < tags.indexOf('delete-doc'));
  const [hide] = cluster.calls('hide');
  assert.equal(typeof JSON.parse(hide.body.split('\n')[0]).update.if_seq_no, 'number');
  assertKeys(cluster);
});

test('a talk whose delete failed keeps its sharers, and the run exits 2', async () => {
  const [s1, s2] = stale(2);
  const cluster = clusterWith([s1, s2]);
  // The deletes come last in the plan; the last one fails.
  cluster.fail({ tag: 'bulk', how: 'partial500' });
  const a = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [s1, s2] });
  const r = await ingest(cluster);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /failed delete /);
  assert.equal(cluster.source(INDEX.talks, s1), null);
  assert.ok(cluster.source(INDEX.talks, s2), 'the failed delete left the talk');
  assert.match(r.out, /people: 1 profile stopped sharing for the 1 deleted talk; 0 deleted/);
  assert.deepEqual(cluster.source(INDEX.people, a.id).shared_talk_ids, [s2]);
});

test('the shrink guard refuses one talk over the Worker rule and writes nothing', async () => {
  const ids = stale(REFUSED);
  const cluster = clusterWith(ids);
  const p = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [ids[0]] });
  const r = await ingest(cluster);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, new RegExp(`refused by the shrink guard: the run would delete ${REFUSED} of ${T + REFUSED} talks, more than 10 and more than 10%`));
  assert.match(r.out, /status: unchanged \(refused by the shrink guard\)/);
  assert.match(r.out, /Refused by the shrink guard \(pass --allow-shrink if the schedule really shrank\): kubecon/);
  assert.deepEqual(cluster.log.filter(isWrite).map((e) => `${e.method} ${e.path}`), [], 'no write before or after the guard');
  assert.ok(cluster.log.every((e) => !isPeople(e)), 'people are not read');
  assert.equal(cluster.ids(INDEX.talks).length, T + REFUSED);
  assert.deepEqual(cluster.source(INDEX.people, p.id).shared_talk_ids, [ids[0]]);
  assert.equal(cluster.source(INDEX.conferences, SLUG), null, 'the conference document is not written');
  assert.equal(r.filesChanged, false, 'the talk file and the conference file are left as they were');
});

test('one talk under the rule is not refused, and new talks count in the total as on the Worker', async () => {
  const cluster = clusterWith(stale(ALLOWED));
  const r = await ingest(cluster);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`index: 0 new, 0 updated, \\d+ unchanged, ${ALLOWED} deleted`));
  assert.doesNotMatch(r.out, /shrink guard/);
  assert.equal(cluster.ids(INDEX.talks).length, T);
  assert.equal(cluster.source(INDEX.conferences, SLUG).status, 'searchable');

  // Ten of the feed's talks are new: counted against the stored talks alone (T - 10 + n) the deletes
  // would be refused, but the Worker's total after its upsert is still T + n.
  assert.ok(shrinkRefusal(ALLOWED, T - 10 + ALLOWED));
  const withNew = clusterWith(stale(ALLOWED), { fresh: 10 });
  const n = await ingest(withNew);
  assert.equal(n.status, 0, n.out);
  assert.match(n.out, new RegExp(`index: 10 new, 0 updated, \\d+ unchanged, ${ALLOWED} deleted`));
  assert.doesNotMatch(n.out, /shrink guard/);
  assert.equal(withNew.ids(INDEX.talks).length, T);
});

test('--allow-shrink lets the refused run through, and the people cleanup runs', async () => {
  const ids = stale(REFUSED);
  const cluster = clusterWith(ids);
  const p = addProfile(cluster, { open_to_meet: false, shared_talk_ids: [ids[0]] });
  const r = await ingest(cluster, ['--allow-shrink']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`shrink guard: the run would delete ${REFUSED} of ${T + REFUSED} talks, more than 10 and more than 10%; allowed by --allow-shrink`));
  assert.equal(cluster.ids(INDEX.talks).length, T);
  assert.equal(cluster.source(INDEX.people, p.id), null);
  assertKeys(cluster);
});

test('a dry run reports what the guard would refuse, exits 2 and writes nothing to Elasticsearch', async () => {
  const cluster = clusterWith(stale(REFUSED));
  const r = await ingest(cluster, ['--dry-run']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, new RegExp(`would index: 0 new, 0 updated, \\d+ unchanged, ${REFUSED} deleted`));
  assert.match(r.out, new RegExp(`shrink guard: the run would delete ${REFUSED} of ${T + REFUSED} talks, more than 10 and more than 10%\\. A run without --dry-run would refuse this conference`));
  assert.match(r.out, /Would be refused by the shrink guard/);
  assert.deepEqual(cluster.log.filter(isWrite).map((e) => `${e.method} ${e.path}`), []);

  const fine = await ingest(clusterWith(stale(ALLOWED)), ['--dry-run']);
  assert.equal(fine.status, 0, fine.out);
  assert.doesNotMatch(fine.out, /shrink guard/);
});
