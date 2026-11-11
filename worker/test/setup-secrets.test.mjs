// worker/scripts/setup-secrets.mjs: the ADMIN_TOKEN rotation (--rotate-admin-token and
// --replace-next, W3), the repository it writes the GitHub secret to (W9: CADDIE_GH_REPO, else the
// git remote "origin"), and the environment each child process gets.
//
// The script is run as a child process, from a copy in a scratch git checkout, with stateful
// stand-ins for `npx wrangler` and `gh` as the only commands on its PATH (plus a link to the real
// git, which only reads the scratch checkout's remotes): the real wrangler and gh can never be
// reached, and nothing here needs a network, an account or a token. The token file is a scratch file
// (ADMIN_TOKEN_FILE) and HOME is a scratch directory too, so the operator's real
// ~/.config/conference-caddie/admin-token is never read or written. The stand-ins keep the Worker's
// secrets and the repository's secrets in files, record what they were asked and the exact standard
// input they received, and read their switches from files next to them, not from the environment
// (the script passes its children no variable the tools do not need).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminKeys } from '../src/lib/admin-auth.js';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-secrets.mjs', import.meta.url));
const OLD_TOKEN = 'f'.repeat(64);
const ALL_NAMES = ['ADMIN_TOKEN', 'REF_SALT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'BLE_MASTER_KEYRING'];
const THIS_REPO_URL = 'https://github.com/KurtLehnardt/conferenceCaddie.git';
const GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// `npx --yes wrangler secret list|put|delete`, over the state in worker.json.
const NPX = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(path.dirname(fs.realpathSync(process.argv[1])), '..', 'stubs');
const read = (f, d) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return d; } };
const args = process.argv.slice(2);
const fail = read('fail', '').split(',');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ tool: 'npx', args }) + '\\n');
fs.writeFileSync(path.join(dir, 'env-npx'), Object.keys(process.env).sort().join('\\n'));
const at = args.indexOf('secret');
const verb = args[at + 1];
const name = args[at + 2];
if (args[0] !== '--yes' || args[1] !== 'wrangler' || at !== 2) { process.stderr.write('unexpected npx call\\n'); process.exit(64); }
const state = JSON.parse(read('worker.json', '{}'));
if (verb === 'list') {
  if (fail.includes('wrangler-list-garbage')) { process.stdout.write('not json'); process.exit(0); }
  process.stdout.write(JSON.stringify(Object.keys(state).map((n) => ({ name: n, type: 'secret_text' }))));
  process.exit(0);
}
if (verb === 'put') {
  fs.writeFileSync(path.join(dir, 'put-' + name), input);
  try { fs.writeFileSync(path.join(dir, 'file-at-put-' + name), fs.readFileSync(read('token-file', ''), 'utf8')); } catch {}
  if (fail.includes('wrangler-put:' + name)) { process.stderr.write('Authentication error for ' + input + '\\n'); process.exit(1); }
  state[name] = input;
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(state));
  process.stdout.write('Success! Uploaded secret ' + name + '\\n');
  process.exit(0);
}
if (verb === 'delete') {
  delete state[name];
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(state));
  process.exit(0);
}
process.stderr.write('npx stand-in: unexpected secret ' + verb + '\\n');
process.exit(65);
`;

// `gh secret list|set`, over the state in gh.json. `gh repo view` is never expected: it is recorded
// and fails, so a test can show the script does not ask.
const GH = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(path.dirname(fs.realpathSync(process.argv[1])), '..', 'stubs');
const read = (f, d) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return d; } };
const args = process.argv.slice(2);
const fail = read('fail', '').split(',');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ tool: 'gh', args }) + '\\n');
fs.writeFileSync(path.join(dir, 'env-gh'), Object.keys(process.env).sort().join('\\n'));
const state = JSON.parse(read('gh.json', '{}'));
if (args[0] === 'secret' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(Object.keys(state).map((n) => ({ name: n }))));
  process.exit(0);
}
if (args[0] === 'secret' && args[1] === 'set') {
  const name = args[2];
  fs.writeFileSync(path.join(dir, 'gh-' + name), input);
  fs.writeFileSync(path.join(dir, 'gh-repo-' + name), args[args.indexOf('--repo') + 1] || '');
  try { fs.writeFileSync(path.join(dir, 'file-at-gh-' + name), fs.readFileSync(read('token-file', ''), 'utf8')); } catch {}
  if (fail.includes('gh-set')) { process.stderr.write('HTTP 403 for ' + input + '\\n'); process.exit(1); }
  state[name] = input;
  fs.writeFileSync(path.join(dir, 'gh.json'), JSON.stringify(state));
  process.exit(0);
}
process.stderr.write('gh stand-in: unexpected call ' + args.slice(0, 2).join(' ') + '\\n');
process.exit(65);
`;

const placeholder = (name) => (name === 'ADMIN_TOKEN' ? OLD_TOKEN : name === 'ADMIN_TOKEN_NEXT' ? 'n'.repeat(64) : 'p'.repeat(40));

// A scratch world: the stand-ins, a home directory, a token file, a git checkout with the script in
// worker/scripts/ (and the remotes asked for), and the secrets the "Worker" and the "repository"
// already hold. workerSecrets and githubSecrets are names (with placeholder values); worker and
// github are name-to-value objects.
function world(t, {
  workerSecrets = ALL_NAMES, worker = null, githubSecrets = ['CADDIE_ADMIN_TOKEN'], github = null,
  tokenFile = OLD_TOKEN, tokenFileMode = 0o644, origin = THIS_REPO_URL, upstream = null, gitInit = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const stubs = join(dir, 'stubs');
  const repo = join(dir, 'repo');
  const script = join(repo, 'worker', 'scripts', 'setup-secrets.mjs');
  for (const d of [bin, home, stubs, join(repo, 'worker', 'scripts')]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, script);
  for (const [name, source] of [['npx', NPX], ['gh', GH]]) {
    writeFileSync(join(bin, name), source, { mode: 0o755 });
    chmodSync(join(bin, name), 0o755);
  }
  symlinkSync(GIT, join(bin, 'git'));
  if (gitInit) {
    const git = (...args) => execFileSync(GIT, ['-C', repo, ...args], { env: { HOME: home, PATH: bin }, stdio: 'pipe' });
    git('init', '-q');
    if (origin) git('remote', 'add', 'origin', origin);
    if (upstream) git('remote', 'add', 'upstream', upstream);
  }
  writeFileSync(join(stubs, 'worker.json'), JSON.stringify(worker ?? Object.fromEntries(workerSecrets.map((n) => [n, placeholder(n)]))));
  writeFileSync(join(stubs, 'gh.json'), JSON.stringify(github ?? Object.fromEntries(githubSecrets.map((n) => [n, OLD_TOKEN]))));
  const file = join(dir, 'secrets', 'admin-token');
  if (tokenFile !== null) {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(file, tokenFile, { mode: tokenFileMode });
    chmodSync(file, tokenFileMode);
  }
  const w = {
    dir,
    home,
    stubs,
    file,
    repo,
    // Runs the script. env overrides the child's environment (a key set to undefined is removed);
    // fail names the switches of the stand-ins: wrangler-put:<NAME>, wrangler-list-garbage, gh-set.
    run(args, { env = {}, fail = [] } = {}) {
      const childEnv = { PATH: bin, HOME: home, ADMIN_TOKEN_FILE: file, ...env };
      for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
      writeFileSync(join(stubs, 'fail'), fail.join(','));
      writeFileSync(join(stubs, 'token-file'), childEnv.ADMIN_TOKEN_FILE ?? file);
      const r = spawnSync(process.execPath, [script, ...args], { env: childEnv, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: `${r.stdout}\n${r.stderr}` };
    },
    calls() {
      const path = join(stubs, 'calls.log');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    // What a stand-in received on standard input, or null when it was never asked.
    got(name) {
      const path = join(stubs, name);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    token() {
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    workerState: () => JSON.parse(readFileSync(join(stubs, 'worker.json'), 'utf8')),
    githubState: () => JSON.parse(readFileSync(join(stubs, 'gh.json'), 'utf8')),
    env: (tool) => readFileSync(join(stubs, `env-${tool}`), 'utf8').split('\n'),
  };
  return w;
}

const verbs = (calls) => calls.map((c) => (c.tool === 'npx' ? `wrangler ${c.args[3]}${c.args[3] === 'list' ? '' : ` ${c.args[4]}`}` : `gh ${c.args.slice(0, 2).join(' ')}`));
const putsOf = (w) => verbs(w.calls()).filter((v) => v.startsWith('wrangler put') || v.startsWith('gh secret set'));

// No part of the value: not the value itself, and none of its 8-character windows.
function assertNoPartOf(value, text, what) {
  assert.ok(!text.includes(value), `${what} holds the whole value`);
  for (let i = 0; i + 8 <= value.length; i++) assert.ok(!text.includes(value.slice(i, i + 8)), `${what} holds a part of the value (offset ${i})`);
}

describe('setup-secrets.mjs --rotate-admin-token --dry-run', () => {
  test('names ADMIN_TOKEN_NEXT, the file, the GitHub secret and the two follow-up commands, and changes nothing', (t) => {
    const w = world(t);
    const before = { content: w.token(), mode: statSync(w.file).mode & 0o777, mtime: statSync(w.file).mtimeMs };
    const r = w.run(['--rotate-admin-token', '--dry-run']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /Dry run: nothing is generated or changed/);
    assert.match(r.stdout, /Would set ADMIN_TOKEN_NEXT: npx wrangler secret put ADMIN_TOKEN_NEXT/);
    assert.ok(r.stdout.includes(`Would write the new value to ${w.file}  (mode 0600)`));
    assert.match(r.stdout, /Would set CADDIE_ADMIN_TOKEN: gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt\/conferenceCaddie/);
    assert.ok(r.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < ${w.file}\n`), 'the first follow-up command');
    assert.ok(r.stdout.trimEnd().endsWith('  npx wrangler secret delete ADMIN_TOKEN_NEXT'), 'the second follow-up command');
    // Read-only calls only: no put, no delete, no gh secret set, and gh is not asked about the repository.
    assert.deepEqual(verbs(w.calls()), ['wrangler list']);
    assert.deepEqual([w.token(), statSync(w.file).mode & 0o777, statSync(w.file).mtimeMs], [before.content, before.mode, before.mtime]);
    assert.deepEqual(readdirSync(join(w.dir, 'secrets')), ['admin-token']);
    assert.equal(w.got('put-ADMIN_TOKEN_NEXT'), null);
  });

  test('with the default token file the commands read ~/.config/conference-caddie/admin-token, and the file is not created', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--dry-run'], { env: { ADMIN_TOKEN_FILE: undefined } });
    assert.equal(r.status, 0, r.text);
    assert.ok(r.stdout.includes('  npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token\n'));
    assert.ok(r.stdout.includes('  npx wrangler secret delete ADMIN_TOKEN_NEXT'));
    assert.ok(r.stdout.includes(`Would write the new value to ${join(w.home, '.config', 'conference-caddie', 'admin-token')}`));
    assert.equal(existsSync(join(w.home, '.config')), false);
  });

  test('a path that needs quoting is quoted in the printed commands', (t) => {
    const w = world(t);
    const odd = join(w.dir, 'my secrets', "it's here");
    const r = w.run(['--rotate-admin-token', '--dry-run'], { env: { ADMIN_TOKEN_FILE: odd } });
    assert.equal(r.status, 0, r.text);
    assert.ok(r.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < '${odd.replaceAll("'", "'\\''")}'\n`), r.stdout);
    assert.equal(existsSync(join(w.dir, 'my secrets')), false);
  });

  test('--skip-gh leaves the GitHub secret out and never calls gh', (t) => {
    const w = world(t, { origin: null });
    const r = w.run(['--rotate-admin-token', '--dry-run', '--skip-gh']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /Would leave the GitHub secret CADDIE_ADMIN_TOKEN alone \(--skip-gh\)/);
    assert.ok(!w.calls().some((c) => c.tool === 'gh'));
  });

  test('an unreadable secret list is only noted in a dry run', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--dry-run'], { fail: ['wrangler-list-garbage'] });
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /cannot check that ADMIN_TOKEN is set/);
    assert.match(r.stdout, /npx wrangler secret delete ADMIN_TOKEN_NEXT/);
  });
});

describe('setup-secrets.mjs --rotate-admin-token', () => {
  test('puts a 64-hex value as ADMIN_TOKEN_NEXT, then writes it to the file with mode 0600 and to the GitHub secret, and never prints any of it', (t) => {
    const w = world(t, { tokenFileMode: 0o644 });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);

    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/, 'exactly 64 lowercase hex characters, no trailing newline');
    assert.equal(w.token(), value, 'the token file holds the value, with no newline');
    assert.equal(statSync(w.file).mode & 0o777, 0o600, 'the file replaced a 0644 one and is 0600');
    assert.equal(w.got('gh-CADDIE_ADMIN_TOKEN'), value, 'the GitHub secret holds the value');
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'KurtLehnardt/conferenceCaddie');
    assert.notEqual(value, OLD_TOKEN);

    // Order: the Worker first (the file still held the old token then), the file next (it held the
    // new one when gh ran), nothing else touched.
    assert.equal(w.got('file-at-put-ADMIN_TOKEN_NEXT'), OLD_TOKEN);
    assert.equal(w.got('file-at-gh-CADDIE_ADMIN_TOKEN'), value);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'wrangler put ADMIN_TOKEN_NEXT', 'gh secret set']);
    assert.equal(w.got('put-ADMIN_TOKEN'), null, 'ADMIN_TOKEN itself is not replaced');
    for (const other of ALL_NAMES.slice(1)) assert.equal(w.got(`put-${other}`), null, `${other} is not touched`);
    assert.deepEqual(w.workerState().ADMIN_TOKEN, OLD_TOKEN);

    // The output names things and never shows the value, in whole or in part.
    assertNoPartOf(value, r.text, 'the output');
    assertNoPartOf(OLD_TOKEN, r.text, 'the output (old value)');
    assert.match(r.stdout, /Set ADMIN_TOKEN_NEXT on the Worker\./);
    assert.ok(r.stdout.includes(`Wrote ${w.file} (mode 0600).`));
    assert.match(r.stdout, /Set the GitHub secret CADDIE_ADMIN_TOKEN on KurtLehnardt\/conferenceCaddie\./);
    assert.ok(r.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < ${w.file}\n  npx wrangler secret delete ADMIN_TOKEN_NEXT\n`));
    // Neither finishing command was run.
    assert.ok(!w.calls().some((c) => c.args.includes('delete')));
    // No temporary file is left next to the token file.
    assert.deepEqual(readdirSync(join(w.dir, 'secrets')), ['admin-token']);
  });

  test('says where the GitHub secret goes before the first change', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    const announce = r.stdout.indexOf('The GitHub secret CADDIE_ADMIN_TOKEN goes to KurtLehnardt/conferenceCaddie (from the git remote "origin").');
    assert.ok(announce >= 0, r.stdout);
    assert.ok(announce < r.stdout.indexOf('Set ADMIN_TOKEN_NEXT on the Worker.'));
  });

  test('creates the file, and its directory, when there was none', (t) => {
    const w = world(t, { tokenFile: null });
    const file = join(w.dir, 'new', 'deeper', 'admin-token');
    const r = w.run(['--rotate-admin-token'], { env: { ADMIN_TOKEN_FILE: file } });
    assert.equal(r.status, 0, r.text);
    assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), w.got('put-ADMIN_TOKEN_NEXT'));
  });

  test('--skip-gh leaves the GitHub secret alone, never calls gh, and says how to set it', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--skip-gh']);
    assert.equal(r.status, 0, r.text);
    assert.ok(!w.calls().some((c) => c.tool === 'gh'));
    assert.equal(w.token(), w.got('put-ADMIN_TOKEN_NEXT'));
    assert.match(r.stdout, /Skipped the GitHub secret \(--skip-gh\)/);
    assert.ok(r.stdout.includes(`gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<name> < ${w.file}`));
    assertNoPartOf(w.token(), r.text, 'the output');
  });

  test('a Worker failure changes nothing, redacts what the tool echoed, and says to rerun', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { fail: ['wrangler-put:ADMIN_TOKEN_NEXT'] });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/, 'the tool did receive a value');
    assert.equal(w.token(), OLD_TOKEN, 'the token file was not touched');
    assert.equal(statSync(w.file).mode & 0o777, 0o644);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'wrangler put ADMIN_TOKEN_NEXT'], 'the GitHub secret was not touched');
    assert.match(r.stderr, /Setting ADMIN_TOKEN_NEXT on the Worker failed \(exit 1\)/);
    assert.match(r.stderr, /\[redacted\]/);
    assert.match(r.stderr, /Nothing else was changed: ADMIN_TOKEN, .* and the GitHub secret CADDIE_ADMIN_TOKEN keep their old values and keep working\. Run the same command again/);
    assert.match(r.stderr, /if it then says ADMIN_TOKEN_NEXT is already set .* run it with --replace-next/);
    assertNoPartOf(value, r.text, 'the output');
    assert.ok(!r.stdout.includes('ADMIN_TOKEN < '), 'no finishing commands after a failure');
  });

  test('a token file failure after the Worker put says the new value is saved nowhere, that every client still works, and to rerun with --replace-next', (t) => {
    const w = world(t);
    // The parent of the token file is a regular file, so it can be neither created nor written.
    const blocker = join(w.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const r = w.run(['--rotate-admin-token'], { env: { ADMIN_TOKEN_FILE: join(blocker, 'admin-token') } });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'wrangler put ADMIN_TOKEN_NEXT'], 'the GitHub secret was not touched');
    assert.match(r.stderr, /Writing .*admin-token failed \(/);
    assert.match(r.stderr, /accepts a new ADMIN_TOKEN_NEXT that is saved nowhere/);
    assert.match(r.stderr, /every client keeps working/);
    assert.match(r.stderr, /run the same command again with --replace-next/);
    assertNoPartOf(value, r.text, 'the output');
  });

  test('a GitHub failure after the file was written prints the one command that finishes that step, and holds back the finishing commands', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { fail: ['gh-set'] });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.equal(w.token(), value, 'the file already holds the new value');
    assert.match(r.stderr, /Setting the GitHub secret CADDIE_ADMIN_TOKEN failed \(exit 1\)/);
    assert.match(r.stderr, /\[redacted\]/);
    assert.match(r.stderr, /CADDIE_ADMIN_TOKEN still holds the old token, which the Worker still accepts as ADMIN_TOKEN/);
    assert.ok(r.stderr.includes(`  gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ${w.file}`));
    assert.match(r.stderr, /do not run the two finishing commands before it succeeds/);
    assert.ok(!r.stdout.includes('secret delete ADMIN_TOKEN_NEXT'), 'the finishing commands are not offered after a failure');
    assertNoPartOf(value, r.text, 'the output');
  });

  test('without an ADMIN_TOKEN on the Worker there is nothing to rotate: refused before anything changes', (t) => {
    const w = world(t, { workerSecrets: ['REF_SALT'] });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ADMIN_TOKEN is not set on the Worker, so there is nothing to rotate/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list']);
    assert.equal(w.token(), OLD_TOKEN);
    // The dry run reports it and still exits 0.
    const dry = w.run(['--rotate-admin-token', '--dry-run']);
    assert.equal(dry.status, 0, dry.text);
    assert.match(dry.stdout, /Note: ADMIN_TOKEN is not set on the Worker.* A real run stops here\./);
  });

  test('an unreadable secret list stops a real run', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { fail: ['wrangler-list-garbage'] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not read the Worker's secret list/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list']);
  });

  test('cannot be combined with --only-missing or --rotate-ref-salt (exit 2, nothing called)', (t) => {
    const w = world(t);
    for (const other of ['--only-missing', '--rotate-ref-salt']) {
      const r = w.run(['--rotate-admin-token', other]);
      assert.equal(r.status, 2, other);
      assert.match(r.stderr, /cannot be combined with --only-missing or --rotate-ref-salt/);
    }
    assert.deepEqual(w.calls(), []);
  });
});

// An ADMIN_TOKEN_NEXT that is already on the Worker means a rotation was started. Replacing its value
// would make the Worker refuse a token file and a GitHub secret that may hold it, so the run stops
// unless --replace-next says to go on.
describe('setup-secrets.mjs --rotate-admin-token with an ADMIN_TOKEN_NEXT already on the Worker', () => {
  const NEW1 = 'a1'.repeat(32);
  const inProgress = { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: NEW1, REF_SALT: 'p'.repeat(40) };

  test('stops without changing anything, and explains how to tell where the earlier rotation stopped', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 1);
    assert.deepEqual(verbs(w.calls()), ['wrangler list'], 'nothing was put');
    assert.deepEqual(w.workerState(), inProgress);
    assert.equal(w.token(), NEW1);
    assert.deepEqual(w.githubState(), { CADDIE_ADMIN_TOKEN: NEW1 });
    assert.match(r.stderr, /ADMIN_TOKEN_NEXT is already set on the Worker, so an earlier rotation was started and not finished/);
    assert.match(r.stderr, /would stop accepting it\. Nothing was changed\./);
    assert.ok(r.stderr.includes(`      npx wrangler secret put ADMIN_TOKEN < ${w.file}\n      npx wrangler secret delete ADMIN_TOKEN_NEXT`), 'the case where it finished: the two finishing commands');
    assert.match(r.stderr, /finishing "put" of ADMIN_TOKEN already ran: only  npx wrangler secret delete ADMIN_TOKEN_NEXT  is left/);
    assert.ok(r.stderr.includes(`stopped at its GitHub step`) && r.stderr.includes(`gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ${w.file}`));
    assert.match(r.stderr, /stopped at its Worker step or its token-file step .* run this command again with --replace-next/);
    assertNoPartOf(NEW1, r.text, 'the output');
  });

  test('the dry run notes it and exits 0; with --replace-next it says it would replace', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const dry = w.run(['--rotate-admin-token', '--dry-run']);
    assert.equal(dry.status, 0, dry.text);
    assert.match(dry.stdout, /Note: ADMIN_TOKEN_NEXT is already set on the Worker, so an earlier rotation was started/);
    assert.match(dry.stdout, /A real run stops here\./);
    const replace = w.run(['--rotate-admin-token', '--dry-run', '--replace-next']);
    assert.equal(replace.status, 0, replace.text);
    assert.match(replace.stdout, /--replace-next would replace it/);
    assert.ok(!replace.stdout.includes('A real run stops here'));
    assert.deepEqual(verbs(w.calls()).filter((v) => v !== 'wrangler list'), []);
    assert.deepEqual(w.workerState(), inProgress);
  });

  test('--replace-next goes on, says up front that the file and the GitHub secret may be refused for a while, and completes', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token', '--replace-next']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /--replace-next replaces it\. From the Worker step on, the token file and CADDIE_ADMIN_TOKEN may hold the old ADMIN_TOKEN_NEXT, which the Worker then no longer accepts/);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.notEqual(value, NEW1);
    assert.equal(w.token(), value);
    assert.deepEqual(w.githubState(), { CADDIE_ADMIN_TOKEN: value });
    assert.equal(w.workerState().ADMIN_TOKEN_NEXT, value);
    assert.equal(w.workerState().ADMIN_TOKEN, OLD_TOKEN, 'ADMIN_TOKEN is untouched');
    assertNoPartOf(value, r.text, 'the output');
  });

  test('--replace-next is refused with --skip-gh and without --rotate-admin-token (exit 2, nothing called)', (t) => {
    const w = world(t, { worker: inProgress, tokenFile: NEW1 });
    const skip = w.run(['--rotate-admin-token', '--replace-next', '--skip-gh']);
    assert.equal(skip.status, 2);
    assert.match(skip.stderr, /--replace-next cannot be combined with --skip-gh/);
    const alone = w.run(['--replace-next']);
    assert.equal(alone.status, 2);
    assert.match(alone.stderr, /--replace-next goes with --rotate-admin-token/);
    assert.deepEqual(w.calls(), []);
  });

  test('without --skip-gh and without --replace-next, --skip-gh does not get around the stop', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token', '--skip-gh']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /an earlier rotation was started and not finished/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list']);
    assert.equal(w.token(), NEW1);
  });

  test('--replace-next with no ADMIN_TOKEN_NEXT on the Worker is an ordinary rotation, with the ordinary hints', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--replace-next'], { fail: ['gh-set'] });
    assert.equal(r.status, 1);
    assert.ok(!r.text.includes('--replace-next replaces it'));
    assert.match(r.stderr, /still holds the old token, which the Worker still accepts as ADMIN_TOKEN/);
  });
});

// The invariant behind the stop: after every step, and after every failure, the token file and the
// GitHub secret hold a value the Worker accepts (adminKeys, the Worker's own function: ADMIN_TOKEN
// and ADMIN_TOKEN_NEXT, trimmed, at least 32 characters), or the output says in so many words that
// the Worker no longer accepts them. And the output never claims that clients keep working when
// they do not.
describe('setup-secrets.mjs --rotate-admin-token: what the Worker accepts after every failure point', () => {
  const NEW1 = 'b2'.repeat(32);
  const states = {
    'no rotation in progress': { worker: { ADMIN_TOKEN: OLD_TOKEN, REF_SALT: 'p'.repeat(40) }, file: OLD_TOKEN, github: OLD_TOKEN },
    'the earlier rotation went through all three steps': { worker: { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: NEW1 }, file: NEW1, github: NEW1 },
    'the earlier rotation stopped at its Worker or file step': { worker: { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: NEW1 }, file: OLD_TOKEN, github: OLD_TOKEN },
    'the earlier rotation stopped at its GitHub step': { worker: { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: NEW1 }, file: NEW1, github: OLD_TOKEN },
  };
  const failures = {
    'no failure': {},
    'the Worker step fails': { fail: ['wrangler-put:ADMIN_TOKEN_NEXT'] },
    'the token file step fails': { blockFile: true },
    'the GitHub step fails': { fail: ['gh-set'] },
  };
  const accepted = (worker, value) => value !== null && adminKeys(worker).includes(String(value).trim());

  for (const [stateName, state] of Object.entries(states)) {
    for (const replace of [false, true]) {
      for (const [failName, failure] of Object.entries(failures)) {
        test(`${stateName}, ${replace ? 'with' : 'without'} --replace-next, ${failName}`, (t) => {
          const w = world(t, { worker: state.worker, github: { CADDIE_ADMIN_TOKEN: state.github }, tokenFile: state.file });
          const env = {};
          if (failure.blockFile) {
            const blocker = join(w.dir, 'blocker');
            writeFileSync(blocker, 'x');
            env.ADMIN_TOKEN_FILE = join(blocker, 'admin-token');
          }
          const r = w.run(['--rotate-admin-token', ...(replace ? ['--replace-next'] : [])], { env, fail: failure.fail ?? [] });
          const worker = w.workerState();
          const fileValue = w.token(); // the operator's token file: it stays where it was when the write was blocked
          const githubValue = w.githubState().CADDIE_ADMIN_TOKEN;
          const out = r.text;
          const stoppedAtTheGuard = state.worker.ADMIN_TOKEN_NEXT !== undefined && !replace;

          if (stoppedAtTheGuard) {
            assert.equal(r.status, 1);
            assert.deepEqual([worker, fileValue, githubValue], [state.worker, state.file, state.github], 'a stopped run changes nothing');
          }
          // The old ADMIN_TOKEN is never touched by a rotation.
          assert.equal(worker.ADMIN_TOKEN, OLD_TOKEN);
          // The invariant.
          const refused = [];
          if (!accepted(worker, fileValue)) refused.push('the token file');
          if (!accepted(worker, githubValue)) refused.push('the GitHub secret');
          if (refused.length) assert.match(out, /no longer accepts/, `${refused.join(' and ')} would be refused by the Worker and the output does not say so\n${out}`);
          // And what the output claims about working clients is true.
          if (/keeps? working|keep their old values and keep working/.test(out)) assert.deepEqual(refused, [], `the output says clients keep working, but ${refused.join(' and ')} are refused\n${out}`);
          // Without a rotation in progress and with no --replace-next, every failure point is safe without any warning.
          if (state.worker.ADMIN_TOKEN_NEXT === undefined) assert.deepEqual(refused, [], `${failName}: ${refused.join(' and ')} refused`);
          // A full success ends with both holding the new value, which the Worker accepts as ADMIN_TOKEN_NEXT.
          if (r.status === 0) {
            assert.equal(fileValue, worker.ADMIN_TOKEN_NEXT);
            assert.equal(githubValue, worker.ADMIN_TOKEN_NEXT);
            assert.match(fileValue, /^[0-9a-f]{64}$/);
            assert.deepEqual(refused, []);
          }
          // After the two finishing commands the new value is the ADMIN_TOKEN and the old one is gone.
          if (r.status === 0) {
            const finished = { ...worker, ADMIN_TOKEN: fileValue };
            delete finished.ADMIN_TOKEN_NEXT;
            assert.ok(accepted(finished, fileValue) && accepted(finished, githubValue));
            assert.ok(!accepted(finished, OLD_TOKEN));
          }
        });
      }
    }
  }
});

describe('setup-secrets.mjs keeps ignoring ADMIN_TOKEN_NEXT', () => {
  test('--only-missing with every name present sets nothing and never touches ADMIN_TOKEN_NEXT, whether it exists or not', (t) => {
    for (const workerSecrets of [[...ALL_NAMES, 'ADMIN_TOKEN_NEXT'], ALL_NAMES]) {
      const w = world(t, { workerSecrets });
      const r = w.run(['--only-missing']);
      assert.equal(r.status, 0, r.text);
      assert.match(r.stdout, /Nothing to set\./);
      assert.ok(!r.text.includes('ADMIN_TOKEN_NEXT'));
      assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh secret list']);
      assert.equal(w.token(), OLD_TOKEN);
    }
  });

  test('--only-missing sets only what is missing, and not ADMIN_TOKEN_NEXT, when the Worker has a stale or half-finished rotation', (t) => {
    // ADMIN_TOKEN_NEXT present, REF_SALT missing: only REF_SALT is set.
    const w = world(t, { workerSecrets: ['ADMIN_TOKEN', 'ADMIN_TOKEN_NEXT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'BLE_MASTER_KEYRING'] });
    const r = w.run(['--only-missing']);
    assert.equal(r.status, 0, r.text);
    assert.deepEqual(verbs(w.calls()).filter((v) => v.startsWith('wrangler put')), ['wrangler put REF_SALT']);
  });

  test('a run without --rotate-admin-token never plans ADMIN_TOKEN_NEXT', (t) => {
    const w = world(t, { workerSecrets: [] });
    const r = w.run(['--dry-run']);
    assert.equal(r.status, 0, r.text);
    for (const name of ALL_NAMES) assert.ok(r.stdout.includes(`Would set ${name}:`), name);
    assert.ok(!r.stdout.includes('ADMIN_TOKEN_NEXT'));
  });
});

describe('setup-secrets.mjs: the repository of the GitHub secret (W9)', () => {
  test('CADDIE_GH_REPO unset: the github.com repository the git remote "origin" names, and gh is not asked', (t) => {
    const w = world(t, { origin: 'https://github.com/someone/their-fork.git' });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.ok(!w.calls().some((c) => c.args[0] === 'repo'), 'gh repo view is never asked');
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'someone/their-fork');
    assert.match(r.stdout, /Set the GitHub secret CADDIE_ADMIN_TOKEN on someone\/their-fork\./);
  });

  test('a fork clone (origin is the fork, upstream is the original) resolves to the fork, never the original', (t) => {
    const w = world(t, { origin: 'https://github.com/octocat/Hello-World.git', upstream: THIS_REPO_URL });
    const dry = w.run(['--rotate-admin-token', '--dry-run']);
    assert.equal(dry.status, 0, dry.text);
    assert.match(dry.stdout, /gh secret set CADDIE_ADMIN_TOKEN --repo octocat\/Hello-World /);
    assert.ok(!dry.text.includes('KurtLehnardt'));
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'octocat/Hello-World');
    assert.deepEqual(Object.keys(w.githubState()), ['CADDIE_ADMIN_TOKEN']);
  });

  test('this repository: origin is KurtLehnardt/conferenceCaddie, so the live target is unchanged', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'KurtLehnardt/conferenceCaddie');
  });

  test('https and ssh forms of a github.com remote, with and without .git', (t) => {
    for (const url of [
      'https://github.com/o-w_n/n.a_m-e.git', 'https://github.com/o-w_n/n.a_m-e', 'https://github.com/o-w_n/n.a_m-e/',
      'git@github.com:o-w_n/n.a_m-e.git', 'git@github.com:o-w_n/n.a_m-e', 'ssh://git@github.com/o-w_n/n.a_m-e.git', 'ssh://git@github.com/o-w_n/n.a_m-e',
      'https://GitHub.com/o-w_n/n.a_m-e.git',
    ]) {
      const w = world(t, { origin: url });
      const r = w.run(['--rotate-admin-token', '--dry-run']);
      assert.equal(r.status, 0, `${url}\n${r.text}`);
      assert.match(r.stdout, /--repo o-w_n\/n\.a_m-e /, url);
    }
    // A name that itself ends in .github.io keeps it; only one .git is dropped.
    const w = world(t, { origin: 'https://github.com/octo/octo.github.io.git' });
    assert.match(w.run(['--rotate-admin-token', '--dry-run']).stdout, /--repo octo\/octo\.github\.io /);
  });

  test('anything else is refused, naming CADDIE_GH_REPO, before anything is changed, without echoing the remote', (t) => {
    for (const url of [
      'https://gitlab.com/o/n.git', 'git@gitlab.com:o/n.git', 'https://github.com.evil.example/o/n', 'https://evil.example/github.com/o/n',
      'https://user@github.com/o/n', 'https://user:pw@github.com/o/n.git', 'http://github.com/o/n', 'git://github.com/o/n.git',
      'https://github.com/o/n/extra', 'https://github.com/o', 'https://github.com/', 'git@github.com:o/n/x.git', 'ssh://git@github.com:22/o/n.git',
      'ssh://other@github.com/o/n.git', 'https://github.com/o/..', 'https://github.com/-o/n', 'https://github.com/o/n?x=1', 'file:///srv/o/n', '/srv/o/n',
    ]) {
      const w = world(t, { origin: url });
      const r = w.run(['--rotate-admin-token']);
      assert.equal(r.status, 1, `${url}\n${r.text}`);
      assert.match(r.stderr, /CADDIE_GH_REPO is not set and the repository could not be worked out from this clone \("origin" is not a github\.com address in https or ssh form\)\./, url);
      assert.match(r.stderr, /Set CADDIE_GH_REPO=<owner>\/<name>/);
      for (const part of ['evil.example', 'user:pw', 'gitlab.com', '/srv/o/n']) assert.ok(!r.text.includes(part), `${url} echoed ${part}`);
      assert.deepEqual(verbs(w.calls()), ['wrangler list'], `${url}: nothing was put`);
      assert.equal(w.token(), OLD_TOKEN);
    }
  });

  test('no origin remote, or no git checkout at all: refused the same way', (t) => {
    const none = world(t, { origin: null });
    const r1 = none.run(['--rotate-admin-token']);
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /this clone has no remote named "origin"/);
    assert.match(r1.stderr, /CADDIE_GH_REPO/);
    const notGit = world(t, { gitInit: false });
    const r2 = notGit.run(['--rotate-admin-token']);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /CADDIE_GH_REPO is not set and the repository could not be worked out/);
    assert.deepEqual(verbs(notGit.calls()), ['wrangler list']);
  });

  test('CADDIE_GH_REPO set: used as it is, over origin, and gh repo view is not asked', (t) => {
    const w = world(t, { origin: 'https://gitlab.com/not/github.git' });
    const r = w.run(['--rotate-admin-token'], { env: { CADDIE_GH_REPO: 'org/other-name' } });
    assert.equal(r.status, 0, r.text);
    assert.ok(!w.calls().some((c) => c.args[0] === 'repo'));
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'org/other-name');
    assert.match(r.stdout, /goes to org\/other-name \(from CADDIE_GH_REPO\)\./);
  });

  test('a malformed CADDIE_GH_REPO is refused (exit 2)', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { env: { CADDIE_GH_REPO: 'not a repo' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CADDIE_GH_REPO must look like <owner>\/<name>/);
    assert.deepEqual(putsOf(w), []);
  });

  test('--skip-gh needs no repository at all', (t) => {
    const w = world(t, { origin: 'https://gitlab.com/not/github.git' });
    const r = w.run(['--rotate-admin-token', '--skip-gh']);
    assert.equal(r.status, 0, r.text);
  });

  test('the normal run resolves the repository before the first Worker put, and prints it', (t) => {
    // Nothing is on the Worker yet, so a normal run would put ADMIN_TOKEN, write the file and set the secret.
    const bad = world(t, { workerSecrets: [], origin: 'https://gitlab.com/not/github.git' });
    const r = bad.run([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CADDIE_GH_REPO is not set/);
    assert.deepEqual(verbs(bad.calls()), ['wrangler list'], 'no secret was put before the failure');
    assert.equal(bad.token(), OLD_TOKEN, 'the token file was not written');

    const good = world(t, { workerSecrets: [], origin: 'https://github.com/octocat/Hello-World.git', upstream: THIS_REPO_URL });
    const ok = good.run([]);
    assert.equal(ok.status, 0, ok.text);
    const announce = ok.stdout.indexOf('The GitHub secret CADDIE_ADMIN_TOKEN goes to octocat/Hello-World (from the git remote "origin").');
    assert.ok(announce >= 0 && announce < ok.stdout.indexOf('Set ADMIN_TOKEN on the Worker.'), ok.stdout);
    assert.equal(good.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'octocat/Hello-World');
    for (const name of ALL_NAMES) assert.match(good.got(`put-${name}`), /\S/, name);
  });

  test('the normal run with --skip-gh needs no repository and calls no gh', (t) => {
    const w = world(t, { workerSecrets: [], origin: 'https://gitlab.com/not/github.git' });
    const r = w.run(['--skip-gh']);
    assert.equal(r.status, 0, r.text);
    assert.ok(!w.calls().some((c) => c.tool === 'gh'));
  });
});

describe('setup-secrets.mjs gives each child only the environment it needs', () => {
  test('wrangler gets the Cloudflare settings and no GitHub token; gh gets the GitHub settings and no Cloudflare token; neither gets an unrelated variable', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], {
      env: {
        CLOUDFLARE_API_TOKEN: 'dummy-cloudflare-value', CLOUDFLARE_ACCOUNT_ID: 'dummy-account', WRANGLER_SEND_METRICS: 'false',
        GH_TOKEN: 'dummy-gh-value', GITHUB_TOKEN: 'dummy-github-value', GH_HOST: 'github.com',
        UNRELATED_SECRET: 'dummy-unrelated', AWS_SECRET_ACCESS_KEY: 'dummy-aws', LC_ALL: 'C', XDG_CONFIG_HOME: join(w.home, '.config'), HTTPS_PROXY: 'http://127.0.0.1:9',
      },
    });
    assert.equal(r.status, 0, r.text);
    const npx = w.env('npx');
    const gh = w.env('gh');
    for (const name of ['PATH', 'HOME', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_SEND_METRICS', 'LC_ALL', 'XDG_CONFIG_HOME', 'HTTPS_PROXY']) assert.ok(npx.includes(name), `wrangler needs ${name}`);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'UNRELATED_SECRET', 'AWS_SECRET_ACCESS_KEY', 'ADMIN_TOKEN_FILE']) assert.ok(!npx.includes(name), `wrangler must not get ${name}`);
    for (const name of ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'LC_ALL', 'XDG_CONFIG_HOME', 'HTTPS_PROXY']) assert.ok(gh.includes(name), `gh needs ${name}`);
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_SEND_METRICS', 'UNRELATED_SECRET', 'AWS_SECRET_ACCESS_KEY', 'ADMIN_TOKEN_FILE']) assert.ok(!gh.includes(name), `gh must not get ${name}`);
    assert.ok(!r.text.includes('dummy-'), 'no value is printed');
  });
});

describe('worker/scripts/dev-vars.mjs sets ADMIN_TEST_ROUTES=1 for a local run (W5)', () => {
  // The script writes <its directory>/../.dev.vars, so it is run from a copy in a scratch tree.
  function copy(t) {
    const dir = mkdtempSync(join(tmpdir(), 'caddie-devvars-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'dev-vars.mjs'), readFileSync(fileURLToPath(new URL('../scripts/dev-vars.mjs', import.meta.url))));
    return dir;
  }
  const run = (dir, ...args) => spawnSync(process.execPath, [join(dir, 'scripts', 'dev-vars.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const vars = (dir) => Object.fromEntries(readFileSync(join(dir, '.dev.vars'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  test('a new file has ADMIN_TEST_ROUTES=1 (mode 0600), and only its name is printed', (t) => {
    const dir = copy(t);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(vars(dir).ADMIN_TEST_ROUTES, '1');
    assert.equal(statSync(join(dir, '.dev.vars')).mode & 0o777, 0o600);
    assert.match(r.stdout, /ADMIN_TEST_ROUTES/);
    assert.ok(!r.stdout.includes(vars(dir).ADMIN_TOKEN));
  });

  test('an existing file without it gains it and keeps its token; one that sets another value keeps that', (t) => {
    const dir = copy(t);
    writeFileSync(join(dir, '.dev.vars'), `ADMIN_TOKEN=${'a'.repeat(64)}\n`, { mode: 0o600 });
    assert.equal(run(dir).status, 0);
    assert.deepEqual([vars(dir).ADMIN_TOKEN, vars(dir).ADMIN_TEST_ROUTES], ['a'.repeat(64), '1']);
    assert.equal(run(dir, '--set', 'ADMIN_TEST_ROUTES=0').status, 0);
    assert.equal(vars(dir).ADMIN_TEST_ROUTES, '0');
    assert.equal(run(dir).status, 0);
    assert.equal(vars(dir).ADMIN_TEST_ROUTES, '0', 'a value that is already there is kept');
  });

  test('wrangler.toml does not set it, so a deployed Worker has the fixtures off', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.ok(!/^\s*ADMIN_TEST_ROUTES\s*=/m.test(toml));
  });
});
