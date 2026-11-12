import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_UPCOMING, countUpcoming, pickUpcomingTopic } from '../scripts/lib/smoke-topic-pick.mjs';

const c = (topic_id, upcoming) => ({ topic_id, label: topic_id, upcoming });

test('pickUpcomingTopic takes the topic with the most upcoming talks', () => {
  assert.equal(pickUpcomingTopic([c('a', 3), c('b', 9), c('c', 5)]).topic_id, 'b');
});
test('pickUpcomingTopic keeps the first of equals', () => {
  assert.equal(pickUpcomingTopic([c('a', 4), c('b', 4)]).topic_id, 'a');
});
test('pickUpcomingTopic needs at least MIN_UPCOMING and else returns null', () => {
  assert.equal(MIN_UPCOMING, 3);
  assert.equal(pickUpcomingTopic([c('a', 2), c('b', 0)]), null);
  assert.equal(pickUpcomingTopic([]), null);
  assert.equal(pickUpcomingTopic([c('a', 2), c('b', 3)]).topic_id, 'b');
});
test('countUpcoming counts talks that end after now and carry the topic', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const r = (end, ...ids) => ({ end, topics: ids.map((topic_id) => ({ topic_id })) });
  const results = [r('2026-11-11T13:00:00Z', 'ebpf'), r('2026-11-11T12:00:00Z', 'ebpf'), r('2026-11-11T11:00:00Z', 'ebpf'), r('2026-11-12T11:00:00Z', 'k8s'), { end: '2026-11-12T11:00:00Z' }];
  assert.equal(countUpcoming(results, 'ebpf', now), 1);
  assert.equal(countUpcoming(results, 'k8s', now), 1);
});
