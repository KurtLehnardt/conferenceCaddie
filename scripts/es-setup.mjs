// Creates the versioned talks index with its mapping and points the alias at it.
//
// Usage: node scripts/es-setup.mjs [index] [--recreate] [--alias name] [--inference-id id] [--lexical-only]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_API_KEY or ELASTISEARCH_API_KEY,
//        ES_SETUP_INDEX (default caddie-talks-v1), ES_ALIAS (default caddie-talks).
//
// Without --inference-id the semantic_text field uses the cluster's default endpoint. The script
// reads the mapping back afterwards and prints which inference endpoint the field resolved to.
// Pass --alias "" to skip the alias step, for example for a development index.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_API_KEY || process.env.ELASTISEARCH_API_KEY;
if (!API_KEY) {
  console.error('Set ES_API_KEY or ELASTISEARCH_API_KEY.');
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
const lexicalOnly = flag('--lexical-only');
const inferenceId = opt('--inference-id');
const aliasArg = opt('--alias');
const index = args[0] || process.env.ES_SETUP_INDEX || 'caddie-talks-v1';
const alias = aliasArg !== undefined ? aliasArg : process.env.ES_ALIAS ?? 'caddie-talks';

if (!index.startsWith('caddie-') || (alias && !alias.startsWith('caddie-'))) {
  console.error('Index and alias names must start with "caddie-".');
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

const semantic = { type: 'semantic_text' };
if (inferenceId) semantic.inference_id = inferenceId;

const properties = {
  talk_id: { type: 'keyword' },
  kind: { type: 'keyword' },
  title: lexicalOnly ? { type: 'text', analyzer: 'english' } : { type: 'text', analyzer: 'english', copy_to: 'semantic' },
  abstract: lexicalOnly ? { type: 'text', analyzer: 'english' } : { type: 'text', analyzer: 'english', copy_to: 'semantic' },
  speakers: { type: 'text' },
  speaker_taglines: { type: 'text', analyzer: 'english' },
  room: { type: 'keyword' },
  track: { type: 'keyword' },
  level: { type: 'keyword' },
  flags: { type: 'keyword' },
  sponsor: { type: 'boolean' },
  has_slides: { type: 'boolean' },
  slides_url: { type: 'keyword', index: false },
  url: { type: 'keyword', index: false },
  start: { type: 'date' },
  end: { type: 'date' },
  day: { type: 'keyword' },
  start_minutes: { type: 'integer' },
  end_minutes: { type: 'integer' },
};
if (!lexicalOnly) properties.semantic = semantic;

const exists = await es('HEAD', `/${index}`);
if (exists.status === 200) {
  if (!recreate) {
    console.error(`Index ${index} already exists. Pass --recreate to delete and recreate it.`);
    process.exit(1);
  }
  const del = await es('DELETE', `/${index}`);
  if (del.status !== 200) {
    console.error(`Deleting ${index} failed with status ${del.status}:`, JSON.stringify(del.json.error?.reason ?? del.json));
    process.exit(1);
  }
  console.log(`Deleted ${index}.`);
}

const created = await es('PUT', `/${index}`, {
  settings: { number_of_shards: 1 },
  // Fields outside the contract are kept in _source but not indexed, so an extra field in the
  // data file never blocks ingestion.
  mappings: { dynamic: false, properties },
});
if (created.status !== 200) {
  console.error(`Creating ${index} failed with status ${created.status}:`, JSON.stringify(created.json.error?.reason ?? created.json));
  process.exit(1);
}
console.log(`Created ${index}.`);

const mapping = await es('GET', `/${index}/_mapping`);
const sem = mapping.json[index]?.mappings?.properties?.semantic;
if (sem) {
  console.log(`semantic_text inference_id: ${sem.inference_id ?? '(cluster default, not echoed)'}`);
} else {
  console.log('Lexical-only mapping: no semantic field.');
}

if (alias) {
  const current = await es('GET', `/_alias/${alias}`);
  const actions = [];
  if (current.status === 200) {
    for (const old of Object.keys(current.json)) if (old !== index) actions.push({ remove: { index: old, alias } });
  }
  actions.push({ add: { index, alias } });
  const res = await es('POST', '/_aliases', { actions });
  if (res.status !== 200) {
    console.error(`Pointing alias ${alias} failed with status ${res.status}:`, JSON.stringify(res.json.error?.reason ?? res.json));
    process.exit(1);
  }
  console.log(`Alias ${alias} now points at ${index}.`);
}
