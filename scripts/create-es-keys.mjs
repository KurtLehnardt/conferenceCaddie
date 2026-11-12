// Mints the two scoped Elasticsearch API keys the deployed service uses and stores them in
// Google Secret Manager. It never prints or logs a key value or a password; the operator key (--operator) is written only to a new file of mode 0600.
//
//   GC_PROJECT=... ELASTISEARCH_API_KEY=... node scripts/create-es-keys.mjs [--verify-only] [--only <secret>]
//   ELASTISEARCH_API_KEY=... node scripts/create-es-keys.mjs --operator [--out <file>] [--expiration <90d>]
//
// --operator mints the third key, the one the caddie-admin command line uses, and writes it to a
// file (default <config dir>/es-admin-key, mode 0600; --out changes the path) instead of Secret
// Manager. It is limited to the caddie-* indices (read, write, view_index_metadata, monitor,
// maintenance), plus create_index and delete_index on caddie-topicwork-* (scripts/topics.mjs builds
// and removes a work index on every run), and the two cluster actions cluster:monitor/health and
// cluster:monitor/state. It holds no security, inference or other index-management privilege (not
// the named cluster privilege monitor, which would include inference), so a leak of it cannot
// create users, keys or other indices. Create the caddie-* indices, aliases and the first topics and
// facets with the short-lived setup key first (npm run es:setup and the first ingest and
// build-facets); the operator key only maintains what exists. It expires after 90 days unless
// --expiration says otherwise (an Elasticsearch duration up to 365d, such as 30d). Every check
// that fails invalidates the new key with the setup key and removes the file, and the key's id (not
// a secret) is printed so you can find it. This mode needs no GC_PROJECT and no gcloud. It refuses
// to overwrite an existing file.
//
// --only caddie-es-readonly (or caddie-es-people) re-mints just that key; the other is only
// verified.
//
// An API key cannot mint a derived key that carries privileges, so each key is minted by a
// native user that holds exactly the key's privileges:
//   caddie-readonly-svc: read and view_index_metadata on caddie-talks*, caddie-conferences*,
//                        caddie-topics* and caddie-facets*, plus the one cluster action
//                        cluster:admin/ingest/pipeline/simulate, which "Import my schedule" needs
//                        to run the attachment processor (Apache Tika) in a simulated pipeline
//                        that indexes nothing. Stored in the secret caddie-es-readonly.
//   caddie-people-svc:   read, write and view_index_metadata on caddie-people*.
//                        Stored in the secret caddie-es-people.
// Each user gets a random in-memory password, mints its key, and then has its password reset
// to another random value that is discarded, so nobody can sign in as it afterwards.
// Key values reach gcloud only through the child process's stdin.
//
// The script then checks, in process, that the read key can search talks and extract text but
// cannot write, read pipelines or call inference, and that the people key can write people but
// cannot read or write talks or run a simulated pipeline. It prints only PASS or FAIL for each
// check.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { esUrlOrExit } from './lib/es-url.mjs';
const OPERATOR_MODE = process.argv.includes('--operator');
const PROJECT = process.env.GC_PROJECT;
if (!PROJECT && !OPERATOR_MODE) {
  console.error('Set GC_PROJECT to your Google Cloud project id.');
  process.exit(1);
}
const ADMIN = process.env.ELASTISEARCH_API_KEY;
if (!ADMIN) {
  console.error('ELASTISEARCH_API_KEY is not set.');
  process.exit(1);
}

// Neither key holds an inference privilege. Indexing into semantic_text fields and knn queries
// with a query_vector_builder work without one, because Elasticsearch runs that inference itself.
// monitor_inference would also allow calling the cluster's chat, completion and rerank endpoints
// directly, and it cannot be limited to one endpoint, so it is left out. The verify step checks
// that both keys are refused on the inference API.
//
// The read key's simulate action is narrower than the named privilege read_pipeline, which would
// also let it read every stored pipeline definition. A simulated pipeline can hold any processor,
// including an inline inference processor, which Elasticsearch runs without checking inference
// privileges (verified on 9.5.6 with the embedding model only). The server only ever sends its
// own fixed attachment pipeline and never takes processors from a request.
const KEYS = [
  {
    user: 'caddie-readonly-svc',
    role: 'caddie_readonly',
    secret: 'caddie-es-readonly',
    cluster: ['cluster:admin/ingest/pipeline/simulate'],
    indices: [{ names: ['caddie-talks*', 'caddie-conferences*', 'caddie-topics*', 'caddie-facets*'], privileges: ['read', 'view_index_metadata'] }],
  },
  {
    user: 'caddie-people-svc',
    role: 'caddie_people',
    secret: 'caddie-es-people',
    cluster: [],
    indices: [{ names: ['caddie-people*'], privileges: ['read', 'write', 'view_index_metadata'] }],
  },
];

// The operator key (caddie-admin). Everything the CLI does fits in these: document reads and writes,
// delete-by-query with refresh (delete, maintenance), index metadata and _cat/_cluster reads
// (view_index_metadata, monitor). Creating indices, roles, users and keys is the setup key's job.
const OPERATOR = {
  user: 'caddie-operator-svc',
  role: 'caddie_operator',
  name: 'caddie-operator',
  // Cluster actions rather than the named privilege monitor, which also covers inference.
  cluster: ['cluster:monitor/health', 'cluster:monitor/state'],
  indices: [
    { names: ['caddie-*'], privileges: ['read', 'write', 'view_index_metadata', 'monitor', 'maintenance'] },
    { names: ['caddie-topicwork-*'], privileges: ['create_index', 'delete_index'] },
  ],
};

async function es(method, path, body, auth = `ApiKey ${ADMIN}`) {
  const res = await fetch(esUrlOrExit() + path, {
    method,
    redirect: 'error', // a redirect would carry the Authorization header to another host
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

function must(r, what) {
  if (r.status >= 300) {
    // Error bodies from these endpoints never echo credentials, but print only the type.
    throw new Error(`${what} failed with status ${r.status} (${r.json?.error?.type ?? 'unknown error'})`);
  }
  return r.json;
}

const randomPassword = () => randomBytes(32).toString('base64url');

function gcloud(args, input) {
  return spawnSync('gcloud', [...args, '--project', PROJECT], { input, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
}

function storeSecret(name, value) {
  const exists = gcloud(['secrets', 'describe', name]).status === 0;
  const r = exists
    ? gcloud(['secrets', 'versions', 'add', name, '--data-file=-'], value)
    : gcloud(['secrets', 'create', name, '--replication-policy=automatic', '--data-file=-'], value);
  if (r.status !== 0) throw new Error(`Storing secret ${name} failed: ${(r.stderr || '').split('\n')[0]}`);
  console.log(`Stored a new version of ${name}.`);
}

function readSecret(name) {
  const r = spawnSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', name, '--project', PROJECT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`Reading secret ${name} failed`);
  return r.stdout.trim();
}

async function mint(k) {
  must(await es('PUT', `/_security/role/${k.role}`, { cluster: [...k.cluster, 'manage_own_api_key'], indices: k.indices }), `Role ${k.role}`);
  const password = randomPassword();
  must(
    await es('PUT', `/_security/user/${k.user}`, {
      password,
      roles: [k.role],
      full_name: 'Conference Caddie service user',
      metadata: { purpose: 'mints the scoped key stored in ' + k.secret },
    }),
    `User ${k.user}`,
  );
  const basic = 'Basic ' + Buffer.from(`${k.user}:${password}`).toString('base64');
  // The role descriptor leaves out manage_own_api_key, so the key itself cannot mint keys.
  const key = must(
    await es(
      'POST',
      '/_security/api_key',
      { name: `${k.secret}-${new Date().toISOString().slice(0, 10)}`, role_descriptors: { [k.role]: { cluster: k.cluster, indices: k.indices } } },
      basic,
    ),
    `API key for ${k.user}`,
  );
  must(await es('POST', `/_security/user/${k.user}/_password`, { password: randomPassword() }), `Password reset for ${k.user}`);
  console.log(`Minted the key for ${k.user} and reset its password to a discarded value.`);
  storeSecret(k.secret, key.encoded);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

function operatorFile() {
  const out = argValue('--out');
  if (out) return out;
  if (process.env.ES_ADMIN_KEY_FILE) return process.env.ES_ADMIN_KEY_FILE;
  const base = process.env.CADDIE_ADMIN_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'conference-caddie');
  return join(base, 'es-admin-key');
}

// Writes the key to a new file readable by its owner only. The key is never printed.
function writeKeyFile(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, value);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
}

const EXPIRATION_RE = /^([1-9][0-9]{0,5})([dhm])$/;
const EXPIRATION_MAX_MINUTES = 365 * 24 * 60;
function checkExpiration(value) {
  const m = EXPIRATION_RE.exec(value);
  const minutes = m ? Number(m[1]) * { d: 1440, h: 60, m: 1 }[m[2]] : Infinity;
  if (minutes > EXPIRATION_MAX_MINUTES) throw new Error('--expiration takes a duration such as 30d, 12h or 90d, at most 365d');
}

async function mintOperator() {
  const file = operatorFile();
  if (existsSync(file)) throw new Error(`${file} exists; move it away first (this script never overwrites a key file)`);
  const expiration = argValue('--expiration') ?? '90d';
  checkExpiration(expiration);
  const k = OPERATOR;
  must(await es('PUT', `/_security/role/${k.role}`, { cluster: [...k.cluster, 'manage_own_api_key'], indices: k.indices }), `Role ${k.role}`);
  const password = randomPassword();
  must(await es('PUT', `/_security/user/${k.user}`, { password, roles: [k.role], full_name: 'Conference Caddie operator service user', metadata: { purpose: 'mints the operator key of caddie-admin' } }), `User ${k.user}`);
  const basic = 'Basic ' + Buffer.from(`${k.user}:${password}`).toString('base64');
  const key = must(
    await es('POST', '/_security/api_key', { name: `${k.name}-${new Date().toISOString().slice(0, 10)}`, expiration, role_descriptors: { [k.role]: { cluster: k.cluster, indices: k.indices } } }, basic),
    `API key for ${k.user}`,
  );
  must(await es('POST', `/_security/user/${k.user}/_password`, { password: randomPassword() }), `Password reset for ${k.user}`);
  console.log(`Minted the operator key ${key.id} (expires in ${expiration}).`);

  // From here on, any failure invalidates the new key (with the setup key) and removes the file.
  let wrote = false;
  const undo = async (why) => {
    if (wrote) {
      try { unlinkSync(file); } catch {}
    }
    const r = await es('DELETE', '/_security/api_key', { ids: [key.id] });
    console.error(`${why}; ${r.status < 300 ? `invalidated the new key ${key.id}` : `could NOT invalidate the new key ${key.id} (status ${r.status}); do it in Kibana`}${wrote ? ' and removed the file' : ''}.`);
  };
  try {
    writeKeyFile(file, key.encoded);
    wrote = true;
    console.log(`Wrote it to ${file} with mode 0600.`);
  } catch (err) {
    await undo(`Writing ${file} failed (${err.code ?? 'error'})`);
    return false;
  }

  const O = `ApiKey ${key.encoded}`;
  const checks = [];
  const check = (ok, label) => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  };
  const health = await es('GET', '/_cluster/health', undefined, O);
  check(health.status === 200, 'operator key: cluster health');
  const cat = await es('GET', '/_cat/indices/caddie-*?format=json&h=index,docs.count', undefined, O);
  const rows = Array.isArray(cat.json) ? cat.json : [];
  check(cat.status === 200 && rows.length > 0 && rows.every((r) => r['docs.count'] !== undefined && r['docs.count'] !== null && r['docs.count'] !== ''), 'operator key: list the caddie-* indices with their document counts (stats usage)');
  const work = `caddie-topicwork-keycheck-${randomBytes(4).toString('hex')}`;
  const made = await es('PUT', `/${work}`, { settings: { number_of_shards: 1 } }, O);
  const gone = made.status === 200 ? await es('DELETE', `/${work}`, undefined, O) : { status: 0 };
  check(made.status === 200 && gone.status === 200, 'operator key: create and delete a caddie-topicwork-* index (the topics script)');
  const outside = await es('POST', '/keycheck-outside-never/_search', { size: 0 }, O);
  check(outside.status === 403, 'operator key: cannot read an index outside caddie-*');
  const roles = await es('GET', '/_security/role', undefined, O);
  check(roles.status === 403, 'operator key: cannot read security settings');
  const inference = await es('GET', '/_inference/_all', undefined, O);
  check(inference.status === 403, 'operator key: cannot list inference endpoints');
  const priv = await es(
    'POST',
    '/_security/user/_has_privileges',
    {
      cluster: ['monitor', 'manage', 'manage_security', 'manage_api_key', 'manage_inference', 'monitor_inference'],
      index: [
        { names: ['caddie-people'], privileges: ['read', 'write', 'view_index_metadata', 'monitor', 'maintenance', 'manage', 'create_index', 'delete_index'] },
        { names: ['caddie-talks'], privileges: ['create_index', 'delete_index', 'manage'] },
        { names: [work], privileges: ['create_index', 'delete_index'] },
      ],
    },
    O,
  );
  const cl = priv.json?.cluster ?? {};
  const ix = priv.json?.index ?? {};
  check(priv.status === 200 && ['monitor', 'manage', 'manage_security', 'manage_api_key', 'manage_inference', 'monitor_inference'].every((p) => cl[p] === false), 'operator key: no cluster monitor (it includes inference), no security, inference or manage privileges');
  check(['read', 'write', 'view_index_metadata', 'monitor', 'maintenance'].every((p) => ix['caddie-people']?.[p] === true) && ['manage', 'create_index', 'delete_index'].every((p) => ix['caddie-people']?.[p] === false), 'operator key: read, write, metadata, monitor and maintenance on caddie-*, but not manage, create_index or delete_index');
  check(['create_index', 'delete_index', 'manage'].every((p) => ix['caddie-talks']?.[p] === false) && ix[work]?.create_index === true && ix[work]?.delete_index === true, 'operator key: create_index and delete_index only on caddie-topicwork-*, refused on caddie-talks');
  if (!checks.every(Boolean)) {
    await undo('A check failed');
    return false;
  }
  return true;
}

async function verify(readKey, peopleKey) {
  const R = `ApiKey ${readKey}`;
  const P = `ApiKey ${peopleKey}`;
  const nothing = { query: { ids: { values: ['caddie-keycheck-no-such-id'] } } };
  const checks = [];
  const check = (ok, label) => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  };

  const search = await es(
    'POST',
    '/caddie-talks/_search',
    { size: 1, query: { semantic: { field: 'semantic', query: 'making my cluster use less energy' } }, _source: ['title'] },
    R,
  );
  check(search.status === 200 && (search.json?.hits?.hits?.length ?? 0) > 0, 'read key: semantic search on caddie-talks');
  const topics = await es('POST', '/caddie-topics/_search', { size: 1 }, R);
  check(topics.status === 200, 'read key: search caddie-topics');
  const confs = await es('POST', '/caddie-conferences/_search', { size: 1 }, R);
  check(confs.status === 200, 'read key: search caddie-conferences');
  // These requests match no document, so even an over-privileged key could not change data.
  const facets = await es('POST', '/caddie-facets/_search', { size: 1 }, R);
  check(facets.status === 200, 'read key: search caddie-facets');
  const readWriteFacets = await es('POST', '/caddie-facets/_delete_by_query', nothing, R);
  check(readWriteFacets.status === 403, 'read key: cannot write caddie-facets');
  const readWriteTalks = await es('POST', '/caddie-talks/_delete_by_query', nothing, R);
  check(readWriteTalks.status === 403, 'read key: cannot write caddie-talks');
  const readWritePeople = await es('POST', '/caddie-people/_delete_by_query', nothing, R);
  check(readWritePeople.status === 403, 'read key: cannot write caddie-people');
  const readReadPeople = await es('POST', '/caddie-people/_search', { size: 0 }, R);
  check(readReadPeople.status === 403, 'read key: cannot read caddie-people');

  // Schedule import: a tiny text document through the attachment processor, indexed nowhere.
  const extract = {
    pipeline: { processors: [{ attachment: { field: 'data', target_field: 'doc', indexed_chars: 1000, properties: ['content'], remove_binary: true } }] },
    docs: [{ _source: { data: Buffer.from('Key check').toString('base64') } }],
  };
  const sim = await es('POST', '/_ingest/pipeline/_simulate', extract, R);
  check(sim.status === 200 && sim.json?.docs?.[0]?.doc?._source?.doc?.content === 'Key check', 'read key: can extract text with the attachment processor in a simulated pipeline');
  const getPipelines = await es('GET', '/_ingest/pipeline', undefined, R);
  check(getPipelines.status === 403, 'read key: cannot read stored pipelines');
  // An invalid body: refused with 403 when unauthorized, and it could never be stored anyway.
  const putPipeline = await es('PUT', '/_ingest/pipeline/caddie-keycheck-never', { processors: [{ caddie_no_such_processor: {} }] }, R);
  check(putPipeline.status === 403, 'read key: cannot create a pipeline');

  // A keyword-only document, so nothing is embedded. Its event id matches no conference.
  const id = encodeURIComponent('caddie-keycheck:' + randomBytes(8).toString('hex'));
  const write = await es(
    'PUT',
    `/caddie-people/_doc/${id}?refresh=wait_for`,
    { event_id: 'caddie-keycheck', profile_id: 'keycheck', open_to_meet: false, visible_until: '2000-01-01T00:00:00Z', sample: true },
    P,
  );
  check(write.status === 201 || write.status === 200, 'people key: can write caddie-people');
  const del = await es('DELETE', `/caddie-people/_doc/${id}?refresh=wait_for`, undefined, P);
  check(del.status === 200, 'people key: can delete its test document');
  const peopleReadTalks = await es('POST', '/caddie-talks/_search', { size: 0 }, P);
  check(peopleReadTalks.status === 403, 'people key: cannot read caddie-talks');
  const peopleReadFacets = await es('POST', '/caddie-facets/_search', { size: 0 }, P);
  check(peopleReadFacets.status === 403, 'people key: cannot read caddie-facets');
  const peopleWriteTalks = await es('POST', '/caddie-talks/_delete_by_query', nothing, P);
  check(peopleWriteTalks.status === 403, 'people key: cannot write caddie-talks');
  const peopleSim = await es('POST', '/_ingest/pipeline/_simulate', extract, P);
  check(peopleSim.status === 403, 'people key: cannot run a simulated pipeline');

  // Neither key may list or call inference endpoints. Only the listing is requested, so no
  // endpoint is ever run, and has_privileges confirms that a call would be refused too.
  const inferenceActions = ['monitor_inference', 'cluster:monitor/xpack/inference/post', 'cluster:monitor/xpack/inference/unified'];
  for (const [label, auth] of [['read key', R], ['people key', P]]) {
    const list = await es('GET', '/_inference/_all', undefined, auth);
    check(list.status === 403, `${label}: cannot list inference endpoints`);
    const priv = await es('POST', '/_security/user/_has_privileges', { cluster: inferenceActions }, auth);
    check(priv.status === 200 && Object.values(priv.json?.cluster ?? { x: true }).every((v) => v === false), `${label}: cannot call inference endpoints`);
  }
  return checks.every(Boolean);
}

try {
  if (OPERATOR_MODE) process.exit((await mintOperator()) ? 0 : 1);
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  if (only && !KEYS.some((k) => k.secret === only)) throw new Error(`--only takes ${KEYS.map((k) => k.secret).join(' or ')}`);
  if (!process.argv.includes('--verify-only')) {
    for (const k of KEYS) if (!only || k.secret === only) await mint(k);
  }
  const ok = await verify(readSecret('caddie-es-readonly'), readSecret('caddie-es-people'));
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
