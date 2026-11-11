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
// (letters, digits, "_", ".", ":", "=", "&", "-"), so the two sides never disagree on escaping:
// an ISO instant such as since=2026-11-10T08:00:00Z passes; "%", a space or "+" does not. A value
// that needs other characters travels base64url-encoded under a key ending in "64" (q64 for the
// search text). Flags such as allow_shrink go in the JSON body, never in the query, so the body
// hash covers them.
//
// The key is the UTF-8 bytes of the secret after trimming surrounding whitespace, with no hex
// decoding; it must be at least 32 characters, as the Worker requires. Nothing here prints or
// logs a key, a header or a body.

import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

export const VERSION = 'v1';
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const QUERY_RE = /^[A-Za-z0-9_.:=&-]*$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
// ts is a decimal integer without a leading zero, so a raw-string verifier and Number() agree.
export const HEADER_RE = /^v1 (0|[1-9]\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
// The path of an admin request: absolute, one leading "/", and only letters, digits, "/", "_",
// "." and "-", so nothing in it is ever percent-encoded, which keeps both sides byte-identical.
export const PATH_RE = /^\/[A-Za-z0-9\/_.-]*$/;
export const HEADER_NAME = 'X-Caddie-Admin';
export const SKEW_SECONDS = 300;
export const MIN_KEY_LENGTH = 32;
// Methods that never carry a body: their header holds EMPTY_BODY_SHA256 and the Worker refuses any
// other hash before it computes anything.
export const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
const METHOD_RE = /^[A-Z]{3,10}$/;

// A request the signer refuses before anything is sent: the caller's mistake, exit code 2 in the CLI.
export class UsageError extends Error {
  constructor(message, code = 'usage') {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.exitCode = 2;
  }
}

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
  if (!PATH_RE.test(rawPath) || rawPath.startsWith('//')) {
    throw new UsageError('The admin request path must start with one "/" and hold only letters, digits, "/", "_", "." and "-".', 'path_charset');
  }
  let u;
  let origin;
  try {
    u = new URL(path, base);
    origin = new URL(base).origin;
  } catch {
    throw new UsageError('The admin request path or base is not a valid URL.', 'url');
  }
  if (u.origin !== origin || !PATH_RE.test(u.pathname)) {
    throw new UsageError('The admin request path must start with one "/" and hold only letters, digits, "/", "_", "." and "-".', 'path_charset');
  }
  if (!QUERY_RE.test(u.search.slice(1))) {
    throw new UsageError('The admin query string may hold only letters, digits, "_", ".", ":", "=", "&" and "-"; send other text base64url-encoded under a key ending in 64 (for example q64).', 'query_charset');
  }
  return { url: u, pathWithQuery: u.pathname + u.search };
}

// Signs one request. Returns the header value, the URL to send it to, and the pieces that went
// into the signature (for tests and fixtures). `now` is milliseconds; `nonce` is for tests only,
// because a nonce is single-use on the Worker and every retry must sign afresh.
export function signAdminRequest({ method, path, base, body, key, now, nonce }) {
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
  const canonical = canonicalString({ method: METHOD, pathWithQuery, bodySha256, ts, nonce: n });
  const sig = hmacSha256Hex(keyBuf, canonical);
  return { header: `${VERSION} ${ts} ${n} ${bodySha256} ${sig}`, url: url.href, pathWithQuery, method: METHOD, bodySha256, ts, nonce: n, canonical };
}

// Parses a header value; null when it does not match HEADER_RE exactly.
export function parseAdminHeader(value) {
  const m = HEADER_RE.exec(typeof value === 'string' ? value : '');
  if (!m) return null;
  return { ts: Number(m[1]), nonce: m[2], bodySha256: m[3], sig: m[4] };
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
export function verifyAdminSignature({ headerValue, method, pathWithQuery, keys, now, skewSeconds = SKEW_SECONDS, timingSafeEqual = nodeTimingSafeEqual }) {
  const parsed = parseAdminHeader(headerValue);
  if (!parsed) return { ok: false, reason: 'malformed', bodySha256: null };
  const METHOD = String(method ?? '').toUpperCase();
  if (BODYLESS_METHODS.has(METHOD) && parsed.bodySha256 !== EMPTY_BODY_SHA256) return { ok: false, reason: 'bodyless_body_hash', bodySha256: null };
  const usable = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k.trim().length >= MIN_KEY_LENGTH);
  if (usable.length === 0) return { ok: false, reason: 'no_key', bodySha256: null };
  const canonical = canonicalString({ method: METHOD, pathWithQuery, bodySha256: parsed.bodySha256, ts: parsed.ts, nonce: parsed.nonce });
  const given = Buffer.from(parsed.sig, 'hex');
  let matched = false;
  for (const key of usable) {
    const expected = createHmac('sha256', Buffer.from(key.trim(), 'utf8')).update(canonical, 'utf8').digest();
    if (timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'signature', bodySha256: null };
  const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.ts) > skewSeconds) return { ok: false, reason: 'skew', bodySha256: null };
  return { ok: true, reason: null, bodySha256: parsed.bodySha256, ts: parsed.ts, nonce: parsed.nonce };
}

// After verifyAdminSignature() accepted the header: whether the body that was then read matches
// the hash the signature covers. Constant time, so a Worker can use it for the admin_body check.
export function bodyMatches(bodySha256, bytes, timingSafeEqual = nodeTimingSafeEqual) {
  return timingSafeEqual(Buffer.from(bodySha256, 'hex'), createHash('sha256').update(bytes).digest());
}
