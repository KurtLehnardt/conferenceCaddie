// Parity between the Worker scripts' token file module (worker/ingest/admin-token-file.mjs) and the
// shared one that the smoke and caddie-admin use (scripts/lib/admin-token-file.mjs). The Worker
// module builds on the shared one, and this test keeps it that way: over every layout below, in
// scratch directories, both must agree on the resolved path, on whether there is an old place to
// fall back to, on whether the two paths are proven one file, and on the file a token comes from.
//
// Every home directory, config directory and token file here is a scratch directory passed in
// explicitly, so the operator's real ~/.config/conference-caddie/admin-token is never read or
// written. No test prints a token.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as worker from '../ingest/admin-token-file.mjs';
import * as shared from '../../scripts/lib/admin-token-file.mjs';

const TOKEN = 'd5'.repeat(32);
const OTHER = 'e6'.repeat(32);
const ORIGIN = 'https://caddie.example';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-token-parity-'));
  const locked = [];
  t.after(() => {
    for (const path of locked) chmodSync(path, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, 'home');
  mkdirSync(home);
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, { mode: 0o600 });
    return path;
  };
  // A directory that cannot be searched, opened again before the scratch directory is removed.
  const lock = (path) => {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o000);
    locked.push(path);
  };
  const xdg = join(dir, 'xdg');
  const caddie = join(dir, 'caddie');
  return {
    dir, home, put, lock, xdg, caddie,
    old: join(home, '.config', 'conference-caddie', 'admin-token'),
    xdgFile: join(xdg, 'conference-caddie', 'admin-token'),
    caddieFile: join(caddie, 'admin-token'),
  };
}

const config = (api) => JSON.stringify({ backends: { live: { tier: 2, api } } });

// Each layout sets up the scratch directories and returns the environment, with what both modules
// must say: the path, whether there is an old place (legacy), and whether the path and the old
// place are proven one file (same). A layout that sets from also says which file both modules must
// take a token from for ORIGIN (null for none); the config.json layouts set it, so a change to the
// rule that makes one module accept a config.json the other refuses fails here, and so does a
// change that makes both accept it.
const LAYOUTS = {
  'no variables, nothing on disk': (s) => ({ env: {}, path: s.old, legacy: false, same: true }),
  'no variables, the old file there': (s) => {
    s.put(s.old, TOKEN);
    return { env: {}, path: s.old, legacy: false, same: true };
  },
  'XDG_CONFIG_HOME set, neither file there': (s) => ({ env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false }),
  'XDG_CONFIG_HOME set, only the new file there (the old one missing)': (s) => {
    s.put(s.xdgFile, TOKEN);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, only the old file there (the new one missing)': (s) => {
    s.put(s.old, TOKEN);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, both files with differing contents': (s) => {
    s.put(s.old, OTHER);
    s.put(s.xdgFile, TOKEN);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, both files with the same contents': (s) => {
    s.put(s.old, TOKEN);
    s.put(s.xdgFile, `${TOKEN}\n`);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, the old file unreadable': (s) => {
    chmodSync(s.put(s.old, OTHER), 0o000);
    s.put(s.xdgFile, TOKEN);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, the new file unreadable': (s) => {
    s.put(s.old, OTHER);
    chmodSync(s.put(s.xdgFile, TOKEN), 0o000);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, only the old file there, unreadable': (s) => {
    chmodSync(s.put(s.old, TOKEN), 0o000);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, only the old file there, and its config.json lists another origin': (s) => {
    s.put(s.old, TOKEN);
    s.put(join(dirname(s.old), 'config.json'), config('https://other.example'));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: null };
  },
  'XDG_CONFIG_HOME set, only the old file there, and its config.json lists the origin': (s) => {
    s.put(s.old, TOKEN);
    s.put(join(dirname(s.old), 'config.json'), config(ORIGIN));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: s.old };
  },
  // The config.json sub-rule that a config which lists nothing refuses the fallback: a file that is
  // not valid JSON, one with only a tier 3 backend (whose api is the origin), and one whose tier 2
  // api has a path under the origin all list no tier 2 origin, so neither module reads the old file.
  'XDG_CONFIG_HOME set, only the old file there, and its config.json is not valid JSON': (s) => {
    s.put(s.old, TOKEN);
    s.put(join(dirname(s.old), 'config.json'), `{ "backends": { "live": { "tier": 2, "api": "${ORIGIN}" }`);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: null };
  },
  'XDG_CONFIG_HOME set, only the old file there, and its config.json has a tier 3 backend only': (s) => {
    s.put(s.old, TOKEN);
    s.put(join(dirname(s.old), 'config.json'), JSON.stringify({ backends: { paid: { tier: 3, es_url: 'https://es.caddie.example', api: ORIGIN } } }));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: null };
  },
  'XDG_CONFIG_HOME set, only the old file there, and its config.json has a tier 2 api with a path': (s) => {
    s.put(s.old, TOKEN);
    s.put(join(dirname(s.old), 'config.json'), config(`${ORIGIN}/base`));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: null };
  },
  // sameFile cannot stat the old place when ~/.config cannot be searched, so its false means "not
  // proven the same": both modules keep the old place, and neither reads it.
  'XDG_CONFIG_HOME set, ~/.config cannot be searched, the new file there': (s) => {
    s.put(s.xdgFile, TOKEN);
    s.lock(join(s.home, '.config'));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false };
  },
  'XDG_CONFIG_HOME set, ~/.config cannot be searched, the new file missing': (s) => {
    s.lock(join(s.home, '.config'));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: true, same: false, from: null };
  },
  'CADDIE_ADMIN_HOME set, only the new file there (the old one missing)': (s) => {
    s.put(s.caddieFile, TOKEN);
    return { env: { CADDIE_ADMIN_HOME: s.caddie, XDG_CONFIG_HOME: s.xdg }, path: s.caddieFile, legacy: false, same: false };
  },
  'CADDIE_ADMIN_HOME set, only the old file there (the new one missing)': (s) => {
    s.put(s.old, TOKEN);
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: false };
  },
  'CADDIE_ADMIN_HOME set, both files with differing contents': (s) => {
    s.put(s.old, OTHER);
    s.put(s.caddieFile, TOKEN);
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: false };
  },
  'CADDIE_ADMIN_HOME set, the new file unreadable': (s) => {
    chmodSync(s.put(s.caddieFile, TOKEN), 0o000);
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: false };
  },
  'ADMIN_TOKEN_FILE set, with the old file there': (s) => {
    s.put(s.old, OTHER);
    const named = s.put(join(s.dir, 'named', 'token'), TOKEN);
    return { env: { ADMIN_TOKEN_FILE: named, CADDIE_ADMIN_HOME: s.caddie, XDG_CONFIG_HOME: s.xdg }, path: named, legacy: false, same: false };
  },
  'ADMIN_TOKEN_FILE set to a missing file': (s) => {
    s.put(s.old, OTHER);
    return { env: { ADMIN_TOKEN_FILE: join(s.dir, 'missing') }, path: join(s.dir, 'missing'), legacy: false, same: false };
  },
  'ADMIN_TOKEN_FILE set to the old file': (s) => {
    s.put(s.old, TOKEN);
    return { env: { ADMIN_TOKEN_FILE: s.old, XDG_CONFIG_HOME: s.xdg }, path: s.old, legacy: false, same: true };
  },
  '~/.config symlinked to $XDG_CONFIG_HOME, before the file exists': (s) => {
    mkdirSync(s.xdg);
    symlinkSync(s.xdg, join(s.home, '.config'));
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: false, same: true };
  },
  '~/.config symlinked to $XDG_CONFIG_HOME, with the file': (s) => {
    mkdirSync(s.xdg);
    symlinkSync(s.xdg, join(s.home, '.config'));
    s.put(s.xdgFile, TOKEN);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: false, same: true };
  },
  '~/.config/conference-caddie symlinked to $CADDIE_ADMIN_HOME, before the file exists': (s) => {
    mkdirSync(s.caddie);
    mkdirSync(join(s.home, '.config'));
    symlinkSync(s.caddie, join(s.home, '.config', 'conference-caddie'));
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: true };
  },
  '~/.config/conference-caddie symlinked to $CADDIE_ADMIN_HOME, with the file': (s) => {
    mkdirSync(s.caddie);
    mkdirSync(join(s.home, '.config'));
    symlinkSync(s.caddie, join(s.home, '.config', 'conference-caddie'));
    s.put(s.caddieFile, TOKEN);
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: true };
  },
  'the old file a hard link to $XDG_CONFIG_HOME/conference-caddie/admin-token': (s) => {
    s.put(s.xdgFile, TOKEN);
    mkdirSync(dirname(s.old), { recursive: true });
    linkSync(s.xdgFile, s.old);
    return { env: { XDG_CONFIG_HOME: s.xdg }, path: s.xdgFile, legacy: false, same: true };
  },
  'the old file a hard link to $CADDIE_ADMIN_HOME/admin-token': (s) => {
    s.put(s.caddieFile, TOKEN);
    mkdirSync(dirname(s.old), { recursive: true });
    linkSync(s.caddieFile, s.old);
    return { env: { CADDIE_ADMIN_HOME: s.caddie }, path: s.caddieFile, legacy: false, same: true };
  },
};

// The file a token comes from: the Worker module's path when it read a value there, and the shared
// module's file when it can be read.
function readable(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('worker/ingest/admin-token-file.mjs and scripts/lib/admin-token-file.mjs agree', () => {
  test('the Worker module uses the shared sameFile, not a copy', () => {
    assert.equal(worker.sameFile, shared.sameFile);
  });

  for (const [name, make] of Object.entries(LAYOUTS)) {
    test(name, (t) => {
      const s = scratch(t);
      const want = make(s);
      const { env } = want;
      const old = shared.legacyAdminTokenFile(s.home);

      const w = worker.adminTokenFile(env, s.home);
      const p = shared.adminTokenPaths(env, s.home);
      assert.equal(w.path, want.path, 'the Worker path');
      assert.equal(p.path, want.path, 'the shared path');
      assert.equal(w.legacy !== null, want.legacy, 'the Worker legacy');
      assert.equal(p.legacy !== null, want.legacy, 'the shared legacy');
      if (want.legacy) assert.equal(w.legacy, p.legacy);
      assert.equal(worker.sameFile(w.path, old), want.same, 'the Worker sameFile');
      assert.equal(shared.sameFile(p.path, old), want.same, 'the shared sameFile');

      const read = worker.adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN });
      const { file } = shared.resolveAdminTokenFile(env, { home: s.home, apiOrigin: ORIGIN });
      const workerFrom = read.value === null ? null : read.path;
      const sharedFrom = file && readable(file) ? file : null;
      assert.equal(workerFrom, sharedFrom, 'the file a token comes from');
      if ('from' in want) assert.equal(workerFrom, want.from, 'the file both modules take a token from');
      for (const value of [TOKEN, OTHER]) assert.ok(!`${read.note}\n${read.doubt}`.includes(value), 'no value in a note');
    });
  }

  // With no variable set the path and the old place are the same string. sameFile cannot stat it
  // when ~/.config cannot be searched, so both modules count two equal path strings as one path and
  // report no old place. Both nulls are checked strictly, because without that guard a module
  // would report an old place, and compare or note a file against itself, for an operator with no
  // variable set.
  test('no variables, ~/.config cannot be searched: no other file to fall back to', (t) => {
    const s = scratch(t);
    s.lock(join(s.home, '.config'));
    const w = worker.adminTokenFile({}, s.home);
    const p = shared.adminTokenPaths({}, s.home);
    assert.equal(w.path, s.old);
    assert.equal(p.path, s.old);
    assert.equal(w.legacy, null, 'the Worker module reports no old place');
    assert.equal(p.legacy, null, 'the shared module reports no old place');
    assert.deepEqual(shared.resolveAdminTokenFile({}, { home: s.home, apiOrigin: ORIGIN }), { file: s.old, note: null }, 'the shared reader names the one path, so its read fails and says so');
    const read = worker.adminTokenFileToRead({}, s.home);
    assert.equal(read.legacy, null, 'the Worker reader reports no old place');
    assert.equal(read.note, null, 'no note for an operator with no variable set');
    assert.equal(read.trusted, true);
  });

  // The fallback fails closed in both modules: when the old place cannot be checked, neither reads
  // it, and each says that it cannot be checked rather than that nothing is there.
  test('XDG_CONFIG_HOME set, ~/.config cannot be searched, the new file missing: both refuse with a "cannot be checked" note', (t) => {
    const s = scratch(t);
    s.lock(join(s.home, '.config'));
    const env = { XDG_CONFIG_HOME: s.xdg };
    const read = worker.adminTokenFileToRead(env, s.home, { apiOrigin: ORIGIN });
    const shared1 = shared.resolveAdminTokenFile(env, { home: s.home, apiOrigin: ORIGIN });
    assert.equal(read.value, null);
    assert.equal(shared1.file, null, 'the shared module reads nothing');
    assert.match(`${read.note}\n${read.doubt}`, /cannot be checked/);
    assert.match(shared1.note, /^NOTE admin token: .* is not read, because it cannot be checked/);
    assert.ok(shared1.note.includes(s.old) && shared1.note.includes(s.xdgFile));
  });
});
