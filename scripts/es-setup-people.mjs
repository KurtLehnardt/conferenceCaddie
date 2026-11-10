// Creates the versioned people indices with their mappings and points the aliases at them.
//
// Usage: node scripts/es-setup-people.mjs [index] [--recreate] [--alias name] [--lexical-only]
//                                         [--inference-id id]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY,
//        ES_INFERENCE_ID (default inference endpoint for the semantic_text fields).
//
// The people index defaults to caddie-people-v2 and its alias to caddie-people. Pass --alias ""
// to skip the alias steps, for example for a development index. --lexical-only leaves out the
// three semantic_text fields, so nothing is embedded; matching then fails on the semantic
// retrievers, so use it only for tests that never send free text.
//
// The three semantic_text fields use the inference endpoint caddie-e5-small, the multilingual E5
// small model deployed on the cluster's own ML node (see DECISIONS.md). --inference-id <id> or
// ES_INFERENCE_ID picks another endpoint, and --inference-id "" leaves inference_id out so the
// fields use the cluster's default endpoint. The setting applies only when the index is created.
//
// Every step is idempotent, so the command can be re-run after a release that adds fields:
// - A people index that already exists is kept, and only the fields that Find & connect added
//   (ref, the presence fields and, from the GPS bands release, presence_location and
//   presence_accuracy; later the unindexed pending_* text fields) are PUT to its mapping. That is
//   additive and never touches the semantic_text fields, so nothing is re-embedded. --recreate
//   deletes and recreates it instead.
// - The blocks index (caddie-people-blocks-v1 behind caddie-people-blocks) and the meets index
//   (caddie-people-meets-v1 behind caddie-people-meets) are created when missing. With a custom
//   people index name the two take the same suffix after "caddie-people" (the default
//   caddie-people-v2 keeps them at v1); with --alias "" they get no alias.

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
const inferenceIdArg = opt('--inference-id');
const inferenceId = inferenceIdArg !== undefined ? inferenceIdArg : process.env.ES_INFERENCE_ID ?? 'caddie-e5-small';
const DEFAULT_INDEX = 'caddie-people-v2';
const index = args[0] || DEFAULT_INDEX;
const alias = aliasArg !== undefined ? aliasArg : 'caddie-people';

if (!index.startsWith('caddie-') || (alias && !alias.startsWith('caddie-'))) {
  console.error('Index and alias names must start with "caddie-".');
  process.exit(1);
}

// caddie-people-v3 gives caddie-people-blocks-v3; caddie-dev-x gives caddie-dev-x-blocks. The
// default people index is the exception: it moved to v2 when its semantic_text fields moved to
// caddie-e5-small, while the sibling indices have no semantic_text field and stayed at v1.
const siblingSuffix = index === DEFAULT_INDEX ? '-v1' : index.slice('caddie-people'.length);
const sibling = (kind) => (index.startsWith('caddie-people') ? `caddie-people-${kind}${siblingSuffix}` : `${index}-${kind}`);
const siblingAlias = (kind) => (alias ? `${alias}-${kind}` : '');

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

const freeText = (semanticField) => (lexicalOnly ? { type: 'text' } : { type: 'text', copy_to: semanticField });
const hidden = { type: 'keyword', index: false };

// Fields Find & connect added to the people document. They are PUT separately on an existing
// index, so they live in their own object.
const connectProperties = {
  ref: { type: 'keyword' },
  presence_zone: { type: 'keyword' },
  presence_spot: { type: 'text' },
  // True while the classifier holds the spot line: stored, shown only to its author.
  presence_spot_pending: { type: 'boolean' },
  presence_since: { type: 'date' },
  presence_until: { type: 'date' },
  // GPS bands: the rounded position (5 decimals) and its accuracy in metres, written only when
  // the person opted in and the fix was within 200 m. Used for ranking; never returned as such.
  presence_location: { type: 'geo_point' },
  presence_accuracy: { type: 'integer' },
  // The Android companion's Bluetooth token (server/ble.mjs): resolved by exact value, ten minutes.
  ble_token: { type: 'keyword' },
  ble_token_until: { type: 'date' },
  // The text of a profile save that could not be embedded (server/semantic.mjs paused): kept in the
  // source only, never indexed, never copied to a semantic field, until the owner's next write
  // embeds it and drops these.
  pending_about: { type: 'text', index: false },
  pending_interests: { type: 'text', index: false },
  pending_expertise: { type: 'text', index: false },
};

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
  ...connectProperties,
};
if (!lexicalOnly) {
  const semantic = () => (inferenceId ? { type: 'semantic_text', inference_id: inferenceId } : { type: 'semantic_text' });
  properties.about_semantic = semantic();
  properties.interests_semantic = semantic();
  properties.expertise_semantic = semantic();
}

const blocksProperties = {
  event_id: { type: 'keyword' },
  blocker_id: { type: 'keyword' },
  blocked_id: { type: 'keyword' },
  blocked_ref: { type: 'keyword' },
  created_at: { type: 'date' },
};

const meetsProperties = {
  event_id: { type: 'keyword' },
  meet_id: { type: 'keyword' },
  participants: { type: 'keyword' },
  requester_id: { type: 'keyword' },
  topic_id: { type: 'keyword' },
  note: hidden,
  rendezvous: hidden,
  spot_me: { type: 'object', enabled: false },
  // Classifier holds: a held note reaches only its author; spot_me_pending is { profile_id: true }.
  note_pending: { type: 'boolean' },
  spot_me_pending: { type: 'object', enabled: false },
  state: { type: 'keyword' },
  same_zone: { type: 'boolean' },
  created_at: { type: 'date' },
  active_since: { type: 'date' },
  expires_at: { type: 'date' },
  ended_at: { type: 'date' },
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

// Creates an index with a dynamic: false mapping when it is missing. Returns true when created.
async function ensureIndex(name, props, note = '') {
  const exists = await es('HEAD', `/${name}`);
  if (exists.status === 200) {
    console.log(`Index ${name} already exists.`);
    return false;
  }
  const created = await es('PUT', `/${name}`, { settings: { number_of_shards: 1 }, mappings: { dynamic: false, properties: props } });
  if (created.status !== 200) fail(`Creating ${name}`, created);
  console.log(`Created ${name}${note}.`);
  return true;
}

// The people index.
const exists = await es('HEAD', `/${index}`);
if (exists.status === 200 && recreate) {
  const del = await es('DELETE', `/${index}`);
  if (del.status !== 200) fail(`Deleting ${index}`, del);
  console.log(`Deleted ${index}.`);
}
if (exists.status !== 200 || recreate) {
  await ensureIndex(index, properties, lexicalOnly ? ' (lexical only, no semantic fields)' : '');
} else {
  // Additive only: the fields are new keyword, text, date, geo_point and integer fields. Putting
  // the same field again is a no-op for Elasticsearch, and the semantic_text fields are never sent.
  const put = await es('PUT', `/${index}/_mapping`, { properties: connectProperties });
  if (put.status !== 200) fail(`Adding the Find & connect fields to ${index}`, put);
  console.log(`Index ${index} already exists; added or confirmed ${Object.keys(connectProperties).join(', ')}.`);
}
await pointAlias(alias, index);

// The blocks and meets indices.
await ensureIndex(sibling('blocks'), blocksProperties);
await pointAlias(siblingAlias('blocks'), sibling('blocks'));
if (!(await ensureIndex(sibling('meets'), meetsProperties))) {
  // Additive: same_zone came after the index existed.
  const put = await es('PUT', `/${sibling('meets')}/_mapping`, { properties: { same_zone: meetsProperties.same_zone } });
  if (put.status !== 200) fail(`Adding same_zone to ${sibling('meets')}`, put);
}
await pointAlias(siblingAlias('meets'), sibling('meets'));
