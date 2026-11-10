// Shared helpers for the ingest and migration scripts: argument parsing, ndjson reading and the
// admin client. Node built-ins only. Nothing here prints a token, a document or a response body.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../scripts/lib/hash.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TALK_BATCH = 50;
export const PEOPLE_BATCH = 25;
export const REPORT_BATCH = 50;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
export const isSlug = (s) => typeof s === 'string' && SLUG_RE.test(s);

export class UsageError extends Error {}

// Parses `--flag` and `--name value` arguments. `flags` names the boolean options, `values` the
// options with one value and `multi` the options that may repeat. Anything else that starts with
// `--` is a usage error.
export function parseArgs(argv, { flags = [], values = [], multi = [] }) {
  const out = { _: [] };
  for (const f of flags) out[f] = false;
  for (const m of multi) out[m] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (flags.includes(name)) {
      out[name] = true;
    } else if (values.includes(name) || multi.includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
      if (multi.includes(name)) out[name].push(v);
      else out[name] = v;
    } else {
      throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  return out;
}

// Reads a newline-delimited JSON file into an array. A missing file gives an empty array only
// when `optional` is set. A line that does not parse is fatal, and the message carries the line
// number only, never the line.
export function readNdjson(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return [];
    throw new Error(`Missing file: ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  const rows = [];
  let n = 0;
  for (const line of text.split('\n')) {
    n++;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${path}: line ${n} is not valid JSON.`);
    }
  }
  return rows;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Asks the Worker to embed whatever is still waiting (POST /admin/embed-pending) until nothing is
// pending or a call embeds nothing, for example because the Workers AI quota is used up. Returns
// the number still pending, or null when the Worker did not say.
export async function drainPending(admin, slug, { maxCalls = 40 } = {}) {
  let pending = null;
  for (let i = 0; i < maxCalls; i++) {
    const r = await admin('POST', `/admin/embed-pending?event=${encodeURIComponent(slug)}`, {});
    pending = Number.isFinite(Number(r.pending)) ? Number(r.pending) : null;
    if (!pending || !(Number(r.embedded) > 0)) break;
  }
  return pending;
}

// ---------------------------------------------------------------------------------------------
// Talk documents

// Talks travel to the Worker with their topics in one request, and the Worker skips a talk whose
// content_hash is unchanged. So the hash must cover the topics too, or a changed topic list would
// never reach an unchanged talk. This returns the talk document with `topics` set (a talk of kind
// talk always has an array) and content_hash recomputed over every field except the three that
// contentHash leaves out. Other kinds are returned as they are, with their original hash.
export function withTopics(doc, topics) {
  if (doc.kind !== 'talk') return doc;
  const out = { ...doc, topics: topics ?? doc.topics ?? [] };
  out.content_hash = contentHash(out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Admin client

// The token comes from ADMIN_TOKEN, else from the file named by ADMIN_TOKEN_FILE, else from the
// operator file that worker/scripts/setup-secrets.mjs writes. Returns '' when none is available.
export function readAdminToken() {
  const direct = (process.env.ADMIN_TOKEN || '').trim();
  if (direct) return direct;
  const file = process.env.ADMIN_TOKEN_FILE || join(homedir(), '.config', 'conference-caddie', 'admin-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function normalizeApiBase(api) {
  if (!api) throw new UsageError('--api <base URL> is required.');
  let u;
  try {
    u = new URL(api);
  } catch {
    throw new UsageError('--api is not a valid URL.');
  }
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new UsageError('--api must be https (plain http is allowed for localhost only).');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A short, safe description of a failed response: the status and, when the body is a JSON object
// whose `error` is a short plain code, that code. Never any other part of the body.
function describe(status, text) {
  let code = '';
  try {
    const e = JSON.parse(text)?.error;
    if (typeof e === 'string' && /^[A-Za-z0-9_ .:-]{1,60}$/.test(e)) code = e;
  } catch { /* not JSON */ }
  return code ? `status ${status} (${code})` : `status ${status}`;
}

export class AdminError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Returns a function admin(method, path, body) that resolves to the parsed JSON body. It retries
// network failures, 429 and 5xx up to `retries` times (honouring Retry-After), and stops at once on
// a 503 daily_limit, because retrying cannot help before the quota resets. Any other status
// throws an AdminError that carries the status.
export function adminClient(api, token, { retries = 3, timeoutMs = 60_000 } = {}) {
  return async function admin(method, path, body) {
    const where = `${method} ${path.split('?')[0]}`;
    let lastError = 'no attempt';
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      let text = '';
      try {
        res = await fetch(api + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        lastError = `${where}: ${e.name === 'TimeoutError' ? 'timeout' : 'network error'}`;
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw new AdminError(`${where}: the answer was not JSON.`, res.status);
        }
      }
      lastError = `${where}: ${describe(res.status, text)}`;
      if (res.status === 503 && /daily_limit/.test(text.slice(0, 200))) {
        throw new AdminError(`${lastError}. The daily limit is reached; try again after the reset.`, 503);
      }
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after'));
        if (attempt < retries) await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new AdminError(lastError, res.status);
    }
    throw new AdminError(`${lastError} (gave up after ${retries + 1} attempts)`);
  };
}
