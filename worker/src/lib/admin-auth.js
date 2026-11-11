// The check of the Worker's admin requests: the X-Caddie-Admin v1 header parser and verifier, and
// the nonce table every Durable Object that serves an /admin/* request keeps. A WebCrypto port of
// verifyAdminSignature() in scripts/lib/admin-sign.mjs (the signer the clients use), tested against
// the same fixture file, test/fixtures/admin-sign.v1.json.
//
// Header: X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>, single spaces.
//   ts          Unix time in seconds, a decimal integer with no leading zero.
//   nonce       16 random bytes as base64url without padding (22 characters).
//   bodySha256  lowercase hex SHA-256 of the body bytes; GET, HEAD and DELETE carry the hash of the
//               empty byte string.
//   sig         lowercase hex HMAC-SHA256 over the canonical string, keyed with the trimmed secret.
//
// Canonical string, UTF-8, every field followed by "\n": caddie-admin-v1, the method in upper case,
// url.pathname + url.search, bodySha256, ts and nonce, each exactly as the header carries them (ts
// is never re-formatted through Number()).
//
// The module is pure: no Worker state, no clock and no rate limit of its own. The constant-time
// compare is passed in, because crypto.subtle.timingSafeEqual exists only on Workers (Node's tests
// pass crypto.timingSafeEqual), and the caller passes the time and the failed-auth pre-check.
// Nothing here logs.

export const HEADER_NAME = 'X-Caddie-Admin';
export const NONCE_HEADER = 'X-Caddie-Admin-Nonce';
export const TS_HEADER = 'X-Caddie-Admin-Ts';
export const HEADER_RE = /^v1 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
export const TS_RE = /^(0|[1-9]\d{0,11})$/;
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
export const SKEW_SECONDS = 300;
// The Durable Object's own clock check of the forwarded timestamp: the Worker's window plus 5
// seconds for the time between the Worker's check and the object's.
export const DO_SKEW_SECONDS = SKEW_SECONDS + 5;
export const MIN_KEY_LENGTH = 32;
// How long a Durable Object remembers a nonce, counted from its signed timestamp. The Worker
// accepts a timestamp for 5 minutes after it, so a nonce is known for as long as its request could
// be replayed, with 10 minutes to spare for a difference between the Worker's and the object's
// clocks.
export const NONCE_TTL_MS = 900_000;

const utf8 = (text) => new TextEncoder().encode(text);

// Lowercase hex (already checked by HEADER_RE) to bytes.
function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const usable = (key) => typeof key === 'string' && key.trim().length >= MIN_KEY_LENGTH;

// The keys the Worker verifies with: ADMIN_TOKEN, and ADMIN_TOKEN_NEXT during a rotation, each
// trimmed and at least 32 characters long. Without a usable ADMIN_TOKEN there is no key at all, so
// the admin routes fail closed even when ADMIN_TOKEN_NEXT is set.
export function adminKeys(env) {
  if (!usable(env?.ADMIN_TOKEN)) return [];
  const keys = [env.ADMIN_TOKEN.trim()];
  if (usable(env.ADMIN_TOKEN_NEXT)) keys.push(env.ADMIN_TOKEN_NEXT.trim());
  return keys;
}

// The header's four fields as the strings it carries, or null when it does not match HEADER_RE
// exactly (absent, empty, another version, a field of the wrong shape, extra spaces, or the value
// sent twice, which a Headers object joins as "<h>, <h>").
export function parseAdminHeader(value) {
  const m = HEADER_RE.exec(typeof value === 'string' ? value : '');
  return m ? { ts: m[1], nonce: m[2], bodySha256: m[3], sig: m[4] } : null;
}

export function canonicalString(method, pathWithQuery, header) {
  return `caddie-admin-v1\n${String(method).toUpperCase()}\n${pathWithQuery}\n${header.bodySha256}\n${header.ts}\n${header.nonce}\n`;
}

// Whether any key reproduces the header's signature. Every key is tried, and each comparison runs
// even after one matched, so the time taken does not depend on which key matched.
export async function signatureMatches({ method, pathWithQuery, header, keys, timingSafeEqual }) {
  const data = utf8(canonicalString(method, pathWithQuery, header));
  const given = hexBytes(header.sig);
  let matched = false;
  for (const key of keys) {
    const k = await crypto.subtle.importKey('raw', utf8(key.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
    if (timingSafeEqual(given, expected)) matched = true;
  }
  return matched;
}

// The clock window: |now - ts| <= limit seconds, with now in whole seconds as the fixture defines
// it (Math.floor(Date.now() / 1000)). The Worker uses SKEW_SECONDS, a Durable Object
// DO_SKEW_SECONDS; both go through this one function.
export function withinSkew(ts, nowMs, limit = SKEW_SECONDS) {
  return Math.abs(Math.floor(nowMs / 1000) - Number(ts)) <= limit;
}

// Verifies the header against the request's method and url.pathname + url.search, in the
// Worker's order (worker/src/index.js, adminAuth): no usable key, a malformed header, a body hash
// on a bodyless method, the caller's failed-auth pre-check (mayTry), the signature with every key,
// then the clock. The first reason that applies is returned; all of them are a 404 on the Worker
// except skew (401 admin_skew), which needs a valid signature: a key holder's, or a captured
// header's. The body is not read here: on success the caller reads it, checks the clock again
// (the body may take any time to arrive) and checks the body with bodyMatches().
//
// Reasons: no_key, malformed, bodyless_body_hash, limited, signature, skew.
export async function verifyAdminHeader({ headerValue, method, pathWithQuery, keys, nowMs, timingSafeEqual, mayTry = () => true }) {
  const held = (Array.isArray(keys) ? keys : [keys]).filter(usable);
  if (held.length === 0) return { ok: false, reason: 'no_key' };
  const header = parseAdminHeader(headerValue);
  if (!header) return { ok: false, reason: 'malformed' };
  if (BODYLESS_METHODS.has(String(method).toUpperCase()) && header.bodySha256 !== EMPTY_BODY_SHA256) return { ok: false, reason: 'bodyless_body_hash' };
  if (!mayTry()) return { ok: false, reason: 'limited' };
  if (!(await signatureMatches({ method, pathWithQuery, header, keys: held, timingSafeEqual }))) return { ok: false, reason: 'signature' };
  if (!withinSkew(header.ts, nowMs)) return { ok: false, reason: 'skew' };
  return { ok: true, reason: null, header };
}

// After verifyAdminHeader() accepted the header: whether the body bytes read afterwards hash to
// the bodySha256 the signature covers. Constant time.
export async function bodyMatches(bodySha256, bytes, timingSafeEqual) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return timingSafeEqual(hexBytes(bodySha256), digest);
}

// ---------------------------------------------------------------------------------------------
// The nonce table (admin_nonces in worker/src/schema.js), one per Durable Object.

// Records the nonce the Worker forwarded with an /admin/* request, before any handler runs.
// `exec` has the signature of storage.sql.exec. Returns:
//   'missing'  either header is absent or not of the shape the Worker's verifier forwards, so the
//              request did not come through it (404);
//   'skew'     the signed timestamp is more than 305 seconds from the object's own clock
//              (401 admin_skew). Without this check a request whose body took longer than the
//              nonce retention to reach the Worker could arrive after its first use was pruned;
//              with it, every nonce the object accepts is still inside the retention;
//   'replay'   the object has seen the nonce before (401 admin_replay);
//   'ok'       a new nonce, now recorded.
// The stored time is the signed timestamp, not the object's clock; every insert also drops the
// nonces signed more than 15 minutes ago (an index on ts_ms keeps that from scanning the table).
export function consumeAdminNonce(exec, headers, nowMs) {
  const nonce = headers.get(NONCE_HEADER);
  const ts = headers.get(TS_HEADER);
  if (!NONCE_RE.test(nonce ?? '') || !TS_RE.test(ts ?? '')) return 'missing';
  if (!withinSkew(ts, nowMs, DO_SKEW_SECONDS)) return 'skew';
  const fresh = exec('INSERT INTO admin_nonces (nonce, ts_ms) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING 1', nonce, Number(ts) * 1000).toArray().length > 0;
  exec('DELETE FROM admin_nonces WHERE ts_ms < ?', nowMs - NONCE_TTL_MS);
  return fresh ? 'ok' : 'replay';
}
