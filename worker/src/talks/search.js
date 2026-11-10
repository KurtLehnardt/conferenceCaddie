// POST /api/search inside the ConferenceDO (PLAN section 1.7): validation and hybrid ranking,
// with the request and response shapes of server/search.mjs.
//
// Definitions, as in the Elasticsearch version:
// - B, the base filters: kind talk (or talk and ambient with include_events), the start_after and
//   start_before window, speaker and room names, hide_sponsor, happening_now (in progress or
//   starting within 60 minutes), and the time phrases found in the query.
// - M, the match set: for a text query the lexical matches (minimum_should_match "2<60%") united
//   with the 50 nearest talks of B by meaning; in browse mode (empty query) every talk.
// - S(g), the selection of facet group g: day, track, level, has_slides, and one group per tag
//   group (values of one group are ORed, different groups are ANDed).
// - total = |M ∩ B ∩ S(every group)|. Facet counts for group g are counted over
//   M ∩ B ∩ S(every group except g), so selecting a value keeps the other values' counts, and a
//   selected value with no match is listed with count 0.
// - Ranking: reciprocal rank fusion (rank constant 60, window 50) of the lexical list (bm25 order)
//   and the semantic list (best cosine of the title and abstract chunk vectors), each filtered by
//   B and S. Browse mode lists B ∩ S by start, then talk_id, paged with "from".
// - When the query embedding is unavailable the answer is keyword-only and carries
//   degraded.semantic; when the rows-read soft cap forces the in-memory lexical leg it carries
//   degraded.lexical.
// - "debug": true adds each result's 1-based position in the two fused lists (the ranking drawer).

import { bad, isPlainObject } from '../lib/http.js';
import { escapeHtml, marked, queryTerms } from '../lib/text.js';
import { embedQuery, EmbedUnavailable } from '../lib/embed.js';
import { dot, rrf } from '../lib/vectors.js';
import { knownValues, localDate, searchableTalks, talkStartDates, talkVecs } from './cache.js';
import { parseTimePhrases } from './phrases.js';
import { suggestChips } from './suggest.js';
import { lexicalLeg, snippets } from './lexical.js';
import { normalizeKey } from './analyze.js';
import { textStart, toResult, trimText } from './shape.js';

const TOP_KEYS = new Set(['conference', 'query', 'filters', 'saved_talk_ids', 'size', 'from', 'debug', 'ignore_phrases']);
const FILTER_KEYS = new Set(['day', 'start_after', 'start_before', 'track', 'level', 'tags', 'has_slides', 'speaker', 'room', 'hide_sponsor', 'happening_now', 'include_events']);
const MAX_FROM = 1000;
const RANK_WINDOW = 50;
const SEMANTIC_K = 50;
const EVIDENCE_CHUNK = 200;
const ABSTRACT_START = 200;
const HAPPENING_AHEAD_MS = 60 * 60_000;
const TAG_SEP = '\u001f';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^([a-z0-9][a-z0-9-]{0,119}):[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FACET_SIZES = { day: 100, track: 500, level: 100, tag_keys: 2000 };

// ---------------------------------------------------------------------------------------------
// Validation.

function parseTime(value, name) {
  if (value === null || value === undefined) return null;
  const m = typeof value === 'string' ? TIME_RE.exec(value) : null;
  if (!m) throw bad(`filters.${name} must be null or "HH:MM"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseValueList(value, name, known) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw bad(`filters.${name} must be an array of known values`);
  for (const v of value) if (typeof v !== 'string' || !known.has(v)) throw bad(`filters.${name} contains an unknown value`);
  return [...new Set(value)];
}

function parseNameList(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || !value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 300)) {
    throw bad(`filters.${name} must be an array of at most 10 names`);
  }
  return [...new Set(value)];
}

function parseTagShape(value) {
  if (value === null || value === undefined) return [];
  const msg = 'filters.tags must be an array of at most 50 {group, value} objects';
  if (!Array.isArray(value) || value.length > 50) throw bad(msg);
  for (const t of value) {
    if (!isPlainObject(t) || Object.keys(t).length !== 2 || typeof t.group !== 'string' || typeof t.value !== 'string'
      || t.group.length > 200 || t.value.length > 200 || t.group.includes(TAG_SEP) || t.value.includes(TAG_SEP)) throw bad(msg);
  }
  return value;
}

function tagSelection(pairs, known) {
  const byGroup = new Map();
  for (const { group, value } of pairs) {
    const key = group + TAG_SEP + value;
    if (!known.has(key)) throw bad('filters.tags contains an unknown value');
    if (!byGroup.has(group)) byGroup.set(group, []);
    const keys = byGroup.get(group);
    if (!keys.includes(key)) keys.push(key);
  }
  return byGroup;
}

export function validate(ctx, body) {
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  if (typeof body.conference !== 'string') throw bad('conference must be a string');
  const slug = body.conference;
  if (!SLUG_RE.test(slug) || slug !== ctx.slug) throw bad('conference is not available');
  if (typeof body.query !== 'string') throw bad('query must be a string');
  const query = body.query.trim();
  if (query.length > 200) throw bad('query must be at most 200 characters');

  let size = 10;
  if (body.size !== undefined) {
    if (!Number.isInteger(body.size) || body.size < 1 || body.size > 50) throw bad('size must be an integer from 1 to 50');
    size = body.size;
  }
  let from = 0;
  if (body.from !== undefined) {
    if (!Number.isInteger(body.from) || body.from < 0 || body.from > MAX_FROM) throw bad(`from must be an integer from 0 to ${MAX_FROM}`);
    from = body.from;
  }
  if (body.debug !== undefined && typeof body.debug !== 'boolean') throw bad('debug must be a boolean');

  let ignored = new Set();
  if (body.ignore_phrases !== undefined) {
    const list = body.ignore_phrases;
    if (!Array.isArray(list) || list.length > 20 || !list.every((k) => typeof k === 'string' && k.length <= 30)) {
      throw bad('ignore_phrases must be an array of at most 20 short strings');
    }
    ignored = new Set(list);
  }
  // saved_talk_ids is still accepted, so older clients keep working, but it never filters.
  if (body.saved_talk_ids !== undefined) {
    const ids = body.saved_talk_ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === 'string' && TALK_ID_RE.exec(id)?.[1] === slug)) {
      throw bad('saved_talk_ids must be at most 100 talk ids of this conference');
    }
  }

  const f = body.filters ?? {};
  if (!isPlainObject(f)) throw bad('filters must be an object');
  for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k)) throw bad(`Unknown filter: ${k.slice(0, 40)}`);
  if (f.has_slides !== undefined && f.has_slides !== null && typeof f.has_slides !== 'boolean') throw bad('filters.has_slides must be null, true or false');
  if (f.hide_sponsor !== undefined && typeof f.hide_sponsor !== 'boolean') throw bad('filters.hide_sponsor must be a boolean');
  if (f.happening_now !== undefined && typeof f.happening_now !== 'boolean') throw bad('filters.happening_now must be a boolean');
  if (f.include_events !== undefined && typeof f.include_events !== 'boolean') throw bad('filters.include_events must be a boolean');
  if (f.day !== undefined && f.day !== null && typeof f.day !== 'string') throw bad('filters.day must be null or a known day');
  const startAfter = parseTime(f.start_after, 'start_after');
  const startBefore = parseTime(f.start_before, 'start_before');
  const tagPairs = parseTagShape(f.tags);

  const doc = ctx.conf?.doc ?? {};
  const levelGroup = doc.category_mapping?.level_group ?? null;
  const tagGroups = Array.isArray(doc.category_mapping?.tag_groups) ? doc.category_mapping.tag_groups : [];
  const levelGiven = f.level !== undefined && f.level !== null && !(Array.isArray(f.level) && f.level.length === 0);
  if (levelGiven && !levelGroup) throw bad('filters.level is not available for this conference');

  const known = knownValues(ctx.store);
  if (f.day !== undefined && f.day !== null && !known.day.has(f.day)) throw bad('filters.day is not a known day');

  const time = parseTimePhrases(query, ctx.conf, ctx.store, ignored);
  if (from > 0 && time.text) throw bad('from is only accepted with an empty query');

  return {
    conference: slug,
    hasLevel: Boolean(levelGroup),
    tagGroups,
    query: time.text,
    timePhrases: time.phrases,
    size,
    from,
    debug: body.debug === true,
    timeZone: ctx.conf?.time_zone || 'UTC',
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
      phrasePredicates: time.predicates,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Filters as predicates over cached talk rows.

// A speaker name matches as a phrase inside one speaker's name (match_phrase in Elasticsearch).
const containsPhrase = (haystack, needle) => needle && ` ${haystack} `.includes(` ${needle} `);

export function basePredicate(f, now) {
  const kindOk = f.includeEvents ? (k) => k === 'talk' || k === 'ambient' : (k) => k === 'talk';
  const speakers = f.speaker.map(normalizeKey).filter(Boolean);
  const rooms = new Set(f.room);
  return (t) => {
    if (!kindOk(t.kind)) return false;
    if (f.startAfter !== null && !(Number.isFinite(t.start_minutes) && t.start_minutes >= f.startAfter)) return false;
    if (f.startBefore !== null && !(Number.isFinite(t.start_minutes) && t.start_minutes < f.startBefore)) return false;
    if (f.speaker.length) {
      const names = t.speakers.map(normalizeKey);
      if (!speakers.some((s) => names.some((n) => containsPhrase(n, s)))) return false;
    }
    if (rooms.size && !rooms.has(t.room)) return false;
    if (f.hideSponsor && t.sponsor) return false;
    if (f.happeningNow && !(t.end_ms > now && t.start_ms < now + HAPPENING_AHEAD_MS)) return false;
    for (const p of f.phrasePredicates) if (!p(t)) return false;
    return true;
  };
}

// The facet groups that have a selection, each with its test.
function selectedGroups(f) {
  const groups = [];
  if (f.day !== null) groups.push({ name: 'day', test: (t) => t.day === f.day });
  if (f.track.length) {
    const s = new Set(f.track);
    groups.push({ name: 'track', test: (t) => s.has(t.track) });
  }
  if (f.level.length) {
    const s = new Set(f.level);
    groups.push({ name: 'level', test: (t) => s.has(t.level) });
  }
  if (f.hasSlides !== null) groups.push({ name: 'has_slides', test: (t) => Boolean(t.has_slides) === f.hasSlides });
  for (const [group, keys] of f.tags) {
    const s = new Set(keys);
    groups.push({ name: `tag:${group}`, test: (t) => t.tag_keys.some((k) => s.has(k)) });
  }
  return groups;
}

const passes = (groups, t, except = null) => groups.every((g) => g.name === except || g.test(t));

// Terms-aggregation order: count descending, then the value ascending.
const bucketOrder = (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);

function countValues(list, valueOf, size) {
  const m = new Map();
  for (const t of list) {
    const v = valueOf(t);
    if (v === null || v === undefined || v === '') continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m].map(([value, count]) => ({ value, count })).sort(bucketOrder).slice(0, size);
}

function buildFacets(base, groups, f, hasLevel, tagGroups) {
  const memo = new Map();
  const setFor = (name) => {
    const key = groups.some((g) => g.name === name) ? name : '';
    if (!memo.has(key)) memo.set(key, base.filter((t) => passes(groups, t, key || null)));
    return memo.get(key);
  };
  const withSelected = (list, selected) => {
    for (const v of selected) if (!list.some((x) => x.value === v)) list.push({ value: v, count: 0 });
    return list;
  };
  const facets = {};
  facets.day = withSelected(countValues(setFor('day'), (t) => t.day, FACET_SIZES.day), f.day !== null ? [f.day] : [])
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  facets.track = withSelected(countValues(setFor('track'), (t) => t.track, FACET_SIZES.track), f.track);
  if (hasLevel) facets.level = withSelected(countValues(setFor('level'), (t) => t.level, FACET_SIZES.level), f.level);
  const slides = setFor('has_slides');
  const withSlides = slides.filter((t) => t.has_slides).length;
  facets.has_slides = [{ value: true, count: withSlides }, { value: false, count: slides.length - withSlides }];
  facets.tags = tagGroups.map((group) => {
    const prefix = group + TAG_SEP;
    const m = new Map();
    for (const t of setFor(`tag:${group}`)) {
      for (const k of new Set(t.tag_keys)) if (typeof k === 'string' && k.startsWith(prefix)) m.set(k, (m.get(k) ?? 0) + 1);
    }
    const values = [...m].map(([key, count]) => ({ value: key, count })).sort(bucketOrder).slice(0, FACET_SIZES.tag_keys)
      .map((b) => ({ value: b.value.slice(prefix.length), count: b.count }));
    for (const key of f.tags.get(group) ?? []) {
      const value = key.slice(prefix.length);
      if (!values.some((x) => x.value === value)) values.push({ value, count: 0 });
    }
    return { group, values };
  });
  return facets;
}

// ---------------------------------------------------------------------------------------------
// Semantic helpers, shared with recommendations and related talks.

// The best cosine of each talk's title and chunk vectors with q, over the given talks; the top k.
export function semanticTop(store, q, talks, k) {
  const vecs = talkVecs(store);
  const scored = [];
  for (const t of talks) {
    const e = vecs.get(t.talk_id);
    if (!e) continue;
    let best = -Infinity;
    for (const v of e.all) {
      const s = dot(q, v);
      if (s > best) best = s;
    }
    scored.push({ talk: t, score: best });
  }
  scored.sort((a, b) => b.score - a.score || (a.talk.start_ms ?? 0) - (b.talk.start_ms ?? 0) || (a.talk.talk_id < b.talk.talk_id ? -1 : 1));
  return scored.length > k ? scored.slice(0, k) : scored;
}

const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// The abstract chunk closest to q, skipping a chunk that only repeats the title, or null.
export function bestChunk(store, q, talk) {
  const e = talkVecs(store).get(talk.talk_id);
  if (!e || !q) return null;
  const title = plain(talk.title);
  let best = null;
  let bestScore = -Infinity;
  for (const c of e.chunks) {
    const p = plain(c.text);
    if (!p || p === title) continue;
    const s = dot(q, c.vec);
    if (s > bestScore) {
      bestScore = s;
      best = c.text;
    }
  }
  return best;
}

// Evidence in the preference order of evidenceFor in server/search.mjs: an abstract fragment with
// marks, a title with marks, the best semantic chunk, the start of the abstract, the title.
function evidenceFor(store, talk, snip, q) {
  if (snip?.snippet.includes('\u0002')) return marked(snip.snippet);
  if (snip?.title.includes('\u0002')) return marked(snip.title);
  const chunk = q ? bestChunk(store, q, talk) : null;
  if (chunk && chunk.trim()) return escapeHtml(trimText(chunk, EVIDENCE_CHUNK));
  if (talk.abstract && talk.abstract.trim()) return escapeHtml(textStart(talk.abstract, ABSTRACT_START));
  return escapeHtml(talk.title ?? '');
}

const hhmm = (m) => (m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

// ---------------------------------------------------------------------------------------------

export async function search(ctx, params) {
  const { conference, hasLevel, tagGroups, query, size, from, filters } = params;
  const store = ctx.store;
  const labels = store.topics().labels;
  const inBase = basePredicate(filters, ctx.now);
  const B = searchableTalks(store).filter(inBase);
  const groups = selectedGroups(filters);
  const degraded = {};

  let terms = [];
  let lexB = [];
  let semB = [];
  let q = null;
  let semantic = false;
  let base = B;
  if (query) {
    terms = queryTerms(query);
    const inB = new Set(B);
    const lex = lexicalLeg(ctx, terms);
    if (lex.memory) degraded.lexical = true;
    lexB = lex.list.filter((x) => inB.has(x.talk));
    try {
      q = await embedQuery(ctx, query);
      semB = semanticTop(store, q, B, SEMANTIC_K);
      semantic = true;
    } catch (err) {
      if (!(err instanceof EmbedUnavailable)) throw err;
      degraded.semantic = true;
    }
    const M = new Set([...lexB.map((x) => x.talk), ...semB.map((x) => x.talk)]);
    base = B.filter((t) => M.has(t));
  }
  const matched = base.filter((t) => passes(groups, t));

  let page;
  let lexList = [];
  let semList = [];
  if (query) {
    lexList = lexB.filter((x) => passes(groups, x.talk)).slice(0, RANK_WINDOW).map((x) => x.talk);
    semList = semB.filter((x) => passes(groups, x.talk)).map((x) => x.talk);
    const byId = new Map([...lexList, ...semList].map((t) => [t.talk_id, t]));
    page = rrf([lexList.map((t) => t.talk_id), semList.map((t) => t.talk_id)], { window: RANK_WINDOW })
      .slice(0, size).map((e) => byId.get(e.id));
  } else {
    page = matched.slice(from, from + size);
  }

  const snips = query && !degraded.lexical ? snippets(ctx, terms, page) : new Map();
  const today = localDate(ctx.now, params.timeZone);
  const response = {
    total: matched.length,
    conference,
    search_text: query,
    time_phrases: params.timePhrases.map((p) => ({ key: p.key, label: p.label, days: p.days, applied: p.applied })),
    suggestions: query ? suggestChips(store, query, filters) : [],
    happening_now: { available: talkStartDates(store, params.timeZone).has(today) },
    results: page.map((t) => toResult(t, labels, evidenceFor(store, t, snips.get(t.talk_id), q))),
    facets: buildFacets(base, groups, filters, hasLevel, tagGroups),
  };
  if (query && (degraded.semantic || degraded.lexical)) response.degraded = degraded;
  if (params.debug && query) {
    const at = (list) => new Map(list.map((t, i) => [t.talk_id, i + 1]));
    const kw = at(lexList);
    const sem = at(semList);
    response.results.forEach((r, i) => {
      r.ranking = { rank: i + 1, keyword_rank: kw.get(r.talk_id) ?? null, semantic_rank: semantic ? sem.get(r.talk_id) ?? null : null };
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
