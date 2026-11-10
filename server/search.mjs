// Request validation and the Elasticsearch queries behind POST /api/search.
//
// Every ranking, count and highlight comes from Elasticsearch. This module only builds
// queries, validates input against values that Elasticsearch reports, and reshapes hits
// in the order Elasticsearch returned them.
//
// Query design
// - Text query: an rrf retriever over a lexical multi_match and a knn query on the
//   semantic_text field "semantic". The knn query uses a fixed k (SEMANTIC_K) and carries the
//   base filters B (defined below) as its own filter, so they are applied before the
//   nearest-neighbour search. The facet selections are not part of the knn filter; the rrf
//   retriever's filter applies them afterwards. That keeps the neighbour set independent of the
//   selections, so the count a facet value shows is exactly the total a user gets after
//   selecting it. A plain "semantic" query on a dense semantic_text field sizes its neighbour set
//   from the request "size", which would make "total" change with "size"; the fixed k avoids
//   that. The query embedding is built by Elasticsearch from the semantic_text field's own
//   inference endpoint.
// - Empty query (browse mode): a bool filter query sorted by start ascending, then talk_id. It
//   pages with "from" (at most MAX_FROM), so the app can list a whole day in schedule order.
//
// Facet and total definition
// - Let M be the documents the main query matches: for a text query, the union of the lexical
//   matches (multi_match with minimum_should_match LEXICAL_MIN_MATCH) and the SEMANTIC_K nearest
//   neighbours among the documents that pass B; in browse mode, every document. M does not depend
//   on any facet selection.
// - Let B be the base filters: kind is "talk" (or "talk" or "ambient" when include_events is on), the start_after and start_before window,
//   hide_sponsor, the happening_now window (end after now and start before now plus 60 minutes,
//   both evaluated by Elasticsearch), the clauses of the time phrases found in the query (see phrases.mjs), and the
//   conference term. Every query this module sends, including the
//   known-values aggregation, carries the conference term, so no talk of another conference can
//   appear in results or counts.
// - Let S(g) be the selection in facet group g: day, track, level, has_slides, and one group per
//   tag group (a tag group's selected values are ORed; different groups are ANDed).
// - total = |M ∩ B ∩ S(every group)|, which is the set the results are drawn from.
// - saved_talk_ids is validated but never filters: the app no longer excludes or flags talks that
//   overlap the talks a user marked.
// - The facet counts for group g are a terms aggregation over M ∩ B ∩ S(every group except g).
//   For a group with no selection that is exactly the total set, and the counts come from the
//   main query's aggregations. For a group with a selection, one extra size-0 query (same
//   retriever, same filters, minus that group's selection) runs in the same _msearch request.
// - A selected value that has no matching documents is still listed, with count 0, so the UI
//   can show it as selected.
//
// Ranking drawer ("debug": true)
// - Only a text query with "debug": true pays for it; every other request sends exactly the
//   searches above. The main query is the same with or without debug.
// - The same _msearch request then also runs the rrf retriever's two child retrievers on their
//   own, each as a standard retriever carrying the same filter the rrf retriever passes down to
//   it, and each sized to the rank window. Elasticsearch orders both lists, so a talk's keyword
//   rank and semantic rank are its positions in those lists, which are the ranks rrf fused. A
//   talk outside a list's top window gets null, which rrf also treats as "not found".
// - Each result then carries ranking: { rank, keyword_rank, semantic_rank }, and the response
//   carries ranking: { rank_window, semantic_k, filters }, where filters echoes the validated
//   filters that every query of the request applied.
// - Every request, with or without debug, sets the conference's preference (see preference.mjs)
//   on all its searches, so every one of them reads the same shard copy. Two identical requests
//   then return the same order, and the child rankings use the same term statistics as the fused
//   ranking they explain.

import { searchableConference } from './conferences.mjs';
import { parseTimePhrases } from './phrases.mjs';
import { suggestChips } from './facets.mjs';
import { conferencePreference, withPreference } from './preference.mjs';
import { pauseSemantic, semanticAvailable, isInferenceFailure, esErrorInfo } from './semantic.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ES_INDEX = process.env.ES_INDEX || 'caddie-talks';
const ES_TOPICS_INDEX = process.env.ES_TOPICS_INDEX || 'caddie-topics';
const ES_TIMEOUT_MS = 8000;

const LEXICAL_FIELDS = ['title^2', 'abstract', 'speakers', 'speaker_taglines'];
// Queries of one or two terms must match every term; longer ones must match 60% of them. Without
// this, a long natural-language query lexically matches any talk that shares one common word
// (for example "cluster"), and that noise outranks the semantic matches in rrf.
const LEXICAL_MIN_MATCH = '2<60%';
const RANK_WINDOW = 50;
const SEMANTIC_K = 50;
const SEMANTIC_CANDIDATES = 200;
const KNOWN_TTL_MS = 10 * 60 * 1000;
const EVIDENCE_MAX = 300;
// U+001F joins a tag's group and value in tag_keys. It cannot occur in a category name.
const TAG_SEP = '\u001f';

const SOURCE_FIELDS = ['talk_id', 'conference', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'topics', 'speaker_profiles', 'slides_url', 'url', 'kind'];
const HIGHLIGHT_BASE = { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'] };

export class BadRequest extends Error {}
// status is the HTTP (or msearch item) status when Elasticsearch answered; types and
// inferenceReason come from esErrorInfo (semantic.mjs) and say whether inference failed. Only the
// message, a status or an error type, is ever logged.
export class UpstreamError extends Error {
  constructor(message, status = null, details = {}) {
    super(message);
    this.status = status;
    this.types = details.types ?? [];
    this.inferenceReason = details.inferenceReason === true;
  }
}

// ---------------------------------------------------------------------------------------------
// Elasticsearch transport. Error bodies from Elasticsearch are never passed on; only the status
// code is kept for the server log, and the error types to tell an inference failure apart.
//
// esRequest(path, body, options) sends one request and returns the parsed JSON response.
// - body: an object (sent as JSON), a string (sent as is) or undefined (no body).
// - options.apiKey: the encoded API key; defaults to process.env.ES_API_KEY.
// - options.method: defaults to POST when there is a body and GET otherwise.
// - options.contentType: defaults to application/json.
// It throws UpstreamError, whose status is the HTTP status when Elasticsearch answered.

export async function esRequest(path, body, options = {}) {
  const apiKey = options.apiKey ?? process.env.ES_API_KEY ?? '';
  const method = options.method ?? (body === undefined ? 'GET' : 'POST');
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method,
      headers: { Authorization: `ApiKey ${apiKey}`, 'Content-Type': options.contentType ?? 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? ES_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(err?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  if (!res.ok) {
    let info = {};
    try {
      info = esErrorInfo((await res.json())?.error);
    } catch {
      // Not JSON, or the body could not be read: the status alone.
    }
    throw new UpstreamError(`status ${res.status}`, res.status, info);
  }
  try {
    return await res.json();
  } catch {
    throw new UpstreamError('invalid response', res.status);
  }
}

// header is the msearch header line sent with every search; the callers pass the conference's preference.
async function msearch(searches, header = {}) {
  const head = JSON.stringify(header);
  const body = searches.flatMap((s) => [head, JSON.stringify(s)]).join('\n') + '\n';
  const json = await esRequest(`/${encodeURIComponent(ES_INDEX)}/_msearch`, body, { contentType: 'application/x-ndjson' });
  const responses = json.responses ?? [];
  if (responses.length !== searches.length) throw new UpstreamError('msearch item failed');
  const failed = responses.find((r) => r.error);
  if (failed) {
    // Only the error's type is kept: an Elasticsearch reason can echo the query text.
    const type = failed.error?.caused_by?.type ?? failed.error?.type ?? 'unknown';
    throw new UpstreamError(`msearch item failed: ${type}`, failed.status, esErrorInfo(failed.error));
  }
  return responses;
}

// ---------------------------------------------------------------------------------------------
// Known filter values per conference, from one terms aggregation over that conference's talks,
// cached for ten minutes.

const knownCache = new Map(); // slug -> { at, promise }

async function fetchKnown(slug) {
  const json = await esRequest(withPreference(`/${encodeURIComponent(ES_INDEX)}/_search`, conferencePreference(slug)), {
    size: 0,
    // Events and showcases (kind "ambient") count too, so their tracks can be selected when the toggle is on.
    query: { bool: { filter: [{ term: { conference: slug } }, { terms: { kind: ['talk', 'ambient'] } }] } },
    aggs: {
      day: { terms: { field: 'day', size: 100 } },
      track: { terms: { field: 'track', size: 500 } },
      level: { terms: { field: 'level', size: 100 } },
      tag_keys: { terms: { field: 'tag_keys', size: 2000 } },
    },
  });
  const keys = (name) => new Set((json.aggregations?.[name]?.buckets ?? []).map((b) => b.key));
  return { day: keys('day'), track: keys('track'), level: keys('level'), tagKeys: keys('tag_keys') };
}

function knownValues(slug) {
  const now = Date.now();
  let entry = knownCache.get(slug);
  if (!entry || now - entry.at > KNOWN_TTL_MS) {
    const promise = fetchKnown(slug);
    entry = { at: now, promise };
    knownCache.set(slug, entry);
    promise.catch(() => {
      if (knownCache.get(slug)?.promise === promise) knownCache.delete(slug);
    });
  }
  return entry.promise;
}

// ---------------------------------------------------------------------------------------------
// Validation. Only the documented keys are accepted, and filter values must be known values of
// the requested conference.

const TOP_KEYS = new Set(['conference', 'query', 'filters', 'saved_talk_ids', 'size', 'from', 'debug', 'ignore_phrases']);
// Browse mode pages with "from" over the Elasticsearch sort (start, then talk_id). The cap keeps
// from + size far below the index's result window; a conference day holds a few hundred items.
const MAX_FROM = 1000;
const FILTER_KEYS = new Set(['day', 'start_after', 'start_before', 'track', 'level', 'tags', 'has_slides', 'speaker', 'room', 'hide_sponsor', 'happening_now', 'include_events']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^([a-z0-9][a-z0-9-]{0,119}):[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseTime(value, name) {
  if (value === null || value === undefined) return null;
  const m = typeof value === 'string' ? TIME_RE.exec(value) : null;
  if (!m) throw new BadRequest(`filters.${name} must be null or "HH:MM"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseValueList(value, name, known) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new BadRequest(`filters.${name} must be an array of known values`);
  for (const v of value) {
    if (typeof v !== 'string' || !known.has(v)) throw new BadRequest(`filters.${name} contains an unknown value`);
  }
  return [...new Set(value)];
}

// Speaker and room filters take free names, so they are checked for shape only: at most ten strings.
// They are matched in Elasticsearch, so a name that matches nothing simply returns no talks.
function parseNameList(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || !value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 300)) {
    throw new BadRequest(`filters.${name} must be an array of at most 10 names`);
  }
  return [...new Set(value)];
}

// Checks the shape of filters.tags; the values are checked against known values later.
function parseTagShape(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new BadRequest('filters.tags must be an array of at most 50 {group, value} objects');
  for (const t of value) {
    if (!isPlainObject(t) || Object.keys(t).length !== 2 || typeof t.group !== 'string' || typeof t.value !== 'string'
      || t.group.length > 200 || t.value.length > 200 || t.group.includes(TAG_SEP) || t.value.includes(TAG_SEP)) {
      throw new BadRequest('filters.tags must be an array of at most 50 {group, value} objects');
    }
  }
  return value;
}

// Returns a Map of group name -> selected tag_keys values, in the order groups were first named.
function tagSelection(pairs, known) {
  const byGroup = new Map();
  for (const { group, value } of pairs) {
    const key = group + TAG_SEP + value;
    if (!known.has(key)) throw new BadRequest('filters.tags contains an unknown value');
    if (!byGroup.has(group)) byGroup.set(group, []);
    const keys = byGroup.get(group);
    if (!keys.includes(key)) keys.push(key);
  }
  return byGroup;
}

export async function validate(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);

  if (typeof body.conference !== 'string') throw new BadRequest('conference must be a string');
  const slug = body.conference;
  if (!SLUG_RE.test(slug)) throw new BadRequest('conference is not available');

  if (typeof body.query !== 'string') throw new BadRequest('query must be a string');
  const query = body.query.trim();
  if (query.length > 200) throw new BadRequest('query must be at most 200 characters');

  let size = 10;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1 || body.size > 50) throw new BadRequest('size must be an integer from 1 to 50');
    size = body.size;
  }

  let from = 0;
  if (body.from !== undefined) {
    if (!Number.isInteger(body.from) || body.from < 0 || body.from > MAX_FROM) throw new BadRequest(`from must be an integer from 0 to ${MAX_FROM}`);
    from = body.from;
  }

  if (body.debug !== undefined && typeof body.debug !== 'boolean') throw new BadRequest('debug must be a boolean');

  // ignore_phrases names time phrases the person removed; an unknown name simply has no effect.
  let ignored = new Set();
  if (body.ignore_phrases !== undefined) {
    const list = body.ignore_phrases;
    if (!Array.isArray(list) || list.length > 20 || !list.every((k) => typeof k === 'string' && k.length <= 30)) {
      throw new BadRequest('ignore_phrases must be an array of at most 20 short strings');
    }
    ignored = new Set(list);
  }

  // saved_talk_ids is still accepted, so older clients keep working, but it never filters.
  if (body.saved_talk_ids !== undefined) {
    const ids = body.saved_talk_ids;
    if (!Array.isArray(ids) || ids.length > 100
      || !ids.every((id) => typeof id === 'string' && TALK_ID_RE.exec(id)?.[1] === slug)) {
      throw new BadRequest('saved_talk_ids must be at most 100 talk ids of this conference');
    }
  }

  const f = body.filters ?? {};
  if (!isPlainObject(f)) throw new BadRequest('filters must be an object');
  for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k)) throw new BadRequest(`Unknown filter: ${k.slice(0, 40)}`);

  if (f.has_slides !== undefined && f.has_slides !== null && typeof f.has_slides !== 'boolean') {
    throw new BadRequest('filters.has_slides must be null, true or false');
  }
  if (f.hide_sponsor !== undefined && typeof f.hide_sponsor !== 'boolean') throw new BadRequest('filters.hide_sponsor must be a boolean');
  if (f.happening_now !== undefined && typeof f.happening_now !== 'boolean') throw new BadRequest('filters.happening_now must be a boolean');
  if (f.include_events !== undefined && typeof f.include_events !== 'boolean') throw new BadRequest('filters.include_events must be a boolean');
  if (f.day !== undefined && f.day !== null && typeof f.day !== 'string') throw new BadRequest('filters.day must be null or a known day');
  const startAfter = parseTime(f.start_after, 'start_after');
  const startBefore = parseTime(f.start_before, 'start_before');
  const tagPairs = parseTagShape(f.tags);

  const conference = await searchableConference(slug);
  if (!conference) throw new BadRequest('conference is not available');
  const levelGroup = conference.category_mapping?.level_group ?? null;
  const tagGroups = Array.isArray(conference.category_mapping?.tag_groups) ? conference.category_mapping.tag_groups : [];

  // An empty level list is accepted for every conference, so a client can always send the full
  // filters object; any selected level needs a level group.
  const levelGiven = f.level !== undefined && f.level !== null && !(Array.isArray(f.level) && f.level.length === 0);
  if (levelGiven && !levelGroup) throw new BadRequest('filters.level is not available for this conference');

  const needsKnown = (f.day ?? null) !== null || (f.track?.length ?? 0) > 0 || levelGiven || tagPairs.length > 0;
  const known = needsKnown ? await knownValues(slug) : { day: new Set(), track: new Set(), level: new Set(), tagKeys: new Set() };
  if (f.day !== undefined && f.day !== null && !known.day.has(f.day)) throw new BadRequest('filters.day is not a known day');

  // Time phrases leave the text and become filter clauses of their own.
  const time = await parseTimePhrases(query, conference, ignored);
  // Only browse mode has a stable sort to page through; a ranked search always starts at the top.
  if (from > 0 && time.text) throw new BadRequest('from is only accepted with an empty query');

  return {
    conference: slug,
    hasLevel: Boolean(levelGroup),
    tagGroups,
    query: time.text,
    timePhrases: time.phrases,
    size,
    from,
    debug: body.debug === true,
    timeZone: conference.time_zone || 'UTC',
    filters: {
      day: f.day ?? null,
      startAfter,
      startBefore,
      track: parseValueList(f.track, 'track', known.track),
      level: levelGroup ? parseValueList(f.level, 'level', known.level) : [],
      tags: tagSelection(tagPairs, known.tagKeys),
      speaker: parseNameList(f.speaker, 'speaker'),
      room: parseNameList(f.room, 'room'),
      hasSlides: f.has_slides ?? null,
      hideSponsor: f.hide_sponsor ?? false,
      happeningNow: f.happening_now ?? false,
      includeEvents: f.include_events ?? false,
      phraseClauses: time.clauses,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Query building.

const HAPPENING_NOW_AHEAD = 'now+60m';

// Whether the conference has a talk starting today. "Today" is the current calendar day in the
// conference's own time zone: Elasticsearch rounds now/d in that zone, so the chip is available
// exactly on the days the conference is running, whatever zone the person's phone is in.
function runningTodaySearch(conference, timeZone) {
  return {
    query: {
      bool: {
        filter: [
          { term: { conference } },
          { term: { kind: 'talk' } },
          { range: { start: { gte: 'now/d', lt: 'now+1d/d', time_zone: timeZone } } },
        ],
      },
    },
    size: 0,
    track_total_hits: 1,
  };
}

function baseClauses(conference, filters) {
  // Breaks and housekeeping never match. Co-located events and showcases (kind "ambient") match
  // only when the person turned the toggle on.
  const kindClause = filters.includeEvents ? { terms: { kind: ['talk', 'ambient'] } } : { term: { kind: 'talk' } };
  const clauses = [{ term: { conference } }, kindClause];
  const minutes = {};
  if (filters.startAfter !== null) minutes.gte = filters.startAfter;
  if (filters.startBefore !== null) minutes.lt = filters.startBefore;
  if (Object.keys(minutes).length) clauses.push({ range: { start_minutes: minutes } });
  // Speaker and room selections come from value-matching chips. They narrow every query and facet
  // alike, and several names of one kind are alternatives.
  if (filters.speaker.length) clauses.push({ bool: { should: filters.speaker.map((name) => ({ match_phrase: { speakers: name } })), minimum_should_match: 1 } });
  if (filters.room.length) clauses.push({ terms: { room: filters.room } });
  if (filters.hideSponsor) clauses.push({ bool: { must_not: [{ term: { sponsor: true } }] } });
  // Happening now: in progress, or starting within the next 60 minutes. Elasticsearch compares
  // the absolute start and end instants with its own current time, so no clock or zone is used here.
  if (filters.happeningNow) clauses.push({ range: { end: { gt: 'now' } } }, { range: { start: { lt: HAPPENING_NOW_AHEAD } } });
  clauses.push(...filters.phraseClauses);
  return clauses;
}

// The facet groups that have a selection, each with the filter clause its selection adds and the
// aggregation its facet uses. Every tag group is its own facet group, named "tag:" + group.
function selectedGroups(filters) {
  const groups = [];
  if (filters.day !== null) groups.push({ name: 'day', clause: { term: { day: filters.day } }, agg: 'day' });
  if (filters.track.length) groups.push({ name: 'track', clause: { terms: { track: filters.track } }, agg: 'track' });
  if (filters.level.length) groups.push({ name: 'level', clause: { terms: { level: filters.level } }, agg: 'level' });
  if (filters.hasSlides !== null) groups.push({ name: 'has_slides', clause: { term: { has_slides: filters.hasSlides } }, agg: 'has_slides' });
  for (const [group, keys] of filters.tags) groups.push({ name: `tag:${group}`, clause: { terms: { tag_keys: keys } }, agg: 'tag_keys' });
  return groups;
}

const selectionClauses = (groups, except) => groups.filter((g) => g.name !== except).map((g) => g.clause);

const AGGS = {
  day: { terms: { field: 'day', size: 100 } },
  track: { terms: { field: 'track', size: 500 } },
  level: { terms: { field: 'level', size: 100 } },
  has_slides: { terms: { field: 'has_slides', size: 2 } },
  tag_keys: { terms: { field: 'tag_keys', size: 2000 } },
};

// The rrf retriever's two children: the lexical query, then the knn query. With semantic off
// (the inference endpoint is unavailable, see semantic.mjs) only the lexical query is built.
function childQueries(query, knnFilter, semantic = true) {
  const lexical = { multi_match: { query, fields: LEXICAL_FIELDS, minimum_should_match: LEXICAL_MIN_MATCH } };
  if (!semantic) return [lexical];
  return [
    lexical,
    {
      knn: {
        field: 'semantic',
        k: SEMANTIC_K,
        num_candidates: SEMANTIC_CANDIDATES,
        filter: knnFilter,
        query_vector_builder: { text_embedding: { model_text: query } },
      },
    },
  ];
}

// knnFilter holds only the base filters, so the nearest-neighbour set does not depend on the
// facet selections; the selections are applied to it afterwards through the rrf filter.
function retrieverFor(query, filter, knnFilter, semantic = true) {
  const children = childQueries(query, knnFilter, semantic);
  if (children.length === 1) return { standard: { query: children[0], filter } };
  return {
    rrf: {
      retrievers: children.map((q) => ({ standard: { query: q } })),
      filter,
      rank_window_size: RANK_WINDOW,
    },
  };
}

// One child retriever on its own, with the filter the rrf retriever passes down to it, for the
// ranking drawer. Only talk_id is returned; Elasticsearch's order is the child's ranking.
function childSearch(childQuery, filter) {
  return {
    retriever: { standard: { query: childQuery, filter } },
    size: RANK_WINDOW,
    track_total_hits: false,
    _source: ['talk_id'],
  };
}

function matchBody(query, filter, knnFilter, semantic = true) {
  return query ? { retriever: retrieverFor(query, filter, knnFilter, semantic) } : { query: { bool: { filter } } };
}

function mainSearch(query, filter, knnFilter, size, aggs, from = 0, semantic = true) {
  const body = {
    ...matchBody(query, filter, knnFilter, semantic),
    size,
    track_total_hits: true,
    _source: SOURCE_FIELDS,
    aggs,
  };
  if (query) {
    body.highlight = {
      ...HIGHLIGHT_BASE,
      fields: {
        abstract: { fragment_size: 200, number_of_fragments: 1, no_match_size: 200 },
        title: { number_of_fragments: 0, no_match_size: 300 },
        ...(semantic ? { semantic: { number_of_fragments: 2 } } : {}),
      },
    };
  } else {
    body.sort = [{ start: 'asc' }, { talk_id: 'asc' }];
    if (from) body.from = from;
    body.highlight = {
      ...HIGHLIGHT_BASE,
      fields: {
        abstract: { fragment_size: 200, number_of_fragments: 1, no_match_size: 200 },
        title: { number_of_fragments: 0, no_match_size: 300 },
      },
    };
  }
  return body;
}

function facetSearch(query, filter, knnFilter, agg, semantic = true) {
  return { ...matchBody(query, filter, knnFilter, semantic), size: 0, track_total_hits: false, aggs: { [agg]: AGGS[agg] } };
}

// ---------------------------------------------------------------------------------------------
// Topic labels. One search on the topics index resolves every topic id in a page of results.
// A missing topics index or alias gives an empty map, so results then carry topics: [].

export async function topicLabels(conference, topicIds) {
  const ids = [...new Set(topicIds.filter((id) => typeof id === 'string' && id))].slice(0, 1000);
  if (!ids.length) return new Map();
  let json;
  try {
    json = await esRequest(withPreference(`/${encodeURIComponent(ES_TOPICS_INDEX)}/_search?ignore_unavailable=true`, conferencePreference(conference)), {
      size: ids.length,
      _source: ['topic_id', 'label'],
      query: { bool: { filter: [{ term: { conference } }, { terms: { topic_id: ids } }] } },
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return new Map();
    // Labels are decoration on a search that already succeeded, so a failure leaves them out.
    console.error(`Topic label lookup failed: ${err instanceof UpstreamError ? err.message : 'error'}`);
    return new Map();
  }
  const labels = new Map();
  for (const h of json.hits?.hits ?? []) {
    const s = h._source ?? {};
    if (typeof s.topic_id === 'string' && typeof s.label === 'string' && s.label) labels.set(s.topic_id, s.label);
  }
  return labels;
}

// ---------------------------------------------------------------------------------------------
// Response shaping.

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function trimText(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= EVIDENCE_MAX) return t;
  const cut = t.slice(0, EVIDENCE_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > EVIDENCE_MAX * 0.6 ? cut.slice(0, space) : cut) + '…';
}

// Evidence preference: a lexical abstract fragment with marks, then a title with marks, then
// the best semantic chunk, then the start of the abstract, then the title. The semantic
// highlighter does not apply the html encoder, so its chunk is escaped here; it has no marks.
// copy_to sends the title to the semantic field as its own chunk, so a chunk that only repeats
// the title is skipped in favour of the next-best chunk, which comes from the abstract.
const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function evidenceFor(hit) {
  const hl = hit.highlight ?? {};
  const abstract = hl.abstract?.[0];
  const title = hl.title?.[0];
  const plainTitle = normalize(hit._source?.title);
  const chunk = (hl.semantic ?? []).find((c) => normalize(c) && normalize(c) !== plainTitle);
  if (abstract?.includes('<mark>')) return abstract;
  if (title?.includes('<mark>')) return title;
  if (chunk && chunk.trim()) return escapeHtml(trimText(chunk));
  if (abstract && abstract.trim()) return abstract;
  if (title && title.trim()) return title;
  return escapeHtml(hit._source?.title ?? '');
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// Shapes one talk hit. labels maps topic_id to label; topics without a label are left out, so
// no raw id reaches the UI.
export function toResult(hit, labels = new Map()) {
  const s = hit._source ?? {};
  return {
    talk_id: String(s.talk_id ?? hit._id),
    conference: s.conference,
    kind: s.kind === 'ambient' ? 'ambient' : 'talk',
    title: s.title ?? '',
    speakers: asArray(s.speakers),
    room: s.room ?? null,
    start: s.start,
    end: s.end,
    track: s.track,
    level: s.level ?? null,
    tags: asArray(s.tags)
      .filter((t) => t && typeof t.group === 'string' && typeof t.value === 'string')
      .map((t) => ({ group: t.group, value: t.value })),
    topics: asArray(s.topics).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) })),
    speaker_profiles: asArray(s.speaker_profiles),
    slides_url: s.slides_url ?? null,
    url: s.url,
    evidence: evidenceFor(hit),
  };
}

function facetList(group, buckets, filters) {
  if (group === 'has_slides') {
    const count = (v) => buckets.find((b) => b.key_as_string === String(v))?.doc_count ?? 0;
    return [{ value: true, count: count(true) }, { value: false, count: count(false) }];
  }
  const list = buckets.map((b) => ({ value: b.key, count: b.doc_count }));
  const selected = group === 'day' ? (filters.day !== null ? [filters.day] : []) : filters[group];
  for (const v of selected) if (!list.some((x) => x.value === v)) list.push({ value: v, count: 0 });
  if (group === 'day') list.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return list;
}

// One tag group's values from tag_keys buckets (already sorted by count descending), plus any
// selected value that has no matching documents, listed with count 0.
function tagValues(group, buckets, filters) {
  const prefix = group + TAG_SEP;
  const values = buckets.filter((b) => b.key.startsWith(prefix)).map((b) => ({ value: b.key.slice(prefix.length), count: b.doc_count }));
  for (const key of filters.tags.get(group) ?? []) {
    const value = key.slice(prefix.length);
    if (!values.some((x) => x.value === value)) values.push({ value, count: 0 });
  }
  return values;
}

// Minutes after midnight back to "HH:MM", or null.
const hhmm = (m) => (m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

// ---------------------------------------------------------------------------------------------

export async function search(params) {
  const { conference, hasLevel, tagGroups, query, size, from, filters } = params;
  const base = baseClauses(conference, filters);
  const groups = selectedGroups(filters);

  const mainAggs = { day: AGGS.day, track: AGGS.track, has_slides: AGGS.has_slides, tag_keys: AGGS.tag_keys };
  if (hasLevel) mainAggs.level = AGGS.level;
  const debug = params.debug && Boolean(query);
  const build = (semantic) => {
    const searches = [mainSearch(query, [...base, ...selectionClauses(groups, null)], base, size, mainAggs, query ? 0 : from, semantic)];
    for (const g of groups) searches.push(facetSearch(query, [...base, ...selectionClauses(groups, g.name)], base, g.agg, semantic));
    searches.push(runningTodaySearch(conference, params.timeZone));
    if (debug) {
      for (const q of childQueries(query, base, semantic)) searches.push(childSearch(q, [...base, ...selectionClauses(groups, null)]));
    }
    return searches;
  };

  // Every search of the request, and every later request for this conference, reads the same shard
  // copy, so ties are broken the same way each time. A text query runs semantic plus keyword; when
  // the semantic query fails because the inference endpoint did (isInferenceFailure), the same
  // request is answered by keyword matching alone and says so, and semantic queries pause for a
  // minute (semantic.mjs). Any other failure fails the request as before.
  let semantic = Boolean(query) && semanticAvailable();
  const header = { preference: conferencePreference(conference) };
  const run = async () => {
    try {
      return await msearch(build(semantic), header);
    } catch (err) {
      if (!semantic || !(err instanceof UpstreamError) || !isInferenceFailure(err)) throw err;
      pauseSemantic(err);
      semantic = false;
      return msearch(build(false), header);
    }
  };
  const [all, suggestions] = await Promise.all([
    run(),
    // Names in the search text, offered as chips; empty for browse mode and on any failure.
    query ? suggestChips(conference, query, filters) : [],
  ]);
  const [main, ...rest] = all.slice(0, 1 + groups.length);
  const today = all[1 + groups.length];
  const aggsFor = (name) => {
    const i = groups.findIndex((g) => g.name === name);
    return i === -1 ? main.aggregations : rest[i].aggregations;
  };

  const facets = {};
  for (const group of ['day', 'track', ...(hasLevel ? ['level'] : []), 'has_slides']) {
    facets[group] = facetList(group, aggsFor(group)?.[group]?.buckets ?? [], filters);
  }
  facets.tags = tagGroups.map((group) => ({
    group,
    values: tagValues(group, aggsFor(`tag:${group}`)?.tag_keys?.buckets ?? [], filters),
  }));

  const hits = main.hits?.hits ?? [];
  const labels = await topicLabels(conference, hits.flatMap((h) => asArray(h._source?.topics)));

  const response = {
    total: main.hits?.total?.value ?? 0,
    conference,
    // The text the retrievers saw, after time phrases left it, and the phrases found in it.
    search_text: query,
    time_phrases: params.timePhrases.map((p) => ({ key: p.key, label: p.label, days: p.days, applied: p.applied })),
    // Track, room, speaker and tag names found in the text. Only suggestions: nothing is applied.
    suggestions,
    // Whether the Happening now chip can be used: the conference has talks today in its own zone.
    happening_now: { available: (today?.hits?.total?.value ?? 0) > 0 },
    results: hits.map((h) => toResult(h, labels)),
    facets,
  };
  // Present only when a text query was answered by keyword matching alone.
  if (query && !semantic) response.degraded = { semantic: true };
  if (debug) {
    // Position in each Elasticsearch-ordered child list, 1-based; nothing is re-sorted here.
    const positions = all.slice(2 + groups.length).map((r) => {
      const at = new Map();
      (r.hits?.hits ?? []).forEach((h, i) => at.set(String(h._source?.talk_id ?? h._id), i + 1));
      return at;
    });
    response.results.forEach((r, i) => {
      r.ranking = { rank: i + 1, keyword_rank: positions[0]?.get(r.talk_id) ?? null, semantic_rank: positions[1]?.get(r.talk_id) ?? null };
    });
    response.ranking = {
      rank_window: RANK_WINDOW,
      semantic_k: SEMANTIC_K,
      filters: {
        kind: filters.includeEvents ? 'talk and ambient' : 'talk',
        include_events: filters.includeEvents,
        day: filters.day,
        start_after: hhmm(filters.startAfter),
        start_before: hhmm(filters.startBefore),
        track: filters.track,
        level: filters.level,
        tags: [...filters.tags.values()].flat().map((key) => {
          const [group, value] = key.split(TAG_SEP);
          return { group, value };
        }),
        speaker: filters.speaker,
        room: filters.room,
        has_slides: filters.hasSlides,
        hide_sponsor: filters.hideSponsor,
        happening_now: filters.happeningNow,
        time_phrases: params.timePhrases.filter((p) => p.applied).map((p) => p.label),
      },
    };
  }
  return response;
}
