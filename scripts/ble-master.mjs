// Creates and rotates the Bluetooth master keyring of derived tokens v1 (docs/contracts/ble-tokens.md,
// Keys) in the Secret Manager secret caddie-ble-master. scripts/deploy.sh mounts that secret as
// BLE_MASTER_KEYRING when it exists; without it the server serves only the legacy server-minted
// tokens. For an admin of the project only.
//
// Usage: node scripts/ble-master.mjs <command> [--project <id>]
//   --init           the first keyring: one new key, current. Refused when the secret already
//                    holds a version.
//   --add-next       rotation step 1: add a new key that is not current yet.
//   --promote <id>   rotation step 2: make that key current; new sessions are issued under it.
//   --retire <id>    rotation step 3: remove a key that is not current. Sessions it issued stop
//                    resolving, and their devices are asked for a new key (403 ble_rekey).
//   --status         the key ids and which one is current.
// --project defaults to the project scripts/deploy.sh deploys to. Deploy after every change, and
// let each deploy finish before the next step, so that every instance holds a key before any
// instance issues sessions under it.
//
// No key value is ever printed, logged or written to a file. The keyring is read from the output
// of `gcloud secrets versions access` into memory and written back as a new secret version through
// gcloud's standard input (`--data-file=-`), never as an argument. The key ids are not secret and
// are printed. Each change adds a version; the older versions still hold the keys they held, so
// after a leak the operator also destroys the versions older than the one --retire added (the
// script prints the commands).

import { spawnSync } from 'node:child_process';
import { parseKeyring, serializeKeyring, newKeyId, newMasterSecret, KeyringError, KEY_ID_RE } from '../server/ble-keyring.mjs';

const SECRET = 'caddie-ble-master';
const DEFAULT_PROJECT = 'project-9205d6eb-366e-4844-b77';
const USAGE = 'Usage: node scripts/ble-master.mjs --init | --add-next | --promote <id> | --retire <id> | --status [--project <id>]';

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

// Runs gcloud with the project. stdout is returned to the caller and never printed here; it holds
// the keyring for `versions access`. gcloud's own error output never contains a payload, so it is
// passed on when a call fails.
function gcloud(argv, { input } = {}) {
  const r = spawnSync('gcloud', [...argv, '--project', project, '--quiet'], {
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  if (r.error) fail(r.error.code === 'ENOENT' ? 'gcloud is not installed or not on PATH.' : 'gcloud could not be run.');
  return r;
}

function check(r, what) {
  if (r.status === 0) return;
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  fail(`${what} failed (gcloud exited with ${r.status}).`);
}

const secretExists = () => gcloud(['secrets', 'describe', SECRET, '--format=value(name)']).status === 0;

function hasVersion() {
  const r = gcloud(['secrets', 'versions', 'list', SECRET, '--filter=state:enabled', '--format=value(name)', '--limit=1']);
  check(r, `Listing the versions of ${SECRET}`);
  return r.stdout.trim() !== '';
}

function readKeyring() {
  const r = gcloud(['secrets', 'versions', 'access', 'latest', '--secret', SECRET]);
  check(r, `Reading the latest version of ${SECRET}`);
  try {
    return parseKeyring(r.stdout);
  } catch (err) {
    fail(`The latest version of ${SECRET} is not a usable keyring: ${err instanceof KeyringError ? err.message : 'it could not be read'}.`);
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

const describe = ({ current, masters }) => [...masters.keys()].map((id) => (id === current ? `${id} (current)` : id)).join(', ');
const DEPLOY = 'Now deploy (npm run deploy) and let it finish before the next step.';

if (command === '--init') {
  if (secretExists()) {
    if (hasVersion()) fail(`${SECRET} already holds a keyring. Rotate it with --add-next, --promote and --retire instead.`);
  } else {
    check(gcloud(['secrets', 'create', SECRET, '--replication-policy', 'automatic']), `Creating ${SECRET}`);
  }
  const id = newKeyId();
  writeKeyring({ current: id, masters: new Map([[id, newMasterSecret()]]) });
  console.log(`Stored a new keyring in ${SECRET} with one key: ${id} (current).\n${DEPLOY} The server then advertises ble.mode derived-v1.`);
} else {
  if (!secretExists()) fail(`${SECRET} does not exist yet. Create it with --init.`);
  const keyring = readKeyring();
  if (command === '--status') {
    console.log(`Keys in ${SECRET}: ${describe(keyring)}.`);
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
      const previous = keyring.current;
      keyring.current = target;
      writeKeyring(keyring);
      console.log(`${target} is now current. Keys: ${describe(keyring)}.\n${DEPLOY} Retire ${previous} with --retire ${previous} once the sessions it issued have ended (at the latest after the conference day), or at once after a leak.`);
    }
  } else if (command === '--retire') {
    if (!keyring.masters.has(target)) fail(`There is no key ${target}. Keys: ${describe(keyring)}.`);
    if (keyring.current === target) fail(`${target} is current. Promote another key first (--add-next, deploy, --promote <id>, deploy).`);
    keyring.masters.delete(target);
    writeKeyring(keyring);
    console.log(`Retired ${target}. Keys: ${describe(keyring)}.\n${DEPLOY}
After a leak, also destroy every older version of the secret, which still holds the retired key:
  gcloud secrets versions list ${SECRET} --project ${project}
  gcloud secrets versions destroy <version> --secret ${SECRET} --project ${project}   # each version but the latest`);
  }
}
