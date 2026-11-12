// worker/ingest/admin-token-file.mjs and readAdminToken in worker/ingest/lib.mjs: where the Worker's
// admin token file is (the caddie-admin CLI's config directory, configDir in
// scripts/admin/config.mjs) and the fallback to the old default ~/.config/conference-caddie/admin-token.
//
// Every home directory, config directory and token file here is a scratch directory, passed in
// explicitly (or, for the child process, through HOME and the variables), so the operator's real
// ~/.config/conference-caddie/admin-token is never read or written.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenFile, adminTokenFileToRead, explicitOldNote, ignoredOldNote, sameFile } from '../ingest/admin-token-file.mjs';
import { readAdminToken } from '../ingest/lib.mjs';
import { run as migrate } from '../ingest/migrate-from-backup.mjs';
import { configDir } from '../../scripts/admin/config.mjs';

const LIB = fileURLToPath(new URL('../ingest/lib.mjs', import.meta.url));
const TOKEN = 'b2'.repeat(32);
const OTHER = 'c3'.repeat(32);
// A file at mode 000 can still be read by root, so the tests that need one are skipped only then.
const AS_ROOT = process.getuid?.() === 0;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-token-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home);
  const put = (path, value) => {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, value, { mode: 0o600 });
    return path;
  };
  return { dir, home, old: join(home, '.config', 'conference-caddie', 'admin-token'), put };
}

// No part of the value: not the value itself, and none of its 8-character windows.
function assertNoPartOf(value, text, what) {
  for (let i = 0; i + 8 <= value.length; i++) assert.ok(!text.includes(value.slice(i, i + 8)), `${what} holds a part of the value (offset ${i})`);
}

describe('adminTokenFile: the resolution order', () => {
  const home = '/scratch/home';

  test('ADMIN_TOKEN_FILE comes first, resolved, with no old place', () => {
    const env = { ADMIN_TOKEN_FILE: '/srv/token', CADDIE_ADMIN_HOME: '/c', XDG_CONFIG_HOME: '/x' };
    assert.deepEqual(adminTokenFile(env, home), { path: '/srv/token', legacy: null });
    assert.equal(adminTokenFile({ ADMIN_TOKEN_FILE: 'rel/token' }, home).path, resolve('rel/token'));
  });

  // With CADDIE_ADMIN_HOME set there is no fallback to the old place (scripts/lib/admin-token-file.mjs).
  test('then $CADDIE_ADMIN_HOME/admin-token, over XDG_CONFIG_HOME, with no old place', () => {
    assert.deepEqual(adminTokenFile({ CADDIE_ADMIN_HOME: '/c', XDG_CONFIG_HOME: '/x' }, home), {
      path: '/c/admin-token', legacy: null,
    });
  });

  test('then $XDG_CONFIG_HOME/conference-caddie/admin-token', () => {
    assert.deepEqual(adminTokenFile({ XDG_CONFIG_HOME: '/x' }, home), {
      path: '/x/conference-caddie/admin-token', legacy: '/scratch/home/.config/conference-caddie/admin-token',
    });
  });

  test('then ~/.config/conference-caddie/admin-token, which is the old place itself', () => {
    assert.deepEqual(adminTokenFile({}, home), { path: '/scratch/home/.config/conference-caddie/admin-token', legacy: null });
    // A variable set to the old place, by either name, is the same file, so there is nothing to fall back to.
    assert.equal(adminTokenFile({ XDG_CONFIG_HOME: '/scratch/home/.config' }, home).legacy, null);
    assert.equal(adminTokenFile({ CADDIE_ADMIN_HOME: '/scratch/home/.config/conference-caddie/' }, home).legacy, null);
  });

  test('an empty variable counts as unset, as in configDir', () => {
    assert.equal(adminTokenFile({ ADMIN_TOKEN_FILE: '', CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: '/x' }, home).path, '/x/conference-caddie/admin-token');
    assert.equal(adminTokenFile({ CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: '' }, home).path, '/scratch/home/.config/conference-caddie/admin-token');
  });

  test('without ADMIN_TOKEN_FILE it is admin-token in the CLI\'s config directory, for every combination', () => {
    // configDir reads the real home directory, so only paths are compared here; no file is touched.
    for (const env of [{}, { XDG_CONFIG_HOME: '/x' }, { CADDIE_ADMIN_HOME: '/c' }, { CADDIE_ADMIN_HOME: '/c', XDG_CONFIG_HOME: '/x' }, { CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: '' }, { CADDIE_ADMIN_HOME: 'relative/dir' }]) {
      assert.equal(adminTokenFile(env, homedir()).path, resolve(configDir(env), 'admin-token'), JSON.stringify(env));
    }
  });
});

// What adminTokenFileToRead returns, without the note and the doubt, which are checked as text.
const shape = ({ note, doubt, ...rest }) => rest;

describe('adminTokenFileToRead: the fallback to the old place, and whether the file is trusted', () => {
  test('reads the old file when only it exists, not trusted, with a note that names both paths and says to move it only if it is this deployment\'s', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    const xdg = join(s.dir, 'xdg');
    const got = adminTokenFileToRead({ XDG_CONFIG_HOME: xdg }, s.home);
    const file = join(xdg, 'conference-caddie', 'admin-token');
    assert.deepEqual(shape(got), { path: s.old, value: TOKEN, legacy: s.old, trusted: false });
    // The advice is the smoke's: move the file and leave a symlink at the old path, which a shell
    // without XDG_CONFIG_HOME still reads, so no script loses the only copy.
    assert.equal(got.note, `Note: the admin token file is not at ${file}, its default place under XDG_CONFIG_HOME, so the file at its old place ${s.old} was read instead; if that file holds this deployment's token, move it to ${file} and leave a symlink at the old path (ln -s '${file}' ~/'.config/conference-caddie/admin-token'), so every script uses one file, or set ADMIN_TOKEN_FILE to it.`);
    assert.equal(got.doubt, `there is no token file at ${file}, its default place under XDG_CONFIG_HOME, only one at its old place ${s.old}, which may hold another deployment's token`);
    assertNoPartOf(TOKEN, `${got.note}\n${got.doubt}`, 'the note and the doubt');
  });

  test('reads the new file when it exists, trusted and with no note when the old one holds the same token', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    const file = s.put(join(s.dir, 'x', 'conference-caddie', 'admin-token'), TOKEN);
    assert.deepEqual(adminTokenFileToRead({ XDG_CONFIG_HOME: join(s.dir, 'x') }, s.home), { path: file, value: TOKEN, note: null, legacy: s.old, trusted: true, doubt: null });
  });

  test('reads the new file when the old one holds a different token, not trusted, with a note that names both paths and not the values', (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    const file = s.put(join(s.dir, 'x', 'conference-caddie', 'admin-token'), TOKEN);
    const got = adminTokenFileToRead({ XDG_CONFIG_HOME: join(s.dir, 'x') }, s.home);
    assert.deepEqual(shape(got), { path: file, value: TOKEN, legacy: s.old, trusted: false });
    assert.equal(got.note, `Note: the admin token file ${file} and the file at its old place ${s.old} hold different tokens; ${file} is used. Set ADMIN_TOKEN_FILE to the other file to use that one instead.`);
    assert.equal(got.doubt, `the token file ${file} and the file at its old place ${s.old} hold different tokens, so it is not clear which one is this deployment's`);
    for (const value of [TOKEN, OTHER]) assertNoPartOf(value, `${got.note}\n${got.doubt}`, 'the note and the doubt');
  });

  test('reads the new file when the old one exists and cannot be read, not trusted, with a note that names both paths', { skip: AS_ROOT && 'root can read a file at mode 000' }, (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    chmodSync(s.old, 0o000);
    const file = s.put(join(s.dir, 'x', 'conference-caddie', 'admin-token'), `${TOKEN}\n`);
    const got = adminTokenFileToRead({ XDG_CONFIG_HOME: join(s.dir, 'x') }, s.home);
    assert.deepEqual(shape(got), { path: file, value: TOKEN, legacy: s.old, trusted: false });
    assert.equal(got.note, `Note: the admin token file ${file} is used, but the file at its old place ${s.old} exists and cannot be read, so the two cannot be compared; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`);
    assert.equal(got.doubt, `the file at the old place ${s.old} of the token file ${file} exists and cannot be read, so it is not clear which one holds this deployment's token`);
    assertNoPartOf(TOKEN, `${got.note}\n${got.doubt}`, 'the note and the doubt');
  });

  test('names the new file, trusted and with no value or note, when neither exists', (t) => {
    const s = scratch(t);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: join(s.dir, 'c', 'admin-token'), value: null, note: null, legacy: null, trusted: true, doubt: null });
  });

  test('never falls back or compares when ADMIN_TOKEN_FILE is set, and the file it names is trusted', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const missing = join(s.dir, 'missing');
    assert.deepEqual(adminTokenFileToRead({ ADMIN_TOKEN_FILE: missing, XDG_CONFIG_HOME: join(s.dir, 'xdg') }, s.home), { path: missing, value: null, note: null, legacy: null, trusted: true, doubt: null });
    const other = s.put(join(s.dir, 'other'), OTHER);
    assert.deepEqual(adminTokenFileToRead({ ADMIN_TOKEN_FILE: other, XDG_CONFIG_HOME: join(s.dir, 'xdg') }, s.home), { path: other, value: OTHER, note: null, legacy: null, trusted: true, doubt: null });
  });

  test('the old place as a hard link to the token file is one file: trusted, with no old place and no note', (t) => {
    const s = scratch(t);
    const file = s.put(join(s.dir, 'c', 'admin-token'), TOKEN);
    mkdirSync(join(s.home, '.config', 'conference-caddie'), { recursive: true });
    linkSync(file, s.old);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: file, value: TOKEN, note: null, legacy: null, trusted: true, doubt: null });
  });
});

// The old place and the new one can be one file through a symbolic link. The old place must then
// never count as old: setup-secrets.mjs would say to delete it, which deletes the live token.
describe('one file through a symbolic link is never the old place', () => {
  // ~/.config is a link to $XDG_CONFIG_HOME.
  function linkedConfig(t) {
    const s = scratch(t);
    const xdg = join(s.dir, 'xdg');
    mkdirSync(xdg);
    symlinkSync(xdg, join(s.home, '.config'));
    return { ...s, env: { XDG_CONFIG_HOME: xdg }, file: join(xdg, 'conference-caddie', 'admin-token') };
  }
  // ~/.config/conference-caddie is a link to $CADDIE_ADMIN_HOME.
  function linkedCaddieHome(t) {
    const s = scratch(t);
    const caddie = join(s.dir, 'caddie');
    mkdirSync(caddie);
    mkdirSync(join(s.home, '.config'));
    symlinkSync(caddie, join(s.home, '.config', 'conference-caddie'));
    return { ...s, env: { CADDIE_ADMIN_HOME: caddie }, file: join(caddie, 'admin-token') };
  }

  for (const [name, make] of [['~/.config links to $XDG_CONFIG_HOME', linkedConfig], ['~/.config/conference-caddie links to $CADDIE_ADMIN_HOME', linkedCaddieHome]]) {
    test(`${name}: no old place before and after the file exists, and no note`, (t) => {
      const s = make(t);
      // Before the file exists (and, for XDG, before its directory exists): the directories decide.
      assert.deepEqual(adminTokenFile(s.env, s.home), { path: s.file, legacy: null });
      s.put(s.file, `${TOKEN}\n`);
      assert.deepEqual(adminTokenFile(s.env, s.home), { path: s.file, legacy: null });
      assert.deepEqual(adminTokenFileToRead(s.env, s.home), { path: s.file, value: TOKEN, note: null, legacy: null, trusted: true, doubt: null });
      const lines = [];
      assert.equal(readAdminToken({ env: s.env, home: s.home, warn: (line) => lines.push(line) }), TOKEN);
      assert.deepEqual(lines, []);
    });
  }

  test('sameFile: a hard link and a linked directory are one file; two files with the same contents are not', (t) => {
    const s = scratch(t);
    const a = s.put(join(s.dir, 'a', 'admin-token'), TOKEN);
    const b = s.put(join(s.dir, 'b', 'admin-token'), TOKEN);
    assert.equal(sameFile(a, b), false);
    linkSync(a, join(s.dir, 'hard'));
    assert.equal(sameFile(a, join(s.dir, 'hard')), true);
    symlinkSync(join(s.dir, 'a'), join(s.dir, 'linked'));
    assert.equal(sameFile(a, join(s.dir, 'linked', 'admin-token')), true);
    assert.equal(sameFile(join(s.dir, 'a', 'missing'), join(s.dir, 'linked', 'missing')), true, 'a file that does not exist yet, under a linked directory');
    assert.equal(sameFile(join(s.dir, 'a', 'missing'), join(s.dir, 'b', 'missing')), false);
  });
});

describe('readAdminToken', () => {
  const quiet = (t) => {
    const lines = [];
    return { lines, warn: (line) => lines.push(line) };
  };

  test('ADMIN_TOKEN wins over every file', (t) => {
    const s = scratch(t);
    const file = s.put(join(s.dir, 'f'), OTHER);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { ADMIN_TOKEN: ` ${TOKEN} `, ADMIN_TOKEN_FILE: file }, home: s.home, warn: w.warn }), TOKEN);
    assert.deepEqual(w.lines, []);
  });

  test('then ADMIN_TOKEN_FILE, then $CADDIE_ADMIN_HOME/admin-token, then $XDG_CONFIG_HOME/conference-caddie/admin-token, then ~/.config', (t) => {
    const s = scratch(t);
    const named = s.put(join(s.dir, 'named'), 'named-token\n');
    const caddie = join(s.dir, 'caddie');
    const xdg = join(s.dir, 'xdg');
    s.put(join(caddie, 'admin-token'), 'caddie-token\n');
    s.put(join(xdg, 'conference-caddie', 'admin-token'), 'xdg-token\n');
    s.put(s.old, 'old-token\n');
    const w = quiet(t);
    const read = (env) => readAdminToken({ env, home: s.home, warn: w.warn });
    assert.equal(read({ ADMIN_TOKEN: '', ADMIN_TOKEN_FILE: named, CADDIE_ADMIN_HOME: caddie, XDG_CONFIG_HOME: xdg }), 'named-token');
    assert.equal(read({}), 'old-token');
    assert.deepEqual(w.lines, [], 'no note for ADMIN_TOKEN_FILE or for the old place itself');
    // With CADDIE_ADMIN_HOME the old file is not read, and one note says so; with XDG_CONFIG_HOME
    // the old file holds a different token, so the note says which file is used.
    assert.equal(read({ CADDIE_ADMIN_HOME: caddie, XDG_CONFIG_HOME: xdg }), 'caddie-token');
    assert.equal(read({ XDG_CONFIG_HOME: xdg }), 'xdg-token');
    assert.equal(w.lines.length, 2, w.lines.join('\n'));
    assert.equal(w.lines[0], ignoredOldNote(join(caddie, 'admin-token'), s.old));
    assert.ok(w.lines[1].includes(`${join(xdg, 'conference-caddie', 'admin-token')} is used`) && w.lines[1].includes(s.old), w.lines[1]);
  });

  test('reads the new file when the old one holds a different token, with one note that holds neither value', (t) => {
    const s = scratch(t);
    s.put(s.old, `${OTHER}\n`);
    const xdg = join(s.dir, 'xdg');
    s.put(join(xdg, 'conference-caddie', 'admin-token'), `${TOKEN}\n`);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { XDG_CONFIG_HOME: xdg }, home: s.home, warn: w.warn }), TOKEN);
    assert.equal(w.lines.length, 1);
    assert.match(w.lines[0], /hold different tokens/);
    assertNoPartOf(TOKEN, w.lines[0], 'the note');
    assertNoPartOf(OTHER, w.lines[0], 'the note');
    // The same token in both files is no news.
    s.put(s.old, TOKEN);
    const quietAgain = quiet(t);
    assert.equal(readAdminToken({ env: { XDG_CONFIG_HOME: xdg }, home: s.home, warn: quietAgain.warn }), TOKEN);
    assert.deepEqual(quietAgain.lines, []);
  });

  test('falls back to the old file when the default one is missing, with one note that never holds the value', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { XDG_CONFIG_HOME: join(s.dir, 'xdg') }, home: s.home, warn: w.warn }), TOKEN);
    assert.equal(w.lines.length, 1);
    assert.ok(w.lines[0].includes(s.old) && /if that file holds this deployment's token, move it to /.test(w.lines[0]), w.lines[0]);
    assertNoPartOf(TOKEN, w.lines.join('\n'), 'the note');
  });

  test('never falls back with CADDIE_ADMIN_HOME set: the old file is not read, and one note names both paths', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    const caddie = join(s.dir, 'caddie');
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { CADDIE_ADMIN_HOME: caddie }, home: s.home, warn: w.warn }), '');
    assert.deepEqual(w.lines, [ignoredOldNote(join(caddie, 'admin-token'), s.old)]);
    assertNoPartOf(TOKEN, w.lines.join('\n'), 'the note');
  });

  test('reads the new file when the old one cannot be read, with one note that names both paths', { skip: AS_ROOT && 'root can read a file at mode 000' }, (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    chmodSync(s.old, 0o000);
    const xdg = join(s.dir, 'xdg');
    const file = s.put(join(xdg, 'conference-caddie', 'admin-token'), `${TOKEN}\n`);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { XDG_CONFIG_HOME: xdg }, home: s.home, warn: w.warn }), TOKEN);
    assert.equal(w.lines.length, 1);
    assert.ok(w.lines[0].includes(file) && w.lines[0].includes(s.old) && /cannot be read/.test(w.lines[0]), w.lines[0]);
    assertNoPartOf(TOKEN, w.lines[0], 'the note');
  });

  test('does not fall back when ADMIN_TOKEN_FILE is set', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { ADMIN_TOKEN_FILE: join(s.dir, 'missing'), XDG_CONFIG_HOME: join(s.dir, 'xdg') }, home: s.home, warn: w.warn }), '');
    assert.deepEqual(w.lines, []);
  });

  test('prints the note on stderr by default, as one line without the value', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const xdg = join(s.dir, 'xdg');
    const code = `import { readAdminToken } from ${JSON.stringify(LIB)}; process.stdout.write(String(readAdminToken().length));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, HOME: s.home, XDG_CONFIG_HOME: xdg }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, String(TOKEN.length));
    const file = join(xdg, 'conference-caddie', 'admin-token');
    assert.equal(r.stderr, `Note: the admin token file is not at ${file}, its default place under XDG_CONFIG_HOME, so the file at its old place ${s.old} was read instead; if that file holds this deployment's token, move it to ${file} and leave a symlink at the old path (ln -s '${file}' ~/'.config/conference-caddie/admin-token'), so every script uses one file, or set ADMIN_TOKEN_FILE to it.\n`);
    assertNoPartOf(TOKEN, r.stderr, 'stderr');
  });
});

// No fallback to the old place with CADDIE_ADMIN_HOME set, and the config.json check of the
// fallback when the caller knows the API origin: the rules of scripts/lib/admin-token-file.mjs.
describe('adminTokenFileToRead: CADDIE_ADMIN_HOME and the old directory\'s config.json', () => {
  const ORIGIN = 'https://caddie.example';
  const config = (api) => JSON.stringify({ backends: { live: { tier: 2, api } } });

  test('with CADDIE_ADMIN_HOME set and both files there, the new file is read and trusted, the old one is not read, and one note names both paths', (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    const caddie = join(s.dir, 'caddie');
    const file = s.put(join(caddie, 'admin-token'), `${TOKEN}\n`);
    const got = adminTokenFileToRead({ CADDIE_ADMIN_HOME: caddie }, s.home);
    assert.deepEqual(got, { path: file, value: TOKEN, note: ignoredOldNote(file, s.old), legacy: null, trusted: true, doubt: null });
    assert.equal(got.note, `Note: CADDIE_ADMIN_HOME is set, so the admin token file is ${file}; the file at the old place ${s.old} is not read or changed, because there is no fallback to the old place with CADDIE_ADMIN_HOME set.`);
    for (const value of [TOKEN, OTHER]) assertNoPartOf(value, got.note, 'the note');
  });

  test('with CADDIE_ADMIN_HOME set and only the old file there, nothing is read and the result is not trusted', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const caddie = join(s.dir, 'caddie');
    const file = join(caddie, 'admin-token');
    const got = adminTokenFileToRead({ CADDIE_ADMIN_HOME: caddie }, s.home);
    assert.deepEqual(got, {
      path: file,
      value: null,
      note: ignoredOldNote(file, s.old),
      legacy: null,
      trusted: false,
      doubt: `there is no token file at ${file}, and the file at the old place ${s.old} is not read, because there is no fallback to the old place with CADDIE_ADMIN_HOME set`,
    });
  });

  test('with CADDIE_ADMIN_HOME set and no old file, there is no note', (t) => {
    const s = scratch(t);
    const caddie = join(s.dir, 'caddie');
    const file = s.put(join(caddie, 'admin-token'), TOKEN);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: caddie }, s.home), { path: file, value: TOKEN, note: null, legacy: null, trusted: true, doubt: null });
  });

  test('with CADDIE_ADMIN_HOME set and the old place unsearchable, the note and the doubt say a file may be there, not that one is', { skip: AS_ROOT && 'root can search a directory at mode 000' }, (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const config = join(s.home, '.config');
    const caddie = join(s.dir, 'caddie');
    const file = join(caddie, 'admin-token');
    chmodSync(config, 0o000);
    let got;
    try {
      got = adminTokenFileToRead({ CADDIE_ADMIN_HOME: caddie }, s.home);
    } finally {
      chmodSync(config, 0o700);
    }
    assert.equal(got.note, `Note: CADDIE_ADMIN_HOME is set, so the admin token file is ${file}; a file that may be at the old place ${s.old} (it cannot be checked) is not read or changed, because there is no fallback to the old place with CADDIE_ADMIN_HOME set.`);
    assert.equal(got.doubt, `there is no token file at ${file}, and a file that may be at the old place ${s.old} (it cannot be checked) is not read, because there is no fallback to the old place with CADDIE_ADMIN_HOME set`);
    assert.equal(got.trusted, false, 'still refused');
    assert.equal(got.value, null);
  });

  test('with CADDIE_ADMIN_HOME set and ADMIN_TOKEN_FILE naming the old file, that file is used and trusted, with one note that says whose file it is', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const caddie = join(s.dir, 'caddie');
    s.put(join(caddie, 'admin-token'), OTHER);
    const note = `Note: CADDIE_ADMIN_HOME is set, but ADMIN_TOKEN_FILE names the old place ${s.old}, the token file of a setup without CADDIE_ADMIN_HOME; it is used, because ADMIN_TOKEN_FILE comes first. If the setup at $CADDIE_ADMIN_HOME has its own token, unset ADMIN_TOKEN_FILE.`;
    const env = { ADMIN_TOKEN_FILE: s.old, CADDIE_ADMIN_HOME: caddie };
    assert.deepEqual(adminTokenFileToRead(env, s.home), { path: s.old, value: TOKEN, note, legacy: null, trusted: true, doubt: null });
    for (const value of [TOKEN, OTHER]) assertNoPartOf(value, note, 'the note');
    const lines = [];
    assert.equal(readAdminToken({ env, home: s.home, warn: (line) => lines.push(line) }), TOKEN);
    assert.deepEqual(lines, [note]);
    // A link that is proven to lead to the old file counts too, and the note names both paths.
    const link = join(s.dir, 'link');
    symlinkSync(s.old, link);
    assert.equal(explicitOldNote({ ADMIN_TOKEN_FILE: link, CADDIE_ADMIN_HOME: caddie }, s.home), `Note: CADDIE_ADMIN_HOME is set, but ADMIN_TOKEN_FILE names ${link}, which is the file at the old place ${s.old}, the token file of a setup without CADDIE_ADMIN_HOME; it is used, because ADMIN_TOKEN_FILE comes first. If the setup at $CADDIE_ADMIN_HOME has its own token, unset ADMIN_TOKEN_FILE.`);
    // No note without CADDIE_ADMIN_HOME, or for another file.
    assert.equal(explicitOldNote({ ADMIN_TOKEN_FILE: s.old }, s.home), null);
    assert.equal(adminTokenFileToRead({ ADMIN_TOKEN_FILE: s.old }, s.home).note, null);
    assert.equal(explicitOldNote({ ADMIN_TOKEN_FILE: join(caddie, 'admin-token'), CADDIE_ADMIN_HOME: caddie }, s.home), null);
  });

  test('the fallback with an API origin: read when the old directory has no config.json or lists the origin, refused when its config.json does not', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const xdg = join(s.dir, 'xdg');
    const file = join(xdg, 'conference-caddie', 'admin-token');
    const env = { XDG_CONFIG_HOME: xdg };
    // No config.json in the old directory: the fallback as before.
    assert.deepEqual(shape(adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN })), { path: s.old, value: TOKEN, legacy: s.old, trusted: false });
    // A config.json that lists the origin as a tier 2 api: the fallback as before.
    const oldConfig = s.put(join(s.home, '.config', 'conference-caddie', 'config.json'), config(ORIGIN));
    assert.deepEqual(shape(adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN })), { path: s.old, value: TOKEN, legacy: s.old, trusted: false });
    // A config.json that lists another origin: the old file is not read.
    s.put(oldConfig, config('https://other.example'));
    const got = adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN });
    assert.deepEqual(shape(got), { path: file, value: null, legacy: s.old, trusted: false });
    assert.equal(got.note, `Note: the admin token file is not at ${file}, its default place under XDG_CONFIG_HOME, and the file at its old place ${s.old} is not read, because ${oldConfig} does not list ${ORIGIN} as a tier 2 api; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`);
    assertNoPartOf(TOKEN, `${got.note}\n${got.doubt}`, 'the note and the doubt');
    // A config.json that is not valid lists nothing.
    s.put(oldConfig, '{');
    assert.equal(adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN }).value, null);
    // Without an origin there is no such check.
    assert.equal(adminTokenFileToRead(env, s.home).value, TOKEN);
    // The check is for the fallback only: a new file is read whatever the old config.json says.
    s.put(file, OTHER);
    assert.equal(adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN }).value, OTHER);
  });

  test('readAdminToken with an API origin prints the refusal as one line and returns nothing', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    s.put(join(s.home, '.config', 'conference-caddie', 'config.json'), config('https://other.example'));
    const lines = [];
    const env = { XDG_CONFIG_HOME: join(s.dir, 'xdg') };
    assert.equal(readAdminToken({ env, home: s.home, warn: (line) => lines.push(line), apiOrigin: ORIGIN }), '');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /is not read, because .* does not list https:\/\/caddie\.example as a tier 2 api/);
    assertNoPartOf(TOKEN, lines.join('\n'), 'the note');
    const listed = [];
    s.put(join(s.home, '.config', 'conference-caddie', 'config.json'), config(ORIGIN));
    assert.equal(readAdminToken({ env, home: s.home, warn: (line) => listed.push(line), apiOrigin: ORIGIN }), TOKEN);
    assert.match(listed[0], /was read instead/);
  });

  test('an old directory that cannot be searched refuses the fallback, and the note says its config.json cannot be checked', { skip: AS_ROOT && 'root can search a directory at mode 000' }, (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const oldDir = dirname(s.old);
    const xdg = join(s.dir, 'xdg');
    const file = join(xdg, 'conference-caddie', 'admin-token');
    chmodSync(oldDir, 0o000);
    try {
      const got = adminTokenFileToRead({ XDG_CONFIG_HOME: xdg }, s.home, { apiOrigin: ORIGIN });
      assert.deepEqual(shape(got), { path: file, value: null, legacy: s.old, trusted: false });
      assert.equal(got.note, `Note: the admin token file is not at ${file}, its default place under XDG_CONFIG_HOME, and the file at its old place ${s.old} is not read, because ${join(oldDir, 'config.json')} cannot be checked for ${ORIGIN}; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`);
      assert.doesNotMatch(got.note, /does not list/);
    } finally {
      chmodSync(oldDir, 0o700);
    }
  });
});

// The three scripts that know the --api origin pass it to readAdminToken, so the old directory's
// config.json gates the fallback for them as it does for the smoke. Without these tests a refactor
// could drop the origin and every other test would still pass. Each run stops before it would send
// a request: nothing listens at the origin used, and no run gets that far.
describe('the ingest, migration and topics scripts pass the --api origin to the token reader', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const ORIGIN = 'http://127.0.0.1:9';
  const config = (api) => JSON.stringify({ backends: { live: { tier: 2, api } } });
  // A scratch home with only the old token file, XDG_CONFIG_HOME set, and an old config.json that
  // lists api as its tier 2 api.
  function oldOnly(t, api) {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const oldConfig = s.put(join(dirname(s.old), 'config.json'), config(api));
    const xdg = join(s.dir, 'xdg');
    const refusal = `Note: the admin token file is not at ${join(xdg, 'conference-caddie', 'admin-token')}, its default place under XDG_CONFIG_HOME, and the file at its old place ${s.old} is not read, because ${oldConfig} does not list ${ORIGIN} as a tier 2 api; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`;
    return { s, oldConfig, refusal, env: { PATH: process.env.PATH, HOME: s.home, XDG_CONFIG_HOME: xdg } };
  }
  const spawn = (name, args, env) => spawnSync(process.execPath, [join(ROOT, 'worker', 'ingest', name), ...args], { env, encoding: 'utf8', timeout: 60_000 });

  test('migrate-from-backup asks for the token with the origin of --api', async (t) => {
    const s = scratch(t);
    const backup = dirname(s.put(join(s.dir, 'backup', 'caddie-conferences-v1.ndjson'), ''));
    const asked = [];
    const out = [];
    const code = await migrate(['--backup', backup, '--api', 'https://caddie.example/base/', '--only', 'conferences', '--dry-run'], {
      readToken: (options) => {
        asked.push(options);
        return '';
      },
      log: (line) => out.push(line),
      error: (line) => out.push(line),
    });
    assert.equal(code, 0, out.join('\n'));
    assert.deepEqual(asked, [{ apiOrigin: 'https://caddie.example' }]);
  });

  test('push-ingest --dry-run does not fall back when the old config.json lists another origin, and does when it lists this one', (t) => {
    const { s, oldConfig, refusal, env } = oldOnly(t, 'https://other.example');
    const args = ['--api', ORIGIN, '--dry-run', '--event', 'no-such-conference-zz'];
    const r = spawn('push-ingest.mjs', args, env);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines[0], refusal);
    assert.match(lines[1], /^No data\/no-such-conference-zz\/conference\.json\./);
    assert.equal(lines.length, 2, r.stderr);
    assert.doesNotMatch(r.stderr, /was read instead/);
    // The same run with the origin listed falls back to the old file, with its note.
    writeFileSync(oldConfig, config(ORIGIN));
    const listed = spawn('push-ingest.mjs', args, env);
    assert.equal(listed.status, 1, listed.stderr);
    assert.match(listed.stderr, /was read instead/);
    assert.doesNotMatch(listed.stderr, /is not read, because/);
    assertNoPartOf(TOKEN, `${r.stdout}${r.stderr}${listed.stdout}${listed.stderr}`, 'the output');
    assert.equal(existsSync(join(s.dir, 'xdg')), false, 'a read never creates the new place');
  });

  test('topics-local --api does not fall back when the old config.json lists another origin, and stops for want of a token', (t) => {
    const slug = readdirSync(join(ROOT, 'data')).find((d) => existsSync(join(ROOT, 'data', d, 'talks.ndjson')));
    assert.ok(slug, 'a conference with talks in data/');
    const { refusal, env } = oldOnly(t, 'https://other.example');
    const r = spawn('topics-local.mjs', ['--event', slug, '--api', ORIGIN], env);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.deepEqual(lines, [refusal, '--api needs ADMIN_TOKEN (or ADMIN_TOKEN_FILE).']);
    assertNoPartOf(TOKEN, `${r.stdout}${r.stderr}`, 'the output');
  });
});
