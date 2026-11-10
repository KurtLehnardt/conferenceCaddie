// Ranking people relative to the requester (PLAN section 1.8). Every leg is computed in code over
// the in-memory people cache and fused with reciprocal rank fusion, replacing the Elasticsearch
// rrf retriever of server/people.mjs:
//   1. topics: my learn topics against their speak topics (sum of idf over the overlap);
//   2. topics: my speak topics against their learn topics;
//   3. text: the query, or else my interests, against their expertise vector;
//   4. text (query only): the query against their about vector;
//   5. text: my expertise against their interests vector;
//   6. text (query only, semantic mode): lexical BM25 on people_fts expertise and about;
//   7. distance (only when I am around with a position): people around with a position, by cell;
//   8. everyone (circles only): the circle's sharers, most recently updated first.
// Semantic legs keep only profiles at or above a similarity floor (SEMANTIC_FLOOR below).
// Every leg is skipped when its input is empty. On EmbedUnavailable the semantic legs become
// lexical legs on the same column and the result says degraded; a candidate with no vector yet
// (its embedding is pending) is reached by a lexical leg on the same column, interleaved with the
// semantic ranking, so a profile saved while the AI was down is still found.
//
// Candidates (gates 1 to 4): live, not the caller, not hidden, not blocked in either direction,
// then open_to_meet (matches) or sharing the circle's talk (circles), around (around_now), the
// extra filter, and onlyIds (Bluetooth sightings).
//
// rankPeople(ctx, me, opts) returns { hits, degraded } where hits is the page (from, size) before
// the specificity filter: [{ person, legs: string[], broad, evidence, passage }].

import { embedQuery, semanticAvailable, EmbedUnavailable, modelOf } from '../lib/embed.js';
import { topK, rrf } from '../lib/vectors.js';
import { cutText, escapeHtml } from '../lib/text.js';
import { lexicalLeg, snippets } from './lexical.js';
import { cellOf, distanceM, sharedTopics, plainEvidence, PASSAGE_MAX } from './view.js';

const KNN_K = 100;
const RANK_WINDOW = 100;
const DISTANCE_PIVOT_M = 100;

// The lowest cosine similarity a semantic people leg keeps, per embedding model. Elasticsearch's
// kNN returned the k nearest profiles whatever their score, and with E5 that was harmless. With
// bge-small, a conference's profiles all score between about 0.4 and 0.6 against a query they have
// nothing to do with (measured on the KubeCon sample profiles on 2026-11-10: unrelated profiles
// sit at a median of 0.39 to 0.60, a synthetic query's best unrelated profile at 0.53, and real
// matches at 0.65 to 0.93). Without a floor nearly every candidate joins every semantic leg, so
// anyone who also shares a common topic outranks the one person whose text actually matches.
// env.PEOPLE_SEMANTIC_FLOOR overrides the value; a model not listed here has no floor.
const SEMANTIC_FLOOR = { '@cf/baai/bge-small-en-v1.5': 0.55 };
function semanticFloor(ctx) {
  const v = Number.parseFloat(ctx.env?.PEOPLE_SEMANTIC_FLOOR ?? '');
  if (Number.isFinite(v)) return v;
  return SEMANTIC_FLOOR[modelOf(ctx)] ?? -Infinity;
}

const byRecent = (a, b) => b.updated_at_ms - a.updated_at_ms || (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0);

// The specificity rule: a hit is broad when every leg that found it is 'topics' or 'distance' and
// every topic it shares with the requester is one of the conference's ten most common. Being
// nearby is not experience, so the distance leg counts neither way.
export function isBroad(legs, me, them, common) {
  if (!legs.length || legs.some((l) => l !== 'topics' && l !== 'distance')) return false;
  return sharedTopics(me, them).every((t) => common.has(t));
}

// The candidates of a ranking, in a stable order.
function candidatesFor(ctx, me, { filter, when, circleTalkId, onlyIds }) {
  const store = ctx.store;
  const blocked = store.blockedIds(me.profile_id);
  const only = onlyIds ? new Set(onlyIds) : null;
  const out = [];
  for (const p of store.people()) {
    if (p.profile_id === me.profile_id || p.hidden || blocked.has(p.profile_id)) continue;
    if (circleTalkId) {
      if (!p.shared_talk_ids.includes(circleTalkId)) continue;
    } else if (!p.open_to_meet) {
      continue;
    }
    if (when === 'around_now' && !store.isAround(p)) continue;
    if (only && !only.has(p.profile_id)) continue;
    if (filter && !filter(p)) continue;
    out.push(p);
  }
  return out;
}

// A topics leg: people whose theirField overlaps my topics, by the sum of idf over the overlap,
// with idf = ln(1 + N / (1 + df)) and df counted over the candidates.
function topicsLeg(candidates, mine, theirField) {
  const want = new Set(mine);
  const df = new Map();
  for (const p of candidates) for (const t of p[theirField]) if (want.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = candidates.length;
  const scored = [];
  for (const p of candidates) {
    let s = 0;
    for (const t of new Set(p[theirField])) if (want.has(t)) s += Math.log(1 + n / (1 + df.get(t)));
    if (s > 0) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s || byRecent(a.p, b.p));
  return scored.map((x) => x.p);
}

// Interleaves two rankings (a first), skipping repeats.
function interleave(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    for (const x of [a[i], b[i]]) {
      if (x && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
  }
  return out;
}

export async function rankPeople(ctx, me, {
  filter = null, query = '', when = 'anyone', from = 0, size = 20, includeEveryone = false, circleTalkId = null, onlyIds = null,
} = {}) {
  const store = ctx.store;
  const candidates = candidatesFor(ctx, me, { filter, when, circleTalkId, onlyIds });
  if (!candidates.length) return { hits: [], degraded: false };

  const state = { semantic: semanticAvailable(ctx), degraded: false };
  // A query vector from the memory LRU or Workers AI, or null when the AI is unavailable (the
  // legs that needed it then run lexically and the answer says degraded).
  const vectorFor = async (textValue, stored) => {
    if (stored) return stored;
    if (!state.semantic) {
      state.degraded = true;
      return null;
    }
    try {
      return await embedQuery(ctx, textValue);
    } catch (err) {
      if (!(err instanceof EmbedUnavailable)) throw err;
      state.semantic = false;
      state.degraded = true;
      return null;
    }
  };

  const legs = []; // { name, ids: Person[], kind, field }
  const add = (name, people, kind = name, field = null) => legs.push({ name, people, kind, field });

  // A text leg on one of their fields: semantic over candidates with a vector, interleaved with a
  // lexical leg over candidates whose vector is pending; fully lexical when the AI is unavailable.
  const textLeg = async (field, textValue, storedVector) => {
    const vec = await vectorFor(textValue, storedVector);
    if (!vec) {
      add('text', lexicalLeg(ctx, [field], textValue, candidates, KNN_K, state), 'lexical', field);
      return;
    }
    const floor = semanticFloor(ctx);
    const semantic = topK(vec, candidates, KNN_K, (p) => p.vec[field]).filter((x) => x.score >= floor).map((x) => x.item);
    const pending = candidates.filter((p) => !p.vec[field] && p[field].trim());
    const lexical = pending.length ? lexicalLeg(ctx, [field], textValue, pending, KNN_K, state) : [];
    add('text', interleave(semantic, lexical).slice(0, KNN_K), 'semantic', field);
  };

  if (me.learn_topics.length) add('topics', topicsLeg(candidates, me.learn_topics, 'speak_topics'));
  if (me.speak_topics.length) add('topics', topicsLeg(candidates, me.speak_topics, 'learn_topics'));
  const textValue = query || me.interests || '';
  if (textValue) await textLeg('expertise', textValue, query ? null : me.vec.interests);
  if (query) await textLeg('about', query, null);
  if (me.expertise) await textLeg('interests', me.expertise, me.vec.expertise);
  if (query && state.semantic) add('text', lexicalLeg(ctx, ['expertise', 'about'], query, candidates, KNN_K, state), 'lexical', 'expertise+about');
  const myCell = cellOf(store, me);
  if (myCell) {
    const near = [];
    for (const p of candidates) {
      const c = cellOf(store, p);
      if (c) near.push({ p, s: DISTANCE_PIVOT_M / (DISTANCE_PIVOT_M + distanceM(myCell, c)) });
    }
    near.sort((a, b) => b.s - a.s || byRecent(a.p, b.p));
    add('distance', near.slice(0, KNN_K).map((x) => x.p));
  }
  if (includeEveryone) add('everyone', [...candidates].sort(byRecent));
  if (!legs.length) return { hits: [], degraded: false };

  const window = Math.max(RANK_WINDOW, from + size);
  const fused = rrf(legs.map((l) => l.people), { window });
  const page = fused.slice(from, from + size);
  const common = store.topics().common;

  // Evidence for the page only: a marked lexical fragment of expertise or about for a query, else
  // the field a semantic leg compared, else the start of their expertise or about.
  const people = page.map((f) => f.id);
  const marks = query ? snippets(ctx, people, query) : new Map();
  const semanticOn = (field) => legs.some((l) => l.kind === 'semantic' && l.field === field);
  const lexicalOn = (field, i) => i.some((k) => legs[k].kind === 'lexical' && legs[k].field.split('+').includes(field));

  const hits = page.map((f) => {
    const p = f.id;
    const names = f.legs.map((i) => legs[i].name);
    const broad = isBroad(names, me, p, common);
    let evidence = marks.get(p.profile_id) ?? null;
    if (!evidence) {
      const field = semanticOn('expertise') && p.vec.expertise && p.expertise ? 'expertise' : semanticOn('about') && p.vec.about && p.about ? 'about' : null;
      const cut = field ? cutText(p[field], PASSAGE_MAX) : '';
      evidence = cut ? escapeHtml(cut) : plainEvidence(p);
    }
    // The passage a reason or a nudge quotes: the matched field text, plain.
    let passage = null;
    if (semanticOn('expertise') && p.vec.expertise && p.expertise) passage = p.expertise;
    else if (semanticOn('interests') && p.vec.interests && p.interests) passage = p.interests;
    else if (lexicalOn('expertise', f.legs) && p.expertise) passage = p.expertise;
    else if (lexicalOn('interests', f.legs) && p.interests) passage = p.interests;
    passage = passage ? cutText(passage, PASSAGE_MAX) || null : null;
    return { person: p, legs: names, broad, evidence: broad ? null : evidence, passage };
  });
  return { hits, degraded: state.degraded };
}
