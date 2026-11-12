// Check r1 of scripts/smoke.mjs needs a topic that still has talks to suggest. It marks the top two
// suggestions and expects the next first result to carry the topic, so it needs at least three
// upcoming talks (a talk "not ended" is one whose end is after now, as the server and the Worker
// decide it for For-you suggestions). The topic is chosen at run time, so a conference that has
// moved on does not fail the check on a topic that has run out.
export const MIN_UPCOMING = 3;

// candidates: [{ topic_id, label, upcoming }] in the order of preference (the topic list's order).
// Returns the candidate with the most upcoming talks, the first of equals, or null when none has
// MIN_UPCOMING or more.
export function pickUpcomingTopic(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!(c.upcoming >= MIN_UPCOMING)) continue;
    if (best === null || c.upcoming > best.upcoming) best = c;
  }
  return best;
}

// The upcoming talks of a result list that carry the topic: end after nowMs, topic_id on the talk.
export function countUpcoming(results, topicId, nowMs) {
  return results.filter((r) => Date.parse(r.end) > nowMs && (r.topics ?? []).some((t) => t.topic_id === topicId)).length;
}
