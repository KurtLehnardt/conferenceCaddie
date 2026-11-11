// Shared helpers for the ingest and migration scripts: argument parsing, ndjson reading and the
// admin client. Node built-ins only. Nothing here prints a token, a document or a response body.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../scripts/lib/hash.mjs';
import { HEADER_NAME, signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

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

// A redirect answer of a fetch made with redirect: 'manual': the 3xx itself (Node), or an
// opaque-redirect response with status 0 (browsers).
export const isRedirect = (res) => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

export class AdminError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// The optional Cloudflare Access service token: both CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET set, or nothing. It is an extra layer in front of the Worker; the
// signature is the check the Worker itself makes. worker/scripts/moderation.mjs sends it too.
export function accessHeaders(env = process.env) {
  const id = (env.CF_ACCESS_CLIENT_ID || '').trim();
  const secret = (env.CF_ACCESS_CLIENT_SECRET || '').trim();
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {};
}

// Returns a function admin(method, path, body) that resolves to the parsed JSON body. Every
// request is signed with the admin token (X-Caddie-Admin, scripts/lib/admin-sign.mjs), which never
// leaves this process; no Authorization header is sent. It retries network failures, 429 and 5xx
// up to `retries` times (honouring Retry-After), signing each attempt afresh: a nonce is
// single-use on the Worker and the timestamp must be within five minutes of its clock, so a retry
// is a new request, which every admin route handles idempotently, with two exceptions on POST
// /admin/moderation: action "delete" answers 404 when the target is already gone, and action
// "unhide" of a target that no longer exists answers 404 once its reports are gone, so either,
// when its first answer was lost, reports 404 on the retry. It stops at once on a 503
// daily_limit, because retrying cannot help before the quota resets. Any other status throws an
// AdminError that carries the status. A redirect is never followed and is an AdminError at once,
// not retried: fetch drops only Authorization on a cross-origin redirect, so following one would
// hand the signed header and the Access secret to another origin. `api` must be an origin (the
// admin routes live at its root); a path or query outside the signer's charset is a UsageError
// before anything is sent.
export function adminClient(api, token, { retries = 3, timeoutMs = 60_000, env = process.env } = {}) {
  const access = accessHeaders(env);
  return async function admin(method, path, body) {
    const where = `${method} ${path.split('?')[0]}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let lastError = 'no attempt';
    for (let attempt = 0; attempt <= retries; attempt++) {
      let signed;
      try {
        signed = signAdminRequest({ method, path, base: api, body: payload, key: token });
      } catch (e) {
        throw new UsageError(`${where}: ${e.message}`);
      }
      const networkError = (e) => `${where}: ${e.name === 'TimeoutError' ? 'timeout' : 'network error'}`;
      let res;
      try {
        res = await fetch(signed.url, {
          method,
          headers: {
            [HEADER_NAME]: signed.header,
            ...access,
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastError = networkError(e);
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
        continue;
      }
      // A redirect is refused as soon as its headers arrive, before any body is read, so a body
      // that stalls or breaks cannot turn it into a retried network failure.
      if (isRedirect(res)) {
        res.body?.cancel().catch(() => {});
        throw new AdminError(`${where}: status ${res.status}, a redirect. Admin calls never follow redirects; the API base must be the Worker's own origin.`, res.status);
      }
      // Any other answer whose body stalls or breaks is retried as a network failure, as before.
      let text;
      try {
        text = await res.text();
      } catch (e) {
        lastError = networkError(e);
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
