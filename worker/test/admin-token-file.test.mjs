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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenFile, adminTokenFileToRead } from '../ingest/admin-token-file.mjs';
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

  test('reads the new file when it exists, even if the old one does too', (t) => {
    const s = scratch(t);
    s.put(s.old, OTHER);
    const file = s.put(join(s.dir, 'c', 'admin-token'), TOKEN);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: file, note: null });
  });

  test('names the new file, with no note, when neither exists', (t) => {
    const s = scratch(t);
    assert.deepEqual(adminTokenFileToRead({ CADDIE_ADMIN_HOME: join(s.dir, 'c') }, s.home), { path: join(s.dir, 'c', 'admin-token'), note: null });
  });

  test('never falls back when ADMIN_TOKEN_FILE is set', (t) => {
    const s = scratch(t);
    s.put(s.old, TOKEN);
    const missing = join(s.dir, 'missing');
    assert.deepEqual(adminTokenFileToRead({ ADMIN_TOKEN_FILE: missing, XDG_CONFIG_HOME: join(s.dir, 'xdg') }, s.home), { path: missing, note: null });
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
    assert.equal(read({ CADDIE_ADMIN_HOME: caddie, XDG_CONFIG_HOME: xdg }), 'caddie-token');
    assert.equal(read({ XDG_CONFIG_HOME: xdg }), 'xdg-token');
    assert.equal(read({}), 'old-token');
    assert.deepEqual(w.lines, [], 'no note while each file is where the rule puts it');
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
