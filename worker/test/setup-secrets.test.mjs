// worker/scripts/setup-secrets.mjs: the ADMIN_TOKEN rotation (--rotate-admin-token, W3) and the
// repository it writes the GitHub secret to (W9: CADDIE_GH_REPO, else `gh repo view`).
//
// The script is run as a child process with stand-ins for `npx wrangler` and `gh` that are the only
// commands on its PATH: the real ones can never be reached, and nothing here needs a network, an
// account or a token. The token file is a scratch file (ADMIN_TOKEN_FILE), and HOME is a scratch
// directory too, so the operator's real ~/.config/conference-caddie/admin-token is never read or
// written. The stand-ins record what they were asked and the exact standard input they received;
// the tests then check that the value reached them, in the right order, and never reached the output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-secrets.mjs', import.meta.url));
const OLD_TOKEN = 'f'.repeat(64);
const ALL_NAMES = ['ADMIN_TOKEN', 'REF_SALT', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'BLE_MASTER_KEYRING'];

// `npx wrangler secret list|put|delete`. STUB_FAIL holds comma-separated switches. A failing stand-in
// echoes its standard input to stderr, as a careless tool could, so the script's redaction is tested.
const NPX = `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const fail = (process.env.STUB_FAIL || '').split(',');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ tool: 'npx', args }) + '\\n');
const at = args.indexOf('secret');
const verb = args[at + 1];
const name = args[at + 2];
if (args[0] !== '--yes' || args[1] !== 'wrangler' || at !== 2) { process.stderr.write('unexpected npx call\\n'); process.exit(64); }
if (verb === 'list') { process.stdout.write(fs.readFileSync(dir + '/secret-list.json', 'utf8')); process.exit(0); }
if (verb === 'put') {
  fs.writeFileSync(dir + '/put-' + name, input);
  try { fs.writeFileSync(dir + '/file-at-put-' + name, fs.readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8')); } catch {}
  if (fail.includes('wrangler-put:' + name)) { process.stderr.write('Authentication error for ' + input + '\\n'); process.exit(1); }
  process.stdout.write('Success! Uploaded secret ' + name + '\\n');
  process.exit(0);
}
process.stderr.write('npx stand-in: unexpected secret ' + verb + '\\n');
process.exit(65);
`;

// `gh repo view` and `gh secret list|set`.
const GH = `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const fail = (process.env.STUB_FAIL || '').split(',');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ tool: 'gh', args }) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') {
  if (fail.includes('gh-repo-view')) { process.stderr.write('no git remotes found\\n'); process.exit(1); }
  process.stdout.write((process.env.STUB_GH_REPO || 'KurtLehnardt/conferenceCaddie') + '\\n');
  process.exit(0);
}
if (args[0] === 'secret' && args[1] === 'list') {
  process.stdout.write(fs.readFileSync(dir + '/gh-list.json', 'utf8'));
  process.exit(0);
}
if (args[0] === 'secret' && args[1] === 'set') {
  const name = args[2];
  fs.writeFileSync(dir + '/gh-' + name, input);
  fs.writeFileSync(dir + '/gh-repo-' + name, args[args.indexOf('--repo') + 1] || '');
  try { fs.writeFileSync(dir + '/file-at-gh-' + name, fs.readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8')); } catch {}
  if (fail.includes('gh-set')) { process.stderr.write('HTTP 403 for ' + input + '\\n'); process.exit(1); }
  process.exit(0);
}
process.stderr.write('gh stand-in: unexpected call\\n');
process.exit(65);
`;

// A scratch world: stand-ins, a home directory, a token file path, and the secrets the "Worker" and
// the "repository" already hold.
function world(t, { workerSecrets = ALL_NAMES, githubSecrets = ['CADDIE_ADMIN_TOKEN'], tokenFile = OLD_TOKEN, tokenFileMode = 0o644 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const stubs = join(dir, 'stubs');
  for (const d of [bin, home, stubs]) mkdirSync(d, { recursive: true });
  for (const [name, source] of [['npx', NPX], ['gh', GH]]) {
    writeFileSync(join(bin, name), source, { mode: 0o755 });
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(stubs, 'secret-list.json'), JSON.stringify(workerSecrets.map((name) => ({ name, type: 'secret_text' }))));
  writeFileSync(join(stubs, 'gh-list.json'), JSON.stringify(githubSecrets.map((name) => ({ name }))));
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
    // Runs the script. env overrides the child's environment; a key set to undefined is removed.
    run(args, env = {}) {
      const childEnv = { PATH: bin, HOME: home, STUB_DIR: stubs, ADMIN_TOKEN_FILE: file, ...env };
      for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: childEnv, encoding: 'utf8', timeout: 60_000 });
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
  };
  return w;
}

const verbs = (calls) => calls.map((c) => (c.tool === 'npx' ? `wrangler ${c.args[3]}${c.args[3] === 'list' ? '' : ` ${c.args[4]}`}` : `gh ${c.args.slice(0, 2).join(' ')}`));

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
    // Read-only calls only: no put, no delete, no gh secret set.
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view']);
    assert.deepEqual([w.token(), statSync(w.file).mode & 0o777, statSync(w.file).mtimeMs], [before.content, before.mode, before.mtime]);
    assert.deepEqual(readdirSync(join(w.dir, 'secrets')), ['admin-token']);
    assert.equal(w.got('put-ADMIN_TOKEN_NEXT'), null);
  });

  test('with the default token file the commands read ~/.config/conference-caddie/admin-token, and the file is not created', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--dry-run'], { ADMIN_TOKEN_FILE: undefined });
    assert.equal(r.status, 0, r.text);
    assert.ok(r.stdout.includes('  npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token\n'));
    assert.ok(r.stdout.includes('  npx wrangler secret delete ADMIN_TOKEN_NEXT'));
    assert.ok(r.stdout.includes(`Would write the new value to ${join(w.home, '.config', 'conference-caddie', 'admin-token')}`));
    assert.equal(existsSync(join(w.home, '.config')), false);
  });

  test('a path that needs quoting is quoted in the printed commands', (t) => {
    const w = world(t);
    const odd = join(w.dir, 'my secrets', "it's here");
    const r = w.run(['--rotate-admin-token', '--dry-run'], { ADMIN_TOKEN_FILE: odd });
    assert.equal(r.status, 0, r.text);
    assert.ok(r.stdout.includes(`  npx wrangler secret put ADMIN_TOKEN < '${odd.replaceAll("'", "'\\''")}'\n`), r.stdout);
    assert.equal(existsSync(join(w.dir, 'my secrets')), false);
  });

  test('--skip-gh leaves the GitHub secret out and never calls gh', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--dry-run', '--skip-gh']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /Would leave the GitHub secret CADDIE_ADMIN_TOKEN alone \(--skip-gh\)/);
    assert.ok(!w.calls().some((c) => c.tool === 'gh'));
  });

  test('an unreadable secret list is only noted in a dry run', (t) => {
    const w = world(t);
    writeFileSync(join(w.stubs, 'secret-list.json'), 'not json');
    const r = w.run(['--rotate-admin-token', '--dry-run']);
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
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view', 'wrangler put ADMIN_TOKEN_NEXT', 'gh secret set']);
    assert.equal(w.got('put-ADMIN_TOKEN'), null, 'ADMIN_TOKEN itself is not replaced');
    for (const other of ALL_NAMES.slice(1)) assert.equal(w.got(`put-${other}`), null, `${other} is not touched`);

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

  test('creates the file, and its directory, when there was none', (t) => {
    const w = world(t, { tokenFile: null });
    const file = join(w.dir, 'new', 'deeper', 'admin-token');
    const r = w.run(['--rotate-admin-token'], { ADMIN_TOKEN_FILE: file });
    assert.equal(r.status, 0, r.text);
    assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), w.got('put-ADMIN_TOKEN_NEXT'));
  });

  test('every run makes a new value', (t) => {
    const w = world(t);
    assert.equal(w.run(['--rotate-admin-token']).status, 0);
    const first = w.got('put-ADMIN_TOKEN_NEXT');
    assert.equal(w.run(['--rotate-admin-token']).status, 0);
    assert.notEqual(w.got('put-ADMIN_TOKEN_NEXT'), first);
    assert.equal(w.token(), w.got('put-ADMIN_TOKEN_NEXT'));
  });

  test('an earlier unfinished rotation is noted and replaced', (t) => {
    const w = world(t, { workerSecrets: [...ALL_NAMES, 'ADMIN_TOKEN_NEXT'] });
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.stdout, /ADMIN_TOKEN_NEXT is already set on the Worker \(an earlier rotation was not finished\); this run replaces it/);
    assert.match(w.got('put-ADMIN_TOKEN_NEXT'), /^[0-9a-f]{64}$/);
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
    const r = w.run(['--rotate-admin-token'], { STUB_FAIL: 'wrangler-put:ADMIN_TOKEN_NEXT' });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/, 'the tool did receive a value');
    assert.equal(w.token(), OLD_TOKEN, 'the token file was not touched');
    assert.equal(statSync(w.file).mode & 0o777, 0o644);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view', 'wrangler put ADMIN_TOKEN_NEXT'], 'the GitHub secret was not touched');
    assert.match(r.stderr, /Setting ADMIN_TOKEN_NEXT on the Worker failed \(exit 1\)/);
    assert.match(r.stderr, /\[redacted\]/);
    assert.match(r.stderr, /Nothing else was changed: ADMIN_TOKEN, .* and the GitHub secret CADDIE_ADMIN_TOKEN keep their old values and keep working\. Run the same command again/);
    assertNoPartOf(value, r.text, 'the output');
    assert.ok(!r.stdout.includes('ADMIN_TOKEN < '), 'no finishing commands after a failure');
  });

  test('a token file failure after the Worker put says the new value is saved nowhere and that every client still works', (t) => {
    const w = world(t);
    // The parent of the token file is a regular file, so it can be neither created nor written.
    const blocker = join(w.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const r = w.run(['--rotate-admin-token'], { ADMIN_TOKEN_FILE: join(blocker, 'admin-token') });
    assert.equal(r.status, 1);
    const value = w.got('put-ADMIN_TOKEN_NEXT');
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view', 'wrangler put ADMIN_TOKEN_NEXT'], 'the GitHub secret was not touched');
    assert.match(r.stderr, /Writing .*admin-token failed \(/);
    assert.match(r.stderr, /accepts a new ADMIN_TOKEN_NEXT that is saved nowhere/);
    assert.match(r.stderr, /every client keeps working/);
    assert.match(r.stderr, /run the same command again; it replaces ADMIN_TOKEN_NEXT/);
    assertNoPartOf(value, r.text, 'the output');
  });

  test('a GitHub failure after the file was written prints the one command that finishes that step, and holds back the finishing commands', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { STUB_FAIL: 'gh-set' });
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
    writeFileSync(join(w.stubs, 'secret-list.json'), 'not json');
    const r = w.run(['--rotate-admin-token']);
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

describe('setup-secrets.mjs keeps ignoring ADMIN_TOKEN_NEXT', () => {
  test('--only-missing with every name present sets nothing and never touches ADMIN_TOKEN_NEXT, whether it exists or not', (t) => {
    for (const workerSecrets of [[...ALL_NAMES, 'ADMIN_TOKEN_NEXT'], ALL_NAMES]) {
      const w = world(t, { workerSecrets });
      const r = w.run(['--only-missing']);
      assert.equal(r.status, 0, r.text);
      assert.match(r.stdout, /Nothing to set\./);
      assert.ok(!r.text.includes('ADMIN_TOKEN_NEXT'));
      assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view', 'gh secret list']);
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
  test('CADDIE_GH_REPO unset: asks gh which repository this clone is, and uses the answer', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { STUB_GH_REPO: 'someone/their-fork' });
    assert.equal(r.status, 0, r.text);
    const view = w.calls().find((c) => c.tool === 'gh' && c.args[0] === 'repo');
    assert.deepEqual(view.args, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'someone/their-fork');
    assert.match(r.stdout, /Set the GitHub secret CADDIE_ADMIN_TOKEN on someone\/their-fork\./);
  });

  test('this repository: gh says KurtLehnardt/conferenceCaddie, so the live target is unchanged', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token']);
    assert.equal(r.status, 0, r.text);
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'KurtLehnardt/conferenceCaddie');
  });

  test('CADDIE_GH_REPO set: used as it is, and gh repo view is not asked', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { CADDIE_GH_REPO: 'org/other-name', STUB_GH_REPO: 'wrong/one' });
    assert.equal(r.status, 0, r.text);
    assert.ok(!w.calls().some((c) => c.args[0] === 'repo'));
    assert.equal(w.got('gh-repo-CADDIE_ADMIN_TOKEN'), 'org/other-name');
  });

  test('neither the variable nor gh can say: fails naming CADDIE_GH_REPO before anything is changed', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { STUB_FAIL: 'gh-repo-view' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CADDIE_GH_REPO is not set and gh could not tell which repository this clone belongs to/);
    assert.match(r.stderr, /Set CADDIE_GH_REPO=<owner>\/<name>/);
    assert.deepEqual(verbs(w.calls()), ['wrangler list', 'gh repo view'], 'no secret was put anywhere');
    assert.equal(w.token(), OLD_TOKEN);
    // The same for a dry run, which names the variable too.
    assert.equal(w.run(['--rotate-admin-token', '--dry-run'], { STUB_FAIL: 'gh-repo-view' }).status, 1);
  });

  test('a malformed CADDIE_GH_REPO is refused (exit 2)', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token'], { CADDIE_GH_REPO: 'not a repo' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CADDIE_GH_REPO must look like <owner>\/<name>/);
    assert.deepEqual(w.calls().filter((c) => c.args.includes('put')), []);
  });

  test('--skip-gh needs no repository at all', (t) => {
    const w = world(t);
    const r = w.run(['--rotate-admin-token', '--skip-gh'], { STUB_FAIL: 'gh-repo-view' });
    assert.equal(r.status, 0, r.text);
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
