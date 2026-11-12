// The Worker scripts' trust policy over the admin token file. Where the file is, and whether two
// paths are one file, come from scripts/lib/admin-token-file.mjs (adminTokenPaths and sameFile),
// which the smoke and the caddie-admin CLI use too, so the Worker scripts and that side cannot
// drift apart. This module adds only what the Worker scripts need on top: each file read once, the
// note a reader prints, and whether the file read can be trusted. It is used by readAdminToken in
// worker/ingest/lib.mjs (for the ingest, migration and topics scripts) and by
// worker/scripts/setup-secrets.mjs, which writes the file.
//
// The path is the one adminTokenPaths gives:
//   1. ADMIN_TOKEN_FILE, when it is set and not empty;
//   2. $CADDIE_ADMIN_HOME/admin-token, when CADDIE_ADMIN_HOME is set and not empty;
//   3. $XDG_CONFIG_HOME/conference-caddie/admin-token, with ~/.config in place of XDG_CONFIG_HOME
//      when it is unset or empty.
// (readAdminToken checks the ADMIN_TOKEN variable before any file.)
//
// Before this rule the default was always ~/.config/conference-caddie/admin-token. An operator who
// has XDG_CONFIG_HOME set may still have the token there, so a reader that finds no file at the
// default but one at the old place reads the old one and gets a one-line note that names both
// paths, never the value. When the caller knows the API origin it is about to use and the old
// directory has its own config.json, that config must list the origin as a tier 2 api, or the old
// file is not read, as in the smoke (a config.json that cannot be checked lists nothing). The note
// says to move the old file and leave a symlink at the old path, as the smoke's does, because a
// shell without XDG_CONFIG_HOME still uses the old path. When both files exist and hold different
// tokens, or the old one exists and cannot be read, the new one is read, with a one-line note that
// names both paths (never the values).
//
// There is no fallback with CADDIE_ADMIN_HOME set, because it names a separate setup (a fork's,
// say) whose token is never the old file. When the old file exists then, it is not read, and a
// reader gets one note that names both paths. There is no fallback with ADMIN_TOKEN_FILE set
// either: the file it names is read as it is, or not at all. When both are set and ADMIN_TOKEN_FILE
// names the old file itself, that file is read, because ADMIN_TOKEN_FILE comes first, but a reader
// gets one note that says so, since it is the token file of a setup without CADDIE_ADMIN_HOME.
//
// The file read is trusted only when ADMIN_TOKEN_FILE names it, when the resolved default is the
// only candidate (no old file, or CADDIE_ADMIN_HOME set and the default exists), or when the old
// file is proven the same file or holds the same token. In every other state (the fallback, two
// files with different tokens, an old file that cannot be read, CADDIE_ADMIN_HOME set with only the
// old file there) a reader may still read what it read, with its note, but setup-secrets.mjs
// pushes nothing from it and offers no recipe that would make it the only admin token: it stops
// and says to set ADMIN_TOKEN_FILE to the file that holds this deployment's token.
//
// sameFile answers "proven the same" only. Its false is never taken as proof that two paths are
// different files, so nothing here says to delete or move a file because of it. Node built-ins and
// scripts/lib/admin-token-file.mjs only.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { adminTokenPaths, configuredWorkerOrigins, legacyAdminTokenFile, sameFile, shellPath } from '../../scripts/lib/admin-token-file.mjs';

export { sameFile };

// { path, legacy }: path is the file to read and write; legacy is the old default place when it
// may be a different file that a reader falls back to (adminTokenPaths: never with ADMIN_TOKEN_FILE
// or CADDIE_ADMIN_HOME set, and never when it is proven the same file), else null. It is decided at
// the time of the call, from the file system. Two equal path strings are one path even when
// sameFile cannot stat them (a directory that cannot be searched), so an operator with no variable
// set never has an old place.
export function adminTokenFile(env = process.env, home = homedir()) {
  const { path, legacy } = adminTokenPaths(env, home);
  return { path, legacy: legacy === path ? null : legacy };
}

// Whether something may be at path: 'yes' when a stat finds it, 'maybe' when the stat fails for
// any other reason than "no such file" (a directory that cannot be searched), else false. Reads
// nothing.
function present(path) {
  try {
    statSync(path);
    return 'yes';
  } catch (err) {
    return err.code !== 'ENOENT' && err.code !== 'ENOTDIR' ? 'maybe' : false;
  }
}

// The old place in a note or a doubt about the file that is not read with CADDIE_ADMIN_HOME set:
// "the file at the old place", or, when the old place cannot be checked, a wording that says a file
// may be there, so no line claims a file that may not exist.
function ignoredOldText(old) {
  return present(old) === 'yes'
    ? `the file at the old place ${old}`
    : `a file that may be at the old place ${old} (it cannot be checked)`;
}

// The old default place ~/.config/conference-caddie/admin-token when CADDIE_ADMIN_HOME is set (and
// ADMIN_TOKEN_FILE is not), something is there, and it is not proven the same file as path: the
// file that is never read in that case, which a caller names in one note. Else null.
export function ignoredOldTokenFile(env = process.env, home = homedir(), path = adminTokenFile(env, home).path) {
  if (env.ADMIN_TOKEN_FILE || !env.CADDIE_ADMIN_HOME) return null;
  const old = legacyAdminTokenFile(home);
  if (old === path || sameFile(path, old) || !present(old)) return null;
  return old;
}

// The one note about the old file that is not read with CADDIE_ADMIN_HOME set. It names both paths
// and never a value.
export function ignoredOldNote(path, old) {
  return `Note: CADDIE_ADMIN_HOME is set, so the admin token file is ${path}; ${ignoredOldText(old)} is not read or changed, because there is no fallback to the old place with CADDIE_ADMIN_HOME set.`;
}

// The one note for ADMIN_TOKEN_FILE naming the old default place ~/.config/conference-caddie/
// admin-token (the path itself, or a link that is proven to lead to the same file) while
// CADDIE_ADMIN_HOME is set: the file is read and used, because ADMIN_TOKEN_FILE comes first, but it
// is the token file of a setup without CADDIE_ADMIN_HOME, which may not be this deployment's. Else
// null. It names the paths and never a value.
export function explicitOldNote(env = process.env, home = homedir()) {
  if (!env.ADMIN_TOKEN_FILE || !env.CADDIE_ADMIN_HOME) return null;
  const { path } = adminTokenPaths(env, home);
  const old = legacyAdminTokenFile(home);
  if (path !== old && !sameFile(path, old)) return null;
  const names = path === old ? `the old place ${old}` : `${path}, which is the file at the old place ${old}`;
  return `Note: CADDIE_ADMIN_HOME is set, but ADMIN_TOKEN_FILE names ${names}, the token file of a setup without CADDIE_ADMIN_HOME; it is used, because ADMIN_TOKEN_FILE comes first. If the setup at $CADDIE_ADMIN_HOME has its own token, unset ADMIN_TOKEN_FILE.`;
}

// { exists, value }: value is the trimmed contents of the file, or null when it cannot be read;
// exists is false only when there is no file at the path. Read once, and kept in memory only.
function readOnce(path) {
  try {
    return { exists: true, value: readFileSync(path, 'utf8').trim() };
  } catch (err) {
    return { exists: err.code !== 'ENOENT' && err.code !== 'ENOTDIR', value: null };
  }
}

// Why the old directory's config.json refuses the fallback for apiOrigin, as a clause that names
// the file, else null: the rule of resolveAdminTokenFile in scripts/lib/admin-token-file.mjs, so
// one setup's config never sends another setup's token. It refuses when it exists and does not
// list apiOrigin as a tier 2 api, and when it cannot be checked (its directory cannot be
// searched); the clause says which.
function oldConfigRefuses(legacy, apiOrigin) {
  const oldDir = dirname(legacy);
  const config = join(oldDir, 'config.json');
  try {
    statSync(config);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    return `${config} cannot be checked for ${apiOrigin}`;
  }
  return configuredWorkerOrigins({ CADDIE_ADMIN_HOME: oldDir }).includes(apiOrigin) ? null : `${config} does not list ${apiOrigin} as a tier 2 api`;
}

// { path, value, note, legacy, trusted, doubt }: the file a reader should read and its trimmed
// contents (null when it cannot be read or is not read), the note to print on stderr (else null),
// and the old default place when it is a fallback candidate that exists (else null). Each file is
// read once, and value is the very contents that were compared, so a caller that pushes it pushes
// what was checked. trusted is false in the fallback (path is then the old place, because nothing
// is at the new one), when the fallback is refused by the old directory's config.json, when both
// files hold different tokens, when the old file exists and cannot be read while the new one can,
// and when CADDIE_ADMIN_HOME is set, the new file is missing and the old one is there; doubt is
// then a clause that names both paths and says why, for a caller that refuses to go on, else null.
// No value is ever part of a note or of doubt.
//
// apiOrigin, when given, is the origin of the API the caller is about to send the token to: the
// fallback to the old file then needs the old directory's config.json, if it has one, to list it
// as a tier 2 api. Without it there is no such check (setup-secrets.mjs knows no origin, and
// refuses the fallback anyway).
export function adminTokenFileToRead(env = process.env, home = homedir(), { apiOrigin } = {}) {
  const { path, legacy } = adminTokenFile(env, home);
  const current = readOnce(path);
  const result = { path, value: current.value, note: explicitOldNote(env, home), legacy: null, trusted: true, doubt: null };

  const ignored = ignoredOldTokenFile(env, home, path);
  if (ignored) {
    const note = ignoredOldNote(path, ignored);
    if (current.exists) return { ...result, note };
    return {
      ...result,
      note,
      trusted: false,
      doubt: `there is no token file at ${path}, and ${ignoredOldText(ignored)} is not read, because there is no fallback to the old place with CADDIE_ADMIN_HOME set`,
    };
  }

  if (!legacy || !present(legacy)) return result;
  if (!current.exists) {
    const refusedBy = apiOrigin === undefined ? null : oldConfigRefuses(legacy, apiOrigin);
    if (refusedBy) {
      return {
        ...result,
        legacy,
        note: `Note: the admin token file is not at ${path}, its default place under XDG_CONFIG_HOME, and the file at its old place ${legacy} is not read, because ${refusedBy}; set ADMIN_TOKEN_FILE to the file that holds this deployment's token.`,
        trusted: false,
        doubt: `there is no token file at ${path}, its default place under XDG_CONFIG_HOME, only one at its old place ${legacy}, which is not read because ${refusedBy}`,
      };
    }
  }
  const old = readOnce(legacy);
  if (!old.exists) return result;
  result.legacy = legacy;
  if (!current.exists) {
    // The new file is missing and the old one is there, so the two are different places: the
    // advice to move the old file rests on that, not on sameFile. Only XDG_CONFIG_HOME leads here
    // (adminTokenPaths gives no old place with CADDIE_ADMIN_HOME or ADMIN_TOKEN_FILE set). A shell
    // without XDG_CONFIG_HOME still reads the old path, so the advice is the smoke's
    // (resolveAdminTokenFile): move the file and leave a symlink at the old path, never only move
    // it.
    return {
      ...result,
      path: legacy,
      value: old.value,
      note: old.value === null
        ? null
        : `Note: the admin token file is not at ${path}, its default place under XDG_CONFIG_HOME, so the file at its old place ${legacy} was read instead; if that file holds this deployment's token, move it to ${path} and leave a symlink at the old path (ln -s ${shellPath(path, home)} ${shellPath(legacy, home)}), so every script uses one file, or set ADMIN_TOKEN_FILE to it.`,
      trusted: false,
      doubt: `there is no token file at ${path}, its default place under XDG_CONFIG_HOME, only one at its old place ${legacy}, which may hold another deployment's token`,
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
