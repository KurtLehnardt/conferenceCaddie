// Loads the filter rules into the percolator index and tests a line against them.
//
//   node scripts/moderation-rules.mjs --reload-rules [--index caddie-people-rules]
//   node scripts/moderation-rules.mjs --test "<text>" [--index caddie-people-rules]
//
// Env: ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.
//
// --reload-rules reads config/moderation-words.json and writes one rule document per entry,
// replacing every rule that is there (delete_by_query, then one bulk request):
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

const WORDS_FILE = new URL('../config/moderation-words.json', import.meta.url);
const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

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
  const res = await fetch(ES_URL + path, {
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

const ruleId = (kind, entry) => `${kind === 'regexp' ? 're' : 'w'}-${crypto.createHash('sha256').update(entry).digest('hex').slice(0, 10)}`;

function ruleDocs() {
  const parsed = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
  if (!Array.isArray(parsed.words)) throw new Error('config/moderation-words.json must have a words array');
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
    console.error('config/moderation-words.json holds no rules; nothing written and the old rules were kept.');
    process.exit(1);
  }
  const deleted = await es('POST', `/${encodeURIComponent(index)}/_delete_by_query?refresh=true&conflicts=proceed`, { query: { match_all: {} } });
  if (deleted.status !== 200) fail('Deleting the old rules', deleted);
  const lines = [];
  for (const { _id, ...doc } of docs) {
    lines.push(JSON.stringify({ index: { _id } }));
    lines.push(JSON.stringify(doc));
  }
  const bulk = await es('POST', `/${encodeURIComponent(index)}/_bulk?refresh=true`, `${lines.join('\n')}\n`, true);
  if (bulk.status !== 200) fail('Writing the rules', bulk);
  const failed = (bulk.json.items ?? []).filter((it) => it.index?.error);
  for (const it of failed.slice(0, 5)) console.error(`Rule ${it.index._id} rejected: ${it.index.error.type} (${it.index.error.reason ?? ''})`);
  if (failed.length) {
    console.error(`${failed.length} of ${docs.length} rules were refused by Elasticsearch; the rest are live.`);
    process.exit(2);
  }
  const phrases = docs.filter((d) => d.kind === 'phrase').length;
  console.log(`Replaced ${deleted.json.deleted ?? 0} rules with ${docs.length} (${phrases} phrases, ${docs.length - phrases} regexps) in ${index}.`);
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
