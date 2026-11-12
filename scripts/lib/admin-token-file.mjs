// Where the Worker's admin token file is on the operator's computer, for scripts/smoke.mjs and for
// the smoke command that `caddie-admin stats health` prints.
//
// The caddie-admin CLI reads <config dir>/admin-token (scripts/admin/config.mjs configDir:
// CADDIE_ADMIN_HOME, else $XDG_CONFIG_HOME/conference-caddie, else ~/.config/conference-caddie),
// and ADMIN_TOKEN_FILE replaces that path. The token used to live at
// ~/.config/conference-caddie/admin-token whatever XDG_CONFIG_HOME said (worker/scripts/setup-secrets.mjs
// still writes it there), so when the config directory has no token file the smoke reads that old
// file and says so. Paths are printed; a token value never is.

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { configDir } from '../admin/config.mjs';

// Where a path is, symlinks resolved, whether or not it exists yet: the real path of its nearest
// existing ancestor with the missing segments joined back on. A symlinked ~/.config or
// conference-caddie directory is then the same location before the token file is written.
// Throws on anything but a missing segment (ENOENT, ENOTDIR).
function location(path) {
  let dir = resolve(path);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch (err) {
      const parent = dirname(dir);
      if ((err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') || parent === dir) throw err;
      rest.unshift(basename(dir));
      dir = parent;
    }
  }
}

// Whether two paths name the same file. Both exist: the same device and inode, read as bigints
// (a Windows file id does not fit in a JS number), so a symlinked directory and a hard link count.
// One or both missing: the same location (above). Any other error (a directory that cannot be
// searched): false. `stat` is for the tests.
export function sameFile(a, b, stat = statSync) {
  try {
    const sa = stat(a, { bigint: true, throwIfNoEntry: false });
    const sb = stat(b, { bigint: true, throwIfNoEntry: false });
    if (sa && sb) return sa.dev === sb.dev && sa.ino === sb.ino;
    return location(a) === location(b);
  } catch {
    return false;
  }
}

// The old location, and the default when none of the variables is set.
export function legacyAdminTokenFile(home = homedir()) {
  return resolve(home, '.config', 'conference-caddie', 'admin-token');
}

// The admin token paths, without reading anything but the file system's metadata:
// - path: ADMIN_TOKEN_FILE resolved when it is non-empty, else <config dir>/admin-token resolved
//   (configDir of scripts/admin/config.mjs, where an empty variable counts as unset);
// - legacy: the old ~/.config/conference-caddie/admin-token when ADMIN_TOKEN_FILE is unset and it is
//   not the same file or location as path (sameFile), else null;
// - explicit: whether ADMIN_TOKEN_FILE was set (non-empty).
export function adminTokenPaths(env = process.env, home = homedir()) {
  const explicit = Boolean(env.ADMIN_TOKEN_FILE);
  const path = explicit ? resolve(env.ADMIN_TOKEN_FILE) : resolve(configDir(env, home), 'admin-token');
  const old = legacyAdminTokenFile(home);
  const legacy = !explicit && !sameFile(path, old) ? old : null;
  return { path, legacy, explicit };
}

// The file the CLI reads when ADMIN_TOKEN_FILE is unset.
export function defaultAdminTokenFile(env, home = homedir()) {
  return adminTokenPaths({ ...env, ADMIN_TOKEN_FILE: '' }, home).path;
}

// The token file the smoke reads: ADMIN_TOKEN_FILE if set; otherwise <config dir>/admin-token;
// otherwise, when that file does not exist, the old ~/.config/conference-caddie/admin-token.
// Returns { file, note }: file is null when ADMIN_TOKEN_FILE is unset and neither file exists, and
// note is one NOTE line for the operator (the old file was read, or a different old file is still
// there) or null. The old path is only ever considered when adminTokenPaths found it to be another
// file or location than path, so no note points at the file in use.
export function resolveAdminTokenFile(env, home = homedir()) {
  const { path, legacy, explicit } = adminTokenPaths(env, home);
  if (explicit) return { file: path, note: null };
  let current;
  try {
    current = statSync(path, { throwIfNoEntry: false });
  } catch {
    // There, but not even stat-able (a directory on the way is not searchable): reading it reports that.
    return { file: path, note: null };
  }
  if (!legacy) return { file: current ? path : null, note: null };
  let old;
  try {
    old = statSync(legacy, { throwIfNoEntry: false });
  } catch {
    old = undefined;
  }
  if (!current) {
    if (!old) return { file: null, note: null };
    return { file: legacy, note: `NOTE admin token: ${path} does not exist, so the old path ${legacy} was read; move the file to ${path}, where caddie-admin reads it` };
  }
  if (old) return { file: path, note: `NOTE admin token: read ${path}; the old path ${legacy} is a different file and is not read; keep only one of the two` };
  return { file: path, note: null };
}

// A path as a POSIX shell word that survives copy and paste: a path under the home directory as
// ~/'<rest>' (the tilde stays outside the quotes so the shell expands it), any other path
// single-quoted, a single quote inside written as '\''.
export function shellPath(path, home = homedir()) {
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  if (home !== sep && path.startsWith(prefix) && path.length > prefix.length) return `~/${quote(path.slice(prefix.length))}`;
  return quote(path);
}
