// Shared helpers for the ingest and migration scripts: argument parsing, ndjson reading and the
// admin client. Node built-ins only. Nothing here prints a token, a document or a response body.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../scripts/lib/hash.mjs';
import { HEADER_NAME, signAdminRequest } from '../../scripts/lib/admin-sign.mjs';
import { adminTokenFileToRead } from './admin-token-file.mjs';

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

// The keys of a conference document that only the operator sends: `unretire`, which lifts a
// removal, and `expect_status`, the precondition of PUT /admin/conferences. An ingest run or a
// migration must never send either, whatever a committed conference.json or a backup holds. A key
// that equals one of them after trim().toLowerCase() is dropped too, the same match as the
// DirectoryDO's near-miss check: the Worker refuses such a key with 400 and fails the whole
// request, so a stray "Unretire" or "expect_status " in one file would otherwise stop the batch.
const OPERATOR_KEYS = new Set(['unretire', 'expect_status']);

/** A copy of a conference document without its own operator keys (see OPERATOR_KEYS), in order. */
export function withoutOperatorKeys(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !OPERATOR_KEYS.has(key.trim().toLowerCase())));
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
// operator file that worker/scripts/setup-secrets.mjs writes, at the default place of
// admin-token-file.mjs (the caddie-admin CLI's config directory). When only the old default
// ~/.config/conference-caddie/admin-token exists, and CADDIE_ADMIN_HOME is not set, that file is
// read and warn gets one line naming both paths (never the value). With apiOrigin, the origin of
// the API the token is for, that fallback also needs the old directory's config.json, when there is
// one, to list apiOrigin as a tier 2 api, as in the smoke; otherwise the old file is not read and
// warn gets one line that says why. With CADDIE_ADMIN_HOME set the old file is never read, and when
// it exists warn gets one line naming both paths. When both exist as two files with different
// tokens, or the old one cannot be read, the default one is read and warn gets one line naming both
// paths (never the values). Two paths that lead to one file through a symbolic or a hard link count
// as one file. The value returned is the one admin-token-file.mjs read and compared, not a second
// read. Returns '' when none is available. env, home and warn are for tests.
export function readAdminToken({ env = process.env, home = homedir(), warn = (line) => process.stderr.write(`${line}\n`), apiOrigin } = {}) {
  const direct = (env.ADMIN_TOKEN || '').trim();
  if (direct) return direct;
  const { value, note } = adminTokenFileToRead(env, home, { apiOrigin });
  if (note) warn(note);
  return value ?? '';
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

// The JSON object an answer's body holds, or null when it holds anything else (not JSON, an
// array, a string). It is the parsed body only, never the request or a header.
function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// A short, safe description of a failed response: the status and, when the body is a JSON object
// whose `error` is a short plain code, that code, with its `cause` when that is one too. The Worker's
// error codes that an operator must see, such as the 400 for a misspelt `expect_status` key, are
// written to match SHORT_CODE, and worker/test/admin-routes.test.mjs checks that they do.
export const SHORT_CODE = /^[A-Za-z0-9_ .:-]{1,60}$/;
function describeShort(status, body) {
  const code = typeof body?.error === 'string' && SHORT_CODE.test(body.error) ? body.error : '';
  if (!code) return `status ${status}`;
  const cause = typeof body.cause === 'string' && SHORT_CODE.test(body.cause) ? `, cause ${body.cause}` : '';
  return `status ${status} (${code}${cause})`;
}

// The short description, followed by the lists some answers carry. For an answer that lists
// `unretire_failed` (PUT /admin/conferences, unretire_incomplete), the slugs of that list and the
// directory's `upserted` count, so the operator sees which conferences were not unretired and that
// the rest of the batch was applied. For a `409 status_mismatch` (the expect_status precondition
// of PUT /admin/conferences), each mismatching document as `slug expected→actual`, where `(no
// row)` stands for the JSON value null (the directory has no row) and a status that reads as null
// is quoted, so that the two are never shown the same way. Only well-formed slugs and statuses are
// named (at most 20); an entry with anything else is counted, not shown. Never any other part of
// the body.
const STATUS_WORD = /^[A-Za-z0-9_-]{1,40}$/;
const isStatusWord = (v) => v === null || (typeof v === 'string' && STATUS_WORD.test(v));
const statusShown = (v) => (v === null ? '(no row)' : /^null$/i.test(v) ? `"${v}"` : v);
const listed = (names, total) => names.slice(0, 20).join(', ') + (total > 20 ? ` and ${total - 20} more` : '');
// A `mismatched` entry that is named: a well-formed slug and two well-formed statuses.
const wellFormed = (m) => m !== null && typeof m === 'object' && isSlug(m.slug) && isStatusWord(m.expected) && isStatusWord(m.actual);
function describe(status, body) {
  let out = describeShort(status, body);
  if (out === `status ${status}`) return out;
  if (Array.isArray(body.unretire_failed)) {
    const slugs = [...new Set(body.unretire_failed.filter((s) => typeof s === 'string' && isSlug(s)))];
    const upserted = Number.isSafeInteger(body.upserted) ? `; the rest of the batch was applied (upserted ${body.upserted})` : '';
    out += `: not unretired, the object did not take the document: ${listed(slugs, slugs.length) || '(none named)'}${upserted}`;
  }
  if (body.error === 'status_mismatch' && Array.isArray(body.mismatched)) {
    const shown = body.mismatched
      .filter(wellFormed)
      .map((m) => `${m.slug} ${statusShown(m.expected)}→${statusShown(m.actual)}`);
    const hidden = body.mismatched.length - shown.length;
    out += `: the directory holds another status (expected→actual): ${listed(shown, shown.length) || '(none named)'}`;
    if (hidden > 0) out += ` (${hidden} malformed ${hidden === 1 ? 'entry' : 'entries'} not shown)`;
  }
  return out;
}

// A redirect answer of a fetch made with redirect: 'manual': the 3xx itself (Node), or an
// opaque-redirect response with status 0 (browsers).
export const isRedirect = (res) => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

// `status` is the last answer's status (0 when there was none). `body` is the JSON object the last
// answer held, or null; it is the parsed body only, never the request or a header. `earlier` holds
// a short description of each earlier attempt that failed and was retried, in order, such as
// "status 502 (unretire_incomplete, cause unretire_superseded)" or "no answer (timeout)".
export class AdminError extends Error {
  constructor(message, status = 0, { body = null, earlier = [] } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.earlier = earlier;
  }
}

// The optional Cloudflare Access service token: both CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET set, or nothing. It is an extra layer in front of the Worker; the
// signature is the check the Worker itself makes.
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
// is a new request, which every admin route handles idempotently, with four exceptions: on POST
// /admin/moderation, action "delete" answers 404 when the target is already gone and action
// "unhide" of a target that no longer exists answers 404 once its reports are gone, and POST
// /admin/people/block with action "unblock" answers 404 once the operator report is gone; each,
// when its first answer was lost, reports 404 on the retry. PUT /admin/conferences with an
// "expect_status" precondition answers 409 status_mismatch on a retry when its first attempt was
// applied, because the row then has the status that attempt set. It stops at once on a 503
// daily_limit, because retrying cannot help before the quota resets. Any other status throws an
// AdminError that carries the status and the answer's JSON object (`body`). Its message and
// `earlier` also describe every earlier attempt that failed and was retried (its status and error
// code, or that it got no answer), because such an attempt may have been applied; after a 409
// status_mismatch that followed a 5xx or no answer, the message says what to do next. Nothing in
// the message comes from the request or a header. A redirect is never followed and is an AdminError at once,
// not retried: fetch drops only Authorization on a cross-origin redirect, so following one would
// hand the signed header and the Access secret to another origin. `api` must be an origin (the
// admin routes live at its root); a path or query outside the signer's charset is a UsageError
// before anything is sent.
export function adminClient(api, token, { retries = 3, timeoutMs = 60_000, env = process.env } = {}) {
  const access = accessHeaders(env);
  return async function admin(method, path, body) {
    const where = `${method} ${path.split('?')[0]}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // The slugs this request unretires, so that the advice after a status_mismatch is the one for
    // an unretire only when one of the mismatching documents is an unretire.
    const unretiring = new Set(Array.isArray(body?.conferences) ? body.conferences.filter((c) => c?.unretire === true && typeof c.slug === 'string').map((c) => c.slug) : []);
    let lastError = 'no attempt';
    let lastBody = null;
    // Each earlier attempt that failed and was retried: its short description, and whether it may
    // have been applied (a 5xx, or no answer; a 429 was not).
    const earlier = [];
    const fail = (message, status, answer = null) => {
      // A message that already ends a sentence loses its period, so that the suffix does not double it.
      let text = earlier.length ? message.replace(/\.$/, '') : message;
      if (earlier.length === 1) text += `. An earlier attempt ${earlier[0].said}`;
      else if (earlier.length > 1) text += `. Earlier attempts: ${earlier.map((e) => e.said).join('; ')}`;
      if (status === 409 && answer?.error === 'status_mismatch' && earlier.some((e) => e.mayHaveApplied)) {
        text += `; ${earlier.length === 1 ? 'it' : 'one of them'} may have been applied, so the actual status can be the one it set`;
        // The advice depends on which of the named slugs this request unretires: the unretire is
        // repeated, any other document is checked first. When the 409 names both kinds, each gets
        // its own advice, and the slugs are named so the operator knows which advice is whose.
        const named = [...new Set((Array.isArray(answer.mismatched) ? answer.mismatched : []).filter(wellFormed).map((m) => m.slug))];
        const unretired = named.filter((slug) => unretiring.has(slug));
        const others = named.filter((slug) => !unretiring.has(slug));
        const general = 'check the conference, then send the request again with the actual status or without expect_status';
        if (unretired.length && others.length) {
          text += `; repeat the unretire of ${listed(unretired, unretired.length)} without expect_status until it answers 200; for ${listed(others, others.length)}, ${general}`;
        } else {
          text += unretired.length ? '; repeat the unretire without expect_status until it answers 200' : `; ${general}`;
        }
      }
      if (earlier.length) text += '.';
      return new AdminError(text, status, { body: answer, earlier: earlier.map((e) => e.short) });
    };
    const retried = (short, mayHaveApplied) => {
      earlier.push({ short, said: short.startsWith('status ') ? `answered ${short}` : `got ${short}`, mayHaveApplied });
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      let signed;
      try {
        signed = signAdminRequest({ method, path, base: api, body: payload, key: token });
      } catch (e) {
        throw new UsageError(`${where}: ${e.message}`);
      }
      const noAnswer = (e) => `no answer (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`;
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
        lastError = `${where}: ${e.name === 'TimeoutError' ? 'timeout' : 'network error'}`;
        lastBody = null;
        if (attempt < retries) {
          retried(noAnswer(e), true);
          await sleep(1000 * 2 ** attempt);
        }
        continue;
      }
      // A redirect is refused as soon as its headers arrive, before any body is read, so a body
      // that stalls or breaks cannot turn it into a retried network failure.
      if (isRedirect(res)) {
        res.body?.cancel().catch(() => {});
        throw fail(`${where}: status ${res.status}, a redirect. Admin calls never follow redirects; the API base must be the Worker's own origin.`, res.status);
      }
      // Any other answer whose body stalls or breaks is retried as a network failure, as before.
      let text;
      try {
        text = await res.text();
      } catch (e) {
        lastError = `${where}: ${e.name === 'TimeoutError' ? 'timeout' : 'network error'}`;
        lastBody = null;
        if (attempt < retries) {
          retried(noAnswer(e), true);
          await sleep(1000 * 2 ** attempt);
        }
        continue;
      }
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw fail(`${where}: the answer was not JSON.`, res.status);
        }
      }
      const answer = parseObject(text);
      lastError = `${where}: ${describe(res.status, answer)}`;
      lastBody = answer;
      if (res.status === 503 && /daily_limit/.test(text.slice(0, 200))) {
        throw fail(`${lastError}. The daily limit is reached; try again after the reset.`, 503, answer);
      }
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after'));
        if (attempt < retries) {
          retried(describeShort(res.status, answer), res.status >= 500);
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
        }
        continue;
      }
      throw fail(lastError, res.status, answer);
    }
    throw fail(`${lastError} (gave up after ${retries + 1} attempts)`, 0, lastBody);
  };
}
