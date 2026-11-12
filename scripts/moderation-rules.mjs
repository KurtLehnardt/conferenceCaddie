// Loads the filter rules into the percolator index and tests a line against them.
//
//   node scripts/moderation-rules.mjs --reload-rules [--index caddie-people-rules]
//   node scripts/moderation-rules.mjs --test "<text>" [--index caddie-people-rules]
//
// Env: ES_URL (required, no default). --reload-rules needs ELASTISEARCH_API_KEY
// (the admin key) and refuses to run without it; --test uses ES_PEOPLE_API_KEY or
// ELASTISEARCH_API_KEY. MODERATION_WORDS_FILE overrides the wordlist path (the tests use it).
//
// --reload-rules reads config/moderation-words.json and writes one rule document per entry,
// then removes every rule that is not in the new set. It writes first and deletes second, so the
// index is never empty: the new rules are bulk-indexed under their stable ids (re-running changes
// nothing that matters), the write is waited on, and only then are the ids that are not in the
// new set found by search and bulk-deleted. If the wordlist is empty or the write fails, nothing
// is deleted, the old rules stay live and the script exits non-zero. The index is never emptied
// by a reload, but one that holds no rules (a fresh rules:setup) stays empty if the first write
// fails; the script then prints a warning. Run one reload at a time: two overlapping runs with
// different wordlists would each delete the other's new rules.
//   "word" or "two words"  → { match_phrase: { text: "<entry>" } }; the phrase is analysed with
//                            the index's rule_text analyzer, so leet, case and diacritics in a
//                            line do not matter, and it matches only as whole words.
//   "re:<pattern>"         → { regexp: { text: "<pattern>" } }, an Elasticsearch regexp over
//                            single analysed tokens (so lowercase ASCII letters). Write it in
//                            lowercase; "re:fu+ck+" catches stretched spellings.
// Rule ids are stable: a hash of the entry, prefixed w- (phrase) or re- (regexp).
//
// --test percolates a line the way the server does: normalised first (NFKC, lowercase,
// diacritics stripped, leet substitutions, punctuation to spaces), then matched against every
// rule. It prints the ids and kinds of the rules that matched, never a key.

import fs from 'node:fs';
import crypto from 'node:crypto';

const WORDS_FILE = process.env.MODERATION_WORDS_FILE || new URL('../config/moderation-words.json', import.meta.url);
// What messages call the wordlist: the repository path, or the override's path when it is set.
const WORDS_LABEL = process.env.MODERATION_WORDS_FILE || 'config/moderation-words.json';
import { esUrlOrExit } from './lib/es-url.mjs';
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? '';
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const reload = flag('--reload-rules');
// Operator policy: a reload rewrites the moderation rules, so only the admin key may do it, and
// the script refuses the people key even though the write-then-delete steps would work with it.
// The narrower people key is good enough to test a line.
const API_KEY = reload ? process.env.ELASTISEARCH_API_KEY : process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
if (!API_KEY) {
  console.error(reload ? 'Set ELASTISEARCH_API_KEY (the admin key); --reload-rules does not run with ES_PEOPLE_API_KEY.' : 'Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}
const testText = opt('--test');
const index = opt('--index') || 'caddie-people-rules';
if (!index.startsWith('caddie-people-rules')) {
  console.error('The index must be caddie-people-rules* so the people key covers it.');
  process.exit(1);
}
if (reload === (testText !== undefined)) {
  console.error('Pass exactly one of --reload-rules or --test "<text>".');
  process.exit(1);
}

async function es(method, path, body, ndjson = false) {
  const res = await fetch(esUrlOrExit() + path, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const fail = (what, r) => {
  console.error(`${what} failed with status ${r.status}:`, JSON.stringify(r.json.error?.reason ?? r.json.error?.type ?? 'error'));
  process.exit(1);
};

// The same normalisation as server/moderation.mjs (kept in step by hand; the server module is
// not imported because loading it starts its probes).
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
function normalize(s) {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[01345 7@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const DELETE_BATCH = 500;
const DELETE_ROUNDS = 20;

const ruleId = (kind, entry) => `${kind === 'regexp' ? 're' : 'w'}-${crypto.createHash('sha256').update(entry).digest('hex').slice(0, 10)}`;

function ruleDocs() {
  const parsed = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
  if (!Array.isArray(parsed.words)) throw new Error(`${WORDS_LABEL} must have a words array`);
  const source = typeof parsed.source === 'string' ? parsed.source.slice(0, 200) : 'config/moderation-words.json';
  const now = new Date().toISOString();
  const seen = new Set();
  const docs = [];
  for (const raw of parsed.words) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    if (entry.startsWith('re:')) {
      const pattern = entry.slice(3).trim();
      if (!pattern) continue;
      docs.push({ _id: ruleId('regexp', entry), kind: 'regexp', rule: entry, source, created_at: now, query: { regexp: { text: { value: pattern, flags: 'ALL', case_insensitive: true } } } });
    } else {
      docs.push({ _id: ruleId('phrase', entry), kind: 'phrase', rule: entry, source, created_at: now, query: { match_phrase: { text: entry } } });
    }
  }
  return docs;
}

async function reloadRules() {
  const exists = await es('HEAD', `/${encodeURIComponent(index)}`);
  if (exists.status !== 200) {
    console.error(`Index ${index} does not exist. Run: node scripts/es-setup-rules.mjs`);
    process.exit(1);
  }
  const docs = ruleDocs();
  if (!docs.length) {
    console.error(`${WORDS_LABEL} holds no rules; nothing was written and the old rules were kept.`);
    process.exit(1);
  }
  const keep = docs.map((d) => d._id);
  if (new Set(keep).size !== keep.length) {
    console.error(`Two entries of ${WORDS_LABEL} hash to the same rule id; nothing was written. Change one of them.`);
    process.exit(2);
  }
  const index_ = encodeURIComponent(index);
  // How many rules the index holds now, only so a failure can say whether it is empty.
  const before = await es('GET', `/${index_}/_count`);
  const held = before.status === 200 ? before.json.count : undefined;
  const writeFailed = (why) => {
    console.error(held === 0
      ? `WARNING: ${index} held no rules before this run and holds none now, so rule moderation is off and the server's wordlist alone decides. Fix the cause and run the reload again.`
      : 'The old rules were kept.');
    console.error(why);
    process.exit(2);
  };
  const lines = [];
  for (const { _id, ...doc } of docs) {
    lines.push(JSON.stringify({ index: { _id } }));
    lines.push(JSON.stringify(doc));
  }
  const bulk = await es('POST', `/${index_}/_bulk?refresh=wait_for`, `${lines.join('\n')}\n`, true);
  if (bulk.status !== 200) writeFailed(`Writing the rules failed with status ${bulk.status}: ${JSON.stringify(bulk.json.error?.reason ?? bulk.json.error?.type ?? 'error')}`);
  // Every rule must be confirmed written before anything is deleted: a missing or short items
  // list proves nothing about what was stored.
  const items = bulk.json.items;
  if (!Array.isArray(items) || items.length !== docs.length) writeFailed(`Elasticsearch answered ${Array.isArray(items) ? items.length : 'no'} results for ${docs.length} rules; nothing was deleted.`);
  const failed = items.filter((it) => ![200, 201].includes(it?.index?.status));
  for (const it of failed.slice(0, 5)) console.error(`Rule ${it?.index?._id ?? '?'} rejected: ${it?.index?.error?.type ?? `status ${it?.index?.status}`} (${it?.index?.error?.reason ?? ''})`);
  if (failed.length) writeFailed(`${failed.length} of ${docs.length} rules were refused by Elasticsearch; nothing was deleted, so any old rules are still live beside the ones that were written.`);
  // Remove the rules that are not in the new set, in batches, the way the server's deleteWhere does.
  let deleted = 0;
  for (let round = 0; ; round++) {
    const found = await es('POST', `/${index_}/_search`, { size: DELETE_BATCH, _source: false, query: { bool: { must_not: [{ ids: { values: keep } }] } } });
    if (found.status !== 200) {
      console.error('The new rules are live.');
      fail('Finding the old rules', found);
    }
    const ids = (found.json.hits?.hits ?? []).map((h) => h._id);
    if (!ids.length) break;
    if (round >= DELETE_ROUNDS) {
      console.error('Too many old rules to remove in one run; the new rules are live. Run the reload again.');
      process.exit(2);
    }
    const body = ids.map((id) => `${JSON.stringify({ delete: { _id: id } })}\n`).join('');
    const removed = await es('POST', `/${index_}/_bulk?refresh=wait_for`, body, true);
    if (removed.status !== 200) {
      console.error('The new rules are live.');
      fail('Deleting the old rules', removed);
    }
    const statusOf = (it) => it?.delete?.status ?? 500;
    const results = Array.isArray(removed.json.items) ? removed.json.items : [];
    const bad = results.length === ids.length ? results.filter((it) => statusOf(it) !== 404 && (statusOf(it) < 200 || statusOf(it) > 299)) : ids;
    if (bad.length) {
      console.error(`${bad.length} old rules could not be deleted (status ${results.length === ids.length ? statusOf(bad[0]) : 500}); the new rules are live.`);
      process.exit(2);
    }
    deleted += results.filter((it) => statusOf(it) >= 200 && statusOf(it) <= 299).length;
    if (ids.length < DELETE_BATCH) break;
  }
  const phrases = docs.filter((d) => d.kind === 'phrase').length;
  console.log(`Wrote ${docs.length} rules (${phrases} phrases, ${docs.length - phrases} regexps) from ${WORDS_LABEL} to ${index} and removed ${deleted} others.`);
}

async function testLine(text) {
  const normalized = normalize(text);
  const res = await es('POST', `/${encodeURIComponent(index)}/_search`, {
    size: 100,
    _source: ['kind'],
    query: { percolate: { field: 'query', document: { text: normalized } } },
  });
  if (res.status !== 200) fail('Percolating', res);
  const hits = res.json.hits?.hits ?? [];
  if (!hits.length) {
    console.log('No rule matched.');
    return;
  }
  console.log(`${hits.length} rule${hits.length === 1 ? '' : 's'} matched:`);
  for (const h of hits) console.log(`  ${h._id} (${h._source?.kind ?? 'rule'})`);
  process.exitCode = 3;
}

if (reload) await reloadRules();
else await testLine(testText);
