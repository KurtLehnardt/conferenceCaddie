// worker/ingest/push-ingest.mjs, worker/ingest/migrate-from-backup.mjs and the Worker's tombstones
// (W7.7, W8): PUT /admin/conferences answers the slugs it skipped because the operator removed them
// (skipped_retired); both scripts log each one by name and send nothing more for it, so an operator
// sees why a conference did not come back and a re-run cannot undo a removal. A recording stand-in
// for the admin routes; no network, no Worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertConferences, planPush, pushEvent, conferenceForWorker } from '../../worker/ingest/push-ingest.mjs';
import { send as migrate } from '../../worker/ingest/migrate-from-backup.mjs';
import { loadStoplist } from '../../worker/ingest/topics-local.mjs';

// A stand-in for the admin routes that records every call and answers PUT /admin/conferences with
// `answer`.
function fakeAdmin(answer) {
  const calls = [];
  const admin = async (method, url, body) => {
    calls.push({ method, url, body });
    return answer;
  };
  return { admin, calls };
}

const docs = [{ slug: 'kept-fixture-2099', status: 'searchable' }, { slug: 'gone-fixture-2099', status: 'searchable' }, { slug: 'also-gone-2099', status: 'unavailable' }];

test('each slug the Worker skipped as retired is logged by name and returned', async () => {
  const { admin, calls } = fakeAdmin({ upserted: 1, searchable: 1, synced: 1, skipped_retired: ['gone-fixture-2099', 'also-gone-2099'] });
  const lines = [];
  const skipped = await upsertConferences(admin, docs, (l) => lines.push(l));
  assert.deepEqual(calls, [{ method: 'PUT', url: '/admin/conferences', body: { conferences: docs } }]);
  assert.deepEqual(skipped, ['gone-fixture-2099', 'also-gone-2099']);
  assert.equal(lines[0], 'Conferences upserted: 1.');
  assert.equal(lines.length, 3);
  for (const slug of skipped) {
    const line = lines.find((l) => l.startsWith(`${slug}: skipped`));
    assert.ok(line, `no line for ${slug}`);
    assert.match(line, /removed/);
    assert.ok(line.includes(`conferences unretire --event ${slug}`), line);
  }
  assert.ok(!lines.some((l) => l.startsWith('kept-fixture-2099')), 'a stored conference is not reported as skipped');
});

test('an answer without skipped_retired (a Worker from before tombstones) skips nothing and logs only the count', async () => {
  for (const answer of [{ upserted: 3, searchable: 2, synced: 2 }, { upserted: 3, skipped_retired: [] }, { upserted: 3, skipped_retired: null }]) {
    const lines = [];
    assert.deepEqual(await upsertConferences(fakeAdmin(answer).admin, docs, (l) => lines.push(l)), []);
    assert.deepEqual(lines, ['Conferences upserted: 3.']);
  }
});

test('only well-formed slugs are logged or returned, each once', async () => {
  const lines = [];
  const skipped = await upsertConferences(
    fakeAdmin({ upserted: 0, skipped_retired: ['gone-fixture-2099', 'gone-fixture-2099', 'Bad Slug', 'x\nFAKE LOG LINE', '../etc', 42, null, { slug: 'y' }] }).admin,
    docs,
    (l) => lines.push(l),
  );
  assert.deepEqual(skipped, ['gone-fixture-2099']);
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.includes('FAKE LOG LINE') || l.includes('Bad Slug') || l.includes('../etc')));
});

// The admin routes push-ingest and the migration call, answering PUT /admin/conferences with
// `skipped` as skipped_retired, and the rest with plausible counts.
function recordingAdmin(skipped) {
  const calls = [];
  const admin = async (method, url, body) => {
    calls.push({ method, url, body });
    if (url === '/admin/conferences') return { upserted: body.conferences.length - skipped.length, searchable: 0, synced: 0, skipped_retired: skipped };
    if (method === 'GET') return { topics: [] };
    if (url.startsWith('/admin/talks/finalize')) return { talks: 1, deleted: 0, unshared: 0 };
    if (url.startsWith('/admin/talks')) return { upserted: body.talks.length, unchanged: 0, embedded: body.talks.length, pending: 0 };
    if (url.startsWith('/admin/topics')) return { topics: body.topics.length };
    if (url.startsWith('/admin/facets')) return { facets: body.facets.length };
    if (url.startsWith('/admin/people')) return { upserted: body.people.length, skipped: 0, embedded: 0, pending: 0 };
    return { inserted: (body.reports ?? []).length, skipped: 0 };
  };
  return { admin, calls };
}

const talk = (slug, n) => ({
  talk_id: `${slug}:${n}`, conference: slug, kind: 'talk', title: `Talk ${n} about Kubernetes scheduling`, abstract: 'An abstract.', speakers: [], speaker_taglines: [],
  speaker_profiles: [], tags: [], tag_keys: [], start: '2099-06-01T10:00:00Z', end: '2099-06-01T10:30:00Z',
});

test('planPush: a retired slug is neither upserted nor pushed, and is reported as skipped', () => {
  const sent = [{ slug: 'kept-2099', status: 'searchable' }, { slug: 'gone-2099', status: 'searchable' }, { slug: 'also-gone-2099', status: 'unavailable' }];
  const plan = planPush({ sent, searchable: sent.slice(0, 2), skipped: ['gone-2099', 'also-gone-2099'] });
  assert.deepEqual(plan, { upserted: ['kept-2099'], skipped_retired: ['gone-2099', 'also-gone-2099'], push: [sent[0]] });
  assert.deepEqual(planPush({ sent, searchable: sent.slice(0, 2), skipped: [] }).push, sent.slice(0, 2));
});

test('push-ingest never posts /admin/talks, topics or facets for a retired slug', async () => {
  const sent = [{ slug: 'kept-2099', status: 'searchable' }, { slug: 'gone-2099', status: 'searchable' }];
  const { admin, calls } = recordingAdmin(['gone-2099']);
  const lines = [];
  const plan = planPush({ sent, searchable: sent, skipped: await upsertConferences(admin, sent, (l) => lines.push(l)) });
  for (const conf of plan.push) await pushEvent(conf, { talks: [talk(conf.slug, 1), talk(conf.slug, 2), talk(conf.slug, 3)], dropped: 0, redacted: 0, entries: 0 }, { admin, dryRun: false, generation: 1, rebuild: false, stop: loadStoplist() });
  assert.ok(calls.some((c) => c.url === '/admin/talks?event=kept-2099'));
  assert.deepEqual(calls.filter((c) => c.url.includes('gone-2099')), []);
  assert.deepEqual([plan.upserted, plan.skipped_retired], [['kept-2099'], ['gone-2099']]);
  assert.ok(lines.some((l) => l.startsWith('gone-2099: skipped')));
});

test('migrate-from-backup sends nothing more for a slug the Worker skipped as retired, and names it', async () => {
  const byConf = (make) => new Map(['kept-2099', 'gone-2099'].map((slug) => [slug, make(slug)]));
  const plan = {
    conferences: { send: [{ slug: 'kept-2099' }, { slug: 'gone-2099' }] },
    talks: { byConf: byConf((slug) => [talk(slug, 1)]) },
    topics: { byConf: byConf((slug) => [{ topic_id: 'k8s', conference: slug }]) },
    facets: { byConf: byConf((slug) => [{ id: 'room:a', kind: 'room', conference: slug }]) },
    people: { byEvent: byConf((slug) => [{ profile_id: 'A'.repeat(22), event_id: slug }]) },
    reports: { byEvent: byConf((slug) => [{ target_kind: 'profile', event_id: slug }]) },
  };
  const { admin, calls } = recordingAdmin(['gone-2099', 'Bad\nslug', 7]);
  const lines = await migrate(plan, admin);
  assert.deepEqual(calls.filter((c) => c.url.includes('gone-2099')), []);
  for (const route of ['/admin/talks?', '/admin/talks/finalize?', '/admin/topics?', '/admin/facets?', '/admin/people?', '/admin/reports?']) {
    assert.ok(calls.some((c) => c.url === `${route}event=kept-2099`), route);
  }
  assert.equal(lines.filter((l) => l.startsWith('gone-2099: skipped')).length, 1);
  assert.ok(!lines.some((l) => l.includes('Bad')));
});

test('push-ingest never sends unretire, so a run of the ingest cannot bring a removed conference back', () => {
  const conf = { slug: 'gone-2099', status: 'searchable', unretire: true, counts: { sessions: 3, talk: 3 } };
  assert.deepEqual(conferenceForWorker(conf, undefined), { slug: 'gone-2099', status: 'searchable', counts: { sessions: 3, talk: 3 } });
  const prepared = { dropped: 1, talks: [talk('gone-2099', 1), talk('gone-2099', 2)] };
  const out = conferenceForWorker(conf, prepared);
  assert.ok(!('unretire' in out));
  assert.equal(out.counts.sessions, 2, 'the takedown recount still applies');
  assert.equal(conf.unretire, true, 'the local document is not changed');
});

test('migrate-from-backup skips a conference whose object answers "conference is not available", names it, and carries on', async () => {
  const byConf = (make) => new Map(['first-2099', 'bare-2099', 'last-2099'].map((slug) => [slug, make(slug)]));
  const plan = {
    talks: { byConf: byConf((slug) => [talk(slug, 1)]) },
    topics: { byConf: byConf((slug) => [{ topic_id: 'k8s', conference: slug }]) },
    people: { byEvent: byConf(() => [{ profile_id: 'A'.repeat(22) }]) },
  };
  const { admin: inner, calls } = recordingAdmin([]);
  const admin = async (method, url, body) => {
    if (url.includes('event=bare-2099')) {
      calls.push({ method, url, body });
      const err = new Error(`${method} ${url.split('?')[0]}: status 400 (conference is not available)`);
      err.status = 400;
      throw err;
    }
    return inner(method, url, body);
  };
  const lines = await migrate(plan, admin);
  // One refused call, then nothing more for that conference; the others get everything.
  assert.deepEqual(calls.filter((c) => c.url.includes('bare-2099')).map((c) => c.url), ['/admin/talks?event=bare-2099']);
  for (const slug of ['first-2099', 'last-2099']) {
    for (const route of ['/admin/talks?', '/admin/talks/finalize?', '/admin/topics?', '/admin/people?']) assert.ok(calls.some((c) => c.url === `${route}event=${slug}`), `${route} ${slug}`);
  }
  assert.equal(lines.filter((l) => l.startsWith('bare-2099: skipped') && l.includes('not available')).length, 1);
  // Any other failure still stops the run.
  const other = async () => {
    const err = new Error('PUT /admin/topics: status 409 (conflict)');
    err.status = 409;
    throw err;
  };
  await assert.rejects(migrate({ topics: { byConf: new Map([['x-2099', []]]) } }, other), /409/);
});
