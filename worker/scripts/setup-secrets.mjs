#!/usr/bin/env node
// Generates the Worker's secrets and installs them without ever showing a value.
//
// Usage, from anywhere in the repository, after `bash worker/scripts/deploy.sh`:
//   node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]
//   node worker/scripts/setup-secrets.mjs --rotate-admin-token [--replace-next] [--dry-run] [--skip-gh]
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
//                       Each step leaves the token file and the GitHub secret holding a value the
//                       Worker accepts, so no client is refused. That holds only when the Worker has no
//                       ADMIN_TOKEN_NEXT yet: with one already set, a rotation is in progress, and
//                       replacing its value would make the Worker refuse a token file and a GitHub
//                       secret that may hold exactly that value. The run then stops without changing
//                       anything and says what to do (finish the earlier rotation, or --replace-next).
//                       Then it prints the two commands that finish the rotation, which are not run
//                       here, because an ingest or a smoke that started before step 2 still signs with
//                       the old token:
//                         npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token
//                         npx wrangler secret delete ADMIN_TOKEN_NEXT
//                       The value is never printed. On a failure the output says which of the three
//                       steps ran and what to do (docs/FREE_HOSTING.md, Rotate ADMIN_TOKEN).
//   --replace-next      With --rotate-admin-token: replace an ADMIN_TOKEN_NEXT that is already set, for
//                       an earlier rotation that stopped at its Worker or token-file step. Until all
//                       three steps of this run are done, the token file and the GitHub secret may
//                       hold the old ADMIN_TOKEN_NEXT, which the Worker no longer accepts, and the
//                       output says so at every failure. Refused with --skip-gh, because the GitHub
//                       secret must then be set again.
// Env: ADMIN_TOKEN_FILE (default ~/.config/conference-caddie/admin-token, the file the smoke,
//      migration and moderation scripts read); CADDIE_GH_REPO, <owner>/<name> (default: the
//      github.com repository that the git remote "origin" of this clone names, in https or ssh
//      form; when that cannot be worked out the script stops and names the variable; --skip-gh
//      needs neither). `gh repo view` is not used: in a fork clone, which has the original as
//      "upstream", it names the original, and the secret would go to the wrong repository.
//      CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read by wrangler itself. Each child
//      process gets only the environment it needs (wrangler no GitHub token, gh no Cloudflare one).

import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WORKER_DIR, '..');
const TOKEN_FILE = resolve(process.env.ADMIN_TOKEN_FILE || join(homedir(), '.config', 'conference-caddie', 'admin-token'));
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAMES = ['ADMIN_TOKEN', 'REF_SALT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'BLE_MASTER_KEYRING'];
// The repository secret that holds ADMIN_TOKEN for the ingest workflow.
const GH_SECRET = 'CADDIE_ADMIN_TOKEN';
// The Worker secret of a rotation in progress (see --rotate-admin-token).
const NEXT_NAME = 'ADMIN_TOKEN_NEXT';
const USAGE = 'Usage: node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]\n'
  + '       node worker/scripts/setup-secrets.mjs --rotate-admin-token [--replace-next] [--dry-run] [--skip-gh]';

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      'only-missing': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'rotate-ref-salt': { type: 'boolean', default: false },
      'rotate-admin-token': { type: 'boolean', default: false },
      'replace-next': { type: 'boolean', default: false },
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
if (options['replace-next'] && !options['rotate-admin-token']) {
  console.error('--replace-next goes with --rotate-admin-token.');
  console.error(USAGE);
  process.exit(2);
}
if (options['replace-next'] && options['skip-gh']) {
  console.error('--replace-next cannot be combined with --skip-gh: the GitHub secret may hold the ADMIN_TOKEN_NEXT that is being replaced, which the Worker would then refuse, so it has to be set again.');
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

// The environment of a child: what any tool needs to run (PATH, HOME, locale, temp directory,
// proxies and certificates), plus the prefixes of the variables that tool reads, and nothing else.
// wrangler gets the Cloudflare and npm settings but no GitHub token, gh gets the GitHub settings but
// no Cloudflare token, and git only the common part (no GIT_* variable steers it to another repository).
const COMMON_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'LANG',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', '__CF_USER_TEXT_ENCODING',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
]);
const COMMON_PREFIXES = ['LC_', 'XDG_'];
const TOOL_PREFIXES = {
  npx: ['CLOUDFLARE_', 'WRANGLER_', 'CF_', 'npm_config_', 'NPM_CONFIG_', 'NODE_'],
  gh: ['GH_', 'GITHUB_'],
};
function childEnv(command) {
  const prefixes = [...COMMON_PREFIXES, ...(TOOL_PREFIXES[command] ?? [])];
  const out = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (COMMON_ENV.has(name) || prefixes.some((p) => name.startsWith(p))) out[name] = value;
  }
  return out;
}

// Runs a command with the given text on its standard input. Its output is captured, never
// streamed, so nothing the child echoes reaches the terminal.
function run(command, args, { input = '', cwd = WORKER_DIR } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: childEnv(command), stdio: ['pipe', 'pipe', 'pipe'] });
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

// The owner and name of a github.com remote URL in https or ssh form, or null. Strict: the host is
// github.com itself, the owner and name are plain, there is no user name or password in an https
// URL, and nothing follows the name but an optional ".git" and, for https, a "/".
const OWNER = '([A-Za-z0-9][A-Za-z0-9_-]*)';
const NAME = '([A-Za-z0-9._-]+?)';
const REMOTE_FORMS = [
  new RegExp(`^https://github\\.com/${OWNER}/${NAME}(?:\\.git)?/?$`, 'i'),
  new RegExp(`^git@github\\.com:${OWNER}/${NAME}(?:\\.git)?$`, 'i'),
  new RegExp(`^ssh://git@github\\.com/${OWNER}/${NAME}(?:\\.git)?$`, 'i'),
];
function repoFromRemoteUrl(url) {
  for (const form of REMOTE_FORMS) {
    const m = form.exec(url);
    if (m && m[2] !== '.' && m[2] !== '..') return `${m[1]}/${m[2]}`;
  }
  return null;
}

// The repository whose secret CADDIE_ADMIN_TOKEN is set: CADDIE_GH_REPO, or the github.com
// repository the git remote "origin" of this clone names. There is no built-in default, so a fork
// never writes to the original's secrets, and `gh repo view` is not asked: in a fork clone made by
// `gh repo fork --clone` it names the original ("upstream"), not the fork. Only asked for when a step
// needs it (never with --skip-gh); it stops the script when it cannot say.
let ghRepoFound;
async function ghRepo() {
  if (ghRepoFound) return ghRepoFound.name;
  const fromEnv = (process.env.CADDIE_GH_REPO ?? '').trim();
  if (fromEnv) {
    if (!REPO_RE.test(fromEnv)) {
      console.error('CADDIE_GH_REPO must look like <owner>/<name>.');
      process.exit(2);
    }
    ghRepoFound = { name: fromEnv, source: 'CADDIE_GH_REPO' };
    return fromEnv;
  }
  const result = await run('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
  const name = result.code === 0 ? repoFromRemoteUrl(result.stdout.trim()) : null;
  if (name) {
    ghRepoFound = { name, source: 'the git remote "origin"' };
    return name;
  }
  const why = result.code === 127 ? 'git is not installed'
    : result.code !== 0 ? 'this clone has no remote named "origin"'
      : '"origin" is not a github.com address in https or ssh form';
  console.error(`CADDIE_GH_REPO is not set and the repository could not be worked out from this clone (${why}).`);
  console.error('Set CADDIE_GH_REPO=<owner>/<name> (the repository that holds the ingest workflow), or pass --skip-gh to leave the GitHub secret alone.');
  process.exit(1);
}

// Says where the GitHub secret goes, before anything is changed.
async function announceRepo() {
  const name = await ghRepo();
  console.log(`The GitHub secret ${GH_SECRET} goes to ${name} (from ${ghRepoFound.source}).`);
  return name;
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
//
// That holds only when the Worker has no ADMIN_TOKEN_NEXT yet. With one already set, an earlier
// rotation was started, and the token file and the GitHub secret may hold exactly its value;
// putting a new value there would make the Worker refuse them. So the run stops, and --replace-next
// is the explicit choice to go on, with every hint then saying that the two may be refused.
async function rotateAdminToken() {
  const skipGh = options['skip-gh'];
  const file = shellPath(TOKEN_FILE);
  let nextExists = false;

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
  } else {
    nextExists = names.has(NEXT_NAME);
  }
  // Asked for before anything changes, so an unresolvable repository stops the run early.
  const repo = skipGh ? null : await ghRepo();
  const ghSetFromFile = `gh secret set ${GH_SECRET} --repo ${repo ?? (process.env.CADDIE_GH_REPO?.trim() || '<owner>/<name>')} < ${file}`;
  const finishing = `  npx wrangler secret put ADMIN_TOKEN < ${file}\n  npx wrangler secret delete ${NEXT_NAME}`;

  const replacing = nextExists && options['replace-next'];
  if (nextExists && !replacing) {
    const why = `${NEXT_NAME} is already set on the Worker, so an earlier rotation was started and not finished, and this run would replace its value. That can lock clients out: `
      + `the token file and ${GH_SECRET} may hold exactly the value that is ${NEXT_NAME} now, and the Worker would stop accepting it. Nothing was changed. Find out where the earlier rotation stopped:\n`
      + `  - It went through all three steps (its output ended with the two finishing commands): run them, from ${WORKER_DIR}:\n${finishing.replace(/^/gm, '    ')}\n`
      + `  - The finishing "put" of ADMIN_TOKEN already ran: only  npx wrangler secret delete ${NEXT_NAME}  is left.\n`
      + `  - It stopped at its GitHub step (the token file holds the new value, ${GH_SECRET} the old one): run  ${ghSetFromFile}  and then the two finishing commands.\n`
      + `  - It stopped at its Worker step or its token-file step (the token file and ${GH_SECRET} still hold the ADMIN_TOKEN): run this command again with --replace-next.`;
    if (!dryRun) {
      console.error(why);
      process.exit(1);
    }
    console.log(`Note: ${why}\nA real run stops here.`);
  }

  if (dryRun) {
    console.log('Dry run: nothing is generated or changed.');
    if (replacing) console.log(`${NEXT_NAME} is already set on the Worker; --replace-next would replace it.`);
    console.log(`Would set ${NEXT_NAME}: npx wrangler secret put ${NEXT_NAME}  (a new value, 32 random bytes as hex, on standard input; the Worker then accepts the old and the new token)`);
    console.log(`Would write the new value to ${TOKEN_FILE}  (mode 0600), only after ${NEXT_NAME} was set`);
    if (skipGh) console.log(`Would leave the GitHub secret ${GH_SECRET} alone (--skip-gh).`);
    else console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${repo}  (value on standard input; the repository is ${ghRepoFound.source === 'CADDIE_GH_REPO' ? 'CADDIE_GH_REPO' : 'what the git remote "origin" names'})`);
    console.log(`Would then print the two commands that finish the rotation, from ${WORKER_DIR} (this script never runs them):\n${finishing}`);
    return;
  }

  if (!skipGh) await announceRepo();
  if (replacing) {
    console.log(`${NEXT_NAME} is already set on the Worker; --replace-next replaces it. From the Worker step on, the token file and ${GH_SECRET} may hold the old ${NEXT_NAME}, which the Worker then no longer accepts, until this run has been through all three steps.`);
  }
  const token = randomHex(32);
  await putWorkerSecret(NEXT_NAME, token, replacing
    ? `Nothing was changed by this run: ${NEXT_NAME}, the token file and ${GH_SECRET} are as they were. Run the same command again.`
    : `Nothing else was changed: ADMIN_TOKEN, ${TOKEN_FILE} and the GitHub secret ${GH_SECRET} keep their old values and keep working. Run the same command again; if it then says ${NEXT_NAME} is already set (the put may have gone through), the token file and ${GH_SECRET} still hold the ADMIN_TOKEN, so run it with --replace-next.`);
  await writeTokenFile(token, replacing
    ? `The Worker now accepts a new ${NEXT_NAME} that is saved nowhere. The token file and ${GH_SECRET} may hold the old ${NEXT_NAME}, which the Worker no longer accepts (only the ADMIN_TOKEN is still accepted), so a client that uses them is refused until a run of this command with --replace-next has been through all three steps. Fix the path (ADMIN_TOKEN_FILE) and run it again.`
    : `The Worker now accepts a new ${NEXT_NAME} that is saved nowhere, and ADMIN_TOKEN, the token file and ${GH_SECRET} are unchanged, so every client keeps working. Fix the path (ADMIN_TOKEN_FILE) and run the same command again with --replace-next.`);
  if (skipGh) {
    console.log(`Skipped the GitHub secret (--skip-gh): ${GH_SECRET} still holds the old token. Run this before the two commands below, or the ingest workflow is refused once ADMIN_TOKEN changes:\n  ${ghSetFromFile}`);
  } else {
    await putGithubSecret(GH_SECRET, token, replacing
      ? `The token file holds the new value. ${GH_SECRET} holds an older one: if that is the old ${NEXT_NAME} (the earlier rotation had got as far as its GitHub step), the Worker no longer accepts it and the ingest is refused until this command succeeds; if it is the ADMIN_TOKEN, it is still accepted.\n`
        + `Run this command, and do not run the two finishing commands before it succeeds:\n  ${ghSetFromFile}`
      : `The Worker accepts the new token as ${NEXT_NAME} and ${TOKEN_FILE} holds it; ${GH_SECRET} still holds the old token, which the Worker still accepts as ADMIN_TOKEN, so the ingest keeps working for now.\n`
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

// The repository of the GitHub secret is worked out before anything is changed, whenever GitHub
// will be touched, so a clone it cannot be worked out for stops the run before ADMIN_TOKEN is put
// and the token file is written, not after.
if (!options['skip-gh'] && (plan.has('ADMIN_TOKEN') || has('ADMIN_TOKEN'))) await ghRepo();

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

if (plan.has('ADMIN_TOKEN') && !options['skip-gh']) await announceRepo();
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
