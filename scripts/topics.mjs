// Builds the topic list of one conference from its talk titles and tags every talk with the
// topics found in its title.
//
// Usage: node scripts/topics.mjs --event <slug> [--dry-run] [--allow-empty] [--allow-shrink]
//        [--talks-index name] [--topics-index name] [--work-index name]
// Env:   ES_URL (required, no default), and an admin-capable key in ES_ADMIN_API_KEY,
//        ELASTISEARCH_API_KEY or ES_API_KEY (the topics step writes, so the read-only key is not enough).
//
// How it works:
// 1. The titles of the conference's kind:talk documents are copied into a temporary work index whose
//    title field is analysed in Elasticsearch: standard tokenizer, lowercase, a trailing 's stripped,
//    a stop filter that uses _english_ plus config/topic-stoplist.txt, no stemming, unigrams and
//    bigrams, and no numbers or single characters. A bigram never spans a removed word, because the
//    shingle filter fills the gap with a filler token and every token that contains the filler is dropped.
// 2. A terms aggregation on that field counts talks per term (at least 3 talks, at most 150 topics).
// 3. Term vector offsets give each term its most common original casing, and give each talk its terms.
// 4. data/topics/{slug}.json can rename, merge (as aliases) or remove topics. A merge never creates a target that occurs in no title (a target below three talks
//    becomes a topic when its aliases bring it to three), and a fix-up never adds any other topic.
//    Then a single word that nearly always appears inside a kept two-word topic is collapsed into
//    it, so "cloud" and "native" do not sit beside "cloud native" (see COLLAPSE_COVERAGE).
// 5. The conference's topic documents are replaced (only when they differ), and talks.topics is set
//    with a Bulk API partial update that omits title and abstract, only where the value changed.
// With --dry-run nothing is written to the topics or talks index: the topic list is printed as JSON
// and the script stops. An empty result never replaces stored topics unless --allow-empty is passed, and a list that
// drops more than 10 topics and 10% of the stored ones needs --allow-shrink (--allow-empty implies it). Only the temporary work index is created and deleted.
// The work index is deleted at the end. Re-running with the same data changes nothing.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { candidatesWithTargets, checkNotShrinking, checkWorkIndexCount } from './lib/topics-candidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { esUrlOrExit } from './lib/es-url.mjs';
const API_KEY = process.env.ES_ADMIN_API_KEY || process.env.ELASTISEARCH_API_KEY || process.env.ES_API_KEY;
if (!API_KEY) {
  console.error('Set ELASTISEARCH_API_KEY (or ES_ADMIN_API_KEY). The topics step writes, so it needs a key with write access.');
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const dryRun = flag('--dry-run');
const allowEmpty = flag('--allow-empty');
const allowShrink = flag('--allow-shrink');
const slug = opt('--event');
const talksIndex = opt('--talks-index') || 'caddie-talks';
const topicsFlag = opt('--topics-index');
const topicsIndex = topicsFlag || 'caddie-topics';
// Unique per run, so a dry run or a second run never deletes the work index of a run in progress.
const workIndex = opt('--work-index') || `caddie-topicwork-${slug}-${process.pid}-${Date.now().toString(36)}`;
if (!slug || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
  console.error('Usage: node scripts/topics.mjs --event <slug> [--talks-index name] [--topics-index name] [--work-index name] [--dry-run] [--allow-empty] [--allow-shrink]');
  process.exit(1);
}
// createWorkIndex deletes this index first, so only a work index name is accepted.
if (!/^caddie-topicwork-[a-z0-9._-]+$/.test(workIndex)) {
  console.error('--work-index must start with caddie-topicwork- (the script deletes that index).');
  process.exit(1);
}

const MIN_TALKS = 3;
const MAX_TOPICS = 150;
// A single-word topic is dropped when at least this share of the talks that hold it hold it as
// part of a kept two-word topic. At 0.75, "cloud" (28 of 37 talks inside "cloud native") goes and
// "llm" (13 of 20 inside "llm inference") stays. Measured on the KubeCon NA 2026 titles.
const COLLAPSE_COVERAGE = 0.75;
const CANDIDATES = 400; // the aggregation returns more than the cap so fix-ups can remove some

async function es(method, urlPath, body, ndjson = false) {
  const res = await fetch(esUrlOrExit() + urlPath, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

function fail(what, res) {
  const reason = res.json?.error?.reason ?? res.json?.error?.type ?? JSON.stringify(res.json).slice(0, 300);
  throw new Error(`${what} failed with status ${res.status}: ${reason}`);
}

async function bulk(lines) {
  if (lines.length === 0) return { errors: 0, items: [] };
  const res = await es('POST', '/_bulk?refresh=wait_for', lines.map((l) => JSON.stringify(l)).join('\n') + '\n', true);
  if (res.status !== 200) fail('Bulk request', res);
  const failed = (res.json.items || []).filter((it) => Object.values(it)[0].error);
  if (failed.length) {
    const first = Object.values(failed[0])[0].error;
    throw new Error(`Bulk request had ${failed.length} failed items, first: ${first.type}: ${first.reason}`);
  }
  return res.json;
}

// ---------------------------------------------------------------------------------------------
// Mappings

const TOPICS_MAPPING = {
  dynamic: false,
  properties: {
    conference: { type: 'keyword' },
    topic_id: { type: 'keyword' },
    label: { type: 'search_as_you_type' },
    label_exact: { type: 'keyword' },
    aliases: { type: 'search_as_you_type' },
    talk_count: { type: 'integer' },
    rank: { type: 'integer' },
  },
};

async function ensureTopicsIndex() {
  const exists = await es('HEAD', `/${topicsIndex}`);
  if (exists.status === 200) return;
  // With the default (the alias) the versioned index and the alias are created. With a development
  // name from --topics-index the index is created on its own.
  const physical = topicsFlag ? topicsIndex : 'caddie-topics-v1';
  const created = await es('PUT', `/${physical}`, {
    settings: { number_of_shards: 1 },
    mappings: TOPICS_MAPPING,
    ...(topicsFlag ? {} : { aliases: { [topicsIndex]: {} } }),
  });
  if (created.status !== 200) fail(`Creating ${physical}`, created);
  console.log(`Created ${physical}${topicsFlag ? '' : ` with alias ${topicsIndex}`}.`);
}

async function createWorkIndex(stopwords) {
  await es('DELETE', `/${workIndex}`);
  const filler = '~';
  const created = await es('PUT', `/${workIndex}`, {
    settings: {
      number_of_shards: 1,
      analysis: {
        char_filter: {
          // The standard tokenizer keeps a curly apostrophe inside a word, so "what’s" must become
          // "what's" before the stop filter sees it.
          curly_apostrophe: { type: 'mapping', mappings: ['’ => \''] },
        },
        filter: {
          topic_stop: { type: 'stop', stopwords: ['_english_', ...stopwords] },
          // Strips a trailing 's before the stop filter, so "what's", "here's" and "let's" are
          // removed by the plain words in the stoplist.
          possessive: { type: 'pattern_replace', pattern: '\'s$', replacement: '' },
          // Drops tokens that are shorter than two characters or hold no letter (numbers). The token
          // position gap stays, so no bigram can span it.
          keep_words: {
            type: 'predicate_token_filter',
            script: {
              source:
                'String t = token.term.toString(); if (t.length() < 2) return false; for (int i = 0; i < t.length(); i++) { if (Character.isLetter(t.charAt(i))) return true; } return false;',
            },
          },
          topic_shingle: {
            type: 'shingle',
            min_shingle_size: 2,
            max_shingle_size: 2,
            output_unigrams: true,
            filler_token: filler,
          },
          drop_filled: {
            type: 'predicate_token_filter',
            script: { source: `return token.term.toString().indexOf('${filler}') < 0;` },
          },
        },
        analyzer: {
          topic_terms: {
            type: 'custom',
            char_filter: ['curly_apostrophe'],
            tokenizer: 'standard',
            filter: ['lowercase', 'possessive', 'topic_stop', 'keep_words', 'topic_shingle', 'drop_filled'],
          },
        },
      },
    },
    mappings: {
      dynamic: false,
      properties: {
        title: { type: 'text', analyzer: 'topic_terms', fielddata: true, term_vector: 'with_positions_offsets' },
      },
    },
  });
  if (created.status !== 200) fail(`Creating work index ${workIndex}`, created);
}

// ---------------------------------------------------------------------------------------------
// Data

async function readStoplist() {
  const text = await readFile(path.join(ROOT, 'config', 'topic-stoplist.txt'), 'utf8');
  return text.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function readFixups() {
  try {
    const parsed = JSON.parse(await readFile(path.join(ROOT, 'data', 'topics', `${slug}.json`), 'utf8'));
    return { rename: parsed.rename || {}, merge: parsed.merge || {}, remove: parsed.remove || [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { rename: {}, merge: {}, remove: [] };
    throw new Error(`Cannot read data/topics/${slug}.json: ${err.message}`);
  }
}

async function loadTalks() {
  const res = await es('POST', `/${talksIndex}/_search`, {
    size: 10000,
    _source: ['title', 'topics'],
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }] } },
    sort: [{ _doc: 'asc' }],
  });
  if (res.status !== 200) fail(`Reading talks from ${talksIndex}`, res);
  return res.json.hits.hits.map((h) => ({ id: h._id, title: h._source.title || '', topics: h._source.topics || [] }));
}

const idOf = (term) => term.replace(/ /g, '-');

async function main() {
  const stopwords = await readStoplist();
  const fixups = await readFixups();

  const talks = await loadTalks();
  if (talks.length === 0) throw new Error(`No kind:talk documents for conference ${slug} in ${talksIndex}. Ingest the conference first.`);

  if (!dryRun) await ensureTopicsIndex();
  try {
    await createWorkIndex(stopwords);
    // Work index: one document per talk, with the same _id as the talk.
    const lines = [];
    for (const t of talks) lines.push({ index: { _index: workIndex, _id: t.id } }, { title: t.title });
    await bulk(lines);
    // The work index must hold exactly this conference's talks, or it was clobbered or never filled.
    const counted = await es('GET', `/${workIndex}/_count`);
    if (counted.status !== 200) fail('Counting the work index', counted);
    checkWorkIndexCount(talks.length, counted.json.count);

    // Count talks per term with a terms aggregation on the analysed title.
    // Aliases and merge targets are counted even when they occur in fewer than three talks. A target
    // that reaches three talks together with its aliases stays a candidate (mergeTargets, shared
    // with the bundle builder).
    const aliasTerms = [...new Set(Object.entries(fixups.merge).flatMap(([a, c]) => [a, c]).map((id) => id.replace(/-/g, ' ')))];
    const agg = await es('POST', `/${workIndex}/_search`, {
      size: 0,
      aggs: {
        terms: { terms: { field: 'title', size: CANDIDATES, min_doc_count: MIN_TALKS, order: [{ _count: 'desc' }, { _key: 'asc' }] } },
        // Alias and target terms are counted even when they occur in fewer than three talks.
        ...(aliasTerms.length ? { alias_terms: { terms: { field: 'title', include: aliasTerms, size: aliasTerms.length, min_doc_count: 1 } } } : {}),
      },
    });
    if (agg.status !== 200) fail('Terms aggregation', agg);
    const termBuckets = agg.json.aggregations.terms.buckets;
    const aliasBuckets = agg.json.aggregations.alias_terms?.buckets ?? [];
    const wanted = new Set(termBuckets.map((b) => b.key));
    for (const t of aliasTerms) wanted.add(t);

    // Term vectors with offsets: the terms of each talk and the original text behind each term.
    const talkTerms = new Map(); // talk id -> Set of wanted terms
    const casings = new Map(); // term -> Map(original text -> count)
    for (let i = 0; i < talks.length; i += 200) {
      const batch = talks.slice(i, i + 200);
      const tv = await es('POST', `/${workIndex}/_mtermvectors`, {
        ids: batch.map((t) => t.id),
        parameters: { fields: ['title'], offsets: true, positions: false, term_statistics: false, field_statistics: false },
      });
      if (tv.status !== 200) fail('Term vectors', tv);
      for (const doc of tv.json.docs) {
        const title = talks.find((t) => t.id === doc._id).title;
        const set = new Set();
        const terms = doc.term_vectors?.title?.terms || {};
        for (const [term, info] of Object.entries(terms)) {
          if (!wanted.has(term)) continue;
          set.add(term);
          const tok = info.tokens[0];
          const original = title.slice(tok.start_offset, tok.end_offset).replace(/\s+/g, ' ').trim();
          const m = casings.get(term) || new Map();
          m.set(original, (m.get(original) || 0) + 1);
          casings.set(term, m);
        }
        talkTerms.set(doc._id, set);
      }
    }
    // The regular candidates, then the merge targets below three talks on their own that reach three
    // with their aliases (mergeTargets, as in scripts/lib/topics.mjs buildTopics). No candidate
    // at all means no topics; checkNotWiping then refuses to replace a stored list with that.
    const candidates = candidatesWithTargets({ termBuckets, aliasBuckets, talkTerms: talkTerms.values(), merge: fixups.merge });
    const labelOf = (term) => {
      const m = casings.get(term);
      if (!m) return term;
      // Most common casing; ties go to the casing that has a capital letter, then alphabetical.
      return [...m.entries()].sort((a, b) => b[1] - a[1] || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) || a[0].localeCompare(b[0]))[0][0];
    };

    // Fix-ups. A merge never creates a target that occurs in no title: the target must be a candidate,
    // and a target below three talks is one when its aliases bring it to three.
    const topicIds = new Map(); // topic_id -> { term, label, aliases:Set<topic_id>, members:Set<term> }
    for (const c of candidates) {
      topicIds.set(idOf(c.term), { term: c.term, label: labelOf(c.term), aliases: new Set(), members: new Set([c.term]) });
    }
    for (const id of fixups.remove) {
      if (!topicIds.delete(id)) console.warn(`Fix-up remove: unknown topic ${id}, ignored.`);
    }
    for (const [alias, canonical] of Object.entries(fixups.merge)) {
      const target = topicIds.get(canonical);
      if (!target) {
        console.warn(`Fix-up merge ${alias} -> ${canonical}: canonical topic not present, ignored.`);
        continue;
      }
      if (!casings.has(alias.replace(/-/g, ' '))) {
        console.warn(`Fix-up merge ${alias} -> ${canonical}: alias occurs in no title, ignored.`);
        continue;
      }
      topicIds.delete(alias);
      target.aliases.add(alias);
      target.members.add(alias.replace(/-/g, ' '));
    }
    for (const [id, label] of Object.entries(fixups.rename)) {
      const topic = topicIds.get(id);
      if (!topic) console.warn(`Fix-up rename: unknown topic ${id}, ignored.`);
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
    if (collapsed.length) (dryRun ? console.error : console.log)(`Collapsed into two-word topics: ${collapsed.join(', ')}.`);

    // Talk counts: the number of talks holding the topic term or one of its merged alias terms.
    const topics = [];
    for (const [id, t] of topicIds) {
      let count = 0;
      for (const set of talkTerms.values()) if ([...t.members].some((m) => set.has(m))) count++;
      topics.push({ topic_id: id, label: t.label, aliases: [...t.aliases].sort(), talk_count: count, members: t.members });
    }
    topics.sort((a, b) => b.talk_count - a.talk_count || a.label.localeCompare(b.label) || a.topic_id.localeCompare(b.topic_id));
    topics.splice(MAX_TOPICS);
    topics.forEach((t, i) => { t.rank = i + 1; });

    const stored = await es('POST', `/${topicsIndex}/_search`, {
      size: 10000,
      query: { term: { conference: slug } },
      sort: [{ rank: 'asc' }],
    });
    // A dry run may run before the topics index exists: nothing is stored then.
    const storedHits = stored.status === 404 && dryRun ? [] : stored.status === 200 ? stored.json.hits.hits : fail(`Reading ${topicsIndex}`, stored);
    checkNotShrinking(topics.length, storedHits.length, { allowEmpty, allowShrink });
    if (dryRun) {
      console.log(JSON.stringify(topics.map((t) => ({ topic_id: t.topic_id, label: t.label, talk_count: t.talk_count, rank: t.rank, aliases: t.aliases.map((a) => a.replace(/-/g, ' ')) }))));
      return;
    }

    // Replace the conference's topic documents, but only when they differ from what is stored.
    const desired = topics.map((t) => ({
      conference: slug,
      topic_id: t.topic_id,
      label: t.label,
      label_exact: t.label,
      aliases: t.aliases.map((a) => a.replace(/-/g, ' ')),
      talk_count: t.talk_count,
      rank: t.rank,
    }));
    const same = JSON.stringify(storedHits.map((h) => h._source)) === JSON.stringify(desired.map((d) => d));
    let topicsWritten = 0;
    if (!same) {
      const del = await es('POST', `/${topicsIndex}/_delete_by_query?refresh=true&conflicts=proceed`, { query: { term: { conference: slug } } });
      if (del.status !== 200) fail(`Deleting old topics from ${topicsIndex}`, del);
      const tl = [];
      for (const d of desired) tl.push({ index: { _index: topicsIndex, _id: `${slug}:${d.topic_id}` } }, d);
      await bulk(tl);
      topicsWritten = desired.length;
    }

    // Tag talks. Order follows topic rank. Partial update, no title or abstract, only where changed.
    const rankOrder = topics.map((t) => t);
    const ul = [];
    for (const talk of talks) {
      const set = talkTerms.get(talk.id) || new Set();
      const value = rankOrder.filter((t) => [...t.members].some((m) => set.has(m))).map((t) => t.topic_id);
      if (JSON.stringify(value) === JSON.stringify(talk.topics)) continue;
      ul.push({ update: { _index: talksIndex, _id: talk.id } }, { doc: { topics: value } });
    }
    await bulk(ul);

    console.log(`Event ${slug}: ${talks.length} talks, ${topics.length} topics.`);
    console.log(`Topic documents written: ${topicsWritten}${same ? ' (unchanged)' : ''}. Talks updated: ${ul.length / 2}.`);
    console.log('Top 20 topics:');
    for (const t of topics.slice(0, 20)) console.log(`  ${String(t.talk_count).padStart(3)}  ${t.label}  (${t.topic_id})`);
  } finally {
    try { await es('DELETE', `/${workIndex}`); } catch { /* never replace the original error */ }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
