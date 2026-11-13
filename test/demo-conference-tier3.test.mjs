// The demo conference on tier 3, end to end: scripts/ingest.mjs --event <demo slug> indexes the
// generated conference into Elasticsearch (the in-memory stand-in of test/helpers/fake-es.mjs, served
// on loopback for the child process), and the server's GET /api/conferences (server/conferences.mjs)
// then lists it as searchable with demo: true, in the contract's shape. The next day's run moves the
// times of the same talks: no talk is re-indexed with its text, none is deleted, the shrink guard is
// never involved and no people index is touched. A hidden demo is left out of the list. The scheduled
// refresh (--refresh-only) refreshes a demo the backend holds, and never brings back one an operator
// hid or removed there, or creates one it does not hold.
//
// Run with `npm test`. No network: the child talks to a loopback server, and the server modules use
// the stubbed fetch of the stand-in. The tracked data is never touched (CADDIE_DATA_DIR).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeES, serve, useCluster, INDEX, FUTURE } from './helpers/fake-es.mjs';
import { buildDemo, DEFAULT_DEMO_CONFIG } from '../scripts/lib/demo-conference.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import { formatErrors } from '../contracts/js/validate.mjs';

const { publicConferences, searchableConference } = await import('../server/conferences.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = DEFAULT_DEMO_CONFIG.slug;
const ON = { ...DEFAULT_DEMO_CONFIG, enabled: true };
const KEY = 'test-demo-ingest-key';

const tmp = mkdtempSync(path.join(tmpdir(), 'caddie-demo-tier3-'));
const configFile = path.join(tmp, 'demo.json');
writeFileSync(configFile, JSON.stringify(ON));
const cluster = useCluster(new FakeES());
// Another conference's talk and a hidden demo-like conference, which must stay as they are.
cluster.put(INDEX.talks, 'otherconf-2099:1', { talk_id: 'otherconf-2099:1', conference: 'otherconf-2099', kind: 'talk', title: 'Other', content_hash: 'c', text_hash: 't' });
cluster.put(INDEX.conferences, 'otherconf-2099', { slug: 'otherconf-2099', name: 'Other Conference', status: 'unavailable', status_reason: 'no_schedule_url', start_date: '2099-01-01', end_date: '2099-01-02', source: 'sessionize' });
cluster.put(INDEX.conferences, 'old-demo-conference', { slug: 'old-demo-conference', name: 'Old Demo Conference', status: 'unavailable', status_reason: 'operator_hidden', demo: true, source: 'demo', start_date: '2099-01-01', end_date: '2099-01-03' });

async function ingest(today, extra = []) {
  const { url, close } = await serve(cluster);
  try {
    const child = spawn(process.execPath, ['scripts/ingest.mjs', '--event', SLUG, '--skip-topics', ...extra], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, CADDIE_DATA_DIR: path.join(tmp, 'data'), CADDIE_DEMO_CONFIG: configFile, CADDIE_DEMO_TODAY: today, ES_URL: url, ES_API_KEY: KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, out };
  } finally {
    await close();
  }
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('switched on, the ingest indexes the demo and the tier 3 server lists it as searchable with demo: true', async () => {
  const r = await ingest('2026-11-12');
  assert.equal(r.status, 0, r.out);
  const expected = buildDemo(ON, '2026-11-12');
  const stored = cluster.ids(INDEX.talks).filter((id) => id.startsWith(`${SLUG}:`));
  assert.equal(stored.length, expected.docs.length);
  const conf = cluster.source(INDEX.conferences, SLUG);
  assert.equal(conf.status, 'searchable');
  assert.equal(conf.demo, true);
  assert.equal(conf.start_date, '2026-11-11');

  const list = await publicConferences();
  const demo = list.find((c) => c.slug === SLUG);
  assert.ok(demo, 'the demo is listed');
  assert.equal(demo.status, 'searchable');
  assert.equal(demo.demo, true);
  assert.equal(demo.source, 'demo');
  assert.equal(demo.talk_count, expected.counts.talk);
  const check = validator('conferences-index.v1', 'Conference');
  for (const c of list) {
    const v = check(c, { closed: true });
    assert.equal(v.valid, true, formatErrors(v.errors));
  }
  assert.ok(!list.some((c) => c.slug === 'old-demo-conference'), 'a hidden demo is left out of the list');
  assert.ok(list.some((c) => c.slug === 'otherconf-2099' && !('demo' in c)), 'a real unavailable conference stays listed, with no demo key');
  assert.ok(await searchableConference(SLUG));
});

test('the next day moves the times in place: nothing re-embedded or deleted, no people index touched', async () => {
  const before = new Map(cluster.ids(INDEX.talks).map((id) => [id, structuredClone(cluster.source(INDEX.talks, id))]));
  cluster.put(INDEX.people, `${SLUG}:sharer`, { event_id: SLUG, profile_id: 'sharer', open_to_meet: false, shared_talk_ids: [`${SLUG}:d1-a10`], visible_until: FUTURE });
  const peopleBefore = structuredClone(cluster.source(INDEX.people, `${SLUG}:sharer`));
  const mark = cluster.log.length;
  const r = await ingest('2026-11-13');
  assert.equal(r.status, 0, r.out);
  const expected = buildDemo(ON, '2026-11-13');
  assert.match(r.out, new RegExp(`index: 0 new, ${expected.docs.length} updated, 0 unchanged, 0 deleted`));
  assert.match(r.out, /bulk ops: 0 index \(model calls\), \d+ update \(no model call\), 0 delete/);
  assert.doesNotMatch(r.out, /shrink guard|people:/);
  const calls = cluster.log.slice(mark);
  assert.ok(!calls.some((e) => e.path.startsWith(`/${INDEX.people}`)), 'no people index is read or written');
  const bulk = calls.filter((e) => e.path === '/_bulk').map((e) => e.body).join('\n');
  assert.doesNotMatch(bulk, /"delete"/);
  assert.doesNotMatch(bulk, /"index"/);
  for (const d of expected.docs) {
    const now = cluster.source(INDEX.talks, d.talk_id);
    assert.equal(now.start, d.start, d.talk_id);
    assert.equal(now.title, before.get(d.talk_id).title);
  }
  assert.deepEqual(cluster.source(INDEX.talks, 'otherconf-2099:1'), before.get('otherconf-2099:1'));
  assert.deepEqual(cluster.source(INDEX.people, `${SLUG}:sharer`), peopleBefore, 'a share for a demo talk is untouched');
  assert.equal(cluster.source(INDEX.conferences, SLUG).end_date, '2026-11-14');
});

test('--refresh-only refreshes the demo the backend holds, and never brings back a hidden or removed one', async () => {
  const fresh = await ingest('2026-11-14', ['--refresh-only']);
  assert.equal(fresh.status, 0, fresh.out);
  assert.equal(cluster.source(INDEX.conferences, SLUG).end_date, '2026-11-15', 'a held, searchable demo is refreshed');

  // Hidden on the backend (caddie-admin conferences hide) before the operator file reached main.
  cluster.patch(INDEX.conferences, SLUG, { status: 'unavailable', status_reason: 'operator_hidden' });
  const hidden = await ingest('2026-11-15', ['--refresh-only']);
  assert.equal(hidden.status, 0, hidden.out);
  assert.match(hidden.out, /skipped \(--refresh-only\): the backend holds it as unavailable \(operator_hidden\)/);
  assert.equal(cluster.source(INDEX.conferences, SLUG).status, 'unavailable');
  assert.equal(cluster.source(INDEX.conferences, SLUG).end_date, '2026-11-15', 'nothing was written');

  // Removed on the backend (caddie-admin conferences remove): the documents are gone.
  for (const id of cluster.ids(INDEX.talks).filter((x) => x.startsWith(`${SLUG}:`))) cluster.docs(INDEX.talks).delete(id);
  cluster.docs(INDEX.conferences).delete(SLUG);
  const removed = await ingest('2026-11-15', ['--refresh-only']);
  assert.equal(removed.status, 0, removed.out);
  assert.match(removed.out, /skipped \(--refresh-only\): caddie-conferences does not hold it; add it first/);
  assert.equal(cluster.source(INDEX.conferences, SLUG), null);
  assert.equal(cluster.ids(INDEX.talks).filter((x) => x.startsWith(`${SLUG}:`)).length, 0, 'no talk is created');
});
