// Where the Worker's admin token file is. One rule for the scripts that read it (readAdminToken in
// worker/ingest/lib.mjs, for the ingest, migration and topics scripts) and the one that writes it
// (worker/scripts/setup-secrets.mjs), so the two cannot drift apart. The default follows the config
// directory of the caddie-admin CLI (configDir in scripts/admin/config.mjs), so the CLI, these
// scripts and setup-secrets.mjs use the same file:
//   1. ADMIN_TOKEN_FILE, when it is set and not empty;
//   2. $CADDIE_ADMIN_HOME/admin-token, when CADDIE_ADMIN_HOME is set and not empty;
//   3. $XDG_CONFIG_HOME/conference-caddie/admin-token, with ~/.config in place of XDG_CONFIG_HOME
//      when it is unset or empty.
// (readAdminToken checks the ADMIN_TOKEN variable before any file.) configDir treats no platform
// specially, so neither does this; on Windows the CLI reads ADMIN_TOKEN only and no file at all
// (scripts/admin/credentials.mjs), which is about reading, not about where the file is.
//
// Before this rule the default was always ~/.config/conference-caddie/admin-token. An operator who
// has CADDIE_ADMIN_HOME or XDG_CONFIG_HOME set may still have the token there, so a reader that finds
// no file at the default but one at the old place reads the old one and gets a one-line note that
// names both paths, never the value, and says to move the file. When both files exist and hold
// different tokens, the new one is read, with a one-line note that names both paths (never the
// values) and says which one is used. That fallback and that note are for the default only: a file
// named by ADMIN_TOKEN_FILE is read as it is, or not at all.
//
// The two places are one file when the paths lead to it through a symbolic link, for example when
// ~/.config is a link to $XDG_CONFIG_HOME, or ~/.config/conference-caddie a link to
// $CADDIE_ADMIN_HOME. Then there is no old place: no note, no fallback, and no "delete the old one"
// from setup-secrets.mjs, which would delete the only copy. Node built-ins only.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// The absolute path with every symbolic link resolved. A path that does not exist (yet) is resolved
// through its nearest existing ancestor, so a linked directory counts before the file is there.
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

// Whether two absolute paths name one file: the same device and inode when both exist (which also
// covers a hard link), else the same path once symbolic links are resolved.
export function sameFile(a, b) {
  if (a === b) return true;
  let first;
  let second;
  try {
    first = statSync(a);
    second = statSync(b);
  } catch {
    return realPath(a) === realPath(b);
  }
  return first.dev === second.dev && first.ino === second.ino;
}

// { path, legacy }: path is the file to read and write; legacy is the old default place when it is
// a different file and ADMIN_TOKEN_FILE is unset, else null. Whether the two are one file is decided
// at the time of the call, from the file system.
export function adminTokenFile(env = process.env, home = homedir()) {
  if (env.ADMIN_TOKEN_FILE) return { path: resolve(env.ADMIN_TOKEN_FILE), legacy: null };
  const dir = env.CADDIE_ADMIN_HOME || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'conference-caddie');
  const path = resolve(dir, 'admin-token');
  const old = resolve(home, '.config', 'conference-caddie', 'admin-token');
  return { path, legacy: sameFile(old, path) ? null : old };
}

// The trimmed contents of a file, or null when it cannot be read. Kept in memory only.
function contents(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

// { path, note, legacy, fallback, differs }: the file a reader should read, the note to print on
// stderr (else null), and the old default place when it is a different file that exists (else
// null). fallback is true when path is that old place, because nothing is at the new one. differs
// is true when both files exist and hold different tokens; path is then the new one. The contents
// are compared in memory and never returned or printed.
export function adminTokenFileToRead(env = process.env, home = homedir()) {
  const { path, legacy } = adminTokenFile(env, home);
  const old = legacy && existsSync(legacy) ? legacy : null;
  if (old && !existsSync(path)) {
    return {
      path: old,
      note: `Note: the admin token file is not at ${path}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, so the file at its old place ${old} was read instead; move that file to ${path}.`,
      legacy: old,
      fallback: true,
      differs: false,
    };
  }
  if (old) {
    const current = contents(path);
    const previous = contents(old);
    if (current !== null && previous !== null && current !== previous) {
      return {
        path,
        note: `Note: the admin token file ${path} and the file at its old place ${old} hold different tokens; ${path} is used. Set ADMIN_TOKEN_FILE to the other file to use that one instead.`,
        legacy: old,
        fallback: false,
        differs: true,
      };
    }
  }
  return { path, note: null, legacy: old, fallback: false, differs: false };
}
