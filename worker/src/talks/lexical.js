// The lexical leg of talk search (PLAN section 1.7).
//
// SQLite FTS5 does the matching. Rows read are a daily cap, so every query selects the FTS rowid
// (equal to the talks rowid) and never a stored column:
// - one `SELECT rowid, bm25(...)` whose only binding is the OR match string finds and orders the
//   talks, with the title weighted 2 as `title^2` was in Elasticsearch (queries of one or two terms
//   need every term, so they match with AND instead);
// - how many query terms each found talk holds is counted in memory, over the same folded,
//   Porter-stemmed word sets the fallback uses, and talks below minimum_should_match "2<60%" are
//   dropped. (A `SELECT rowid` per term, as first planned, costs about one row read per matching
//   talk and term, which measured 1,600 to 3,700 rows for a cold seven-term query; counting in
//   memory leaves only the one bm25 query, whose cost is one row per talk in the OR union.)
// - snippet() and highlight() run only for the talks of the returned page, one row each.
// Results are cached per normalised term list (LRU of 500) and snippets per term list and rowid,
// both cleared when the talks change.
//
// When the rows-read soft cap is reached (ctx.meter.lexicalAllowed() is false) the leg runs in
// memory instead, over folded, stemmed word sets of each talk, with the same "2<60%" rule.

import { ftsTerm, minimumShouldMatch } from '../lib/text.js';
import { memo, Lru, searchableTalks } from './cache.js';
import { termSet, words, stem } from './analyze.js';

const COLS = '{title abstract speakers speaker_taglines}';
export const LEXICAL_MIN_MATCH = '2<60%';
const LRU_MAX = 500;
const SNIPPET_MAX = 2000;
const START = '\u0002';
const END = '\u0003';

const keyOf = (terms) => [...terms].sort().join('\u0001');

// Only an FTS5 query error (for example a term the tokenizer turns into nothing) is treated as
// "no match"; anything else, such as a storage or daily-limit error, propagates.
function rows(ctx, query, ...bindings) {
  try {
    return ctx.sql.exec(query, ...bindings).toArray();
  } catch (err) {
    if (/fts5|syntax error|MATCH|unterminated/i.test(String(err?.message ?? ''))) return [];
    throw err;
  }
}

const byScore = (a, b) => b.score - a.score || (a.talk.start_ms ?? 0) - (b.talk.start_ms ?? 0) || (a.talk.talk_id < b.talk.talk_id ? -1 : a.talk.talk_id > b.talk.talk_id ? 1 : 0);

function runFts(ctx, terms) {
  const n = terms.length;
  const need = minimumShouldMatch(n, LEXICAL_MIN_MATCH);
  const match = `${COLS}: (${terms.map(ftsTerm).join(need >= n ? ' AND ' : ' OR ')})`;
  const index = need >= n ? null : memIndexById(ctx.store);
  const stems = terms.map(termStem);
  const out = [];
  for (const r of rows(ctx, 'SELECT rowid, bm25(talks_fts, 0, 2.0, 1.0, 1.0, 1.0) AS s FROM talks_fts WHERE talks_fts MATCH ?', match)) {
    const talk = ctx.store.talkByRowid(r.rowid);
    if (!talk) continue;
    let matched = n;
    if (index) {
      const e = index.get(talk.talk_id);
      if (!e) continue;
      matched = 0;
      for (const s of stems) if (e.title.has(s) || e.other.has(s)) matched += 1;
      // FTS5 found at least one term, even if the in-memory analysis disagrees.
      matched = Math.max(1, matched);
    }
    if (matched < need) continue;
    out.push({ talk, score: -r.s, matched });
  }
  return out.sort(byScore);
}

// The in-memory index of the fallback: folded, stemmed word sets per searchable talk.
const memIndex = (store) => memo(store, 'lexMem', () => searchableTalks(store).map((t) => ({
  talk: t,
  title: termSet(t.title),
  other: termSet([...t.speakers, ...t.speaker_taglines, t.abstract].join(' ')),
})));

const memIndexById = (store) => memo(store, 'lexMemById', () => new Map(memIndex(store).map((e) => [e.talk.talk_id, e])));

// A query term (already lowercased by queryTerms) folded and stemmed like the FTS5 tokenizer.
const termStem = (term) => stem(words(term)[0] ?? term);

// The fallback leg: each query term scores 2 in the title and 1 elsewhere.
export function memoryLexical(store, terms, entries = memIndex(store)) {
  const stems = [...new Set(terms.flatMap((t) => words(t)).map(stem))];
  const n = stems.length;
  if (!n) return [];
  const need = minimumShouldMatch(n, LEXICAL_MIN_MATCH);
  const out = [];
  for (const e of entries) {
    let matched = 0;
    let score = 0;
    for (const s of stems) {
      const inTitle = e.title.has(s);
      const inOther = e.other.has(s);
      if (inTitle || inOther) matched += 1;
      score += (inTitle ? 2 : 0) + (inOther ? 1 : 0);
    }
    if (matched >= need) out.push({ talk: e.talk, score, matched });
  }
  return out.sort(byScore);
}

// The lexical matches of a term list, best first: [{ talk, score, matched }], plus whether the
// in-memory fallback answered.
export function lexicalLeg(ctx, terms) {
  if (!terms.length) return { list: [], memory: false };
  if (!ctx.meter.lexicalAllowed()) return { list: memoryLexical(ctx.store, terms), memory: true };
  const lru = memo(ctx.store, 'lexLru', () => new Lru(LRU_MAX));
  const key = keyOf(terms);
  let list = lru.get(key);
  if (!list) {
    list = runFts(ctx, terms);
    lru.set(key, list);
  }
  return { list, memory: false };
}

// The abstract snippet and the highlighted title of each talk, made with the sentinels \u0002 and
// \u0003 around matched terms, for the talks of one page. A talk without any query term gives
// null. Cached per term list and talk.
//
// The rowid is cast in SQL: a JavaScript number may arrive as a REAL, and FTS5 then silently
// drops the rowid constraint and returns every matching row.
export function snippets(ctx, terms, talks) {
  const out = new Map();
  if (!terms.length || !talks.length) return out;
  const cache = memo(ctx.store, 'snippets', () => new Lru(SNIPPET_MAX));
  const key = keyOf(terms);
  const match = `${COLS}: (${terms.map(ftsTerm).join(' OR ')})`;
  for (const t of talks) {
    const k = `${key}\u0000${t._rowid}`;
    let v = cache.get(k);
    if (v === undefined) {
      const r = rows(
        ctx,
        `SELECT snippet(talks_fts, 2, ?, ?, '…', 32) AS sn, highlight(talks_fts, 1, ?, ?) AS hl FROM talks_fts WHERE talks_fts MATCH ? AND rowid = CAST(? AS INTEGER)`,
        START, END, START, END, match, t._rowid,
      )[0];
      v = r ? { snippet: String(r.sn ?? ''), title: String(r.hl ?? '') } : null;
      cache.set(k, v);
    }
    out.set(t.talk_id, v);
  }
  return out;
}
