// POST /api/meet after three "Not now" replies today (tier 3): 429 paused, whose retry_at and
// Retry-After point at midnight in the conference's time zone, when the count starts again. That
// is one second after the day's end (dayBounds, 23:59:59.000), so an ask refused in the last
// second of a day is not told to retry at a time that has already passed, and an ask made at
// retry_at goes through. The Worker keeps the same rule (worker/test/meet-pause-day-end.test.mjs).
//
// Run with `npm test`. The server modules talk to the in-memory stand-in of
// test/helpers/fake-es.mjs through a stubbed fetch; nothing reaches the network. Every test runs on
// a pinned clock in 2099, before the test conferences end.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeES, useCluster, bootPurgeDone, INDEX, EVENT, newDevice, personId, addPerson, refOf, request, quietly,
} from './helpers/fake-es.mjs';

const { handleConnectApi } = await import('../server/connect.mjs');

before(() => bootPurgeDone());

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const PAUSED = 'Three people said not now today. You can ask again tomorrow.';
// Beside the stand-in's own EVENT (in UTC), a conference in Los Angeles (UTC-8 in November). Every
// cluster holds both, so the server's conference cache answers the same whichever one filled it.
const LA_EVENT = 'testconf-la-2099';
const LA_CONFERENCE = { slug: LA_EVENT, status: 'searchable', end_date: '2099-12-31', time_zone: 'America/Los_Angeles' };

// Runs fn with Date.now pinned at `atMs` (the meet route and the stand-in read no other clock),
// and puts the real clock back after.
async function atClock(atMs, fn) {
  const realNow = Date.now;
  Date.now = () => atMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// Two people who are around at `event`, and three asks of the first that were declined at
// `declinedAt`, each by someone else.
function setup(event, declinedAt) {
  const cluster = useCluster(new FakeES());
  cluster.put(INDEX.conferences, LA_EVENT, LA_CONFERENCE);
  const [me, them] = [newDevice(), newDevice()];
  for (const device of [me, them]) {
    addPerson(cluster, device);
    if (event !== EVENT) {
      // addPerson stores the person at EVENT; the same document, moved to the other conference.
      const id = personId(device.profileId);
      const source = { ...cluster.source(INDEX.people, id), event_id: event };
      cluster.docs(INDEX.people).delete(id);
      cluster.put(INDEX.people, `${event}:${device.profileId}`, source);
    }
  }
  for (const n of [1, 2, 3]) {
    const id = `declined-${n}`;
    cluster.put(INDEX.meets, id, {
      event_id: event, meet_id: id, participants: [me.profileId, `other${n}`], requester_id: me.profileId, state: 'declined',
      created_at: iso(declinedAt - 5 * MIN), ended_at: iso(declinedAt), expires_at: iso(declinedAt + 10 * MIN),
    });
  }
  return { me, ref: refOf(them.profileId) };
}

// The answer to an ask, with its headers (request() keeps only the status and the body).
async function ask(event, me, ref) {
  let headers = {};
  const handler = (req, res, url) => {
    const writeHead = res.writeHead;
    res.writeHead = function (status, h = {}) {
      headers = h;
      return writeHead.call(this, status);
    };
    return handleConnectApi(req, res, url);
  };
  const { result } = await quietly(() => request(handler, 'POST', '/api/meet', me, { event, ref, topic_id: null, note: '' }));
  return { ...result, headers };
}

// [conference, the clock, retry_at, Retry-After in seconds]
const CASES = [
  [EVENT, '2099-11-12T10:00:00.000Z', '2099-11-13T00:00:00.000Z', '50400'],
  [EVENT, '2099-11-12T23:59:58.000Z', '2099-11-13T00:00:00.000Z', '2'],
  [EVENT, '2099-11-12T23:59:59.000Z', '2099-11-13T00:00:00.000Z', '1'],
  [EVENT, '2099-11-12T23:59:59.500Z', '2099-11-13T00:00:00.000Z', '1'],
  [EVENT, '2099-11-12T23:59:59.999Z', '2099-11-13T00:00:00.000Z', '1'],
  [LA_EVENT, '2099-11-13T00:00:00.000Z', '2099-11-13T08:00:00.000Z', '28800'],
  [LA_EVENT, '2099-11-13T07:59:59.500Z', '2099-11-13T08:00:00.000Z', '1'],
];

for (const [event, clock, retryAt, retryAfter] of CASES) {
  test(`at ${clock} the fourth ask at ${event} is paused until ${retryAt}`, async () => {
    const now = Date.parse(clock);
    await atClock(now, async () => {
      const { me, ref } = setup(event, now - 1000);
      const res = await ask(event, me, ref);
      assert.equal(res.status, 429, JSON.stringify(res.body));
      assert.deepEqual(res.body, { error: 'paused', message: PAUSED, retry_at: retryAt });
      assert.equal(res.headers['Retry-After'], retryAfter);
      assert.ok(Date.parse(res.body.retry_at) > now, 'retry_at is still ahead');
    });
  });
}

test('an ask made at retry_at goes through, and one a millisecond before it is still paused', async () => {
  for (const [event, declinedAt, retryAt] of [
    [EVENT, Date.parse('2099-11-12T23:59:59.500Z'), Date.parse('2099-11-13T00:00:00.000Z')],
    [LA_EVENT, Date.parse('2099-11-13T07:59:59.500Z'), Date.parse('2099-11-13T08:00:00.000Z')],
  ]) {
    await atClock(retryAt - 1, async () => {
      const { me, ref } = setup(event, declinedAt);
      assert.equal((await ask(event, me, ref)).status, 429, `${event}: 1 ms before retry_at`);
    });
    await atClock(retryAt, async () => {
      const { me, ref } = setup(event, declinedAt);
      const res = await ask(event, me, ref);
      assert.equal(res.status, 200, `${event}: at retry_at, ${JSON.stringify(res.body)}`);
      assert.equal(res.body.state, 'requested');
    });
  }
});
