// Where scripts/smoke.mjs finds the Worker's admin token when neither ADMIN_TOKEN nor
// ADMIN_TOKEN_FILE is set: the file caddie-admin reads (<config dir>/admin-token), else the old
// ~/.config/conference-caddie/admin-token with one NOTE line, and no note when both paths are the
// same file. The resolver is tested directly, then the real smoke is run with fake short tokens: a
// token it read stops it at the "at least 32 characters" check, before any request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenPaths, configuredWorkerOrigins, defaultAdminTokenFile, legacyAdminTokenFile, resolveAdminTokenFile, sameFile, shellPath } from '../scripts/lib/admin-token-file.mjs';

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
const asRoot = process.getuid?.() === 0;
// A note must never tell the operator to remove a token file: the old path is where
// worker/scripts/setup-secrets.mjs writes a rotated token.
const NEVER_IN_A_NOTE = /\b(remove|keep only one)\b|\bdelete (it|the|one)\b|\brm /i;

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

  test('the config dir has no token file but the old path has one: the old file, with a note to move it and leave a symlink', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      put(legacy);
      for (const env of [{ XDG_CONFIG_HOME: join(home, 'x dg') }, { CADDIE_ADMIN_HOME: join(home, 'cah') }]) {
        const wanted = defaultAdminTokenFile(env, home);
        const { file, note } = resolveAdminTokenFile(env, home);
        assert.equal(file, legacy);
        assert.equal(note, `NOTE admin token: ${wanted} does not exist, so the old path ${legacy} was read. Move it to ${wanted} and leave a symlink at the old path (ln -s ${shellPath(wanted, home)} ${shellPath(legacy, home)}), so caddie-admin and worker/scripts/setup-secrets.mjs use one file.`);
        assert.ok(!note.includes(FAKE));
        assert.doesNotMatch(note, NEVER_IN_A_NOTE);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('both paths hold different files: the config dir one is read, and the note names the newer and deletes nothing', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      const current = join(xdg, 'conference-caddie', 'admin-token');
      put(legacy, 'fake-old\n');
      put(current, 'fake-new\n');
      utimesSync(legacy, 1_700_000_000, 1_700_000_000);
      utimesSync(current, 1_800_000_000, 1_800_000_000);
      const { file, note } = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home);
      assert.equal(file, current);
      assert.equal(note, `NOTE admin token: read ${current}; the old path ${legacy} is a different file and is not read. Do not delete either until you know which one the Worker accepts: worker/scripts/setup-secrets.mjs writes ${legacy}. By modification time the newer is ${current}.`);
      assert.doesNotMatch(note, NEVER_IN_A_NOTE);
      utimesSync(legacy, 1_800_000_000, 1_800_000_000);
      assert.match(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home).note, /Both have the same modification time\.$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The critic's case g: setup-secrets.mjs rotated the token into the old path, so the config dir
  // holds the stale one. The note must not lead the operator to delete the live (old-path) file.
  test('case g, after a rotation: the old path holds the live token; the note names it the newer and says delete neither', () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      const current = join(xdg, 'conference-caddie', 'admin-token');
      put(current, 'fake-OLD\n');
      put(legacy, 'fake-NEW-live\n');
      utimesSync(current, 1_700_000_000, 1_700_000_000);
      utimesSync(legacy, 1_800_000_000, 1_800_000_000);
      const { file, note } = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home);
      assert.equal(file, current, 'the order stays: the config dir first');
      assert.match(note, /Do not delete either until you know which one the Worker accepts/);
      assert.ok(note.endsWith(`By modification time the newer is ${legacy}.`), note);
      assert.doesNotMatch(note, NEVER_IN_A_NOTE);
      assert.ok(!note.includes('fake-'), 'no token value');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a path whose stat fails for another reason than "missing" is returned, so the read fails and names it', { skip: asRoot ? 'root can search any directory' : false }, () => {
    const home = tempHome();
    const legacyDir = join(home, '.config', 'conference-caddie');
    const xdg = join(home, 'xdg');
    const curDir = join(xdg, 'conference-caddie');
    const locked = [];
    try {
      // a. the config dir cannot be searched; the old file is fine: the config dir file, no note.
      put(join(legacyDir, 'admin-token'));
      put(join(curDir, 'admin-token'));
      chmodSync(curDir, 0o000);
      locked.push(curDir);
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home), { file: join(curDir, 'admin-token'), note: null });
      chmodSync(curDir, 0o700);
      locked.pop();
      // c. the old dir cannot be searched and the config dir has no file: the old path, no note.
      rmSync(join(curDir, 'admin-token'));
      chmodSync(legacyDir, 0o000);
      locked.push(legacyDir);
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home), { file: join(legacyDir, 'admin-token'), note: null });
      // b. the old dir cannot be searched and the config dir file is fine: that file, no note.
      put(join(curDir, 'admin-token'));
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home), { file: join(curDir, 'admin-token'), note: null });
      chmodSync(legacyDir, 0o700);
      locked.pop();
      // j. a symlink loop at the config dir path: that path, no note.
      rmSync(join(curDir, 'admin-token'));
      symlinkSync(join(curDir, 'admin-token'), join(curDir, 'admin-token'));
      assert.deepEqual(resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home), { file: join(curDir, 'admin-token'), note: null });
    } finally {
      for (const d of locked) chmodSync(d, 0o700);
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
const WORKER = 'https://caddie-smoke.example.test';
const smoke = (env) => run(process.execPath, [SMOKE], { BASE_URL: WORKER, SMOKE_API: 'worker', ...env });
// caddie-admin's config.json in `dir`, naming WORKER as a tier 2 backend unless `backends` says otherwise.
const writeConfig = (dir, backends = { live: { tier: 2, api: WORKER } }) => put(join(dir, 'config.json'), JSON.stringify({ default: Object.keys(backends)[0], backends }));

describe('configuredWorkerOrigins', () => {
  test('the origins of the tier 2 backends; none without a valid config.json', () => withHome((home) => {
    const dir = join(home, '.config', 'conference-caddie');
    assert.deepEqual(configuredWorkerOrigins({ HOME: home, CADDIE_ADMIN_HOME: dir }), []);
    writeConfig(dir, { a: { tier: 2, api: 'https://A.example.test:443' }, b: { tier: 3, es_url: 'https://es.example.test', api: 'https://run.example.test' }, c: { tier: 2, api: 'http://127.0.0.1:8787' } });
    assert.deepEqual(configuredWorkerOrigins({ CADDIE_ADMIN_HOME: dir }), ['https://a.example.test', 'http://127.0.0.1:8787']);
    put(join(dir, 'config.json'), '{ not json');
    assert.deepEqual(configuredWorkerOrigins({ CADDIE_ADMIN_HOME: dir }), []);
    writeConfig(dir, { a: { tier: 2, api: 'http://plain.example.test' } });
    assert.deepEqual(configuredWorkerOrigins({ CADDIE_ADMIN_HOME: dir }), [], 'plain http to another host is refused by loadConfig');
  }));
});

describe('scripts/smoke.mjs reads the admin token file caddie-admin reads', { timeout: 180_000 }, () => {
  test('the default <config dir>/admin-token is read for the configured Worker, with no note', async () => {
    const home = tempHome();
    try {
      writeConfig(join(home, '.config', 'conference-caddie'));
      put(join(home, '.config', 'conference-caddie', 'admin-token'));
      const r = await smoke({ HOME: home });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      assert.deepEqual(noteLines(r.stdout), []);
      assert.ok(!r.stdout.includes(FAKE) && !r.stderr.includes(FAKE), 'the token is never printed');
      const xdg = join(home, 'xdg');
      writeConfig(join(xdg, 'conference-caddie'));
      put(join(xdg, 'conference-caddie', 'admin-token'));
      rmSync(join(home, '.config'), { recursive: true });
      const viaXdg = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.ok(viaXdg.stdout.includes(SHORT_FAIL), viaXdg.stdout);
      assert.deepEqual(noteLines(viaXdg.stdout), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the old path is read when the config dir has no token file, with exactly one NOTE line after the read', async () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      const wanted = join(xdg, 'conference-caddie', 'admin-token');
      writeConfig(join(xdg, 'conference-caddie'));
      put(legacy);
      const r = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      assert.deepEqual(noteLines(r.stdout), [`NOTE admin token: ${wanted} does not exist, so the old path ${legacy} was read. Move it to ${wanted} and leave a symlink at the old path (ln -s ~/'xdg/conference-caddie/admin-token' ~/'.config/conference-caddie/admin-token'), so caddie-admin and worker/scripts/setup-secrets.mjs use one file.`]);
      // A file caddie-admin would refuse (mode 0644) fails the run naming it, and no note is printed.
      chmodSync(legacy, 0o644);
      const loose = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.equal(loose.code, 1, loose.stdout);
      assert.ok(loose.stdout.includes(`FAIL config: credential file ${legacy} has mode 0644; only the owner may read it, run chmod 600 on it`), loose.stdout);
      assert.deepEqual(noteLines(loose.stdout), [], 'the note only follows a read that worked');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('~/.config symlinked to $XDG_CONFIG_HOME: the token is read and no note points at it', async () => {
    const home = tempHome();
    try {
      const xdg = join(home, 'xdg');
      writeConfig(join(xdg, 'conference-caddie'));
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

  test('case g after a rotation: the config dir file is read, and the note deletes nothing and names the old path as newer', async () => {
    const home = tempHome();
    try {
      const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
      const xdg = join(home, 'xdg');
      writeConfig(join(xdg, 'conference-caddie'));
      put(join(xdg, 'conference-caddie', 'admin-token'), 'fake-OLD\n');
      put(legacy, 'fake-NEW-live\n');
      utimesSync(join(xdg, 'conference-caddie', 'admin-token'), 1_700_000_000, 1_700_000_000);
      utimesSync(legacy, 1_800_000_000, 1_800_000_000);
      const r = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.ok(r.stdout.includes(SHORT_FAIL), r.stdout);
      const notes = noteLines(r.stdout);
      assert.equal(notes.length, 1, r.stdout);
      assert.match(notes[0], /Do not delete either until you know which one the Worker accepts/);
      assert.ok(notes[0].endsWith(`By modification time the newer is ${legacy}.`), notes[0]);
      assert.doesNotMatch(notes[0], NEVER_IN_A_NOTE);
      assert.ok(!r.stdout.includes('fake-'), 'no token value');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the old dir cannot be searched and the config dir has no file: the run fails naming the old path', { skip: asRoot ? 'root can search any directory' : false }, async () => {
    const home = tempHome();
    const legacyDir = join(home, '.config', 'conference-caddie');
    try {
      const xdg = join(home, 'xdg');
      writeConfig(join(xdg, 'conference-caddie'));
      put(join(legacyDir, 'admin-token'));
      chmodSync(legacyDir, 0o000);
      const r = await smoke({ HOME: home, XDG_CONFIG_HOME: xdg });
      assert.equal(r.code, 1, r.stdout);
      assert.ok(r.stdout.includes(`FAIL config: no credential: set ADMIN_TOKEN, or put it in ${join(legacyDir, 'admin-token')}`), r.stdout);
      assert.deepEqual(noteLines(r.stdout), []);
    } finally {
      chmodSync(legacyDir, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The default file has mode 0644, which caddie-admin's checks refuse: a run that reads it stops
  // with that, naming the file, and one that does not stops at the bad SMOKE_TALKS checked after the
  // token instead. Neither sends a request.
  test('scope: the default file only for a signed run whose API_BASE origin is a tier 2 api in config.json', async () => {
    const home = tempHome();
    try {
      const dir = join(home, '.config', 'conference-caddie');
      const loose = join(dir, 'admin-token');
      writeConfig(dir, { live: { tier: 2, api: WORKER }, paid: { tier: 3, es_url: 'https://es.example.test', api: 'https://run.example.test' }, local: { tier: 2, api: 'http://127.0.0.1:8787' } });
      put(loose);
      chmodSync(loose, 0o644);
      const READ = `FAIL config: credential file ${loose} has mode 0644`;
      const NOT_READ = 'FAIL config: SMOKE_TALKS must be bundle or data';
      const cases = [
        [{}, READ],
        [{ SMOKE_API: '' }, READ, 'same origin without SMOKE_API: the configured Worker'],
        [{ BASE_URL: 'https://app.example.test/conferenceCaddie', API_BASE: WORKER, SMOKE_API: '' }, READ, 'the app elsewhere, the API the configured Worker'],
        [{ BASE_URL: 'http://127.0.0.1:8787' }, READ, 'a loopback Worker that is in config.json'],
        [{ BASE_URL: 'https://other.example.test' }, NOT_READ, 'a host not in config.json (a typo, a relay)'],
        [{ BASE_URL: `${WORKER}:8443` }, NOT_READ, 'another port is another origin'],
        [{ BASE_URL: 'http://caddie-smoke.example.test' }, NOT_READ, 'http is another origin'],
        [{ API_BASE: 'https://relay.example.test' }, NOT_READ, 'the app is the Worker but the API is not'],
        [{ BASE_URL: 'https://run.example.test' }, NOT_READ, 'a tier 3 api'],
        [{ BASE_URL: 'http://127.0.0.1:9' }, NOT_READ, 'a loopback API not in config.json'],
        [{ SMOKE_API: 'cloudrun' }, NOT_READ],
        [{ SMOKE_ADMIN_AUTH: 'bearer' }, NOT_READ, 'bearer would send the token itself'],
        [{ ADMIN_TOKEN: FAKE }, SHORT_FAIL, 'ADMIN_TOKEN first'],
        [{ ADMIN_TOKEN_FILE: join(home, 'missing') }, 'FAIL config: ADMIN_TOKEN_FILE cannot be read', 'then ADMIN_TOKEN_FILE'],
        [{ ADMIN_TOKEN_FILE: '' }, NOT_READ, 'a set but empty ADMIN_TOKEN_FILE means no token'],
        [{ CADDIE_ADMIN_HOME: join(home, 'empty') }, NOT_READ, 'no config.json in the config dir'],
      ];
      for (const [env, expected, why = ''] of cases) {
        const r = await smoke({ HOME: home, SMOKE_TALKS: 'bogus', ...env });
        assert.equal(r.code, 1, `${why} ${JSON.stringify(env)}: ${r.stdout}`);
        assert.ok(r.stdout.includes(expected), `${why} ${JSON.stringify(env)}: expected ${expected}\n${r.stdout}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// docs/ADMIN_CLI.md quotes the notes and the printed command; the quotes must stay what the code
// writes, with the absolute paths of a home of ~ standing in for the placeholders.
test('docs/ADMIN_CLI.md quotes the notes and the stats health smoke command as the code writes them', () => withHome((home) => {
  const doc = readFileSync(join(ROOT, 'docs', 'ADMIN_CLI.md'), 'utf8');
  const legacy = join(home, '.config', 'conference-caddie', 'admin-token');
  const xdg = join(home, 'xdg');
  const wanted = join(xdg, 'conference-caddie', 'admin-token');
  put(legacy);
  const fallback = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home).note
    .replaceAll(wanted, '<config dir>/admin-token').replaceAll(legacy, '~/.config/conference-caddie/admin-token');
  const quotedFallback = /`(NOTE admin token: [^`]+)`/.exec(doc)?.[1];
  assert.ok(quotedFallback && fallback.startsWith(quotedFallback), `${quotedFallback}\n${fallback}`);
  put(wanted);
  const both = resolveAdminTokenFile({ XDG_CONFIG_HOME: xdg }, home).note;
  assert.ok(doc.includes('`Do not delete either until you know which one the Worker accepts`') && both.includes('Do not delete either until you know which one the Worker accepts'));
  assert.ok(doc.includes(`\`BASE_URL="https://<your worker>" SMOKE_API=worker ADMIN_TOKEN_FILE=${shellPath(legacy, home)} node scripts/smoke.mjs\``));
}));
