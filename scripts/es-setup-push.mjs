// Creates the two indices of the Web Push nudges: the subscriptions and the nudge records.
// Run it after scripts/es-setup-people.mjs.
//
// Usage: node scripts/es-setup-push.mjs [--push index] [--nudges index] [--no-alias]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.
//
// Defaults: caddie-people-push-v1 behind caddie-people-push, and caddie-people-nudges-v1 behind
// caddie-people-nudges. Both are caddie-people-*, so the people key covers them. Every step is
// idempotent: an index that exists is left alone, an alias is pointed at the index.
//
// The subscription's endpoint and keys are keyword fields with index: false, so they are stored
// and never searchable; a subscription is found by its _id (sha256 of the endpoint) or by
// profile_id. Both indices use dynamic: false.

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
const pushIndex = opt('--push') || 'caddie-people-push-v1';
const nudgesIndex = opt('--nudges') || 'caddie-people-nudges-v1';
const withAlias = !args.includes('--no-alias');

for (const name of [pushIndex, nudgesIndex]) {
  if (!name.startsWith('caddie-')) {
    console.error('Index names must start with "caddie-".');
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

const pushProperties = {
  event_id: { type: 'keyword' },
  profile_id: { type: 'keyword' },
  endpoint: { type: 'keyword', index: false },
  keys_p256dh: { type: 'keyword', index: false },
  keys_auth: { type: 'keyword', index: false },
  created_at: { type: 'date' },
  expires_at: { type: 'date' },
};

const nudgesProperties = {
  event_id: { type: 'keyword' },
  day: { type: 'keyword' },
  profile_ids: { type: 'keyword' },
  receivers: { type: 'keyword' },
  created_at: { type: 'date' },
  expires_at: { type: 'date' },
};

async function pointAlias(name, target) {
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

await ensureIndex(pushIndex, pushProperties);
if (withAlias) await pointAlias(pushIndex.replace(/-v\d+$/, ''), pushIndex);
await ensureIndex(nudgesIndex, nudgesProperties);
if (withAlias) await pointAlias(nudgesIndex.replace(/-v\d+$/, ''), nudgesIndex);
