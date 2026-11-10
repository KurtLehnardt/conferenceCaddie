// GET /api/topics and POST /api/topics/suggest, ported from server/topics-api.mjs over the cached
// topic list (PLAN section 1.7).
//
// GET /api/topics?event=&q=&size=
//   Empty q: the topics by rank, then label. Otherwise type-ahead: every word of q but the last must
//   equal a word of the label or an alias, and the last may be a prefix of one (any word may match,
//   as the bool_prefix query did); a label that starts with the whole of q ranks highest. Ordered by
//   match quality, then talk_count, then label. size is at most 150; default 150 for an empty q
//   and 10 otherwise.
// POST /api/topics/suggest { event, talk_ids, text }
//   The topics of those talks (at most 8, most common first) always come first, then topics whose
//   label or aliases share words with the text. At most 12.

import { bad, isPlainObject } from '../lib/http.js';
import { STOPWORDS } from '../lib/text.js';
import { memo } from './cache.js';
import { words } from './analyze.js';
import { validEvent, validTalkIds } from './recommend.js';

const MAX_SIZE = 150;
const SUGGEST_MAX = 12;
const SUGGEST_FROM_TALKS = 8;
const QUERY_MAX = 60;
const TEXT_MAX = 500;
const TALK_TOPIC_BOOST = 1000;
const SUGGEST_KEYS = new Set(['event', 'talk_ids', 'text']);

const toTopic = (t) => ({ topic_id: t.topic_id, label: t.label, talk_count: t.talk_count ?? 0 });

const compiled = (store) => memo(store, 'topicIndex', () => store.topics().list.map((t) => ({
  t,
  label: words(t.label),
  labelText: words(t.label).join(' '),
  aliases: t.aliases.flatMap((a) => words(a)),
  aliasTexts: t.aliases.map((a) => words(a).join(' ')),
})));

const ordered = (a, b) => b.score - a.score || (b.e.t.talk_count ?? 0) - (a.e.t.talk_count ?? 0)
  || String(a.e.t.label_exact ?? '').localeCompare(String(b.e.t.label_exact ?? ''));

function typeAheadScore(e, tokens, qText) {
  let score = 0;
  tokens.forEach((tok, i) => {
    const last = i === tokens.length - 1;
    const hit = (w) => (last ? w.startsWith(tok) : w === tok);
    if (e.label.some(hit)) score += 2;
    else if (e.aliases.some(hit)) score += 1;
  });
  if (!score) return 0;
  if (e.labelText === qText) score += 4;
  else if (e.labelText.startsWith(qText)) score += 3;
  else if (e.aliasTexts.some((a) => a.startsWith(qText))) score += 1.5;
  return score;
}

export function listTopics(store, url) {
  const q = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (q.length > QUERY_MAX) throw bad(`q must be at most ${QUERY_MAX} characters`);
  let size = q ? 10 : MAX_SIZE;
  const rawSize = url.searchParams.get('size');
  if (rawSize !== null) {
    size = Number(rawSize);
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) throw bad(`size must be an integer from 1 to ${MAX_SIZE}`);
  }
  if (!q) return { topics: store.topics().list.slice(0, size).map(toTopic) };
  const tokens = words(q);
  if (!tokens.length) return { topics: [] };
  const qText = tokens.join(' ');
  const scored = [];
  for (const e of compiled(store)) {
    const score = typeAheadScore(e, tokens, qText);
    if (score > 0) scored.push({ e, score });
  }
  return { topics: scored.sort(ordered).slice(0, size).map((x) => toTopic(x.e.t)) };
}

export function validateSuggest(body) {
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!SUGGEST_KEYS.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  const textValue = body.text === undefined || body.text === null ? '' : body.text;
  if (typeof textValue !== 'string' || textValue.length > TEXT_MAX) throw bad(`text must be a string of at most ${TEXT_MAX} characters`);
  return {
    event: validEvent(body.event),
    talkIds: validTalkIds(body.talk_ids, 'talk_ids'),
    text: textValue.replace(/\s+/g, ' ').trim(),
  };
}

export function suggestTopics(store, { talkIds, text: textValue }) {
  const boost = new Map();
  if (talkIds.length) {
    const counts = new Map();
    for (const id of talkIds) {
      const t = store.talk(id);
      if (!t || t.kind !== 'talk') continue;
      for (const topic of new Set(t.topics)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, SUGGEST_FROM_TALKS);
    for (const [topic, n] of top) boost.set(topic, TALK_TOPIC_BOOST + n);
  }
  const textWords = new Set(words(textValue).filter((w) => !STOPWORDS.has(w)));
  if (!boost.size && !textWords.size) return { topics: [] };
  const scored = [];
  for (const e of compiled(store)) {
    let score = boost.get(e.t.topic_id) ?? 0;
    if (textWords.size) {
      const inLabel = e.label.filter((w) => textWords.has(w)).length;
      const inAlias = e.aliases.filter((w) => textWords.has(w)).length;
      if (inLabel) score += inLabel / Math.sqrt(e.label.length);
      if (inAlias) score += (0.5 * inAlias) / Math.sqrt(Math.max(1, e.aliases.length));
    }
    if (score > 0) scored.push({ e, score });
  }
  return { topics: scored.sort(ordered).slice(0, SUGGEST_MAX).map((x) => toTopic(x.e.t)) };
}
