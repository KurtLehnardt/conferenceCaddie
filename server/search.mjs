// Request validation and the Elasticsearch queries behind POST /api/search.
//
// Every ranking, count and highlight comes from Elasticsearch. This module only builds
// queries, validates input against values that Elasticsearch reports, and reshapes hits
// in the order Elasticsearch returned them.
//
// Query design
// - Text query: an rrf retriever over a lexical multi_match and a knn query on the
//   semantic_text field "semantic". The knn query uses a fixed k (SEMANTIC_K) and carries the
//   same filters as the rrf retriever, so the filters are applied before the nearest-neighbour
//   search. A plain "semantic" query on a dense semantic_text field sizes its neighbour set
//   from the request "size", which would make "total" change with "size"; the fixed k avoids
//   that. The query embedding is built by Elasticsearch from the semantic_text field's own
//   inference endpoint.
// - Empty query (browse mode): a bool filter query sorted by start ascending, then talk_id.
//
// Facet and total definition
// - Let M be the documents the main query matches: for a text query, the union of the lexical
//   matches (multi_match with minimum_should_match LEXICAL_MIN_MATCH) and the SEMANTIC_K nearest
//   neighbours; in browse mode, every document.
// - Let B be the base filters: kind is "talk", the start_after and start_before window,
//   hide_sponsor, and the must_not clauses for saved-talk overlaps.
// - Let S(g) be the selection in facet group g (day, track, level, has_slides).
// - total = |M ∩ B ∩ S(day) ∩ S(track) ∩ S(level) ∩ S(has_slides)|, which is the set the results
//   are drawn from.
// - The facet counts for group g are a terms aggregation over M ∩ B ∩ S(every group except g).
//   For a group with no selection that is exactly the total set, and the counts come from the
//   main query's aggregations. For a group with a selection, one extra size-0 query (same
//   retriever, same filters, minus that group's selection) runs in the same _msearch request.
// - A selected value that has no matching documents is still listed, with count 0, so the UI
//   can show it as selected.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ES_API_KEY = process.env.ES_API_KEY || '';
const ES_INDEX = process.env.ES_INDEX || 'caddie-talks';
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

const SOURCE_FIELDS = ['talk_id', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'flags', 'slides_url', 'url'];
const HIGHLIGHT_BASE = { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'] };

export class BadRequest extends Error {}
export class UpstreamError extends Error {}

// ---------------------------------------------------------------------------------------------
// Elasticsearch transport. Error bodies from Elasticsearch are never passed on; only the status
// code is kept, for the server log.

async function es(path, body, contentType = 'application/json') {
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${ES_API_KEY}`, 'Content-Type': contentType },
      body,
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

async function msearch(searches) {
  const body = searches.flatMap((s) => ['{}', JSON.stringify(s)]).join('\n') + '\n';
  const json = await es(`/${encodeURIComponent(ES_INDEX)}/_msearch`, body, 'application/x-ndjson');
  const responses = json.responses ?? [];
  if (responses.length !== searches.length || responses.some((r) => r.error)) {
    throw new UpstreamError('msearch item failed');
  }
  return responses;
}

// ---------------------------------------------------------------------------------------------
// Known filter values, from a terms aggregation over talks, cached for ten minutes.

let knownCache = null; // { at, promise }

async function fetchKnown() {
  const json = await es(`/${encodeURIComponent(ES_INDEX)}/_search`, JSON.stringify({
    size: 0,
    query: { term: { kind: 'talk' } },
    aggs: {
      day: { terms: { field: 'day', size: 100 } },
      track: { terms: { field: 'track', size: 500 } },
      level: { terms: { field: 'level', size: 100 } },
    },
  }));
  const keys = (name) => new Set((json.aggregations?.[name]?.buckets ?? []).map((b) => b.key));
  return { day: keys('day'), track: keys('track'), level: keys('level') };
}

function knownValues() {
  const now = Date.now();
  if (!knownCache || now - knownCache.at > KNOWN_TTL_MS) {
    const promise = fetchKnown();
    knownCache = { at: now, promise };
    promise.catch(() => {
      if (knownCache?.promise === promise) knownCache = null;
    });
  }
  return knownCache.promise;
}

// ---------------------------------------------------------------------------------------------
// Validation. Only the documented keys are accepted, and filter values must be known values.

const TOP_KEYS = new Set(['query', 'filters', 'saved_talk_ids', 'size']);
const FILTER_KEYS = new Set(['day', 'start_after', 'start_before', 'track', 'level', 'has_slides', 'hide_sponsor']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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

export async function validate(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);

  if (typeof body.query !== 'string') throw new BadRequest('query must be a string');
  const query = body.query.trim();
  if (query.length > 200) throw new BadRequest('query must be at most 200 characters');

  let size = 10;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1 || body.size > 50) throw new BadRequest('size must be an integer from 1 to 50');
    size = body.size;
  }

  let savedIds = [];
  if (body.saved_talk_ids !== undefined) {
    const ids = body.saved_talk_ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === 'string' && ID_RE.test(id))) {
      throw new BadRequest('saved_talk_ids must be at most 100 ids');
    }
    savedIds = [...new Set(ids)];
  }

  const f = body.filters ?? {};
  if (!isPlainObject(f)) throw new BadRequest('filters must be an object');
  for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k)) throw new BadRequest(`Unknown filter: ${k.slice(0, 40)}`);

  if (f.has_slides !== undefined && f.has_slides !== null && typeof f.has_slides !== 'boolean') {
    throw new BadRequest('filters.has_slides must be null, true or false');
  }
  if (f.hide_sponsor !== undefined && typeof f.hide_sponsor !== 'boolean') throw new BadRequest('filters.hide_sponsor must be a boolean');
  if (f.day !== undefined && f.day !== null && typeof f.day !== 'string') throw new BadRequest('filters.day must be null or a known day');
  const startAfter = parseTime(f.start_after, 'start_after');
  const startBefore = parseTime(f.start_before, 'start_before');

  const needsKnown = (f.day ?? null) !== null || (f.track?.length ?? 0) > 0 || (f.level?.length ?? 0) > 0;
  const known = needsKnown ? await knownValues() : { day: new Set(), track: new Set(), level: new Set() };
  if (f.day !== undefined && f.day !== null && !known.day.has(f.day)) throw new BadRequest('filters.day is not a known day');

  return {
    query,
    size,
    savedIds,
    filters: {
      day: f.day ?? null,
      startAfter,
      startBefore,
      track: parseValueList(f.track, 'track', known.track),
      level: parseValueList(f.level, 'level', known.level),
      hasSlides: f.has_slides ?? null,
      hideSponsor: f.hide_sponsor ?? false,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Query building.

async function savedConflictClauses(savedIds) {
  if (!savedIds.length) return [];
  const json = await es(`/${encodeURIComponent(ES_INDEX)}/_search`, JSON.stringify({
    size: savedIds.length,
    _source: ['start', 'end'],
    query: { bool: { filter: [{ term: { kind: 'talk' } }, { terms: { talk_id: savedIds } }] } },
  }));
  return (json.hits?.hits ?? [])
    .map((h) => h._source)
    .filter((s) => s?.start && s?.end)
    .map((s) => ({
      bool: {
        filter: [
          { term: { kind: 'talk' } },
          { range: { start: { lt: s.end } } },
          { range: { end: { gt: s.start } } },
        ],
      },
    }));
}

function baseClauses(filters, conflicts) {
  const clauses = [{ term: { kind: 'talk' } }];
  const minutes = {};
  if (filters.startAfter !== null) minutes.gte = filters.startAfter;
  if (filters.startBefore !== null) minutes.lt = filters.startBefore;
  if (Object.keys(minutes).length) clauses.push({ range: { start_minutes: minutes } });
  if (filters.hideSponsor) clauses.push({ bool: { must_not: [{ term: { sponsor: true } }] } });
  if (conflicts.length) clauses.push({ bool: { must_not: conflicts } });
  return clauses;
}

// The facet groups and the filter clause each one's selection adds.
const GROUPS = {
  day: (f) => (f.day !== null ? { term: { day: f.day } } : null),
  track: (f) => (f.track.length ? { terms: { track: f.track } } : null),
  level: (f) => (f.level.length ? { terms: { level: f.level } } : null),
  has_slides: (f) => (f.hasSlides !== null ? { term: { has_slides: f.hasSlides } } : null),
};

function selectionClauses(filters, except) {
  return Object.entries(GROUPS)
    .filter(([name]) => name !== except)
    .map(([, clause]) => clause(filters))
    .filter(Boolean);
}

const AGGS = {
  day: { terms: { field: 'day', size: 100 } },
  track: { terms: { field: 'track', size: 500 } },
  level: { terms: { field: 'level', size: 100 } },
  has_slides: { terms: { field: 'has_slides', size: 2 } },
};

function retrieverFor(query, filter) {
  return {
    rrf: {
      retrievers: [
        { standard: { query: { multi_match: { query, fields: LEXICAL_FIELDS, minimum_should_match: LEXICAL_MIN_MATCH } } } },
        {
          standard: {
            query: {
              knn: {
                field: 'semantic',
                k: SEMANTIC_K,
                num_candidates: SEMANTIC_CANDIDATES,
                filter,
                query_vector_builder: { text_embedding: { model_text: query } },
              },
            },
          },
        },
      ],
      filter,
      rank_window_size: RANK_WINDOW,
    },
  };
}

function matchBody(query, filter) {
  return query ? { retriever: retrieverFor(query, filter) } : { query: { bool: { filter } } };
}

function mainSearch(query, filter, size) {
  const body = {
    ...matchBody(query, filter),
    size,
    track_total_hits: true,
    _source: SOURCE_FIELDS,
    aggs: AGGS,
  };
  if (query) {
    body.highlight = {
      ...HIGHLIGHT_BASE,
      fields: {
        abstract: { fragment_size: 200, number_of_fragments: 1, no_match_size: 200 },
        title: { number_of_fragments: 0, no_match_size: 300 },
        semantic: { number_of_fragments: 2 },
      },
    };
  } else {
    body.sort = [{ start: 'asc' }, { talk_id: 'asc' }];
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

function facetSearch(query, filter, group) {
  return { ...matchBody(query, filter), size: 0, track_total_hits: false, aggs: { [group]: AGGS[group] } };
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

function toResult(hit) {
  const s = hit._source ?? {};
  return {
    talk_id: String(s.talk_id ?? hit._id),
    title: s.title ?? '',
    speakers: s.speakers ?? [],
    room: s.room ?? null,
    start: s.start,
    end: s.end,
    track: s.track,
    level: s.level,
    flags: s.flags ?? [],
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

// ---------------------------------------------------------------------------------------------

export async function search(params) {
  const { query, size, savedIds, filters } = params;
  const conflicts = await savedConflictClauses(savedIds);
  const base = baseClauses(filters, conflicts);

  const searches = [mainSearch(query, [...base, ...selectionClauses(filters, null)], size)];
  const extra = [];
  for (const [group, clause] of Object.entries(GROUPS)) {
    if (clause(filters)) {
      extra.push(group);
      searches.push(facetSearch(query, [...base, ...selectionClauses(filters, group)], group));
    }
  }

  const [main, ...rest] = await msearch(searches);
  const facets = {};
  for (const group of Object.keys(GROUPS)) {
    const i = extra.indexOf(group);
    const aggs = i === -1 ? main.aggregations : rest[i].aggregations;
    facets[group] = facetList(group, aggs?.[group]?.buckets ?? [], filters);
  }

  return {
    total: main.hits?.total?.value ?? 0,
    results: (main.hits?.hits ?? []).map(toResult),
    facets,
  };
}
