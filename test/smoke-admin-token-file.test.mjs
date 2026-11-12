// Where scripts/smoke.mjs finds the Worker's admin token when neither ADMIN_TOKEN nor
// ADMIN_TOKEN_FILE is set: the file caddie-admin reads (<config dir>/admin-token), else the old
// ~/.config/conference-caddie/admin-token with one NOTE line, and no note when both paths are the
// same file. The resolver is tested directly, then the real smoke is run with fake short tokens: a
// token it read stops it at the "at least 32 characters" check, before any request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenPaths, defaultAdminTokenFile, legacyAdminTokenFile, resolveAdminTokenFile, sameFile, shellPath } from '../scripts/lib/admin-token-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SMOKE = join(ROOT, 'scripts', 'smoke.mjs');
// Fake tokens, shorter than the 32 characters a signed run needs.
const FAKE = 'fake-short-token-not-a-secret';
const SHORT_FAIL = 'FAIL config: the admin token must have at least 32 characters';

// A fresh temporary home (its real path, so macOS /var -> /private/var does not matter).
function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'caddie-tok-')));
}

function put(file, text = `${FAKE}\n`) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
}

const noteLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('NOTE admin token'));

describe('resolveAdminTokenFile', () => {
  test('precedence: ADMIN_TOKEN_FILE, then CADDIE_ADMIN_HOME, then XDG_CONFIG_HOME, then ~/.config', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      const cah = join(home, 'cah');
      for (const f of [legacy, join(xdg, 'conference-caddie', 'admin-token'), join(cah, 'admin-token')]) put(f);
      const explicit = join(home, 'elsewhere', 'token');

      assert.deepEqual(resolveAdminTokenFile({ ADMIN_TOKEN_FILE: explicit, CADDIE_ADMIN_HOME: cah, XDG_CONFIG_HOME: xdg }, home), { file: explicit, note: null }, 'ADMIN_TOKEN_FILE wins, even when it does not exist');
      assert.deepEqual(resolveAdminTokenFile({ CADDIE_ADMIN_HOME: cah, XDG_CONFIG_HOME: xdg }, home).file, join(cah, 'admin-token'));
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home).file, join(xdg, 'conference-caddie', 'admin-token'));
      assert.deepEqual(resolveAdminTokenFile({}, home), { file: legacy, note: null });
      assert.equal(defaultAdminTokenFile({}, home), legacy);
      assert.equal(legacyAdminTokenFile(home), legacy);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no file anywhere: no file and no note', () => {
    const home = tempHome();
    try {
      assert.deepEqual(resolveAdminTokenFile({}, home), { file: null, note: null });
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: join(home, 'xdg') }, home), { file: null, note: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the config dir has no token file but the old path has one: the old file, with a note to move it', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      put(legacy);
      for (const env of [{ XDG_CONFIG_HOME: join(home, 'xdg') }, { CADDIE_ADMIN_HOME: join(home, 'cah') }]) {
        const wanted = defaultAdminTokenFile(env, home);
        const { file, note } = resolveAdminTokenFile(env, home);
        assert.equal(file, legacy);
        assert.equal(note, `NOTE admin token: ${wanted} does not exist, so the old path ${legacy} was read; move the file to ${wanted}, where caddie-admin reads it`);
        assert.ok(!note.includes(FAKE));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('both paths hold different files: the config dir one is read and the note names the other', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      const current = join(xdg, 'conference-caddie', 'admin-token');
      put(legacy, 'fake-old\n');
      put(current, 'fake-new\n');
      const { file, note } = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home);
      assert.equal(file, current);
      assert.equal(note, `NOTE admin token: read ${current}; the old path ${legacy} is a different file and is not read; keep only one of the two`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('~/.config is a symlink to $XDG_CONFIG_HOME: the two paths are one file, so there is no note', () => {
    const home = tempHome();
    try {
      const xdg = join(home, 'xdg');
      put(join(xdg, 'conference-caddie', 'admin-token'));
      symlinkSync(xdg, join(home, '.config'), 'dir');
      const { file, note } = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home);
      assert.equal(file, join(xdg, 'conference-caddie', 'admin-token'));
      assert.equal(note, null, 'a note here would point at the live token');
      // The other way round: XDG_CONFIG_HOME is the symlink.
      const other = tempHome();
      try {
        put(join(other, '.config', 'conference-caddie', 'admin-token'));
        symlinkSync(join(other, '.config'), join(other, 'xdg-link'), 'dir');
        assert.equal(resolveAdminTokenFile({ XDG_CONFIG_HOME: join(other, 'xdg-link') }, other).note, null);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a hard link is the same file too: no note', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const cah = join(home, 'cah');
      put(legacy);
      mkdirSync(cah);
      linkSync(legacy, join(cah, 'admin-token'));
      assert.deepEqual(resolveAdminTokenFile({ CADDIE_ADMIN_HOME: cah }, home), { file: join(cah, 'admin-token'), note: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Runs fn with a fresh temporary home and removes it after.
function withHome(fn) {
  const home = tempHome();
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('sameFile', () => {
  test('~/.config symlinked to $XDG_CONFIG_HOME: the same, with the token file missing and present', () => withHome((home) => {
    const xdg = join(home, 'xdg');
    mkdirSync(xdg);
    symlinkSync(xdg, join(home, '.config'), 'dir');
    const viaLink = join(home, '.config', 'conference-caddie', 'admin-token');
    const real = join(xdg, 'conference-caddie', 'admin-token');
    assert.equal(sameFile(viaLink, real), true, 'missing: the same location');
    put(real);
    assert.equal(sameFile(viaLink, real), true, 'present: the same inode');
  }));

  test('a symlinked conference-caddie directory: the same, with the token file missing and present', () => withHome((home) => {
    const target = join(home, 'elsewhere', 'cc');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(home, '.config'));
    symlinkSync(target, join(home, '.config', 'conference-caddie'), 'dir');
    const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
    const real = join(target, 'admin-token');
    assert.equal(sameFile(legacy, real), true, 'missing');
    assert.deepEqual(adminTokenPaths({ CADDIE_ADMIN_HOME: target }, home), { path: real, legacy: null, explicit: false });
    put(real);
    assert.equal(sameFile(legacy, real), true, 'present');
    assert.deepEqual(adminTokenPaths({ CADDIE_ADMIN_HOME: target }, home), { path: real, legacy: null, explicit: false });
  }));

  test('a hard link is the same file', () => withHome((home) => {
    put(join(home, 'a'));
    linkSync(join(home, 'a'), join(home, 'b'));
    assert.equal(sameFile(join(home, 'a'), join(home, 'b')), true);
  }));

  test('one path missing, or both missing in different places: not the same', () => withHome((home) => {
    put(join(home, 'a', 'admin-token'));
    assert.equal(sameFile(join(home, 'a', 'admin-token'), join(home, 'b', 'admin-token')), false);
    assert.equal(sameFile(join(home, 'b', 'admin-token'), join(home, 'a', 'admin-token')), false);
    assert.equal(sameFile(join(home, 'x', 'admin-token'), join(home, 'y', 'admin-token')), false);
    assert.equal(sameFile(join(home, 'x', 'admin-token'), join(home, 'x', '..', 'x', 'admin-token')), true, 'the same missing path, spelled two ways');
    assert.equal(sameFile(join(home, 'a', 'admin-token', 'under-a-file'), join(home, 'a', 'admin-token', 'under-a-file')), true, 'ENOTDIR counts as missing');
  }));

  test('two different files are not the same', () => withHome((home) => {
    put(join(home, 'a'), 'fake-a\n');
    put(join(home, 'b'), 'fake-a\n');
    assert.equal(sameFile(join(home, 'a'), join(home, 'b')), false, 'equal contents do not make one file');
  }));

  test('an unreadable path is false, never a throw', { skip: process.getuid?.() === 0 ? 'root can search any directory' : false }, () => withHome((home) => {
    const locked = join(home, 'locked');
    put(join(locked, 'admin-token'));
    chmodSync(locked, 0o000);
    try {
      assert.equal(sameFile(join(locked, 'admin-token'), join(locked, 'admin-token')), false);
      assert.equal(sameFile(join(locked, 'admin-token'), join(home, 'other')), false);
      assert.equal(sameFile(join(locked, 'missing', 'admin-token'), join(home, 'other')), false);
    } finally {
      chmodSync(locked, 0o700);
    }
  }));

  test('device and inode are compared as bigints: ids that collide as JS numbers stay apart', () => {
    const big = 2n ** 60n;
    assert.equal(Number(big), Number(big + 1n), 'the two ids are one JS number');
    const asked = [];
    const fakeStat = (ids) => (path, options) => {
      asked.push(options);
      return { dev: 7n, ino: ids[path] };
    };
    assert.equal(sameFile('a', 'b', fakeStat({ a: big, b: big + 1n })), false);
    assert.equal(sameFile('a', 'b', fakeStat({ a: big + 1n, b: big + 1n })), true);
    assert.ok(asked.every((o) => o.bigint === true), 'stat is asked for bigints');
    assert.equal(sameFile('a', 'b', () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }), false);
  });
});

describe('adminTokenPaths', () => {
  test('ADMIN_TOKEN_FILE: resolved, explicit, no legacy', () => withHome((home) => {
    assert.deepEqual(adminTokenPaths({ ADMIN_TOKEN_FILE: 'rel/admin-token', XDG_CONFIG_HOME: join(home, 'xdg') }, home), { path: resolve('rel/admin-token'), legacy: null, explicit: true });
  }));

  test('empty-string variables count as unset', () => withHome((home) => {
    const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
    assert.deepEqual(adminTokenPaths({ ADMIN_TOKEN_FILE: '', CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: '' }, home), { path: legacy, legacy: null, explicit: false });
    const xdg = join(home, 'xdg');
    assert.deepEqual(adminTokenPaths({ ADMIN_TOKEN_FILE: '', CADDIE_ADMIN_HOME: '', XDG_CONFIG_HOME: xdg }, home), { path: join(xdg, 'conference-caddie', 'admin-token'), legacy, explicit: false });
    assert.deepEqual(adminTokenPaths({ ADMIN_TOKEN_FILE: '', CADDIE_ADMIN_HOME: join(home, 'cah'), XDG_CONFIG_HOME: '' }, home), { path: join(home, 'cah', 'admin-token'), legacy, explicit: false });
    assert.equal(defaultAdminTokenFile({ ADMIN_TOKEN_FILE: join(home, 'x'), XDG_CONFIG_HOME: xdg }, home), join(xdg, 'conference-caddie', 'admin-token'), 'the default ignores ADMIN_TOKEN_FILE');
  }));

  test('legacy is null when it is the same file or location as path, and the old path otherwise', () => withHome((home) => {
    const xdg = join(home, 'xdg');
    const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
    assert.equal(adminTokenPaths({ XDG_CONFIG_HOME: xdg }, home).legacy, legacy, 'different and both missing');
    mkdirSync(xdg);
    symlinkSync(xdg, join(home, '.config'), 'dir');
    assert.equal(adminTokenPaths({ XDG_CONFIG_HOME: xdg }, home).legacy, null, 'symlinked ~/.config, file missing');
    put(join(xdg, 'conference-caddie', 'admin-token'));
    assert.equal(adminTokenPaths({ XDG_CONFIG_HOME: xdg }, home).legacy, null, 'symlinked ~/.config, file present');
  }));
});

describe('shellPath', () => {
  test('a path under home keeps ~/ outside the quotes; anything else is single-quoted; a quote is escaped', () => {
    assert.equal(shellPath('/home/op/.config/conference-caddie/admin-token', '/home/op'), "~/'.config/conference-caddie/admin-token'");
    assert.equal(shellPath("/home/op/it's here/$HOME `x`/t", '/home/op'), "~/'it'\\''s here/$HOME `x`/t'");
    assert.equal(shellPath('/srv/caddie/admin-token', '/home/op'), "'/srv/caddie/admin-token'");
    assert.equal(shellPath('/home/opx/t', '/home/op'), "'/home/opx/t'", 'a sibling with the same prefix is not under home');
    assert.equal(shellPath('/home/op/t', '/home/op/'), "~/'t'");
    assert.equal(shellPath('/t', '/'), "'/t'", 'a home of / never turns every path into ~/');
  });

  test('bash reads the quoted word back as the same path', async () => {
    const home = tempHome();
    try {
      const file = join(home, "a b", "it's $HOME `x`", 'admin-token');
      put(file);
      const outside = join(home, 'out side');
      const run = await sh(`test -f ${shellPath(file, home)} && test -f ${shellPath(file, outside)} && echo found`, { HOME: home });
      assert.equal(run.stdout.trim(), 'found', run.stderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function sh(command, env) {
  return run('bash', ['-c', command], env);
}

function run(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// The real smoke, with nothing from this process's environment but PATH. BASE_URL is a name that
// is never contacted: each run stops at a config check first.
const smoke = (env) => run(process.execPath, [SMOKE], { BASE_URL: 'https://caddie-smoke.example.test', SMOKE_API: 'worker', ...env });

describe('scripts/smoke.mjs reads the admin token file caddie-admin reads', { timeout: 120_000 }, () => {
  test('the default <config dir>/admin-token is read against a deployed Worker, with no note', async () => {
    const home = tempHome();
    try {
      put(join(home, '.config', 'conference-caddie', 'admin-token'));
      const r = await smoke({ HOME: home });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      assert.deepEqual(noteLines(r.stdout), []);
      assert.ok(!r.stdout.includes(FAKE) && !r.stderr.includes(FAKE), 'the token is never printed');
      const xdg = join(home, 'xdg');
      put(join(xdg, 'conference-caddie', 'admin-token'));
      rmSync(join(home, '.config'), { recursive: true });
      const viaXdg = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.ok(viaXdg.stdout.includes(SHORT_FAIL), viaXdg.stdout);
      assert.deepEqual(noteLines(viaXdg.stdout), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the old path is read when the config dir has no token file, with exactly one NOTE line', async () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      put(legacy);
      const r = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      assert.deepEqual(noteLines(r.stdout), [`NOTE admin token: ${join(xdg, 'conference-caddie', 'admin-token')} does not exist, so the old path ${legacy} was read; move the file to ${join(xdg, 'conference-caddie', 'admin-token')}, where caddie-admin reads it`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('~/.config symlinked to $XDG_CONFIG_HOME: the token is read and no note points at it', async () => {
    const home = tempHome();
    try {
      const xdg = join(home, 'xdg');
      put(join(xdg, 'conference-caddie', 'admin-token'));
      symlinkSync(xdg, join(home, '.config'), 'dir');
      const r = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      assert.deepEqual(noteLines(r.stdout), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A directory where the token file should be cannot be read: a run that reads the default file
  // stops with "cannot be read", and one that does not stops at the bad SMOKE_TALKS checked after
  // the token instead. Neither sends a request.
  test('precedence and scope: ADMIN_TOKEN, then ADMIN_TOKEN_FILE, then the default file, and that only for a signed run against a deployed Worker', async () => {
    const home = tempHome();
    try {
      const unreadable = join(home, '.config', 'conference-caddie', 'admin-token');
      mkdirSync(unreadable, { recursive: true });
      const READ = `FAIL config: the admin token file ${unreadable} cannot be read`;
      const NOT_READ = 'FAIL config: SMOKE_TALKS must be bundle or data';
      const cases = [
        [{}, READ],
        [{ SMOKE_ADMIN_AUTH: 'signed' }, READ],
        [{ ADMIN_TOKEN: FAKE }, SHORT_FAIL],
        [{ ADMIN_TOKEN_FILE: join(home, 'missing') }, 'FAIL config: ADMIN_TOKEN_FILE cannot be read'],
        [{ SMOKE_API: '', API_BASE: 'https://api.caddie-smoke.example.test' }, READ],
        [{ BASE_URL: 'http://127.0.0.1:9', SMOKE_TREAT_AS_REMOTE: '1' }, READ],
        [{ SMOKE_API: 'cloudrun' }, NOT_READ],
        [{ SMOKE_API: '' }, NOT_READ],
        [{ BASE_URL: 'http://127.0.0.1:9' }, NOT_READ],
        [{ BASE_URL: 'http://localhost:9', API_BASE: 'http://127.0.0.1:9', SMOKE_API: '' }, NOT_READ],
        // Bearer would send the token itself, so a file nobody named is never used for it.
        [{ SMOKE_ADMIN_AUTH: 'bearer' }, NOT_READ],
        [{ SMOKE_ADMIN_AUTH: 'bearer', ADMIN_TOKEN_FILE: join(home, 'missing') }, 'FAIL config: ADMIN_TOKEN_FILE cannot be read'],
      ];
      for (const [env, expected] of cases) {
        const r = await smoke({ HOME: home, SMOKE_TALKS: 'bogus', ...env });
        assert.equal(r.code, 1, `${JSON.stringify(env)}: ${r.stdout}`);
        assert.ok(r.stdout.includes(expected), `${JSON.stringify(env)}: expected ${expected}\n${r.stdout}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
