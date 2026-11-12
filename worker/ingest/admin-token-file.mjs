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
// names both paths, never the value, and says to move the file. That fallback is for the default
// only: a file named by ADMIN_TOKEN_FILE is read as it is, or not at all. Node built-ins only.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// { path, legacy }: path is the file to read and write; legacy is the old default place when it is
// a different file and ADMIN_TOKEN_FILE is unset, else null.
export function adminTokenFile(env = process.env, home = homedir()) {
  if (env.ADMIN_TOKEN_FILE) return { path: resolve(env.ADMIN_TOKEN_FILE), legacy: null };
  const dir = env.CADDIE_ADMIN_HOME || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'conference-caddie');
  const path = resolve(dir, 'admin-token');
  const old = resolve(home, '.config', 'conference-caddie', 'admin-token');
  return { path, legacy: old === path ? null : old };
}

// { path, note }: the file a reader should read, and the note to print on stderr when that is the
// old default place (else null). exists is for tests.
export function adminTokenFileToRead(env = process.env, home = homedir(), exists = existsSync) {
  const { path, legacy } = adminTokenFile(env, home);
  if (legacy && !exists(path) && exists(legacy)) {
    return {
      path: legacy,
      note: `Note: the admin token file is not at ${path}, its default place under CADDIE_ADMIN_HOME or XDG_CONFIG_HOME, so the file at its old place ${legacy} was read instead; move that file to ${path}.`,
    };
  }
  return { path, note: null };
}
