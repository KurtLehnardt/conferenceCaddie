// GET /api/topics and POST /api/topics/suggest: the topic list of a conference.
//
// Topics are built from talk titles at ingestion and live in the topics index. Elasticsearch
// does the type-ahead (bool_prefix over the search_as_you_type fields) and every ordering.
//
// GET /api/topics?event={slug}&q={prefix}&size={n}
//   Empty q: the conference's topics by rank. Otherwise a bool_prefix match on label and aliases.
//   size is at most 150; the default is 150 for an empty q and 10 otherwise.
// POST /api/topics/suggest  { event, talk_ids, text }
//   Topics that occur in those talks, most common first, then topics whose label matches the
//   text. At most 12.

import {
  BadRequest, checkRate, failure, isPlainObject, readJsonPost, searchTalks, searchTopics, sendJson, validEvent, validTalkIds,
} from './recommend.mjs';

const MAX_SIZE = 150;
const SUGGEST_MAX = 12;
const SUGGEST_FROM_TALKS = 8;
const QUERY_MAX = 60;
const TEXT_MAX = 500;
// A topic found in the selected talks always outranks a label match on free text.
const TALK_TOPIC_BOOST = 1000;
const SUGGEST_KEYS = new Set(['event', 'talk_ids', 'text']);
const TYPE_AHEAD_FIELDS = ['label', 'label._2gram', 'label._3gram', 'aliases', 'aliases._2gram', 'aliases._3gram'];

const toTopic = (hit) => ({ topic_id: hit._source.topic_id, label: hit._source.label, talk_count: hit._source.talk_count ?? 0 });

async function listTopics(url) {
  const event = validEvent(url.searchParams.get('event') ?? undefined);
  const q = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (q.length > QUERY_MAX) throw new BadRequest(`q must be at most ${QUERY_MAX} characters`);
  let size = q ? 10 : MAX_SIZE;
  const rawSize = url.searchParams.get('size');
  if (rawSize !== null) {
    size = Number(rawSize);
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) throw new BadRequest(`size must be an integer from 1 to ${MAX_SIZE}`);
  }
  const filter = [{ term: { conference: event } }];
  const body = {
    size,
    _source: ['topic_id', 'label', 'talk_count'],
    query: q
      ? { bool: { filter, must: [{ multi_match: { query: q, type: 'bool_prefix', fields: TYPE_AHEAD_FIELDS } }] } }
      : { bool: { filter } },
    sort: q
      ? ['_score', { talk_count: 'desc' }, { label_exact: 'asc' }]
      : [{ rank: 'asc' }, { label_exact: 'asc' }],
  };
  const json = await searchTopics(body, event);
  return { topics: (json.hits?.hits ?? []).map(toTopic) };
}

function validateSuggest(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!SUGGEST_KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);
  const text = body.text === undefined || body.text === null ? '' : body.text;
  if (typeof text !== 'string' || text.length > TEXT_MAX) throw new BadRequest(`text must be a string of at most ${TEXT_MAX} characters`);
  return {
    event: validEvent(body.event),
    talkIds: validTalkIds(body.talk_ids, 'talk_ids'),
    text: text.replace(/\s+/g, ' ').trim(),
  };
}

async function suggestTopics({ event, talkIds, text }) {
  const should = [];
  if (talkIds.length) {
    const agg = await searchTalks({
      size: 0,
      query: { bool: { filter: [{ term: { conference: event } }, { term: { kind: 'talk' } }, { terms: { talk_id: talkIds } }] } },
      aggs: { topics: { terms: { field: 'topics', size: SUGGEST_FROM_TALKS } } },
    }, event);
    for (const b of agg.aggregations?.topics?.buckets ?? []) {
      should.push({ constant_score: { filter: { term: { topic_id: b.key } }, boost: TALK_TOPIC_BOOST + b.doc_count } });
    }
  }
  if (text) should.push({ match: { label: { query: text } } }, { match: { aliases: { query: text } } });
  if (!should.length) return { topics: [] };
  const json = await searchTopics({
    size: SUGGEST_MAX,
    _source: ['topic_id', 'label', 'talk_count'],
    query: { bool: { filter: [{ term: { conference: event } }], should, minimum_should_match: 1 } },
    sort: ['_score', { talk_count: 'desc' }, { label_exact: 'asc' }],
  }, event);
  return { topics: (json.hits?.hits ?? []).map(toTopic) };
}

// ---------------------------------------------------------------------------------------------

export async function handleTopicsApi(req, res, url) {
  if (url.pathname === '/api/topics') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
      return true;
    }
    if (!(await checkRate(req, res, 'topics'))) return true;
    try {
      sendJson(res, 200, await listTopics(url));
    } catch (err) {
      failure(res, err, 'Topics');
    }
    return true;
  }
  if (url.pathname === '/api/topics/suggest') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
      return true;
    }
    if (!(await checkRate(req, res, 'suggest'))) return true;
    const body = await readJsonPost(req, res);
    if (body === undefined) return true;
    try {
      sendJson(res, 200, await suggestTopics(validateSuggest(body)));
    } catch (err) {
      failure(res, err, 'Topic suggestions');
    }
    return true;
  }
  return false;
}
