// Builds the topic list of one conference from its talk titles without Elasticsearch, and tags
// every talk with the topics found in its title. It is a Node port of scripts/topics.mjs, which
// ran the same steps inside an Elasticsearch analyzer.
//
// Usage:
//   node worker/ingest/topics-local.mjs --event <slug> [--top 50] [--compare <topics.ndjson>]
//        [--api <base> [--rebuild-topics]]
// With --compare it reads the topic documents of a backup (a caddie-topics-v1 ndjson file), keeps
// the ones of the event and prints how many of the top labels the two lists share.
// With --api it reads the topic list stored on the Worker (GET /admin/topics, which needs
// ADMIN_TOKEN) and, like push-ingest.mjs does, keeps it frozen unless --rebuild-topics is given.
//
// The analyzer (the "topic_terms" analyzer of the Elasticsearch version):
// 1. Words come from Intl.Segmenter (Unicode word boundaries, the same rules as Lucene's standard
//    tokenizer). A curly apostrophe is made straight first, so "what’s" is one word.
// 2. Each word is lowercased and a trailing 's is cut off, then dropped when it is in the English
//    stop list (Lucene's _english_ set) or in config/topic-stoplist.txt, shorter than two
//    characters, or without a letter. A dropped word still takes its position, so a two-word
//    topic never spans a dropped word.
// 3. The terms of a title are its single words and its pairs of neighbouring words.
// 4. Talks are counted per term (at least 3 talks, at most 150 topics, ordered by count and then
//    term). The label is the most common original casing found in the titles.
// 5. data/topics/{slug}.json can rename, merge (as aliases) or remove topics. It never adds one.
//    Then a single word that nearly always appears inside a kept two-word topic is collapsed into
//    it, so "cloud" and "native" do not sit beside "cloud native" (see COLLAPSE_COVERAGE).
//
// The topic list of a conference that already has topics on the Worker is frozen, because people
// store topic ids in their profiles. Only the topics of each talk, the talk counts and the ranks
// are recomputed against it; the ranks follow the same order rule as a fresh build.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cmp, compareTopics, mergeTargets } from '../../scripts/lib/topics.mjs';
import { ROOT, UsageError, adminClient, isSlug, normalizeApiBase, parseArgs, readAdminToken, readNdjson } from './lib.mjs';

export const MIN_TALKS = 3;
export const MAX_TOPICS = 150;
// A single-word topic is dropped when at least this share of the talks that hold it hold it as
// part of a kept two-word topic. At 0.75, "cloud" (28 of 37 talks inside "cloud native") goes and
// "llm" (13 of 20 inside "llm inference") stays. Measured on the KubeCon NA 2026 titles.
export const COLLAPSE_COVERAGE = 0.75;
// The number of candidates considered before the fix-ups, so removals leave room for others.
const CANDIDATES = 400;

// Lucene's _english_ stop set.
const ENGLISH_STOP = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on',
  'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
];

export function loadStoplist() {
  const text = readFileSync(join(ROOT, 'config', 'topic-stoplist.txt'), 'utf8');
  const extra = text.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([...ENGLISH_STOP, ...extra]);
}

export function loadFixups(slug) {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'data', 'topics', `${slug}.json`), 'utf8'));
    return { rename: parsed.rename || {}, merge: parsed.merge || {}, remove: parsed.remove || [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { rename: {}, merge: {}, remove: [] };
    throw new Error(`Cannot read data/topics/${slug}.json: ${err.message}`);
  }
}

const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const HAS_LETTER = /\p{L}/u;

// Returns a Map from term to the original text of its first occurrence in the title.
export function titleTerms(title, stop) {
  // U+2019 and the straight apostrophe have the same length, so offsets stay valid for `title`.
  const text = String(title).replace(/’/g, "'");
  const kept = [];
  let pos = 0;
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    pos++;
    const term = seg.segment.toLowerCase().replace(/'s$/, '');
    if (stop.has(term) || term.length < 2 || !HAS_LETTER.test(term)) continue;
    kept.push({ term, pos, start: seg.index, end: seg.index + seg.segment.length });
  }
  const terms = new Map();
  const note = (term, from, to) => {
    if (terms.has(term)) return;
    terms.set(term, text.slice(from, to).replace(/\s+/g, ' ').trim());
  };
  for (let i = 0; i < kept.length; i++) {
    note(kept[i].term, kept[i].start, kept[i].end);
    const next = kept[i + 1];
    if (next && next.pos === kept[i].pos + 1) note(`${kept[i].term} ${next.term}`, kept[i].start, next.end);
  }
  return terms;
}

// The order of the topic list: most talks first, then label, then topic id. Both the builder and a
// frozen list (assignFrozen) rank by this rule, and rank 1 is the first topic in this order. It is
// the comparator of scripts/lib/topics.mjs (the builder behind the bundles and the contract
// fixtures), which orders by UTF-16 code unit and so does not depend on the ICU version, instead
// of String.prototype.localeCompare, which orders accented and kana labels differently.
export { compareTopics };

const idOf = (term) => term.replace(/ /g, '-');
const termOf = (topicId) => topicId.replace(/-/g, ' ');

// Builds the topic list from scratch. `talks` are objects with talk_id and title (kind talk only).
// Returns { topics, assignments, warnings, collapsed }: topics are documents shaped like
// caddie-topics-v1 and assignments maps a talk_id to its topic ids in rank order.
export function buildTopics(talks, { slug, stop = loadStoplist(), fixups = loadFixups(slug) }) {
  const warnings = [];
  const perTalk = talks.map((t) => ({ id: t.talk_id, terms: titleTerms(t.title || '', stop) }));

  const counts = new Map();
  for (const { terms } of perTalk) for (const term of terms.keys()) counts.set(term, (counts.get(term) || 0) + 1);
  const candidates = [...counts.entries()]
    .filter(([, n]) => n >= MIN_TALKS)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, CANDIDATES)
    .map(([term, count]) => ({ term, count }));
  // A merge target that reaches MIN_TALKS only with its aliases stays a candidate (mergeTargets).
  candidates.push(...mergeTargets(perTalk.map((p) => p.terms), counts, fixups.merge, new Set(candidates.map((c) => c.term))));
  // With no candidate the steps below give an empty list and talks without topics, as the bundle
  // builder and tier 3 do for a conference too small for any shared term.
  if (candidates.length === 0) warnings.push('No term occurs in at least three talk titles; the conference has no topics.');

  // Alias terms are counted even when they occur in fewer than three talks.
  const wanted = new Set(candidates.map((c) => c.term));
  for (const id of Object.keys(fixups.merge)) wanted.add(termOf(id));

  const talkTerms = new Map(); // talk id -> Set of wanted terms
  const casings = new Map(); // term -> Map(original text -> count)
  for (const { id, terms } of perTalk) {
    const set = new Set();
    for (const [term, original] of terms) {
      if (!wanted.has(term)) continue;
      set.add(term);
      const m = casings.get(term) || new Map();
      m.set(original, (m.get(original) || 0) + 1);
      casings.set(term, m);
    }
    talkTerms.set(id, set);
  }
  const labelOf = (term) => {
    const m = casings.get(term);
    if (!m) return term;
    // Most common casing; ties go to the casing that has a capital letter, then alphabetical.
    return [...m.entries()].sort((a, b) => b[1] - a[1] || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) || cmp(a[0], b[0]))[0][0];
  };

  // Fix-ups. A fix-up never adds a topic: a merge needs its canonical topic to be a candidate, alone
  // or together with its aliases (mergeTargets).
  const topicIds = new Map(); // topic_id -> { term, label, aliases:Set<topic_id>, members:Set<term> }
  for (const c of candidates) topicIds.set(idOf(c.term), { term: c.term, label: labelOf(c.term), aliases: new Set(), members: new Set([c.term]) });
  for (const id of fixups.remove) {
    if (!topicIds.delete(id)) warnings.push(`Fix-up remove: unknown topic ${id}, ignored.`);
  }
  for (const [alias, canonical] of Object.entries(fixups.merge)) {
    const target = topicIds.get(canonical);
    if (!target) {
      warnings.push(`Fix-up merge ${alias} -> ${canonical}: canonical topic not present, ignored.`);
      continue;
    }
    if (!casings.has(termOf(alias))) {
      warnings.push(`Fix-up merge ${alias} -> ${canonical}: alias occurs in no title, ignored.`);
      continue;
    }
    topicIds.delete(alias);
    target.aliases.add(alias);
    target.members.add(termOf(alias));
  }
  for (const [id, label] of Object.entries(fixups.rename)) {
    const topic = topicIds.get(id);
    if (!topic) warnings.push(`Fix-up rename: unknown topic ${id}, ignored.`);
    else topic.label = label;
  }

  // Collapse single words into the two-word topics that almost always contain them. A talk
  // "holds" a topic when its title has any of the topic's member terms.
  const holds = (set, t) => [...t.members].some((m) => set.has(m));
  const bigramTopics = [...topicIds.values()].filter((t) => t.term.includes(' '));
  const collapsed = [];
  for (const [id, t] of topicIds) {
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
    if (withWord && covered / withWord >= COLLAPSE_COVERAGE) {
      topicIds.delete(id);
      collapsed.push(`${t.term} (${covered}/${withWord})`);
    }
  }

  // Talk counts: the number of talks holding the topic term or one of its merged alias terms.
  const topics = [];
  for (const [id, t] of topicIds) {
    let count = 0;
    for (const set of talkTerms.values()) if (holds(set, t)) count++;
    topics.push({ topic_id: id, label: t.label, aliases: [...t.aliases].sort(), talk_count: count, members: t.members });
  }
  topics.sort(compareTopics);
  topics.splice(MAX_TOPICS);
  topics.forEach((t, i) => { t.rank = i + 1; });

  const assignments = new Map();
  for (const { id } of perTalk) {
    const set = talkTerms.get(id) || new Set();
    assignments.set(id, topics.filter((t) => holds(set, t)).map((t) => t.topic_id));
  }
  const docs = topics.map((t) => ({
    conference: slug,
    topic_id: t.topic_id,
    label: t.label,
    label_exact: t.label,
    aliases: t.aliases.map(termOf),
    talk_count: t.talk_count,
    rank: t.rank,
  }));
  return { topics: docs, assignments, warnings, collapsed };
}

// Recomputes the topics of each talk against a frozen list (documents shaped like the ones
// GET /admin/topics returns). The ids, labels and aliases stay as they are, which keeps the topic
// ids people store in their profiles valid. talk_count is refreshed and the ranks are recomputed
// from the new counts with the builder's rule (compareTopics), so the list a later GET /api/topics
// serves is in the order buildTopics would give for the same talks. A topic whose count has
// fallen below MIN_TALKS or to zero is kept, at the end of the list. Each talk's topic ids are
// listed in the new rank order. Returns { topics, assignments }, with topics in rank order.
export function assignFrozen(talks, frozen, { slug, stop = loadStoplist() }) {
  const members = frozen.map((t) => new Set([termOf(t.topic_id), ...(t.aliases || []).map(termOf)]));
  const counts = new Array(frozen.length).fill(0);
  const matches = new Map(); // talk id -> indexes into `frozen`
  for (const talk of talks) {
    const terms = titleTerms(talk.title || '', stop);
    const hit = [];
    frozen.forEach((t, i) => {
      for (const m of members[i]) {
        if (terms.has(m)) {
          hit.push(i);
          counts[i]++;
          break;
        }
      }
    });
    matches.set(talk.talk_id, hit);
  }
  const ordered = frozen.map((t, i) => ({
    index: i,
    topic_id: t.topic_id,
    label: t.label,
    label_exact: t.label_exact ?? t.label,
    aliases: t.aliases || [],
    talk_count: counts[i],
  }));
  ordered.sort(compareTopics);
  const rankOf = new Array(frozen.length);
  ordered.forEach((t, r) => { rankOf[t.index] = r + 1; });
  const assignments = new Map();
  for (const [id, hit] of matches) {
    assignments.set(id, hit.sort((a, b) => rankOf[a] - rankOf[b]).map((i) => frozen[i].topic_id));
  }
  const topics = ordered.map((t) => ({
    conference: slug,
    topic_id: t.topic_id,
    label: t.label,
    label_exact: t.label_exact,
    aliases: t.aliases,
    talk_count: t.talk_count,
    rank: rankOf[t.index],
  }));
  return { topics, assignments };
}

// The topic list stored on the Worker for a conference, or [] when the Worker does not know it.
async function storedTopics(admin, slug) {
  let stored;
  try {
    stored = (await admin('GET', `/admin/topics?event=${encodeURIComponent(slug)}`)).topics;
  } catch (e) {
    // A 404 is the Worker's answer to a failed admin authorization (an unknown conference answers 400
    // instead), and in a dry run push-ingest's softAdmin turns any error into a 404. It means "nothing
    // stored" and not an error because a real run has already sent PUT /admin/conferences with the same
    // token, so a failed authorization would have stopped it there, and a dry run sends nothing.
    if (e.status !== 404) throw e;
    stored = [];
  }
  if (!Array.isArray(stored)) throw new Error('GET /admin/topics did not return a topics array.');
  return stored;
}

// Chooses between the stored list and a fresh one. `admin` is an adminClient or null.
// Returns { mode, topics, assignments, warnings, collapsed } where mode is 'frozen', 'built'
// (the Worker holds no topics yet, or --rebuild-topics), or 'built-offline' (no Worker to ask).
// A rebuild that finds no topics while the Worker holds some throws before any talk or topic is sent,
// unless allowEmpty (--allow-empty) is given; PUT /admin/topics refuses that change too.
export async function resolveTopics(talks, { slug, admin = null, rebuild = false, allowEmpty = false, stop = loadStoplist() }) {
  const topicTalks = talks.filter((t) => t.kind === 'talk');
  let stored = null;
  if (admin && !rebuild) {
    stored = await storedTopics(admin, slug);
    if (stored.length > 0) return { mode: 'frozen', warnings: [], collapsed: [], ...assignFrozen(topicTalks, stored, { slug, stop }) };
  }
  const built = buildTopics(topicTalks, { slug, stop });
  if (admin && built.topics.length === 0 && !allowEmpty) {
    const n = (stored ?? await storedTopics(admin, slug)).length;
    if (n > 0) throw new Error(`${slug}: the rebuilt topic list is empty and would replace the ${n} stored topics; no talk or topic was sent. Re-run with --allow-empty if the conference really has no topics.`);
  }
  return { mode: admin ? 'built' : 'built-offline', ...built };
}

// ---------------------------------------------------------------------------------------------
// Command line

function readEventTalks(slug) {
  return readNdjson(join(ROOT, 'data', slug, 'talks.ndjson'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['rebuild-topics'], values: ['event', 'top', 'compare', 'api'] });
  if (!isSlug(args.event)) throw new UsageError('Usage: node worker/ingest/topics-local.mjs --event <slug> [--top 50] [--compare <topics.ndjson>] [--api <base> [--rebuild-topics]]');
  const top = Number(args.top ?? 50);
  if (!Number.isInteger(top) || top < 1) throw new UsageError('--top must be a positive integer.');

  const talks = readEventTalks(args.event);
  let admin = null;
  if (args.api) {
    const token = readAdminToken();
    if (!token) throw new UsageError('--api needs ADMIN_TOKEN (or ADMIN_TOKEN_FILE).');
    admin = adminClient(normalizeApiBase(args.api), token);
  }
  // This command only reads, so an empty rebuilt list is reported rather than refused.
  const result = await resolveTopics(talks, { slug: args.event, admin, rebuild: args['rebuild-topics'], allowEmpty: true });
  for (const w of result.warnings) console.warn(w);
  const tagged = [...result.assignments.values()].filter((ids) => ids.length).length;
  console.log(`Event ${args.event}: ${talks.filter((t) => t.kind === 'talk').length} talks, ${result.topics.length} topics (${result.mode}), ${tagged} talks tagged.`);
  if (result.collapsed.length) console.log(`Collapsed into two-word topics: ${result.collapsed.join(', ')}.`);
  const shown = result.topics.slice(0, top);
  console.log(`Top ${shown.length} topics:`);
  for (const t of shown) console.log(`  ${String(t.talk_count).padStart(3)}  ${t.label}  (${t.topic_id})`);

  if (args.compare) {
    const other = readNdjson(args.compare)
      .filter((d) => d.conference === args.event)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, top);
    if (other.length === 0) throw new Error(`No topic documents for ${args.event} in the comparison file.`);
    const mine = new Set(shown.map((t) => t.label.toLowerCase()));
    const theirs = other.map((t) => t.label.toLowerCase());
    const shared = theirs.filter((l) => mine.has(l)).length;
    const missing = theirs.filter((l) => !mine.has(l));
    console.log(`Overlap of the top ${top} labels with the comparison file: ${(shared / Math.max(1, theirs.length)).toFixed(2)} (${shared}/${theirs.length}).`);
    if (missing.length) console.log(`Only in the comparison file: ${missing.join(', ')}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(e instanceof UsageError ? 1 : 2);
  });
}
