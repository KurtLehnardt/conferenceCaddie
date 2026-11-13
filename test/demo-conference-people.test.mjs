// The demo conference's people on tier 3: its end date rolls forward every day, so what is written
// with the end of the conference (a profile's visible_until) lasts DEMO_GRACE_DAYS longer for it, and
// a profile saved for it the day before a demonstration is not purged on the day. A real conference
// keeps the end of its last day.
//
// Run with `npm test`. The in-memory stand-in of test/lib/fake-es.mjs answers every Elasticsearch
// call; nothing reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, newDevice, request, profileBody } from './lib/fake-es.mjs';

const { handlePeopleApi, conferenceFor } = await import('../server/people.mjs');
const { visibleUntil, DEMO_GRACE_DAYS } = await import('../server/people-shared.mjs');

const DEMO = 'caddie-demo-conference';

test('a demo conference\'s profiles last DEMO_GRACE_DAYS after its rolling end; a real conference\'s do not', async () => {
  fake.reset();
  fake.put('caddie-conferences', DEMO, { slug: DEMO, status: 'searchable', demo: true, source: 'demo', start_date: '2099-03-01', end_date: '2099-03-03', time_zone: 'America/Denver' });
  assert.equal(DEMO_GRACE_DAYS, 7);
  const demo = await conferenceFor(DEMO);
  assert.equal(demo.demo, true);
  assert.equal(demo.visibleUntil, '2099-03-11T05:59:59.000Z', '23:59:59 on 2099-03-10 in Denver (MDT)');
  assert.equal(demo.visibleUntil, visibleUntil('2099-03-10', 'America/Denver'));
  const real = await conferenceFor(EVENT);
  assert.equal(real.demo, false);
  assert.equal(real.visibleUntil, visibleUntil('2099-12-31', 'UTC'));

  const d = newDevice();
  const r = await request(handlePeopleApi, 'PUT', '/api/people/profile', d, { ...profileBody('Demo Person'), event: DEMO });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fake.doc('caddie-people', `${DEMO}:${d.profileId}`).visible_until, demo.visibleUntil);
});
