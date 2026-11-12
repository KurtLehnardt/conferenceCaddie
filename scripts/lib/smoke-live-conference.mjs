// Which conference the clock-dependent checks of scripts/smoke.mjs run against, and which topics they
// ask For you for there. Pure decisions, taking `nowMs` and injected loaders so they can be tested.
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

const talkOnly = (docs) => (docs ?? []).filter((d) => d?.kind === 'talk');

// The talks of a conference whose end is more than marginMs after nowMs.
export function talksToCome(docs, nowMs, marginMs = LIVE_MARGIN_MS) {
  return talkOnly(docs).filter((d) => Date.parse(d.end) > nowMs + marginMs).length;
}

// Why a conference whose expected talks are `docs` has no talks to come, in the words of a SKIP reason.
export function noTalksToComeWhy(slug, docs, nowMs, marginMs = LIVE_MARGIN_MS) {
  const talks = talkOnly(docs);
  if (!talks.length) return `${slug} has no talks`;
  if (!talks.some((d) => Date.parse(d.end) > nowMs)) return `every talk of ${slug} has ended`;
  return `every talk of ${slug} has ended or ends within ${Math.round(marginMs / 60_000)} minutes`;
}

// Picks the live conference. conferences: the GET /api/conferences list (each { slug, status }).
// loadTalks(slug): resolves to the conference's expected items (every kind) or rejects when they cannot
// be read. Returns
//   { slug, source: 'override' | 'primary' | 'fallback' | 'none', why, error?, primary }
// slug is null when no conference qualifies; why then is the SKIP reason. error is set only for an
// SMOKE_LIVE_CONFERENCE that is not a searchable conference, which the smoke reports as a FAIL.
// primary is { known, toCome, why }: the primary conference's own state, which the checks that stay
// on it (the fallback ended-skip) read. A primary whose talks cannot be read counts as live, as before
// this file: the check runs rather than couple the smoke to the bundle host being up.
export async function pickLiveConference({ primary, override = '', conferences, loadTalks, nowMs, marginMs = LIVE_MARGIN_MS }) {
  const searchable = (conferences ?? []).filter((c) => c?.status === 'searchable').map((c) => c.slug);
  const look = async (slug) => {
    try {
      const docs = await loadTalks(slug);
      const toCome = talksToCome(docs, nowMs, marginMs);
      return { known: true, toCome, why: toCome ? '' : noTalksToComeWhy(slug, docs, nowMs, marginMs) };
    } catch (err) {
      return { known: false, toCome: null, why: `its talks could not be read: ${err?.message ?? err}` };
    }
  };
  const own = await look(primary);
  const primaryState = { known: own.known, toCome: own.toCome, why: own.why };

  if (override) {
    if (!searchable.includes(override)) {
      const error = `SMOKE_LIVE_CONFERENCE=${override} is not a searchable conference of GET /api/conferences`;
      return { slug: null, source: 'override', why: error, error, primary: primaryState };
    }
    const s = override === primary ? own : await look(override);
    if (s.known && !s.toCome) return { slug: null, source: 'override', why: `${s.why} (SMOKE_LIVE_CONFERENCE)`, primary: primaryState };
    return { slug: override, source: 'override', why: s.known ? `SMOKE_LIVE_CONFERENCE, ${s.toCome} talks to come` : `SMOKE_LIVE_CONFERENCE; ${s.why}, so it is taken as live`, primary: primaryState };
  }

  if (!own.known || own.toCome) {
    return { slug: primary, source: 'primary', why: own.known ? `the primary conference, ${own.toCome} talks to come` : `the primary conference; ${own.why}, so it is taken as live`, primary: primaryState };
  }

  const passed = [];
  for (const slug of searchable) {
    if (slug === primary) continue;
    const s = await look(slug);
    if (s.known && s.toCome) {
      const over = passed.length ? `; passed over: ${passed.join('; ')}` : '';
      return { slug, source: 'fallback', why: `${own.why}; ${slug} is the first searchable conference of GET /api/conferences with talks to come (${s.toCome})${over}`, primary: primaryState };
    }
    passed.push(`${slug}: ${s.why}`);
  }
  return { slug: null, source: 'none', why: `${own.why} and no other searchable conference has talks to come`, primary: primaryState };
}

// ---------------------------------------------------------------------------------------------
// The topics the For-you checks ask with on the live conference, taken from its own data.
//
// A probe is the For-you answer to learn_topics [topic_id] (size 50) for one of the conference's
// topics, in its topic list's order: { topic_id, label, results }. Every result carries its talk's
// topics, so the probes say which topics still have talks to come and which topics share one.

// The probed topics with at least one talk ending after cutoffMs, most such talks first (the topic
// list's order among equals): [{ topic_id, label, upcoming }].
export function rankTopics(probes, cutoffMs) {
  return probes
    .map((p, i) => ({ topic_id: p.topic_id, label: p.label, upcoming: countUpcoming(p.results ?? [], p.topic_id, cutoffMs), i }))
    .filter((t) => t.upcoming > 0)
    .sort((a, b) => b.upcoming - a.upcoming || a.i - b.i)
    .map(({ i, ...t }) => t);
}

// topic_id -> Set of the other topic ids that share a talk ending after cutoffMs with it.
export function cooccurring(probes, cutoffMs) {
  const out = new Map();
  for (const p of probes) {
    for (const r of p.results ?? []) {
      if (!(Date.parse(r.end) > cutoffMs)) continue;
      const ids = (r.topics ?? []).map((t) => t.topic_id);
      for (const a of ids) {
        if (!out.has(a)) out.set(a, new Set());
        for (const b of ids) if (b !== a) out.get(a).add(b);
      }
    }
  }
  return out;
}

// The original choice of check r3 on KubeCon: leave Kubernetes out and ask for AI and agents.
export const PREFERRED_LEAVE_OUT = Object.freeze({ leftOut: 'kubernetes', learn: Object.freeze(['ai', 'agents']) });

// Check r3's request: a topic to leave out and one or two learn topics that share a talk to come with
// it, so a talk carrying the left-out topic is among the suggestions and the check has teeth.
// The preferred case is kept when the conference lists its three topics and one of its learn topics
// shares a talk to come with the left-out one; otherwise the topic with the most talks to come that
// shares one with another, with up to two of those others (most talks to come first). null when no
// talk to come carries two probed topics.
export function leaveOutCase(probes, cutoffMs, topicIds, preferred = PREFERRED_LEAVE_OUT) {
  const listed = new Set(topicIds);
  const co = cooccurring(probes, cutoffMs);
  const ranked = rankTopics(probes, cutoffMs).map((t) => t.topic_id);
  const withLeftOut = co.get(preferred.leftOut);
  if ([preferred.leftOut, ...preferred.learn].every((id) => listed.has(id)) && preferred.learn.some((id) => withLeftOut?.has(id))) {
    return { leftOut: preferred.leftOut, learn: [...preferred.learn] };
  }
  for (const x of ranked) {
    const sharing = ranked.filter((id) => id !== x && co.get(x)?.has(id));
    if (sharing.length) return { leftOut: x, learn: sharing.slice(0, 2) };
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
