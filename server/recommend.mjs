// POST /api/recommendations: talks for you, from the topics and free text a client sends.
//
// Nothing is stored and nothing from the request body is logged. Elasticsearch does all the
// matching and ranking in one rrf retriever over the talks of one conference. This module builds
// the query, validates input, and reshapes hits in the order Elasticsearch returned them.
//
// Talks are recommended only from what the user wants to learn or the problems they face. There
// are two retrievers, each skipped when its input is empty:
//   learn_topics  against the talk "topics" field   weight 1
//   interests     against the talk "semantic" field weight 1 (the learn and problems free text)
//
// What a person can speak to is never a signal for talks. The request still accepts speak_topics
// and expertise so that cached clients keep working, but both are ignored.
//
// A talk that matches more of the learn topics scores higher, because each topic is its own
// constant-score clause.
//
// Reasons: why.learn_topics names the learn topics of this request that the talk has, and
// why.topics is kept equal to it for clients that predate the split. Nothing outside the request
// is ever named, and speak topics are never named.
//
// Filter: the conference, kind talk, end in the future, and not one of interested_talk_ids.
// The same filter is carried by the semantic (knn) retrievers so it applies before the
// nearest-neighbour search.
//
// Env: ES_URL, ES_API_KEY (talks and topics), ES_INDEX (default caddie-talks),
//      ES_TOPICS_INDEX (default caddie-topics), ES_PEOPLE_API_KEY and ES_PEOPLE_INDEX (default
//      caddie-people) for the circle counts.

import { take, clientIp } from './ratelimit.mjs';
import { conferencePreference, peoplePreference, withPreference } from './preference.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ES_API_KEY = process.env.ES_API_KEY || '';
const ES_PEOPLE_API_KEY = process.env.ES_PEOPLE_API_KEY || '';
const TALKS_INDEX = process.env.ES_INDEX || 'caddie-talks';
export const TOPICS_INDEX = process.env.ES_TOPICS_INDEX || 'caddie-topics';
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const ES_TIMEOUT_MS = 8000;

const MAX_BODY = 8192;
const RANK_WINDOW = 50;
const SEMANTIC_K = 50;
const SEMANTIC_CANDIDATES = 200;
const PASSAGE_MAX = 300;
const EVIDENCE_MAX = 300;
const RATE_PER_MIN = 60;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const TOPIC_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u;

export class BadRequest extends Error {}
export class UpstreamError extends Error {}

// ---------------------------------------------------------------------------------------------
// HTTP helpers, shared with topics-api.mjs.

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

// Returns true when the request may continue. Otherwise the response has been sent.
export async function checkRate(req, res, name) {
  const verdict = await take(`${name}:${clientIp(req)}`, RATE_PER_MIN);
  if (verdict.ok) return true;
  sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(verdict.retryAfterSec) });
  return false;
}

// A browser sends Origin on a cross-origin POST. When it is present it must name this host.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Request body is too large'), { status: 413 });
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(tooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

// Reads and parses a JSON POST body. Returns the parsed body, or undefined after sending the
// error response.
export async function readJsonPost(req, res) {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
    return undefined;
  }
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return undefined;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.status === 413 ? 'Request body is too large' : 'Could not read the request body' }, { Connection: 'close' });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Malformed JSON' });
    return undefined;
  }
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validEvent(value) {
  if (typeof value !== 'string') throw new BadRequest('event must be a string');
  if (!SLUG_RE.test(value)) throw new BadRequest('event is not valid');
  return value;
}

export function validTalkIds(value, name, max = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((id) => typeof id === 'string' && TALK_ID_RE.test(id))) {
    throw new BadRequest(`${name} must be at most ${max} talk ids`);
  }
  return [...new Set(value)];
}

export function failure(res, err, what) {
  if (err instanceof BadRequest) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  console.error(`${what} failed: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'Error')}`);
  if (!res.headersSent) sendJson(res, 502, { error: `${what} is temporarily unavailable` });
}

// ---------------------------------------------------------------------------------------------
// Elasticsearch transport. Error bodies from Elasticsearch are never passed on; only the status
// code is kept, for the server log.

export async function esRequest(path, body, key = ES_API_KEY) {
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ES_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(err?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpstreamError(`status ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new UpstreamError('invalid response');
  }
}

// Both take the conference slug, whose preference keeps every search for it on one shard copy, so
// ties between equal scores break the same way on every request and every instance.
export const searchTalks = (body, event) =>
  esRequest(withPreference(`/${encodeURIComponent(TALKS_INDEX)}/_search`, conferencePreference(event)), body);
export const searchTopics = (body, event) =>
  esRequest(withPreference(`/${encodeURIComponent(TOPICS_INDEX)}/_search`, conferencePreference(event)), body);

// ---------------------------------------------------------------------------------------------
// Validation.

const TOP_KEYS = new Set(['event', 'learn_topics', 'speak_topics', 'interests', 'expertise', 'interested_talk_ids', 'size']);

function validTopicIds(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 30 || !value.every((t) => typeof t === 'string' && TOPIC_ID_RE.test(t))) {
    throw new BadRequest(`${name} must be at most 30 topic ids`);
  }
  return [...new Set(value)];
}

function validText(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 500) throw new BadRequest(`${name} must be a string of at most 500 characters`);
  return value.replace(/\s+/g, ' ').trim();
}

function validate(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);
  let size = 10;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1 || body.size > 50) throw new BadRequest('size must be an integer from 1 to 50');
    size = body.size;
  }
  // speak_topics and expertise are accepted and ignored: talks are recommended from what the user
  // wants to learn only. They are still checked, so a malformed value is a 400 as it always was.
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

// ---------------------------------------------------------------------------------------------
// Query building.

function baseFilter(p) {
  const filter = [
    { term: { conference: p.event } },
    { term: { kind: 'talk' } },
    { range: { end: { gt: 'now' } } },
  ];
  if (p.interestedIds.length) filter.push({ bool: { must_not: [{ terms: { talk_id: p.interestedIds } }] } });
  return filter;
}

// One constant-score clause per topic, so a talk with more of the wanted topics scores higher.
function topicRetriever(topicIds) {
  return {
    standard: {
      query: {
        bool: {
          should: topicIds.map((t) => ({ constant_score: { filter: { term: { topics: t } }, boost: 1 } })),
          minimum_should_match: 1,
        },
      },
    },
  };
}

function semanticRetriever(text, filter) {
  return {
    standard: {
      query: {
        knn: {
          field: 'semantic',
          k: SEMANTIC_K,
          num_candidates: SEMANTIC_CANDIDATES,
          filter,
          query_vector_builder: { text_embedding: { model_text: text } },
        },
      },
    },
  };
}

function buildSearch(p) {
  const filter = baseFilter(p);
  const weighted = [];
  if (p.learn.length) weighted.push({ retriever: topicRetriever(p.learn), weight: 1 });
  if (p.interests) weighted.push({ retriever: semanticRetriever(p.interests, filter), weight: 1 });
  const body = {
    retriever: { rrf: { retrievers: weighted, filter, rank_window_size: RANK_WINDOW } },
    size: p.size,
    _source: ['talk_id', 'conference', 'title', 'abstract', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'slides_url', 'url', 'topics', 'speaker_profiles'],
  };
  if (p.interests) {
    body.highlight = { encoder: 'default', pre_tags: [''], post_tags: [''], fields: { semantic: { number_of_fragments: 2 } } };
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Response shaping.

const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function trimText(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}

// The best semantic chunk. copy_to sends the title to the semantic field as its own chunk, so a
// chunk that only repeats the title is skipped.
function passageFor(hit) {
  const title = normalize(hit._source?.title);
  const chunk = (hit.highlight?.semantic ?? []).find((c) => normalize(c) && normalize(c) !== title);
  return chunk ? trimText(chunk, PASSAGE_MAX) : null;
}

async function circleCounts(event, talkIds) {
  if (!ES_PEOPLE_API_KEY || !talkIds.length) return {};
  try {
    const json = await esRequest(withPreference(`/${encodeURIComponent(PEOPLE_INDEX)}/_search`, peoplePreference(event)), {
      size: 0,
      query: {
        bool: {
          filter: [{ term: { event_id: event } }, { range: { visible_until: { gt: 'now' } } }, { terms: { shared_talk_ids: talkIds } }],
        },
      },
      aggs: { circles: { terms: { field: 'shared_talk_ids', include: talkIds, size: talkIds.length } } },
    }, ES_PEOPLE_API_KEY);
    return Object.fromEntries((json.aggregations?.circles?.buckets ?? []).map((b) => [b.key, b.doc_count]));
  } catch (err) {
    // A missing index or a failed lookup means "no circles", not a failed recommendation.
    console.error(`Circle counts unavailable: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'Error')}`);
    return {};
  }
}

async function topicLabels(event, topicIds) {
  if (!topicIds.length) return new Map();
  const json = await searchTopics({
    size: Math.min(topicIds.length, 200),
    _source: ['topic_id', 'label'],
    query: { bool: { filter: [{ term: { conference: event } }, { terms: { topic_id: topicIds } }] } },
  }, event);
  return new Map((json.hits?.hits ?? []).map((h) => [h._source.topic_id, h._source.label]));
}

async function recommend(p) {
  const json = await searchTalks(buildSearch(p), p.event);
  const hits = json.hits?.hits ?? [];
  // The reasons are built only from the topics of this request, never from anything remembered or
  // from the talk's other topics, so a topic the user has removed can never be named.
  const topicIds = [...new Set([...p.learn, ...hits.flatMap((h) => h._source?.topics ?? [])])];
  const ids = hits.map((h) => String(h._source?.talk_id ?? h._id));
  const [labels, counts] = await Promise.all([topicLabels(p.event, topicIds), circleCounts(p.event, ids)]);

  return hits.map((hit) => {
    const s = hit._source ?? {};
    const talkTopics = s.topics ?? [];
    const passage = passageFor(hit);
    const named = (ids) => ids.filter((t) => talkTopics.includes(t) && labels.has(t)).map((t) => labels.get(t));
    const learnMatched = named(p.learn);
    const talkId = String(s.talk_id ?? hit._id);
    return {
      talk_id: talkId,
      conference: s.conference ?? p.event,
      title: s.title ?? '',
      speakers: s.speakers ?? [],
      room: s.room ?? null,
      start: s.start,
      end: s.end,
      track: s.track,
      level: s.level ?? null,
      tags: s.tags ?? [],
      slides_url: s.slides_url ?? null,
      url: s.url,
      evidence: escapeHtml(passage ?? trimText(s.abstract || s.title || '', EVIDENCE_MAX)),
      topics: talkTopics.filter((t) => labels.has(t)).map((t) => ({ topic_id: t, label: labels.get(t) })),
      speaker_profiles: s.speaker_profiles ?? [],
      // topics equals learn_topics, kept for clients that predate the split. Speak topics are never named.
      why: { topics: learnMatched, learn_topics: learnMatched, passage },
      circle_count: counts[talkId] ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------

export async function handleRecommendationsApi(req, res, url) {
  if (url.pathname !== '/api/recommendations') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    return true;
  }
  if (!(await checkRate(req, res, 'recs'))) return true;
  const body = await readJsonPost(req, res);
  if (body === undefined) return true;
  try {
    const params = validate(body);
    if (!params.learn.length && !params.interests) {
      sendJson(res, 200, { results: [], needs_profile: true });
      return true;
    }
    sendJson(res, 200, { results: await recommend(params) });
  } catch (err) {
    failure(res, err, 'Recommendations');
  }
  return true;
}
