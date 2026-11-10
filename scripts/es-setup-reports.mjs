// Creates the reports index of the Report item and adds the hidden flags to the people and meets
// mappings. Run it after scripts/es-setup-people.mjs.
//
// Usage: node scripts/es-setup-reports.mjs [index] [--alias name] [--people name] [--meets name]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY;
//        ES_PEOPLE_INDEX (default caddie-people) and ES_PEOPLE_MEETS_INDEX (default
//        caddie-people-meets) name the indices whose mappings are extended, unless --people or
//        --meets says otherwise.
//
// The reports index defaults to caddie-people-reports-v1 behind the alias caddie-people-reports.
// The alias moves only for the default index or caddie-people-reports-v<N>; any other name gets no
// alias unless --alias names one. Pass --alias "" to skip the alias step. Every step is idempotent:
// - The reports index is created when missing and left alone otherwise.
// - hidden (boolean) and spot_hidden (boolean) are PUT to the people mapping. That is additive and
//   never names a semantic_text field, so nothing is re-embedded. The people index must exist.
// - hidden (boolean) is PUT to the meets mapping when that index exists, and skipped otherwise.

import { chooseAlias } from './lib/alias.mjs';

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
const aliasArg = opt('--alias');
const peopleIndex = opt('--people') || process.env.ES_PEOPLE_INDEX || 'caddie-people';
const meetsIndex = opt('--meets') || process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
const index = args[0] || 'caddie-people-reports-v1';
const { alias, hint } = chooseAlias({ index, explicit: aliasArg, defaultIndex: 'caddie-people-reports-v1', defaultAlias: 'caddie-people-reports' });
if (hint) console.log(hint);

for (const name of [index, alias, peopleIndex, meetsIndex]) {
  if (name && !name.startsWith('caddie-')) {
    console.error('Index and alias names must start with "caddie-".');
    process.exit(1);
  }
}

async function es(method, path, body) {
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method,
      headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(`Could not reach Elasticsearch: ${err?.cause?.code ?? err?.name ?? 'error'}`);
    process.exit(1);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const fail = (what, r) => {
  console.error(`${what} failed with status ${r.status}:`, JSON.stringify(r.json.error?.reason ?? r.json));
  process.exit(1);
};

const reportsProperties = {
  event_id: { type: 'keyword' },
  target_kind: { type: 'keyword' },
  target_id: { type: 'keyword' },
  target_profile_id: { type: 'keyword' },
  reporter_id: { type: 'keyword' },
  reason: { type: 'keyword' },
  created_at: { type: 'date' },
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

// Creates an index with a dynamic: false mapping when it is missing.
async function ensureIndex(name, props) {
  const exists = await es('HEAD', `/${name}`);
  if (exists.status === 200) {
    console.log(`Index ${name} already exists.`);
    return;
  }
  const created = await es('PUT', `/${name}`, { settings: { number_of_shards: 1 }, mappings: { dynamic: false, properties: props } });
  if (created.status !== 200) fail(`Creating ${name}`, created);
  console.log(`Created ${name}.`);
}

// Adds boolean fields to an existing index or alias. Putting a field that already exists with the
// same type is a no-op for Elasticsearch.
async function addFields(name, props, { required }) {
  const exists = await es('HEAD', `/${name}`);
  if (exists.status !== 200) {
    if (required) {
      console.error(`Index ${name} does not exist; run npm run people:setup first.`);
      process.exit(1);
    }
    console.log(`Index ${name} does not exist; skipped ${Object.keys(props).join(', ')}.`);
    return;
  }
  const put = await es('PUT', `/${name}/_mapping`, { properties: props });
  if (put.status !== 200) fail(`Adding ${Object.keys(props).join(', ')} to ${name}`, put);
  console.log(`Index ${name}: added or confirmed ${Object.keys(props).join(', ')}.`);
}

await ensureIndex(index, reportsProperties);
await pointAlias(alias, index);
await addFields(peopleIndex, { hidden: { type: 'boolean' }, spot_hidden: { type: 'boolean' } }, { required: true });
await addFields(meetsIndex, { hidden: { type: 'boolean' } }, { required: false });
