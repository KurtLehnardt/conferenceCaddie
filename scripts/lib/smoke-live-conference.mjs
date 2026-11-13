// Which conference the clock-dependent checks of scripts/smoke.mjs run against, and which topics they
// ask For you for there. Pure decisions, taking the clock and injected loaders so they can be tested.
//
// For you and Happening now only return talks whose end is after now (the server and the Worker filter
// with end > now), so once a conference is over a check that needs suggestions has nothing to assert.
// The content checks stay on the primary conference (SMOKE_CONFERENCE), whose talks, titles and topics
// they name. The checks that only need talks still to come run against a "live" conference, picked
// once when the run starts:
//   1. SMOKE_LIVE_CONFERENCE when it is set: it must be a searchable conference of GET /api/conferences;
//   2. else the primary conference, when it has talks to come;
//   3. else the first searchable conference of GET /api/conferences, in the order it lists them, whose
//      expected talks (the published bundle, or data/ with SMOKE_TALKS=data) have talks to come;
//   4. else none, and those checks print SKIP with the reason (never PASS).
// A conference has talks to come when at least one item of kind talk ends LIVE_MARGIN_MS or more after
// now, so a conference picked at the start still has suggestions when its checks run minutes later.

import { countUpcoming } from './smoke-topic-pick.mjs';

export const LIVE_MARGIN_MS = 15 * 60_000;
// For you answers at most 50 talks per leg (RANK_WINDOW of worker/src/talks/recommend.js and
// server/recommend.mjs) and the smoke asks for size 50.
export const FOR_YOU_WINDOW = 50;
// A conference's listed end_date is a local date: its last talk ends at the latest 36 hours after that
// date's UTC midnight (the date's end at UTC-12, with time to spare).
const END_DATE_SLACK_MS = 36 * 3600_000;

const talkOnly = (docs) => (docs ?? []).filter((d) => d?.kind === 'talk');

// The talks of a conference whose end is more than marginMs after nowMs.
export function talksToCome(docs, nowMs, marginMs = LIVE_MARGIN_MS) {
  return talkOnly(docs).filter((d) => Date.parse(d.end) > nowMs + marginMs).length;
}

// Why a conference whose expected talks are `docs` has no talks to come, in the words of a SKIP reason.
// A conference whose list can be read but holds no talk has none to come either.
export function noTalksToComeWhy(slug, docs, nowMs, marginMs = LIVE_MARGIN_MS) {
  const talks = talkOnly(docs);
  if (!talks.length) return `${slug} has no talks`;
  if (!talks.some((d) => Date.parse(d.end) > nowMs)) return `every talk of ${slug} has ended`;
  return `every talk of ${slug} has ended or ends within ${Math.round(marginMs / 60_000)} minutes`;
}

// Picks the live conference. conferences: the GET /api/conferences list (each { slug, status, end_date });
// conferencesKnown is false when that list could not be read. loadTalks(slug): resolves to the
// conference's expected items (every kind) or rejects when they cannot be read. now(): the clock, read
// afresh for each conference. Returns
//   { slug, source: 'override' | 'primary' | 'fallback' | 'none', why, error?, primary }
// slug is null when no conference qualifies; why then is the SKIP reason. error is set only for an
// SMOKE_LIVE_CONFERENCE that is not a searchable conference, which the smoke reports as a FAIL.
// primary is { known, toCome, why } at the time of the pick. A primary whose talks cannot be read
// counts as live, as before this file: the check runs rather than couple the smoke to the bundle host.
export async function pickLiveConference({ primary, override = '', conferences, conferencesKnown = true, loadTalks, now = Date.now, marginMs = LIVE_MARGIN_MS }) {
  const searchable = (conferences ?? []).filter((c) => c?.status === 'searchable');
  const look = async (slug) => {
    try {
      const docs = await loadTalks(slug);
      const at = now();
      const toCome = talksToCome(docs, at, marginMs);
      return { known: true, toCome, why: toCome ? '' : noTalksToComeWhy(slug, docs, at, marginMs) };
    } catch (err) {
      return { known: false, toCome: null, why: `its talks could not be read: ${err?.message ?? err}` };
    }
  };
  const own = await look(primary);
  const primaryState = { known: own.known, toCome: own.toCome, why: own.why };
  const unread = 'GET /api/conferences could not be read';

  if (override) {
    if (conferencesKnown && !searchable.some((c) => c.slug === override)) {
      const error = `SMOKE_LIVE_CONFERENCE=${override} is not a searchable conference of GET /api/conferences`;
      return { slug: null, source: 'override', why: error, error, primary: primaryState };
    }
    const s = override === primary ? own : await look(override);
    const unchecked = conferencesKnown ? '' : ` (${unread}, so it is not checked to be searchable)`;
    if (s.known && !s.toCome) return { slug: null, source: 'override', why: `${s.why} (SMOKE_LIVE_CONFERENCE)`, primary: primaryState };
    return { slug: override, source: 'override', why: `${s.known ? `SMOKE_LIVE_CONFERENCE, ${s.toCome} talks to come` : `SMOKE_LIVE_CONFERENCE; ${s.why}, so it is taken as live`}${unchecked}`, primary: primaryState };
  }

  if (!own.known || own.toCome) {
    return { slug: primary, source: 'primary', why: own.known ? `the primary conference, ${own.toCome} talks to come` : `the primary conference; ${own.why}, so it is taken as live`, primary: primaryState };
  }
  if (!conferencesKnown) return { slug: null, source: 'none', why: `${own.why} and ${unread}, so no other conference could be looked for`, primary: primaryState };

  const passed = [];
  for (const c of searchable) {
    if (c.slug === primary) continue;
    // A conference whose listed last day is well past is not read: its bundle would only say so.
    if (typeof c.end_date === 'string' && Date.parse(`${c.end_date}T00:00:00Z`) + END_DATE_SLACK_MS < now()) {
      passed.push(`${c.slug}: ended on ${c.end_date}`);
      continue;
    }
    const s = await look(c.slug);
    if (s.known && s.toCome) {
      const over = passed.length ? `; passed over: ${passed.join('; ')}` : '';
      return { slug: c.slug, source: 'fallback', why: `${own.why}; ${c.slug} is the first searchable conference of GET /api/conferences with talks to come (${s.toCome})${over}`, primary: primaryState };
    }
    passed.push(`${c.slug}: ${s.why}`);
  }
  return { slug: null, source: 'none', why: `${own.why} and no other searchable conference has talks to come`, primary: primaryState };
}

// ---------------------------------------------------------------------------------------------
// The topics the For-you checks ask with on the live conference, taken from its own data: the topic
// list (GET /api/topics, [{ topic_id, label }]) and the schedule (GET /api/schedule talks, each with its
// end and topics). Never from For you's own answers, so a For you that answers nothing fails the checks
// instead of making them skip.

// A talk's topic ids, from the schedule's [{ topic_id, label }] or a bare id list.
export const topicIdsOf = (talk) => [...new Set((talk.topics ?? []).map((t) => (typeof t === 'string' ? t : t?.topic_id)).filter(Boolean))];
const withIds = (talks) => talks.map((t) => ({ ...t, topics: topicIdsOf(t).map((topic_id) => ({ topic_id })) }));

// The listed topics with at least one talk ending after cutoffMs, most such talks first (the topic
// list's order among equals): [{ topic_id, label, upcoming }].
export function rankTopics(talks, topics, cutoffMs) {
  const shaped = withIds(talks);
  return topics
    .map((t, i) => ({ topic_id: t.topic_id, label: t.label, upcoming: countUpcoming(shaped, t.topic_id, cutoffMs), i }))
    .filter((t) => t.upcoming > 0)
    .sort((a, b) => b.upcoming - a.upcoming || a.i - b.i)
    .map(({ i, ...t }) => t);
}

// topic_id -> Set of the other topic ids that share a talk ending after cutoffMs with it.
export function cooccurring(talks, cutoffMs) {
  const out = new Map();
  for (const t of talks) {
    if (!(Date.parse(t.end) > cutoffMs)) continue;
    const ids = topicIdsOf(t);
    for (const a of ids) {
      if (!out.has(a)) out.set(a, new Set());
      for (const b of ids) if (b !== a) out.get(a).add(b);
    }
  }
  return out;
}

// True when a For-you request with learn topics `learn` (no text, size FOR_YOU_WINDOW) must return a
// talk that carries `leftOut` and ends after cutoffMs, whatever order the server gives talks of equal
// score. Both tiers score a talk by the number of learn topics it carries and keep the best
// FOR_YOU_WINDOW of the talks whose end is after now; talks only leave that pool as time passes, so a
// talk that is certain to be in the answer now stays so until it ends.
export function returnsLeftOut(talks, learn, leftOut, nowMs, cutoffMs, window = FOR_YOU_WINDOW) {
  const want = new Set(learn);
  const pool = talks
    .filter((t) => Date.parse(t.end) > nowMs)
    .map((t) => ({ t, ids: topicIdsOf(t) }))
    .map((x) => ({ ...x, n: x.ids.filter((id) => want.has(id)).length }))
    .filter((x) => x.n > 0);
  const carrying = pool.filter((x) => x.ids.includes(leftOut) && Date.parse(x.t.end) > cutoffMs);
  if (!carrying.length) return false;
  const best = Math.max(...carrying.map((x) => x.n));
  return pool.filter((x) => x.n >= best).length <= window;
}

// The original choice of check r3 on KubeCon: leave Kubernetes out and ask for AI and agents.
export const PREFERRED_LEAVE_OUT = Object.freeze({ leftOut: 'kubernetes', learn: Object.freeze(['ai', 'agents']) });

// Check r3's request: a topic to leave out and one or two learn topics (not it) such that the answer
// must carry the left-out topic (returnsLeftOut), so the check has teeth. Tried in this order: the
// preferred case; the preferred left-out topic with others; then each topic with talks to come, most
// first, with the two topics sharing a talk to come with it that have the most talks to come, then each
// of those alone. sharedWith is a learn topic that shares a talk to come with the left-out one (r6
// learns it). null when no listed topic can be left out that way.
export function leaveOutCase(talks, topics, nowMs, cutoffMs, preferred = PREFERRED_LEAVE_OUT) {
  const listed = new Set(topics.map((t) => t.topic_id));
  const co = cooccurring(talks, cutoffMs);
  const ranked = rankTopics(talks, topics, cutoffMs).map((t) => t.topic_id);
  const found = (leftOut, learn) => ({ leftOut, learn, sharedWith: learn.find((id) => co.get(leftOut)?.has(id)) });
  const tryLeftOut = (x, first = []) => {
    const sharing = ranked.filter((id) => id !== x && co.get(x)?.has(id));
    for (const learn of [first, sharing.slice(0, 2), ...sharing.map((id) => [id])]) {
      if (learn.length && !learn.includes(x) && returnsLeftOut(talks, learn, x, nowMs, cutoffMs)) return found(x, [...learn]);
    }
    return null;
  };
  if (listed.has(preferred.leftOut)) {
    const first = preferred.learn.every((id) => listed.has(id)) ? preferred.learn : [];
    const hit = tryLeftOut(preferred.leftOut, first);
    if (hit) return hit;
  }
  for (const x of ranked) {
    if (x === preferred.leftOut) continue;
    const hit = tryLeftOut(x);
    if (hit) return hit;
  }
  return null;
}

// Check r4's [learn, speak] requests: the r3 roles (left-out X, learn Y1 and Y2), two other topics with
// talks to come asked with a third and X spoken, and the first eight of the topic list. Without r3
// roles the ranked topics stand in. Requests with no learn topic are dropped.
export function whyCases(ranked, topicIds, leave) {
  const x = leave?.leftOut ?? ranked[0];
  const [y1, y2] = leave?.learn ?? ranked.filter((id) => id !== x).slice(0, 2);
  const others = ranked.filter((id) => id !== x && id !== y1 && id !== y2);
  const cases = [
    [[y1, y2], [x]],
    [[x], [y1]],
    [[others[0], others[1]], [others[2], x]],
    [[x, y1], [x]],
    [topicIds.slice(0, 5), topicIds.slice(3, 8)],
  ];
  return cases.map(([learn, speak]) => [learn.filter(Boolean), speak.filter(Boolean)]).filter(([learn]) => learn.length > 0);
}
