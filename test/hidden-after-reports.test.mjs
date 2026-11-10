// Profiles hidden after reports, and sample profiles, run against the in-memory stand-in for
// Elasticsearch in test/lib/fake-es.mjs. Run with `npm test`; nothing reaches the network.
//
// The tests check that the push nudge (server/nudge.mjs)
// - sends nothing at all when the person whose presence was written is hidden after reports or is
//   a sample profile, and runs no query for them;
// - never pairs a real attendee with a sample profile that is around in the same zone;
// - still nudges an ordinary pair, and the push never carries a spot line.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fake, EVENT, FUTURE, newDevice, request, profileBody } from './lib/fake-es.mjs';

const { handlePeopleApi } = await import('../server/people.mjs');
const { nudgeAfterPresence } = await import('../server/nudge.mjs');

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
  fake.put('caddie-people-push', `push-${d.profileId}`, { event_id: EVENT, profile_id: d.profileId, endpoint: `https://push.example.test/${d.profileId}`, keys_p256dh: 'B'.repeat(87), keys_auth: 'a'.repeat(22), expires_at: FUTURE });
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
    await nudgeAfterPresence(me, CONF);
    assert.equal(nudgeRecords().length, 1);
    assert.equal(fake.pushes.length, 2, 'both people are nudged');
    for (const p of fake.pushes) {
      assert.match(p.payload.body, /^Someone who's worked on .+ is in Hall A right now$/);
      assert.ok(!JSON.stringify(p.payload).includes(SPOT), 'no spot line in a push');
    }
  });

  test('a trigger hidden after reports sends nothing and runs no query', async () => {
    const { me } = await pair({ trigger: { hidden: true } });
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
    assert.equal(fake.peopleSearches().length, 0);
  });

  test('a trigger hidden after reports with its spot hidden too sends nothing', async () => {
    const { me } = await pair({ trigger: { hidden: true, spot_hidden: true, presence_spot: null } });
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
  });

  test('a sample trigger sends nothing and runs no query', async () => {
    const { me } = await pair({ trigger: { sample: true } });
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
    assert.equal(fake.peopleSearches().length, 0);
  });

  test('a sample profile around in the same zone is never paired with a real attendee', async () => {
    const { me } = await pair({ other: { sample: true } });
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
  });

  test('a match hidden after reports is never paired', async () => {
    const { me } = await pair({ other: { hidden: true } });
    await nudgeAfterPresence(me, CONF);
    assert.equal(fake.pushes.length, 0);
    assert.equal(nudgeRecords().length, 0);
  });
});
