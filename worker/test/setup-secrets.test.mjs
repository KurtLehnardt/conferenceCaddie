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
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminKeys } from '../src/lib/admin-auth.js';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-secrets.mjs', import.meta.url));
// The rule for where the token file is, which the script imports.
const TOKEN_FILE_HELPER = fileURLToPath(new URL('../ingest/admin-token-file.mjs', import.meta.url));
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
// The script calls \`npx --yes wrangler secret ...\`; the recipe it prints says \`npx wrangler secret ...\`.
const first = args[0] === '--yes' ? 1 : 0;
if (args[first] !== 'wrangler' || at !== first + 1) { process.stderr.write('unexpected npx call\\n'); process.exit(64); }
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
  if (fail.includes('wrangler-put-stored:' + name)) {
    // The value is stored, and the tool still exits 1 (a timeout after the upload).
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(state));
    process.stderr.write('network timeout after uploading ' + input + '\\n');
    process.exit(1);
  }
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
  if (fail.includes('gh-set-stored')) {
    // The value is stored, and the tool still exits 1.
    fs.writeFileSync(path.join(dir, 'gh.json'), JSON.stringify(state));
    process.stderr.write('timeout after setting ' + input + '\\n');
    process.exit(1);
  }
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
  for (const d of [bin, home, stubs, join(repo, 'worker', 'scripts'), join(repo, 'worker', 'ingest')]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, script);
  copyFileSync(TOKEN_FILE_HELPER, join(repo, 'worker', 'ingest', 'admin-token-file.mjs'));
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
    // fail names the switches of the stand-ins: wrangler-put:<NAME> and wrangler-put-stored:<NAME>
    // (the value is stored, then the tool exits 1), wrangler-list-garbage, gh-set and gh-set-stored.
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
    // The repository is worked out best-effort, for the command that is printed.
    assert.ok(r.stdout.includes(`gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ${w.file}`));
    assertNoPartOf(w.token(), r.text, 'the output');
    // When it cannot be worked out, the run still succeeds and the command keeps a placeholder.
    const other = world(t, { origin: 'https://gitlab.com/not/github.git' });
    const r2 = other.run(['--rotate-admin-token', '--skip-gh']);
    assert.equal(r2.status, 0, r2.text);
    assert.ok(r2.stdout.includes(`gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<name> < ${other.file}`));
    // And CADDIE_GH_REPO is used for it when set.
    const set = world(t, { origin: null });
    const r3 = set.run(['--rotate-admin-token', '--skip-gh'], { env: { CADDIE_GH_REPO: 'org/named' } });
    assert.ok(r3.stdout.includes(`gh secret set CADDIE_ADMIN_TOKEN --repo org/named < ${set.file}`));
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
    assert.match(r.stderr, /Nothing else was changed: ADMIN_TOKEN, .* and the GitHub secret CADDIE_ADMIN_TOKEN keep their old values and keep working, even if the put went through before it failed/);
    assert.match(r.stderr, /Run the same command again; if it then says ADMIN_TOKEN_NEXT is already set, follow the recipe it prints\./);
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
    assert.match(r.stderr, /CADDIE_ADMIN_TOKEN holds the old token, or the new one if the set went through before it failed, and the Worker accepts either/);
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
    assert.match(dry.stdout, /Note: ADMIN_TOKEN is not set on the Worker[^\n]*\nDry run: nothing is generated or changed\. A real run stops here\./);
    assert.ok(!dry.stdout.includes('Would set'), 'a dry run that a real run would stop at does not list what it would set');
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

  test('stops without changing anything, and leads with one recipe that makes the token file the only token', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 1);
    assert.deepEqual(verbs(w.calls()), ['wrangler list'], 'nothing was put');
    assert.deepEqual(w.workerState(), inProgress);
    assert.equal(w.token(), NEW1);
    assert.deepEqual(w.githubState(), { CADDIE_ADMIN_TOKEN: NEW1 });
    assert.match(r.stderr, /ADMIN_TOKEN_NEXT is already set on the Worker, so an earlier rotation was started and not finished/);
    assert.match(r.stderr, /would stop accepting it \(after an earlier run that replaced it and stopped part-way, they may hold a value the Worker no longer accepts already\)\. Nothing was changed\./);
    assert.match(r.stderr, /cannot tell where the earlier rotation stopped\. This recipe is safe wherever it stopped: it makes the value in the token file the only admin token, everywhere/);
    // The three commands, in this order, with the resolved repository and the real path, and never the value.
    const recipe = [
      `  gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ${w.file}`,
      `  npx wrangler secret put ADMIN_TOKEN < ${w.file}`,
      '  npx wrangler secret delete ADMIN_TOKEN_NEXT',
    ].join('\n');
    assert.ok(r.stderr.includes(`${recipe}\n`), r.stderr);
    assert.ok(r.stderr.includes('the last two from '), 'the Worker commands are run from worker/');
    // The case list is gone, and --replace-next comes only after the recipe.
    assert.doesNotMatch(r.stderr, /stopped at its|finishing "put" of ADMIN_TOKEN already ran|went through all three steps/);
    assert.ok(r.stderr.indexOf('--replace-next') > r.stderr.indexOf(recipe), '--replace-next is offered after the recipe');
    assertNoPartOf(NEW1, r.text, 'the output');
  });

  test('the dry run notes it and exits 0; with --replace-next it says it would replace', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const dry = w.run(['--rotate-admin-token', '--dry-run']);
    assert.equal(dry.status, 0, dry.text);
    assert.match(dry.stdout, /Note: ADMIN_TOKEN_NEXT is already set on the Worker, so an earlier rotation was started/);
    assert.match(dry.stdout, /Dry run: nothing is generated or changed\. A real run stops here\./);
    assert.ok(!dry.stdout.includes('Would set'), 'a dry run that a real run would stop at does not list what it would set');
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
    assert.match(r.stderr, /holds the old token, or the new one if the set went through before it failed, and the Worker accepts either/);
  });

  test('a token file that is missing, empty or too short gets no recipe: it says to stop, and what to do instead', (t) => {
    for (const [label, content] of [['missing', null], ['empty', ''], ['blank', ' \n'], ['short', 'abc123'], ['31 characters', 'a'.repeat(31)]]) {
      const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: content });
      const r = w.run(['--rotate-admin-token']);
      assert.equal(r.status, 1, label);
      assert.match(r.stderr, /is missing, empty or shorter than 32 characters, so the safe recipe .* cannot be offered/, label);
      assert.match(r.stderr, /Stop here\. Put the value you last set as the admin token back into that file from your own copy, then run this command again\./, label);
      assert.match(r.stderr, /If you have no copy, run it again with --replace-next/, label);
      assert.doesNotMatch(r.text, /gh secret set|secret put ADMIN_TOKEN|secret delete/, `${label}: no command that could do harm is printed`);
      assert.deepEqual(verbs(w.calls()), ['wrangler list'], label);
      assert.deepEqual(w.workerState(), inProgress, label);
      // The dry run says the same and exits 0.
      const dry = w.run(['--rotate-admin-token', '--dry-run']);
      assert.equal(dry.status, 0, label);
      assert.match(dry.stdout, /cannot be offered[\s\S]*A real run stops here\./, label);
    }
    // With --replace-next a missing file is simply written: that is the way out when no copy exists.
    const gone = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: null });
    const ok = gone.run(['--rotate-admin-token', '--replace-next']);
    assert.equal(ok.status, 0, ok.text);
    assert.match(gone.token(), /^[0-9a-f]{64}$/);
  });

  test('the recipe, run as printed, ends with the token file the only token, in every state an earlier rotation can have left', (t) => {
    const N = 'e5'.repeat(32);
    const N0 = 'd4'.repeat(32);
    const N2 = 'c3'.repeat(32);
    const A = OLD_TOKEN;
    const states = {
      '1 the earlier rotation went through all three steps': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N }, file: N, gh: N },
      '2 it stopped at its Worker or file step (the put went through)': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N }, file: A, gh: A },
      '3 it stopped at its GitHub step': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N }, file: N, gh: A },
      '4 the finishing put already ran': { worker: { ADMIN_TOKEN: N, ADMIN_TOKEN_NEXT: N }, file: N, gh: N },
      '5 the finishing put ran and the GitHub secret was never set': { worker: { ADMIN_TOKEN: N, ADMIN_TOKEN_NEXT: N }, file: N, gh: A },
      '6 an earlier --replace-next stopped at its token-file step': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N2 }, file: N, gh: N },
      '7 an earlier --replace-next stopped at its GitHub step': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N2 }, file: N2, gh: N },
      '8 the GitHub secret holds a value of yet another attempt': { worker: { ADMIN_TOKEN: A, ADMIN_TOKEN_NEXT: N }, file: N, gh: N0 },
    };
    for (const [name, state] of Object.entries(states)) {
      const w = world(t, { worker: state.worker, github: { CADDIE_ADMIN_TOKEN: state.gh }, tokenFile: state.file });
      const stopped = w.run(['--rotate-admin-token']);
      assert.equal(stopped.status, 1, name);
      assert.deepEqual([w.workerState(), w.token(), w.githubState().CADDIE_ADMIN_TOKEN], [state.worker, state.file, state.gh], `${name}: the stop changes nothing`);

      // Run the printed commands as an operator would, in order, from worker/, against the stand-ins.
      const commands = stopped.stderr.split('\n').filter((l) => /^ {2}(gh secret set |npx wrangler secret )/.test(l)).map((l) => l.trim());
      assert.equal(commands.length, 3, `${name}: three commands\n${stopped.stderr}`);
      assert.match(commands[0], /^gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt\/conferenceCaddie < /);
      assert.match(commands[1], /^npx wrangler secret put ADMIN_TOKEN < /);
      assert.equal(commands[2], 'npx wrangler secret delete ADMIN_TOKEN_NEXT');
      for (const command of commands) {
        const ran = spawnSync('/bin/sh', ['-c', command], { cwd: join(w.repo, 'worker'), env: { PATH: join(w.dir, 'bin'), HOME: w.home }, encoding: 'utf8' });
        assert.equal(ran.status, 0, `${name}: ${command}\n${ran.stderr}`);
      }

      const worker = w.workerState();
      assert.equal(worker.ADMIN_TOKEN_NEXT, undefined, `${name}: ADMIN_TOKEN_NEXT is gone`);
      assert.equal(worker.ADMIN_TOKEN, state.file, `${name}: the file's value is the ADMIN_TOKEN`);
      assert.equal(w.token(), state.file, `${name}: the file is untouched`);
      assert.equal(w.githubState().CADDIE_ADMIN_TOKEN, state.file, `${name}: the GitHub secret holds the file's value`);
      const keys = adminKeys(worker);
      assert.ok(keys.includes(w.token().trim()), `${name}: the Worker accepts the token file`);
      assert.ok(keys.includes(w.githubState().CADDIE_ADMIN_TOKEN.trim()), `${name}: the Worker accepts the GitHub secret`);
      // Afterwards a new rotation starts normally.
      const again = w.run(['--rotate-admin-token']);
      assert.equal(again.status, 0, `${name}: ${again.text}`);
    }
  });

  test('--replace-next after a put that stored its value and then failed: the hint says it may have gone through, that the old value is refused, and to run again now', (t) => {
    // The earlier rotation went through all three steps, so the file and the GitHub secret hold NEW1, which is ADMIN_TOKEN_NEXT.
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token', '--replace-next'], { fail: ['wrangler-put-stored:ADMIN_TOKEN_NEXT'] });
    assert.equal(r.status, 1);
    // The premise: the put did go through, and the Worker now refuses what the file and GitHub hold.
    const stored = w.workerState().ADMIN_TOKEN_NEXT;
    assert.notEqual(stored, NEW1);
    assert.ok(!adminKeys(w.workerState()).includes(NEW1));
    assert.equal(w.token(), NEW1);
    assert.match(r.stderr, /The put may have gone through before it failed \(a timeout, say\)\. If it did, the Worker now has a new ADMIN_TOKEN_NEXT that is saved nowhere and no longer accepts the old ADMIN_TOKEN_NEXT that the token file and CADDIE_ADMIN_TOKEN may hold, so a client that uses them is refused: run the same command again now, with --replace-next\./);
    assert.doesNotMatch(r.stderr, /Nothing was changed by this run|are as they were/);
    assertNoPartOf(stored, r.text, 'the output');
    // Running it again now does what the hint says: everything is consistent afterwards.
    const again = w.run(['--rotate-admin-token', '--replace-next']);
    assert.equal(again.status, 0, again.text);
    assert.ok(adminKeys(w.workerState()).includes(w.token()));
    assert.ok(adminKeys(w.workerState()).includes(w.githubState().CADDIE_ADMIN_TOKEN));
  });

  test('--replace-next after a GitHub step that was refused earlier says the earlier rotation had completed its GitHub step', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: NEW1 });
    const r = w.run(['--rotate-admin-token', '--replace-next'], { fail: ['gh-set'] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\(the earlier rotation had completed its GitHub step\)/);
    assert.doesNotMatch(r.stderr, /got as far as/);
  });

  test('two separate rotations make two different values', (t) => {
    const first = world(t);
    const second = world(t);
    assert.equal(first.run(['--rotate-admin-token']).status, 0);
    assert.equal(second.run(['--rotate-admin-token']).status, 0);
    const a = first.got('put-ADMIN_TOKEN_NEXT');
    const b = second.got('put-ADMIN_TOKEN_NEXT');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.match(b, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.notEqual(first.token(), second.token());
  });

  test('a leftover temporary token file of a killed run is removed when it is old, and nothing else in the directory is touched', (t) => {
    const w = world(t);
    const dir = join(w.dir, 'secrets');
    const stale = join(dir, '.admin-token.4242.1700000000000.tmp');
    const fresh = join(dir, '.admin-token.4243.1700000000001.tmp');
    const other = join(dir, 'notes.txt');
    writeFileSync(stale, 'x'.repeat(64), { mode: 0o600 });
    writeFileSync(fresh, 'y'.repeat(64), { mode: 0o600 });
    writeFileSync(other, 'keep');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stale, old, old);
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.equal(existsSync(stale), false, 'the old leftover is gone');
    assert.equal(existsSync(fresh), true, 'a recent one, which a run in progress may own, is kept');
    assert.equal(readFileSync(other, 'utf8'), 'keep');
    assert.equal(w.token(), w.got('put-ADMIN_TOKEN_NEXT'));
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
    'the finishing put already ran': { worker: { ADMIN_TOKEN: NEW1, ADMIN_TOKEN_NEXT: NEW1 }, file: NEW1, github: NEW1 },
    'an earlier --replace-next stopped at its token-file step': { worker: { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: 'c3'.repeat(32) }, file: NEW1, github: NEW1 },
  };
  const failures = {
    'no failure': {},
    'the Worker step fails': { fail: ['wrangler-put:ADMIN_TOKEN_NEXT'] },
    'the Worker step stores the value and then fails': { fail: ['wrangler-put-stored:ADMIN_TOKEN_NEXT'] },
    'the token file step fails': { blockFile: true },
    'the GitHub step fails': { fail: ['gh-set'] },
    'the GitHub step stores the value and then fails': { fail: ['gh-set-stored'] },
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
          // The ADMIN_TOKEN is never touched by a rotation.
          assert.equal(worker.ADMIN_TOKEN, state.worker.ADMIN_TOKEN);
          // The invariant.
          const refused = [];
          if (!accepted(worker, fileValue)) refused.push('the token file');
          if (!accepted(worker, githubValue)) refused.push('the GitHub secret');
          if (refused.length) {
            assert.match(out, /no longer accepts/, `${refused.join(' and ')} would be refused by the Worker and the output does not say so\n${out}`);
            // And it never claims that nothing changed, which is not true when a failed step stored its value anyway.
            assert.doesNotMatch(out, /Nothing was changed by this run|are as they were|Nothing else was changed/, `${refused.join(' and ')} are refused but the output says nothing changed\n${out}`);
          }
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
      const credentials = /^https:\/\/[^/@]*@github\.com\//.test(url);
      assert.match(r.stderr, credentials
        ? /CADDIE_GH_REPO is not set and the repository could not be worked out from this clone \(the git remote "origin" holds a user name or password, which this script does not take from a remote; use a plain https or ssh address\)\./
        : /CADDIE_GH_REPO is not set and the repository could not be worked out from this clone \("origin" is not a github\.com address in https or ssh form\)\./, url);
      assert.match(r.stderr, /Set CADDIE_GH_REPO=<owner>\/<name>/);
      for (const part of ['evil.example', 'user:pw', 'gitlab.com', '/srv/o/n', 'user@']) assert.ok(!r.text.includes(part), `${url} echoed ${part}`);
      assert.deepEqual(verbs(w.calls()), ['wrangler list'], `${url}: nothing was put`);
      assert.equal(w.token(), OLD_TOKEN);
    }
  });

  test('each way git can fail has its own words: no origin, not a checkout, no git, a remote with a credential', (t) => {
    const none = world(t, { origin: null });
    const r1 = none.run(['--rotate-admin-token']);
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /\(this clone has no remote named "origin"\)/);
    assert.match(r1.stderr, /Set CADDIE_GH_REPO=<owner>\/<name>/);

    const notGit = world(t, { gitInit: false });
    const r2 = notGit.run(['--rotate-admin-token']);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /\(git cannot read this folder as a checkout: it is not one, or git refuses it because another user owns it\)/);
    assert.doesNotMatch(r2.stderr, /no remote named/);
    assert.deepEqual(verbs(notGit.calls()), ['wrangler list']);

    const noGit = world(t);
    rmSync(join(noGit.dir, 'bin', 'git'));
    const r3 = noGit.run(['--rotate-admin-token']);
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /\(git is not installed\)/);
    assert.doesNotMatch(r3.stderr, /no remote named/);

    const credentialed = world(t, { origin: 'https://x-access-token:ghp_NOTAREALTOKENVALUE@github.com/o/n.git' });
    const r4 = credentialed.run(['--rotate-admin-token']);
    assert.equal(r4.status, 1);
    assert.match(r4.stderr, /holds a user name or password/);
    assert.ok(!r4.text.includes('NOTAREALTOKENVALUE') && !r4.text.includes('x-access-token'), 'the credential is not echoed');
    assert.deepEqual(verbs(credentialed.calls()), ['wrangler list']);
  });

  test('a git environment variable of the caller cannot point the script at another repository', (t) => {
    const w = world(t, { origin: 'https://github.com/good/repo.git' });
    const other = join(w.dir, 'other');
    mkdirSync(other);
    execFileSync(GIT, ['-C', other, 'init', '-q'], { env: { HOME: w.home, PATH: join(w.dir, 'bin') } });
    execFileSync(GIT, ['-C', other, 'remote', 'add', 'origin', 'https://github.com/evil/other.git'], { env: { HOME: w.home, PATH: join(w.dir, 'bin') } });
    const r = w.run(['--rotate-admin-token', '--dry-run'], { env: { GIT_DIR: join(other, '.git'), GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://github.com/evil/inj.git'" } });
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /--repo good\/repo /);
    assert.ok(!r.text.includes('evil'));
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
    for (const bad of ['not a repo', '-x/y', '../..', 'o/..', 'o/.', 'o/n/x', 'o', '/n']) {
      const r = w.run(['--rotate-admin-token'], { env: { CADDIE_GH_REPO: bad } });
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /CADDIE_GH_REPO must look like <owner>\/<name>/, bad);
    }
    assert.deepEqual(putsOf(w), []);
    // A well-formed one, with surrounding spaces, is fine.
    assert.equal(w.run(['--rotate-admin-token', '--dry-run'], { env: { CADDIE_GH_REPO: '  o/n.x_y-z  ' } }).status, 0);
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

describe('setup-secrets.mjs: the plain run and --only-missing', () => {
  test('--only-missing that sets a missing GitHub secret from the token file says where it goes before it sets it', (t) => {
    const w = world(t, { workerSecrets: ALL_NAMES, githubSecrets: [], origin: 'https://github.com/octocat/Hello-World.git', upstream: THIS_REPO_URL });
    const r = w.run(['--only-missing']);
    assert.equal(r.status, 0, r.text);
    const announce = r.stdout.indexOf('The GitHub secret CADDIE_ADMIN_TOKEN goes to octocat/Hello-World (from the git remote "origin").');
    const set = r.stdout.indexOf('Set the GitHub secret CADDIE_ADMIN_TOKEN on octocat/Hello-World.');
    assert.ok(announce >= 0 && set > announce, r.stdout);
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'octocat/Hello-World');
    assert.equal(w.githubState().CADDIE_ADMIN_TOKEN, OLD_TOKEN);
    assert.deepEqual(putsOf(w), ['gh secret set']);
  });

  test('a plain run that replaces the live ADMIN_TOKEN outright says the ingest is refused until the GitHub secret is set', (t) => {
    const w = world(t);
    const r = w.run([], { fail: ['gh-set'] });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN');
    assert.notEqual(w.workerState().ADMIN_TOKEN, OLD_TOKEN, 'the Worker has the new ADMIN_TOKEN');
    assert.equal(w.token(), value);
    assert.ok(!adminKeys(w.workerState()).includes(w.githubState().CADDIE_ADMIN_TOKEN), 'the premise: the GitHub secret is now refused');
    assert.match(r.stderr, /Setting the GitHub secret CADDIE_ADMIN_TOKEN failed/);
    assert.match(r.stderr, /still holds the old one \(or the new one, if the set went through before it failed\)\. The old one is no longer accepted by the Worker, so the ingest workflow is refused until the secret is set:/);
    assert.ok(r.stderr.includes(`  gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ${w.file}`));
    assertNoPartOf(value, r.text, 'the output');
  });

  test('a plain run whose ADMIN_TOKEN put stores its value and then fails says every client is refused, and to run it again', (t) => {
    const w = world(t);
    const r = w.run([], { fail: ['wrangler-put-stored:ADMIN_TOKEN'] });
    assert.equal(r.status, 1);
    const stored = w.workerState().ADMIN_TOKEN;
    assert.notEqual(stored, OLD_TOKEN, 'the premise: the put went through');
    assert.ok(!adminKeys(w.workerState()).includes(w.token()), 'the premise: the token file is now refused');
    assert.match(r.stderr, /If the put did not go through, nothing was changed\. If it did \(a timeout, say\), the Worker's ADMIN_TOKEN is a value that nothing local holds, and the token file and CADDIE_ADMIN_TOKEN hold the old one, which the Worker no longer accepts, so every client is refused: run the same command again/);
    assertNoPartOf(stored, r.text, 'the output');
    // Running it again repairs everything.
    const again = w.run([]);
    assert.equal(again.status, 0, again.text);
    assert.ok(adminKeys(w.workerState()).includes(w.token()));
    assert.ok(adminKeys(w.workerState()).includes(w.githubState().CADDIE_ADMIN_TOKEN));
  });

  test('a plain run whose token file cannot be written says the old file and GitHub secret are refused', (t) => {
    const w = world(t);
    const blocker = join(w.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: join(blocker, 'admin-token') } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The Worker already holds the new ADMIN_TOKEN and nothing local has it; the token file and CADDIE_ADMIN_TOKEN hold the old one, which the Worker no longer accepts, so every client is refused until this is fixed\./);
  });

  test('the first run on a Worker that has no ADMIN_TOKEN yet does not claim that clients are refused', (t) => {
    const w = world(t, { workerSecrets: [], githubSecrets: [] });
    const blocker = join(w.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: join(blocker, 'admin-token') } });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /no longer accepts|every client is refused/);
  });
});

// The token file's default place follows the caddie-admin CLI's config directory
// (worker/ingest/admin-token-file.mjs): ADMIN_TOKEN_FILE, else $CADDIE_ADMIN_HOME/admin-token, else
// ${XDG_CONFIG_HOME:-~/.config}/conference-caddie/admin-token. The old default
// ~/.config/conference-caddie/admin-token (under the scratch HOME here) is never written or deleted.
// Neither the --only-missing GitHub sync nor the recipe for an unfinished rotation uses a token
// file that is not trusted: the fallback to the old file, two files with different tokens, or an
// old file that cannot be read.
describe('setup-secrets.mjs: where the token file is (the caddie-admin config directory)', () => {
  const NEW1 = 'a1'.repeat(32);
  const inProgress = { ADMIN_TOKEN: OLD_TOKEN, ADMIN_TOKEN_NEXT: NEW1, REF_SALT: 'p'.repeat(40) };
  const oldFile = (w) => join(w.home, '.config', 'conference-caddie', 'admin-token');
  function writeOld(w, value) {
    mkdirSync(join(w.home, '.config', 'conference-caddie'), { recursive: true });
    writeFileSync(oldFile(w), value, { mode: 0o600 });
  }
  const quoted = (path) => `'${path.replaceAll("'", "'\\''")}'`;
  // A file at mode 000 can still be read by root, so the tests that need one are skipped only then.
  const asRoot = process.getuid?.() === 0 && 'root can read a file at mode 000';
  // The end of every refusal over a token file that is not trusted.
  const SET_FILE = 'Set ADMIN_TOKEN_FILE to the file that holds this deployment\'s token and run this command again.';
  const syncWhy = (doubt) => `ADMIN_TOKEN is set on the Worker and CADDIE_ADMIN_TOKEN is not, but ${doubt}. CADDIE_ADMIN_TOKEN is not set, and nothing was changed. ${SET_FILE}`;
  const recipeWhy = (doubt) => `The safe recipe makes the value in the token file the only admin token, so it is offered only when there is no doubt which file holds this deployment's token, and ${doubt}. ${SET_FILE}`;
  const fallbackDoubt = (file, old) => `there is no token file at ${file}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, only one at its old place ${old}, which may hold another deployment's token`;
  const differsDoubt = (file, old) => `the token file ${file} and the file at its old place ${old} hold different tokens, so it is not clear which one is this deployment's`;
  const unreadableDoubt = (file, old) => `the file at the old place ${old} of the token file ${file} exists and cannot be read, so it is not clear which one holds this deployment's token`;
  // The new token file under $XDG_CONFIG_HOME, holding value.
  function writeNew(w, value) {
    const xdg = join(w.dir, 'xdg');
    const file = join(xdg, 'conference-caddie', 'admin-token');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, { mode: 0o600 });
    return { env: { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg }, file };
  }
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

  test('a first run writes $XDG_CONFIG_HOME/conference-caddie/admin-token, and nothing under ~/.config', (t) => {
    const w = world(t, { workerSecrets: [], githubSecrets: [], tokenFile: null });
    const xdg = join(w.dir, 'xdg config');
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg } });
    assert.equal(r.status, 0, r.text);
    const file = join(xdg, 'conference-caddie', 'admin-token');
    assert.equal(read(file), w.got('put-ADMIN_TOKEN'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(r.stdout.includes(`Wrote ${file} (mode 0600).`), r.stdout);
    assert.equal(existsSync(join(w.home, '.config')), false);
    assert.doesNotMatch(r.text, /old token file/);
  });

  test('CADDIE_ADMIN_HOME wins over XDG_CONFIG_HOME; a write there leaves the old file as it is and says so in one line', (t) => {
    const w = world(t, { workerSecrets: [], githubSecrets: [], tokenFile: null });
    writeOld(w, OLD_TOKEN);
    const home = join(w.dir, 'caddie home');
    const xdg = join(w.dir, 'xdg');
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: home, XDG_CONFIG_HOME: xdg } });
    assert.equal(r.status, 0, r.text);
    const file = join(home, 'admin-token');
    assert.equal(read(file), w.got('put-ADMIN_TOKEN'));
    assert.equal(existsSync(xdg), false);
    assert.equal(read(oldFile(w)), OLD_TOKEN, 'the old file is neither updated nor deleted');
    const lines = r.stdout.split('\n').filter((l) => l.includes(oldFile(w)));
    assert.deepEqual(lines, [`The old token file ${oldFile(w)} still exists and was left as it is (not updated, not deleted); the token file is now ${file}, so delete the old one once nothing reads it.`]);
    // The dry run says the same, and changes nothing.
    const dry = w.run(['--dry-run'], { env: { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: join(w.dir, 'other'), XDG_CONFIG_HOME: xdg } });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`Would leave the old token file ${oldFile(w)} as it is (not updated, not deleted).`), dry.stdout);
    assert.equal(existsSync(join(w.dir, 'other')), false);
  });

  test('without either variable the token file is the old default, and no old-file line is printed', (t) => {
    const w = world(t, { workerSecrets: [], githubSecrets: [], tokenFile: null });
    writeOld(w, OLD_TOKEN);
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: '' } });
    assert.equal(r.status, 0, r.text);
    assert.equal(read(oldFile(w)), w.got('put-ADMIN_TOKEN'));
    assert.doesNotMatch(r.text, /old token file/);
  });

  test('--rotate-admin-token writes the resolved file and names it, quoted, in the finishing commands', (t) => {
    const w = world(t, { tokenFile: null });
    writeOld(w, OLD_TOKEN);
    const xdg = join(w.dir, "it's xdg");
    const file = join(xdg, 'conference-caddie', 'admin-token');
    const env = { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg };
    const dry = w.run(['--rotate-admin-token', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`Would write the new value to ${file}  (mode 0600)`), dry.stdout);
    assert.ok(dry.stdout.includes(`Would leave the old token file ${oldFile(w)} as it is (not updated, not deleted).`), dry.stdout);
    assert.ok(dry.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < ${quoted(file)}\n`), dry.stdout);

    const r = w.run(['--rotate-admin-token'], { env });
    assert.equal(r.status, 0, r.text);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.equal(read(file), value);
    assert.equal(read(oldFile(w)), OLD_TOKEN, 'the old file is neither updated nor deleted');
    assert.ok(r.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < ${quoted(file)}\n  npx wrangler secret delete ADMIN_TOKEN_NEXT`), r.stdout);
    assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('The old token file ')).length, 1, r.stdout);
    assertNoPartOf(value, r.text, 'the output');
  });

  test('an unfinished rotation with only the old file gets no recipe: the refusal names both paths and not the value', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: null });
    writeOld(w, NEW1);
    const xdg = join(w.dir, 'xdg config');
    const file = join(xdg, 'conference-caddie', 'admin-token');
    const env = { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg };
    const r = w.run(['--rotate-admin-token'], { env });
    assert.equal(r.status, 1);
    assert.deepEqual(verbs(w.calls()), ['wrangler list'], 'nothing was put');
    assert.ok(r.stderr.includes(`Nothing was changed.\n${recipeWhy(fallbackDoubt(file, oldFile(w)))}\n`), r.stderr);
    assert.doesNotMatch(r.text, /Note: the admin token file|gh secret set|secret put ADMIN_TOKEN/, 'no separate note and no recipe');
    const dry = w.run(['--rotate-admin-token', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`${recipeWhy(fallbackDoubt(file, oldFile(w)))}\nDry run: nothing is generated or changed. A real run stops here.\n`), dry.stdout);
    assert.equal(existsSync(xdg), false);
    assertNoPartOf(NEW1, `${r.text}\n${dry.text}`, 'the output');
    // ADMIN_TOKEN_FILE set to the old file is the operator's choice: the recipe names that file.
    const ok = w.run(['--rotate-admin-token'], { env: { ...env, ADMIN_TOKEN_FILE: oldFile(w) } });
    assert.equal(ok.status, 1);
    const recipe = [
      '  gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ~/.config/conference-caddie/admin-token',
      '  npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token',
      '  npx wrangler secret delete ADMIN_TOKEN_NEXT',
    ].join('\n');
    assert.ok(ok.stderr.includes(`${recipe}\n`), ok.stderr);
    assertNoPartOf(NEW1, ok.text, 'the output');
  });

  test('an unfinished rotation with two files that hold different tokens gets no recipe', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: null });
    const NEW2 = 'b4'.repeat(32);
    writeOld(w, NEW1);
    const { env, file } = writeNew(w, `${NEW2}\n`);
    const r = w.run(['--rotate-admin-token'], { env });
    assert.equal(r.status, 1);
    assert.deepEqual(verbs(w.calls()), ['wrangler list'], 'nothing was put');
    assert.ok(r.stderr.includes(`Nothing was changed.\n${recipeWhy(differsDoubt(file, oldFile(w)))}\n`), r.stderr);
    assert.doesNotMatch(r.text, /Note: the admin token file|gh secret set|secret put ADMIN_TOKEN/);
    for (const value of [NEW1, NEW2]) assertNoPartOf(value, r.text, 'the output');
    // With the same token in both, there is no doubt, and the recipe names the new file.
    writeFileSync(oldFile(w), NEW2);
    const ok = w.run(['--rotate-admin-token'], { env });
    assert.equal(ok.status, 1);
    assert.ok(ok.stderr.includes(`  npx wrangler secret put ADMIN_TOKEN < ${file}\n`), ok.stderr);
    assert.doesNotMatch(ok.text, /Note: |old place/);
  });

  test('an unfinished rotation with an old file that cannot be read gets no recipe', { skip: asRoot }, (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: null });
    writeOld(w, NEW1);
    chmodSync(oldFile(w), 0o000);
    const { env, file } = writeNew(w, NEW1);
    const r = w.run(['--rotate-admin-token'], { env });
    assert.equal(r.status, 1);
    assert.deepEqual(verbs(w.calls()), ['wrangler list'], 'nothing was put');
    assert.ok(r.stderr.includes(`Nothing was changed.\n${recipeWhy(unreadableDoubt(file, oldFile(w)))}\n`), r.stderr);
    assert.doesNotMatch(r.text, /Note: the admin token file|gh secret set|secret put ADMIN_TOKEN/);
    assertNoPartOf(NEW1, r.text, 'the output');
  });

  test('with ADMIN_TOKEN_FILE set there is no fallback: a missing file gets no recipe and no note', (t) => {
    const w = world(t, { worker: inProgress, github: { CADDIE_ADMIN_TOKEN: NEW1 }, tokenFile: null });
    writeOld(w, NEW1);
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`The token file ${w.file} is missing, empty or shorter than 32 characters`), r.stderr);
    assert.doesNotMatch(r.text, /Note: the admin token file|gh secret set|secret put ADMIN_TOKEN/);
  });

  test('--only-missing refuses to set a missing GitHub secret from the old file when only it exists, unless ADMIN_TOKEN_FILE names it', (t) => {
    const w = world(t, { workerSecrets: ALL_NAMES, githubSecrets: [], tokenFile: null });
    writeOld(w, NEW1);
    const home = join(w.dir, 'caddie home');
    const env = { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: home };
    const why = syncWhy(fallbackDoubt(join(home, 'admin-token'), oldFile(w)));
    const dry = w.run(['--only-missing', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`Note: ${why}\nDry run: nothing is generated or changed. A real run stops here.\n`), dry.stdout);
    assert.doesNotMatch(dry.stdout, /Would set/);
    const r = w.run(['--only-missing'], { env });
    assert.equal(r.status, 1, r.text);
    assert.ok(r.stderr.includes(`${why}\n`), r.stderr);
    assert.doesNotMatch(r.stderr, /Note: the admin token file/, 'the refusal says it all, in one message');
    assert.deepEqual(putsOf(w), [], 'nothing was put or set');
    assert.deepEqual(w.githubState(), {});
    assert.equal(existsSync(home), false, 'a read never creates the new place');
    assertNoPartOf(NEW1, `${dry.text}\n${r.text}`, 'the output');
    // ADMIN_TOKEN_FILE set to the old file is the operator's choice: the secret is set from it.
    const ok = w.run(['--only-missing'], { env: { ...env, ADMIN_TOKEN_FILE: oldFile(w) } });
    assert.equal(ok.status, 0, ok.text);
    assert.equal(w.githubState().CADDIE_ADMIN_TOKEN, NEW1);
    assert.deepEqual(putsOf(w), ['gh secret set']);
    assertNoPartOf(NEW1, ok.text, 'the output');
  });

  test('--only-missing refuses to set a missing GitHub secret when the token file and the old one hold different tokens', (t) => {
    const w = world(t, { workerSecrets: ALL_NAMES, githubSecrets: [], tokenFile: null });
    const NEW2 = 'b4'.repeat(32);
    writeOld(w, NEW1);
    const xdg = join(w.dir, 'xdg');
    const file = join(xdg, 'conference-caddie', 'admin-token');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${NEW2}\n`, { mode: 0o600 });
    const env = { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg };
    const why = syncWhy(differsDoubt(file, oldFile(w)));
    const dry = w.run(['--only-missing', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`Note: ${why}\n`), dry.stdout);
    const r = w.run(['--only-missing'], { env });
    assert.equal(r.status, 1, r.text);
    assert.equal(r.stderr, `${why}\n`);
    assert.deepEqual(putsOf(w), []);
    for (const value of [NEW1, NEW2]) assertNoPartOf(value, `${dry.text}\n${r.text}`, 'the output');
    // With the same token in both, there is no doubt, and the secret is set from the new file.
    writeFileSync(oldFile(w), NEW2);
    const ok = w.run(['--only-missing'], { env });
    assert.equal(ok.status, 0, ok.text);
    assert.equal(w.githubState().CADDIE_ADMIN_TOKEN, NEW2);
    assert.doesNotMatch(ok.text, /Note: |old place/);
  });

  test('--only-missing refuses to set a missing GitHub secret when the old file exists and cannot be read', { skip: asRoot }, (t) => {
    const w = world(t, { workerSecrets: ALL_NAMES, githubSecrets: [], tokenFile: null });
    writeOld(w, NEW1);
    chmodSync(oldFile(w), 0o000);
    const { env, file } = writeNew(w, NEW1);
    const why = syncWhy(unreadableDoubt(file, oldFile(w)));
    const dry = w.run(['--only-missing', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.ok(dry.stdout.includes(`Note: ${why}\nDry run: nothing is generated or changed. A real run stops here.\n`), dry.stdout);
    assert.doesNotMatch(dry.stdout, /Would set/);
    const r = w.run(['--only-missing'], { env });
    assert.equal(r.status, 1, r.text);
    assert.equal(r.stderr, `${why}\n`);
    assert.deepEqual(putsOf(w), [], 'nothing was put or set');
    assert.deepEqual(w.githubState(), {});
    assertNoPartOf(NEW1, `${dry.text}\n${r.text}`, 'the output');
    // ADMIN_TOKEN_FILE set to the new file is the operator's choice: the secret is set from it.
    const ok = w.run(['--only-missing'], { env: { ...env, ADMIN_TOKEN_FILE: file } });
    assert.equal(ok.status, 0, ok.text);
    assert.equal(w.githubState().CADDIE_ADMIN_TOKEN, NEW1);
  });

  test('a rotation splits a hard link between the old place and the token file, and says the old path keeps the previous token', (t) => {
    const w = world(t, { tokenFile: null });
    const caddie = join(w.dir, 'caddie home');
    const file = join(caddie, 'admin-token');
    mkdirSync(caddie);
    writeFileSync(file, OLD_TOKEN, { mode: 0o600 });
    mkdirSync(dirname(oldFile(w)), { recursive: true });
    linkSync(file, oldFile(w));
    const env = { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: caddie };
    const dry = w.run(['--rotate-admin-token', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.text);
    assert.doesNotMatch(dry.text, /old token file|old place/, 'one file before the write');
    const r = w.run(['--rotate-admin-token'], { env });
    assert.equal(r.status, 0, r.text);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.equal(read(file), value);
    assert.equal(read(oldFile(w)), OLD_TOKEN, 'the old path keeps the previous token');
    const lines = r.stdout.split('\n').filter((l) => l.includes(oldFile(w)));
    assert.deepEqual(lines, [`The old token file ${oldFile(w)} still exists and was left as it is (not updated, not deleted); the token file is now ${file}, so delete the old one once nothing reads it. The two paths were hard links to one file, which this write split, so ${oldFile(w)} now holds the previous token, which the Worker refuses once the two finishing commands below have run.`]);
    assertNoPartOf(value, `${dry.text}\n${r.text}`, 'the output');
  });

  test('a plain run splits a hard link the same way, and says the previous token is no longer the Worker\'s ADMIN_TOKEN', (t) => {
    const w = world(t, { githubSecrets: [], tokenFile: null });
    const caddie = join(w.dir, 'caddie home');
    const file = join(caddie, 'admin-token');
    mkdirSync(caddie);
    writeFileSync(file, OLD_TOKEN, { mode: 0o600 });
    mkdirSync(dirname(oldFile(w)), { recursive: true });
    linkSync(file, oldFile(w));
    const r = w.run([], { env: { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: caddie } });
    assert.equal(r.status, 0, r.text);
    assert.equal(read(file), w.got('put-ADMIN_TOKEN'));
    assert.equal(read(oldFile(w)), OLD_TOKEN);
    assert.ok(r.stdout.includes(`, so ${oldFile(w)} now holds the previous token, which is no longer the Worker's ADMIN_TOKEN.\n`), r.stdout);
  });

  // ~/.config (or ~/.config/conference-caddie) can be a link to the new place, so both paths are
  // one file. Nothing may then call it the old file: deleting it, as that line advises, would
  // delete the live token.
  for (const [name, link] of [
    ['~/.config is a link to $XDG_CONFIG_HOME', (w) => {
      const xdg = join(w.dir, 'xdg');
      mkdirSync(xdg);
      symlinkSync(xdg, join(w.home, '.config'));
      return { env: { ADMIN_TOKEN_FILE: undefined, XDG_CONFIG_HOME: xdg }, file: join(xdg, 'conference-caddie', 'admin-token'), dir: join(xdg, 'conference-caddie') };
    }],
    ['~/.config/conference-caddie is a link to $CADDIE_ADMIN_HOME', (w) => {
      const caddie = join(w.dir, 'caddie home');
      mkdirSync(caddie);
      mkdirSync(join(w.home, '.config'));
      symlinkSync(caddie, join(w.home, '.config', 'conference-caddie'));
      return { env: { ADMIN_TOKEN_FILE: undefined, CADDIE_ADMIN_HOME: caddie }, file: join(caddie, 'admin-token'), dir: caddie };
    }],
  ]) {
    test(`${name}: no old-file line in a dry run or a real run, and the token is written once`, (t) => {
      const w = world(t, { workerSecrets: [], githubSecrets: [], tokenFile: null });
      const { env, file, dir } = link(w);
      const oldLine = /old token file|old place/;
      // Before the token file exists: the linked directory makes the two paths one file.
      const dryFirst = w.run(['--dry-run'], { env });
      assert.equal(dryFirst.status, 0, dryFirst.text);
      assert.ok(dryFirst.stdout.includes(`Would write ADMIN_TOKEN to ${file}  (mode 0600)`), dryFirst.stdout);
      assert.doesNotMatch(dryFirst.text, oldLine);

      const r = w.run([], { env });
      assert.equal(r.status, 0, r.text);
      const value = w.got('put-ADMIN_TOKEN');
      assert.equal(read(file), value);
      assert.equal(read(oldFile(w)), value, 'the old path leads to the same file');
      assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('Wrote ')).length, 1, r.stdout);
      assert.deepEqual(readdirSync(dir), ['admin-token'], 'one file, no copy and no temporary file');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.doesNotMatch(r.text, oldLine);

      // With the file there: a dry run of the plain run and of a rotation.
      const dry = w.run(['--dry-run'], { env });
      assert.equal(dry.status, 0, dry.text);
      assert.doesNotMatch(dry.text, oldLine);
      const dryRotate = w.run(['--rotate-admin-token', '--dry-run'], { env });
      assert.equal(dryRotate.status, 0, dryRotate.text);
      assert.ok(dryRotate.stdout.includes(`Would write the new value to ${file}  (mode 0600)`), dryRotate.stdout);
      assert.doesNotMatch(dryRotate.text, oldLine);
      assertNoPartOf(value, [dryFirst.text, r.text, dry.text, dryRotate.text].join('\n'), 'the output');
    });
  }
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
