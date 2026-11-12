// Backend configuration of the caddie-admin CLI: which backends exist, their tier and their
// addresses. The file holds no secrets; credentials come from credentials.mjs.
//
// Shape of <config dir>/config.json:
//   { "default": "<name>", "backends": { "<name>": { "tier": 2, "api": "https://..." },
//                                       "<name>": { "tier": 3, "es_url": "https://...",
//                                                   "api": "https://<cloud run>", "project": "<gcp project>", "service": "<cloud run service>" } } }
// On a tier 3 entry, api, project and service are optional: `stats health` reads the service at
// api and prints the smoke and log-tail commands with project and service (default conference-caddie).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors.mjs';

const SHAPE = '{ "default": "<name>", "backends": { "<name>": { "tier": 2, "api": "<https url>" } or { "tier": 3, "es_url": "<url>", "api"?: "<https url>", "project"?: "<gcp project>", "service"?: "<cloud run service>" } } }';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function configDir(env) {
  if (env.CADDIE_ADMIN_HOME) return env.CADDIE_ADMIN_HOME;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'conference-caddie');
}

export function configPath(env) {
  return join(configDir(env), 'config.json');
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// https, or plain http to this machine only (the rule of worker/ingest/lib.mjs normalizeApiBase),
// for the tier 2 api and the tier 3 es_url alike, so neither admin credential ever travels in
// clear to another host.
function isUrl(value, protocols) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    if (!protocols.includes(u.protocol)) return false;
    return u.protocol !== 'http:' || LOOPBACK.includes(u.hostname);
  } catch {
    return false;
  }
}

export function loadConfig(env) {
  const path = configPath(env);
  const fail = (why) => new UsageError(`config ${why}: ${path}; expected ${SHAPE}`);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw fail('not readable');
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw fail('is not valid JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('has the wrong shape');
  const { backends } = config;
  if (!backends || typeof backends !== 'object' || Array.isArray(backends) || Object.keys(backends).length === 0) {
    throw fail('has no backends');
  }
  if (config.default !== undefined && typeof config.default !== 'string') throw fail('has a non-string default');
  for (const [name, entry] of Object.entries(backends)) {
    if (!entry || typeof entry !== 'object') throw fail(`has a bad entry "${name}"`);
    if (entry.tier === 2 && !isUrl(entry.api, ['https:', 'http:'])) throw fail(`entry "${name}" needs an https api url (http only for localhost)`);
    else if (entry.tier === 3 && !isUrl(entry.es_url, ['https:', 'http:'])) throw fail(`entry "${name}" needs an https es_url (http only for localhost)`);
    else if (entry.tier !== 2 && entry.tier !== 3) throw fail(`entry "${name}" needs tier 2 or 3`);
    if (entry.tier === 3) {
      if (entry.api !== undefined && !isUrl(entry.api, ['https:', 'http:'])) throw fail(`entry "${name}" has an api that is not an https url (http only for localhost)`);
      for (const key of ['project', 'service']) {
        if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !NAME_RE.test(entry[key]))) throw fail(`entry "${name}" has a ${key} that is not a lowercase name`);
      }
    }
  }
  return config;
}

export function selectBackend(config, name) {
  const chosen = name ?? config.default;
  if (!chosen) throw new UsageError('no backend chosen: pass --backend <name> or set "default" in config.json');
  if (!Object.hasOwn(config.backends, chosen)) {
    throw new UsageError(`unknown backend "${chosen}"; configured: ${Object.keys(config.backends).join(', ')}`);
  }
  return { name: chosen, ...config.backends[chosen] };
}
