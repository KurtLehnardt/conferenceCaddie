// Creates the versioned people index with its mapping and points the alias at it.
//
// Usage: node scripts/es-setup-people.mjs [index] [--recreate] [--alias name] [--lexical-only]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.
//
// The index defaults to caddie-people-v1 and the alias to caddie-people. Pass --alias "" to skip
// the alias step, for example for a development index. --lexical-only leaves out the three
// semantic_text fields, so nothing is embedded; matching then fails on the semantic retrievers,
// so use it only for tests that never send free text.

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
const lexicalOnly = flag('--lexical-only');
const aliasArg = opt('--alias');
const index = args[0] || 'caddie-people-v1';
const alias = aliasArg !== undefined ? aliasArg : 'caddie-people';

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

const freeText = (semanticField) => (lexicalOnly ? { type: 'text' } : { type: 'text', copy_to: semanticField });
const hidden = { type: 'keyword', index: false };

const properties = {
  event_id: { type: 'keyword' },
  profile_id: { type: 'keyword' },
  display_name: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
  about: freeText('about_semantic'),
  interests: freeText('interests_semantic'),
  expertise: freeText('expertise_semantic'),
  learn_topics: { type: 'keyword' },
  speak_topics: { type: 'keyword' },
  shared_talk_ids: { type: 'keyword' },
  open_to_meet: { type: 'boolean' },
  sample: { type: 'boolean' },
  visible_until: { type: 'date' },
  updated_at: { type: 'date' },
  linkedin_url: hidden,
  contact_note: hidden,
  secret_hash: hidden,
  text_hash: hidden,
};
if (!lexicalOnly) {
  properties.about_semantic = { type: 'semantic_text' };
  properties.interests_semantic = { type: 'semantic_text' };
  properties.expertise_semantic = { type: 'semantic_text' };
}

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
  mappings: { dynamic: false, properties },
});
if (created.status !== 200) {
  console.error(`Creating ${index} failed with status ${created.status}:`, JSON.stringify(created.json.error?.reason ?? created.json));
  process.exit(1);
}
console.log(`Created ${index}${lexicalOnly ? ' (lexical only, no semantic fields)' : ''}.`);

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
