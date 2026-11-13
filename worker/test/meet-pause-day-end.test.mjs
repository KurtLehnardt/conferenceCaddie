// POST /api/meet after three "Not now" replies today, on the Worker: 429 paused, whose retry_at and
// Retry-After point at midnight in the conference's time zone (nextDayStart), when the count starts
// again: normally one second after the day's end (dayBounds, 23:59:59.000), and an hour after it
// where daylight saving time ends at midnight west of UTC. An ask refused in the last second of a
// day is not told to retry at a time that has already passed, and an ask made at retry_at goes
// through. The same rule and cases as tier 3 (test/meet-pause-day-end.test.mjs).
//
// ConferenceDO runs in Node on node:sqlite (helpers/harness.mjs), on a pinned clock in 2099.
// module.registerHooks needs Node 22.15 or later; on older versions these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skip, ConferenceDO, fakeState, withFixedClock } from './helpers/harness.mjs';

const SLUG = 'caddie-fixture-2099';
const MIN = 60_000;
const PAUSED = 'Three people said not now today. You can ask again tomorrow.';
const ENV = { EMBED_FAKE: '1' };

let ipCounter = 0;
const device = (c) => ({ id: c.repeat(22), secret: c.repeat(43) });

async function call(obj, method, path, body, d) {
  const headers = { 'content-type': 'application/json', 'x-caddie-slug': SLUG, 'x-caddie-ip': `192.0.2.${(ipCounter++ % 200) + 1}` };
  if (d) headers['x-caddie-device'] = `${d.id}.${d.secret}`;
  const res = await obj.fetch(new Request(`https://do.internal${path}?event=${SLUG}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json, headers: res.headers };
}

// A conference in `timeZone` with two people who are around, and three asks of the first that
// were declined at `declinedAt`, each by someone else.
async function setup(timeZone, declinedAt) {
  const state = fakeState();
  const obj = new ConferenceDO(state, ENV);
  const doc = { slug: SLUG, name: 'Fixture', status: 'searchable', start_date: '2099-01-01', end_date: '2099-12-31', time_zone: timeZone };
  const put = await obj.fetch(new Request('https://do.internal/internal/conference', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-caddie-slug': SLUG }, body: JSON.stringify({ doc, route_prefix: 'Abc123' }),
  }));
  assert.equal(put.status, 200);
  const [me, them] = [device('a'), device('b')];
  for (const [d, name] of [[me, 'Ada Lovelace'], [them, 'Grace Hopper']]) {
    const profile = await call(obj, 'PUT', '/api/people/profile', { event: SLUG, profile: { display_name: name, about: `${name} works on compilers.` }, open_to_meet: true, shared_talk_ids: [] }, d);
    assert.equal(profile.status, 200, JSON.stringify(profile.json));
    const on = await call(obj, 'PUT', '/api/presence', { event: SLUG, zone: 'Hallway', until: 'hour' }, d);
    assert.equal(on.status, 200, JSON.stringify(on.json));
  }
  const insert = state.db.prepare('INSERT INTO meets (meet_id, requester_id, recipient_id, state, created_at_ms, expires_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const n of [1, 2, 3]) insert.run(`declined-${n}`, me.id, `other${n}`.padEnd(22, 'x'), 'declined', declinedAt - 5 * MIN, declinedAt + 10 * MIN, declinedAt);
  const ref = obj.store.person(them.id).ref;
  return { ask: () => call(obj, 'POST', '/api/meet', { event: SLUG, ref, topic_id: null, note: '' }, me) };
}

const LA = 'America/Los_Angeles';
// Daylight saving time ends at midnight in Santiago: on 4 April 2099 the hour from 23:00 comes
// twice (UTC-3, then UTC-4, from 03:00Z), and 5 April starts at 04:00Z. On 5 September it starts
// at midnight: 6 September starts at 04:00Z, as 01:00 at UTC-3.
const SANTIAGO = 'America/Santiago';
// [time zone, the clock, retry_at, Retry-After in seconds]
const CASES = [
  ['UTC', '2099-11-12T10:00:00.000Z', '2099-11-13T00:00:00.000Z', '50400'],
  ['UTC', '2099-11-12T23:59:58.000Z', '2099-11-13T00:00:00.000Z', '2'],
  ['UTC', '2099-11-12T23:59:59.000Z', '2099-11-13T00:00:00.000Z', '1'],
  ['UTC', '2099-11-12T23:59:59.500Z', '2099-11-13T00:00:00.000Z', '1'],
  ['UTC', '2099-11-12T23:59:59.999Z', '2099-11-13T00:00:00.000Z', '1'],
  [LA, '2099-11-13T00:00:00.000Z', '2099-11-13T08:00:00.000Z', '28800'],
  [LA, '2099-11-13T07:59:59.500Z', '2099-11-13T08:00:00.000Z', '1'],
  [SANTIAGO, '2099-04-05T02:30:00.000Z', '2099-04-05T04:00:00.000Z', '5400'],
  [SANTIAGO, '2099-04-05T03:30:00.000Z', '2099-04-05T04:00:00.000Z', '1800'],
  [SANTIAGO, '2099-09-06T03:30:00.000Z', '2099-09-06T04:00:00.000Z', '1800'],
];

for (const [timeZone, clock, retryAt, retryAfter] of CASES) {
  test(`at ${clock} the fourth ask in ${timeZone} is paused until ${retryAt}`, { skip }, async () => {
    const now = Date.parse(clock);
    await withFixedClock(now, async () => {
      const s = await setup(timeZone, now - 1000);
      const res = await s.ask();
      assert.equal(res.status, 429, JSON.stringify(res.json));
      assert.deepEqual(res.json, { error: 'paused', message: PAUSED, retry_at: retryAt });
      assert.equal(res.headers.get('retry-after'), retryAfter);
      assert.ok(Date.parse(res.json.retry_at) > now, 'retry_at is still ahead');
    });
  });
}

test('an ask made at retry_at goes through, and one a millisecond before it is still paused', { skip }, async () => {
  for (const [timeZone, declinedAt, retryAt] of [
    ['UTC', Date.parse('2099-11-12T23:59:59.500Z'), Date.parse('2099-11-13T00:00:00.000Z')],
    [LA, Date.parse('2099-11-13T07:59:59.500Z'), Date.parse('2099-11-13T08:00:00.000Z')],
    [SANTIAGO, Date.parse('2099-04-05T03:30:00.000Z'), Date.parse('2099-04-05T04:00:00.000Z')],
  ]) {
    await withFixedClock(retryAt - 1, async () => {
      const s = await setup(timeZone, declinedAt);
      assert.equal((await s.ask()).status, 429, `${timeZone}: 1 ms before retry_at`);
    });
    await withFixedClock(retryAt, async () => {
      const s = await setup(timeZone, declinedAt);
      const res = await s.ask();
      assert.equal(res.status, 200, `${timeZone}: at retry_at, ${JSON.stringify(res.json)}`);
      assert.equal(res.json.state, 'requested');
    });
  }
});
