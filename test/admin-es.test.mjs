// The tier 3 adapter of the caddie-admin CLI (scripts/admin/backends/es.mjs and the conference
// file layer in scripts/admin/commands/conferences.mjs), driven in-process through main() against
// the in-memory stand-in for Elasticsearch (test/helpers/fake-es.mjs) served over loopback HTTP.
//
// Run with `npm test`. Nothing here reaches the network: the CLI's fetch is the real one but every
// backend address is a loopback server answering from memory; the server routes used for the
// parity check go through the stubbed fetch to the same stand-in; child processes are recorded by
// an injected spawn and never started. The config dir and the repository root are fresh temp dirs
// per test, and the key is a dummy string that every run checks is absent from stdout, stderr, the
// audit file, every request URL and body, and every child argument list, and present only in the
// Authorization: ApiKey header of the Elasticsearch requests.
//
// The tests check
// - SEC-1: the tier 3 server dispatches no /admin path;
// - ATT-1 to ATT-5, ATT-8 to ATT-10: search, view with the privacy rule, delete with the same
//   calls as the server's DELETE /api/people/profile, block and unblock;
// - MOD-1 to MOD-6: the queue (and the deprecated scripts/moderation.mjs shell), hide, unhide,
//   delete, purge-reports, purge-expired and rules through recorded child processes;
// - CONF-1, CONF-2, CONF-4, CONF-6, CONF-8, CONF-11, CONF-12: list, add, hide, unhide, remove,
//   unretire, the operator file, and the untouched time-zone overrides file;
// - STAT-1 to STAT-3: counts, usage and health, with the smoke and log commands naming variables.

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real fetch, before the stand-in replaces the global one for the server modules.
const realFetch = globalThis.fetch;
const {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, refOf, personId, addPerson, addConnections, request, quietly, serve,
} = await import('./helpers/fake-es.mjs');
const people = await import('../server/people.mjs');
const { main } = await import('../scripts/admin/cli.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'dummy-es-admin-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const OTHER = 'otherconf-2099';
const NOTE = 'fixture-note-text-that-must-not-travel';
const LINE = 'fixture rules test line that must not be logged';
const PAST_CONF = 'pastconf-2020';
const execFileAsync = promisify(execFile);

before(() => bootPurgeDone());

let home;
let root;
let cluster;
let served;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'caddie-admin-es-home-'));
  root = mkdtempSync(join(tmpdir(), 'caddie-admin-es-root-'));
  cluster = new FakeES();
  served = await serve(cluster);
  writeConfig({ default: 't3', backends: { t3: { tier: 3, es_url: served.url } } });
});
afterEach(async () => {
  await served.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(config) {
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

function auditLines() {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Runs main() with the real adapter factory against the served cluster. `spawn` records child
// processes instead of starting them.
async function invoke(argv, { spawnResult, env = {}, sleep = async () => {} } = {}) {
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { status: 0, stdout: '', stderr: '', ...(typeof spawnResult === 'function' ? spawnResult(args) : spawnResult ?? {}) };
  };
  const out = sink();
  const err = sink();
  const before = cluster.log.length;
  const code = await main(argv, {
    env: { CADDIE_ADMIN_HOME: home, CADDIE_ADMIN_ROOT: root, ELASTISEARCH_API_KEY: KEY, ...env },
    stdout: out,
    stderr: err,
    stdin: { isTTY: false },
    isTTY: false,
    now: () => new Date('2026-11-11T10:00:00Z'),
    spawn,
    fetch: realFetch,
    sleep,
  });
  const stdout = out.text();
  const stderr = err.text();
  const auditText = existsSync(join(home, 'audit.jsonl')) ? readFileSync(join(home, 'audit.jsonl'), 'utf8') : '';
  for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['audit', auditText]]) {
    assert.ok(!text.includes(KEY), `the key leaked into ${where}`);
  }
  const requests = cluster.log.slice(before);
  for (const entry of requests) {
    const { headers, ...rest } = entry;
    assert.ok(!JSON.stringify(rest).includes(KEY), `the key leaked into a request to ${entry.path}`);
    assert.equal(headers?.authorization, `ApiKey ${KEY}`, `the key arrives only as Authorization: ApiKey (${entry.path})`);
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name !== 'authorization') assert.ok(!String(value).includes(KEY), `the key leaked into the ${name} header`);
    }
  }
  for (const child of spawned) {
    assert.ok(!JSON.stringify([child.file, child.args]).includes(KEY), 'the key leaked into a child argument list');
  }
  return { code, stdout, stderr, audit: auditLines(), requests, spawned, json: () => JSON.parse(stdout) };
}

const confirmed = (argv, target) => [...argv, '--yes', '--confirm', target];

// ---- seed helpers ----

function person(name, fields = {}) {
  const device = newDevice();
  addPerson(cluster, device, { display_name: name, ...fields });
  return { device, ref: refOf(device.profileId), profileId: device.profileId, id: personId(device.profileId) };
}

function report(kind, targetRef, targetProfileId, reporter, reason = 'spam', event = EVENT, createdAt = '2026-11-10T09:00:00.000Z') {
  cluster.put(INDEX.reports, `${kind}:${targetRef}:${reporter}:${event}`, {
    event_id: event, target_kind: kind, target_id: targetRef, target_profile_id: targetProfileId, reporter_id: reporter, reason, created_at: createdAt,
  });
}

function seedConferenceFiles(slug, { talks = true, raw = true, status = 'searchable', statusReason = status === 'searchable' ? null : 'fetch_failed' } = {}) {
  mkdirSync(join(root, 'data', slug), { recursive: true });
  writeFileSync(join(root, 'data', slug, 'conference.json'), `${JSON.stringify({ slug, name: `Conference ${slug}`, status, status_reason: statusReason, start_date: '2099-12-01', end_date: '2099-12-03', raw_fetched_at: '2026-11-01T00:00:00.000Z', counts: { talk: 2 } }, null, 2)}\n`);
  if (talks) writeFileSync(join(root, 'data', slug, 'talks.ndjson'), '{"talk_id":"a"}\n{"talk_id":"b"}\n');
  if (raw) {
    mkdirSync(join(root, 'data', 'raw', slug), { recursive: true });
    writeFileSync(join(root, 'data', 'raw', slug, 'lf-event.json'), '{}\n');
  }
  mkdirSync(join(root, 'data'), { recursive: true });
  copyFileSync(join(ROOT, 'data', 'conference-overrides.json'), join(root, 'data', 'conference-overrides.json'));
  writeFileSync(join(root, 'data', 'conference-operator.json'), '{\n  "hidden": {},\n  "removed": {}\n}\n');
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const operatorFile = () => readJson(join(root, 'data', 'conference-operator.json'));
const overridesMtime = () => statSync(join(root, 'data', 'conference-overrides.json')).mtimeMs;

// ---------------------------------------------------------------------------------------------

describe('SEC-1 no admin route on tier 3', () => {
  test('server/index.mjs dispatches no path under /admin', () => {
    const src = readFileSync(join(ROOT, 'server', 'index.mjs'), 'utf8');
    assert.ok(!/['"`]\/admin/.test(src), 'no /admin path literal');
    const grep = spawnSync('git', ['grep', '-n', '--no-index', '/admin', '--', 'server/'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(grep.stdout.trim(), '', grep.stdout);
  });
});

describe('ATT-1, ATT-2 attendees search', () => {
  test('--name matches a case-insensitive substring, excludes hidden people unless asked, prints only the listed fields', async () => {
    const ann = person('Ann Lee');
    person('Bob Stone');
    const hidden = person('ANNA HIDDEN', { hidden: true });
    const r = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'ann', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const { result } = r.json();
    assert.deepEqual(result.items.map((i) => i.ref), [ann.ref]);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['display_name', 'hidden', 'open_to_meet', 'ref', 'sample', 'spot_hidden', 'visible_until']);
    assert.equal(result.counts.matched, 1);
    const all = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'ann', '--include-hidden', '--json']);
    assert.deepEqual(all.json().result.items.map((i) => i.ref).sort(), [ann.ref, hidden.ref].sort());
    assert.ok(!all.stdout.includes(ann.profileId) && !all.stdout.includes(hidden.profileId), 'no profile_id');
    const typed = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'nN lEe']);
    assert.match(typed.stdout, /display_name=Ann Lee/);
    assert.ok(!JSON.stringify(typed.audit).includes('nN lEe') && !JSON.stringify(typed.audit).includes('Ann Lee'), 'the search text and the names are not audited');
    const human = await invoke(['attendees', 'search', '--event', EVENT, '--name', 'Lee', '--limit', '1']);
    assert.match(human.stdout, /^ref=[0-9a-f]{16} display_name=Ann Lee hidden=false spot_hidden=false open_to_meet=true sample=false visible_until=2099/);
    assert.match(human.stdout, /1 attendee matched at testconf-2099/);
  });

  test('--ref finds exactly that person, or exits 4', async () => {
    const ann = person('Ann Lee');
    person('Bob Stone');
    const r = await invoke(['attendees', 'search', '--event', EVENT, '--ref', ann.ref, '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json().result.items.map((i) => i.display_name), ['Ann Lee']);
    const missing = await invoke(['attendees', 'search', '--event', EVENT, '--ref', '0123456789abcdef']);
    assert.equal(missing.code, 4);
    assert.equal(missing.audit.at(-1).result, 'not_found');
  });
});

describe('ATT-3, ATT-4 attendees view', () => {
  // The same position sentinels as in test/admin-worker.test.mjs, which no ISO time can hold: it has
  // a "." only after its seconds (00 to 59). This file pins the CLI's clock, so the
  // earlier 51.5 never met one here, but the check should not depend on that.
  const SENTINELS = {
    profile_id: 'SENTINEL-PROFILE-ID', secret_hash: 'SENTINEL-SECRET-HASH', presence_location: { lat: 78.5, lon: -100.5 }, presence_cell: 'SENTINEL-CELL',
    ble_token: 'SENTINEL-BLE-TOKEN', presence_nonce: 'SENTINEL-NONCE', ble_master_id: 'SENTINEL-MASTER', about_semantic: 'SENTINEL-EMBEDDING',
    about: 'SENTINEL-ABOUT', interests: 'SENTINEL-INTERESTS', expertise: 'SENTINEL-EXPERTISE', contact_note: 'SENTINEL-CONTACT-NOTE', presence_spot: 'SENTINEL-SPOT',
    pending_about: 'SENTINEL-PENDING', linkedin_url: 'https://www.linkedin.com/in/SENTINEL-LINKEDIN',
  };
  const TEXT = ['SENTINEL-ABOUT', 'SENTINEL-INTERESTS', 'SENTINEL-EXPERTISE', 'SENTINEL-CONTACT-NOTE', 'SENTINEL-SPOT', 'SENTINEL-PENDING'];
  const CONTACT = ['SENTINEL-LINKEDIN'];
  const NEVER = ['SENTINEL-PROFILE-ID', 'SENTINEL-SECRET-HASH', '78.5', '100.5', 'SENTINEL-CELL', 'SENTINEL-BLE-TOKEN', 'SENTINEL-NONCE', 'SENTINEL-MASTER', 'SENTINEL-EMBEDDING', 'SENTINEL-REPORTER', 'SENTINEL-ENDPOINT', 'SENTINEL-PUSH-TOKEN'];

  function seedViewed() {
    const device = newDevice();
    const profileId = SENTINELS.profile_id;
    cluster.put(INDEX.people, personId(profileId), {
      event_id: EVENT, ref: refOf(profileId), display_name: 'Viewed Person', open_to_meet: true, shared_talk_ids: [`${EVENT}:t1`, `${EVENT}:t2`], visible_until: FUTURE,
      updated_at: '2026-11-10T08:00:00.000Z', presence_until: FUTURE, hidden: false, spot_hidden: true, sample: false, ...SENTINELS,
    });
    cluster.put(INDEX.meets, 'm1', { event_id: EVENT, meet_id: 'm1', participants: [profileId, 'o1'], state: 'requested' });
    cluster.put(INDEX.meets, 'm2', { event_id: EVENT, meet_id: 'm2', participants: [profileId, 'o2'], state: 'accepted' });
    cluster.put(INDEX.meets, 'm3', { event_id: EVENT, meet_id: 'm3', participants: ['o3', 'o4'], state: 'accepted' });
    cluster.put(INDEX.blocks, 'b1', { event_id: EVENT, blocker_id: profileId, blocked_id: 'o1' });
    cluster.put(INDEX.blocks, 'b2', { event_id: EVENT, blocker_id: 'o5', blocked_id: profileId });
    cluster.put(INDEX.blocks, 'b3', { event_id: EVENT, blocker_id: 'o6', blocked_id: profileId });
    cluster.put(INDEX.push, 'p1', { event_id: EVENT, profile_id: profileId, endpoint: 'https://push.example/SENTINEL-ENDPOINT' });
    cluster.put(INDEX.push, 'p2', { event_id: EVENT, profile_id: profileId, platform: 'apns', token: 'SENTINEL-PUSH-TOKEN' });
    report('profile', refOf(profileId), profileId, 'SENTINEL-REPORTER-1', 'spam');
    report('spot', refOf(profileId), profileId, 'SENTINEL-REPORTER-2', 'harassment');
    return { device, ref: refOf(profileId) };
  }

  for (const json of [false, true]) {
    test(`default fields only, --text and --contact add theirs, forbidden fields never (${json ? '--json' : 'human'})`, async () => {
      const { ref } = seedViewed();
      const flag = json ? ['--json'] : [];
      const base = await invoke(['attendees', 'view', '--event', EVENT, ref, ...flag]);
      assert.equal(base.code, 0, base.stderr);
      for (const s of [...NEVER, ...TEXT, ...CONTACT]) assert.ok(!base.stdout.includes(s), `${s} in the default view`);
      assert.match(base.stdout, /Viewed Person/);
      assert.match(base.stdout, /spot_hidden=true|"spot_hidden":true/);
      assert.match(base.stdout, /presence=on|"presence":"on"/);
      assert.match(base.stdout, /shared_talks=2|"shared_talks":2/);
      assert.match(base.stdout, /"requested":1|requested":1/);
      assert.match(base.stdout, /blocks_made=1|"blocks_made":1/);
      assert.match(base.stdout, /blocks_received=2|"blocks_received":2/);
      assert.match(base.stdout, /"web":1/);
      assert.match(base.stdout, /"apns":1/);
      assert.match(base.stdout, /"profile":1/);
      assert.match(base.stdout, /"spot":1/);
      assert.match(base.stdout, /"spam":1/);

      const text = await invoke(['attendees', 'view', '--event', EVENT, ref, '--text', ...flag]);
      for (const s of TEXT) assert.ok(text.stdout.includes(s), `${s} under --text`);
      for (const s of [...NEVER, ...CONTACT]) assert.ok(!text.stdout.includes(s), `${s} under --text`);

      const contact = await invoke(['attendees', 'view', '--event', EVENT, ref, '--contact', ...flag]);
      for (const s of CONTACT) assert.ok(contact.stdout.includes(s), `${s} under --contact`);
      for (const s of [...NEVER, ...TEXT]) assert.ok(!contact.stdout.includes(s), `${s} under --contact`);

      const both = await invoke(['attendees', 'view', '--event', EVENT, ref, '--text', '--contact', ...flag]);
      for (const s of NEVER) assert.ok(!both.stdout.includes(s), `${s} under both`);
      if (json) assert.equal(both.stdout.trim().split('\n').length, 1);

      // ATT-4: the audit names the flags and the ref, nothing else from the profile.
      const entries = auditLines();
      assert.deepEqual(entries.map((e) => e.flags), [[], ['text'], ['contact'], ['text', 'contact']]);
      assert.deepEqual(entries.at(-1).target, ref);
      for (const s of [...NEVER, ...TEXT, ...CONTACT, 'Viewed Person']) assert.ok(!JSON.stringify(entries).includes(s), `${s} in the audit`);
    });
  }

  test('an unknown ref exits 4', async () => {
    assert.equal((await invoke(['attendees', 'view', '--event', EVENT, '0123456789abcdef'])).code, 4);
  });
});

describe('ATT-5, ATT-10, MOD-3 attendees delete', () => {
  // The same person and connections in two clusters: the server deletes in one through its route,
  // the CLI in the other through the served stand-in, and both make the same requests.
  const serialize = (e) => JSON.stringify([e.tag, e.method, e.path, e.params.toString(), e.body ?? null]);
  const THREE = ['meets', 'push', 'nudges'];
  function assertOrder(tags) {
    assert.deepEqual(tags[0], 'hide');
    const docAt = tags.indexOf('delete-doc');
    assert.ok(docAt > 0, 'the document is deleted');
    const first = tags.slice(1, docAt);
    assert.equal(first.length, 8, `first pass: ${first.join(', ')}`);
    for (const name of THREE) assert.ok(first.indexOf(`search:${name}`) < first.indexOf(`bulk:${name}`), `${name} searched before its bulk delete`);
    assert.deepEqual(first.slice(6), ['search:blocks', 'bulk:blocks'], 'the blocks go after meets, push and nudges');
    const second = tags.slice(docAt + 1);
    assert.deepEqual(new Set(second.slice(0, 3)), new Set(THREE.map((n) => `search:${n}`)));
    assert.deepEqual(second.slice(3), ['search:blocks']);
  }

  test('the CLI delete makes the same Elasticsearch calls as DELETE /api/people/profile', async () => {
    const device = newDevice();
    const serverCluster = useCluster(new FakeES());
    addPerson(serverCluster, device);
    const serverIds = addConnections(serverCluster, device.profileId);
    const { result } = await quietly(() => request(people.handlePeopleApi, 'DELETE', `/api/people/profile?event=${EVENT}`, device));
    assert.equal(result.status, 200);
    const serverCalls = serverCluster.log.slice(serverCluster.tags().indexOf('hide'));

    addPerson(cluster, device);
    const cliIds = addConnections(cluster, device.profileId);
    const ref = refOf(device.profileId);
    const r = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, ref, '--reason', 'spam', '--note', NOTE], ref));
    assert.equal(r.code, 0, r.stderr);
    const cliCalls = r.requests.slice(r.requests.findIndex((e) => e.tag === 'hide'));
    assertOrder(cliCalls.map((e) => e.tag));
    assert.deepEqual(cliCalls.map(serialize).sort(), serverCalls.map(serialize).sort(), 'the same requests, byte for byte');
    assert.equal(cliCalls.length, serverCalls.length);

    for (const [c, ids] of [[serverCluster, serverIds], [cluster, cliIds]]) {
      assert.equal(c.source(INDEX.people, personId(device.profileId)), null);
      for (const meet of ids.meets) assert.equal(c.source(INDEX.meets, meet), null);
      assert.equal(c.ids(INDEX.push).length, 0);
      assert.equal(c.ids(INDEX.nudges).length, 0);
      for (const block of ids.ownBlocks) assert.equal(c.source(INDEX.blocks, block), null);
      assert.ok(c.source(INDEX.blocks, ids.blockedBy), 'a block someone else made is kept');
      assert.ok(c.source(INDEX.meets, ids.unrelatedMeet));
      assert.ok(c.source(INDEX.blocks, ids.unrelatedBlock));
    }
    const entry = r.audit.at(-1);
    assert.equal(entry.mode, 'run');
    assert.equal(entry.result, 'ok');
    assert.equal(entry.reason, 'spam');
    assert.deepEqual(entry.counts, { profile: 1, meets: 2, push: 1, nudges: 1, blocks: 2 });
    assert.ok(!JSON.stringify(r.audit).includes(NOTE) && !r.stdout.includes(NOTE));
    assert.ok(!r.stdout.includes(device.profileId) && !r.stdout.includes('Test person'));
  });

  test('the dry-run prints counts per index, no name, and deletes nothing', async () => {
    const device = newDevice();
    addPerson(cluster, device);
    addConnections(cluster, device.profileId);
    const ref = refOf(device.profileId);
    const r = await invoke(['attendees', 'delete', '--event', EVENT, ref]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /profile 1, meets 2, push 1, nudges 1, blocks 2/);
    assert.match(r.stdout, /dry-run, nothing changed/);
    assert.ok(!r.stdout.includes('Test person') && !r.stdout.includes(device.profileId));
    assert.ok(cluster.source(INDEX.people, personId(device.profileId)), 'the profile is still there');
    assert.equal(cluster.ids(INDEX.meets).length, 3);
    assert.ok(!r.requests.some((e) => e.method === 'DELETE' || e.tag.startsWith('bulk') || e.tag === 'hide'));
    assert.equal(r.audit.at(-1).mode, 'dry-run');
  });

  test('a failed second pass still deletes, but warns on stderr, counts the warning and exits 1', async () => {
    const device = newDevice();
    addPerson(cluster, device);
    const ids = addConnections(cluster, device.profileId);
    cluster.fail({ tag: 'search:meets', nth: 2, how: 503 });
    const ref = refOf(device.profileId);
    const r = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, ref], ref));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^caddie-admin: warning: Deleting a deleted profile's connections again failed: POST .* failed with status 503; the hourly purge/m);
    assert.match(r.stdout, /\(with warnings\)/);
    assert.equal(cluster.source(INDEX.people, personId(device.profileId)), null, 'the profile is gone');
    for (const meet of ids.meets) assert.equal(cluster.source(INDEX.meets, meet), null);
    const entry = r.audit.at(-1);
    assert.equal(entry.result, 'warned');
    assert.equal(entry.counts.warnings, 1);
    const json = await invoke(confirmed(['attendees', 'delete', '--event', EVENT, ref], ref));
    assert.equal(json.code, 4, 'gone now');
  });

  test('moderation delete profile:<ref> runs the full delete, not the document-only one', async () => {
    const device = newDevice();
    addPerson(cluster, device);
    const ids = addConnections(cluster, device.profileId);
    const ref = refOf(device.profileId);
    const r = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `profile:${ref}`], `profile:${ref}`));
    assert.equal(r.code, 0, r.stderr);
    const tags = r.requests.map((e) => e.tag);
    assert.ok(tags.includes('hide') && tags.includes('bulk:meets') && tags.includes('delete-doc'));
    for (const meet of ids.meets) assert.equal(cluster.source(INDEX.meets, meet), null);
    assert.ok(cluster.source(INDEX.blocks, ids.blockedBy));
  });
});

describe('ATT-8, ATT-9 block and unblock', () => {
  test('block writes the operator report, hides, and the hide survives a rewrite by the owner', async () => {
    const p = person('Blocked Person');
    const r = await invoke(confirmed(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'harassment', '--note', NOTE], p.ref));
    assert.equal(r.code, 0, r.stderr);
    const doc = cluster.source(INDEX.reports, `profile:${p.ref}:operator`);
    assert.ok(doc, 'the operator report exists');
    assert.equal(doc.reporter_id, 'operator');
    assert.equal(doc.reason, 'operator');
    assert.equal(doc.target_kind, 'profile');
    assert.equal(doc.target_id, p.ref);
    assert.equal(doc.target_profile_id, p.profileId);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, true);
    assert.ok(!r.stdout.includes(p.profileId) && !JSON.stringify(r.audit).includes(p.profileId), 'profile_id is never printed or logged');
    assert.ok(!r.stdout.includes(NOTE) && !JSON.stringify(r.audit).includes(NOTE));
    assert.equal(r.audit.at(-1).reason, 'harassment');
    const create = r.requests.find((e) => e.path.includes('/_create/'));
    assert.ok(create, 'written with op_type create');
    assert.deepEqual(r.audit.at(-1).counts, { reports: 1 });
    // Blocking again is harmless (409 on the create), keeps it hidden, and counts no second report.
    const again = await invoke(confirmed(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'spam'], p.ref));
    assert.equal(again.code, 0);
    assert.deepEqual(again.audit.at(-1).counts, { reports: 1 });
    assert.equal(cluster.ids(INDEX.reports).length, 1);

    // The owner rewrites the profile fully through the server against the same data: still hidden.
    useCluster(cluster);
    const put = await quietly(() => request(people.handlePeopleApi, 'PUT', '/api/people/profile', p.device, {
      event: EVENT, profile: { display_name: 'Blocked Person', about: 'a full reindex' }, open_to_meet: true, shared_talk_ids: [],
    }));
    assert.equal(put.result.status, 200);
    assert.equal(put.result.body.hidden_for_owner, true);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, true);
  });

  test('the block dry-run writes nothing', async () => {
    const p = person('Blocked Person');
    const r = await invoke(['attendees', 'block', '--event', EVENT, p.ref, '--reason', 'spam']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cluster.source(INDEX.reports, `profile:${p.ref}:operator`), null);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, undefined);
  });

  test('unblock removes only the operator report and keeps hidden when two others remain', async () => {
    const p = person('Blocked Person', { hidden: true });
    report('profile', p.ref, p.profileId, 'reporter-a');
    report('profile', p.ref, p.profileId, 'reporter-b');
    cluster.put(INDEX.reports, `profile:${p.ref}:operator`, { event_id: EVENT, target_kind: 'profile', target_id: p.ref, target_profile_id: p.profileId, reporter_id: 'operator', reason: 'operator', created_at: '2026-11-10T09:00:00.000Z' });
    const r = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cluster.source(INDEX.reports, `profile:${p.ref}:operator`), null);
    assert.equal(cluster.ids(INDEX.reports).length, 2);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, true);
    assert.match(r.stdout, /2 other reports remain, so it stays hidden/);
  });

  test('unblock makes the profile visible when fewer than two other reporters remain', async () => {
    const p = person('Blocked Person', { hidden: true });
    report('profile', p.ref, p.profileId, 'reporter-a');
    cluster.put(INDEX.reports, `profile:${p.ref}:operator`, { event_id: EVENT, target_kind: 'profile', target_id: p.ref, target_profile_id: p.profileId, reporter_id: 'operator', reason: 'operator', created_at: '2026-11-10T09:00:00.000Z' });
    const r = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, false);
    assert.equal(cluster.ids(INDEX.reports).length, 1);
    const none = await invoke(confirmed(['attendees', 'unblock', '--event', EVENT, p.ref], p.ref));
    assert.equal(none.code, 4);
  });
});

describe('MOD-1, MOD-2, MOD-4 moderation queue, hide, unhide, purge-reports', () => {
  function seedModeration() {
    const h = person('Hidden Harry', { hidden: true });
    const s = person('Spot Sally', { spot_hidden: true, presence_spot: null });
    const v = person('Visible Vic');
    report('profile', h.ref, h.profileId, 'r1', 'spam');
    report('profile', h.ref, h.profileId, 'r2', 'hate');
    report('spot', s.ref, s.profileId, 'r3', 'sexual');
    cluster.put(INDEX.meets, 'AbCdEfGhIjKlMnOpQrSt_-', { event_id: EVENT, meet_id: 'AbCdEfGhIjKlMnOpQrSt_-', participants: [h.profileId, v.profileId], state: 'accepted', hidden: true, hidden_owner_id: h.profileId, created_at: '2026-11-10T09:00:00.000Z' });
    report('meet', 'AbCdEfGhIjKlMnOpQrSt_-', h.profileId, 'r4', 'harassment');
    report('meet', 'AbCdEfGhIjKlMnOpQrSt_-', h.profileId, 'r5', 'harassment');
    return { h, s, v };
  }

  test('queue lists hidden targets with counts, names and reasons only with --show-content, and reports since an instant', async () => {
    const { h, s } = seedModeration();
    const plain = await invoke(['moderation', 'queue', '--event', EVENT, '--json']);
    assert.equal(plain.code, 0, plain.stderr);
    const items = plain.json().result.items;
    assert.deepEqual(items.map((i) => [i.list, i.kind, i.id, i.reports]), [['hidden', 'profile', h.ref, 2], ['hidden', 'spot', s.ref, 1], ['hidden', 'meet', 'AbCdEfGhIjKlMnOpQrSt_-', 2]]);
    for (const s of ['Hidden Harry', 'Spot Sally', 'Visible Vic', 'spam', 'hate', 'sexual', 'r1', h.profileId]) assert.ok(!plain.stdout.includes(s), `${s} without --show-content`);
    const shown = await invoke(['moderation', 'queue', '--event', EVENT, '--show-content', '--since', '2026-11-10T00:00:00Z', '--json']);
    const { result } = shown.json();
    assert.equal(result.items.filter((i) => i.list === 'hidden')[0].display_name, 'Hidden Harry');
    assert.deepEqual(result.items.filter((i) => i.list === 'hidden')[0].reasons, { spam: 1, hate: 1 });
    assert.match(result.items.filter((i) => i.list === 'hidden')[2].display_name, /between "Hidden Harry" and "Visible Vic"/);
    assert.equal(result.items.filter((i) => i.list === 'report').length, 5);
    assert.ok(!shown.stdout.includes('r1') && !shown.stdout.includes(h.profileId), 'reporter ids and profile ids never');
    assert.deepEqual(result.counts, { hidden: 3, reports: 5 });
    assert.match(result.summary, /3 hidden targets at testconf-2099\. 5 reports since 2026-11-10T00:00:00\.000Z/);
  });

  test('the deprecated scripts/moderation.mjs shell prints the same hidden list and since list', async () => {
    const { h, s } = seedModeration();
    // Asynchronous, because the stand-in that answers the child lives in this process.
    const run = (args) => execFileAsync(process.execPath, [join(ROOT, 'scripts', 'moderation.mjs'), '--event', EVENT, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ES_URL: served.url, ELASTISEARCH_API_KEY: KEY },
    }).then((r) => ({ status: 0, ...r }), (err) => ({ status: err.code, stdout: err.stdout, stderr: err.stderr }));
    const hidden = await run(['--hidden']);
    assert.equal(hidden.status, 0, hidden.stderr);
    const lines = hidden.stdout.trim().split('\n');
    assert.equal(lines[0], `profile  "Hidden Harry" ref ${h.ref}  2 reports: spam x1, hate x1`);
    assert.equal(lines[1], `spot     "Spot Sally" ref ${s.ref}  1 report: sexual x1`);
    assert.match(lines[2], /^meet     meet AbCdEfGhIjKlMnOpQrSt_- between "Hidden Harry" and "Visible Vic", state accepted  2 reports: harassment x2$/);
    assert.equal(lines[3], `3 hidden targets at ${EVENT}.`);
    assert.ok(!hidden.stdout.includes(KEY) && !hidden.stdout.includes(h.profileId));
    const since = await run(['--since', '2026-11-10T00:00:00Z']);
    assert.equal(since.status, 0, since.stderr);
    assert.match(since.stdout, /^2026-11-10T09:00:00\.000Z  profile  spam        "Hidden Harry" ref /m);
    assert.match(since.stdout, /5 reports since 2026-11-10T00:00:00\.000Z at testconf-2099\.$/m);
    // The shell's --delete profile: keeps its document-only delete.
    const del = await run(['--delete', `profile:${h.ref}`]);
    assert.equal(del.status, 0, del.stderr);
    assert.match(del.stdout, /Deleted the profile "Hidden Harry"/);
    assert.equal(cluster.source(INDEX.people, h.id), null);
    assert.equal(cluster.ids(INDEX.reports).length, 5, 'the reports stay');
  });

  test('hide profile and spot write an operator report and the flag; unhide clears the flag and the reports', async () => {
    const p = person('Plain Pat', { presence_spot: 'red hat' });
    const hideP = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `profile:${p.ref}`, '--reason', 'spam'], `profile:${p.ref}`));
    assert.equal(hideP.code, 0, hideP.stderr);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, true);
    assert.ok(cluster.source(INDEX.reports, `profile:${p.ref}:operator`));
    const hideS = await invoke(confirmed(['moderation', 'hide', '--event', EVENT, `spot:${p.ref}`, '--reason', 'other'], `spot:${p.ref}`));
    assert.equal(hideS.code, 0, hideS.stderr);
    assert.equal(cluster.source(INDEX.people, p.id).spot_hidden, true);
    assert.equal(cluster.source(INDEX.people, p.id).presence_spot, null);
    assert.ok(cluster.source(INDEX.reports, `spot:${p.ref}:operator`));

    const dry = await invoke(['moderation', 'unhide', '--event', EVENT, `profile:${p.ref}`]);
    assert.match(dry.stdout, /would clear the hidden flag of profile .* and remove 1 report/);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, true);
    const unhide = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, `profile:${p.ref}`], `profile:${p.ref}`));
    assert.equal(unhide.code, 0, unhide.stderr);
    assert.equal(cluster.source(INDEX.people, p.id).hidden, false);
    assert.equal(cluster.source(INDEX.reports, `profile:${p.ref}:operator`), null);
    assert.ok(cluster.source(INDEX.reports, `spot:${p.ref}:operator`), 'the spot report stays');
    assert.deepEqual(unhide.audit.at(-1).counts, { reports: 1 });
    assert.match(unhide.stdout, /Removed 1 report; it is hidden again after two new ones/);
  });

  test('unhide and delete of a meet, and exit 4 for a missing target', async () => {
    const { h } = seedModeration();
    const meet = 'AbCdEfGhIjKlMnOpQrSt_-';
    const unhide = await invoke(confirmed(['moderation', 'unhide', '--event', EVENT, `meet:${meet}`], `meet:${meet}`));
    assert.equal(unhide.code, 0, unhide.stderr);
    assert.equal(cluster.source(INDEX.meets, meet).hidden, false);
    assert.equal(cluster.source(INDEX.meets, meet).hidden_owner_id, null);
    assert.equal(cluster.ids(INDEX.reports).filter((id) => id.startsWith('meet:')).length, 0);
    const del = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `meet:${meet}`], `meet:${meet}`));
    assert.equal(del.code, 0, del.stderr);
    assert.equal(cluster.source(INDEX.meets, meet), null);
    assert.equal((await invoke(['moderation', 'unhide', '--event', EVENT, `meet:${meet}`])).code, 4);
    assert.equal((await invoke(['moderation', 'delete', '--event', EVENT, 'spot:0123456789abcdef'])).code, 4);
    const spot = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `spot:${h.ref}`], `spot:${h.ref}`));
    assert.equal(spot.code, 0);
    assert.equal(cluster.source(INDEX.people, h.id).spot_hidden, true);
  });

  test('purge-reports refuses before the conference end and purges after it', async () => {
    const { h } = seedModeration();
    cluster.put(INDEX.conferences, PAST_CONF, { slug: PAST_CONF, status: 'unavailable', end_date: '2020-01-01', time_zone: 'UTC' });
    report('profile', h.ref, h.profileId, 'old-1', 'spam', PAST_CONF, '2019-12-30T09:00:00.000Z');
    report('profile', h.ref, h.profileId, 'old-2', 'spam', PAST_CONF, '2019-12-31T09:00:00.000Z');
    const early = await invoke(confirmed(['moderation', 'purge-reports', '--event', EVENT], EVENT));
    assert.equal(early.code, 1);
    assert.match(early.stderr, /ends at 2099-12-31T23:59:59\.000Z; nothing is purged before that/);
    assert.equal(cluster.ids(INDEX.reports).length, 7);
    const dry = await invoke(['moderation', 'purge-reports', '--event', PAST_CONF]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would delete 2 reports of pastconf-2020 made before 2020-01-01T23:59:59\.000Z/);
    assert.equal(cluster.ids(INDEX.reports).length, 7);
    const run = await invoke(confirmed(['moderation', 'purge-reports', '--event', PAST_CONF], PAST_CONF));
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Deleted 2 reports of pastconf-2020/);
    assert.equal(cluster.ids(INDEX.reports).length, 5, 'the other conference keeps its reports');
    assert.deepEqual(run.audit.at(-1).counts, { reports: 2 });
    assert.equal((await invoke(['moderation', 'purge-reports', '--event', 'nosuch-2099'])).code, 4);
  });
});

describe('MOD-5, MOD-6 child processes', () => {
  test('purge-expired runs the script with the key in its environment only, after confirmation', async () => {
    const dry = await invoke(['moderation', 'purge-expired']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.spawned.length, 0);
    assert.match(dry.stdout, /would run scripts\/purge-expired-people\.mjs/);
    const run = await invoke(confirmed(['moderation', 'purge-expired'], 'purge-expired'), { spawnResult: { stdout: 'Deleted 3 expired profiles.\n' } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.spawned.length, 1);
    const [child] = run.spawned;
    assert.equal(child.file, process.execPath);
    assert.deepEqual(child.args, [join(root, 'scripts', 'purge-expired-people.mjs')]);
    assert.equal(child.options.env.ELASTISEARCH_API_KEY, KEY);
    assert.equal(child.options.env.ES_URL, served.url);
    assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.match(run.stdout, /Deleted 3 expired profiles/);
  });

  test('the child environment carries the checked key only: no other *API_KEY or token variable reaches it', async () => {
    const env = {
      ES_API_KEY: 'other-read-key', ES_PEOPLE_API_KEY: 'other-people-key', ADMIN_TOKEN: 'a-token', NODE_AUTH_TOKEN: 'npm-token', ES_PEOPLE_INDEX: 'caddie-people-x',
      NODE_OPTIONS: '--max-old-space-size=512', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', PATH: '/usr/bin', HOME: '/home/op', SECRET_THING: 'nope',
      HTTPS_PROXY: 'http://proxy.example:3128', HTTP_PROXY: 'http://proxy.example:3128', NO_PROXY: 'localhost', SSL_CERT_FILE: '/etc/ssl/corp.pem', SSL_CERT_DIR: '/etc/ssl/certs',
      SYSTEMROOT: 'C:\\Windows', PATHEXT: '.EXE', APPDATA: 'C:\\Users\\op\\AppData', USERPROFILE: 'C:\\Users\\op', COMSPEC: 'cmd.exe',
    };
    const r = await invoke(confirmed(['moderation', 'purge-expired'], 'purge-expired'), { env });
    assert.equal(r.code, 0, r.stderr);
    const child = r.spawned[0].options.env;
    assert.deepEqual(Object.keys(child).filter((k) => /API_KEY|TOKEN|SECRET/i.test(k)), ['ELASTISEARCH_API_KEY']);
    assert.equal(child.ELASTISEARCH_API_KEY, KEY);
    assert.ok(!JSON.stringify(child).includes('other-read-key') && !JSON.stringify(child).includes('other-people-key') && !JSON.stringify(child).includes('a-token'));
    assert.equal(child.ES_PEOPLE_INDEX, 'caddie-people-x');
    assert.equal(child.NODE_OPTIONS, '--max-old-space-size=512');
    assert.equal(child.NODE_EXTRA_CA_CERTS, '/etc/ca.pem');
    assert.equal(child.NODE_AUTH_TOKEN, undefined, 'NODE_AUTH_TOKEN is dropped');
    assert.equal(child.PATH, '/usr/bin');
    assert.equal(child.HOME, '/home/op');
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SYSTEMROOT', 'PATHEXT', 'APPDATA', 'USERPROFILE', 'COMSPEC']) assert.equal(child[key], env[key], key);
    assert.equal(child.SECRET_THING, undefined);
    assert.equal(child.CADDIE_DATA_DIR, join(root, 'data'));
    assert.equal(child.CADDIE_ADMIN_HOME, undefined);
    assert.equal(child.CADDIE_ADMIN_ROOT, undefined);
  });

  test('rules test passes the line as an argument, never logs it, and reads exit 3 as matched', async () => {
    const r = await invoke(['moderation', 'rules', 'test', LINE], { spawnResult: { status: 3, stdout: '1 rule matched:\n  w-abc (phrase)\n' } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.spawned[0].args, [join(root, 'scripts', 'moderation-rules.mjs'), '--test', LINE]);
    assert.match(r.stdout, /w-abc/);
    assert.match(r.stdout, /the line matched the word list/);
    assert.ok(!JSON.stringify(r.audit).includes(LINE));
    assert.deepEqual(r.audit.at(-1).counts, { matched: 1 });
    const none = await invoke(['moderation', 'rules', 'test', LINE, '--index', 'caddie-people-rules-v2'], { spawnResult: { status: 0, stdout: 'No rule matched.\n' } });
    assert.deepEqual(none.spawned[0].args.slice(-3), [LINE, '--index', 'caddie-people-rules-v2']);
    assert.match(none.stdout, /no rule matched/);
  });

  test('rules test with --dry-run prints the command and starts nothing', async () => {
    const r = await invoke(['moderation', 'rules', 'test', LINE, '--index', 'caddie-people-rules-v2', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.spawned.length, 0);
    assert.match(r.stdout, /would run scripts\/moderation-rules\.mjs --test "<line>" --index caddie-people-rules-v2/);
    assert.ok(!r.stdout.includes(LINE) && !JSON.stringify(r.audit).includes(LINE));
    assert.equal(r.audit.at(-1).mode, 'dry-run');
  });

  test('rules reload previews, then runs --reload-rules with the key in the environment', async () => {
    const dry = await invoke(['moderation', 'rules', 'reload']);
    assert.equal(dry.spawned.length, 0);
    assert.match(dry.stdout, /would run scripts\/moderation-rules\.mjs --reload-rules/);
    const run = await invoke(confirmed(['moderation', 'rules', 'reload'], 'reload'));
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.spawned[0].args, [join(root, 'scripts', 'moderation-rules.mjs'), '--reload-rules']);
    assert.equal(run.spawned[0].options.env.ELASTISEARCH_API_KEY, KEY);
    const failed = await invoke(confirmed(['moderation', 'rules', 'reload'], 'reload'), { spawnResult: { status: 1, stderr: 'Set ELASTISEARCH_API_KEY (the admin key)\n' } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /scripts\/moderation-rules\.mjs exited with 1: Set ELASTISEARCH_API_KEY/);
  });
});

describe('CONF-1, CONF-2 conferences list and add', () => {
  test('list shows searchable conferences, --all every one, with the talk count', async () => {
    cluster.put(INDEX.conferences, OTHER, { slug: OTHER, name: 'Other', status: 'unavailable', status_reason: 'fetch_failed', start_date: '2099-01-01', end_date: '2099-01-02', counts: { talk: 0 } });
    cluster.patch(INDEX.conferences, EVENT, { name: 'Test Conf', start_date: '2099-12-30', counts: { talk: 12, sessions: 15 } });
    const r = await invoke(['conferences', 'list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.items, [{ slug: EVENT, name: 'Test Conf', start_date: '2099-12-30', end_date: '2099-12-31', status: 'searchable', talks: 12 }]);
    const all = await invoke(['conferences', 'list', '--all']);
    assert.match(all.stdout, /^slug=otherconf-2099 name=Other start_date=2099-01-01 end_date=2099-01-02 status=unavailable talks=0\nslug=testconf-2099 /);
    assert.match(all.stdout, /2 conferences$/m);
    assert.ok(!all.stdout.includes('fetch_failed'), 'status_reason is not shown');
  });

  test('add spawns ingest.mjs --event then build-facets.mjs, with the key in the environment only', async () => {
    const r = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: (args) => ({ stdout: `${args[0].split('/').pop()} ran\n` }) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.spawned.map((c) => c.args), [[join(root, 'scripts', 'ingest.mjs'), '--event', OTHER], [join(root, 'scripts', 'build-facets.mjs'), OTHER]]);
    for (const c of r.spawned) {
      assert.equal(c.options.env.ELASTISEARCH_API_KEY, KEY);
      assert.equal(c.options.env.ES_URL, served.url);
      assert.equal(c.options.cwd, root);
    }
    assert.match(r.stdout, /step=ingest line=ingest.mjs ran\nstep=facets line=build-facets.mjs ran\ningested otherconf-2099 and rebuilt its facets/);
    const refresh = await invoke(['conferences', 'refresh', '--event', OTHER, '--allow-shrink']);
    assert.equal(refresh.spawned.length, 2);
    assert.match(refresh.stdout, /--allow-shrink has no effect on tier 3/);
    const failed = await invoke(['conferences', 'add', '--event', OTHER], { spawnResult: { status: 2, stderr: 'Fatal: nope\n' } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /scripts\/ingest\.mjs exited with 2: Fatal: nope/);
  });

  test('add and refresh with --dry-run start nothing and print the commands they would run', async () => {
    for (const argv of [['conferences', 'add', '--event', OTHER], ['conferences', 'refresh', '--event', OTHER, '--allow-shrink']]) {
      const r = await invoke([...argv, '--dry-run']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.spawned.length, 0, 'no child process');
      assert.equal(r.requests.length, 0, 'no request');
      assert.match(r.stdout, /step=ingest command=node scripts\/ingest\.mjs --event otherconf-2099\nstep=facets command=node scripts\/build-facets\.mjs otherconf-2099\nwould run the two commands above/);
      assert.match(r.stdout, /dry-run, nothing changed/);
      assert.equal(r.audit.at(-1).mode, 'dry-run');
    }
  });

  test('add, refresh and hide refuse a removed slug and point at conferences unretire', async () => {
    seedConferenceFiles(OTHER);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [OTHER]: { since: '2026-11-01T00:00:00.000Z' } } }));
    for (const argv of [['conferences', 'add', '--event', OTHER], ['conferences', 'refresh', '--event', OTHER], confirmed(['conferences', 'hide', '--event', OTHER], OTHER)]) {
      const r = await invoke(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.stderr, /otherconf-2099 is removed .*run conferences unretire --event otherconf-2099 first/);
      assert.equal(r.spawned.length, 0);
      assert.equal(r.requests.length, 0);
    }
    assert.equal(readJson(join(root, 'data', OTHER, 'conference.json')).status, 'searchable');
    // Under --dry-run the refusal is previewed, still exits 2, and is audited as a dry run.
    const dry = await invoke(['conferences', 'refresh', '--event', OTHER, '--dry-run']);
    assert.equal(dry.code, 2);
    assert.match(dry.stderr, /would refuse: otherconf-2099 is removed .*run conferences unretire --event otherconf-2099 first/);
    assert.equal(dry.audit.at(-1).mode, 'dry-run');
    assert.equal(dry.spawned.length + dry.requests.length, 0);
  });
});

describe('CONF-4, CONF-11 conferences hide and unhide', () => {
  test('hide rewrites conference.json, updates the backend, records the operator file, and leaves the overrides file alone', async () => {
    seedConferenceFiles(EVENT);
    const mtime = overridesMtime();
    const dry = await invoke(['conferences', 'hide', '--event', EVENT, '--reason', 'other', '--note', NOTE]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would set testconf-2099 to unavailable \(operator_hidden\) on the backend \(now searchable\)/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.equal(cluster.source(INDEX.conferences, EVENT).status, 'searchable');

    const r = await invoke(confirmed(['conferences', 'hide', '--event', EVENT, '--reason', 'other', '--note', NOTE], EVENT));
    assert.equal(r.code, 0, r.stderr);
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status, 'unavailable');
    assert.equal(local.status_reason, 'operator_hidden');
    assert.equal(local.raw_fetched_at, '2026-11-11T10:00:00.000Z');
    assert.equal(local.name, `Conference ${EVENT}`, 'the other fields are kept');
    const backend = cluster.source(INDEX.conferences, EVENT);
    assert.equal(backend.status, 'unavailable');
    assert.equal(backend.status_reason, 'operator_hidden');
    assert.deepEqual(operatorFile(), { hidden: { [EVENT]: { reason: 'other', since: '2026-11-11T10:00:00.000Z', previous: { status: 'searchable', status_reason: null } } }, removed: {} });
    assert.match(r.stdout, /commit data\/testconf-2099\/conference\.json and data\/conference-operator\.json/);
    assert.match(r.stdout, /pages\.yml/);
    assert.ok(!r.stdout.includes(NOTE) && !JSON.stringify(r.audit).includes(NOTE));
    assert.equal(overridesMtime(), mtime, 'data/conference-overrides.json is untouched');
    assert.deepEqual(readJson(join(root, 'data', 'conference-overrides.json')), { 'pytorch-day-japan-2026': { time_zone: 'Asia/Tokyo' } });

    assert.deepEqual(operatorFile().hidden[EVENT].previous, { status: 'searchable', status_reason: null });
    assert.equal(backend.name, undefined, 'only the status fields were sent to the backend');

    // unhide previews without --yes and writes nothing.
    const preview = await invoke(['conferences', 'unhide', '--event', EVENT]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /would set testconf-2099 to searchable on the backend \(now unavailable \(operator_hidden\)\); would rewrite/);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'unavailable');
    assert.equal(cluster.source(INDEX.conferences, EVENT).status, 'unavailable');
    assert.ok(operatorFile().hidden[EVENT]);
    assert.ok(!preview.requests.some((e) => e.method !== 'GET'), 'no write in the preview');

    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(unhide.code, 0, unhide.stderr);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status_reason, null);
    assert.equal(cluster.source(INDEX.conferences, EVENT).status, 'searchable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.match(unhide.stdout, /run conferences refresh --event testconf-2099/);
    assert.equal(overridesMtime(), mtime);
  });

  test('unhide restores the status the conference had before the hide (partial_index stays partial_index)', async () => {
    seedConferenceFiles(EVENT, { status: 'unavailable', statusReason: 'partial_index' });
    cluster.patch(INDEX.conferences, EVENT, { status: 'unavailable', status_reason: 'partial_index' });
    const hide = await invoke(confirmed(['conferences', 'hide', '--event', EVENT], EVENT));
    assert.equal(hide.code, 0, hide.stderr);
    assert.deepEqual(operatorFile().hidden[EVENT].previous, { status: 'unavailable', status_reason: 'partial_index' });
    assert.equal(cluster.source(INDEX.conferences, EVENT).status_reason, 'operator_hidden');
    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(unhide.code, 0, unhide.stderr);
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status, 'unavailable');
    assert.equal(local.status_reason, 'partial_index');
    assert.equal(cluster.source(INDEX.conferences, EVENT).status_reason, 'partial_index');
    assert.match(unhide.stdout, /restored unavailable \(partial_index\)/);
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
  });

  test('remove, unretire, hide, unhide brings a conference back searchable, never operator_removed', async () => {
    seedConferenceFiles(EVENT);
    assert.equal((await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT))).code, 0);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status_reason, 'operator_removed');
    assert.equal((await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT))).code, 0);
    // The backend holds the conference again (as conferences refresh would put it back).
    cluster.put(INDEX.conferences, EVENT, { slug: EVENT, status: 'searchable', end_date: '2099-12-31' });
    const hide = await invoke(confirmed(['conferences', 'hide', '--event', EVENT], EVENT));
    assert.equal(hide.code, 0, hide.stderr);
    assert.equal(operatorFile().hidden[EVENT].previous, null, 'an operator-set status is not recorded as the status to restore');
    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(unhide.code, 0, unhide.stderr);
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status, 'searchable');
    assert.equal(local.status_reason, null);
    assert.equal(cluster.source(INDEX.conferences, EVENT).status, 'searchable');
    // An older hidden entry whose recorded previous is operator_hidden: unhide uses the talk-file rule too.
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: { [EVENT]: { reason: 'spam', since: '2026-11-01T00:00:00.000Z', previous: { status: 'unavailable', status_reason: 'operator_hidden' } } }, removed: {} }));
    const legacy = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
  });

  test('unhide without the talk file keeps the status until a refresh; hide without a local file exits 4', async () => {
    seedConferenceFiles(EVENT, { talks: false, status: 'unavailable' });
    const operator = { hidden: { [EVENT]: { reason: 'spam', since: '2026-11-01T00:00:00.000Z' } }, removed: {} };
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify(operator));
    const r = await invoke(confirmed(['conferences', 'unhide', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'unavailable');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: {} });
    assert.match(r.stdout, /talk file is missing/);
    assert.equal((await invoke(confirmed(['conferences', 'unhide', '--event', OTHER], OTHER))).code, 4);
    assert.equal((await invoke(['conferences', 'hide', '--event', OTHER])).code, 4);
    // A backend without the conference is exit 4 too, and the local file stays.
    seedConferenceFiles(OTHER);
    const gone = await invoke(confirmed(['conferences', 'hide', '--event', OTHER], OTHER));
    assert.equal(gone.code, 4);
    assert.equal(readJson(join(root, 'data', OTHER, 'conference.json')).status, 'searchable');
  });
});

describe('CONF-6, CONF-8, CONF-11, CONF-12 conferences remove and unretire', () => {
  function seedTwoConferences() {
    for (const slug of [EVENT, OTHER]) {
      if (slug !== EVENT) cluster.put(INDEX.conferences, slug, { slug, status: 'searchable', end_date: '2099-12-31' });
      for (let i = 0; i < 3; i++) cluster.put(INDEX.talks, `${slug}:t${i}`, { conference: slug, talk_id: `${slug}:t${i}` });
      cluster.put(INDEX.topics, `${slug}:topic`, { conference: slug });
      cluster.put('caddie-facets', `${slug}:facet`, { conference: slug });
      const p = newDevice();
      cluster.put(INDEX.people, `${slug}:${p.profileId}`, { event_id: slug, profile_id: p.profileId, ref: refOf(p.profileId), display_name: 'Someone' });
      cluster.put(INDEX.meets, `${slug}:meet`, { event_id: slug, meet_id: 'x', participants: [p.profileId, 'o'] });
      cluster.put(INDEX.blocks, `${slug}:block`, { event_id: slug, blocker_id: p.profileId, blocked_id: 'o' });
      cluster.put(INDEX.push, `${slug}:push`, { event_id: slug, profile_id: p.profileId });
      cluster.put(INDEX.nudges, `${slug}:nudge`, { event_id: slug, profile_ids: [p.profileId, 'o'] });
      report('profile', refOf(p.profileId), p.profileId, 'r1', 'spam', slug);
    }
  }
  const EXPECTED = { talks: 3, topics: 1, facets: 1, people: 1, meets: 1, blocks: 1, push: 1, nudges: 1, reports: 1, conference: 1 };
  const remaining = (slug) => Object.fromEntries(['talks', 'topics', 'caddie-facets', 'people', 'meets', 'blocks', 'push', 'nudges', 'reports'].map((name) => {
    const index = INDEX[name] ?? name;
    return [name, cluster.find(index, { match_all: {} }).filter(([, d]) => (d.source.conference ?? d.source.event_id) === slug).length];
  }));

  test('the dry-run counts per index and deletes nothing; the run wipes one conference and keeps the other', async () => {
    seedTwoConferences();
    seedConferenceFiles(EVENT);
    const mtime = overridesMtime();
    const dry = await invoke(['conferences', 'remove', '--event', EVENT, '--json']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json().result.counts, EXPECTED);
    assert.match(dry.json().result.summary, /would delete from the backend: talks 3, topics 1, facets 1, people 1, meets 1, blocks 1, push 1, nudges 1, reports 1, conference 1; would retire data\/testconf-2099\/conference\.json/);
    assert.deepEqual(remaining(EVENT), { talks: 3, topics: 1, 'caddie-facets': 1, people: 1, meets: 1, blocks: 1, push: 1, nudges: 1, reports: 1 });
    assert.ok(cluster.source(INDEX.conferences, EVENT));
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status, 'searchable');
    assert.ok(!dry.requests.some((e) => e.method === 'DELETE' || e.path.includes('_delete_by_query')));

    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--reason', 'other'], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.audit.at(-1).counts, EXPECTED);
    assert.deepEqual(remaining(EVENT), { talks: 0, topics: 0, 'caddie-facets': 0, people: 0, meets: 0, blocks: 0, push: 0, nudges: 0, reports: 0 });
    assert.deepEqual(remaining(OTHER), { talks: 3, topics: 1, 'caddie-facets': 1, people: 1, meets: 1, blocks: 1, push: 1, nudges: 1, reports: 1 });
    assert.equal(cluster.source(INDEX.conferences, EVENT), null);
    assert.ok(cluster.source(INDEX.conferences, OTHER));
    for (const e of r.requests.filter((x) => x.path.includes('_delete_by_query'))) {
      assert.equal(e.params.get('refresh'), 'true');
      assert.equal(e.params.get('conflicts'), 'proceed');
    }
    // CONF-8: the local file is retired and kept; the operator file records the removal.
    const local = readJson(join(root, 'data', EVENT, 'conference.json'));
    assert.equal(local.status, 'unavailable');
    assert.equal(local.status_reason, 'operator_removed');
    assert.equal(local.raw_fetched_at, '2026-11-11T10:00:00.000Z');
    assert.ok(existsSync(join(root, 'data', EVENT, 'talks.ndjson')), 'the talk file stays without --purge-local');
    assert.ok(existsSync(join(root, 'data', 'raw', EVENT)));
    assert.deepEqual(operatorFile(), { hidden: {}, removed: { [EVENT]: { since: '2026-11-11T10:00:00.000Z' } } });
    assert.match(r.stdout, /commit data\/testconf-2099\/conference\.json and data\/conference-operator\.json; the next pages\.yml build drops testconf-2099 from the bundle index and carries its bundle forward for one day; testconf-2099 stays removed across the weekly ingest until conferences unretire --event testconf-2099/);
    assert.equal(overridesMtime(), mtime, 'data/conference-overrides.json is untouched');
  });

  test('--purge-local deletes only data/raw/<slug>/ and the talk file; conference.json survives', async () => {
    seedTwoConferences();
    seedConferenceFiles(EVENT);
    seedConferenceFiles(OTHER);
    const r = await invoke(confirmed(['conferences', 'remove', '--event', EVENT, '--purge-local'], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(root, 'data', EVENT, 'conference.json')), 'conference.json survives --purge-local');
    assert.equal(readJson(join(root, 'data', EVENT, 'conference.json')).status_reason, 'operator_removed');
    assert.ok(!existsSync(join(root, 'data', EVENT, 'talks.ndjson')));
    assert.ok(!existsSync(join(root, 'data', 'raw', EVENT)));
    assert.ok(existsSync(join(root, 'data', OTHER, 'talks.ndjson')) && existsSync(join(root, 'data', 'raw', OTHER)), 'the other conference is untouched');
    assert.ok(existsSync(join(root, 'data', 'conference-overrides.json')));
    assert.match(r.stdout, /deleted data\/raw\/testconf-2099, data\/testconf-2099\/talks\.ndjson/);
    assert.deepEqual(r.audit.at(-1).flags, ['purge-local']);
  });

  test('a malformed operator file or conference.json stops hide and remove before any backend call', async () => {
    seedTwoConferences();
    seedConferenceFiles(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), '{ not json');
    for (const argv of [confirmed(['conferences', 'remove', '--event', EVENT], EVENT), confirmed(['conferences', 'hide', '--event', EVENT], EVENT)]) {
      const r = await invoke(argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.stderr, /conference-operator\.json is not valid JSON/);
      assert.equal(r.requests.length, 0, 'no backend call');
    }
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: [], removed: {} }));
    const shape = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(shape.code, 1);
    assert.match(shape.stderr, /must be \{ "hidden": \{\}, "removed": \{\} \}/);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: {} }));
    writeFileSync(join(root, 'data', EVENT, 'conference.json'), '{ not json');
    const conf = await invoke(confirmed(['conferences', 'remove', '--event', EVENT], EVENT));
    assert.equal(conf.code, 1);
    assert.equal(conf.requests.length, 0);
    assert.deepEqual(remaining(EVENT).talks, 3, 'nothing was deleted');
  });

  test('remove without a local file records the removal and says the file is missing', async () => {
    seedTwoConferences();
    mkdirSync(join(root, 'data'), { recursive: true });
    const r = await invoke(confirmed(['conferences', 'remove', '--event', OTHER], OTHER));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(root, 'data', OTHER, 'conference.json')));
    assert.deepEqual(operatorFile().removed, { [OTHER]: { since: '2026-11-11T10:00:00.000Z' } });
    assert.match(r.stdout, /file=data\/otherconf-2099\/conference\.json missing=true/);
  });

  test('unretire drops the removed entry with no backend call and points at conferences refresh', async () => {
    seedConferenceFiles(EVENT);
    writeFileSync(join(root, 'data', 'conference-operator.json'), JSON.stringify({ hidden: {}, removed: { [EVENT]: { since: '2026-11-01T00:00:00.000Z' }, [OTHER]: { since: '2026-11-01T00:00:00.000Z' } } }));
    const dry = await invoke(['conferences', 'unretire', '--event', EVENT]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(Object.keys(operatorFile().removed).length, 2);
    const r = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.requests, [], 'no backend call on tier 3');
    assert.deepEqual(operatorFile(), { hidden: {}, removed: { [OTHER]: { since: '2026-11-01T00:00:00.000Z' } } });
    assert.match(r.stdout, /run conferences refresh --event testconf-2099 next/);
    assert.match(r.stdout, /commit data\/conference-operator\.json/);
    const again = await invoke(confirmed(['conferences', 'unretire', '--event', EVENT], EVENT));
    assert.equal(again.code, 4);
  });
});

describe('SEC terminal output: control characters in user text are escaped', () => {
  // OSC 52 (clipboard write), CSI 2J (clear screen), a right-to-left override, a C1 CSI (0x9B)
  // and a newline, in a display name and in profile text stored in Elasticsearch.
  const HOSTILE = 'Eve\u001b]52;c;aGk=\u0007 \u001b[2J \u202Eevil\u202C \u009b31m\nnext';
  const RAW = ['\u001b', '\u0007', '\u202e', '\u202c', '\u009b'];
  const clean = (text) => RAW.every((c) => !text.includes(c));

  test('human and --json output of search, view, queue and the moderation summary hold no raw control or bidi character on tier 3', async () => {
    const p = person(HOSTILE, { hidden: true, about: `about ${HOSTILE}`, presence_spot: HOSTILE });
    report('profile', p.ref, p.profileId, 'r1', 'spam');
    const runs = [
      ['attendees', 'search', '--event', EVENT, '--name', 'Eve', '--include-hidden'],
      ['attendees', 'view', '--event', EVENT, p.ref, '--text'],
      ['moderation', 'queue', '--event', EVENT, '--show-content', '--since', '2026-11-01T00:00:00Z'],
    ];
    for (const argv of runs) {
      for (const flag of [[], ['--json']]) {
        const r = await invoke([...argv, ...flag]);
        assert.equal(r.code, 0, `${argv.join(' ')} ${flag}: ${r.stderr}`);
        assert.ok(clean(r.stdout), `raw control characters in stdout of ${argv.join(' ')} ${flag}`);
        assert.ok(r.stdout.includes('Eve'), 'the name is still shown');
        if (flag.length) {
          JSON.parse(r.stdout);
          assert.match(r.stdout, /\\u001b\]52;c;aGk=\\u0007/);
          assert.match(r.stdout, /\\u202e/);
          assert.match(r.stdout, /\\u009b/);
          assert.match(r.stdout, /\\nnext/, 'the newline as a JSON escape');
          assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one JSON line');
        } else {
          assert.match(r.stdout, /Eve\\u\{1B\}\]52;c;aGk=\\u\{7\} \\u\{1B\}\[2J \\u\{202E\}evil\\u\{202C\} \\u\{9B\}31m\\u\{A\}next/);
          assert.ok(!/\nnext/.test(r.stdout), 'a newline in a value does not add a line');
        }
        assert.ok(clean(JSON.stringify(r.audit)) && !JSON.stringify(r.audit).includes('Eve'), 'the audit holds no user text');
      }
    }
    // The summary line of a moderation command repeats the name through the refactored script
    // functions; it is escaped the same way.
    const del = await invoke(confirmed(['moderation', 'delete', '--event', EVENT, `spot:${p.ref}`], `spot:${p.ref}`));
    assert.equal(del.code, 0, del.stderr);
    assert.ok(clean(del.stdout) && clean(del.stderr));
  });
});

describe('SEC-13 redirects', () => {
  test('an Elasticsearch redirect is never followed, so the key never travels on', async () => {
    const hops = [];
    const redirecting = http.createServer((req, res) => {
      hops.push(req.url);
      res.writeHead(302, { location: `${served.url}${req.url}` });
      res.end();
    });
    await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    try {
      writeConfig({ default: 't3', backends: { t3: { tier: 3, es_url: `http://127.0.0.1:${redirecting.address().port}` } } });
      const r = await invoke(['stats', 'counts']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Could not reach Elasticsearch/);
      assert.equal(hops.length, 1);
      assert.equal(cluster.log.length, 0, 'the redirect target was never called');
    } finally {
      await new Promise((resolve) => redirecting.close(resolve));
    }
  });
});

describe('STAT-1 to STAT-3 stats', () => {
  test('counts per index, with and without --event', async () => {
    for (const slug of [EVENT, OTHER]) {
      cluster.put(INDEX.talks, `${slug}:t`, { conference: slug });
      cluster.put(INDEX.people, `${slug}:p`, { event_id: slug });
    }
    cluster.put(INDEX.talks, `${EVENT}:t2`, { conference: EVENT });
    const r = await invoke(['stats', 'counts', '--event', EVENT, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().result.counts, { talks: 2, topics: 0, facets: 0, people: 1, meets: 0, blocks: 0, push: 0, nudges: 0, reports: 0, conferences: 1 });
    const all = await invoke(['stats', 'counts', '--json']);
    assert.deepEqual(all.json().result.counts, { people: 2, blocks: 0, meets: 0, push: 0, nudges: 0, reports: 0, conferences: 1, talks: 3, topics: 0, facets: 0 });
    assert.match((await invoke(['stats', 'counts'])).stdout, /^index=people count=2\n/);
  });

  test('usage prints the cluster health and the caddie indices from the monitor endpoints', async () => {
    cluster.clusterHealth = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'admin-stats', 'cluster-health.json'), 'utf8'));
    cluster.catIndices = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'admin-stats', 'cat-indices.json'), 'utf8'));
    const r = await invoke(['stats', 'usage', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const { result } = r.json();
    assert.deepEqual(result.items[0], { cluster: 'fixture-cluster', status: 'yellow', nodes: 2, active_shards: 9, unassigned_shards: 9 });
    assert.deepEqual(result.items[1], { index: 'caddie-talks-v3', docs: 1234, size: '41.2mb' });
    assert.equal(result.items.length, 5);
    assert.match(result.summary, /cluster yellow, 4 caddie indices \(needs the monitor privilege/);
    // The third request looks for a demo conference to leave out of the counts; there is none here.
    assert.deepEqual(r.requests.map((e) => `${e.method} ${e.path}?${e.params}`), ['GET /_cluster/health?', 'GET /_cat/indices/caddie-*?format=json&h=index%2Cdocs.count%2Cstore.size', 'POST /caddie-conferences/_search?ignore_unavailable=true']);
    delete cluster.clusterHealth;
    delete cluster.catIndices;
    const own = await invoke(['stats', 'usage']);
    assert.match(own.stdout, /^cluster=fake status=green/);
    assert.match(own.stdout, /index=caddie-conferences docs=1 /);
  });

  test('health reads the service, then prints the smoke and log commands with variable names, never values', async () => {
    const api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/health') res.end('{"ok":true}');
      else if (req.url === '/api/capabilities') res.end(JSON.stringify({ tier: 3, ble: { mode: 'derived' }, push: { apns: false, fcm: true } }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${api.address().port}`;
    try {
      writeConfig({ default: 't3', backends: { t3: { tier: 3, es_url: served.url, api: apiUrl, project: 'fixture-project', service: 'fixture-service' } } });
      const r = await invoke(['stats', 'health']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^health=200 ok=true\ncapabilities=200 tier=3 ble_mode=derived push_apns=false push_fcm=true\n/);
      assert.ok(r.stdout.includes(`smoke=BASE_URL="${apiUrl}" ES_URL="${served.url}" ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" node scripts/smoke.mjs`), r.stdout);
      assert.ok(r.stdout.includes(`logs=gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="fixture-service" AND severity>=ERROR' --limit 50 --project fixture-project --format=json`), r.stdout);
      assert.equal(r.requests.length, 0, 'no Elasticsearch call');
      writeConfig({ default: 't3', backends: { t3: { tier: 3, es_url: served.url } } });
      const none = await invoke(['stats', 'health']);
      assert.equal(none.code, 1);
      assert.match(none.stderr, /has no api/);
      writeConfig({ default: 't3', backends: { t3: { tier: 3, es_url: served.url, api: 'http://10.0.0.9' } } });
      assert.equal((await invoke(['stats', 'health'])).code, 2);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The demo conference (demo: true, invented data; scripts/lib/demo-conference.mjs): hiding it leaves
// no presence, meet request or nudge of it behind, removing it leaves nothing, it is gone from the
// public list either way, and the counts that span conferences leave it out.

describe('DEMO the demo conference on tier 3', () => {
  const DEMO = 'caddie-demo-conference';

  // The demo conference as the ingest stores it, with two people: one around, both in a meet and a
  // nudge; and a person around at the real conference EVENT, with a meet and a nudge of its own.
  function seedDemo() {
    seedConferenceFiles(DEMO);
    const local = readJson(join(root, 'data', DEMO, 'conference.json'));
    writeFileSync(join(root, 'data', DEMO, 'conference.json'), `${JSON.stringify({ ...local, name: 'Caddie Demo Conference', demo: true, source: 'demo' }, null, 2)}\n`);
    cluster.put(INDEX.conferences, DEMO, { slug: DEMO, name: 'Caddie Demo Conference', status: 'searchable', demo: true, source: 'demo', start_date: '2099-12-01', end_date: '2099-12-03', time_zone: 'UTC' });
    cluster.put(INDEX.talks, `${DEMO}:d1-a10`, { conference: DEMO });
    const around = { presence_zone: 'Main Hall', presence_spot: 'by the coffee', presence_since: '2026-11-11T09:00:00Z', presence_until: FUTURE, presence_location: { lat: 1, lon: 2 } };
    cluster.put(INDEX.people, `${DEMO}:p1`, { event_id: DEMO, profile_id: 'p1', open_to_meet: true, visible_until: FUTURE, ...around });
    cluster.put(INDEX.people, `${DEMO}:p2`, { event_id: DEMO, profile_id: 'p2', open_to_meet: true, visible_until: FUTURE });
    cluster.put(INDEX.meets, 'demo-meet', { event_id: DEMO, meet_id: 'demo-meet', participants: ['p1', 'p2'], requester_id: 'p2', state: 'requested', expires_at: FUTURE });
    cluster.put(INDEX.nudges, 'demo-nudge', { event_id: DEMO, profile_ids: ['p1', 'p2'], receivers: ['p1'], expires_at: FUTURE });
    cluster.put(INDEX.people, `${EVENT}:r1`, { event_id: EVENT, profile_id: 'r1', open_to_meet: true, visible_until: FUTURE, ...around });
    cluster.put(INDEX.meets, 'real-meet', { event_id: EVENT, meet_id: 'real-meet', participants: ['r1', 'x'], requester_id: 'x', state: 'requested', expires_at: FUTURE });
    cluster.put(INDEX.nudges, 'real-nudge', { event_id: EVENT, profile_ids: ['r1', 'x'], receivers: ['r1'], expires_at: FUTURE });
  }

  test('hide clears the demo\'s presence and deletes its meets and nudges; the real conference keeps its own', async () => {
    seedDemo();
    const dry = await invoke(['conferences', 'hide', '--event', DEMO]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /it is the demo conference, so its presence would be cleared and its meet requests and nudges deleted/);
    assert.ok(cluster.source(INDEX.meets, 'demo-meet'), 'the preview deletes nothing');

    const r = await invoke(confirmed(['conferences', 'hide', '--event', DEMO], DEMO));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /demo conference: cleared presence on 1 profile, deleted 1 meet and 1 nudge record/);
    assert.equal(cluster.source(INDEX.conferences, DEMO).status, 'unavailable');
    assert.equal(cluster.source(INDEX.people, `${DEMO}:p1`).presence_until, null);
    assert.equal(cluster.source(INDEX.people, `${DEMO}:p1`).presence_zone, null);
    assert.equal(cluster.source(INDEX.meets, 'demo-meet'), null);
    assert.equal(cluster.source(INDEX.nudges, 'demo-nudge'), null);
    assert.equal(cluster.source(INDEX.people, `${EVENT}:r1`).presence_until, FUTURE, 'the real conference keeps its presence');
    assert.ok(cluster.source(INDEX.meets, 'real-meet'));
    assert.ok(cluster.source(INDEX.nudges, 'real-nudge'));
    assert.equal(operatorFile().hidden[DEMO].reason, 'other');
  });

  test('the second sweep, a minute after the hide, catches what the server accepted from its cached list', async () => {
    seedDemo();
    const waits = [];
    const sleep = async (ms) => {
      waits.push(ms);
      // Written while the server still listed the demo as searchable (its 60-second cache).
      cluster.put(INDEX.meets, 'late-meet', { event_id: DEMO, meet_id: 'late-meet', participants: ['p1', 'p2'], requester_id: 'p1', state: 'requested', expires_at: FUTURE });
      cluster.patch(INDEX.people, `${DEMO}:p2`, { presence_zone: 'Room 2', presence_until: FUTURE });
    };
    const r = await invoke(confirmed(['conferences', 'hide', '--event', DEMO], DEMO), { sleep });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(waits, [61_000]);
    assert.equal(cluster.source(INDEX.meets, 'late-meet'), null);
    assert.equal(cluster.source(INDEX.people, `${DEMO}:p2`).presence_until, null);
    assert.match(r.stdout, /cleared presence on 2 profiles, deleted 2 meets and 1 nudge record/);
  });

  test('a hide that leaves conflicting rows fails and asks for another run', async () => {
    seedDemo();
    const conflicted = async (ms) => { void ms; };
    const original = cluster.answer.bind(cluster);
    cluster.answer = (method, index, op, ...rest) => {
      if (op === '_delete_by_query' && index === INDEX.meets) return new Response(JSON.stringify({ deleted: 0, version_conflicts: 1, failures: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return original(method, index, op, ...rest);
    };
    const r = await invoke(confirmed(['conferences', 'hide', '--event', DEMO], DEMO), { sleep: conflicted });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /left 1 conflicting and 0 failed documents; run the same conferences hide again/);
  });

  test('a fresh clone, which has no generated folder for the demo, can hide and unhide it', async () => {
    seedDemo();
    rmSync(join(root, 'data', DEMO), { recursive: true, force: true });
    const hide = await invoke(confirmed(['conferences', 'hide', '--event', DEMO], DEMO));
    assert.equal(hide.code, 0, hide.stderr);
    assert.equal(cluster.source(INDEX.conferences, DEMO).status, 'unavailable');
    assert.equal(readJson(join(root, 'data', DEMO, 'conference.json')).demo, true, 'the generated document stands in for the missing file');
    assert.match(hide.stdout, /commit data\/conference-operator\.json;/, 'only the operator file is committed for the demo');
    // The hide left a generated file (unavailable, no talk file); the unhide still restores the demo.
    const unhide = await invoke(confirmed(['conferences', 'unhide', '--event', DEMO], DEMO));
    assert.equal(unhide.code, 0, unhide.stderr);
    assert.equal(cluster.source(INDEX.conferences, DEMO).status, 'searchable');
  });

  test('hiding a real conference keeps its presence, meets and nudges, as before', async () => {
    seedDemo();
    seedConferenceFiles(EVENT);
    const r = await invoke(confirmed(['conferences', 'hide', '--event', EVENT], EVENT));
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /demo conference/);
    assert.equal(cluster.source(INDEX.people, `${EVENT}:r1`).presence_until, FUTURE);
    assert.ok(cluster.source(INDEX.meets, 'real-meet') && cluster.source(INDEX.nudges, 'real-nudge'));
    assert.ok(cluster.source(INDEX.meets, 'demo-meet'), 'and nothing of the demo is touched');
  });

  test('remove leaves no row of the demo behind', async () => {
    seedDemo();
    const r = await invoke(confirmed(['conferences', 'remove', '--event', DEMO], DEMO));
    assert.equal(r.code, 0, r.stderr);
    for (const name of ['people', 'meets', 'nudges', 'talks', 'push', 'blocks', 'reports']) {
      assert.deepEqual(cluster.ids(INDEX[name]).filter((id) => cluster.source(INDEX[name], id)?.event_id === DEMO || cluster.source(INDEX[name], id)?.conference === DEMO), [], name);
    }
    assert.equal(cluster.source(INDEX.conferences, DEMO), null);
    assert.ok(cluster.source(INDEX.meets, 'real-meet'), 'another conference keeps its rows');
  });

  test('counts without --event, and usage, leave the demo out; --event counts it; list marks it', async () => {
    seedDemo();
    const all = await invoke(['stats', 'counts', '--json']);
    assert.equal(all.code, 0, all.stderr);
    const counts = all.json().result.counts;
    assert.equal(counts.people, 1, 'only the real conference\'s person');
    assert.equal(counts.meets, 1);
    assert.equal(counts.nudges, 1);
    assert.equal(counts.talks, 0);
    assert.equal(counts.conferences, 1, 'the demo conference document is left out');
    assert.match(all.json().result.summary, /the demo conference caddie-demo-conference left out/);
    const own = await invoke(['stats', 'counts', '--event', DEMO, '--json']);
    assert.equal(own.json().result.counts.people, 2);
    const usage = await invoke(['stats', 'usage', '--json']);
    assert.equal(usage.code, 0, usage.stderr);
    const rows = Object.fromEntries(usage.json().result.items.slice(1).map((row) => [row.index, row.docs]));
    assert.equal(rows[INDEX.people], 1);
    assert.equal(rows[INDEX.meets], 1);
    assert.equal(rows[INDEX.conferences], 1);
    assert.match(usage.json().result.summary, /top-level documents counted without the demo conference caddie-demo-conference/);
    // Versioned index names behind the aliases, as on a real cluster.
    cluster.put('caddie-talks-v3', 'real-1', { conference: EVENT });
    cluster.put('caddie-talks-v3', 'real-2', { conference: EVENT });
    cluster.put('caddie-talks-v3', `${DEMO}:d1-a10`, { conference: DEMO });
    cluster.put('caddie-people-meets-v2', 'demo-meet', { event_id: DEMO });
    const versioned = Object.fromEntries((await invoke(['stats', 'usage', '--json'])).json().result.items.slice(1).map((row) => [row.index, row.docs]));
    assert.equal(versioned['caddie-talks-v3'], 2, 'the demo talk is left out of a versioned talks index');
    assert.equal(versioned['caddie-people-meets-v2'], 0, 'the longest alias decides the field: event_id of the meets');
    const list = await invoke(['conferences', 'list', '--json']);
    const demo = list.json().result.items.find((c) => c.slug === DEMO);
    assert.equal(demo.demo, true);
    assert.ok(!('demo' in list.json().result.items.find((c) => c.slug === EVENT)));
  });
});
