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
//                      ingest workflow and in the token file (mode 0600, outside the repository; see
//                      Env below) for the smoke, the ingest and migration scripts and caddie-admin.
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
//                       the GitHub secret is set from that file (found as described under Env), only
//                       when the file is trusted (see Env). Otherwise the run stops with exit 1
//                       before changing anything and says to set ADMIN_TOKEN_FILE to the file that
//                       holds this deployment's token. It never looks at ADMIN_TOKEN_NEXT (not one of the names above), which is safe after a rotation
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
//                       anything and prints a recipe that is safe wherever the earlier rotation
//                       stopped (the token file's value becomes the only admin token: gh secret set,
//                       wrangler secret put ADMIN_TOKEN, wrangler secret delete ADMIN_TOKEN_NEXT), or,
//                       when the token file is not trusted (see Env), says to set ADMIN_TOKEN_FILE
//                       to the file that holds this deployment's token, or, when it is missing, empty
//                       or too short to trust, says to stop; --replace-next is the other way on.
//                       Then it prints the two commands that finish the rotation, which are not run
//                       here, because an ingest or a smoke that started before step 2 still signs with
//                       the old token:
//                         npx wrangler secret put ADMIN_TOKEN < <token file>
//                         npx wrangler secret delete ADMIN_TOKEN_NEXT
//                       with the token file's path in place of <token file>, quoted for the shell.
//                       The value is never printed. On a failure the output says which of the three
//                       steps ran and what to do (docs/FREE_HOSTING.md, Rotate ADMIN_TOKEN).
//   --replace-next      With --rotate-admin-token: replace an ADMIN_TOKEN_NEXT that is already set, for
//                       an earlier rotation that stopped at its Worker or token-file step. Until all
//                       three steps of this run are done, the token file and the GitHub secret may
//                       hold the old ADMIN_TOKEN_NEXT, which the Worker no longer accepts, and the
//                       output says so at every failure. Refused with --skip-gh, because the GitHub
//                       secret must then be set again.
// Env: ADMIN_TOKEN_FILE, the token file. When it is unset or empty, the token file is admin-token in
//      the config directory of the caddie-admin CLI (configDir in scripts/admin/config.mjs), the
//      same rule as readAdminToken in worker/ingest/lib.mjs (worker/ingest/admin-token-file.mjs):
//      $CADDIE_ADMIN_HOME/admin-token when CADDIE_ADMIN_HOME is set and not empty, else
//      ${XDG_CONFIG_HOME:-~/.config}/conference-caddie/admin-token. Without either variable that is
//      ~/.config/conference-caddie/admin-token, which was the only default before. The token is
//      written only to that file. When that is a new place and the old file still exists, a write
//      says so in one line and leaves the old file alone. A read (the --only-missing GitHub sync and
//      the check of an unfinished rotation) reads each file once and uses the value it compared.
//      The file it read is trusted only when ADMIN_TOKEN_FILE names it, when no different file is
//      at the old place, or when both hold the same token. Any other state is not trusted: no file
//      at the new place and one at the old (which may hold another deployment's token, for example
//      one kept apart with CADDIE_ADMIN_HOME), two files with different tokens, or an old file that
//      exists and cannot be read. Then both reads stop with exit 1, change nothing, name both paths
//      (never a value) and say to set ADMIN_TOKEN_FILE to the file that holds this deployment's
//      token. Two paths that lead to one file through a symbolic or a hard link (~/.config a link to
//      $XDG_CONFIG_HOME, say) are one file, so there is no old file then. With ADMIN_TOKEN_FILE set
//      there is no fallback and no comparison.
//      CADDIE_GH_REPO, <owner>/<name> (default: the github.com repository that the git remote
//      "origin" of this clone names, in https or ssh form; when that cannot be worked out the
//      script stops and names the variable; --skip-gh needs neither). `gh repo view` is not used: in a fork clone, which has the original as
//      "upstream", it names the original, and the secret would go to the wrong repository.
//      CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read by wrangler itself. Each child
//      process gets only the environment it needs (wrangler no GitHub token, gh no Cloudflare one).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adminTokenFile, adminTokenFileToRead } from '../ingest/admin-token-file.mjs';

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WORKER_DIR, '..');
// The token file this script writes; see Env above.
const { path: TOKEN_FILE } = adminTokenFile(process.env);
// <owner>/<name>: the owner starts with a letter or digit, and the name is not . or .. .
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
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
// { name, source } or { error: [lines], exitCode }; never exits.
async function findGhRepo() {
  if (ghRepoFound) return ghRepoFound;
  const fromEnv = (process.env.CADDIE_GH_REPO ?? '').trim();
  if (fromEnv) {
    if (!REPO_RE.test(fromEnv)) return { error: ['CADDIE_GH_REPO must look like <owner>/<name>.'], exitCode: 2 };
    return (ghRepoFound = { name: fromEnv, source: 'CADDIE_GH_REPO' });
  }
  const result = await run('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
  const url = result.stdout.trim();
  const name = result.code === 0 ? repoFromRemoteUrl(url) : null;
  if (name) return (ghRepoFound = { name, source: 'the git remote "origin"' });
  // Each way it can fail gets its own words. The remote itself is never echoed: it may hold a credential.
  const why = result.code === 127 ? 'git is not installed'
    : result.code === 2 ? 'this clone has no remote named "origin"'
      : result.code === 128 ? 'git cannot read this folder as a checkout: it is not one, or git refuses it because another user owns it'
        : result.code !== 0 ? `git failed (exit ${result.code})`
          : /^https:\/\/[^/@\s]*@github\.com\//i.test(url) ? 'the git remote "origin" holds a user name or password, which this script does not take from a remote; use a plain https or ssh address'
            : '"origin" is not a github.com address in https or ssh form';
  return {
    error: [
      `CADDIE_GH_REPO is not set and the repository could not be worked out from this clone (${why}).`,
      'Set CADDIE_GH_REPO=<owner>/<name> (the repository that holds the ingest workflow), or pass --skip-gh to leave the GitHub secret alone.',
    ],
    exitCode: 1,
  };
}

async function ghRepo() {
  const found = await findGhRepo();
  if (found.error) {
    for (const line of found.error) console.error(line);
    process.exit(found.exitCode);
  }
  return found.name;
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

// file is the token file that holds value, for the default hint.
async function putGithubSecret(name, value, hint, file = TOKEN_FILE) {
  const repo = await ghRepo();
  const result = await run('gh', ['secret', 'set', name, '--repo', repo], { input: value });
  if (result.code !== 0) {
    console.error(`Setting the GitHub secret ${name} failed (exit ${result.code}):\n${failureText(result)}`);
    console.error(hint ?? `The Worker and ${file} already hold the value; set the GitHub secret from that file with:\n  gh secret set ${name} --repo ${repo} < ${shellPath(file)}`);
    process.exit(1);
  }
  console.log(`Set the GitHub secret ${name} on ${repo}.`);
}

// A run that was killed between writing the temporary file and renaming it leaves a 0600 file that
// holds a token. Its own leftovers (this exact name pattern, older than five minutes, so another run
// in progress is left alone) are removed before the next write.
async function removeStaleTempFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\.admin-token\.\d+\.\d+\.tmp$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > 300_000) await rm(path, { force: true });
    } catch {
      // gone already, or not ours to remove
    }
  }
}

// Writes the file with mode 0600 from the first byte and swaps it in with a rename, so an old file
// of any mode is never left holding the new value, and a failure part-way never leaves a truncated
// token behind. A symlink at the path is followed, as a plain write would. hint is printed after a
// failure. The rename splits a hard link between the old default place and the token file: the old
// path then keeps the previous token, and previous says what that token is now to the Worker.
async function writeTokenFile(value, hint = '', previous = '') {
  const oldBefore = existingOldTokenFile();
  let tmp;
  try {
    await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    const target = await realpath(TOKEN_FILE).catch(() => TOKEN_FILE);
    await removeStaleTempFiles(dirname(target));
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
  const old = existingOldTokenFile();
  if (!old) return;
  const split = oldBefore
    ? ''
    : ` The two paths were hard links to one file, which this write split, so ${old} now holds the previous token${previous ? `, ${previous}` : ''}.`;
  console.log(`The old token file ${old} still exists and was left as it is (not updated, not deleted); the token file is now ${TOKEN_FILE}, so delete the old one once nothing reads it.${split}`);
}

// The old default place ~/.config/conference-caddie/admin-token when the token file is at a new
// default place (CADDIE_ADMIN_HOME or XDG_CONFIG_HOME) and a different file is still at the old one,
// which this script never changes or deletes; else null. It is asked from the file system each
// time, so a path that leads to the token file through a symbolic link never counts as old.
function existingOldTokenFile() {
  const { legacy } = adminTokenFile(process.env);
  return legacy && existsSync(legacy) ? legacy : null;
}

// A path for a command line the operator will paste: ~ for the home directory, quotes where the
// shell needs them.
function shellPath(file) {
  const quote = (text) => (/^[A-Za-z0-9_.\/@%+=:,-]*$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
  const home = homedir();
  if (file.startsWith(`${home}/`)) return `~/${quote(file.slice(home.length + 1))}`;
  return quote(file);
}

// { value, path, trusted, doubt }: the token in the token file (null when it is missing, empty or
// cannot be read), the file it was read from, and whether that file is trusted (see Env above),
// with doubt naming both paths when it is not. Each file is read once, by adminTokenFileToRead, and
// value is the very contents it compared; a caller reads this once and uses that value throughout.
function readTokenFile() {
  const { path, value, trusted, doubt } = adminTokenFileToRead(process.env);
  if (value) generated.push(value);
  return { value: value || null, path, trusted, doubt };
}

// The end of a refusal over a token file that is not trusted.
const SET_TOKEN_FILE = 'Set ADMIN_TOKEN_FILE to the file that holds this deployment\'s token and run this command again.';

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
// putting a new value there would make the Worker refuse them. So the run stops. The script cannot
// read the Worker's or GitHub's secrets, so it cannot tell where the earlier rotation stopped; what
// it prints is a recipe that is safe wherever it stopped (the token file's value becomes the only
// admin token, everywhere), and only when the token file can be trusted for that: it is trusted
// (see Env above) and holds at least 32 characters. --replace-next is
// the explicit choice to go on rotating anyway, with every hint then saying that the file and the
// GitHub secret may be refused. A put or a set can store its value and still fail (a timeout), so
// no hint after a failed step claims that nothing changed unless that is true either way.
async function rotateAdminToken() {
  const skipGh = options['skip-gh'];
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
    console.log(`Note: ${why}\nDry run: nothing is generated or changed. A real run stops here.`);
    return;
  } else {
    nextExists = names.has(NEXT_NAME);
  }
  // Asked for before anything changes, so an unresolvable repository stops the run early. With
  // --skip-gh it is only for the command that is printed, so it may stay unknown.
  const repo = skipGh ? ((await findGhRepo()).name ?? null) : await ghRepo();
  // The commands that take the token from a file, for the file that holds it: TOKEN_FILE, which this
  // run writes, or, in the recipe below, the file that was read.
  const ghSetFrom = (path) => `gh secret set ${GH_SECRET} --repo ${repo ?? '<owner>/<name>'} < ${shellPath(path)}`;
  const finishingFrom = (path) => `  npx wrangler secret put ADMIN_TOKEN < ${shellPath(path)}\n  npx wrangler secret delete ${NEXT_NAME}`;
  const ghSetFromFile = ghSetFrom(TOKEN_FILE);
  const finishing = finishingFrom(TOKEN_FILE);

  const replacing = nextExists && options['replace-next'];
  if (nextExists && !replacing) {
    const { value: current, path: readFrom, trusted, doubt } = readTokenFile();
    const trustworthy = current !== null && current.length >= 32;
    const why = `${NEXT_NAME} is already set on the Worker, so an earlier rotation was started and not finished, and this run would replace its value. That can lock clients out: `
      + `the token file and ${GH_SECRET} may hold exactly the value that is ${NEXT_NAME} now, and the Worker would stop accepting it (after an earlier run that replaced it and stopped part-way, they may hold a value the Worker no longer accepts already). Nothing was changed.\n`
      + (!trusted
        ? `The safe recipe makes the value in the token file the only admin token, so it is offered only when there is no doubt which file holds this deployment's token, and ${doubt}. ${SET_TOKEN_FILE}`
        : trustworthy
        ? 'This script cannot read the Worker\'s or GitHub\'s secrets, so it cannot tell where the earlier rotation stopped. This recipe is safe wherever it stopped: it makes the value in the token file the only admin token, everywhere. '
          + `Use it if the token file holds the token your clients should use. Run the three commands in this order (the last two from ${WORKER_DIR}), once any running ingest or smoke has finished:\n`
          + `  ${ghSetFrom(readFrom)}\n${finishingFrom(readFrom)}\n`
          + `Then run this command again to start a new rotation. To go on rotating at once instead, run it again with --replace-next, and accept that until that run has been through all three steps the token file and ${GH_SECRET} may hold the old ${NEXT_NAME}, which the Worker then no longer accepts.`
        : `The token file ${readFrom} is missing, empty or shorter than 32 characters, so the safe recipe (make the value in the token file the only admin token) cannot be offered: with a bad file it would make the Worker refuse every admin request. Stop here. `
          + 'Put the value you last set as the admin token back into that file from your own copy, then run this command again. '
          + `If you have no copy, run it again with --replace-next: it makes a new token and saves it in the file and in ${GH_SECRET}, and a client that holds anything else is refused until that run has been through all three steps.`);
    if (!dryRun) {
      console.error(why);
      process.exit(1);
    }
    console.log(`Note: ${why}\nDry run: nothing is generated or changed. A real run stops here.`);
    return;
  }

  if (dryRun) {
    console.log('Dry run: nothing is generated or changed.');
    if (replacing) console.log(`${NEXT_NAME} is already set on the Worker; --replace-next would replace it.`);
    console.log(`Would set ${NEXT_NAME}: npx wrangler secret put ${NEXT_NAME}  (a new value, 32 random bytes as hex, on standard input; the Worker then accepts the old and the new token)`);
    console.log(`Would write the new value to ${TOKEN_FILE}  (mode 0600), only after ${NEXT_NAME} was set`);
    const old = existingOldTokenFile();
    if (old) console.log(`Would leave the old token file ${old} as it is (not updated, not deleted).`);
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
    ? `The put may have gone through before it failed (a timeout, say). If it did, the Worker now has a new ${NEXT_NAME} that is saved nowhere and no longer accepts the old ${NEXT_NAME} that the token file and ${GH_SECRET} may hold, so a client that uses them is refused: run the same command again now, with --replace-next. If it did not, nothing was changed.`
    : `Nothing else was changed: ADMIN_TOKEN, ${TOKEN_FILE} and the GitHub secret ${GH_SECRET} keep their old values and keep working, even if the put went through before it failed (then the Worker holds an ${NEXT_NAME} that is saved nowhere). Run the same command again; if it then says ${NEXT_NAME} is already set, follow the recipe it prints.`);
  await writeTokenFile(token, replacing
    ? `The Worker now accepts a new ${NEXT_NAME} that is saved nowhere. The token file and ${GH_SECRET} may hold the old ${NEXT_NAME}, which the Worker no longer accepts (only the ADMIN_TOKEN is still accepted), so a client that uses them is refused until a run of this command with --replace-next has been through all three steps. Fix the path (ADMIN_TOKEN_FILE, or CADDIE_ADMIN_HOME or XDG_CONFIG_HOME for the default) and run it again.`
    : `The Worker now accepts a new ${NEXT_NAME} that is saved nowhere, and ADMIN_TOKEN, the token file and ${GH_SECRET} are unchanged, so every client keeps working. Fix the path (ADMIN_TOKEN_FILE, or CADDIE_ADMIN_HOME or XDG_CONFIG_HOME for the default) and run the same command again with --replace-next.`,
  'which the Worker refuses once the two finishing commands below have run');
  if (skipGh) {
    console.log(`Skipped the GitHub secret (--skip-gh): ${GH_SECRET} still holds the old token. Run this before the two commands below, or the ingest workflow is refused once ADMIN_TOKEN changes:\n  ${ghSetFromFile}`);
  } else {
    await putGithubSecret(GH_SECRET, token, replacing
      ? `The token file holds the new value. ${GH_SECRET} holds an older one, or the new one if the set went through before it failed. An older one is either the ADMIN_TOKEN, which the Worker still accepts, or the old ${NEXT_NAME} (the earlier rotation had completed its GitHub step), which the Worker no longer accepts, and then the ingest is refused until this command succeeds.\n`
        + `Run this command, and do not run the two finishing commands before it succeeds:\n  ${ghSetFromFile}`
      : `The Worker accepts the new token as ${NEXT_NAME} and ${TOKEN_FILE} holds it; ${GH_SECRET} holds the old token, or the new one if the set went through before it failed, and the Worker accepts either (the old one as ADMIN_TOKEN), so the ingest keeps working for now.\n`
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

// The GitHub secret is set from the token file only when there is no doubt which file holds this
// deployment's token (the file is trusted, see Env above). The old default place may hold another
// deployment's token (CADDIE_ADMIN_HOME keeps a second one apart), of two files with different
// tokens either may be stale, and an old file that cannot be read cannot be compared, so each of
// these stops the run before anything is changed; ADMIN_TOKEN_FILE names the file to use. The file
// is read once, here, and the value set is the value adminTokenFileToRead compared; it is never
// printed.
const syncToken = syncGithubFromFile ? readTokenFile() : null;
if (syncToken && !syncToken.trusted) {
  const why = `ADMIN_TOKEN is set on the Worker and ${GH_SECRET} is not, but ${syncToken.doubt}. ${GH_SECRET} is not set, and nothing was changed. ${SET_TOKEN_FILE}`;
  if (!dryRun) {
    console.error(why);
    process.exit(1);
  }
  console.log(`Note: ${why}\nDry run: nothing is generated or changed. A real run stops here.`);
  process.exit(0);
}

if (dryRun) {
  console.log('Dry run: nothing is generated or changed.');
  for (const name of NAMES) {
    if (!plan.has(name)) continue;
    console.log(`Would set ${name}: npx wrangler secret put ${name}  (value on standard input)`);
    if (name === 'ADMIN_TOKEN') {
      console.log(`Would write ${name} to ${TOKEN_FILE}  (mode 0600)`);
      const old = existingOldTokenFile();
      if (old) console.log(`Would leave the old token file ${old} as it is (not updated, not deleted).`);
      if (!options['skip-gh']) console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${await ghRepo()}  (value on standard input)`);
    }
  }
  if (syncGithubFromFile) console.log(`Would set ${GH_SECRET}: gh secret set ${GH_SECRET} --repo ${await ghRepo()}  (value from ${syncToken.path}, on standard input)`);
  if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
  process.exit(0);
}

if (plan.has('ADMIN_TOKEN') && !options['skip-gh']) await announceRepo();
if (plan.has('ADMIN_TOKEN')) {
  // A plain run replaces an ADMIN_TOKEN that is already there outright, with no overlap: from the
  // put on, a client that holds the old one is refused until the file and the GitHub secret are set.
  const replacesLive = has('ADMIN_TOKEN');
  const token = randomHex(32);
  await putWorkerSecret('ADMIN_TOKEN', token, replacesLive
    ? `If the put did not go through, nothing was changed. If it did (a timeout, say), the Worker's ADMIN_TOKEN is a value that nothing local holds, and the token file and ${GH_SECRET} hold the old one, which the Worker no longer accepts, so every client is refused: run the same command again, which makes, saves and sets a new one.`
    : '');
  await writeTokenFile(token, `The Worker already holds the new ADMIN_TOKEN and nothing local has it${replacesLive ? `; the token file and ${GH_SECRET} hold the old one, which the Worker no longer accepts, so every client is refused until this is fixed` : ''}. Fix the path (ADMIN_TOKEN_FILE, or CADDIE_ADMIN_HOME or XDG_CONFIG_HOME for the default) and run this script with --rotate-admin-token, then run the two commands it prints.`,
    'which is no longer the Worker\'s ADMIN_TOKEN');
  if (!options['skip-gh']) {
    await putGithubSecret(GH_SECRET, token, replacesLive
      ? `The Worker and ${TOKEN_FILE} hold the new ADMIN_TOKEN, but ${GH_SECRET} still holds the old one (or the new one, if the set went through before it failed). The old one is no longer accepted by the Worker, so the ingest workflow is refused until the secret is set:
  gh secret set ${GH_SECRET} --repo ${await ghRepo()} < ${shellPath(TOKEN_FILE)}`
      : undefined);
  }
} else if (syncGithubFromFile) {
  const { value: token, path: readFrom } = syncToken;
  if (token) {
    await announceRepo();
    await putGithubSecret(GH_SECRET, token, undefined, readFrom);
  } else console.error(`ADMIN_TOKEN is set on the Worker but ${readFrom} is missing or empty, so the GitHub secret cannot be set. Rerun without --only-missing to rotate it.`);
}
if (plan.has('REF_SALT')) await putWorkerSecret('REF_SALT', randomHex(32));
if (plan.has('VAPID_PRIVATE_KEY')) {
  const { privateKey, publicKey } = await vapidPair();
  await putWorkerSecret('VAPID_PRIVATE_KEY', privateKey);
  await putWorkerSecret('VAPID_PUBLIC_KEY', publicKey);
}
if (plan.has('BLE_MASTER_KEYRING')) await putWorkerSecret('BLE_MASTER_KEYRING', firstKeyring());
if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
