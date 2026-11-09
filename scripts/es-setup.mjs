// Creates the versioned talks index or the conferences index, and manages their aliases.
//
// Usage:
//   node scripts/es-setup.mjs [index] [--recreate] [--alias name] [--inference-id id] [--lexical-only]
//       Creates the talks index (default caddie-talks-v2) and points alias caddie-talks at it.
//   node scripts/es-setup.mjs --conferences [index] [--recreate] [--alias name]
//       Creates the conferences index (default caddie-conferences-v1) and points alias
//       caddie-conferences at it.
//   node scripts/es-setup.mjs --switch-alias <alias> <index>
//       Points the alias at the index in one atomic _aliases call, removing every index it
//       pointed at before, and prints the before and after.
//
// Env: ES_URL (default: the Elastic Cloud deployment), ES_API_KEY or ELASTISEARCH_API_KEY,
//      ES_SETUP_INDEX (default talks index), ES_ALIAS (default alias for the talks index).
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
// A flag that may be followed by one value; the value is taken only when it is not another flag.
const flagWithOptionalValue = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v !== undefined && !v.startsWith('--')) {
    args.splice(i, 2);
    return v;
  }
  args.splice(i, 1);
  return '';
};

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

const fail = (message, res) => {
  console.error(message, res ? JSON.stringify(res.json.error?.reason ?? res.json) : '');
  process.exit(1);
};

const checkName = (name, what) => {
  if (!/^caddie-[a-z0-9._-]+$/.test(name)) fail(`The ${what} name must start with "caddie-" and use lowercase letters, digits, ".", "_" or "-".`);
};

async function aliasTargets(alias) {
  const res = await es('GET', `/_alias/${encodeURIComponent(alias)}`);
  if (res.status === 404) return [];
  if (res.status !== 200) fail(`Reading alias ${alias} failed with status ${res.status}:`, res);
  return Object.keys(res.json).sort();
}

// One atomic _aliases call: remove the alias from every other index, then add it to this one.
async function pointAlias(alias, index) {
  const before = await aliasTargets(alias);
  const actions = before.filter((old) => old !== index).map((old) => ({ remove: { index: old, alias } }));
  actions.push({ add: { index, alias } });
  const res = await es('POST', '/_aliases', { actions });
  if (res.status !== 200) fail(`Pointing alias ${alias} at ${index} failed with status ${res.status}:`, res);
  const after = await aliasTargets(alias);
  console.log(`Alias ${alias}: before [${before.join(', ')}], after [${after.join(', ')}].`);
}

async function createIndex(index, mappings, recreate) {
  const exists = await es('HEAD', `/${index}`);
  if (exists.status === 200) {
    if (!recreate) fail(`Index ${index} already exists. Pass --recreate to delete and recreate it.`);
    const del = await es('DELETE', `/${index}`);
    if (del.status !== 200) fail(`Deleting ${index} failed with status ${del.status}:`, del);
    console.log(`Deleted ${index}.`);
  }
  const created = await es('PUT', `/${index}`, { settings: { number_of_shards: 1 }, mappings });
  if (created.status !== 200) fail(`Creating ${index} failed with status ${created.status}:`, created);
  console.log(`Created ${index}.`);
}

// ---------------------------------------------------------------------------------------------
// --switch-alias <alias> <index>

const switchAt = args.indexOf('--switch-alias');
if (switchAt !== -1) {
  const [alias, index] = [args[switchAt + 1], args[switchAt + 2]];
  if (!alias || !index || alias.startsWith('--') || index.startsWith('--')) fail('Usage: --switch-alias <alias> <index>');
  checkName(alias, 'alias');
  checkName(index, 'index');
  const exists = await es('HEAD', `/${index}`);
  if (exists.status !== 200) fail(`Index ${index} does not exist.`);
  await pointAlias(alias, index);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// --conferences [index]

const recreate = flag('--recreate');
const conferences = flagWithOptionalValue('--conferences');

if (conferences !== undefined) {
  const aliasArg = opt('--alias');
  const index = conferences || 'caddie-conferences-v1';
  const alias = aliasArg !== undefined ? aliasArg : 'caddie-conferences';
  checkName(index, 'index');
  if (alias) checkName(alias, 'alias');
  // The mapping of CONTRACT2 section C. Fields outside it stay in _source but are not indexed.
  await createIndex(index, {
    dynamic: false,
    properties: {
      slug: { type: 'keyword' },
      name: { type: 'keyword' },
      status: { type: 'keyword' },
      status_reason: { type: 'keyword' },
      source: { type: 'keyword' },
      start_date: { type: 'date', format: 'strict_date' },
      end_date: { type: 'date', format: 'strict_date' },
      time_zone: { type: 'keyword' },
      time_zone_windows: { type: 'keyword', index: false },
      location: { type: 'object', enabled: false },
      sessionize_api_code: { type: 'keyword', index: false },
      sessionize_public_slug: { type: 'keyword', index: false },
      sessionize_site_published: { type: 'boolean', index: false },
      lf_event_id: { type: 'long', index: false },
      lf_url: { type: 'keyword', index: false },
      official_schedule_url: { type: 'keyword', index: false },
      parent_slug: { type: 'keyword' },
      category_mapping: { type: 'object', enabled: false },
      counts: { type: 'object', enabled: false },
      ingested_at: { type: 'date' },
      raw_fetched_at: { type: 'date' },
    },
  }, recreate);
  if (alias) await pointAlias(alias, index);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Talks index.

const lexicalOnly = flag('--lexical-only');
const inferenceId = opt('--inference-id');
const aliasArg = opt('--alias');
const index = args[0] || process.env.ES_SETUP_INDEX || 'caddie-talks-v2';
const alias = aliasArg !== undefined ? aliasArg : process.env.ES_ALIAS ?? 'caddie-talks';
checkName(index, 'index');
if (alias) checkName(alias, 'alias');

const semantic = { type: 'semantic_text' };
if (inferenceId) semantic.inference_id = inferenceId;
const textField = lexicalOnly ? { type: 'text', analyzer: 'english' } : { type: 'text', analyzer: 'english', copy_to: 'semantic' };

// The mapping of CONTRACT2 section D plus the CONTRACT3 section 2 additions (topics and
// speaker_profiles). Fields outside it stay in _source but are not indexed, so an extra field in
// the data never blocks ingestion.
const properties = {
  talk_id: { type: 'keyword' },
  conference: { type: 'keyword' },
  session_id: { type: 'keyword', index: false },
  kind: { type: 'keyword' },
  title: textField,
  abstract: textField,
  speakers: { type: 'text' },
  speaker_taglines: { type: 'text', analyzer: 'english' },
  speaker_profiles: { type: 'object', enabled: false },
  room: { type: 'keyword' },
  track: { type: 'keyword' },
  level: { type: 'keyword' },
  tag_keys: { type: 'keyword' },
  tags: { type: 'object', enabled: false },
  topics: { type: 'keyword' },
  sponsor: { type: 'boolean' },
  has_slides: { type: 'boolean' },
  slides_url: { type: 'keyword', index: false },
  url: { type: 'keyword', index: false },
  start: { type: 'date' },
  end: { type: 'date' },
  day: { type: 'keyword' },
  start_minutes: { type: 'integer' },
  end_minutes: { type: 'integer' },
  content_hash: { type: 'keyword', index: false },
  text_hash: { type: 'keyword', index: false },
  ingested_at: { type: 'date', index: false },
};
if (!lexicalOnly) properties.semantic = semantic;

await createIndex(index, { dynamic: false, properties }, recreate);

const mapping = await es('GET', `/${index}/_mapping`);
const sem = mapping.json[index]?.mappings?.properties?.semantic;
if (sem) {
  console.log(`semantic_text inference_id: ${sem.inference_id ?? '(cluster default, not echoed)'}`);
} else {
  console.log('Lexical-only mapping: no semantic field.');
}

if (alias) await pointAlias(alias, index);
