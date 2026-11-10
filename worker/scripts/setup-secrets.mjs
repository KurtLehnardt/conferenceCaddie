#!/usr/bin/env node
// Generates the Worker's secrets and installs them without ever showing a value.
//
// Usage, from anywhere in the repository, after `bash worker/scripts/deploy.sh`:
//   node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]
//
// Secrets:
//   ADMIN_TOKEN        32 random bytes as hex. Opens the /admin routes (ingest, migration, smoke
//                      fixtures, moderation). Also stored with `gh secret set ADMIN_TOKEN` for the
//                      ingest workflow and in ~/.config/conference-caddie/admin-token (mode 0600,
//                      outside the repository) for the smoke, migration and moderation runs.
//   REF_SALT           32 random bytes as hex. Salts every person's public ref. Changing it changes
//                      every ref, so an existing REF_SALT is only replaced with --rotate-ref-salt.
//   VAPID_PRIVATE_KEY  The base64url 32-byte P-256 private scalar for Web Push.
//   VAPID_PUBLIC_KEY   The base64url 65-byte uncompressed public point. It is not secret (every
//                      browser receives it) but is stored as a secret so the pair stays together.
//                      The two VAPID keys are always set together, from one generated pair.
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
//                       the GitHub secret is set from that file.
//   --dry-run           Print the names that would be set and the commands that would receive
//                       them, and change nothing.
//   --rotate-ref-salt   Allow replacing an existing REF_SALT (every ref changes).
//   --skip-gh           Do not touch the GitHub repository secret.
// Env: ADMIN_TOKEN_FILE (default ~/.config/conference-caddie/admin-token, the file the smoke,
//      migration and moderation scripts read); CADDIE_GH_REPO (default
//      KurtLehnardt/conferenceCaddie); CLOUDFLARE_API_TOKEN and
//      CLOUDFLARE_ACCOUNT_ID are read by wrangler itself.

import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = process.env.ADMIN_TOKEN_FILE || join(homedir(), '.config', 'conference-caddie', 'admin-token');
const GH_REPO = process.env.CADDIE_GH_REPO || 'KurtLehnardt/conferenceCaddie';
const NAMES = ['ADMIN_TOKEN', 'REF_SALT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'];

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      'only-missing': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'rotate-ref-salt': { type: 'boolean', default: false },
      'skip-gh': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (err) {
  console.error(err.message);
  console.error('Usage: node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]');
  process.exit(2);
}
if (options.help) {
  console.log('Usage: node worker/scripts/setup-secrets.mjs [--only-missing] [--dry-run] [--rotate-ref-salt] [--skip-gh]');
  console.log(`Sets ${NAMES.join(', ')} on the Worker through wrangler's standard input; prints names only.`);
  process.exit(0);
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

async function githubSecretNames() {
  const result = await run('gh', ['secret', 'list', '--repo', GH_REPO, '--json', 'name'], { cwd: WORKER_DIR });
  if (result.code !== 0) return null;
  try {
    return new Set(JSON.parse(result.stdout).map((s) => s?.name).filter(Boolean));
  } catch {
    return null;
  }
}

async function putWorkerSecret(name, value) {
  const result = await run('npx', ['--yes', 'wrangler', 'secret', 'put', name], { input: value });
  if (result.code !== 0) {
    console.error(`Setting ${name} on the Worker failed (exit ${result.code}):\n${failureText(result)}`);
    process.exit(1);
  }
  console.log(`Set ${name} on the Worker.`);
}

async function putGithubSecret(name, value) {
  const result = await run('gh', ['secret', 'set', name, '--repo', GH_REPO], { input: value });
  if (result.code !== 0) {
    console.error(`Setting the GitHub secret ${name} failed (exit ${result.code}):\n${failureText(result)}`);
    console.error(`The Worker and ${TOKEN_FILE} already hold the new value; rerun with --only-missing to retry the GitHub secret from that file.`);
    process.exit(1);
  }
  console.log(`Set the GitHub secret ${name} on ${GH_REPO}.`);
}

async function writeTokenFile(value) {
  await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, value, { mode: 0o600 });
  // writeFile keeps the mode of an existing file, so set it explicitly.
  await chmod(TOKEN_FILE, 0o600);
  console.log(`Wrote ${TOKEN_FILE} (mode 0600).`);
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
  if (ghNames && !ghNames.has('ADMIN_TOKEN')) syncGithubFromFile = true;
}

if (dryRun) {
  console.log('Dry run: nothing is generated or changed.');
  for (const name of NAMES) {
    if (!plan.has(name)) continue;
    console.log(`Would set ${name}: npx wrangler secret put ${name}  (value on standard input)`);
    if (name === 'ADMIN_TOKEN') {
      console.log(`Would write ${name} to ${TOKEN_FILE}  (mode 0600)`);
      if (!options['skip-gh']) console.log(`Would set ${name}: gh secret set ${name} --repo ${GH_REPO}  (value on standard input)`);
    }
  }
  if (syncGithubFromFile) console.log(`Would set ADMIN_TOKEN: gh secret set ADMIN_TOKEN --repo ${GH_REPO}  (value from ${TOKEN_FILE}, on standard input)`);
  if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
  process.exit(0);
}

if (plan.has('ADMIN_TOKEN')) {
  const token = randomHex(32);
  await putWorkerSecret('ADMIN_TOKEN', token);
  await writeTokenFile(token);
  if (!options['skip-gh']) await putGithubSecret('ADMIN_TOKEN', token);
} else if (syncGithubFromFile) {
  const token = await readTokenFile();
  if (token) await putGithubSecret('ADMIN_TOKEN', token);
  else console.error(`ADMIN_TOKEN is set on the Worker but ${TOKEN_FILE} is missing, so the GitHub secret cannot be set. Rerun without --only-missing to rotate it.`);
}
if (plan.has('REF_SALT')) await putWorkerSecret('REF_SALT', randomHex(32));
if (plan.has('VAPID_PRIVATE_KEY')) {
  const { privateKey, publicKey } = await vapidPair();
  await putWorkerSecret('VAPID_PRIVATE_KEY', privateKey);
  await putWorkerSecret('VAPID_PUBLIC_KEY', publicKey);
}
if (!plan.size && !syncGithubFromFile) console.log('Nothing to set.');
