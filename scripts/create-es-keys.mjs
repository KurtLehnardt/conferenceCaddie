// Mints the two scoped Elasticsearch API keys the deployed service uses and stores them in
// Google Secret Manager. It never prints, logs or writes a key value or a password.
//
//   ELASTISEARCH_API_KEY=... node scripts/create-es-keys.mjs [--verify-only]
//
// An API key cannot mint a derived key that carries privileges, so each key is minted by a
// native user that holds exactly the key's privileges:
//   caddie-readonly-svc: read and view_index_metadata on caddie-talks*, caddie-conferences*
//                        and caddie-topics*. Stored in the secret caddie-es-readonly.
//   caddie-people-svc:   read, write and view_index_metadata on caddie-people*.
//                        Stored in the secret caddie-es-people.
// Each user gets a random in-memory password, mints its key, and then has its password reset
// to another random value that is discarded, so nobody can sign in as it afterwards.
// Key values reach gcloud only through the child process's stdin.
//
// The script then checks, in process, that the read key can search talks but cannot write,
// and that the people key can write people but cannot read or write talks. It prints only
// PASS or FAIL for each check.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const PROJECT = process.env.GC_PROJECT || 'project-9205d6eb-366e-4844-b77';
const ADMIN = process.env.ELASTISEARCH_API_KEY;
if (!ADMIN) {
  console.error('ELASTISEARCH_API_KEY is not set.');
  process.exit(1);
}

// Inference privileges let a key run semantic queries and index into semantic_text fields
// with the default endpoint. They cannot create or change inference endpoints.
const KEYS = [
  {
    user: 'caddie-readonly-svc',
    role: 'caddie_readonly',
    secret: 'caddie-es-readonly',
    cluster: ['monitor_inference'],
    indices: [{ names: ['caddie-talks*', 'caddie-conferences*', 'caddie-topics*'], privileges: ['read', 'view_index_metadata'] }],
  },
  {
    user: 'caddie-people-svc',
    role: 'caddie_people',
    secret: 'caddie-es-people',
    cluster: ['monitor_inference'],
    indices: [{ names: ['caddie-people*'], privileges: ['read', 'write', 'view_index_metadata'] }],
  },
];

async function es(method, path, body, auth = `ApiKey ${ADMIN}`) {
  const res = await fetch(ES_URL + path, {
    method,
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
  const readWriteTalks = await es('POST', '/caddie-talks/_delete_by_query', nothing, R);
  check(readWriteTalks.status === 403, 'read key: cannot write caddie-talks');
  const readWritePeople = await es('POST', '/caddie-people/_delete_by_query', nothing, R);
  check(readWritePeople.status === 403, 'read key: cannot write caddie-people');
  const readReadPeople = await es('POST', '/caddie-people/_search', { size: 0 }, R);
  check(readReadPeople.status === 403, 'read key: cannot read caddie-people');

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
  const peopleWriteTalks = await es('POST', '/caddie-talks/_delete_by_query', nothing, P);
  check(peopleWriteTalks.status === 403, 'people key: cannot write caddie-talks');
  return checks.every(Boolean);
}

try {
  if (!process.argv.includes('--verify-only')) {
    for (const k of KEYS) await mint(k);
  }
  const ok = await verify(readSecret('caddie-es-readonly'), readSecret('caddie-es-people'));
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
