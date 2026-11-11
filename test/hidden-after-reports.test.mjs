// Profiles hidden after reports, and sample profiles, run against the in-memory stand-in for
// Elasticsearch in test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// The tests check that the push nudge (server/nudge.mjs)
// - sends nothing at all when the person whose presence was written is hidden after reports or is
//   a sample profile, and runs no query for them;
// - never pairs a real attendee with a sample profile that is around in the same zone;
// - still nudges an ordinary pair, and the push never carries a spot line;
// and that PUT /api/people/profile, when it creates or fully reindexes a profile document, sets
// hidden and spot_hidden again from the reports on file (which outlive the document), so turning
// both visibility choices off and on does not undo a hide; that it answers hidden_for_owner to
// match; and that it fails closed when the reports cannot be counted: a reindex keeps the stored
// flags, and a create is refused rather than made visible.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, FUTURE, newDevice, request, profileBody, esError } from './lib/fake-es.mjs';

const { handlePeopleApi } = await import('../server/people.mjs');
const { handleConnectApi } = await import('../server/connect.mjs');
const { nudgeAfterPresence } = await import('../server/nudge.mjs');
// The pause between the two pushes of a pair, which these tests do not wait for.
const NO_PAUSE = { pause: async () => {} };
const { refFor } = await import('../server/device.mjs');

const CONF = { slug: EVENT, timeZone: 'UTC', visibleUntil: FUTURE };
const SPOT = 'blue cap by the coffee';
const docOf = (d) => fake.doc('caddie-people', `${EVENT}:${d.profileId}`);
const put = (d, name, o) => request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody(name, o));

// Puts a person around in Hall A with a spot line and a push subscription, straight into the
// stand-in, and sets any extra fields (hidden, sample).
function around(d, extra = {}) {
  const id = `${EVENT}:${d.profileId}`;
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  fake.put('caddie-people', id, { ...fake.doc('caddie-people', id), presence_zone: 'Hall A', presence_spot: SPOT, presence_since: new Date().toISOString(), presence_until: until, ...extra });
  fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://fcm.googleapis.com/fcm/send/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
}

// The trigger T (expertise eBPF) and a strong match V (wants to learn eBPF), both around.
async function pair({ trigger = {}, other = {} } = {}) {
  fake.reset();
  const t = newDevice();
  const v = newDevice();
  assert.equal((await put(t, 'Harry', { expertise: 'ABUSIVE-TEXT eBPF probes in production', speak: ['ebpf'] })).status, 200);
  assert.equal((await put(v, 'Vic', { expertise: 'Postgres operators', interests: 'ebpf probes', learn: ['ebpf'] })).status, 200);
  around(t, trigger);
  around(v, other);
  fake.calls.length = 0;
  return { t, v, me: { ...docOf(t) } };
}

const nudgeRecords = () => [...fake.store('caddie-people-nudges').keys()];

describe('push nudge', () => {
  test('an ordinary strong match in the same zone is nudged, without any spot line', async () => {
    const { me } = await pair();
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(nudgeRecords().length, 1);
    assert.equal(fake.pushes.length, 2, 'both people are nudged');
    for (const p of fake.pushes) {
      assert.match(p.payload.body, /^Someone who's worked on .+ is in Hall A right now$/);
      assert.ok(!JSON.stringify(p.payload).includes(SPOT), 'no spot line in a push');
    }
  });

  test('a trigger hidden after reports sends nothing and runs no query', async () => {
    const { me } = await pair({ trigger: { hidden: true } });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
    assert.equal(fake.peopleSearches().length, 0);
  });

  test('a trigger hidden after reports with its spot hidden too sends nothing', async () => {
    const { me } = await pair({ trigger: { hidden: true, spot_hidden: true, presence_spot: null } });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
  });

  test('a sample trigger sends nothing and runs no query', async () => {
    const { me } = await pair({ trigger: { sample: true } });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
    assert.equal(fake.peopleSearches().length, 0);
  });

  test('a sample profile around in the same zone is never paired with a real attendee', async () => {
    const { me } = await pair({ other: { sample: true } });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
  });

  test('a match hidden after reports is never paired', async () => {
    const { me } = await pair({ other: { hidden: true } });
    await nudgeAfterPresence(me, CONF, NO_PAUSE);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
  });
});

// Report documents as server/report.mjs writes them, straight into the stand-in.
function reports(d, kind, n, event = EVENT) {
  const ref = refFor(EVENT, d.profileId);
  for (let i = 0; i < n; i++) {
    fake.put('caddie-people-reports', `${kind}:${ref}:reporter${i}:${event}`, { event_id: event, target_kind: kind, target_id: ref, target_profile_id: d.profileId, reporter_id: `reporter${i}`, reason: 'hate', created_at: new Date().toISOString() });
  }
}
const H_TEXT = { expertise: 'eBPF probes in production', speak: ['ebpf'] };
const offAndOn = async (d, o = H_TEXT) => {
  assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody('Harry', o, false))).status, 200);
  assert.equal(docOf(d), undefined, 'both choices off deletes the document');
  return request(handlePeopleApi, 'PUT', '/api/people/profile', d, profileBody('Harry', o));
};
const seenBy = async (viewer) => (await request(handlePeopleApi, 'POST', '/api/people/matches', viewer, { event: EVENT, interested_talk_ids: [] })).body.results.map((p) => p.display_name);
async function quietly(fn) {
  const lines = [];
  const spy = mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}
// Fails every search of the reports index with a 503.
const failReportCounts = () => {
  fake.inject = (c) => (c.index === 'caddie-people-reports' && c.op === '_search' ? esError(503, 'injected') : undefined);
};

describe('hidden after reports survives deleting and re-making the profile', () => {
  test('two profile reports on file: the re-made profile is hidden, and says so to its owner', async () => {
    fake.reset();
    const h = newDevice();
    const v = newDevice();
    assert.equal((await put(v, 'Vic', { learn: ['ebpf'] })).status, 200);
    assert.equal((await put(h, 'Harry', H_TEXT)).status, 200);
    reports(h, 'profile', 2);
    const again = await offAndOn(h);
    assert.equal(again.status, 200);
    assert.equal(again.body.hidden_for_owner, true);
    assert.equal(docOf(h).hidden, true);
    assert.ok(!(await seenBy(v)).includes('Harry'), 'Vic does not see Harry');
  });

  test('one report, or reports from another conference, do not hide', async () => {
    fake.reset();
    const h = newDevice();
    reports(h, 'profile', 1);
    reports(h, 'spot', 3, 'otherconf-2099');
    const made = await request(handlePeopleApi, 'PUT', '/api/people/profile', h, profileBody('Harry', H_TEXT));
    assert.equal(made.status, 200);
    assert.equal(made.body.hidden_for_owner, false);
    assert.equal(docOf(h).hidden, false);
    assert.equal(docOf(h).spot_hidden, false);
  });

  test('two spot reports on file: spot_hidden again, and presence stores no spot line', async () => {
    fake.reset();
    const h = newDevice();
    reports(h, 'spot', 2);
    const made = await request(handlePeopleApi, 'PUT', '/api/people/profile', h, profileBody('Harry', H_TEXT));
    assert.equal(made.status, 200);
    assert.equal(made.body.hidden_for_owner, false);
    assert.equal(docOf(h).spot_hidden, true);
    const p = await request(handleConnectApi, 'PUT', '/api/presence', h, { event: EVENT, zone: 'Hall A', spot: 'green scarf' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.status, 200);
    assert.equal(p.body.spot, null);
    assert.equal(p.body.spot_hidden, true);
    assert.equal(docOf(h).presence_spot, null);
  });

  test('a full reindex hides a profile whose reports reached the threshold even if the flag was lost', async () => {
    fake.reset();
    const h = newDevice();
    assert.equal((await put(h, 'Harry', H_TEXT)).status, 200);
    reports(h, 'profile', 2);
    const r = await put(h, 'Harry', { ...H_TEXT, about: 'changed, so this is a full reindex' });
    assert.equal(r.status, 200);
    assert.equal(r.body.hidden_for_owner, true);
    assert.equal(docOf(h).hidden, true);
  });

  test('when counting fails, a full reindex keeps a stored hide and logs only a status', async () => {
    fake.reset();
    const h = newDevice();
    assert.equal((await put(h, 'Harry', H_TEXT)).status, 200);
    const id = `${EVENT}:${h.profileId}`;
    fake.put('caddie-people', id, { ...docOf(h), hidden: true, spot_hidden: true });
    failReportCounts();
    const { result, lines } = await quietly(() => put(h, 'Harry', { ...H_TEXT, about: 'a full reindex' }));
    assert.equal(result.status, 200);
    assert.equal(result.body.hidden_for_owner, true);
    assert.equal(docOf(h).hidden, true);
    assert.equal(docOf(h).spot_hidden, true);
    assert.deepEqual(lines, ['Counting reports failed; keeping the stored flags: status 503']);
  });

  test('when counting fails, re-making a deleted profile is refused rather than made visible', async () => {
    fake.reset();
    const h = newDevice();
    assert.equal((await put(h, 'Harry', H_TEXT)).status, 200);
    reports(h, 'profile', 2);
    assert.equal((await request(handlePeopleApi, 'PUT', '/api/people/profile', h, profileBody('Harry', H_TEXT, false))).status, 200);
    failReportCounts();
    const { result } = await quietly(() => request(handlePeopleApi, 'PUT', '/api/people/profile', h, profileBody('Harry', H_TEXT)));
    assert.equal(result.status, 502);
    assert.equal(docOf(h), undefined, 'no document was created');
    fake.inject = null;
    const retry = await request(handlePeopleApi, 'PUT', '/api/people/profile', h, profileBody('Harry', H_TEXT));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.hidden_for_owner, true);
  });
});
