// The lexical people leg (PLAN sections 1.4, 1.8 and 1.14): BM25 over people_fts with
// minimum_should_match '2<60%', by the rowid-only per-term method, with an in-memory LRU of results
// and an in-memory fallback once the day's rows-read soft cap is near.
//
// - One `SELECT rowid FROM people_fts WHERE people_fts MATCH ?` per query term counts how many
//   terms each row matched; rows meeting '2<60%' are kept. One more `SELECT rowid, bm25(...)` with
//   the OR of the terms orders them. Neither reads a content row (people_fts.rowid equals
//   people.rowid), and no statement binds more than one parameter.
// - Results are cached per (people fingerprint, columns, terms). The fingerprint changes whenever a
//   live person is added, removed or changes their text, so a cached result is never stale.
// - When ctx.meter.lexicalAllowed() is false, the same rule runs over lowercased word sets built in
//   memory once per person text, scored by matched terms, and no SQL runs at all.

import { queryTerms, ftsTerm, minimumShouldMatch, marked } from '../lib/text.js';

export const MSM = '2<60%';
const LRU_MAX = 200;
// people_fts columns: profile_id (0), about (1), expertise (2), interests (3).
export const FTS_COLUMN = { about: 1, expertise: 2, interests: 3 };

// One LRU per Store (and so per Durable Object), keyed by fingerprint, columns and terms.
const caches = new WeakMap();
function cacheOf(store) {
  let c = caches.get(store);
  if (!c) {
    c = new Map();
    caches.set(store, c);
  }
  return c;
}

// A cheap fingerprint of the live people's text: their number, and a sum over their rowids and
// text hashes. Any insert, delete, expiry or text change gives a new value.
export function peopleFingerprint(store) {
  let n = 0;
  let h = 0;
  for (const p of store.people()) {
    n += 1;
    const t = parseInt(String(p.text_hash ?? '0').slice(0, 8), 16) || 0;
    h = (h + Math.imul(p._rowid | 0, 2654435761) + t) % 4294967296;
  }
  return `${n}:${h}`;
}

const columnFilter = (columns) => `{${columns.join(' ')}}`;
const orExpression = (columns, terms) => `${columnFilter(columns)} : (${terms.map(ftsTerm).join(' OR ')})`;

// The rows of people_fts matching '2<60%' of the terms on the columns, best first, as
// [{ rowid, score }] (score: bm25, lower is better). Cached.
function ftsRows(ctx, columns, terms, fingerprint) {
  const key = `${fingerprint}\n${columns.join(',')}\n${terms.join(' ')}`;
  const cache = cacheOf(ctx.store);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const need = minimumShouldMatch(terms.length, MSM);
  const counts = new Map();
  for (const t of terms) {
    for (const r of ctx.sql.exec('SELECT rowid FROM people_fts WHERE people_fts MATCH ?', `${columnFilter(columns)} : ${ftsTerm(t)}`)) {
      counts.set(r.rowid, (counts.get(r.rowid) ?? 0) + 1);
    }
  }
  const kept = new Set();
  for (const [rowid, n] of counts) if (n >= need) kept.add(rowid);
  let rows = [];
  if (kept.size) {
    // Column weights: profile_id, about, expertise, interests. Only the filtered columns can match.
    for (const r of ctx.sql.exec('SELECT rowid, bm25(people_fts, 0.0, 1.0, 1.0, 1.0) AS s FROM people_fts WHERE people_fts MATCH ?', orExpression(columns, terms))) {
      if (kept.has(r.rowid)) rows.push({ rowid: r.rowid, score: r.s });
    }
    rows.sort((a, b) => a.score - b.score || a.rowid - b.rowid);
  }
  cache.set(key, rows);
  if (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The in-memory fallback.

const wordCache = new WeakMap(); // person -> { hash, sets: { about, expertise, interests } }

// A light stem so that plurals meet their singular, applied to text and terms alike.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const wordsOf = (s) => new Set(String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem));

function wordSets(p) {
  let e = wordCache.get(p);
  if (!e || e.hash !== p.text_hash) {
    e = { hash: p.text_hash, sets: { about: wordsOf(p.about), expertise: wordsOf(p.expertise), interests: wordsOf(p.interests) } };
    wordCache.set(p, e);
  }
  return e.sets;
}

function memoryLeg(columns, terms, candidates, k) {
  const need = minimumShouldMatch(terms.length, MSM);
  const stems = terms.map(stem);
  const scored = [];
  for (const p of candidates) {
    const sets = wordSets(p);
    let n = 0;
    for (const t of stems) if (columns.some((c) => sets[c].has(t))) n += 1;
    if (n >= need) scored.push({ p, n });
  }
  scored.sort((a, b) => b.n - a.n || b.p.updated_at_ms - a.p.updated_at_ms || (a.p.profile_id < b.p.profile_id ? -1 : 1));
  return scored.slice(0, k).map((x) => x.p);
}

// ---------------------------------------------------------------------------------------------

// The lexical leg: up to k candidates (an array of people) whose columns match the text, best
// first. state.fingerprint is computed once per ranking and reused. Returns an array of people.
export function lexicalLeg(ctx, columns, textValue, candidates, k, state) {
  const terms = queryTerms(textValue);
  if (!terms.length || !candidates.length) return [];
  if (!ctx.meter.lexicalAllowed()) {
    state.lexicalMemory = true;
    return memoryLeg(columns, terms, candidates, k);
  }
  if (state.fingerprint === undefined) state.fingerprint = peopleFingerprint(ctx.store);
  const allowed = new Set(candidates);
  const out = [];
  for (const { rowid } of ftsRows(ctx, columns, terms, state.fingerprint)) {
    const p = ctx.store.personByRowid(rowid);
    if (p && allowed.has(p)) {
      out.push(p);
      if (out.length >= k) break;
    }
  }
  return out;
}

// Marked fragments of expertise and about for a page of people, for the query's terms, as a Map
// profile_id -> HTML with <mark> (only rows where a term matched). One statement with the page's
// rowids (at most 50 parameters). Empty when lexical SQL is not allowed today.
export function snippets(ctx, people, textValue) {
  const out = new Map();
  const terms = queryTerms(textValue);
  if (!terms.length || !people.length || !ctx.meter.lexicalAllowed()) return out;
  const byRowid = new Map(people.map((p) => [p._rowid, p]));
  const rowids = [...byRowid.keys()].slice(0, 90);
  const rows = ctx.sql.exec(
    `SELECT rowid, snippet(people_fts, 2, char(2), char(3), '…', 32) AS ex, snippet(people_fts, 1, char(2), char(3), '…', 32) AS ab
     FROM people_fts WHERE people_fts MATCH ? AND rowid IN (${rowids.map(() => '?').join(', ')})`,
    orExpression(['expertise', 'about'], terms),
    ...rowids,
  );
  for (const r of rows) {
    const p = byRowid.get(r.rowid);
    if (!p) continue;
    const frag = [r.ex, r.ab].find((f) => typeof f === 'string' && f.includes('\u0002'));
    if (frag) out.set(p.profile_id, marked(frag).replace(/\s+/g, ' ').trim());
  }
  return out;
}
