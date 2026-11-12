// Where the Worker's admin token file is on the operator's computer, for scripts/smoke.mjs, for the
// smoke command that `caddie-admin stats health` prints, and for worker/scripts/setup-secrets.mjs.
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
import { configDir, loadConfig } from '../admin/config.mjs';

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

// The origins of the tier 2 (Worker) backends in caddie-admin's config.json, which loadConfig has
// checked are https (or http to this machine); none when the file is missing or not valid. The
// smoke reads the token file by itself only for one of these (scripts/smoke.mjs).
export function configuredWorkerOrigins(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return [];
  }
  return Object.values(config.backends).filter((b) => b.tier === 2).map((b) => new URL(b.api).origin);
}

// statSync that tells "no such file" (stat undefined: ENOENT, ENOTDIR) from any other failure.
function look(path) {
  try {
    return { stat: statSync(path, { throwIfNoEntry: false }) };
  } catch (error) {
    return { error };
  }
}

// The token file the smoke reads when ADMIN_TOKEN_FILE is unset: <config dir>/admin-token; when that
// does not exist, the old ~/.config/conference-caddie/admin-token. A path whose stat fails for any
// other reason (a directory that cannot be searched, a symlink loop) is returned as it is, so the
// read fails and names it. Returns { file, note }: file is null when neither exists; note is one
// NOTE line to print once the file was read, or null. It never suggests deleting a token file: the
// old path is where worker/scripts/setup-secrets.mjs writes a rotated token, so after a rotation
// it can hold the newer one. The old path is considered only when adminTokenPaths found it to be
// another file or location than the config dir's, so a note never names the file in use twice.
export function resolveAdminTokenFile(env, home = homedir()) {
  const { path, legacy, explicit } = adminTokenPaths(env, home);
  if (explicit) return { file: path, note: null };
  const current = look(path);
  if (current.error) return { file: path, note: null };
  if (!legacy) return { file: current.stat ? path : null, note: null };
  const old = look(legacy);
  if (current.stat) {
    if (!old.stat) return { file: path, note: null };
    const a = current.stat.mtimeMs;
    const b = old.stat.mtimeMs;
    const newer = a === b ? 'Both have the same modification time.' : `By modification time the newer is ${a > b ? path : legacy}.`;
    return { file: path, note: `NOTE admin token: read ${path}; the old path ${legacy} is a different file and is not read. Do not delete either until you know which one the Worker accepts: worker/scripts/setup-secrets.mjs writes ${legacy}. ${newer}` };
  }
  if (old.error) return { file: legacy, note: null };
  if (!old.stat) return { file: null, note: null };
  return { file: legacy, note: `NOTE admin token: ${path} does not exist, so the old path ${legacy} was read. Move it to ${path} and leave a symlink at the old path (ln -s ${shellPath(path, home)} ${shellPath(legacy, home)}), so caddie-admin and worker/scripts/setup-secrets.mjs use one file.` };
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
