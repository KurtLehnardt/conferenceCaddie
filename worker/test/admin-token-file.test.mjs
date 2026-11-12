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
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenFile, adminTokenFileToRead, sameFile } from '../ingest/admin-token-file.mjs';
import { readAdminToken } from '../ingest/lib.mjs';
import { configDir } from '../../scripts/admin/config.mjs';

const LIB = fileURLToPath(new URL('../ingest/lib.mjs', import.meta.url));
const TOKEN = 'b2'.repeat(32);
const OTHER = 'c3'.repeat(32);

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

  test('then $CADDIE_ADMIN_HOME/admin-token, over XDG_CONFIG_HOME', () => {
    assert.deepEqual(adminTokenFile({ CADDIE_ADMIN_HOME: '/c', XDG_CONFIG_HOME: '/x' }, home), {
      path: '/c/admin-token', legacy: '/scratch/home/.config/conference-caddie/admin-token',
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

describe('adminTokenFileToRead: the fallback to the old place', () => {
  test('reads the old file when only it exists, with a note that names both paths', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const xdg = join(s.dir, 'xdg');
    const { path, note } = adminTokenFileToRead({ XDG_CONFIG_HOME: xdg }, s.home);
    assert.equal(path, s.old);
    const file = join(xdg, 'conference-caddie', 'admin-token');
    assert.equal(note, `Note: the admin token file is not at ${file}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, so the file at its old place ${s.old} was read instead; move that file to ${file}.`);
  });

  test('reads the new file when it exists, with no note when the old one holds the same token', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    const file = s.put(join(s.dir, 'c', 'admin-token'), TOKEN);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: file, note: null, legacy: s.old, fallback: false, differs: false });
  });

  test('reads the new file when the old one holds a different token, with a note that names both paths and not the values', (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    const file = s.put(join(s.dir, 'c', 'admin-token'), TOKEN);
    const got = adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home);
    assert.deepEqual({ ...got, note: undefined }, { path: file, note: undefined, legacy: s.old, fallback: false, differs: true });
    assert.equal(got.note, `Note: the admin token file ${file} and the file at its old place ${s.old} hold different tokens; ${file} is used. Set ADMIN_TOKEN_FILE to the other file to use that one instead.`);
    assertNoPartOf(TOKEN, got.note, 'the note');
    assertNoPartOf(OTHER, got.note, 'the note');
  });

  test('names the new file, with no note, when neither exists', (t) => {
    const s = scratch(t);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: join(s.dir, 'c', 'admin-token'), note: null, legacy: null, fallback: false, differs: false });
  });

  test('never falls back or compares when ADMIN_TOKEN_FILE is set', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const missing = join(s.dir, 'missing');
    assert.deepEqual(adminTokenFileToRead({ ADMIN_TOKEN_FILE: missing, XDG_CONFIG_HOME: join(s.dir, 'xdg') }, s.home), { path: missing, note: null, legacy: null, fallback: false, differs: false });
    const other = s.put(join(s.dir, 'other'), OTHER);
    assert.deepEqual(adminTokenFileToRead({ ADMIN_TOKEN_FILE: other, XDG_CONFIG_HOME: join(s.dir, 'xdg') }, s.home), { path: other, note: null, legacy: null, fallback: false, differs: false });
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
      assert.deepEqual(adminTokenFileToRead(s.env, s.home), { path: s.file, note: null, legacy: null, fallback: false, differs: false });
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
    // The old file holds a different token, so each of these says which file is used.
    assert.equal(read({ CADDIE_ADMIN_HOME: caddie, XDG_CONFIG_HOME: xdg }), 'caddie-token');
    assert.equal(read({ XDG_CONFIG_HOME: xdg }), 'xdg-token');
    assert.equal(w.lines.length, 2, w.lines.join('\n'));
    assert.ok(w.lines[0].includes(`${join(caddie, 'admin-token')} is used`) && w.lines[0].includes(s.old), w.lines[0]);
    assert.ok(w.lines[1].includes(`${join(xdg, 'conference-caddie', 'admin-token')} is used`) && w.lines[1].includes(s.old), w.lines[1]);
  });

  test('reads the new file when the old one holds a different token, with one note that holds neither value', (t) => {
    const s = scratch(t);
    s.put(s.old, `${OTHER}\n`);
    const caddie = join(s.dir, 'caddie');
    s.put(join(caddie, 'admin-token'), `${TOKEN}\n`);
    const w = quiet(t);
    assert.equal(readAdminToken({ env: { CADDIE_ADMIN_HOME: caddie }, home: s.home, warn: w.warn }), TOKEN);
    assert.equal(w.lines.length, 1);
    assert.match(w.lines[0], /hold different tokens/);
    assertNoPartOf(TOKEN, w.lines[0], 'the note');
    assertNoPartOf(OTHER, w.lines[0], 'the note');
    // The same token in both files is no news.
    s.put(s.old, TOKEN);
    const quietAgain = quiet(t);
    assert.equal(readAdminToken({ env: { CADDIE_ADMIN_HOME: caddie }, home: s.home, warn: quietAgain.warn }), TOKEN);
    assert.deepEqual(quietAgain.lines, []);
  });

  test('falls back to the old file when the default one is missing, with one note that never holds the value', (t) => {
    const s = scratch(t);
    s.put(s.old, `${TOKEN}\n`);
    for (const env of [{ XDG_CONFIG_HOME: join(s.dir, 'xdg') }, { CADDIE_ADMIN_HOME: join(s.dir, 'caddie') }]) {
      const w = quiet(t);
      assert.equal(readAdminToken({ env, home: s.home, warn: w.warn }), TOKEN, JSON.stringify(env));
      assert.equal(w.lines.length, 1);
      assert.ok(w.lines[0].includes(s.old) && /move that file to /.test(w.lines[0]), w.lines[0]);
      assertNoPartOf(TOKEN, w.lines.join('\n'), 'the note');
    }
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
    assert.equal(r.stderr, `Note: the admin token file is not at ${join(xdg, 'conference-caddie', 'admin-token')}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, so the file at its old place ${s.old} was read instead; move that file to ${join(xdg, 'conference-caddie', 'admin-token')}.\n`);
    assertNoPartOf(TOKEN, r.stderr, 'stderr');
  });
});
