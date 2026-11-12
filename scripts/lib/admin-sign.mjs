// Signing and verification of the Worker's admin requests (design: "caddie-admin", section 5.3).
// Node built-ins only. This module is shared: scripts/smoke.mjs and the caddie-admin CLI sign with
// it, worker/ingest/lib.mjs signs with it, and the Worker's own verifier is a WebCrypto port of
// verifyAdminSignature() checked against the same fixture file, test/fixtures/admin-sign.v1.json.
//
// Header: X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>, single spaces.
//   ts          Unix time in seconds, a decimal integer.
//   nonce       16 random bytes as base64url without padding (22 characters).
//   bodySha256  lowercase hex SHA-256 of the body bytes the client sends. GET, HEAD and DELETE
//               carry no body and must use the hash of the empty byte string (EMPTY_BODY_SHA256).
//   sig         lowercase hex HMAC-SHA256 over the canonical string, keyed with the trimmed secret.
//
// Canonical string, UTF-8, every field followed by "\n":
//   caddie-admin-v1
//   <METHOD, uppercase>
//   <pathname + search>
//   <bodySha256, as in the header>
//   <ts>
//   <nonce>
//
// Canonicalisation: the client builds new URL(path, base) and signs u.pathname + u.search; the
// Worker does the same with new URL(request.url). The query string after "?" must match QUERY_RE
// (letters, digits, "_", ".", ":", "=", "&", ",", "-"; the comma for lists such as
// fields=text,contact), so the two sides never disagree on escaping:
// an ISO instant such as since=2026-11-10T08:00:00Z passes; "%", a space or "+" does not. A value
// that needs other characters travels base64url-encoded under a key ending in "64" (q64 for the
// search text). Flags such as allow_shrink go in the JSON body, never in the query, so the body
// hash covers them.
//
// The key is the UTF-8 bytes of the secret after trimming surrounding whitespace, with no hex
// decoding; it must be at least 32 characters, as the Worker requires. Nothing here prints or
// logs a key, a header or a body.
//
// Version 2 (test/fixtures/admin-sign.v2.json) binds the request to the origin it is sent to, so a
// signed request that reaches another host (a typo, a hostile mirror) cannot be replayed to the
// production Worker within the clock window. The header has the same fields and grammar with "v2"
// in front: X-Caddie-Admin: v2 <ts> <nonce> <bodySha256> <sig>. Its canonical string has its own
// first line and one more field, so no v1 string can ever equal a v2 string:
//   caddie-admin-v2
//   <METHOD, uppercase>
//   <pathname + search>
//   <bodySha256, as in the header>
//   <ts>
//   <nonce>
//   <origin>
// The origin is not in the header. The client signs the origin of its base, which lowercases the
// scheme and host and drops the scheme's default port; the verifier holds the list of origins it
// serves (on the Worker, ADMIN_ORIGIN when set, else the origin of the request's own URL),
// normalised the same way, and tries each. A signature made for any other origin fails as
// "signature", with no reason of its own. Both sides read an origin value strictly
// (canonicalOrigin): printable ASCII, a literal http:// or https:// prefix, nothing but a host and
// a port. The origin rules, the Worker's ADMIN_ORIGIN and ADMIN_SIG_MIN readers and the client's
// version override live in scripts/lib/admin-origin.mjs, which has no imports so the Worker can
// use it as it is; this module re-exports them. The signer signs v1 unless asked for v2, and the
// verifier accepts only v1 unless told otherwise; the migration is in DECISIONS.md ("Admin
// signature v2").

import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { UsageError, canonicalOrigin } from './admin-origin.mjs';

export {
  ORIGIN_ALLOW_RE, ORIGIN_CHARS_RE, ORIGIN_FORBIDDEN_RE, ORIGIN_PREFIX_RE, SIG_VERSION_ENV, UsageError,
  canonicalOrigin, parseAdminOrigin, parseAdminSigMin, signVersionFromEnv,
} from './admin-origin.mjs';

export const VERSION = 'v1';
export const VERSION_V2 = 'v2';
// The version signAdminRequest() signs when the caller names none. It stays 1 until the clients
// move to v2 (step c of the migration).
export const DEFAULT_SIGN_VERSION = 1;
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const QUERY_RE = /^[A-Za-z0-9_.:=&,-]*$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
// ts is a decimal integer without a leading zero, so a raw-string verifier and Number() agree.
export const HEADER_RE = /^v1 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
// The v2 header: the v1 grammar field for field, with "v2" in front.
export const HEADER_RE_V2 = /^v2 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
// The path of an admin request: absolute, one leading "/", segments of letters, digits, "_", "."
// and "-" with no empty segment (so no "//" anywhere), so nothing in it is ever percent-encoded
// or rewritten, which keeps both sides byte-identical.
export const PATH_RE = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/;
export const HEADER_NAME = 'X-Caddie-Admin';
export const SKEW_SECONDS = 300;
export const MIN_KEY_LENGTH = 32;
// Methods that never carry a body: their header holds EMPTY_BODY_SHA256 and the Worker refuses any
// other hash before it computes anything.
export const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
const METHOD_RE = /^[A-Z]{3,10}$/;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hmacSha256Hex = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('hex');

// The body as bytes: undefined or null is the empty body, a string is UTF-8, bytes are taken as
// they are. An object is refused: the caller serialises, so the hash covers the bytes it sends.
export function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return body;
  throw new UsageError('The body must be a string or bytes; serialise an object before signing.', 'body_type');
}

export function canonicalString({ method, pathWithQuery, bodySha256, ts, nonce }) {
  return `caddie-admin-${VERSION}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n`;
}

// The v2 canonical string: its own first line (domain separation from v1), the six v1 fields in
// the v1 order with the same "\n" after each, then the origin, also followed by "\n".
export function canonicalStringV2({ method, pathWithQuery, bodySha256, ts, nonce, origin }) {
  return `caddie-admin-v2\n${String(method).toUpperCase()}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n${origin}\n`;
}

// The trimmed key bytes, or a UsageError when the key is missing or too short.
export function keyBytes(key) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (trimmed.length < MIN_KEY_LENGTH) throw new UsageError(`The admin key must have at least ${MIN_KEY_LENGTH} characters after trimming.`, 'key_too_short');
  return Buffer.from(trimmed, 'utf8');
}

export function randomNonce() {
  return randomBytes(16).toString('base64url');
}

// The request URL and its canonical path: new URL(path, base), with the query charset enforced.
export function canonicalUrl(path, base) {
  // The path is checked as given and again as parsed: "//host/x" would change the host, "\\" is a
  // slash to the URL parser, and a space or non-ASCII would come back percent-encoded.
  const rawPath = String(path ?? '').split(/[?#]/, 1)[0];
  if (!PATH_RE.test(rawPath)) {
    throw new UsageError('The admin request path must start with one "/" and hold segments of letters, digits, "_", "." and "-" only, with no empty segment.', 'path_charset');
  }
  // The base is an origin: a base with a path, query or fragment would be dropped by new URL(path,
  // base) for an absolute path, so the Worker would see another path than the caller meant.
  let b;
  try {
    b = new URL(base);
  } catch {
    throw new UsageError('The admin request base is not a valid URL.', 'url');
  }
  if (b.pathname !== '/' || b.search !== '' || b.hash !== '') throw new UsageError('The admin request base must be an origin with no path, query or fragment.', 'url');
  const u = new URL(path, b);
  if (u.origin !== b.origin || !PATH_RE.test(u.pathname)) {
    throw new UsageError('The admin request path must start with one "/" and hold segments of letters, digits, "_", "." and "-" only, with no empty segment.', 'path_charset');
  }
  if (!QUERY_RE.test(u.search.slice(1))) {
    throw new UsageError('The admin query string may hold only letters, digits, "_", ".", ":", "=", "&" and "-"; send other text base64url-encoded under a key ending in 64 (for example q64).', 'query_charset');
  }
  return { url: u, pathWithQuery: u.pathname + u.search };
}

// Signs one request. Returns the header value, the URL to send it to, and the pieces that went
// into the signature (for tests and fixtures). `now` is milliseconds; `nonce` is for tests only,
// because a nonce is single-use on the Worker and every retry must sign afresh.
//
// `version` is 1 (the default, DEFAULT_SIGN_VERSION) or 2. A v1 result is exactly what it was
// before v2 existed; a v2 result also carries `version: 2` and the `origin` it signed, which is
// canonicalOrigin(base): a v2 signature needs a base string that canonicalOrigin accepts.
export function signAdminRequest({ method, path, base, body, key, now, nonce, version = DEFAULT_SIGN_VERSION }) {
  if (version !== 1 && version !== 2) throw new UsageError('The admin signature version must be the number 1 or 2.', 'version');
  const METHOD = String(method ?? '').toUpperCase();
  if (!METHOD_RE.test(METHOD)) throw new UsageError('The admin request needs an HTTP method.', 'method');
  const keyBuf = keyBytes(key);
  const { url, pathWithQuery } = canonicalUrl(path, base);
  const bytes = bodyBytes(body);
  if (BODYLESS_METHODS.has(METHOD) && bytes.length > 0) throw new UsageError(`A ${METHOD} admin request cannot carry a body.`, 'body_on_bodyless_method');
  const bodySha256 = bytes.length === 0 ? EMPTY_BODY_SHA256 : sha256Hex(bytes);
  const ts = Math.floor((now ?? Date.now()) / 1000);
  if (!Number.isInteger(ts) || ts < 0 || String(ts).length > 12) throw new UsageError('The signing time is out of range.', 'ts');
  const n = nonce ?? randomNonce();
  if (!NONCE_RE.test(n)) throw new UsageError('A nonce is 16 bytes as base64url without padding (22 characters).', 'nonce');
  if (version === 1) {
    const canonical = canonicalString({ method: METHOD, pathWithQuery, bodySha256, ts, nonce: n });
    const sig = hmacSha256Hex(keyBuf, canonical);
    return { header: `${VERSION} ${ts} ${n} ${bodySha256} ${sig}`, url: url.href, pathWithQuery, method: METHOD, bodySha256, ts, nonce: n, canonical };
  }
  const origin = canonicalOrigin(base);
  if (origin === null) throw new UsageError('A v2 admin signature needs a base that is a plain http:// or https:// origin in printable ASCII, with an internationalised host in its punycode (xn--) form, and no user name, password, backslash, "%" or ",".', 'url');
  const canonical = canonicalStringV2({ method: METHOD, pathWithQuery, bodySha256, ts, nonce: n, origin });
  const sig = hmacSha256Hex(keyBuf, canonical);
  return { header: `${VERSION_V2} ${ts} ${n} ${bodySha256} ${sig}`, url: url.href, pathWithQuery, method: METHOD, bodySha256, ts, nonce: n, canonical, version: 2, origin };
}

// Parses a header value; null when it does not match HEADER_RE exactly. It reads v1 only, as it
// always has; parseVersionedAdminHeader() reads both versions.
export function parseAdminHeader(value) {
  const m = HEADER_RE.exec(typeof value === 'string' ? value : '');
  if (!m) return null;
  return { ts: Number(m[1]), nonce: m[2], bodySha256: m[3], sig: m[4] };
}

// Parses a header of either version: { version: 1 or 2, ts, nonce, bodySha256, sig }, or null
// when the value matches neither HEADER_RE nor HEADER_RE_V2 exactly.
export function parseVersionedAdminHeader(value) {
  const text = typeof value === 'string' ? value : '';
  for (const [version, re] of [[1, HEADER_RE], [2, HEADER_RE_V2]]) {
    const m = re.exec(text);
    if (m) return { version, ts: Number(m[1]), nonce: m[2], bodySha256: m[3], sig: m[4] };
  }
  return null;
}

// The verifier's options, checked before the header is read, so a misconfigured verifier fails on
// every request rather than on the first v2 one. allowedVersions is a non-empty list of 1 and 2;
// when it holds 2, expectedOrigins is a non-empty list of values canonicalOrigin() accepts, and
// one bad entry refuses the whole list (fail closed). The origins are deduplicated after
// normalisation, so the work per request does not grow with a repeated entry.
function verifierVersions(allowedVersions) {
  if (!Array.isArray(allowedVersions) || allowedVersions.length === 0 || !allowedVersions.every((v) => v === 1 || v === 2)) {
    throw new UsageError('allowedVersions must be a non-empty list of the numbers 1 and 2.', 'version');
  }
  return new Set(allowedVersions);
}

function verifierOrigins(expectedOrigins) {
  const origins = Array.isArray(expectedOrigins) ? expectedOrigins.map(canonicalOrigin) : [];
  if (origins.length === 0 || origins.includes(null)) {
    throw new UsageError('A verifier that accepts v2 needs expectedOrigins: a non-empty list of plain http:// or https:// origins in printable ASCII, each internationalised host in its punycode (xn--) form, with no path, query, fragment, credentials, backslash, "%" or ",".', 'expected_origins');
  }
  return [...new Set(origins)];
}

// Verifies a header against the request's method and canonical path, in the Worker's order:
// malformed header, then a body hash on a bodyless method, then the signature with every key
// (ADMIN_TOKEN and, during a rotation, ADMIN_TOKEN_NEXT), then the timestamp window. It returns
// the header's bodySha256 on success so the caller can read the body afterwards, hash it and
// compare; a signature that fails must be answered as "not found" by the Worker, a skew or a body
// mismatch as 401, as only a key holder can reach those.
//
// `timingSafeEqual(a, b)` compares two 32-byte values in constant time: crypto.timingSafeEqual in
// Node (the default), crypto.subtle.timingSafeEqual on Workers. Every key is checked, and the
// comparison of each runs even after one matched, so the time taken does not depend on which key
// matched. Reasons: malformed, bodyless_body_hash, no_key, signature, skew.
//
// Versions: `allowedVersions` (default [1]) lists the header versions accepted; a header of any
// other version is "malformed", as a v2 header always was to a v1 verifier. Accepting 2 needs
// `expectedOrigins`, the origins this verifier serves, or the call throws a UsageError
// ("expected_origins"); a bad allowedVersions throws "version". A v2 header is checked against
// every (key, origin) pair, each comparison running even after one matched, so a signature made
// for an origin outside the list fails as "signature". A v1 success has the shape it always had;
// a v2 success also carries `version: 2` and the `origin` that matched.
export function verifyAdminSignature({ headerValue, method, pathWithQuery, keys, now, skewSeconds = SKEW_SECONDS, timingSafeEqual = nodeTimingSafeEqual, allowedVersions = [1], expectedOrigins }) {
  const versions = verifierVersions(allowedVersions);
  const origins = versions.has(2) ? verifierOrigins(expectedOrigins) : [];
  const parsed = parseVersionedAdminHeader(headerValue);
  if (!parsed || !versions.has(parsed.version)) return { ok: false, reason: 'malformed', bodySha256: null };
  const METHOD = String(method ?? '').toUpperCase();
  if (BODYLESS_METHODS.has(METHOD) && parsed.bodySha256 !== EMPTY_BODY_SHA256) return { ok: false, reason: 'bodyless_body_hash', bodySha256: null };
  const usable = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k.trim().length >= MIN_KEY_LENGTH);
  if (usable.length === 0) return { ok: false, reason: 'no_key', bodySha256: null };
  const fields = { method: METHOD, pathWithQuery, bodySha256: parsed.bodySha256, ts: parsed.ts, nonce: parsed.nonce };
  // One canonical string for v1; one per expected origin for v2.
  const candidates = parsed.version === 1 ? [{ origin: null, canonical: canonicalString(fields) }] : origins.map((origin) => ({ origin, canonical: canonicalStringV2({ ...fields, origin }) }));
  const given = Buffer.from(parsed.sig, 'hex');
  let matched = false;
  let matchedOrigin = null;
  for (const key of usable) {
    const keyBuf = Buffer.from(key.trim(), 'utf8');
    for (const { origin, canonical } of candidates) {
      const expected = createHmac('sha256', keyBuf).update(canonical, 'utf8').digest();
      if (timingSafeEqual(given, expected)) {
        matched = true;
        matchedOrigin = origin;
      }
    }
  }
  if (!matched) return { ok: false, reason: 'signature', bodySha256: null };
  const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.ts) > skewSeconds) return { ok: false, reason: 'skew', bodySha256: null };
  const result = { ok: true, reason: null, bodySha256: parsed.bodySha256, ts: parsed.ts, nonce: parsed.nonce };
  return parsed.version === 1 ? result : { ...result, version: 2, origin: matchedOrigin };
}

// After verifyAdminSignature() accepted the header: whether the body that was then read matches
// the hash the signature covers. Constant time, so a Worker can use it for the admin_body check.
export function bodyMatches(bodySha256, bytes, timingSafeEqual = nodeTimingSafeEqual) {
  return timingSafeEqual(Buffer.from(bodySha256, 'hex'), createHash('sha256').update(bytes).digest());
}
