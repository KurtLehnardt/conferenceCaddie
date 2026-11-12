// The check of the Worker's admin requests: the X-Caddie-Admin header parser and verifier for
// versions 1 and 2, the reader of the two settings that choose what is accepted (ADMIN_SIG_MIN and
// ADMIN_ORIGIN), and the nonce table every Durable Object that serves an /admin/* request keeps. A
// WebCrypto port of verifyAdminSignature() in scripts/lib/admin-sign.mjs (the signer the clients
// use), tested against the same fixture files, test/fixtures/admin-sign.v1.json and
// test/fixtures/admin-sign.v2.json.
//
// Header: X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>, or the same fields with "v2" in
// front, single spaces.
//   ts          Unix time in seconds, a decimal integer with no leading zero.
//   nonce       16 random bytes as base64url without padding (22 characters).
//   bodySha256  lowercase hex SHA-256 of the body bytes; GET, HEAD and DELETE carry the hash of the
//               empty byte string.
//   sig         lowercase hex HMAC-SHA256 over the canonical string, keyed with the trimmed secret.
//
// Canonical string, UTF-8, every field followed by "\n": caddie-admin-v1, the method in upper case,
// url.pathname + url.search, bodySha256, ts and nonce, each exactly as the header carries them (ts
// is never re-formatted through Number()). Version 2 has caddie-admin-v2 on its first line and the
// origin the request was signed for as a seventh line, so a request signed for another host (a
// typo in the base, a hostile mirror, a staging Worker with the same key) does not verify here.
// The origin is not in the header: the Worker tries every origin it serves (adminConfig()).
//
// The origin rules and the exact readings of ADMIN_ORIGIN and ADMIN_SIG_MIN come from
// scripts/lib/admin-origin.mjs, the module the signer uses too. It has no imports at all, so it
// bundles into the Worker as it is.
//
// The module is pure: no Worker state, no clock and no rate limit of its own. The constant-time
// compare is passed in, because crypto.subtle.timingSafeEqual exists only on Workers (Node's tests
// pass crypto.timingSafeEqual), and the caller passes the time and the failed-auth pre-check.
// Nothing here logs.

import { parseAdminOrigin, parseAdminSigMin } from '../../../scripts/lib/admin-origin.mjs';

export const HEADER_NAME = 'X-Caddie-Admin';
export const NONCE_HEADER = 'X-Caddie-Admin-Nonce';
export const TS_HEADER = 'X-Caddie-Admin-Ts';
export const HEADER_RE = /^v1 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
// The v2 header: the v1 grammar field for field, with "v2" in front.
export const HEADER_RE_V2 = /^v2 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
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
// The ADMIN_SIG_MIN this Worker uses when the setting is absent from its environment. It is in the
// source, not in wrangler.toml, so that no deploy path can lower it: once step d of the migration
// (DECISIONS.md, "Admin signature v2") changes it to "2", a deploy that drops the [vars] entry, or a
// fork that never had one, still refuses v1. Only an explicit ADMIN_SIG_MIN = "1" reopens v1.
export const WORKER_DEFAULT_SIG_MIN = '1';

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
// sent twice, which a Headers object joins as "<h>, <h>"). It reads v1 only, as it always has;
// parseVersionedAdminHeader() reads both versions.
export function parseAdminHeader(value) {
  const m = HEADER_RE.exec(typeof value === 'string' ? value : '');
  return m ? { ts: m[1], nonce: m[2], bodySha256: m[3], sig: m[4] } : null;
}

// A header of either version: { version: 1 or 2, ts, nonce, bodySha256, sig }, the fields as the
// strings it carries, or null when it matches neither HEADER_RE nor HEADER_RE_V2 exactly. A v2
// header with a sixth field (the origin appended, say) matches neither.
export function parseVersionedAdminHeader(value) {
  const text = typeof value === 'string' ? value : '';
  for (const [version, re] of [[1, HEADER_RE], [2, HEADER_RE_V2]]) {
    const m = re.exec(text);
    if (m) return { version, ts: m[1], nonce: m[2], bodySha256: m[3], sig: m[4] };
  }
  return null;
}

export function canonicalString(method, pathWithQuery, header) {
  return `caddie-admin-v1\n${String(method).toUpperCase()}\n${pathWithQuery}\n${header.bodySha256}\n${header.ts}\n${header.nonce}\n`;
}

// The v2 canonical string: its own first line, the six v1 fields in the v1 order, then the origin,
// each followed by "\n".
export function canonicalStringV2(method, pathWithQuery, header, origin) {
  return `caddie-admin-v2\n${String(method).toUpperCase()}\n${pathWithQuery}\n${header.bodySha256}\n${header.ts}\n${header.nonce}\n${origin}\n`;
}

// What this Worker accepts, read from its environment for one request:
//   allowedVersions  from ADMIN_SIG_MIN, or WORKER_DEFAULT_SIG_MIN when it is absent, matched
//                    exactly (parseAdminSigMin): "1" allows [1, 2], "2" allows [2];
//   origins          the origins a v2 signature may name: the ADMIN_ORIGIN list when it is set
//                    (parseAdminOrigin), else the request URL's own origin, taken as
//                    new URL(requestUrl).origin and never through canonicalOrigin(), which refuses
//                    a URL with a path. Cloudflare invokes the Worker only for the hostnames
//                    routed to it, so the fallback is safe there; behind a proxy that forwards a
//                    client-chosen Host, on a custom domain or behind Access, ADMIN_ORIGIN must be
//                    set.
// Either setting holding anything else is invalid configuration: { ok: false, invalid } names the
// setting (never its value), and the caller answers 404 to every admin request, v1 included.
export function adminConfig(env, requestUrl) {
  const allowedVersions = parseAdminSigMin(env?.ADMIN_SIG_MIN ?? WORKER_DEFAULT_SIG_MIN);
  if (allowedVersions === null) return { ok: false, invalid: 'ADMIN_SIG_MIN' };
  const setting = parseAdminOrigin(env?.ADMIN_ORIGIN);
  if (setting.mode === 'list') return { ok: true, allowedVersions, origins: setting.origins };
  if (setting.mode === 'fallback') return { ok: true, allowedVersions, origins: [new URL(requestUrl).origin] };
  return { ok: false, invalid: 'ADMIN_ORIGIN' };
}

// The verifier's own settings, checked before anything else so that a caller that passes a bad
// list fails closed on every request: allowedVersions a non-empty list of the numbers 1 and 2, and,
// when it holds 2, origins a non-empty list of strings. The Worker always passes adminConfig()'s.
function settingsUsable(allowedVersions, origins) {
  if (!Array.isArray(allowedVersions) || allowedVersions.length === 0 || !allowedVersions.every((v) => v === 1 || v === 2)) return false;
  if (!allowedVersions.includes(2)) return true;
  return Array.isArray(origins) && origins.length > 0 && origins.every((o) => typeof o === 'string' && o !== '');
}

// Whether any key reproduces the header's signature, and with which origin for v2. A v1 header is
// checked over the v1 canonical string with each key; a v2 header over the v2 canonical string for
// every pair of key and origin (keys outer, origins inner). Every comparison runs even after one
// matched, so the time taken depends only on the number of keys and origins, never on which pair
// matched. Returns { matched, origin } (origin null for v1).
export async function signatureMatches({ method, pathWithQuery, header, keys, origins = [], timingSafeEqual }) {
  const version = header.version ?? 1;
  const texts = version === 2
    ? [...new Set(origins)].map((origin) => ({ origin, data: utf8(canonicalStringV2(method, pathWithQuery, header, origin)) }))
    : [{ origin: null, data: utf8(canonicalString(method, pathWithQuery, header)) }];
  const given = hexBytes(header.sig);
  let matched = false;
  let matchedOrigin = null;
  for (const key of keys) {
    const k = await crypto.subtle.importKey('raw', utf8(key.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    for (const { origin, data } of texts) {
      const expected = new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
      if (timingSafeEqual(given, expected)) {
        matched = true;
        matchedOrigin = origin;
      }
    }
  }
  return { matched, origin: matchedOrigin };
}

// The clock window: |now - ts| <= limit seconds, with now in whole seconds as the fixture defines
// it (Math.floor(Date.now() / 1000)). The Worker uses SKEW_SECONDS, a Durable Object
// DO_SKEW_SECONDS; both go through this one function.
export function withinSkew(ts, nowMs, limit = SKEW_SECONDS) {
  return Math.abs(Math.floor(nowMs / 1000) - Number(ts)) <= limit;
}

// Verifies the header against the request's method and url.pathname + url.search, in the
// Worker's order (worker/src/index.js, adminAuth): the verifier's own settings, no usable key, a
// malformed header or one of a version not in allowedVersions, a body hash on a bodyless method,
// the caller's failed-auth pre-check (mayTry), the signature with every key (and, for v2, every
// origin in `origins`), then the clock. The first reason that applies is returned; all of them are
// a 404 on the Worker except skew (401 admin_skew), which needs a valid signature: a key holder's,
// or a captured header's. A v2 signature made for an origin outside `origins` is "signature", with
// no reason of its own. The body is not read here: on success the caller reads it, checks the
// clock again (the body may take any time to arrive) and checks the body with bodyMatches().
//
// allowedVersions defaults to [1], a verifier that has never heard of v2; the Worker passes
// adminConfig()'s. On success `header` carries the version and the fields as strings, and a v2
// success also names the `origin` that matched.
//
// Reasons: config, no_key, malformed, bodyless_body_hash, limited, signature, skew.
export async function verifyAdminHeader({ headerValue, method, pathWithQuery, keys, nowMs, timingSafeEqual, mayTry = () => true, allowedVersions = [1], origins = [] }) {
  if (!settingsUsable(allowedVersions, origins)) return { ok: false, reason: 'config' };
  const held = (Array.isArray(keys) ? keys : [keys]).filter(usable);
  if (held.length === 0) return { ok: false, reason: 'no_key' };
  const header = parseVersionedAdminHeader(headerValue);
  if (!header || !allowedVersions.includes(header.version)) return { ok: false, reason: 'malformed' };
  if (BODYLESS_METHODS.has(String(method).toUpperCase()) && header.bodySha256 !== EMPTY_BODY_SHA256) return { ok: false, reason: 'bodyless_body_hash' };
  if (!mayTry()) return { ok: false, reason: 'limited' };
  const sig = await signatureMatches({ method, pathWithQuery, header, keys: held, origins: header.version === 2 ? origins : [], timingSafeEqual });
  if (!sig.matched) return { ok: false, reason: 'signature' };
  if (!withinSkew(header.ts, nowMs)) return { ok: false, reason: 'skew' };
  return header.version === 2 ? { ok: true, reason: null, header, version: 2, origin: sig.origin } : { ok: true, reason: null, header, version: 1 };
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
