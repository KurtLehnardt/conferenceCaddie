// POST /api/recommendations (For you), ported from server/recommend.mjs (PLAN section 1.7).
//
// Talks are recommended only from what the person wants to learn: reciprocal rank fusion (rank
// constant 60, window 50, both weight 1) of
//   - a topics leg: talks sharing any learn topic, more shared learn topics first;
//   - a semantic leg: the interests text against the talk title and chunk vectors, top 50.
// speak_topics and expertise are still validated, so old clients keep working, but ignored.
// Filter: kind talk, end in the future, not one of interested_talk_ids. When the embedding is
// unavailable the interests text is matched by keywords in memory (title weighted 2, abstract,
// "2<60%") and the response carries degraded.semantic. The reasons name only learn topics of this
// request. Nothing is stored and nothing from the request is logged.

import { bad, isPlainObject } from '../lib/http.js';
import { escapeHtml, queryTerms } from '../lib/text.js';
import { embedQuery, EmbedUnavailable } from '../lib/embed.js';
import { rrf } from '../lib/vectors.js';
import { memo, talkOnly } from './cache.js';
import { memoryLexical } from './lexical.js';
import { termSet } from './analyze.js';
import { bestChunk, semanticTop } from './search.js';
import { cleanTags, labelledTopics, trimText } from './shape.js';

const TOP_KEYS = new Set(['event', 'learn_topics', 'speak_topics', 'interests', 'expertise', 'interested_talk_ids', 'size']);
const RANK_WINDOW = 50;
const SEMANTIC_K = 50;
const PASSAGE_MAX = 200;
const EVIDENCE_MAX = 300;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const TOPIC_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u;

export function validEvent(value) {
  if (typeof value !== 'string') throw bad('event must be a string');
  if (!SLUG_RE.test(value)) throw bad('event is not valid');
  return value;
}

export function validTalkIds(value, name, max = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((id) => typeof id === 'string' && TALK_ID_RE.test(id))) {
    throw bad(`${name} must be at most ${max} talk ids`);
  }
  return [...new Set(value)];
}

function validTopicIds(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 30 || !value.every((t) => typeof t === 'string' && TOPIC_ID_RE.test(t))) {
    throw bad(`${name} must be at most 30 topic ids`);
  }
  return [...new Set(value)];
}

function validText(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 500) throw bad(`${name} must be a string of at most 500 characters`);
  return value.replace(/\s+/g, ' ').trim();
}

export function validate(body) {
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  let size = 10;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1 || body.size > 50) throw bad('size must be an integer from 1 to 50');
    size = body.size;
  }
  validTopicIds(body.speak_topics, 'speak_topics');
  validText(body.expertise, 'expertise');
  return {
    event: validEvent(body.event),
    learn: validTopicIds(body.learn_topics, 'learn_topics'),
    interests: validText(body.interests, 'interests'),
    interestedIds: validTalkIds(body.interested_talk_ids, 'interested_talk_ids'),
    size,
  };
}

// The keyword stand-in for the semantic leg: title (weight 2) and abstract word sets.
const titleAbstractIndex = (store) => memo(store, 'recLexMem', () => talkOnly(store).map((t) => ({
  talk: t,
  title: termSet(t.title),
  other: termSet(t.abstract),
})));

const byStart = (a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0) || (a.talk_id < b.talk_id ? -1 : a.talk_id > b.talk_id ? 1 : 0);

export async function recommend(ctx, p) {
  const store = ctx.store;
  const skip = new Set(p.interestedIds);
  const pool = talkOnly(store).filter((t) => t.end_ms > ctx.now && !skip.has(t.talk_id));
  const lists = [];
  if (p.learn.length) {
    const want = new Set(p.learn);
    const scored = [];
    for (const t of pool) {
      let n = 0;
      for (const id of t.topics) if (want.has(id)) n += 1;
      if (n) scored.push({ t, n });
    }
    scored.sort((a, b) => b.n - a.n || byStart(a.t, b.t));
    lists.push(scored.slice(0, RANK_WINDOW).map((x) => x.t));
  }
  let q = null;
  let degraded = false;
  if (p.interests) {
    try {
      q = await embedQuery(ctx, p.interests);
      lists.push(semanticTop(store, q, pool, SEMANTIC_K).map((x) => x.talk));
    } catch (err) {
      if (!(err instanceof EmbedUnavailable)) throw err;
      degraded = true;
      const inPool = new Set(pool);
      const entries = titleAbstractIndex(store).filter((e) => inPool.has(e.talk));
      lists.push(memoryLexical(store, queryTerms(p.interests), entries).slice(0, RANK_WINDOW).map((x) => x.talk));
    }
  }
  const byId = new Map(lists.flat().map((t) => [t.talk_id, t]));
  const fused = rrf(lists.map((l) => l.map((t) => t.talk_id)), { window: RANK_WINDOW }).slice(0, p.size).map((e) => byId.get(e.id));

  const labels = store.topics().labels;
  const counts = store.circleCounts(fused.map((t) => t.talk_id));
  const results = fused.map((t) => {
    const chunk = q ? bestChunk(store, q, t) : null;
    const passage = chunk ? trimText(chunk, PASSAGE_MAX) : null;
    const learnMatched = p.learn.filter((id) => t.topics.includes(id) && labels.has(id)).map((id) => labels.get(id));
    return {
      talk_id: t.talk_id,
      conference: t.conference,
      title: t.title ?? '',
      speakers: t.speakers ?? [],
      room: t.room ?? null,
      start: t.start,
      end: t.end,
      track: t.track,
      level: t.level ?? null,
      tags: cleanTags(t.tags),
      slides_url: t.slides_url ?? null,
      url: t.url,
      evidence: escapeHtml(passage ?? trimText(t.abstract || t.title || '', EVIDENCE_MAX)),
      topics: labelledTopics(t.topics, labels),
      speaker_profiles: t.speaker_profiles ?? [],
      why: { topics: learnMatched, learn_topics: learnMatched, passage },
      circle_count: counts[t.talk_id] ?? 0,
    };
  });
  return { results, degraded };
}
