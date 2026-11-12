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
// - A 404 from the Worker means "not found" or "the signature was refused", and the Worker does not
//   say which; every not-found message says so. After a retry of a delete or an unhide (an attempt
//   whose answer was lost may have done the work), a 404 reads as "already done", and after a
//   retried unblock a 404 no_operator_block reads as "already unblocked"; the command succeeds
//   with a note. A removal run again is a success too (already_retired_at), and a removal that
//   stopped between its steps (removal_incomplete) says which step and asks for another run.
// - Query values stay inside the signer's charset: slugs, refs, integers, ISO instants in Z form
//   and comma lists; free text travels base64url-encoded under q64. Flags that change what a
//   handler does (unretire) travel in the JSON body, never in the query.
// - A result row never holds profile_id, secret_hash, reporter ids, push endpoints or tokens,
//   positions, cells or Bluetooth fields: every row is rebuilt from an allow-list of keys, so a
//   field the Worker might add later never reaches the output by accident.
// - mode 'dry-run' reads and counts and writes nothing.

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_NAME, signAdminRequest } from '../../lib/admin-sign.mjs';
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
// whose `error` is a short plain text, that text. Never any other part of the body.
function describe(status, json) {
  const e = json?.error;
  const code = typeof e === 'string' && /^[A-Za-z0-9_ .:,'-]{1,120}$/.test(e) ? e : '';
  return code ? `status ${status} (${code})` : `status ${status}`;
}

// The not-found answer of the Worker: a missing target or a refused signature, and the Worker does
// not say which (design 5.3). `retried` is set when an earlier attempt of the same request was
// sent and its answer never came back, so the work may have been done already.
class WorkerNotFoundError extends NotFoundError {
  constructor(what, { code = null, retried = false } = {}) {
    super(`${what}: not found, or the admin signature was refused (the Worker answers 404 to both; a refused signature means the token, not the clock)`);
    this.workerCode = code;
    this.retried = retried;
  }
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

export function createWorkerAdapter(backend, { credential, env = {}, spawn = defaultSpawnSync, fetch = (...args) => globalThis.fetch(...args), root = REPO_ROOT, now = () => new Date() } = {}) {
  if (typeof credential !== 'string' || !credential) throw new AdminError('no credential for the Worker backend');
  const api = workerOrigin(backend);
  const access = accessHeaders(env);

  // ---- transport ----

  // One signed admin request. Resolves to { status, json, retried }; throws WorkerNotFoundError on
  // 404, AdminError on any other failure. Network failures, 429 and 5xx are retried with a fresh
  // signature; a 503 daily_limit and a redirect are not.
  async function admin(method, path, body, { okStatuses = [] } = {}) {
    const where = `${method} ${path.split('?')[0]}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let lastError = 'no attempt';
    let lastStatus = 0;
    let lastJson = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const retried = attempt > 0;
      let signed;
      try {
        signed = signAdminRequest({ method, path, base: api, body: payload, key: credential, now: now().getTime() });
      } catch (err) {
        throw new UsageError(`${where}: ${err.message}`);
      }
      const networkError = (err) => `${where}: ${err?.name === 'TimeoutError' ? 'timeout' : `network error (${err?.cause?.code ?? err?.name ?? 'error'})`}`;
      let res;
      try {
        res = await fetch(signed.url, {
          method,
          headers: { [HEADER_NAME]: signed.header, ...access, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        lastError = networkError(err);
        if (attempt < RETRIES) await sleep(250 * 2 ** attempt);
        continue;
      }
      if (isRedirect(res)) {
        res.body?.cancel().catch(() => {});
        throw new AdminError(`${where}: status ${res.status}, a redirect; admin requests never follow redirects, so the api must be the Worker's own origin`);
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        lastError = networkError(err);
        if (attempt < RETRIES) await sleep(250 * 2 ** attempt);
        continue;
      }
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      if (res.ok || okStatuses.includes(res.status)) return { status: res.status, json: json && typeof json === 'object' ? json : {}, retried };
      lastError = `${where}: ${describe(res.status, json)}`;
      lastStatus = res.status;
      lastJson = json;
      // An unretire ran during the removal: the directory row was kept and the object stays
      // wiped. removeConference turns this into the two commands the operator chooses between.
      if (json?.error === 'removal_superseded' || (json?.error === 'removal_incomplete' && (res.status === 409 || json.cause === 'removal_superseded'))) {
        const superseded = new AdminError(`${where}: an unretire overtook the removal at step ${typeof json.step === 'string' && /^[a-z_]{1,20}$/.test(json.step) ? json.step : 'directory'} (status ${res.status})`);
        superseded.code = 'removal_superseded';
        superseded.status = res.status;
        throw superseded;
      }
      // A removal that stopped between its steps (tombstone, wipe, directory row): the next run
      // finishes it, so the operator is told to run it again rather than the client retrying blind.
      if (json?.error === 'removal_incomplete') {
        const step = typeof json.step === 'string' && /^[a-z_]{1,20}$/.test(json.step) ? json.step : 'unknown';
        const cause = typeof json.cause === 'string' && /^[A-Za-z0-9_ .:,'-]{1,120}$/.test(json.cause) ? `; cause: ${json.cause}` : '';
        const after = Number(res.headers.get('retry-after'));
        const hint = Number.isFinite(after) && after > 0 ? `run the removal again after ${after} seconds (Retry-After)` : 'run the removal again (after the Retry-After the Worker sent, if any)';
        throw new AdminError(`${where}: removal incomplete at step ${step} (status ${res.status}; retired ${json.retired === true}, wiped ${json.wiped === true}${cause}); ${hint}`);
      }
      // A conference the Worker does not route: never added, or removed (its object refuses admin
      // requests after a wipe until an unretire puts the directory row back).
      if (res.status === 400 && json?.error === 'conference is not available') {
        const slug = /[?&]event=([a-z0-9-]+)/.exec(path)?.[1];
        throw new AdminError(`${where}: the Worker does not route ${slug ?? 'this conference'} (no conference, or it was removed; after a removal run conferences unretire --event ${slug ?? '<slug>'} and then conferences refresh)`);
      }
      if (res.status === 404) throw new WorkerNotFoundError(where, { code: typeof json?.error === 'string' ? json.error : null, retried });
      if (res.status === 401) {
        const code = json?.error;
        if (code === 'admin_skew') throw new AdminError(`${lastError}: this machine's clock is more than five minutes from the Worker's`);
        if (code === 'admin_replay') throw new AdminError(`${lastError}: the Worker saw this nonce before`);
        throw new AdminError(lastError);
      }
      if (res.status === 503 && json?.error === 'daily_limit') throw new AdminError(`${lastError}: the account's daily limit is reached; try again after 00:00 UTC`);
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after'));
        if (attempt < RETRIES) await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 250 * 2 ** attempt);
        continue;
      }
      throw new AdminError(lastError);
    }
    const gaveUp = new AdminError(`${lastError} (gave up after ${RETRIES + 1} attempts)`);
    gaveUp.status = lastStatus;
    gaveUp.json = lastJson;
    throw gaveUp;
  }

  // One public GET (/api/*): unsigned, no Access headers, no redirect.
  async function publicGet(path) {
    let res;
    try {
      res = await fetch(api + path, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
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

  // The not-found of a target by its ref or id, with the Worker's double meaning spelled out.
  const notFound = (what, err) => new WorkerNotFoundError(what, { code: err?.workerCode ?? null, retried: err?.retried ?? false });
  const isNotFound = (err) => err instanceof WorkerNotFoundError;

  // A 404 after a retried write of a delete, an unhide or an unblock: the lost attempt may have
  // done the work, so the command succeeds and says so (PEER-6).
  const alreadyDone = (err, what) => (isNotFound(err) && err.retried ? `${what}: already done or never existed (a retried request answered 404; the first attempt may have succeeded)` : null);

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

  async function conferenceList() {
    const { status, json } = await publicGet('/api/conferences');
    if (status !== 200) throw new AdminError(`GET /api/conferences failed with status ${status}`);
    return (Array.isArray(json.conferences) ? json.conferences : []).filter((c) => c && typeof c.slug === 'string');
  }

  // Sends the rewritten local conference document (and nothing else of the batch answer is
  // trusted): a retired slug the Worker skipped is an error, because the hide did not happen.
  async function putConference(slug, doc, { unretire = false } = {}) {
    const body = { conferences: [unretire ? { ...doc, slug, unretire: true } : { ...doc, slug }] };
    let json;
    try {
      ({ json } = await admin('PUT', '/admin/conferences', body));
    } catch (err) {
      // A flagged fan-out that failed answers 502 unretire_incomplete with the slugs it could not
      // sync; the client retried it (signed afresh, and a second unretire repairs the first).
      // Still failing, the operator runs it again.
      if (unretire && err instanceof AdminError && err.status === 502) {
        const failed = (Array.isArray(err.json?.unretire_failed) ? err.json.unretire_failed : []).filter((s) => typeof s === 'string' && SLUG_RE.test(s));
        const incomplete = new AdminError(`unretire of ${failed.length ? failed.join(', ') : slug} incomplete; run the unretire again (${err.message})`);
        incomplete.code = 'unretire_incomplete';
        throw incomplete;
      }
      throw err;
    }
    const skipped = Array.isArray(json.skipped_retired) ? json.skipped_retired : [];
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
    const { status, json } = await admin('GET', `/admin/stats?${q({ event })}`, undefined, { okStatuses: [400] });
    if (status === 400) return null;
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
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'delete', kind: 'profile', id: ref });
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
        ({ json } = await admin('POST', `/admin/people/block?${q({ event })}`, { ref, action }));
      } catch (err) {
        // The four unblock answers: no_operator_block is exit 4, or "already unblocked" when a
        // retried attempt may have removed it; not_found (no person, no stale report) is exit 4.
        if (options.unblock && isNotFound(err) && err.workerCode === 'no_operator_block') {
          if (err.retried) return { counts: { reports: 0 }, note: 'already_unblocked', summary: `the operator block of ${ref}: already unblocked (a retried request answered 404; the first attempt may have succeeded)` };
          throw new NotFoundError(`${ref} has no operator block at ${event}`);
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
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'hide', kind, id });
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
        return { counts: { reports }, summary: `would clear the hidden flag of ${kind} ${id} and remove ${plural(reports, 'report')} (every report of the person, on tier 2)` };
      }
      let json;
      try {
        ({ json } = await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'unhide', kind, id }));
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
        await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'delete', kind, id });
      } catch (err) {
        const done = alreadyDone(err, `${kind} ${id}`);
        if (done) return { counts: { [kind]: 0 }, note: 'already_deleted', summary: done };
        throw isNotFound(err) ? notFound(`${kind} ${id} at ${event}`, err) : err;
      }
      return { counts: { [kind]: 1 }, summary: kind === 'meet' ? `deleted meet ${id}` : `cleared the spot line of ${id} and kept it hidden` };
    },

    async purgeReports({ event, mode }) {
      if (mode === 'dry-run') {
        const stats = await statsOf(event);
        if (!stats) throw new NotFoundError(`the Worker does not route ${event} (no conference, or it was removed)`);
        return { counts: { reports: stats.counts.reports ?? 0 }, summary: `would ask the Worker to delete the reports of ${event} made before its end (${plural(stats.counts.reports ?? 0, 'report')} on file; the Worker refuses before the end)` };
      }
      const { json } = await admin('POST', `/admin/moderation?${q({ event })}`, { action: 'purge' });
      const purged = int(json.purged);
      if (typeof json.ends_at === 'string') throw new AdminError(`${event} ends at ${json.ends_at}; nothing is purged before that`);
      return { counts: { reports: purged }, summary: `deleted ${plural(purged, 'report')} of ${event} made before its end` };
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
      try {
        ({ json } = await admin('DELETE', `/admin/conference?${q({ event: slug })}`));
      } catch (err) {
        // The CLI does not act on its own after a superseded removal: the operator chooses
        // between finishing the removal and restoring the conference, with the same flags.
        if (err?.code === 'removal_superseded') {
          const confirm = `--yes --confirm ${slug}`;
          const flags = `${reason ? ` --reason ${reason}` : ''}${options?.purgeLocal ? ' --purge-local' : ''}`;
          const guided = new AdminError(`an unretire ran during the removal of ${slug}: the directory row was kept and the object stays wiped, nothing further was removed, and the object may refuse the conference until the unretire is repeated; choose one: finish the removal with \`caddie-admin conferences remove --event ${slug}${flags} ${confirm}\`, or restore the conference with \`caddie-admin conferences unretire --event ${slug} ${confirm}\` (${err.message})`);
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
      return { counts, ...(already ? { note: 'already_retired' } : {}), summary: `wiped ${slug} from the Worker${what ? `: ${what}` : ' (nothing was left to delete)'}; tombstone ${json.retired === true ? 'left' : 'not confirmed'}${already}, so the weekly ingest skips it until conferences unretire` };
    },

    async unretireConference({ slug, doc, mode }) {
      if (mode === 'dry-run') return { backend: 'worker', summary: `would send ${slug} to PUT /admin/conferences with "unretire": true in the body, dropping the Worker's tombstone` };
      const counts = await putConference(slug, doc, { unretire: true });
      return { backend: 'worker', counts, summary: `sent ${slug} with unretire: true; the Worker dropped its tombstone (upserted ${counts.upserted})` };
    },

    async counts({ event }) {
      if (event !== undefined) {
        const stats = await statsOf(event);
        if (!stats) throw new NotFoundError(`the Worker does not route ${event} (no conference, or it was removed)`);
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
        // The pace lives in each conference's own meter; a conference the Worker no longer routes has none.
        const own = await statsOf(slug).catch(() => null);
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
      const tokenFile = env.ADMIN_TOKEN_FILE || '~/.config/conference-caddie/admin-token';
      const smoke = `BASE_URL="${api}" ADMIN_TOKEN_FILE="${tokenFile}" node scripts/smoke.mjs`;
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
