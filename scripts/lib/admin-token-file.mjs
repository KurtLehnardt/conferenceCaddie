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
import { resolve, sep } from 'node:path';
import { configDir } from '../admin/config.mjs';

// The file the CLI reads when ADMIN_TOKEN_FILE is unset.
export function defaultAdminTokenFile(env, home = homedir()) {
  return resolve(configDir(env, home), 'admin-token');
}

// The old location, and the default when none of the variables is set.
export function legacyAdminTokenFile(home = homedir()) {
  return resolve(home, '.config', 'conference-caddie', 'admin-token');
}

// Two existing paths name the same file: the same inode (a symlinked directory, a hard link) or
// the same real path. When that cannot be told, they count as the same, so no note ever points at
// the file in use.
function sameFile(a, aStat, b, bStat) {
  if (aStat.ino !== 0 && aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return true;
  }
}

// The token file the smoke reads: ADMIN_TOKEN_FILE if set; otherwise <config dir>/admin-token;
// otherwise, when that file does not exist, the old ~/.config/conference-caddie/admin-token.
// Returns { file, note }: file is null when ADMIN_TOKEN_FILE is unset and neither file exists, and
// note is one NOTE line for the operator (the old file was read, or a different old file is still
// there) or null.
export function resolveAdminTokenFile(env, home = homedir()) {
  if (env.ADMIN_TOKEN_FILE) return { file: env.ADMIN_TOKEN_FILE, note: null };
  const file = defaultAdminTokenFile(env, home);
  const legacy = legacyAdminTokenFile(home);
  let current;
  try {
    current = statSync(file, { throwIfNoEntry: false });
  } catch {
    // There, but not even stat-able (a directory on the way is not searchable): reading it reports that.
    return { file, note: null };
  }
  let old;
  try {
    old = statSync(legacy, { throwIfNoEntry: false });
  } catch {
    old = undefined;
  }
  if (!current) {
    if (!old) return { file: null, note: null };
    return { file: legacy, note: `NOTE admin token: ${file} does not exist, so the old path ${legacy} was read; move the file to ${file}, where caddie-admin reads it` };
  }
  if (old && !sameFile(file, current, legacy, old)) {
    return { file, note: `NOTE admin token: read ${file}; the old path ${legacy} is a different file and is not read; keep only one of the two` };
  }
  return { file, note: null };
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
