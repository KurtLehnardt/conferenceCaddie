// A Node port of the topic builder in scripts/topics.mjs, so public bundles need no Elasticsearch.
//
// The Elasticsearch version analyses each talk title with a custom analyzer (standard tokenizer,
// lowercase, a trailing 's stripped, a stop filter, no numbers or single characters, unigrams and
// bigrams that never span a removed word), counts talks per term, applies data/topics/{slug}.json
// and collapses single words into the two-word topics that almost always contain them. This module
// does the same in memory and returns the topic list plus the topics of every talk. The tokenizer
// is a regular-expression approximation of Unicode word segmentation, and the test suite compares
// the result against the snapshot of the live lists in contracts/fixtures/topics-live/.

import { readFileSync } from 'node:fs';

const MIN_TALKS = 3;
const MAX_TOPICS = 150;
const COLLAPSE_COVERAGE = 0.75;
const CANDIDATES = 400;
// The Lucene _english_ stop set, which the Elasticsearch analyzer used.
const ENGLISH_STOP = ['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const collator = new Intl.Collator('en');
const idOf = (term) => term.replace(/ /g, '-');

export function readStoplist(text) {
  return text.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The analysed terms of one title: [{ term, start, end }] for unigrams and for bigrams of
 * neighbouring kept words. Offsets point into the original title.
 */
export function analyse(title, stop) {
  const text = title.replace(/’/g, "'");
  const tokens = [];
  const re = /[\p{L}\p{N}_]+(?:['.:][\p{L}\p{N}_]+)*/gu;
  let m;
  let position = 0;
  while ((m = re.exec(text))) {
    let word = m[0].toLowerCase().replace(/'s$/, '');
    const keep = !stop.has(word) && word.length >= 2 && /\p{L}/u.test(word);
    if (keep) tokens.push({ term: word, start: m.index, end: m.index + m[0].length, position });
    position++;
  }
  const out = tokens.map((t) => ({ term: t.term, start: t.start, end: t.end }));
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i + 1].position === tokens[i].position + 1) {
      out.push({ term: `${tokens[i].term} ${tokens[i + 1].term}`, start: tokens[i].start, end: tokens[i + 1].end });
    }
  }
  return out;
}

/**
 * Builds the topics of one conference.
 *   talks      [{ talk_id, title }] of the kind:talk items
 *   stoplistText  the text of config/topic-stoplist.txt
 *   fixups     { rename, merge, remove } from data/topics/{slug}.json
 * Returns { topics: [{ topic_id, label, talk_count, rank, aliases }], talkTopics: Map talk_id -> [topic_id] }.
 */
export function buildTopics({ talks, stoplistText, fixups = {} }) {
  const fx = { rename: fixups.rename ?? {}, merge: fixups.merge ?? {}, remove: fixups.remove ?? [] };
  const stop = new Set([...ENGLISH_STOP, ...readStoplist(stoplistText)]);
  const perTalk = new Map();
  const docCount = new Map();
  for (const t of talks) {
    const terms = new Map(); // term -> first token
    for (const tok of analyse(t.title ?? '', stop)) if (!terms.has(tok.term)) terms.set(tok.term, tok);
    perTalk.set(t.talk_id, terms);
    for (const term of terms.keys()) docCount.set(term, (docCount.get(term) ?? 0) + 1);
  }
  const candidates = [...docCount.entries()]
    .filter(([, c]) => c >= MIN_TALKS)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, CANDIDATES)
    .map(([term, count]) => ({ term, count }));
  if (candidates.length === 0 && Object.keys(fx.merge).length === 0) {
    // A conference too small for any shared term has no topics; its talks have empty topic lists.
    return { topics: [], talkTopics: new Map(talks.map((t) => [t.talk_id, []])) };
  }
  const wanted = new Set(candidates.map((c) => c.term));
  for (const id of Object.keys(fx.merge)) wanted.add(id.replace(/-/g, ' '));

  const casings = new Map();
  const talkTerms = new Map();
  for (const t of talks) {
    const set = new Set();
    for (const [term, tok] of perTalk.get(t.talk_id)) {
      if (!wanted.has(term)) continue;
      set.add(term);
      const original = t.title.slice(tok.start, tok.end).replace(/\s+/g, ' ').trim();
      const m = casings.get(term) ?? new Map();
      m.set(original, (m.get(original) ?? 0) + 1);
      casings.set(term, m);
    }
    talkTerms.set(t.talk_id, set);
  }
  const labelOf = (term) => {
    const m = casings.get(term);
    if (!m) return term;
    return [...m.entries()].sort((a, b) => b[1] - a[1] || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) || collator.compare(a[0], b[0]))[0][0];
  };

  const topicIds = new Map();
  for (const c of candidates) topicIds.set(idOf(c.term), { term: c.term, label: labelOf(c.term), aliases: new Set(), members: new Set([c.term]) });
  for (const id of fx.remove) topicIds.delete(id);
  for (const [alias, canonical] of Object.entries(fx.merge)) {
    const target = topicIds.get(canonical);
    if (!target || !casings.has(alias.replace(/-/g, ' '))) continue;
    topicIds.delete(alias);
    target.aliases.add(alias);
    target.members.add(alias.replace(/-/g, ' '));
  }
  for (const [id, label] of Object.entries(fx.rename)) {
    const topic = topicIds.get(id);
    if (topic) topic.label = label;
  }

  const holds = (set, t) => [...t.members].some((m) => set.has(m));
  const bigramTopics = [...topicIds.values()].filter((t) => t.term.includes(' '));
  for (const [id, t] of [...topicIds]) {
    if (t.term.includes(' ')) continue;
    const words = new Set([...t.members].filter((m) => !m.includes(' ')));
    const containing = bigramTopics.filter((b) => b.term.split(' ').some((w) => words.has(w)));
    if (!containing.length) continue;
    let withWord = 0;
    let covered = 0;
    for (const set of talkTerms.values()) {
      if (!holds(set, t)) continue;
      withWord++;
      if (containing.some((b) => holds(set, b))) covered++;
    }
    if (withWord && covered / withWord >= COLLAPSE_COVERAGE) topicIds.delete(id);
  }

  const topics = [];
  for (const [id, t] of topicIds) {
    let count = 0;
    for (const set of talkTerms.values()) if (holds(set, t)) count++;
    topics.push({ topic_id: id, label: t.label, aliases: [...t.aliases].sort().map((a) => a.replace(/-/g, ' ')), talk_count: count, members: t.members });
  }
  topics.sort((a, b) => b.talk_count - a.talk_count || collator.compare(a.label, b.label) || collator.compare(a.topic_id, b.topic_id));
  topics.splice(MAX_TOPICS);
  topics.forEach((t, i) => { t.rank = i + 1; });

  const talkTopics = new Map();
  for (const t of talks) {
    const set = talkTerms.get(t.talk_id);
    talkTopics.set(t.talk_id, topics.filter((tp) => holds(set, tp)).map((tp) => tp.topic_id));
  }
  return {
    topics: topics.map(({ topic_id, label, talk_count, rank, aliases }) => ({ topic_id, label, talk_count, rank, aliases })),
    talkTopics,
  };
}

/** The fix-ups file of a conference, or an empty set when there is none. */
export function readFixups(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}
