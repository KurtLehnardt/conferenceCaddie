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

/**
 * Whether two paths are proven to name the same file.
 *
 * - Both exist: the same device and inode, read with statSync(p, { bigint: true }) because a
 *   Windows file id does not fit in a JS number. A symlinked directory and a hard link count.
 * - One or both missing: the same location, meaning the real path of each path's nearest existing
 *   ancestor with the missing segments joined back on, so a symlinked ~/.config or
 *   conference-caddie directory counts before the file exists.
 * - Any other error (a directory that cannot be searched, a symlink loop): false.
 *
 * false means "not proven the same", never "proven different": a caller that would act on two
 * different files (delete one, warn about one) must not take false as proof. On a case-insensitive
 * file system (macOS by default) a missing path that differs only in letter case is a different
 * location to this check, because realpathSync does not fold case; existing files are compared by
 * inode and are not affected. The answer reflects the file system at the time of the call.
 *
 * @param {string} a
 * @param {string} b
 * @param {typeof statSync} [stat] for the tests
 * @returns {boolean}
 */
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

/**
 * The old token location, ~/.config/conference-caddie/admin-token, resolved. It is also the default
 * when none of CADDIE_ADMIN_HOME, XDG_CONFIG_HOME and ADMIN_TOKEN_FILE is set.
 *
 * @param {string} [home]
 * @returns {string}
 */
export function legacyAdminTokenFile(home = homedir()) {
  return resolve(home, '.config', 'conference-caddie', 'admin-token');
}

/**
 * The admin token paths. It reads no file and prints nothing, but `legacy` depends on the file
 * system at the time of the call (sameFile), so call it again rather than cache the result.
 *
 * - path: ADMIN_TOKEN_FILE resolved when it is non-empty; else <config dir>/admin-token resolved,
 *   the config dir being CADDIE_ADMIN_HOME, else $XDG_CONFIG_HOME/conference-caddie, else
 *   ~/.config/conference-caddie (configDir of scripts/admin/config.mjs). An empty variable counts
 *   as unset.
 * - legacy: the old ~/.config/conference-caddie/admin-token when it may be a stray copy of this
 *   setup's token: ADMIN_TOKEN_FILE and CADDIE_ADMIN_HOME are unset (a CADDIE_ADMIN_HOME is a
 *   separate setup, a fork's for example, whose token is never the old file) and sameFile(path,
 *   old) is false. Otherwise null. Because sameFile's false means "not proven the same", a
 *   non-null legacy can still be the same file in rare cases (an unsearchable directory, a case
 *   difference on macOS).
 * - explicit: whether ADMIN_TOKEN_FILE was set (non-empty).
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 * @returns {{ path: string, legacy: string | null, explicit: boolean }}
 */
export function adminTokenPaths(env = process.env, home = homedir()) {
  const explicit = Boolean(env.ADMIN_TOKEN_FILE);
  const path = explicit ? resolve(env.ADMIN_TOKEN_FILE) : resolve(configDir(env, home), 'admin-token');
  const old = legacyAdminTokenFile(home);
  const legacy = !explicit && !env.CADDIE_ADMIN_HOME && !sameFile(path, old) ? old : null;
  return { path, legacy, explicit };
}

// The file the CLI reads when ADMIN_TOKEN_FILE is unset.
export function defaultAdminTokenFile(env, home = homedir()) {
  return adminTokenPaths({ ...env, ADMIN_TOKEN_FILE: '' }, home).path;
}

// The origins of the tier 2 (Worker) backends in the config.json of env's config dir, which
// loadConfig has checked are https (or http to this machine). An api with a path, a query or a
// fragment is skipped, as workerOrigin of scripts/admin/backends/worker.mjs refuses it. None when
// the file is missing or not valid. The smoke reads a token file by itself only for one of these.
export function configuredWorkerOrigins(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return [];
  }
  const origins = [];
  for (const backend of Object.values(config.backends)) {
    if (backend.tier !== 2) continue;
    const u = new URL(backend.api);
    if (u.pathname === '/' && !u.search && !u.hash) origins.push(u.origin);
  }
  return origins;
}

// statSync that tells "no such file" (stat undefined: ENOENT, ENOTDIR) from any other failure.
function look(path) {
  try {
    return { stat: statSync(path, { throwIfNoEntry: false }) };
  } catch (error) {
    return { error };
  }
}

// The token file the smoke reads when ADMIN_TOKEN_FILE is unset, for a run against apiOrigin:
// <config dir>/admin-token; when that does not exist, the old ~/.config/conference-caddie/admin-token,
// but only where adminTokenPaths offers it (never with CADDIE_ADMIN_HOME set) and, when the old
// directory has its own config.json, only if that file also lists apiOrigin as a tier 2 api, so one
// setup's config never sends another setup's token. A path whose stat fails for another reason than
// "missing" is returned as it is, so the read fails and names it. Returns { file, note }: file is
// null when there is nothing to read; note is one NOTE line (to print after a successful read when
// file is set, at once when it is null) or null. No note suggests deleting a token file: the old
// path is where worker/scripts/setup-secrets.mjs writes a rotated token.
export function resolveAdminTokenFile(env, { home = homedir(), apiOrigin } = {}) {
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
  // Not stat-able (its directory cannot be searched): the read fails the same way and names it.
  if (old.error) return { file: legacy, note: null };
  if (!old.stat) return { file: null, note: null };
  const oldDir = dirname(legacy);
  const oldConfig = look(join(oldDir, 'config.json'));
  if ((oldConfig.stat || oldConfig.error) && !configuredWorkerOrigins({ CADDIE_ADMIN_HOME: oldDir }).includes(apiOrigin)) {
    return { file: null, note: `NOTE admin token: ${path} does not exist, and the old path ${legacy} is not read, because ${join(oldDir, 'config.json')} does not list ${apiOrigin} as a tier 2 api; set ADMIN_TOKEN_FILE to run with a token` };
  }
  return { file: legacy, note: `NOTE admin token: ${path} does not exist, so the old path ${legacy} was read. Move it to ${path} and leave a symlink at the old path (ln -s ${shellPath(path, home)} ${shellPath(legacy, home)}), so caddie-admin and worker/scripts/setup-secrets.mjs use one file.` };
}

// A string as one single-quoted POSIX shell word, a single quote inside written as '\''.
export function shellQuote(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

// A path as a POSIX shell word that survives copy and paste: a path under the home directory as
// ~/'<rest>' (the tilde stays outside the quotes so the shell expands it), any other path
// single-quoted (shellQuote).
export function shellPath(path, home = homedir()) {
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  if (home !== sep && path.startsWith(prefix) && path.length > prefix.length) return `~/${shellQuote(path.slice(prefix.length))}`;
  return shellQuote(path);
}
