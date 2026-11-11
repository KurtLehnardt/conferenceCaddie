#!/usr/bin/env node
// Generates the Worker's secrets and installs them without ever showing a value.
//
// Usage, from anywhere in the repository, after `bash worker/scripts/deploy.sh`:
//   node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]
//   node worker/scripts/setup-secrets.mjs --rotate-admin-token [--dry-run] [--skip-gh]
//
// Secrets:
//   ADMIN_TOKEN        32 random bytes as hex. Opens the /admin routes (ingest, migration, smoke
//                      fixtures, moderation). Also stored with `gh secret set CADDIE_ADMIN_TOKEN` for the
//                      ingest workflow and in ~/.config/conference-caddie/admin-token (mode 0600,
//                      outside the repository) for the smoke, migration and moderation runs.
//   ADMIN_TOKEN_NEXT   Only during a rotation (--rotate-admin-token, below): a second admin token the
//                      Worker verifies beside ADMIN_TOKEN. Never part of a normal run.
//   REF_SALT           32 random bytes as hex. Salts every person's public ref. Changing it changes
//                      every ref, so an existing REF_SALT is only replaced with --rotate-ref-salt.
//   VAPID_PRIVATE_KEY  The base64url 32-byte P-256 private scalar for Web Push.
//   VAPID_PUBLIC_KEY   The base64url 65-byte uncompressed public point. It is not secret (every
//                      browser receives it) but is stored as a secret so the pair stays together.
//                      The two VAPID keys are always set together, from one generated pair.
//   BLE_MASTER_KEYRING The Bluetooth master keyring of derived tokens v1 (src/lib/ble.js): JSON
//                      { "current": "<id>", "keys": { "<id>": "<32 random bytes, base64url>" } }.
//                      Only the first keyring is generated here, when the Worker has none; an
//                      existing keyring is never replaced, because that would retire every live
//                      session at once. Rotate it by hand in the three steps of
//                      docs/contracts/ble-tokens.md (Keys) with `npx wrangler secret put`.
//
// Every value is generated with Web Crypto and written to the standard input of
// `npx wrangler secret put NAME` (and `gh secret set NAME`); no value is ever put on a command
// line, in a log, in the repository or on the terminal. Child output is captured and only a status
// line is printed; on a failure the child's error text is printed with every generated value
// redacted.
//
// Options:
//   --only-missing      Skip names that `wrangler secret list` already shows. When ADMIN_TOKEN is
//                       skipped but the local token file exists and the GitHub secret is missing,
//                       the GitHub secret is set from that file. It never looks at
//                       ADMIN_TOKEN_NEXT (not one of the names above), which is safe after a rotation
//                       has started only because the Worker accepts ADMIN_TOKEN and ADMIN_TOKEN_NEXT
//                       side by side (src/lib/admin-auth.js, adminKeys): between the first step of a
//                       rotation and the last, the token file and the GitHub secret hold the value
//                       the Worker knows as ADMIN_TOKEN_NEXT, so a run that skips ADMIN_TOKEN as
//                       already set, or sets a missing GitHub secret from that file, still leaves
//                       every client with a token the Worker accepts. It never sets, replaces or
//                       deletes ADMIN_TOKEN_NEXT, and cannot be combined with --rotate-admin-token.
//   --dry-run           Print the names that would be set and the commands that would receive
//                       them, and change nothing.
//   --rotate-ref-salt   Allow replacing an existing REF_SALT (every ref changes).
//   --skip-gh           Do not touch the GitHub repository secret.
//   --rotate-admin-token
//                       Start an ADMIN_TOKEN rotation without an outage, and nothing else (no other
//                       secret is created or replaced). A new value is generated and
//                         1. put as ADMIN_TOKEN_NEXT on the Worker (the Worker now accepts the old and
//                            the new token),
//                         2. written to the token file (mode 0600), only after step 1 succeeded, so a
//                            failed step 1 leaves the old token in the file,
//                         3. set as the GitHub secret CADDIE_ADMIN_TOKEN (unless --skip-gh).
//                       Then it prints the two commands that finish the rotation, which are not run
//                       here, because an ingest or a smoke that started before step 2 still signs with
//                       the old token:
//                         npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token
//                         npx wrangler secret delete ADMIN_TOKEN_NEXT
//                       The value is never printed. On a failure the output says which of the three
//                       steps ran and what to do (docs/FREE_HOSTING.md, Rotate ADMIN_TOKEN).
// Env: ADMIN_TOKEN_FILE (default ~/.config/conference-caddie/admin-token, the file the smoke,
//      migration and moderation scripts read); CADDIE_GH_REPO, <owner>/<name> (default: what
//      `gh repo view --json nameWithOwner -q .nameWithOwner` says for this clone, and when that
//      fails the script stops and names the variable; --skip-gh needs neither);
//      CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read by wrangler itself.

import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = resolve(process.env.ADMIN_TOKEN_FILE || join(homedir(), '.config', 'conference-caddie', 'admin-token'));
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAMES = ['ADMIN_TOKEN', 'REF_SALT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'BLE_MASTER_KEYRING'];
// The repository secret that holds ADMIN_TOKEN for the ingest workflow.
const GH_SECRET = 'CADDIE_ADMIN_TOKEN';
// The Worker secret of a rotation in progress (see --rotate-admin-token).
const NEXT_NAME = 'ADMIN_TOKEN_NEXT';
const USAGE = 'Usage: node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]\n'
  + '       node worker/scripts/setup-secrets.mjs --rotate-admin-token [--dry-run] [--skip-gh]';

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      'only-missing': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'rotate-ref-salt': { type: 'boolean', default: false },
      'rotate-admin-token': { type: 'boolean', default: false },
      'skip-gh': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  console.log(`Sets ${NAMES.join(', ')} on the Worker through wrangler's standard input; prints names only.`);
  console.log(`--rotate-admin-token only starts an ADMIN_TOKEN rotation (${NEXT_NAME}, the token file, ${GH_SECRET}) and prints the two commands that finish it.`);
  process.exit(0);
}
if (options['rotate-admin-token'] && (options['only-missing'] || options['rotate-ref-salt'])) {
  console.error('--rotate-admin-token does nothing but start the rotation, so it cannot be combined with --only-missing or --rotate-ref-salt.');
  console.error(USAGE);
  process.exit(2);
}
const dryRun = options['dry-run'];

// Every generated value, so that any child error text can be redacted before it is printed.
const generated = [];

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

function randomHex(n) {
  const value = hex(crypto.getRandomValues(new Uint8Array(n)));
  generated.push(value);
  return value;
}

// The first Bluetooth master keyring: one key, current, with an id that tells keys apart by age.
function firstKeyring() {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = `${new Date().toISOString().slice(0, 10)}-${hex(crypto.getRandomValues(new Uint8Array(2)))}`;
  const value = JSON.stringify({ current: id, keys: { [id]: secret } });
  generated.push(secret, value);
  return value;
}

// A VAPID key pair in the format the web-push library and worker/src/push use.
async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = jwk.d;
  const publicKey = base64url(raw);
  if (Buffer.from(privateKey, 'base64url').length !== 32 || raw.length !== 65 || raw[0] !== 4) {
    throw new Error('Generated VAPID keys have an unexpected format.');
  }
  generated.push(privateKey, publicKey);
  return { privateKey, publicKey };
}

function redact(text) {
  let out = String(text);
  for (const value of generated) if (value) out = out.split(value).join('[redacted]');
  for (const name of ['CLOUDFLARE_API_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name];
    if (value) out = out.split(value).join(`[${name}]`);
  }
  return out;
}

// Runs a command with the given text on its standard input. Its output is captured, never
// streamed, so nothing the child echoes reaches the terminal.
function run(command, args, { input = '', cwd = WORKER_DIR } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolvePromise({ code: 127, stdout: '', stderr: `${command}: ${err.code ?? err.message}` }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function failureText(result) {
  const lines = redact(`${result.stderr}\n${result.stdout}`).trim().split('\n').filter(Boolean);
  return lines.slice(-12).join('\n');
}

// The names `wrangler secret list` shows, or null when the list cannot be read (for example
// before the first deploy).
async function workerSecretNames() {
  const result = await run('npx', ['--yes', 'wrangler', 'secret', 'list', '--format', 'json']);
  if (result.code !== 0) return { names: null, error: failureText(result) };
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  try {
    const list = JSON.parse(result.stdout.slice(start, end + 1));
    return { names: new Set(list.map((s) => s?.name).filter(Boolean)) };
  } catch {
    return { names: null, error: 'wrangler secret list printed no JSON list.' };
  }
}

// The repository whose secret CADDIE_ADMIN_TOKEN is set: CADDIE_GH_REPO, or what gh says for this
// clone. There is no built-in default, so a fork never writes to the original's secrets. Only
// asked for when a step needs it (never with --skip-gh); it stops the script when it cannot say.
let ghRepoName;
async function ghRepo() {
  if (ghRepoName) return ghRepoName;
  const fromEnv = (process.env.CADDIE_GH_REPO ?? '').trim();
  if (fromEnv) {
    if (!REPO_RE.test(fromEnv)) {
      console.error('CADDIE_GH_REPO must look like <owner>/<name>.');
      process.exit(2);
    }
    return (ghRepoName = fromEnv);
  }
  const result = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const found = result.stdout.trim();
  if (result.code === 0 && REPO_RE.test(found)) return (ghRepoName = found);
  console.error('CADDIE_GH_REPO is not set and gh could not tell which repository this clone belongs to'
    + ` (gh repo view --json nameWithOwner -q .nameWithOwner failed${result.code === 127 ? ': gh is not installed' : ''}).`);
  console.error('Set CADDIE_GH_REPO=<owner>/<name> (the repository that holds the ingest workflow), or pass --skip-gh to leave the GitHub secret alone.');
  const detail = failureText(result);
  if (detail && result.code !== 127) console.error(detail);
  process.exit(1);
}

async function githubSecretNames() {
  const result = await run('gh', ['secret', 'list', '--repo', await ghRepo(), '--json', 'name'], { cwd: WORKER_DIR });
  if (result.code !== 0) return null;
  try {
    return new Set(JSON.parse(result.stdout).map((s) => s?.name).filter(Boolean));
  } catch {
    return null;
  }
}

// hint is printed after the failure text: what state the failure left and what to do about it.
async function putWorkerSecret(name, value, hint = '') {
  const result = await run('npx', ['--yes', 'wrangler', 'secret', 'put', name], { input: value });
  if (result.code !== 0) {
    console.error(`Setting ${name} on the Worker failed (exit ${result.code}):\n${failureText(result)}`);
    if (hint) console.error(hint);
    process.exit(1);
  }
  console.log(`Set ${name} on the Worker.`);
}

async function putGithubSecret(name, value, hint) {
  const repo = await ghRepo();
  const result = await run('gh', ['secret', 'set', name, '--repo', repo], { input: value });
  if (result.code !== 0) {
    console.error(`Setting the GitHub secret ${name} failed (exit ${result.code}):\n${failureText(result)}`);
    console.error(hint ?? `The Worker and ${TOKEN_FILE} already hold the value; set the GitHub secret from that file with:\n  gh secret set ${name} --repo ${repo} < ${shellPath(TOKEN_FILE)}`);
    process.exit(1);
  }
  console.log(`Set the GitHub secret ${name} on ${repo}.`);
}

// Writes the file with mode 0600 from the first byte and swaps it in with a rename, so an old file
// of any mode is never left holding the new value, and a failure part-way never leaves a truncated
// token behind. A symlink at the path is followed, as a plain write would. hint is printed after a
// failure.
async function writeTokenFile(value, hint = '') {
  let tmp;
  try {
    await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    const target = await realpath(TOKEN_FILE).catch(() => TOKEN_FILE);
    tmp = join(dirname(target), `.admin-token.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    if (tmp) await rm(tmp, { force: true }).catch(() => {});
    console.error(`Writing ${TOKEN_FILE} failed (${err.code ?? err.message}).`);
    if (hint) console.error(hint);
    process.exit(1);
  }
  console.log(`Wrote ${TOKEN_FILE} (mode 0600).`);
}

// A path for a command line the operator will paste: ~ for the home directory, quotes where the
// shell needs them.
function shellPath(file) {
  const quote = (text) => (/^[A-Za-z0-9_.\/@%+=:,-]*$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
  const home = homedir();
  if (file.startsWith(`${home}/`)) return `~/${quote(file.slice(home.length + 1))}`;
  return quote(file);
}

async function readTokenFile() {
  try {
    const value = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (value) generated.push(value);
    return value || null;
  } catch {
    return null;
  }
}

// --rotate-admin-token: the steps in the order that keeps every failure recoverable. The Worker
// gets the new value first, as ADMIN_TOKEN_NEXT, beside the old ADMIN_TOKEN: it accepts both, so
// nothing a client holds stops working. The token file is overwritten only after that succeeded
// (a failure before it leaves the old token in the file, the only copy of the old value that the
// operator can read), and the GitHub secret last, from the same value. The two commands that make
// the new value the ADMIN_TOKEN and drop ADMIN_TOKEN_NEXT are printed, not run: a running ingest
// or smoke still signs with the token it started with.
async function rotateAdminToken() {
  const skipGh = options['skip-gh'];
  const file = shellPath(TOKEN_FILE);

  // Read-only checks first, so a failure here leaves everything as it was.
  const { names, error } = await workerSecretNames();
  if (!names) {
    if (!dryRun) {
      console.error(`Could not read the Worker's secret list; deploy first (bash worker/scripts/deploy.sh).\n${error ?? ''}`.trim());
      process.exit(1);
    }
    console.log('Could not read the Worker\'s secret list (it may not be deployed yet); the dry run cannot check that ADMIN_TOKEN is set.');
  } else if (!names.has('ADMIN_TOKEN')) {
    const why = 'ADMIN_TOKEN is not set on the Worker, so there is nothing to rotate; run node worker/scripts/setup-secrets.mjs --only-missing to create it.';
    if (!dryRun) {
      console.error(why);
      process.exit(1);
    }
    console.log(`Note: ${why} A real run stops here.`);
  } else if (names.has(NEXT_NAME)) {
    console.log(`${NEXT_NAME} is already set on the Worker (an earlier rotation was not finished); this run replaces it. ADMIN_TOKEN keeps working.`);
  }
  // Asked for before anything changes, so an unresolvable repository stops the run early.
  const repo = skipGh ? null : await ghRepo();
  const ghSetFromFile = `gh secret set ${GH_SECRET} --repo ${repo ?? (process.env.CADDIE_GH_REPO?.trim() || '<owner>/<name>')} < ${file}`;
  const finishing = `  npx wrangler secret put ADMIN_TOKEN < ${file}\n  npx wrangler secret delete ${NEXT_NAME}`;

  if (dryRun) {
    console.log('Dry run: nothing is generated or changed.');
    console.log(`Would set ${NEXT_NAME}: npx wrangler secret put ${NEXT_NAME}  (a new value, 32 random bytes as hex, on standard input; the Worker then accepts the old and the new token)`);
    console.log(`Would write the new value to ${TOKEN_FILE}  (mode 0600), only after ${NEXT_NAME} was set`);
    if (skipGh) console.log(`Would leave the GitHub secret ${GH_SECRET} alone (--skip-gh).`);
    else console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${repo}  (value on standard input)`);
    console.log(`Would then print the two commands that finish the rotation, from ${WORKER_DIR} (this script never runs them):\n${finishing}`);
    return;
  }

  const token = randomHex(32);
  await putWorkerSecret(NEXT_NAME, token,
    `Nothing else was changed: ADMIN_TOKEN, ${TOKEN_FILE} and the GitHub secret ${GH_SECRET} keep their old values and keep working. Run the same command again; a ${NEXT_NAME} that was stored anyway is replaced.`);
  await writeTokenFile(token,
    `The Worker now accepts a new ${NEXT_NAME} that is saved nowhere, and ADMIN_TOKEN, the token file and ${GH_SECRET} are unchanged, so every client keeps working. Fix the path (ADMIN_TOKEN_FILE) and run the same command again; it replaces ${NEXT_NAME}.`);
  if (skipGh) {
    console.log(`Skipped the GitHub secret (--skip-gh): ${GH_SECRET} still holds the old token. Run this before the two commands below, or the ingest workflow is refused once ADMIN_TOKEN changes:\n  ${ghSetFromFile}`);
  } else {
    await putGithubSecret(GH_SECRET, token,
      `The Worker accepts the new token as ${NEXT_NAME} and ${TOKEN_FILE} holds it; ${GH_SECRET} still holds the old token, which the Worker still accepts as ADMIN_TOKEN, so the ingest keeps working for now.\n`
      + `Retry with this command, and do not run the two finishing commands before it succeeds:\n  ${ghSetFromFile}`);
  }
  console.log(`${NEXT_NAME} is live: the Worker accepts the old and the new token. The token file${skipGh ? '' : ` and ${GH_SECRET}`} hold${skipGh ? 's' : ''} the new one.`);
  console.log(`To finish the rotation, run these two commands in this order from ${WORKER_DIR}, once any running ingest or smoke has finished (it signs with the token it started with):\n${finishing}`);
  console.log('Run the second only after the first succeeded; if the first fails, run it again, both tokens keep working meanwhile. Never print the token file.');
}

if (options['rotate-admin-token']) {
  await rotateAdminToken();
  process.exit(0);
}

// Decide which names to set.
const { names: existing, error: listError } = await workerSecretNames();
if (!existing) {
  if (!dryRun) {
    console.error(`Could not read the Worker's secret list; deploy first (bash worker/scripts/deploy.sh).\n${listError ?? ''}`.trim());
    process.exit(1);
  }
  console.log('Could not read the Worker\'s secret list (it may not be deployed yet); assuming no secret exists.');
}
const has = (name) => Boolean(existing?.has(name));

const plan = new Set();
for (const name of NAMES) {
  if (options['only-missing'] && has(name)) continue;
  if (name === 'REF_SALT' && has(name) && !options['rotate-ref-salt']) {
    console.log('Keeping the existing REF_SALT (changing it changes every ref; pass --rotate-ref-salt to replace it).');
    continue;
  }
  if (name === 'BLE_MASTER_KEYRING' && has(name)) {
    console.log('Keeping the existing BLE_MASTER_KEYRING (rotate it by hand, see docs/contracts/ble-tokens.md).');
    continue;
  }
  plan.add(name);
}
// The VAPID keys are one pair: when either is set, both are.
if (plan.has('VAPID_PRIVATE_KEY') || plan.has('VAPID_PUBLIC_KEY')) {
  plan.add('VAPID_PRIVATE_KEY');
  plan.add('VAPID_PUBLIC_KEY');
}
for (const name of NAMES) if (!plan.has(name) && has(name) && options['only-missing']) console.log(`Skipping ${name}: already set on the Worker.`);

// ADMIN_TOKEN already on the Worker: make sure the GitHub secret exists, from the local file.
let syncGithubFromFile = false;
if (!plan.has('ADMIN_TOKEN') && has('ADMIN_TOKEN') && !options['skip-gh']) {
  const ghNames = await githubSecretNames();
  if (ghNames && !ghNames.has(GH_SECRET)) syncGithubFromFile = true;
}

if (dryRun) {
  console.log('Dry run: nothing is generated or changed.');
  for (const name of NAMES) {
    if (!plan.has(name)) continue;
    console.log(`Would set ${name}: npx wrangler secret put ${name}  (value on standard input)`);
    if (name === 'ADMIN_TOKEN') {
      console.log(`Would write ${name} to ${TOKEN_FILE}  (mode 0600)`);
      if (!options['skip-gh']) console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${await ghRepo()}  (value on standard input)`);
    }
  }
  if (syncGithubFromFile) console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${await ghRepo()}  (value from ${TOKEN_FILE}, on standard input)`);
  if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
  process.exit(0);
}

if (plan.has('ADMIN_TOKEN')) {
  const token = randomHex(32);
  await putWorkerSecret('ADMIN_TOKEN', token);
  await writeTokenFile(token, `The Worker already holds the new ADMIN_TOKEN and nothing local has it. Fix the path (ADMIN_TOKEN_FILE) and run this script with --rotate-admin-token, then run the two commands it prints.`);
  if (!options['skip-gh']) await putGithubSecret(GH_SECRET, token);
} else if (syncGithubFromFile) {
  const token = await readTokenFile();
  if (token) await putGithubSecret(GH_SECRET, token);
  else console.error(`ADMIN_TOKEN is set on the Worker but ${TOKEN_FILE} is missing, so the GitHub secret cannot be set. Rerun without --only-missing to rotate it.`);
}
if (plan.has('REF_SALT')) await putWorkerSecret('REF_SALT', randomHex(32));
if (plan.has('VAPID_PRIVATE_KEY')) {
  const { privateKey, publicKey } = await vapidPair();
  await putWorkerSecret('VAPID_PRIVATE_KEY', privateKey);
  await putWorkerSecret('VAPID_PUBLIC_KEY', publicKey);
}
if (plan.has('BLE_MASTER_KEYRING')) await putWorkerSecret('BLE_MASTER_KEYRING', firstKeyring());
if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
