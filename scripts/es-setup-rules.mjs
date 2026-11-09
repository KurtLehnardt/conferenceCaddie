// Creates the filter rules index (a percolator) and points its alias at it.
//
// Usage: node scripts/es-setup-rules.mjs [index] [--recreate] [--alias name]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.
//
// The index defaults to caddie-people-rules-v1 and its alias to caddie-people-rules. The name
// must stay caddie-people-rules*: the deployed server reads it with the people key, which covers
// caddie-people* and nothing else. Pass --alias "" to skip the alias step.
//
// Mapping (dynamic: false):
//   query  percolator     one Elasticsearch query per rule (match_phrase or regexp on text)
//   text   text           the field the queries run against, analysed with rule_text:
//                         a mapping char_filter for leet (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s),
//                         the standard tokenizer, lowercase and asciifolding
//   rule, kind, source    keyword; the config entry, "phrase" or "regexp", and where it came from
//   created_at            date
//
// Idempotent: an index that exists is kept (--recreate deletes it first) and the alias is moved
// when it points elsewhere. Rules are written by scripts/moderation-rules.mjs --reload-rules.

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
const recreate = flag('--recreate');
const aliasArg = opt('--alias');
const index = args[0] || 'caddie-people-rules-v1';
const alias = aliasArg !== undefined ? aliasArg : 'caddie-people-rules';

if (!index.startsWith('caddie-people-rules') || (alias && !alias.startsWith('caddie-people-rules'))) {
  console.error('Index and alias names must start with "caddie-people-rules" so the people key covers them.');
  process.exit(1);
}

async function es(method, path, body) {
  const res = await fetch(ES_URL + path, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const fail = (what, r) => {
  console.error(`${what} failed with status ${r.status}:`, JSON.stringify(r.json.error?.reason ?? r.json));
  process.exit(1);
};

const RULES_INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    analysis: {
      char_filter: {
        leet: { type: 'mapping', mappings: ['0 => o', '1 => i', '3 => e', '4 => a', '5 => s', '7 => t', '@ => a', '$ => s'] },
      },
      analyzer: {
        rule_text: { type: 'custom', char_filter: ['leet'], tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
      },
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      query: { type: 'percolator' },
      text: { type: 'text', analyzer: 'rule_text' },
      rule: { type: 'keyword' },
      kind: { type: 'keyword' },
      source: { type: 'keyword' },
      created_at: { type: 'date' },
    },
  },
};

async function pointAlias(name, target) {
  if (!name) return;
  const current = await es('GET', `/_alias/${name}`);
  const actions = [];
  if (current.status === 200) {
    for (const old of Object.keys(current.json)) if (old !== target) actions.push({ remove: { index: old, alias: name } });
  }
  actions.push({ add: { index: target, alias: name } });
  const res = await es('POST', '/_aliases', { actions });
  if (res.status !== 200) fail(`Pointing alias ${name}`, res);
  console.log(`Alias ${name} now points at ${target}.`);
}

const exists = await es('HEAD', `/${index}`);
if (exists.status === 200 && recreate) {
  const del = await es('DELETE', `/${index}`);
  if (del.status !== 200) fail(`Deleting ${index}`, del);
  console.log(`Deleted ${index}.`);
}
if (exists.status !== 200 || recreate) {
  const created = await es('PUT', `/${index}`, RULES_INDEX_BODY);
  if (created.status !== 200) fail(`Creating ${index}`, created);
  console.log(`Created ${index}.`);
} else {
  console.log(`Index ${index} already exists.`);
}
await pointAlias(alias, index);
console.log('Next: node scripts/moderation-rules.mjs --reload-rules');
