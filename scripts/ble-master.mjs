// Creates and rotates the Bluetooth master keyring of derived tokens v1 (docs/contracts/ble-tokens.md,
// Keys) in the Secret Manager secret caddie-ble-master. scripts/deploy.sh mounts that secret as
// BLE_MASTER_KEYRING when it exists, pinned to its latest enabled version at deploy time; without
// it the server serves only the legacy server-minted tokens. For an admin of the project only.
//
// Usage: node scripts/ble-master.mjs <command> [--project <id>]
//   --init           the first keyring: one new key, current. Refused when the secret already
//                    holds an enabled version.
//   --add-next       rotation step 1: add a new key that is not current yet.
//   --promote <id>   rotation step 2: make that key current; new sessions are issued under it.
//                    Refused unless the deployed keyring already holds the key (step 1 deployed).
//   --retire <id>    rotation step 3: remove a key that is not current. Sessions it issued stop
//                    resolving, and their devices are asked for a new key (403 ble_rekey).
//                    Refused while the key is current in the deployed keyring (step 2 not deployed).
//   --status         the key ids of the latest version and of the deployed one, and which is current.
// --project defaults to the project scripts/deploy.sh deploys to, and the service is the shell's
// SERVICE (default conference-caddie) in us-west1, as in scripts/deploy.sh. Deploy after every
// change, and let each deploy finish before the next step, so that every instance holds a key
// before any instance issues sessions under it. The deployed keyring is the secret version that
// the service's current revision mounts as BLE_MASTER_KEYRING.
//
// No key value is ever printed, logged or written to a file. A keyring is read from the output of
// `gcloud secrets versions access` into memory and written back as a new secret version through
// gcloud's standard input (`--data-file=-`), never as an argument. gcloud runs with HTTP logging
// and file logging off and only errors on its own error output, and that output is never passed
// on, because a failed call could include a request or response body: a failure prints which step
// failed and gcloud's exit code. The key ids are not secret and are printed. Each change adds a
// version; the older versions still hold the keys they held, so after a leak the operator also
// destroys the versions older than the one --retire added (the script prints the commands).

import { spawnSync } from 'node:child_process';
import { parseKeyring, serializeKeyring, newKeyId, newMasterSecret, KeyringError, KEY_ID_RE } from '../server/ble-keyring.mjs';

const SECRET = 'caddie-ble-master';
const ENV_NAME = 'BLE_MASTER_KEYRING';
const DEFAULT_PROJECT = 'project-9205d6eb-366e-4844-b77';
const REGION = 'us-west1';
const SERVICE = process.env.SERVICE || 'conference-caddie';
const USAGE = 'Usage: node scripts/ble-master.mjs --init | --add-next | --promote <id> | --retire <id> | --status [--project <id>]';
// gcloud's own logging, turned down so that nothing it writes can carry a payload.
const GCLOUD_ENV = { CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_VERBOSITY: 'error', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true' };

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// Arguments: exactly one command, and --project.
const args = process.argv.slice(2);
let project = DEFAULT_PROJECT;
let command = null;
let target = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--project') {
    project = args[++i] ?? '';
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) fail(`--project must be a project id.\n${USAGE}`, 2);
  } else if (['--init', '--add-next', '--status'].includes(a) && !command) {
    command = a;
  } else if (['--promote', '--retire'].includes(a) && !command) {
    command = a;
    target = args[++i] ?? '';
    if (!KEY_ID_RE.test(target)) fail(`${a} needs a key id (see --status).\n${USAGE}`, 2);
  } else {
    fail(USAGE, 2);
  }
}
if (!command) fail(USAGE, 2);
if (!/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(SERVICE)) fail('SERVICE must be a Cloud Run service name.', 2);

// Runs gcloud with the project. Its standard output is returned to the caller and never printed
// here (it holds the keyring for `versions access`); its error output is captured and dropped.
function gcloud(argv, { input } = {}) {
  const r = spawnSync('gcloud', [...argv, '--project', project, '--quiet'], {
    input,
    env: { ...process.env, ...GCLOUD_ENV },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  if (r.error) fail(r.error.code === 'ENOENT' ? 'gcloud is not installed or not on PATH.' : 'gcloud could not be run.');
  return r;
}

function check(r, what) {
  if (r.status === 0) return;
  fail(`${what} failed (gcloud exited with ${r.status ?? 'a signal'}). Its output is not shown, because it could include the keyring; run the step's gcloud command yourself to see why.`);
}

const secretExists = () => gcloud(['secrets', 'describe', SECRET, '--format=value(name)']).status === 0;

// The id of the newest enabled version, or null when there is none: the version deploy.sh mounts.
function latestVersion() {
  const r = gcloud(['secrets', 'versions', 'list', SECRET, '--filter=state:enabled', '--sort-by=~createTime', '--limit=1', '--format=value(name)']);
  check(r, `Listing the versions of ${SECRET}`);
  const name = r.stdout.trim().split('/').pop();
  return /^[0-9]+$/.test(name) ? name : null;
}

function readKeyring(version) {
  const r = gcloud(['secrets', 'versions', 'access', version, '--secret', SECRET]);
  check(r, `Reading version ${version} of ${SECRET}`);
  try {
    return parseKeyring(r.stdout);
  } catch (err) {
    fail(`Version ${version} of ${SECRET} is not a usable keyring: ${err instanceof KeyringError ? err.message : 'it could not be read'}.`);
  }
  return null;
}

function writeKeyring(keyring) {
  let text;
  try {
    text = serializeKeyring(keyring);
  } catch (err) {
    fail(`That keyring would not be usable: ${err instanceof KeyringError ? err.message : 'it could not be written'}.`);
  }
  check(gcloud(['secrets', 'versions', 'add', SECRET, '--data-file=-'], { input: text }), `Adding a version to ${SECRET}`);
}

// The keyring the service runs with: the secret version its current revision mounts as
// BLE_MASTER_KEYRING. { version: null, keyring: null } when it mounts none. Refuses when the latest
// deploy is not ready, when traffic goes to another revision, or when the version is not pinned,
// because then no single keyring is known to be on every instance.
function deployedKeyring() {
  const r = gcloud(['run', 'services', 'describe', SERVICE, '--region', REGION, '--format=json']);
  check(r, `Reading the Cloud Run service ${SERVICE}`);
  let service;
  try {
    service = JSON.parse(r.stdout);
  } catch {
    fail(`The description of the Cloud Run service ${SERVICE} could not be read.`);
  }
  const status = service?.status ?? {};
  if (!status.latestReadyRevisionName || status.latestReadyRevisionName !== status.latestCreatedRevisionName) {
    fail(`The latest revision of ${SERVICE} is not ready. Wait for the deploy to finish, or fix it, before the next step.`);
  }
  const serving = (status.traffic ?? []).filter((t) => (t.percent ?? 0) > 0);
  if (serving.some((t) => t.latestRevision !== true && t.revisionName !== status.latestReadyRevisionName)) {
    fail(`Traffic of ${SERVICE} goes to more than its latest revision. Send all traffic to the latest revision before the next step.`);
  }
  const env = (service?.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
  const ref = env.find((e) => e.name === ENV_NAME)?.valueFrom?.secretKeyRef;
  if (!ref) return { version: null, keyring: null };
  if (ref.name !== SECRET) fail(`${SERVICE} mounts ${ENV_NAME} from another secret than ${SECRET}.`);
  if (!/^[0-9]+$/.test(String(ref.key))) fail(`${SERVICE} mounts ${ENV_NAME} as version "${ref.key}", not a pinned version. Deploy with npm run deploy, which pins it, first.`);
  return { version: String(ref.key), keyring: readKeyring(String(ref.key)) };
}

const describe = ({ current, masters }) => [...masters.keys()].map((id) => (id === current ? `${id} (current)` : id)).join(', ');
const DEPLOY = 'Now deploy (npm run deploy) and let it finish before the next step.';

if (command === '--init') {
  if (secretExists()) {
    if (latestVersion()) fail(`${SECRET} already holds a keyring. Rotate it with --add-next, --promote and --retire instead.`);
  } else {
    check(gcloud(['secrets', 'create', SECRET, '--replication-policy', 'automatic']), `Creating ${SECRET}`);
  }
  const id = newKeyId();
  writeKeyring({ current: id, masters: new Map([[id, newMasterSecret()]]) });
  console.log(`Stored a new keyring in ${SECRET} with one key: ${id} (current).\n${DEPLOY} The server then advertises ble.mode derived-v1.`);
} else {
  if (!secretExists()) fail(`${SECRET} does not exist yet. Create it with --init.`);
  const version = latestVersion();
  if (!version) fail(`${SECRET} has no enabled version. Create one with --init.`);
  const keyring = readKeyring(version);
  if (command === '--status') {
    const deployed = deployedKeyring();
    const running = deployed.keyring ? `version ${deployed.version}: ${describe(deployed.keyring)}` : `none (${SERVICE} serves the legacy server-rotate mode)`;
    console.log(`Keys in ${SECRET}, latest version ${version}: ${describe(keyring)}.\nDeployed on ${SERVICE}: ${running}.`);
  } else if (command === '--add-next') {
    const id = newKeyId(keyring.masters);
    keyring.masters.set(id, newMasterSecret());
    writeKeyring(keyring);
    console.log(`Added key ${id}, not current. Keys: ${describe(keyring)}.\n${DEPLOY} Then make it current with --promote ${id}.`);
  } else if (command === '--promote') {
    if (!keyring.masters.has(target)) fail(`There is no key ${target}. Keys: ${describe(keyring)}.`);
    if (keyring.current === target) {
      console.log(`${target} is already current. Keys: ${describe(keyring)}.`);
    } else {
      const deployed = deployedKeyring();
      if (!deployed.keyring?.masters.has(target)) {
        fail(`${SERVICE} does not hold key ${target} yet: deploy the keyring that added it (npm run deploy) and let it finish, then promote it.`);
      }
      const previous = keyring.current;
      keyring.current = target;
      writeKeyring(keyring);
      console.log(`${target} is now current. Keys: ${describe(keyring)}.\n${DEPLOY} Retire ${previous} with --retire ${previous} once the sessions it issued have ended (at the latest after the conference day), or at once after a leak.`);
    }
  } else if (command === '--retire') {
    if (!keyring.masters.has(target)) fail(`There is no key ${target}. Keys: ${describe(keyring)}.`);
    if (keyring.current === target) fail(`${target} is current. Promote another key first (--add-next, deploy, --promote <id>, deploy).`);
    const deployed = deployedKeyring();
    if (deployed.keyring?.current === target) {
      fail(`${target} is still current on ${SERVICE}: deploy the promotion of ${keyring.current} (npm run deploy) and let it finish, then retire ${target}.`);
    }
    keyring.masters.delete(target);
    writeKeyring(keyring);
    console.log(`Retired ${target}. Keys: ${describe(keyring)}.\n${DEPLOY}
After a leak, also destroy every older version of the secret, which still holds the retired key:
  gcloud secrets versions list ${SECRET} --project ${project}
  gcloud secrets versions destroy <version> --secret ${SECRET} --project ${project}   # each version but the latest`);
  }
}
