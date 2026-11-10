// GET /api/related?event={slug}&talk_id={id}: up to 5 talks of the same conference that are
// closest in meaning to one talk.
//
// Elasticsearch does the work in two reads. The first fetches the talk's title and abstract.
// The second is a nearest-neighbour (knn) query on the talk "semantic" field, with those texts
// as model_text, filtered to the same conference and kind talk and excluding the talk itself.
// The stored embedding is not reachable through the search API, so the text is embedded again
// for each request, which is why the endpoint is rate limited and the response may be cached
// by the browser for a few minutes. Results keep the order Elasticsearch returned. Nothing is
// stored, and the talk id is never logged.

import {
  BadRequest, checkRate, failure, searchTalks, sendJson, validEvent,
} from './recommend.mjs';

const RELATED_MAX = 5;
const SEMANTIC_K = 10;
const SEMANTIC_CANDIDATES = 100;
const MODEL_TEXT_MAX = 1500;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const KEYS = new Set(['event', 'talk_id']);
const SOURCE = ['talk_id', 'conference', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'slides_url', 'url'];

function validate(url) {
  for (const k of url.searchParams.keys()) if (!KEYS.has(k)) throw new BadRequest(`Unknown parameter: ${k.slice(0, 40)}`);
  const event = validEvent(url.searchParams.get('event') ?? undefined);
  const talkId = url.searchParams.get('talk_id');
  if (typeof talkId !== 'string' || !TALK_ID_RE.test(talkId)) throw new BadRequest('talk_id is not valid');
  return { event, talkId };
}

async function related({ event, talkId }) {
  const own = await searchTalks({
    size: 1,
    _source: ['title', 'abstract'],
    query: { bool: { filter: [{ term: { conference: event } }, { term: { kind: 'talk' } }, { term: { talk_id: talkId } }] } },
  }, event);
  const source = own.hits?.hits?.[0]?._source;
  if (!source) return null;
  const text = `${source.title ?? ''}. ${source.abstract ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, MODEL_TEXT_MAX);
  const filter = [
    { term: { conference: event } },
    { term: { kind: 'talk' } },
    { bool: { must_not: [{ term: { talk_id: talkId } }] } },
  ];
  const json = await searchTalks({
    size: RELATED_MAX,
    _source: SOURCE,
    query: {
      knn: {
        field: 'semantic',
        k: SEMANTIC_K,
        num_candidates: SEMANTIC_CANDIDATES,
        filter,
        query_vector_builder: { text_embedding: { model_text: text } },
      },
    },
  }, event);
  return (json.hits?.hits ?? []).slice(0, RELATED_MAX).map((hit) => {
    const s = hit._source ?? {};
    return {
      talk_id: String(s.talk_id ?? hit._id),
      conference: s.conference ?? event,
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
    };
  });
}

export async function handleRelatedApi(req, res, url) {
  if (url.pathname !== '/api/related') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
    return true;
  }
  if (!(await checkRate(req, res, 'related'))) return true;
  try {
    const results = await related(validate(url));
    if (results === null) sendJson(res, 404, { error: 'Talk not found' });
    else sendJson(res, 200, { results }, { 'Cache-Control': 'private, max-age=300' });
  } catch (err) {
    failure(res, err, 'Related talks');
  }
  return true;
}
