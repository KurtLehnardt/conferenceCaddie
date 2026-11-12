// Tier 2 adapter of the caddie-admin CLI: the Cloudflare Worker, reached through its signed
// /admin/* routes (scripts/lib/admin-sign.mjs, design section 5.3) and its public /api/* routes.
//
// createWorkerAdapter(backend, { credential, env, spawn, fetch, root, now }) where backend is the
// config entry ({ tier: 2, api }), credential the admin token (the HMAC key), env the process
// environment, spawn a spawnSync-like function and fetch a fetch-like function (both injectable for
// the tests), and root the repository root the conference commands write under.
//
// Rules this module keeps:
// - The token signs requests and goes nowhere else: never in a URL, a header, a body, an argument
//   list, a child environment, a result or an error. Every attempt is signed afresh, because a
//   nonce is single-use on the Worker and the timestamp has a five-minute window.
// - A redirect is never followed: the response is refused as soon as its status arrives, its body
//   is cancelled, and nothing is retried (fetch would carry the signed header and the optional
//   Access secret to another origin).
// - The Worker tells its two 404s apart by the body: {"error": "Not found"} is a refusal (a refused
//   signature, the failed-signature limiter, an unknown route, a missing nonce), and "not_found"
//   or "no_operator_block" is a missing target. Both are exit 4, each with its own message.
// - An attempt "may have run" only when the Worker may have executed it: it answered a 5xx (its
//   body unread or not daily_limit), the body of a 2xx could not be read, or the connection broke
//   after undici had written the whole request (trackSend below). A failure before that (refused,
//   DNS, connect timeout, a reset during the TLS handshake) and a 429 never count. Only after such
//   an attempt does a retried delete or unhide that answers 404 not_found, or a retried unblock
//   that answers not_found or no_operator_block, read as "already done" (exit 0 with a note); a
//   "Not found" refusal never does. When a write ends in a 404 or gives up after an earlier attempt
//   failed (a network error or a 5xx), the message says that attempt may have done the work. A
//   retried purge or removal says that an earlier attempt may have done more than the counts show.
// - A 503 for the daily limit (error or cause daily_limit) stops at once, never retried.
// - A removal run again is a success too (already_retired_at), and a removal that stopped between
//   its steps (removal_incomplete) says which step and asks for another run. A conference the
//   Worker does not route (400 "conference is not available") is exit 4 with the code
//   conference_unavailable.
// - An unretire carries expect_status: the status of the slug's directory row as a fresh GET
//   /api/conferences found it, or null when the slug is not listed (no row). After an answer that
//   proves the directory committed it (a 502 unretire_incomplete, or a 2xx whose body was lost),
//   the retry expects the status the document was stored with instead. The Worker answers 409
//   status_mismatch, writing nothing, when the row does not have the expected status; that is
//   exit 1 with the code status_mismatch, never retried, naming each slug as
//   `slug expected->actual`. When every mismatch shows the status sent, it names every earlier
//   attempt that may have run; a status no row holds is a version mismatch, with no re-run
//   advised; otherwise something else changed the conference. A 200 that lists the unretired slug
//   under skipped_retired is exit 1 with the code skipped_retired: nothing of it was applied.
// - Every 2xx must carry a JSON object, and the writes that answer "ok" (POST /admin/moderation,
//   POST /admin/people/block, DELETE /admin/conference) must answer "ok": true; anything else is
//   exit 1, never taken for success.
// - Query values stay inside the signer's charset: slugs, refs, integers, ISO instants in Z form
//   and comma lists; free text travels base64url-encoded under q64. Flags that change what a
//   handler does (unretire, and the expect_status precondition) travel in the JSON body, never in
//   the query.
// - A result row never holds profile_id, secret_hash, reporter ids, push endpoints or tokens,
//   positions, cells or Bluetooth fields: every row is rebuilt from an allow-list of keys, so a
//   field the Worker might add later never reaches the output by accident.
// - mode 'dry-run' reads and counts and writes nothing.

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import dc from 'node:diagnostics_channel';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_NAME, signAdminRequest } from '../../lib/admin-sign.mjs';
import { adminTokenPaths, shellPath, shellQuote } from '../../lib/admin-token-file.mjs';
import { withoutControlKeys } from '../commands/conferences.mjs';
import { AdminError, NotFoundError, UnsupportedError, UsageError } from '../errors.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TIMEOUT_MS = 60_000;
const RETRIES = 3;
const SEARCH_LIMIT_MAX = 200;
const Q64_MAX_BYTES = 200;
const TEXT_MAX = 300;

// What `attendees view` prints, by section, as the Worker names the fields (W7.2).
const PROFILE_KEYS = ['ref', 'display_name', 'hidden', 'spot_hidden', 'open_to_meet', 'sample', 'visible_until', 'updated_at', 'presence'];
const TEXT_KEYS = ['about', 'interests', 'expertise', 'contact_note', 'spot', 'pending'];
const CONTACT_KEYS = ['linkedin_url'];
const MEET_STATES = ['requested', 'accepted', 'declined', 'ended', 'other'];
// The tables GET /admin/stats?event= counts (worker/src/admin.js STAT_TABLES, plus vectors).
const STAT_KEYS = ['talks', 'topics', 'facets', 'people', 'shared_talks', 'presence', 'blocks', 'meets', 'reports', 'push_subs', 'nudges', 'vectors'];

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The 404 codes of a missing target (worker/src/admin.js); any other 404 is a refusal.
const TARGET_CODES = new Set(['not_found', 'no_operator_block']);
// The short name of a network failure, for messages: its code, or "timeout".
const failureOf = (err) => {
  if (err?.name === 'TimeoutError') return 'timeout';
  const code = String(err?.cause?.code ?? err?.code ?? err?.name ?? 'error');
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'network error';
};
// The note of a result whose counts may be short, because an earlier attempt may have done more.
const EARLIER = 'earlier_attempt_may_have_run';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const int = (v) => (Number.isInteger(v) ? v : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const bool = (v) => v === true;
const str = (v) => (typeof v === 'string' ? v : null);
const cut = (v) => (typeof v === 'string' ? v.slice(0, TEXT_MAX) : v === null || v === undefined ? null : typeof v === 'object' ? v : String(v));
const countKey = (slug) => String(slug).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
// One search or view row, every listed field present and nothing else.
const personRow = (p) => ({ ref: str(p.ref), display_name: str(p.display_name), hidden: bool(p.hidden), spot_hidden: bool(p.spot_hidden), open_to_meet: bool(p.open_to_meet), sample: bool(p.sample), visible_until: str(p.visible_until) });
const isRedirect = (res) => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A short, safe description of an error answer: the status and, when the body is a JSON object
// whose `error` (and `cause`) is a short plain text, that text. Never any other part of the body.
const plainCode = (v, max = 120) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_ .:,'-]+$/.test(v) ? v : '');
function describe(status, json) {
  const code = plainCode(json?.error);
  const cause = plainCode(json?.cause, 60);
  if (!code) return `status ${status}`;
  return `status ${status} (${code}${cause ? `; cause ${cause}` : ''})`;
}

// The mismatching documents of a 409 status_mismatch, as the peer's adminClient shows them
// (worker/ingest/lib.mjs): `slug expected->actual` with the arrow U+2192, "(no row)" for the JSON
// value null (the directory has no row for the slug) and a status that reads as null quoted, so
// the two never look the same. Only well-formed slugs and statuses are named, at most 20; an entry
// with anything else is counted, not shown.
const STATUS_WORD_RE = /^[A-Za-z0-9_-]{1,40}$/;
const isStatusWord = (v) => v === null || (typeof v === 'string' && STATUS_WORD_RE.test(v));
const statusShown = (v) => (v === null ? '(no row)' : /^null$/i.test(v) ? `"${v}"` : v);
function mismatchList(mismatched) {
  const entries = Array.isArray(mismatched) ? mismatched : [];
  const shown = entries
    .filter((m) => isPlainObject(m) && typeof m.slug === 'string' && SLUG_RE.test(m.slug) && isStatusWord(m.expected) && isStatusWord(m.actual))
    .map((m) => `${m.slug} ${statusShown(m.expected)}\u2192${statusShown(m.actual)}`);
  const hidden = entries.length - shown.length;
  const named = shown.length ? `${shown.slice(0, 20).join(', ')}${shown.length > 20 ? ` and ${shown.length - 20} more` : ''}` : '(none named)';
  return `${named}${hidden > 0 ? ` (${hidden} malformed ${hidden === 1 ? 'entry' : 'entries'} not shown)` : ''}`;
}

// The statuses a directory row stores (worker/src/directory.js #upsert), which GET
// /api/conferences lists as they are.
const ROW_STATUSES = ['searchable', 'unavailable'];

// Whether undici wrote a whole admin request to a socket (N1). undici publishes
// undici:client:sendHeaders once it has written a request's headers to a connected socket and
// undici:request:bodySent once it has written the body (for a request without one too); both
// carry the request, whose headers hold the attempt's X-Caddie-Admin value, unique per attempt (its
// nonce). A refused connection, a DNS failure and a reset during the TLS handshake fire neither
// (checked on Node 22.23 and 26.11). trackSend(headerValue) listens for both until stop(); sent()
// is true when both fired for that request. A fetch other than undici's fires neither, so its
// network errors never count as "may have run". createWorkerAdapter takes another trackSend for
// the tests.
const SEND_HEADERS = 'undici:client:sendHeaders';
const BODY_SENT = 'undici:request:bodySent';
function headerHolds(headers, value) {
  const name = HEADER_NAME.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name && String(headers[i + 1]) === value) return true;
    return false;
  }
  if (typeof headers === 'string') return headers.split('\r\n').some((line) => line.slice(0, name.length + 1).toLowerCase() === `${name}:` && line.slice(name.length + 1).trim() === value);
  return false;
}
export function trackSend(headerValue) {
  let headersSent = false;
  let bodySent = false;
  const onHeaders = (m) => { if (headerHolds(m?.request?.headers, headerValue)) headersSent = true; };
  const onBody = (m) => { if (headerHolds(m?.request?.headers, headerValue)) bodySent = true; };
  dc.subscribe(SEND_HEADERS, onHeaders);
  dc.subscribe(BODY_SENT, onBody);
  return {
    sent: () => headersSent && bodySent,
    stop: () => {
      dc.unsubscribe(SEND_HEADERS, onHeaders);
      dc.unsubscribe(BODY_SENT, onBody);
    },
  };
}

// A 404 of the Worker. `missing` when its code names a missing target (not_found,
// no_operator_block); otherwise a refusal, which the Worker answers {"error": "Not found"} to a
// refused signature, the failed-signature limiter, an unknown route and a missing nonce alike.
// `mayHaveRun` is set when an earlier attempt of the same request may have run on the Worker.
// `earlier` names an earlier attempt of a write that failed (a network error or a 5xx): it may
// have reached the Worker and done the work, and the message says so.
class WorkerNotFoundError extends NotFoundError {
  constructor(what, { code = null, mayHaveRun = false, earlier = null } = {}) {
    const missing = TARGET_CODES.has(code);
    super(`${missing
      ? `${what}: no such target (the Worker answered ${code})`
      : `${what}: refused: check the admin key, the failed-signature rate limit or the route (the Worker answers 404 "Not found" to each)`}${earlierNote(earlier)}`);
    this.workerCode = code;
    this.missing = missing;
    this.mayHaveRun = mayHaveRun;
    this.earlier = earlier;
  }
}
function earlierNote(earlier) {
  return earlier ? `; an earlier attempt failed (${earlier}); if it reached the Worker it may have done the work` : '';
}

// A conference the Worker does not route or will not write to (400 "conference is not available":
// never added, a typo, or removed): exit 4 with its own code.
function unrouted(slug, where = null) {
  const s = typeof slug === 'string' && SLUG_RE.test(slug) ? slug : null;
  const err = new NotFoundError(`${where ? `${where}: ` : ''}the Worker does not route ${s ?? 'this conference'} or takes no admin write for it; check the slug; if it was removed, run conferences unretire --event ${s ?? '<slug>'} and then conferences refresh`);
  err.code = 'conference_unavailable';
  return err;
}

// The optional Cloudflare Access service token: both variables set, or nothing. Sent on admin
// requests only; never printed, logged or audited.
function accessHeaders(env) {
  const id = String(env.CF_ACCESS_CLIENT_ID ?? '').trim();
  const secret = String(env.CF_ACCESS_CLIENT_SECRET ?? '').trim();
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {};
}

// The Worker's origin from the config entry: https, or plain http to this machine only (the rule of
// worker/ingest/lib.mjs normalizeApiBase), with no path, query or fragment, as the signer requires.
export function workerOrigin(backend) {
  let u;
  try {
    u = new URL(String(backend.api ?? ''));
  } catch {
    throw new UsageError(`backend "${backend.name}" needs an https api url`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.includes(u.hostname))) throw new UsageError(`backend "${backend.name}" needs an https api url (http only for localhost)`);
  if (u.pathname !== '/' || u.search || u.hash) throw new UsageError(`backend "${backend.name}": api must be the Worker's origin with no path, query or fragment`);
  return u.origin;
}

// The search text as the Worker reads it: base64url without padding of at most 200 bytes of UTF-8.
export function q64Of(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length === 0) throw new UsageError('--name must not be empty');
  if (bytes.includes(0)) throw new UsageError('--name must not hold a NUL character');
  if (bytes.length > Q64_MAX_BYTES) throw new UsageError(`--name must be at most ${Q64_MAX_BYTES} bytes of UTF-8`);
  return bytes.toString('base64url');
}

// An ISO instant in the Z form, which passes the signer's query charset (a "+" offset would not).
const isoZ = (value) => new Date(value).toISOString();

// A child's environment: the basics gh needs (its own variables included), never the admin token
// or anything whose name looks like a token, a secret, a password or a key except gh's own.
const CHILD_ENV_RE = /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|SHELL|USER|SYSTEMROOT|PATHEXT|APPDATA|USERPROFILE|COMSPEC|LOCALAPPDATA|XDG_CONFIG_HOME|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|GH_HOST|GH_REPO|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/;
const GH_OWN_RE = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/;
const CHILD_ENV_DENY_RE = /(TOKEN|SECRET|PASSWORD|API_KEY)/i;

export function createWorkerAdapter(backend, { credential, env = {}, spawn = defaultSpawnSync, fetch = (...args) => globalThis.fetch(...args), root = REPO_ROOT, now = () => new Date(), trackSend: track = trackSend } = {}) {
  if (typeof credential !== 'string' || !credential) throw new AdminError('no credential for the Worker backend');
  const api = workerOrigin(backend);
  const access = accessHeaders(env);

  // ---- transport ----

  // One signed admin request. Resolves to { status, json, mayHaveRun } where json is the answer's
  // JSON object and mayHaveRun says an earlier attempt may have run on the Worker; throws
  // WorkerNotFoundError on 404, NotFoundError (conference_unavailable) on a conference the Worker
  // does not route, AdminError on any other failure. Network failures, 429 and 5xx are retried with
  // a fresh signature; a 503 for the daily limit and a redirect are not. With expectOk, a 2xx must
  // carry "ok": true. nextBody({ status, json }), when given, is asked for the body of the next
  // attempt after an answer that may say what the failed attempt did: a 5xx whose body is a JSON
  // object, or a 2xx whose body was lost (json null). It returns the new body, or undefined to
  // keep the one sent; each attempt is signed afresh, so the body hash follows the body.
  async function admin(method, path, body, { expectOk = false, nextBody } = {}) {
    const where = `${method} ${path.split('?')[0]}`;
    let payload = body === undefined ? undefined : JSON.stringify(body);
    const follow = (status, json) => {
      const next = nextBody ? nextBody({ status, json }) : undefined;
      if (next !== undefined) payload = JSON.stringify(next);
    };
    const write = method !== 'GET';
    let lastError = 'no attempt';
    let lastStatus = 0;
    let lastJson = null;
    let mayHaveRun = false;
    // The last failed attempt that may have reached the Worker (a network error or a 5xx).
    let earlier = null;
    // What each attempt that may have run (mayHaveRun) answered, in order, for a 409
    // status_mismatch that follows: "answered status 502 (...)", "answered status 200, its answer
    // lost" or "got no answer (<code>)".
    const ran = [];
    const note = () => (write ? earlierNote(earlier) : '');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      let signed;
      try {
        signed = signAdminRequest({ method, path, base: api, body: payload, key: credential, now: now().getTime() });
      } catch (err) {
        throw new UsageError(`${where}: ${err.message}`);
      }
      const networkError = (err) => `${where}: ${err?.name === 'TimeoutError' ? 'timeout' : `network error (${err?.cause?.code ?? err?.name ?? 'error'})`}`;
      let res;
      const probe = track(signed.header);
      try {
        res = await fetch(signed.url, {
          method,
          headers: { [HEADER_NAME]: signed.header, ...access, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Only a request undici had written whole may have run; one that never left (refused,
        // DNS, a reset during the TLS handshake) did not.
        if (probe.sent()) {
          mayHaveRun = true;
          ran.push(`got no answer (${failureOf(err)})`);
        }
        earlier = failureOf(err);
        lastError = networkError(err);
        if (attempt < RETRIES) await sleep(250 * 2 ** attempt);
        continue;
      } finally {
        probe.stop();
      }
      if (isRedirect(res)) {
        res.body?.cancel().catch(() => {});
        throw new AdminError(`${where}: status ${res.status}, a redirect; admin requests never follow redirects, so the api must be the Worker's own origin`);
      }
      // A 5xx may have run the handler (a 502 from a route that threw half way, a platform error
      // after the handler), whether or not its body can be read; a daily_limit body stops below.
      if (res.status >= 500) mayHaveRun = true;
      let text;
      try {
        text = await res.text();
      } catch (err) {
        // A 2xx ran and only its answer was lost; a 5xx may have run.
        if (res.ok) mayHaveRun = true;
        if (res.ok || res.status >= 500) ran.push(`answered status ${res.status}, its answer lost`);
        earlier = res.ok || res.status >= 500 ? `status ${res.status}, answer lost` : failureOf(err);
        // A 2xx ran: the next attempt may say what it did (PUT /admin/conferences: committed).
        if (res.ok) follow(res.status, null);
        lastError = networkError(err);
        if (attempt < RETRIES) await sleep(250 * 2 ** attempt);
        continue;
      }
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) {
        // A success that does not say so is not taken for one: the request may have run, so the
        // operator checks before running it again.
        if (!isPlainObject(parsed)) throw new AdminError(`${where}: status ${res.status} without a JSON object; the request may have taken effect, check before running it again`);
        if (expectOk && parsed.ok !== true) throw new AdminError(`${where}: status ${res.status} without "ok": true; the request may have taken effect, check before running it again`);
        return { status: res.status, json: parsed, mayHaveRun };
      }
      const json = isPlainObject(parsed) ? parsed : {};
      lastError = `${where}: ${describe(res.status, json)}`;
      lastStatus = res.status;
      lastJson = json;
      // An unretire that came later by the directory's order overtook the removal (409). At step
      // "wipe" the object had already taken it and refused the wipe (wiped false, nothing
      // deleted); at step "directory" the object was wiped first and the row was kept (wiped
      // true, with the counts). removeConference turns this into what happened and the two
      // commands the operator chooses between.
      if (json.error === 'removal_superseded') {
        const step = json.step === 'wipe' || json.step === 'directory' ? json.step : json.wiped === false ? 'wipe' : 'directory';
        const superseded = new AdminError(`${where}: an unretire overtook the removal at step ${step} (status ${res.status})`);
        superseded.code = 'removal_superseded';
        superseded.status = res.status;
        const deleted = {};
        for (const [table, n] of Object.entries(isPlainObject(json.deleted) ? json.deleted : {})) if (/^[A-Za-z0-9_]{1,40}$/.test(table)) deleted[table] = int(n);
        superseded.detail = { step, wiped: typeof json.wiped === 'boolean' ? json.wiped : null, retired: typeof json.retired === 'boolean' ? json.retired : null, deleted };
        throw superseded;
      }
      // A removal that stopped between its steps (tombstone, wipe, directory row): the next run
      // finishes it, so the operator is told to run it again rather than the client retrying blind.
      if (json.error === 'removal_incomplete') {
        const step = typeof json.step === 'string' && /^[a-z_]{1,20}$/.test(json.step) ? json.step : 'unknown';
        const cause = typeof json.cause === 'string' && /^[A-Za-z0-9_ .:,'-]{1,120}$/.test(json.cause) ? `; cause: ${json.cause}` : '';
        const after = Number(res.headers.get('retry-after'));
        const hint = Number.isFinite(after) && after > 0 ? `run the removal again after ${after} seconds (Retry-After)` : 'run the removal again (after the Retry-After the Worker sent, if any)';
        throw new AdminError(`${where}: removal incomplete at step ${step} (status ${res.status}; retired ${json.retired === true}, wiped ${json.wiped === true}${cause}); ${hint}`);
      }
      // The expect_status precondition of PUT /admin/conferences did not hold (#79): the
      // directory's row of a slug has another status than the document expected, and nothing was
      // written. Never retried: the same body would mismatch again. The error carries the answer
      // and the answers of the earlier attempts of this request that may have run (ran), because
      // one of them may be what changed the status; putConference turns it into the operator's
      // message.
      if (res.status === 409 && json.error === 'status_mismatch') {
        const mismatch = new AdminError(lastError);
        mismatch.code = 'status_mismatch';
        mismatch.status = res.status;
        mismatch.json = json;
        mismatch.mayHaveRun = mayHaveRun;
        mismatch.ran = [...ran];
        throw mismatch;
      }
      // A conference the Worker does not route: never added, or removed (its object refuses admin
      // requests after a wipe until an unretire puts the directory row back). Exit 4, as every
      // other absent conference.
      if (res.status === 400 && json.error === 'conference is not available') {
        throw unrouted(/[?&]event=([a-z0-9-]+)/.exec(path)?.[1], where);
      }
      if (res.status === 404) throw new WorkerNotFoundError(where, { code: typeof json.error === 'string' ? json.error : null, mayHaveRun, earlier: write ? earlier : null });
      if (res.status === 401) {
        const code = json.error;
        if (code === 'admin_skew') throw new AdminError(`${lastError}: this machine's clock is more than five minutes from the Worker's${note()}`);
        if (code === 'admin_replay') throw new AdminError(`${lastError}: the Worker saw this nonce before${note()}`);
        throw new AdminError(`${lastError}${note()}`);
      }
      // The account's daily limit: as the error, or as the cause of a 503 unretire_incomplete
      // (PUT /admin/conferences when a fan-out hit it). Retrying before 00:00 UTC cannot help.
      if (res.status === 503 && (json.error === 'daily_limit' || json.cause === 'daily_limit')) {
        const limited = new AdminError(`${lastError}: the account's daily limit is reached; try again after 00:00 UTC${note()}`);
        limited.status = res.status;
        limited.json = json;
        limited.dailyLimit = true;
        throw limited;
      }
      // A 429 is the limiter's, before any handler; a 5xx may have run (mayHaveRun is set above).
      if (res.status === 429 || res.status >= 500) {
        if (res.status >= 500) {
          earlier = describe(res.status, json);
          ran.push(`answered ${earlier}`);
          if (isPlainObject(parsed)) follow(res.status, parsed);
        }
        const after = Number(res.headers.get('retry-after'));
        if (attempt < RETRIES) await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 250 * 2 ** attempt);
        continue;
      }
      throw new AdminError(`${lastError}${note()}`);
    }
    const gaveUp = new AdminError(`${lastError} (gave up after ${RETRIES + 1} attempts${note()})`);
    gaveUp.status = lastStatus;
    gaveUp.json = lastJson;
    throw gaveUp;
  }

  // One public GET (/api/*): unsigned, no Access headers, no redirect, and never a cached copy
  // (the Worker serves /api/conferences with max-age=60): Cache-Control: no-cache on the request
  // and, with fresh, a query key the Worker ignores, so no cache on the way answers from an
  // earlier copy.
  async function publicGet(path, { fresh = false } = {}) {
    let res;
    try {
      res = await fetch(`${api}${path}${fresh ? `?fresh=${Date.now()}` : ''}`, { headers: { 'Cache-Control': 'no-cache' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new AdminError(`GET ${path} failed: ${err?.cause?.code ?? err?.name ?? 'error'}`);
    }
    if (isRedirect(res)) {
      res.body?.cancel().catch(() => {});
      throw new AdminError(`GET ${path}: status ${res.status}, a redirect; the api must be the Worker's own origin`);
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json && typeof json === 'object' ? json : {} };
  }

  const q = (params) => Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&');

  // The not-found of a target by its ref or id, named for the operator.
  const notFound = (what, err) => new WorkerNotFoundError(what, { code: err?.workerCode ?? null, mayHaveRun: err?.mayHaveRun ?? false, earlier: err?.earlier ?? null });
  const isNotFound = (err) => err instanceof WorkerNotFoundError;

  // A 404 not_found of a delete or an unhide after an attempt that may have run: that attempt may
  // have done the work, so the command succeeds and says so (PEER-6). A refusal never does.
  const alreadyDone = (err, what) => (isNotFound(err) && err.workerCode === 'not_found' && err.mayHaveRun ? `${what}: already done (an earlier attempt may have run and its answer was lost; the retry answered not_found)` : null);

  // ---- people reads ----

  async function viewRaw(event, ref, fields) {
    const query = { event, ref, ...(fields.length ? { fields: fields.join(',') } : {}) };
    let json;
    try {
      ({ json } = await admin('GET', `/admin/people/view?${q(query)}`));
    } catch (err) {
      throw isNotFound(err) ? notFound(`profile ${ref} at ${event}`, err) : err;
    }
    const p = json.person;
    if (!p || typeof p !== 'object' || typeof p.ref !== 'string') throw new AdminError(`GET /admin/people/view: the answer has no person`);
    return p;
  }

  // The meet buckets as the Worker sends them (the five of the spec, plus whatever it adds), so a
  // renamed bucket still shows and the total still adds up.
  const meetCounts = (p) => {
    const m = p.counts?.meets && typeof p.counts.meets === 'object' ? p.counts.meets : {};
    const by = Object.fromEntries(MEET_STATES.map((s) => [s, int(m[s])]));
    for (const [state, n] of Object.entries(m)) if (/^[a-z_]{1,20}$/.test(state)) by[state] = int(n);
    return { by, total: Object.values(by).reduce((a, b) => a + b, 0) };
  };
  const reportCounts = (p) => {
    const r = p.counts?.reports ?? {};
    const reasons = {};
    for (const [reason, n] of Object.entries(r.reasons ?? {})) if (/^[A-Za-z0-9_-]{1,40}$/.test(reason)) reasons[reason] = int(n);
    return { total: int(r.total), reasons };
  };

  // ---- child processes ----

  function childEnv() {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
      if (CHILD_ENV_RE.test(key) && (GH_OWN_RE.test(key) || !CHILD_ENV_DENY_RE.test(key)) && typeof value === 'string') out[key] = value;
    }
    return out;
  }

  function runGh(args) {
    const result = spawn('gh', args, { cwd: root, encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    const lines = (text) => String(text ?? '').split('\n').filter(Boolean);
    if (result.error) throw new AdminError(`gh could not start: ${result.error.code ?? result.error.message}; install the GitHub CLI and run gh auth login`);
    if (result.status !== 0) throw new AdminError(`gh exited with ${result.status}${lines(result.stderr).length ? `: ${lines(result.stderr)[0]}` : ''}`);
    return { stdout: lines(result.stdout), stderr: lines(result.stderr) };
  }

  // ---- conferences ----

  // The Worker's public listing. An answer without a conferences array is an error, never an empty
  // list: the unretire check reads "not listed" from it.
  async function conferenceList() {
    const { status, json } = await publicGet('/api/conferences', { fresh: true });
    if (status !== 200) throw new AdminError(`GET /api/conferences failed with status ${status}`);
    if (!Array.isArray(json.conferences)) throw new AdminError('GET /api/conferences: the answer holds no conferences list');
    return json.conferences.filter((c) => c && typeof c.slug === 'string');
  }

  // Sends the rewritten local conference document (and nothing else of the batch answer is
  // trusted): a retired slug the Worker skipped is an error, because the hide did not happen.
  // The document's own control keys (withoutControlKeys) are dropped; an unretire carries "unretire":
  // true and its expect_status (a status string or null), which the Worker checks against the
  // slug's directory row inside its upsert transaction (#79).
  async function putConference(slug, doc, { unretire = false, expectStatus } = {}) {
    const fields = withoutControlKeys(doc);
    const sent = { ...fields, slug, ...(unretire ? { unretire: true } : {}), ...(expectStatus !== undefined ? { expect_status: expectStatus } : {}) };
    // The status the directory stores the document with (worker/src/directory.js #upsert).
    const stored = sent.status === 'searchable' ? 'searchable' : 'unavailable';
    // After an answer that proves the directory committed the document, the row has that status,
    // so the next attempt expects it rather than what the listing showed: a 502 unretire_incomplete
    // (the Worker fans out only after the directory's 200, worker/src/index.js) or a 2xx whose
    // body was lost. A removal that lands between the attempts then still mismatches, and is not
    // undone. After any other failure (a network error, another 5xx) nothing proves a commit, so
    // the body stays, and a 409 on the repeat is the cautious outcome.
    const nextBody = unretire && expectStatus !== undefined
      ? ({ status, json: answer }) => (answer?.error === 'unretire_incomplete' || (status >= 200 && status < 300) ? { conferences: [{ ...sent, expect_status: stored }] } : undefined)
      : undefined;
    let json;
    try {
      ({ json } = await admin('PUT', '/admin/conferences', { conferences: [sent] }, { nextBody }));
    } catch (err) {
      // The slug's row does not have the status this attempt expected. Nothing was written by
      // this attempt, and the CLI never re-reads and resends on its own. A status a row never
      // stores means the Worker and the CLI disagree on what a row holds: no re-run can help.
      // When every mismatch shows the status this command sent and an earlier attempt may have
      // run, that attempt may be what set it (its answer was not one that proves a commit, which
      // would have changed the expectation): the operator re-runs the unretire. Otherwise
      // something else changed the conference: the operator checks it before a re-run, which reads
      // the listing again and expects what it finds.
      if (unretire && err?.code === 'status_mismatch') {
        const entries = Array.isArray(err.json?.mismatched) ? err.json.mismatched : [];
        const ran = Array.isArray(err.ran) ? err.ran : [];
        let advice;
        if (entries.some((m) => !isPlainObject(m) || (m.actual !== null && !ROW_STATUSES.includes(m.actual)))) {
          advice = `the Worker answered a status that a directory row never holds in this CLI's version (${ROW_STATUSES.join(' or ')}, or no row), so the Worker and this CLI are not from the same version; do not run the unretire again until they are`;
        } else if (ran.length && entries.length && entries.every((m) => m.actual === stored)) {
          const which = ran.length === 1
            ? `an earlier attempt of this command ${ran[0]} and may have been applied`
            : `earlier attempts of this command may have been applied (${ran.join('; ')})`;
          advice = `${which}, so the actual status can be the one this command sent; run conferences unretire --event ${slug} again until it answers 200: each run re-reads the status and expects that`;
        } else {
          advice = `something else changed the conference after this command read it (another remove, unretire, hide or unhide, or an ingest run); check it with conferences list --all, then run conferences unretire --event ${slug} again if it is still wanted: it re-reads the status and expects that`;
        }
        const mismatch = new AdminError(`unretire of ${slug} not applied: the directory holds another status than this command expected (expected\u2192actual): ${mismatchList(entries)}; nothing was written by this attempt; ${advice} (${err.message})`);
        mismatch.code = 'status_mismatch';
        throw mismatch;
      }
      // A flagged fan-out that failed answers 502 unretire_incomplete (with a cause such as
      // unretire_superseded or conference_retired) and the slugs it could not sync; the client
      // retried it (signed afresh, and a second unretire repairs the first). Still failing, the
      // operator runs it again. A 503 with cause daily_limit stopped at once: run it again after
      // the reset.
      if (unretire && err instanceof AdminError && (err.json?.error === 'unretire_incomplete' || err.status === 502)) {
        const failed = (Array.isArray(err.json?.unretire_failed) ? err.json.unretire_failed : []).filter((s) => typeof s === 'string' && SLUG_RE.test(s));
        const again = err.dailyLimit ? "the account's daily limit is reached; run the unretire again after 00:00 UTC" : 'run the unretire again';
        const incomplete = new AdminError(`unretire of ${failed.length ? failed.join(', ') : slug} incomplete; ${again} (${err.message})`);
        incomplete.code = 'unretire_incomplete';
        throw incomplete;
      }
      throw err;
    }
    const skipped = Array.isArray(json.skipped_retired) ? json.skipped_retired : [];
    // An unretire the Worker skipped kept the tombstone and applied nothing of the document: a
    // Worker that reads "unretire": true never skips the slug, so it is older than that flag.
    if (skipped.includes(slug) && unretire) {
      const kept = new AdminError(`unretire of ${slug} not applied (retired): the Worker answered status 200 and listed ${slug} under skipped_retired, so it kept the tombstone and applied nothing of the document; a Worker that reads "unretire": true never skips it, so check that the Worker is deployed from a version with the unretire flag (worker/README.md), then run conferences unretire --event ${slug} again`);
      kept.code = 'skipped_retired';
      throw kept;
    }
    if (skipped.includes(slug)) throw new AdminError(`${slug} is retired on the Worker (a tombstone from conferences remove); run conferences unretire --event ${slug} first`);
    return { upserted: int(json.upserted), searchable: int(json.searchable), synced: int(json.synced) };
  }

  async function writeConferenceDoc(slug, doc, mode) {
    const current = (await conferenceList()).find((c) => c.slug === slug);
    if (!current) throw new NotFoundError(`no conference ${slug} on this backend (GET /api/conferences does not list it)`);
    const wanted = `${doc.status}${doc.status_reason ? ` (${doc.status_reason})` : ''}`;
    if (mode === 'dry-run') return { summary: `would send ${slug} as ${wanted} to the Worker (now ${current.status})` };
    const counts = await putConference(slug, doc);
    return { counts, summary: `sent ${slug} as ${wanted} to the Worker (was ${current.status}; ${counts.synced} object${counts.synced === 1 ? '' : 's'} synced)` };
  }

  // The per-table counts of a conference, or null when the Worker does not route the slug.
  async function statsOf(event) {
    try {
      return await statsRaw(event);
    } catch (err) {
      if (err instanceof NotFoundError && err.code === 'conference_unavailable') return null;
      throw err;
    }
  }

  async function statsRaw(event) {
    const { json } = await admin('GET', `/admin/stats?${q({ event })}`);
    const counts = {};
    for (const key of STAT_KEYS) if (json[key] !== undefined) counts[key] = int(json[key]);
    const u = json.usage && typeof json.usage === 'object' ? json.usage : {};
    return { counts, usage: { day: str(u.day), requests: int(u.requests), rows_read: int(u.rows_read), rows_written: int(u.rows_written), pace: Number.isFinite(u.pace) ? u.pace : null, stale: u.stale === true } };
  }

  async function accountStats() {
    const { json } = await admin('GET', '/admin/stats');
    const usage = {};
    for (const [slug, u] of Object.entries(json.usage && typeof json.usage === 'object' ? json.usage : {})) {
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug) || !u || typeof u !== 'object') continue;
      usage[slug] = { requests: int(u.requests), rows_read: int(u.rows_read), rows_written: int(u.rows_written) };
    }
    const holds = new Set(Object.entries(json.holds && typeof json.holds === 'object' ? json.holds : {}).filter(([, v]) => v === true).map(([k]) => k));
    return { day: str(json.day), usage, holds };
  }

  // ---- the adapter ----

  return {
    async searchPeople({ event, ref, name, options }) {
      if (ref !== undefined) {
        let json;
        try {
          ({ json } = await admin('GET', `/admin/people/search?${q({ event, ref })}`));
        } catch (err) {
          throw isNotFound(err) ? notFound(`profile ${ref} at ${event}`, err) : err;
        }
        const people = Array.isArray(json.people) ? json.people : [];
        if (!people.length) throw new NotFoundError(`no profile with ref ${ref} at ${event}`);
        return { items: people.map(personRow), counts: { matched: 1 }, summary: `1 attendee at ${event}` };
      }
      const limit = Math.min(options.limit, SEARCH_LIMIT_MAX);
      const query = { event, q64: q64Of(name), limit, ...(options.includeHidden ? { include_hidden: 1 } : {}) };
      const { json } = await admin('GET', `/admin/people/search?${q(query)}`);
      const items = (Array.isArray(json.people) ? json.people : []).map(personRow);
      const matched = Number.isInteger(json.matched) ? json.matched : items.length;
      return {
        items,
        counts: { matched, shown: items.length },
        summary: `${plural(matched, 'attendee')} matched at ${event}${matched > items.length ? `, ${items.length} shown (--limit${options.limit > SEARCH_LIMIT_MAX ? `, at most ${SEARCH_LIMIT_MAX} on tier 2` : ''})` : ''}${options.includeHidden ? '' : ' (hidden excluded)'}`,
      };
    },

    async viewPerson({ event, ref, options }) {
      const fields = [...(options.text ? ['text'] : []), ...(options.contact ? ['contact'] : [])];
      const p = await viewRaw(event, ref, fields);
      const profile = Object.fromEntries(PROFILE_KEYS.map((k) => [k, k === 'presence' ? (p.presence === 'on' ? 'on' : 'off') : ['hidden', 'spot_hidden', 'open_to_meet', 'sample'].includes(k) ? bool(p[k]) : str(p[k])]));
      profile.shared_talks = int(p.counts?.shared_talks);
      const meets = meetCounts(p);
      const reports = reportCounts(p);
      const push = { web: int(p.counts?.push?.web) };
      const blocksMade = int(p.counts?.blocks_made);
      const blocksReceived = int(p.counts?.blocks_received);
      const items = [profile, { meets: meets.total, meets_by_state: meets.by, blocks_made: blocksMade, blocks_received: blocksReceived, push, reports }];
      if (options.text) items.push(Object.fromEntries(TEXT_KEYS.map((k) => [k, k === 'pending' ? (p.pending && typeof p.pending === 'object' ? Object.fromEntries(Object.entries(p.pending).map(([a, b]) => [a, cut(b)])) : {}) : cut(p[k])])));
      if (options.contact) items.push(Object.fromEntries(CONTACT_KEYS.map((k) => [k, str(p[k])])));
      return {
        items,
        counts: { meets: meets.total, blocks_made: blocksMade, blocks_received: blocksReceived, push: push.web, reports: reports.total },
        summary: `attendee ${ref} at ${event}${options.text ? ' with text' : ''}${options.contact ? ' with contact' : ''}`,
      };
    },

    async deletePerson({ event, ref, mode }) {
      if (mode === 'dry-run') {
        const p = await viewRaw(event, ref, []);
        const counts = { profile: 1, meets: meetCounts(p).total, blocks_made: int(p.counts?.blocks_made), push: int(p.counts?.push?.web), reports: reportCounts(p).total };
        const what = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
        return { counts, summary: `would delete profile ${ref} at ${event} and what goes with it (blocks others made and reports stay): ${what}` };
      }
      try {
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'delete', kind: 'profile', id: ref }, { expectOk: true });
      } catch (err) {
        const done = alreadyDone(err, `profile ${ref}`);
        if (done) return { counts: { profile: 0 }, note: 'already_deleted', summary: done };
        throw isNotFound(err) ? notFound(`profile ${ref} at ${event}`, err) : err;
      }
      return { counts: { profile: 1 }, summary: `deleted profile ${ref} at ${event} with its presence, shared talks, meets, push subscriptions, nudges and own blocks` };
    },

    async setOperatorBlock({ event, ref, options, mode }) {
      if (mode === 'dry-run') {
        const p = await viewRaw(event, ref, []);
        const reports = reportCounts(p);
        const blocked = int(reports.reasons.operator) > 0;
        const others = Math.max(reports.total - (blocked ? 1 : 0), 0);
        if (!options.unblock) return { counts: { reports: reports.total }, summary: `would ${p.hidden === true ? 'keep' : 'set'} profile ${ref} hidden with an operator report (${plural(reports.total, 'report')} on file)` };
        return { counts: { reports_remaining: others }, summary: blocked ? `would remove the operator block of ${ref}; ${plural(others, 'other report')} remain, so the Worker would decide whether it stays hidden` : `${ref} has no operator block` };
      }
      const action = options.unblock ? 'unblock' : 'block';
      let json;
      try {
        ({ json } = await admin('POST', `/admin/people/block?${q({ event })}`, { ref, action }, { expectOk: true }));
      } catch (err) {
        // The unblock answers: after an attempt that may have run, a 404 no_operator_block (the
        // block went) or not_found (a deleted profile's stale report went) is "already unblocked",
        // exit 0. Otherwise both are exit 4, and a "Not found" refusal always is.
        if (options.unblock && isNotFound(err) && err.missing) {
          if (err.mayHaveRun) return { counts: { reports: 0 }, note: 'already_unblocked', summary: `the operator block of ${ref}: already unblocked (an earlier attempt may have run and its answer was lost; the retry answered ${err.workerCode})` };
          if (err.workerCode === 'no_operator_block') throw new NotFoundError(`${ref} has no operator block at ${event}${earlierNote(err.earlier)}`);
        }
        throw isNotFound(err) ? notFound(`profile ${ref} at ${event}`, err) : err;
      }
      if (!options.unblock) return { counts: { reports: 1 }, summary: `profile ${ref} is hidden by an operator report (hidden=${json.hidden === true})` };
      if (json.found === false) return { counts: { reports: json.removed === true ? 1 : int(json.removed) }, found: false, summary: `the profile ${ref} is gone; removed its stale operator report` };
      return { counts: { reports: 1 }, found: true, summary: `removed the operator block of ${ref}; it ${json.hidden === true ? 'stays hidden (other reports remain)' : 'is visible again'}` };
    },

    async moderationQueue({ event, options }) {
      const query = { event, ...(options.since !== undefined ? { since: isoZ(options.since) } : {}) };
      const { json } = await admin('GET', `/admin/moderation?${q(query)}`);
      const show = options.showContent;
      const items = [];
      for (const h of Array.isArray(json.hidden) ? json.hidden : []) {
        if (!h || typeof h !== 'object') continue;
        const meet = h.kind === 'meet';
        const row = { list: 'hidden', kind: str(h.kind), id: meet ? str(h.meet_id) : str(h.ref), reports: int(h.reports) };
        if (show) {
          row.display_name = meet ? `between ${(Array.isArray(h.between) ? h.between : []).map((n) => `"${n}"`).join(' and ')}, state ${h.state ?? '?'}` : str(h.display_name);
          row.reasons = Object.fromEntries(Object.entries(h.reasons && typeof h.reasons === 'object' ? h.reasons : {}).map(([k, v]) => [k, int(v)]));
        }
        items.push(row);
      }
      const hiddenCount = items.length;
      const counts = { hidden: hiddenCount };
      let summary = `${plural(hiddenCount, 'hidden target')} at ${event}.`;
      if (options.since !== undefined) {
        let n = 0;
        for (const r of Array.isArray(json.reports) ? json.reports : []) {
          if (!r || typeof r !== 'object') continue;
          const t = r.target && typeof r.target === 'object' ? r.target : {};
          const row = { list: 'report', created_at: str(r.created_at), kind: str(r.kind), id: t.kind === 'meet' ? str(t.meet_id) : str(t.ref) };
          if (show) {
            row.reason = str(r.reason);
            row.display_name = t.kind === 'meet' ? (t.deleted ? '(meet deleted)' : `between ${(Array.isArray(t.between) ? t.between : []).map((x) => `"${x}"`).join(' and ')}, state ${t.state ?? '?'}`) : str(t.display_name);
          }
          items.push(row);
          n += 1;
        }
        counts.reports = n;
        summary = `${summary} ${plural(n, 'report')} since ${isoZ(options.since)} at ${event}.`;
      }
      return { items, counts, summary };
    },

    async hideTarget({ event, kind, id, mode }) {
      if (mode === 'dry-run') {
        const p = await viewRaw(event, id, []);
        const already = kind === 'profile' ? p.hidden === true : p.spot_hidden === true;
        return { counts: { reports: reportCounts(p).total }, summary: `would ${already ? 'keep' : 'set'} ${kind} ${id} hidden with an operator report (${plural(reportCounts(p).total, 'report')} on file)` };
      }
      try {
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'hide', kind, id }, { expectOk: true });
      } catch (err) {
        throw isNotFound(err) ? notFound(`${kind} ${id} at ${event}`, err) : err;
      }
      return { counts: { [kind]: 1 }, summary: `${kind} ${id} is hidden by an operator report` };
    },

    async unhideTarget({ event, kind, id, mode }) {
      if (mode === 'dry-run') {
        if (kind === 'meet') return { summary: `would clear the hidden flag of meet ${id} and remove its reports (tier 2 has no preview read of a meet)` };
        const p = await viewRaw(event, id, []);
        const reports = reportCounts(p).total;
        // The view counts every report of the person (profile, spot line and meets); the unhide
        // removes only those of this target.
        return { counts: { reports }, summary: `would clear the hidden flag of ${kind} ${id} and remove up to ${plural(reports, 'report')}, those of this ${kind}` };
      }
      let json;
      try {
        ({ json } = await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'unhide', kind, id }, { expectOk: true }));
      } catch (err) {
        const done = alreadyDone(err, `the hidden flag of ${kind} ${id}`);
        if (done) return { counts: { reports: 0 }, note: 'already_unhidden', summary: done };
        throw isNotFound(err) ? notFound(`${kind} ${id} at ${event}`, err) : err;
      }
      const removed = int(json.removed);
      const found = json.found !== false;
      return { counts: { reports: removed }, found, summary: found ? `cleared the hidden flag of ${kind} ${id}; removed ${plural(removed, 'report')}; it is hidden again after two new ones` : `${kind} ${id} is gone; removed ${plural(removed, 'stale report')}` };
    },

    async deleteTarget({ event, kind, id, reason, mode }) {
      if (kind === 'profile') return this.deletePerson({ event, ref: id, reason, mode });
      if (mode === 'dry-run') {
        if (kind === 'meet') return { counts: { meet: 1 }, summary: `would delete meet ${id} (tier 2 has no preview read of a meet)` };
        await viewRaw(event, id, []);
        return { counts: { spot: 1 }, summary: `would clear the spot line of ${id} and keep it hidden` };
      }
      try {
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'delete', kind, id }, { expectOk: true });
      } catch (err) {
        const done = alreadyDone(err, `${kind} ${id}`);
        if (done) return { counts: { [kind]: 0 }, note: 'already_deleted', summary: done };
        throw isNotFound(err) ? notFound(`${kind} ${id} at ${event}`, err) : err;
      }
      return { counts: { [kind]: 1 }, summary: kind === 'meet' ? `deleted meet ${id}` : `cleared the spot line of ${id} and kept it hidden` };
    },

    async purgeReports({ event, mode }) {
      if (mode === 'dry-run') {
        const stats = await statsRaw(event);
        return { counts: { reports: stats.counts.reports ?? 0 }, summary: `would ask the Worker to delete the reports of ${event} made before its end (${plural(stats.counts.reports ?? 0, 'report')} on file; the Worker refuses before the end)` };
      }
      const { json, mayHaveRun } = await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'purge' }, { expectOk: true });
      const purged = int(json.purged);
      if (typeof json.ends_at === 'string') throw new AdminError(`${event} ends at ${json.ends_at}; nothing is purged before that`);
      const earlier = mayHaveRun ? '; an earlier attempt may have run and deleted more (its answer was lost), so the count can be short' : '';
      return { counts: { reports: purged }, ...(mayHaveRun ? { note: EARLIER } : {}), summary: `deleted ${plural(purged, 'report')} of ${event} made before its end${earlier}` };
    },

    async purgeExpired() {
      throw new UnsupportedError('tier 2 purges expired profiles from the Worker\'s hourly cron; there is nothing to run by hand');
    },

    async rules() {
      throw new UnsupportedError('tier 2 compiles its word list into the Worker; moderation rules test and reload are tier 3 commands');
    },

    async listConferences({ options }) {
      const all = await conferenceList();
      const shown = options.all ? all : all.filter((c) => c.status === 'searchable');
      return {
        items: shown.map((c) => ({ slug: c.slug, name: str(c.name), start_date: str(c.start_date), end_date: str(c.end_date), status: c.status === 'searchable' ? 'searchable' : 'unavailable', talks: int(c.talk_count) })),
        counts: { shown: shown.length, total: all.length },
        summary: `${plural(shown.length, 'conference')}${options.all ? '' : ` searchable of ${all.length}`}`,
      };
    },

    async addConference({ slug, mode }) {
      return this.refreshConference({ slug, options: {}, mode });
    },

    // The ingest workflow does the work (it fetches the schedule, pushes talks, topics and facets
    // to the Worker and commits the data files); the CLI only starts it with gh.
    async refreshConference({ slug, options, mode }) {
      const args = ['workflow', 'run', 'ingest.yml', '-f', `events=${slug}`, ...(options.allowShrink ? ['-f', 'allow_shrink=true'] : [])];
      const command = `gh ${args.join(' ')}`;
      if (mode === 'dry-run') return { items: [{ step: 'workflow', command }], summary: `would run the command above (the ingest workflow pushes ${slug} to the Worker)` };
      const { stdout } = runGh(args);
      return { items: [{ step: 'workflow', command }, ...stdout.map((line) => ({ step: 'gh', line }))], summary: `started the ingest workflow for ${slug}; watch it with gh run list --workflow ingest.yml` };
    },

    async hideConference({ slug, doc, mode }) {
      return writeConferenceDoc(slug, doc, mode);
    },

    async unhideConference({ slug, doc, mode }) {
      return writeConferenceDoc(slug, doc, mode);
    },

    async removeConference({ slug, reason, options, mode }) {
      if (mode === 'dry-run') {
        const stats = await statsOf(slug);
        if (!stats) return { counts: {}, summary: `the Worker does not route ${slug} (no directory row); a run would still wipe its object and leave a retired tombstone` };
        const what = Object.entries(stats.counts).map(([k, v]) => `${k} ${v}`).join(', ');
        return { counts: stats.counts, summary: `would wipe ${slug} from the Worker: ${what}; directory row 1, and leave a retired tombstone` };
      }
      let json;
      let mayHaveRun = false;
      try {
        ({ json, mayHaveRun } = await admin('DELETE', `/admin/conference?${q({ event: slug })}`, undefined, { expectOk: true }));
      } catch (err) {
        // The CLI does not act on its own after a superseded removal: it says what the Worker
        // did, and the operator chooses between removing the conference after all and keeping or
        // restoring it, with the same flags.
        if (err?.code === 'removal_superseded') {
          const d = err.detail ?? {};
          const confirm = `--yes --confirm ${slug}`;
          const flags = `${reason ? ` --reason ${reason}` : ''}${options?.purgeLocal ? ' --purge-local' : ''}`;
          const remove = `\`caddie-admin conferences remove --event ${slug}${flags} ${confirm}\``;
          const unretire = `\`caddie-admin conferences unretire --event ${slug} ${confirm}\``;
          const tombstone = d.retired === true
            ? 'the directory holds a tombstone for it again (a later removal wrote one)'
            : d.retired === false ? 'the directory holds no tombstone for it' : 'the Worker could not say whether the directory holds a tombstone for it';
          let story;
          let choice;
          if (d.step === 'wipe' || d.wiped === false) {
            story = "the conference's object had already taken that unretire and refused the wipe, and the directory kept its row: nothing was deleted; the conference is live as the unretire left it";
            choice = `choose one: remove it after all with ${remove}, or keep it as it is (nothing to run; ${unretire} sends the local document again)`;
          } else {
            const what = Object.entries(d.deleted ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
            story = `the object was wiped first (${what || 'nothing was left to delete'}) and the directory kept its row: the conference is listed and its data is gone, and if that unretire's fan-out failed, the object refuses the conference until an unretire is repeated`;
            choice = `choose one: finish the removal with ${remove}, or restore the conference with ${unretire}`;
          }
          const guided = new AdminError(`an unretire overtook the removal of ${slug} at step ${d.step ?? 'directory'}: ${story}; ${tombstone}; nothing further was done; ${choice} (${err.message})`);
          guided.code = 'removal_superseded';
          throw guided;
        }
        throw isNotFound(err) ? notFound(`DELETE /admin/conference for ${slug}`, err) : err;
      }
      const counts = {};
      for (const [table, n] of Object.entries(json.deleted && typeof json.deleted === 'object' ? json.deleted : {})) if (/^[A-Za-z0-9_]{1,40}$/.test(table)) counts[table] = int(n);
      counts.directory = int(json.directory);
      const what = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
      // A removal run again (for example after a lost answer) finds the tombstone already there:
      // already_retired_at is an ISO instant then, and null otherwise.
      const already = typeof json.already_retired_at === 'string' && Number.isFinite(Date.parse(json.already_retired_at)) ? ` (it was retired already, at ${new Date(json.already_retired_at).toISOString()})` : '';
      const earlier = mayHaveRun ? '; an earlier attempt may have run and deleted more (its answer was lost), so these counts can be short' : '';
      const note = mayHaveRun ? EARLIER : already ? 'already_retired' : null;
      return { counts, ...(note ? { note } : {}), summary: `wiped ${slug} from the Worker${what ? `: ${what}` : ' (nothing was left to delete)'}; tombstone ${json.retired === true ? 'left' : 'not confirmed'}${already}, so the weekly ingest skips it until conferences unretire${earlier}` };
    },

    // The document goes out with "unretire": true, which the Worker accepts for any slug, removed
    // or live. So the Worker's own listing is read first: a slug it lists must keep its status
    // (the repair after removal_superseded, unretire_incomplete or removal_incomplete, where the
    // row is still listed), and a different status is refused, because the unretire would change a
    // live conference (DECISIONS.md, caddie-admin C1). The document also carries expect_status,
    // the status of the slug's directory row as this read found it: the listed status, or null
    // when the slug is not listed. GET /api/conferences lists every directory row, tombstoned or
    // with a wiped object alike, with the status the row stores, so "not listed" is "no row". The
    // Worker checks it in the upsert's transaction, so a removal or an unretire that lands between
    // the read and the PUT answers 409 status_mismatch and nothing is written. A listing that
    // shows the slug with a status a row never stores, or twice with two statuses, does not say
    // what the row holds: the unretire is refused and nothing is sent.
    async unretireConference({ slug, doc, mode }) {
      const listed = (await conferenceList()).filter((c) => c.slug === slug);
      const statusOf = (s) => (s === 'searchable' ? 'searchable' : 'unavailable');
      const sending = statusOf(doc.status);
      const wanted = `${sending}${typeof doc.status_reason === 'string' && /^[a-z_]{1,40}$/.test(doc.status_reason) ? ` (${doc.status_reason})` : ''}`;
      const statuses = [...new Set(listed.map((c) => c.status))];
      if (statuses.length > 1 || (statuses.length === 1 && !ROW_STATUSES.includes(statuses[0]))) {
        const shown = statuses.map((v) => (typeof v === 'string' && STATUS_WORD_RE.test(v) ? v : 'a malformed value')).join(' and ');
        const unknown = new AdminError(`${slug} is listed on the Worker as ${shown}, which is not one status a directory row stores (${ROW_STATUSES.join(' or ')}), so this command cannot tell what to expect; refused, nothing was sent; check GET /api/conferences and that the Worker and this CLI are from the same version`);
        unknown.code = 'unretire_refused';
        throw unknown;
      }
      const current = listed[0] ?? null;
      const live = current ? current.status : 'not listed';
      const expectStatus = current ? current.status : null;
      if (current && live !== sending) {
        const refused = new AdminError(`${slug} is listed on the Worker as ${live}, and the unretire would send it as ${wanted}; refused, because that would change a live conference (use conferences hide, unhide or refresh to change its status, or update the local data/${slug}/conference.json first)`);
        refused.code = 'unretire_refused';
        throw refused;
      }
      const expected = JSON.stringify(expectStatus);
      if (mode === 'dry-run') return { backend: 'worker', summary: `would unretire ${slug}: sending ${wanted} (Worker now ${live}) to PUT /admin/conferences with "unretire": true and "expect_status": ${expected} on the document, dropping the Worker's tombstone` };
      const counts = await putConference(slug, doc, { unretire: true, expectStatus });
      return { backend: 'worker', counts, summary: `unretired ${slug}: sent ${wanted} (Worker was ${live}) with unretire: true and expect_status: ${expected}; the Worker dropped its tombstone (upserted ${counts.upserted})` };
    },

    async counts({ event }) {
      if (event !== undefined) {
        const stats = await statsRaw(event);
        return { items: Object.entries(stats.counts).map(([table, n]) => ({ table, count: n })), counts: stats.counts, summary: `rows of ${event} per table` };
      }
      const { day, usage, holds } = await accountStats();
      const items = Object.entries(usage).map(([slug, u]) => ({ conference: slug, requests: u.requests, rows_read: u.rows_read, rows_written: u.rows_written, holds: holds.has(slug) }));
      return { items, counts: Object.fromEntries(items.map((r) => [countKey(r.conference), r.requests])), summary: `requests per conference on ${day ?? 'no day yet (the cron has not run)'}; use --event <slug> for row counts` };
    },

    async usage() {
      const { day, usage, holds } = await accountStats();
      const items = [];
      const total = { requests: 0, rows_read: 0, rows_written: 0 };
      for (const [slug, u] of Object.entries(usage)) {
        // The pace lives in each conference's own meter; a conference the Worker no longer routes
        // has none (null). Any other failure stops the command with its own exit code.
        const own = await statsOf(slug);
        items.push({ conference: slug, requests: u.requests, rows_read: u.rows_read, rows_written: u.rows_written, pace: own?.usage.pace ?? null, holds: holds.has(slug) });
        for (const k of Object.keys(total)) total[k] += u[k];
      }
      items.push({ day, total_requests: total.requests, total_rows_read: total.rows_read, total_rows_written: total.rows_written, conferences: items.length });
      return { items, counts: { conferences: items.length - 1, ...total }, summary: `${plural(items.length - 1, 'conference')} metered on ${day ?? 'no day yet (the cron has not run)'}; totals ${total.requests} requests, ${total.rows_read} rows read, ${total.rows_written} rows written` };
    },

    async health() {
      const health = await publicGet('/api/health');
      const caps = await publicGet('/api/capabilities');
      const c = caps.json ?? {};
      // The api single-quoted, and the token file this CLI reads always named: the smoke reads a
      // file nobody named only for an api in config.json, and a named file works in any POSIX shell
      // whatever it exports. The file is an absolute path quoted for the shell, with a leading ~/
      // left unquoted so it expands.
      const smoke = `BASE_URL=${shellQuote(api)} SMOKE_API=worker ADMIN_TOKEN_FILE=${shellPath(adminTokenPaths(env).path)} node scripts/smoke.mjs`;
      const logs = '(cd worker && npx wrangler tail --format json) | node /path/to/scratch/tail-filter.mjs   # the filter is in worker/README.md, "Logs and CPU"; never run wrangler tail unfiltered';
      return {
        items: [
          { health: health.status, ok: health.json?.ok === true },
          { capabilities: caps.status, tier: c.tier ?? null, ble_mode: c.ble?.mode ?? null, push_apns: c.push?.apns ?? null, push_fcm: c.push?.fcm ?? null },
          { smoke },
          { logs },
        ],
        commands: { smoke, logs },
        summary: `health ${health.status}, capabilities ${caps.status}; run the smoke and log commands above by hand`,
      };
    },
  };
}
