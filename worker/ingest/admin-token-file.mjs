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
// names both paths, never the value, and says what to do if that file holds this deployment's token
// (with CADDIE_ADMIN_HOME keeping a second deployment apart, it may hold the other one's). When both
// files exist and hold different tokens, or the old one exists and cannot be read, the new one is
// read, with a one-line note that names both paths (never the values). That fallback and those notes
// are for the default only: a file named by ADMIN_TOKEN_FILE is read as it is, or not at all.
//
// The file read is trusted only when ADMIN_TOKEN_FILE names it, when the old place holds no
// different file, or when both hold the same token. In every other state (the fallback, two files
// with different tokens, an old file that cannot be read) a reader may still read it, with its
// note, but setup-secrets.mjs pushes nothing from it and offers no recipe that would make it the
// only admin token: it stops and says to set ADMIN_TOKEN_FILE to the file that holds this
// deployment's token.
//
// The two places are one file when the paths lead to it through a symbolic link, for example when
// ~/.config is a link to $XDG_CONFIG_HOME, or ~/.config/conference-caddie a link to
// $CADDIE_ADMIN_HOME, or when one is a hard link to the other. Then there is no old place: no note, no
// fallback, and no "delete the old one" from setup-secrets.mjs, which would delete the only copy.
// Node built-ins only.

import { readFileSync, realpathSync, statSync } from 'node:fs';
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
// covers a hard link), else the same path once symbolic links are resolved. The numbers are compared
// as bigints, since a large file ID (on Windows, say) does not fit a double exactly.
export function sameFile(a, b) {
  if (a === b) return true;
  let first;
  let second;
  try {
    first = statSync(a, { bigint: true });
    second = statSync(b, { bigint: true });
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

// { exists, value }: value is the trimmed contents of the file, or null when it cannot be read; exists
// is false only when there is no file at the path. Read once, and kept in memory only.
function readOnce(path) {
  try {
    return { exists: true, value: readFileSync(path, 'utf8').trim() };
  } catch (err) {
    return { exists: err.code !== 'ENOENT' && err.code !== 'ENOTDIR', value: null };
  }
}

// { path, value, note, legacy, trusted, doubt }: the file a reader should read and its trimmed
// contents (null when it cannot be read), the note to print on stderr (else null), and the old
// default place when it is a different file that exists (else null). Each file is read once, and
// value is the very contents that were compared, so a caller that pushes it pushes what was
// checked. trusted is false in the fallback (path is then the old place, because nothing is at the
// new one), when both files hold different tokens, and when the old file exists and cannot be read
// while the new one can; doubt is then a clause that names both paths and says why, for a caller
// that refuses to go on, else null. No value is ever part of a note or of doubt.
export function adminTokenFileToRead(env = process.env, home = homedir()) {
  const { path, legacy } = adminTokenFile(env, home);
  const current = readOnce(path);
  const old = legacy ? readOnce(legacy) : { exists: false, value: null };
  const result = { path, value: current.value, note: null, legacy: old.exists ? legacy : null, trusted: true, doubt: null };
  if (!old.exists) return result;
  if (!current.exists) {
    return {
      ...result,
      path: legacy,
      value: old.value,
      note: `Note: the admin token file is not at ${path}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, so the file at its old place ${legacy} was read instead; if that file holds this deployment's token, move it to ${path}, or set ADMIN_TOKEN_FILE to it.`,
      trusted: false,
      doubt: `there is no token file at ${path}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, only one at its old place ${legacy}, which may hold another deployment's token`,
    };
  }
  if (current.value === null) return result;
  if (old.value === null) {
    return {
      ...result,
      note: `Note: the admin token file ${path} is used, but the file at its old place ${legacy} exists and cannot be read, so the two cannot be compared; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`,
      trusted: false,
      doubt: `the file at the old place ${legacy} of the token file ${path} exists and cannot be read, so it is not clear which one holds this deployment's token`,
    };
  }
  if (current.value !== old.value) {
    return {
      ...result,
      note: `Note: the admin token file ${path} and the file at its old place ${legacy} hold different tokens; ${path} is used. Set ADMIN_TOKEN_FILE to the other file to use that one instead.`,
      trusted: false,
      doubt: `the token file ${path} and the file at its old place ${legacy} hold different tokens, so it is not clear which one is this deployment's`,
    };
  }
  return result;
}
