// Profile deletes that hid the profile and then failed, and were never tried again: the hourly
// purge in server/people.mjs and the purge CLI finish them, the export leaves them out, and no
// route acts for such a profile. Blocks expire with their conference.
//
// Run with `npm test`. The server modules talk to the in-memory stand-in of
// test/helpers/fake-es.mjs through a stubbed fetch; the two CLI scripts run as child processes
// with dummy env values and talk to the same stand-in over loopback HTTP. Nothing reaches the
// network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, FUTURE, newDevice, personId, addPerson,
  addConnections, request, quietly, serve, HIDDEN_FOR_DELETE,
} from './helpers/fake-es.mjs';

const people = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');

before(() => bootPurgeDone());

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile);
const PAST = new Date(Date.now() - 3600_000).toISOString();

// A pending delete (hidden, with every connection), a visible profile and a circle-only profile
// (not visible conference-wide, sharing a talk), which is a legitimate profile, not a pending
// delete.
function setup() {
  const cluster = useCluster(new FakeES());
  const pending = newDevice();
  addPerson(cluster, pending, { display_name: 'Pending', ...HIDDEN_FOR_DELETE });
  const ids = addConnections(cluster, pending.profileId);
  const visible = newDevice();
  addPerson(cluster, visible, { display_name: 'Visible' });
  const circle = newDevice();
  addPerson(cluster, circle, { display_name: 'Circle only', open_to_meet: false, presence_zone: null, presence_until: null, ble_token: null, ble_token_until: null });
  const seqs = () => [visible, circle].map((d) => cluster.docs(INDEX.people).get(personId(d.profileId)).seq);
  return { cluster, pending, visible, circle, ids, seqs };
}

function assertFinished(cluster, pending, ids) {
  assert.equal(cluster.source(INDEX.people, personId(pending.profileId)), null, 'the pending profile is deleted');
  for (const meet of ids.meets) assert.equal(cluster.source(INDEX.meets, meet), null, `${meet} is deleted`);
  assert.equal(cluster.ids(INDEX.push).length, 0, 'the push subscription is deleted');
  assert.equal(cluster.ids(INDEX.nudges).length, 0, 'the nudge record is deleted');
  for (const block of ids.ownBlocks) assert.equal(cluster.source(INDEX.blocks, block), null, 'a block the person made is deleted');
  assert.ok(cluster.source(INDEX.blocks, ids.blockedBy), 'a block someone else made of the person is kept');
  assert.ok(cluster.source(INDEX.meets, ids.unrelatedMeet), 'a meet between two other people is kept');
}

function assertKept(cluster, pending, ids) {
  const p = cluster.source(INDEX.people, personId(pending.profileId));
  assert.ok(p, 'the re-enabled profile is kept');
  assert.equal(p.open_to_meet, true);
  for (const block of ids.ownBlocks) assert.ok(cluster.source(INDEX.blocks, block), 'the re-enabled profile keeps every block it made');
}

// Nothing that connects the person to others was touched.
function assertUntouched(cluster, ids) {
  for (const meet of ids.meets) assert.ok(cluster.source(INDEX.meets, meet), `${meet} is kept`);
  assert.equal(cluster.ids(INDEX.push).length, 1, 'the push subscription is kept');
  assert.equal(cluster.ids(INDEX.nudges).length, 1, 'the nudge record is kept');
  for (const name of ['meets', 'push', 'nudges', 'blocks']) assert.ok(!cluster.tags().includes(`search:${name}`), `no ${name} were looked at`);
}

// The owner makes the hidden profile visible again (a profile write) right after the purge found it.
const reEnable = (pending) => (c) => c.patch(INDEX.people, personId(pending.profileId), { open_to_meet: true, shared_talk_ids: [`${EVENT}:talk1`] });

describe('the hourly purge (server/people.mjs)', () => {
  test('finishes a pending delete: meets, push and nudges, then the document, then the blocks it made', async () => {
    const { cluster, pending, ids, seqs } = setup();
    const before = seqs();
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assertFinished(cluster, pending, ids);
    assert.deepEqual(seqs(), before, 'the visible and the circle-only profiles are untouched');
    const tags = cluster.tags();
    const docAt = tags.indexOf('delete-doc');
    for (const name of ['meets', 'push', 'nudges']) assert.ok(tags.indexOf(`bulk:${name}`) < docAt, `${name} go before the document`);
    assert.ok(tags.indexOf('bulk:blocks') > docAt, 'the blocks go after the document');
    const del = cluster.calls('delete-doc')[0];
    assert.ok(del.params.has('if_seq_no') && del.params.has('if_primary_term'), 'the document delete is guarded');
    assert.deepEqual(tags.slice(0, 2), ['search:pending', 'get'], 'a realtime read comes before anything is deleted');
    assert.deepEqual(cluster.calls('search:pending')[0].body.sort, [{ updated_at: 'asc' }, { profile_id: 'asc' }]);
    assert.deepEqual(lines, ['Finished 1 pending profile deletes.']);
  });

  test('a profile its owner made visible again after the search is not touched at all', async () => {
    const { cluster, pending, ids } = setup();
    cluster.after('search:pending', 1, reEnable(pending));
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assertKept(cluster, pending, ids);
    assertUntouched(cluster, ids);
    assert.ok(!cluster.tags().includes('delete-doc'), 'the document delete was not tried');
    assert.deepEqual(lines, ['Kept 1 pending profile deletes that changed since they were found.']);
  });

  test('a profile its owner made visible again after the realtime read is kept, with its blocks', async () => {
    const { cluster, pending, ids } = setup();
    cluster.after('get', 1, reEnable(pending));
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assertKept(cluster, pending, ids);
    assert.ok(!cluster.tags().includes('search:blocks'), 'no block was looked at');
    assert.deepEqual(lines, ['Kept 1 pending profile deletes that changed since they were found.']);
  });

  test("a document the owner's own retry deleted in the meantime (a guarded delete answers 409) still loses its blocks", async () => {
    const { cluster, pending, ids } = setup();
    cluster.before('delete-doc', 1, (c) => c.docs(INDEX.people).delete(personId(pending.profileId)));
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assertFinished(cluster, pending, ids);
    assert.deepEqual(lines, ['Finished 1 pending profile deletes.']);
  });

  test('a profile re-created from the same device right after the delete keeps the blocks', async () => {
    const { cluster, pending, ids } = setup();
    cluster.after('delete-doc', 1, (c) => addPerson(c, pending, { display_name: 'Back again' }));
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assert.equal(cluster.source(INDEX.people, personId(pending.profileId)).display_name, 'Back again');
    for (const block of ids.ownBlocks) assert.ok(cluster.source(INDEX.blocks, block), 'the blocks are kept');
    assert.deepEqual(lines, ['Finished 1 pending profile deletes.']);
  });

  test('pages through more pending deletes than fit in one search', async () => {
    const cluster = useCluster(new FakeES());
    const devices = Array.from({ length: 101 }, () => newDevice());
    devices.forEach((d, i) => addPerson(cluster, d, { ...HIDDEN_FOR_DELETE, updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const { lines } = await quietly(() => people.finishPendingDeletes());
    assert.equal(cluster.ids(INDEX.people).length, 0, 'every pending delete is finished');
    const searches = cluster.calls('search:pending');
    assert.equal(searches.length, 2);
    assert.equal(searches[0].body.search_after, undefined);
    assert.ok(Array.isArray(searches[1].body.search_after), 'the second page starts after the first');
    assert.deepEqual(lines, ['Finished 101 pending profile deletes.']);
  });

  test('a failure leaves the pending document for the next run, which finishes it', async () => {
    const { cluster, pending, ids } = setup();
    cluster.fail({ tag: 'search:push', how: 503 });
    const first = await quietly(() => people.finishPendingDeletes());
    assert.ok(cluster.source(INDEX.people, personId(pending.profileId)), 'the document is kept');
    assert.ok(cluster.source(INDEX.blocks, ids.ownBlocks[0]), 'its blocks are kept');
    assert.deepEqual(first.lines, ['Finishing a pending profile delete failed: status 503']);
    await quietly(() => people.finishPendingDeletes());
    assertFinished(cluster, pending, ids);
  });

  test('runs on every purge, which also deletes blocks whose conference has ended and keeps blocks without expires_at', async () => {
    const { cluster, pending, ids } = setup();
    const block = (blocker, blocked, extra) => ({ event_id: EVENT, blocker_id: blocker, blocked_id: blocked, blocked_ref: 'ffffffffffffffff', created_at: PAST, ...extra });
    cluster.put(INDEX.blocks, 'ended', block('a', 'b', { expires_at: PAST }));
    cluster.put(INDEX.blocks, 'legacy', block('c', 'd', {}));
    await quietly(() => people.purgeExpired());
    assertFinished(cluster, pending, ids);
    assert.equal(cluster.source(INDEX.blocks, 'ended'), null, 'a block whose conference has ended is deleted');
    assert.ok(cluster.source(INDEX.blocks, 'legacy'), 'a block without expires_at is left alone');
    assert.ok(cluster.source(INDEX.blocks, ids.unrelatedBlock), 'a block that has not run out is kept');
  });
});

describe('the hourly purge of Bluetooth caps records (server/people.mjs)', () => {
  const caps = (at) => ({ ble_caps: [{ ref: '0123456789abcdef', at, w: 1 }], ble_caps_until: new Date(at + 3600_000).toISOString() });

  test('clears a record whose newest entry is more than an hour old, with a guarded update, and keeps a recent one', async () => {
    const cluster = useCluster(new FakeES());
    const [old, recent] = [newDevice(), newDevice()];
    addPerson(cluster, old, caps(Date.now() - 2 * 3600_000));
    addPerson(cluster, recent, caps(Date.now() - 60_000));
    await quietly(() => people.purgeExpired());
    const cleared = cluster.source(INDEX.people, personId(old.profileId));
    assert.equal(cleared.ble_caps, null);
    assert.equal(cleared.ble_caps_until, null);
    assert.equal(cleared.display_name, 'Test person', 'only the record is cleared');
    assert.equal(cluster.source(INDEX.people, personId(recent.profileId)).ble_caps.length, 1, 'a recent record is kept');
    const [action] = cluster.calls('update').map((c) => JSON.parse(c.body.split('\n')[0]).update);
    assert.ok(Number.isInteger(action.if_seq_no) && Number.isInteger(action.if_primary_term), 'the clear is guarded');
  });

  test('keeps a record that a sightings answer wrote after the search found it', async () => {
    const cluster = useCluster(new FakeES());
    const device = newDevice();
    addPerson(cluster, device, caps(Date.now() - 2 * 3600_000));
    const fresh = caps(Date.now());
    cluster.after('search:caps', 1, (c) => c.patch(INDEX.people, personId(device.profileId), fresh));
    await quietly(() => people.purgeExpired());
    assert.deepEqual(cluster.source(INDEX.people, personId(device.profileId)).ble_caps, fresh.ble_caps);
  });
});

describe('a pending delete is treated as gone', () => {
  test('its owner gets profile_required from the routes that need a profile', async () => {
    const { pending } = setup();
    const inbox = await quietly(() => request(handleConnectApi, 'GET', `/api/meet/inbox?event=${EVENT}`, pending));
    assert.equal(inbox.result.status, 403);
    assert.deepEqual(inbox.result.body, { error: 'profile_required' });
    const blocks = await quietly(() => request(handleConnectApi, 'GET', `/api/people/blocks?event=${EVENT}`, pending));
    assert.equal(blocks.result.status, 403);
  });

  test('a meet with someone whose delete is pending is left out of the inbox', async () => {
    const { cluster, pending, visible } = setup();
    cluster.put(INDEX.meets, 'meet-pending', {
      event_id: EVENT, meet_id: 'meet-pending', participants: [pending.profileId, visible.profileId], requester_id: pending.profileId,
      state: 'requested', expires_at: new Date(Date.now() + 600_000).toISOString(), created_at: new Date().toISOString(), spot_me: {}, spot_me_pending: {},
    });
    const { result } = await quietly(() => request(handleConnectApi, 'GET', `/api/meet/inbox?event=${EVENT}`, visible));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { incoming: [], outgoing: [] });
  });
});

// Runs a CLI script against the cluster with dummy env values only, and returns its stdout.
async function runScript(cluster, script, args = [], env = { ES_PEOPLE_API_KEY: 'test-people-key' }) {
  const server = await serve(cluster);
  try {
    const { stdout } = await execFileP(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ES_URL: server.url, ...env },
      timeout: 30_000,
    });
    return stdout;
  } finally {
    await server.close();
  }
}

describe('npm run people:purge (scripts/purge-expired-people.mjs)', () => {
  test('finishes a pending delete, keeps everyone else, and deletes blocks whose conference has ended', async () => {
    const { cluster, pending, ids, seqs } = setup();
    cluster.put(INDEX.blocks, 'ended', { event_id: EVENT, blocker_id: 'a', blocked_id: 'b', blocked_ref: 'ffffffffffffffff', created_at: PAST, expires_at: PAST });
    cluster.put(INDEX.blocks, 'legacy', { event_id: EVENT, blocker_id: 'c', blocked_id: 'd', blocked_ref: 'ffffffffffffffff', created_at: PAST });
    const lapsed = newDevice();
    const caps = [{ ref: '0123456789abcdef', at: Date.now() - 60_000, w: 1 }];
    addPerson(cluster, lapsed, { display_name: 'Lapsed', presence_spot_pending: true, presence_until: PAST, ble_token_until: PAST, presence_nonce: 'AAECAwQFBgcICQoLDA0ODw', ble_master_id: 'm1', ble_caps: caps });
    const before = seqs();
    const out = await runScript(cluster, 'purge-expired-people.mjs');
    const lapsedDoc = cluster.source(INDEX.people, personId(lapsed.profileId));
    for (const [field, value] of Object.entries(HIDDEN_FOR_DELETE)) {
      if (field.startsWith('presence_') || field.startsWith('ble_')) assert.equal(lapsedDoc[field], value, `${field} is cleared with run-out presence`);
    }
    assert.equal(lapsedDoc.presence_nonce, null, 'the derived-token nonce is cleared with run-out presence');
    assert.equal(lapsedDoc.ble_master_id, null, 'and so is the id of its master');
    assert.deepEqual(lapsedDoc.ble_caps, caps, 'the caps record outlives the presence session');
    assert.match(out, /Finished 1 pending profile deletes\./);
    assertFinished(cluster, pending, ids);
    assert.deepEqual(seqs(), before, 'the visible and the circle-only profiles are untouched');
    assert.equal(cluster.source(INDEX.blocks, 'ended'), null);
    assert.ok(cluster.source(INDEX.blocks, 'legacy'));
    const del = cluster.calls('delete-doc')[0];
    assert.ok(del.params.has('if_seq_no') && del.params.has('if_primary_term'), 'the document delete is guarded');
  });

  test('clears Bluetooth caps records whose newest entry is more than an hour old, and keeps recent ones', async () => {
    const cluster = useCluster(new FakeES());
    const [old, recent] = [newDevice(), newDevice()];
    const caps = (at) => ({ ble_caps: [{ ref: '0123456789abcdef', at, w: 1 }], ble_caps_until: new Date(at + 3600_000).toISOString() });
    addPerson(cluster, old, caps(Date.now() - 2 * 3600_000));
    addPerson(cluster, recent, caps(Date.now() - 60_000));
    const out = await runScript(cluster, 'purge-expired-people.mjs');
    assert.match(out, /Cleared 1 run-out Bluetooth caps records\./);
    const cleared = cluster.source(INDEX.people, personId(old.profileId));
    assert.equal(cleared.ble_caps, null);
    assert.equal(cleared.ble_caps_until, null);
    assert.equal(cluster.source(INDEX.people, personId(recent.profileId)).ble_caps.length, 1);
  });

  test('does not touch a profile whose owner made it visible again after the script found it', async () => {
    const { cluster, pending, ids } = setup();
    cluster.after('search:pending', 1, reEnable(pending));
    const out = await runScript(cluster, 'purge-expired-people.mjs');
    assert.match(out, /kept 1 that changed/);
    assertKept(cluster, pending, ids);
    for (const meet of ids.meets) assert.ok(cluster.source(INDEX.meets, meet), `${meet} is kept`);
    assert.equal(cluster.ids(INDEX.push).length, 1, 'the push subscription is kept');
    assert.equal(cluster.ids(INDEX.nudges).length, 1, 'the nudge record is kept');
  });

  test("still deletes the blocks of a document the owner's own retry deleted in the meantime", async () => {
    const { cluster, pending, ids } = setup();
    cluster.before('delete-doc', 1, (c) => c.docs(INDEX.people).delete(personId(pending.profileId)));
    const out = await runScript(cluster, 'purge-expired-people.mjs');
    assert.match(out, /Finished 1 pending profile deletes\./);
    assertFinished(cluster, pending, ids);
  });
});

describe('npm run people:setup (scripts/es-setup-people.mjs) on an existing blocks index', () => {
  test('maps expires_at, indexes it where blocks carry it, and gives older blocks the end of their conference', async () => {
    const cluster = useCluster(new FakeES());
    const block = (event, extra = {}) => ({ event_id: event, blocker_id: 'a', blocked_id: 'b', blocked_ref: 'ffffffffffffffff', created_at: PAST, ...extra });
    cluster.put(INDEX.blocks, 'old', block(EVENT));
    cluster.put(INDEX.blocks, 'new', block(EVENT, { expires_at: '2100-01-01T00:00:00.000Z' }));
    cluster.put(INDEX.blocks, 'unknown', block('no-such-conference'));
    cluster.put(INDEX.meets, 'meet', { event_id: EVENT, meet_id: 'meet' });
    addPerson(cluster, newDevice());
    const args = ['caddie-people', '--alias', '', '--lexical-only'];
    const env = { ES_PEOPLE_API_KEY: '', ELASTISEARCH_API_KEY: 'test-admin-key' };
    const out = await runScript(cluster, 'es-setup-people.mjs', args, env);
    assert.ok(cluster.mappings.some((m) => m.index === INDEX.blocks && m.properties.expires_at?.type === 'date'), 'expires_at is mapped');
    // The Bluetooth fields: never indexed, searchable or aggregatable, except the date the purge
    // finds run-out caps records by.
    const peopleMapping = cluster.mappings.find((m) => m.index === INDEX.people)?.properties ?? {};
    for (const f of ['presence_nonce', 'ble_master_id']) assert.deepEqual(peopleMapping[f], { type: 'keyword', index: false, doc_values: false }, f);
    assert.deepEqual(peopleMapping.ble_rotated, { type: 'boolean', index: false, doc_values: false });
    assert.deepEqual(peopleMapping.ble_caps, { type: 'object', enabled: false });
    assert.deepEqual(peopleMapping.ble_caps_until, { type: 'date' });
    const updates = cluster.updates.filter((u) => u.index === INDEX.blocks);
    assert.equal(updates[0].body.script, undefined, 'the first update re-indexes blocks as they are');
    assert.equal(cluster.source(INDEX.blocks, 'old').expires_at, FUTURE, 'an older block gets the end of its conference');
    assert.equal(cluster.source(INDEX.blocks, 'new').expires_at, '2100-01-01T00:00:00.000Z', 'a block that has expires_at keeps it');
    assert.equal(cluster.source(INDEX.blocks, 'unknown').expires_at, undefined, 'a block of an unknown conference is left without');
    assert.match(out, /Left 1 blocks of no-such-conference without expires_at/);

    const again = await runScript(cluster, 'es-setup-people.mjs', args, env);
    assert.doesNotMatch(again, /Gave \d+ blocks/, 'a second run has nothing to backfill');
  });
});

describe('npm run people:export (scripts/export-people.mjs)', () => {
  test('leaves out profiles whose delete is pending, and secrets, presence and the Bluetooth token', async () => {
    const slug = `export-test-${crypto.randomBytes(4).toString('hex')}`;
    const cluster = useCluster(new FakeES());
    const [visible, circle, pending] = [newDevice(), newDevice(), newDevice()];
    // The derived-token session and the caps record would let the key be rebuilt with the master
    // secret, or tell whom Bluetooth returned; none of it is exported (docs/contracts/ble-tokens.md).
    const bluetooth = { presence_nonce: 'AAECAwQFBgcICQoLDA0ODw', ble_master_id: 'm1', ble_caps: [{ ref: '0123456789abcdef', at: Date.now(), w: 1 }] };
    addPerson(cluster, visible, { event_id: slug, display_name: 'Visible', ...bluetooth });
    addPerson(cluster, circle, { event_id: slug, display_name: 'Circle only', open_to_meet: false, ...bluetooth });
    addPerson(cluster, pending, { event_id: slug, display_name: 'Pending', ...HIDDEN_FOR_DELETE });
    const dir = path.join(ROOT, 'data', 'exports');
    const file = path.join(dir, `people-${slug}.ndjson`);
    const dirExisted = fs.existsSync(dir);
    try {
      const out = await runScript(cluster, 'export-people.mjs', ['--event', slug]);
      assert.match(out, /Wrote 2 profiles/);
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(rows.map((r) => r.display_name).sort(), ['Circle only', 'Visible']);
      for (const row of rows) {
        for (const key of Object.keys(row)) assert.ok(!/^(secret_hash|text_hash|presence_|ble_)/.test(key), `${key} is not exported`);
        for (const key of ['presence_nonce', 'ble_master_id', 'ble_caps', 'ble_token', 'ble_token_until']) assert.equal(key in row, false, `${key} is not exported`);
      }
      const excludes = cluster.calls('search:people')[0]?.body?._source?.excludes ?? [];
      for (const key of ['presence_nonce', 'ble_master_id', 'ble_caps']) assert.ok(excludes.includes(key), `the export names ${key} among its exclusions`);
    } finally {
      fs.rmSync(file, { force: true });
      if (!dirExisted) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the pending-delete query and isPendingDelete agree, and a circle-only or visible profile is never pending', () => {
  const cases = [
    [{ open_to_meet: false, shared_talk_ids: [] }, true],
    [{ open_to_meet: false }, true],
    [{ open_to_meet: false, shared_talk_ids: ['t'] }, false],
    [{ open_to_meet: true, shared_talk_ids: [] }, false],
    [{ shared_talk_ids: [] }, false],
  ];
  const cluster = new FakeES();
  for (const [source, pending] of cases) {
    assert.equal(people.isPendingDelete(source), pending, JSON.stringify(source));
    const id = crypto.randomBytes(4).toString('hex');
    cluster.put(INDEX.people, id, source);
    assert.equal(cluster.find(INDEX.people, people.PENDING_DELETE_QUERY).some(([found]) => found === id), pending, `query: ${JSON.stringify(source)}`);
  }
});
