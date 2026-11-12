// The X-Caddie-Admin v2 request signature (scripts/lib/admin-sign.mjs), which binds a signed admin
// request to its origin, against the shared fixture file test/fixtures/admin-sign.v2.json.
//
// Run with `npm test`. Nothing here reaches the network. The fixture is built by
// test/fixtures/admin-sign.v2.gen.mjs, and the first test fails when the committed file differs
// from what the generator builds. Every "sign" vector is recomputed here from scratch, twice: with
// node:crypto and with WebCrypto (crypto.subtle), with the canonical string written out in this
// file rather than taken from the module. Every "verify" vector runs through the module's verifier
// and through a WebCrypto port written here the way the Worker's is: it compiles the header
// regexes from the fixtures' strings and uses the header's ts as a raw string. Every "reject"
// vector must throw a UsageError with the named code, and every "origin" vector must normalise as
// stated. The mutation tests at the end prove that a canonical string without its origin line or
// without its domain-separation line fails these vectors, and that a verifier that stops comparing
// at the first match fails the compare counts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import * as signModule from '../scripts/lib/admin-sign.mjs';
import * as originModule from '../scripts/lib/admin-origin.mjs';
import {
  BODYLESS_METHODS, DEFAULT_SIGN_VERSION, EMPTY_BODY_SHA256, HEADER_NAME, HEADER_RE, HEADER_RE_V2, MIN_KEY_LENGTH, NONCE_RE, PATH_RE, QUERY_RE, SKEW_SECONDS, UsageError, VERSION, VERSION_V2,
  ORIGIN_ALLOW_RE, ORIGIN_CHARS_RE, ORIGIN_FORBIDDEN_RE, ORIGIN_PREFIX_RE, SIG_VERSION_ENV,
  bodyMatches, canonicalOrigin, canonicalString, canonicalStringV2, parseAdminHeader, parseAdminOrigin, parseAdminSigMin, parseVersionedAdminHeader, signAdminRequest, signVersionFromEnv, verifyAdminSignature,
} from '../scripts/lib/admin-sign.mjs';
import { FIXTURE_URL, buildFixture, serialise } from './fixtures/admin-sign.v2.gen.mjs';

const MODULE_URL = new URL('../scripts/lib/admin-sign.mjs', import.meta.url);
const ORIGIN_MODULE_URL = new URL('../scripts/lib/admin-origin.mjs', import.meta.url);
const fixtureText = readFileSync(FIXTURE_URL, 'utf8');
const fixture = JSON.parse(fixtureText);
const v1 = JSON.parse(readFileSync(new URL('./fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const signCases = fixture.cases.filter((c) => c.kind === 'sign');
const verifyCases = fixture.cases.filter((c) => c.kind === 'verify');
const rejectCases = fixture.cases.filter((c) => c.kind === 'reject');
const originCases = fixture.cases.filter((c) => c.kind === 'origin');
const byId = Object.fromEntries(fixture.cases.map((c) => [c.id, c]));

const hex = (buf) => Buffer.from(buf).toString('hex');
// The canonical strings, written out here independently of the module.
const canonicalV2 = (c) => `caddie-admin-v2\n${c.method.toUpperCase()}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n${c.origin}\n`;
const canonicalV1 = (c) => `caddie-admin-v1\n${c.method.toUpperCase()}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n`;
const nodeHmacHex = (key, text) => crypto.createHmac('sha256', Buffer.from(key.trim(), 'utf8')).update(text, 'utf8').digest('hex');

async function webCryptoHmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}
const webCryptoSha256Hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

// The origin rule (the fixture's origin_rule), written the way a port would: the regexes compiled
// from the fixture's strings, not taken from the module.
const RAW_ORIGIN_CHARS = new RegExp(fixture.origin_chars_re);
const RAW_ORIGIN_PREFIX = new RegExp(fixture.origin_prefix_re, 'i');
const RAW_ORIGIN_FORBIDDEN = new RegExp(fixture.origin_forbidden_re);
const RAW_ORIGIN_ALLOW = new RegExp(fixture.origin_allow_re, 'i');
function portOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!RAW_ORIGIN_CHARS.test(text)) return null;
  if (!RAW_ORIGIN_PREFIX.test(text)) return null;
  if (RAW_ORIGIN_FORBIDDEN.test(text)) return null;
  if (!RAW_ORIGIN_ALLOW.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!fixture.origin_protocols.includes(u.protocol)) return null;
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null;
  // The parser rewrote nothing: its host is the typed one in lower case, its port the typed one
  // with the scheme's default (or an empty port) dropped.
  const authority = text.slice(text.indexOf('//') + 2).replace(/\/$/, '');
  const colon = authority.startsWith('[') ? authority.indexOf(':', authority.indexOf(']')) : authority.indexOf(':');
  const typedHost = colon === -1 ? authority : authority.slice(0, colon);
  const typedPort = colon === -1 ? '' : authority.slice(colon + 1);
  if (u.hostname !== typedHost.toLowerCase()) return null;
  if (u.port !== (typedPort === { 'http:': '80', 'https:': '443' }[u.protocol] ? '' : typedPort)) return null;
  return u.origin;
}

// A WebCrypto port of verifyAdminSignature() for both versions, written the way the Worker's
// verifier is: both header regexes compiled from the fixtures' strings (not the module's
// constants), ts kept as the header's raw string, the settings checked first, the bodyless rule,
// HMAC with every held key and every expected origin, constant-time compare, then the clock.
const RAW_RE_V1 = new RegExp(v1.header_re);
const RAW_RE_V2 = new RegExp(fixture.header_re);
class PortSettingsError extends Error {}
async function verifyWithWebCrypto({ headerValue, method, pathWithQuery, keys, now, allowedVersions, expectedOrigins }) {
  if (!Array.isArray(allowedVersions) || allowedVersions.length === 0 || allowedVersions.some((x) => x !== 1 && x !== 2)) throw new PortSettingsError('version');
  let origins = [];
  if (allowedVersions.includes(2)) {
    origins = Array.isArray(expectedOrigins) ? expectedOrigins.map(portOrigin) : [];
    if (origins.length === 0 || origins.includes(null)) throw new PortSettingsError('expected_origins');
    origins = [...new Set(origins)];
  }
  const text = typeof headerValue === 'string' ? headerValue : '';
  const m1 = RAW_RE_V1.exec(text);
  const m2 = RAW_RE_V2.exec(text);
  const version = m1 ? 1 : m2 ? 2 : null;
  if (version === null || !allowedVersions.includes(version)) return { ok: false, reason: 'malformed', compares: 0 };
  const [, ts, nonce, bodySha256, sig] = m1 ?? m2;
  const METHOD = method.toUpperCase();
  if (fixture.bodyless_methods.includes(METHOD) && bodySha256 !== fixture.empty_body_sha256) return { ok: false, reason: 'bodyless_body_hash', compares: 0 };
  const usable = keys.filter((k) => typeof k === 'string' && k.trim().length >= fixture.min_key_length);
  if (usable.length === 0) return { ok: false, reason: 'no_key', compares: 0 };
  const head = `${METHOD}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n`;
  const texts = version === 1 ? [[null, `caddie-admin-v1\n${head}`]] : origins.map((o) => [o, `caddie-admin-v2\n${head}${o}\n`]);
  const given = Buffer.from(sig, 'hex');
  let compares = 0;
  let matched = null;
  for (const key of usable) {
    for (const [origin, canonical] of texts) {
      compares++;
      if (crypto.timingSafeEqual(given, Buffer.from(await webCryptoHmacHex(key, canonical), 'hex'))) matched = { origin };
    }
  }
  if (!matched) return { ok: false, reason: 'signature', compares };
  if (Math.abs(now - Number(ts)) > fixture.skew_seconds) return { ok: false, reason: 'skew', compares };
  return { ok: true, reason: null, bodySha256, version, origin: matched.origin, compares };
}

// A verify case's input for the module (now in milliseconds) and for the port (now in seconds).
const moduleArgs = (c, extra = {}) => ({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now * 1000, allowedVersions: c.allowed_versions, expectedOrigins: c.expected_origins, ...extra });
const portArgs = (c) => ({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now, allowedVersions: c.allowed_versions, expectedOrigins: c.expected_origins });

describe('the v2 fixture file states the scheme the module implements', () => {
  test('the committed file is exactly what the generator builds, and it is ASCII', () => {
    assert.equal(fixtureText, serialise(buildFixture()));
    assert.ok(/^[\x00-\x7f]*$/.test(fixtureText), 'the fixture is ASCII-only');
  });

  test('constants', () => {
    assert.equal(fixture.version, VERSION_V2);
    assert.equal(fixture.version, 'v2');
    assert.equal(VERSION, 'v1');
    assert.equal(fixture.header_name, HEADER_NAME);
    assert.equal(fixture.header_re, HEADER_RE_V2.source);
    assert.equal(fixture.header_format, 'v2 <ts> <nonce> <bodySha256> <sig>');
    // The v1 rules the v2 file restates are the v1 file's, unchanged.
    assert.equal(fixture.v1_header_re, v1.header_re);
    assert.equal(fixture.v1_header_re, HEADER_RE.source);
    assert.equal(fixture.v1_canonical_format, v1.canonical_format);
    for (const k of ['header_name', 'query_re', 'path_re', 'empty_body_sha256', 'bodyless_methods', 'skew_seconds', 'min_key_length', 'keys']) assert.deepEqual(fixture[k], v1[k], k);
    assert.equal(fixture.query_re, QUERY_RE.source);
    assert.equal(fixture.path_re, PATH_RE.source);
    assert.equal(fixture.empty_body_sha256, EMPTY_BODY_SHA256);
    assert.deepEqual(fixture.bodyless_methods, [...BODYLESS_METHODS]);
    assert.equal(fixture.skew_seconds, SKEW_SECONDS);
    assert.equal(fixture.min_key_length, MIN_KEY_LENGTH);
    assert.deepEqual(fixture.origin_protocols, ['http:', 'https:']);
    // The v2 header grammar is v1's, field for field, with "v2" in front.
    assert.equal(HEADER_RE_V2.source.slice(3), HEADER_RE.source.slice(3));
    assert.equal(HEADER_RE_V2.source.slice(0, 3), '^v2');
    assert.equal(HEADER_RE.source.slice(0, 3), '^v1');
    // From step (c) the signer signs v2 by default, as signVersionFromEnv() does with
    // CADDIE_ADMIN_SIG_VERSION unset; the Node verifier still accepts v1 only unless told otherwise.
    assert.equal(fixture.default_sign_version, 2);
    assert.equal(DEFAULT_SIGN_VERSION, 2);
    assert.equal(signVersionFromEnv({}), DEFAULT_SIGN_VERSION);
    assert.deepEqual(fixture.default_allowed_versions, [1]);
  });

  test('canonical_format and the about text state the exact layout the module builds', () => {
    // canonical_format, with its placeholders filled in, is what canonicalStringV2() returns.
    const f = { method: 'POST', pathWithQuery: '/admin/x?event=e', bodySha256: 'b'.repeat(64), ts: 12, nonce: 'n'.repeat(22), origin: 'https://o.example' };
    const filled = fixture.canonical_format.replaceAll('\\n', '\n').replace('<METHOD>', f.method).replace('<pathname + search>', f.pathWithQuery).replace('<bodySha256>', f.bodySha256).replace('<ts>', f.ts).replace('<nonce>', f.nonce).replace('<origin>', f.origin);
    assert.equal(filled, canonicalStringV2(f));
    assert.equal(filled.split('\n').length, 8, 'seven lines, each ending in "\\n"');
    assert.ok(filled.endsWith('\n') && !filled.includes('\r'));
    const filledV1 = fixture.v1_canonical_format.replaceAll('\\n', '\n').replace('<METHOD>', f.method).replace('<pathname + search>', f.pathWithQuery).replace('<bodySha256>', f.bodySha256).replace('<ts>', f.ts).replace('<nonce>', f.nonce);
    assert.equal(filledV1, canonicalString(f));
    for (const phrase of ['exactly seven lines', 'line 1 "caddie-admin-v2"', 'line 7 the origin', 'new URL(x).origin', 'no v1 string equals a v2 string', 'Math.floor(Date.now() / 1000)', 'printable ASCII only, a literal http:// or https:// prefix', 'new URL(request.url).origin', 'Only a set ADMIN_ORIGIN with a refused entry, or an ADMIN_SIG_MIN other than unset, "1" or "2"', 'expect.compares', 'node_api_only']) {
      assert.ok(fixture.about.includes(phrase), `about names: ${phrase}`);
    }
    assert.ok(fixture.origin_rule.includes('^[\\x21-\\x7e]+$') && fixture.origin_rule.includes('^https?://') && fixture.origin_rule.includes('no "@"'));
    assert.ok(fixture.worker_admin_origin.includes('unset, or empty after trimming (mode "fallback"): the expected origins are [new URL(request.url).origin], computed without origin_rule'));
    assert.ok(fixture.worker_admin_sig_min.includes('The match is exact because a loose reading would fail open at step d'));
    // The origin regexes in the fixture are the module's, flags included.
    assert.equal(fixture.origin_chars_re, ORIGIN_CHARS_RE.source);
    assert.equal(fixture.origin_prefix_re, ORIGIN_PREFIX_RE.source);
    assert.equal(fixture.origin_forbidden_re, ORIGIN_FORBIDDEN_RE.source);
    assert.equal(fixture.origin_forbidden_re, '[@\\\\%,]');
    assert.equal(fixture.origin_allow_re, ORIGIN_ALLOW_RE.source);
    assert.deepEqual([ORIGIN_CHARS_RE.flags, ORIGIN_PREFIX_RE.flags, ORIGIN_FORBIDDEN_RE.flags, ORIGIN_ALLOW_RE.flags], ['', 'i', '', 'i']);
    assert.ok(fixture.worker_admin_origin.includes('never another deployment\'s origin'));
    assert.ok(fixture.verify_reasons.signature.includes('a wrong origin is this reason'));
    assert.ok(fixture.verify_reasons.malformed.includes('not in allowed_versions'));
  });

  test('the reject codes are exactly the codes the module throws', () => {
    const codes = Object.keys(fixture.reject_reasons).filter((k) => !k.startsWith('_')).sort();
    const source = readFileSync(MODULE_URL, 'utf8') + readFileSync(ORIGIN_MODULE_URL, 'utf8');
    const thrown = [...new Set([...source.matchAll(/new UsageError\([\s\S]*?, '([a-z_]+)'\);/g)].map((m) => m[1]))].sort();
    assert.deepEqual(codes, thrown);
    assert.ok(rejectCases.every((c) => codes.includes(c.reject) && ['sign', 'verify'].includes(c.call)));
    for (const code of codes) assert.ok(rejectCases.some((c) => c.reject === code), `no reject case for ${code}`);
    assert.ok(rejectCases.some((c) => c.call === 'verify' && c.reject === 'expected_origins'));
    assert.ok(rejectCases.some((c) => c.call === 'verify' && c.reject === 'version'));
    assert.ok(rejectCases.some((c) => c.call === 'sign' && c.reject === 'version'));
    // Every verifier-settings case says whether a Worker has an equivalent. The Node-API-only ones
    // are the missing, empty and non-list expectedOrigins and every allowedVersions case; every
    // other one is a list holding an entry the origin rule refuses, as a set ADMIN_ORIGIN would.
    for (const c of rejectCases.filter((x) => x.call === 'verify')) {
      assert.equal(typeof c.node_api_only, 'boolean', c.id);
      if (!c.node_api_only) {
        assert.equal(c.reject, 'expected_origins', c.id);
        assert.ok(Array.isArray(c.input.expected_origins) && c.input.expected_origins.some((o) => portOrigin(o) === null), c.id);
      }
    }
    for (const id of ['reject-verify-origins-missing', 'reject-verify-origins-empty']) assert.equal(byId[id].node_api_only, true);
    assert.equal(byId['reject-verify-origins-empty-entry'].node_api_only, false);
  });

  test('the required cases are present', () => {
    const ids = fixture.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const id of [
      'get-stats', 'get-stats-uppercase-host', 'get-stats-default-port', 'get-stats-staging', 'get-stats-port-8443', 'get-stats-loopback', 'get-stats-ipv6', 'get-stats-punycode', 'put-conferences', 'put-body-flag',
      'v-ok', 'v-wrong-origin', 'v-wrong-origin-hostile', 'v-origin-list-first-matches', 'v-origin-list-second-matches', 'v-expected-uppercase', 'v-expected-default-port',
      'v-v2-header-over-v1-canonical', 'v-v1-header-over-v2-canonical', 'v-v1-ok-during-migration', 'v-v1-refused-min-2', 'v-v2-refused-v1-only',
      'v-skew-plus-300', 'v-skew-plus-301', 'v-skew-minus-300', 'v-skew-minus-301', 'v-skew-after-wrong-origin', 'v-body-flag-stripped',
      'v-malformed-missing', 'v-malformed-origin-field', 'v-malformed-ts-leading-zero', 'v-malformed-joined-twice', 'v-malformed-uppercase-version',
      'reject-verify-origins-missing', 'reject-verify-origins-empty', 'reject-verify-origins-empty-entry', 'reject-v2-base-credentials', 'reject-version-3',
      'origin-uppercase', 'origin-default-port-https', 'origin-punycode', 'origin-refused-path', 'origin-refused-request-url',
      'get-stats-workers-dev', 'v-first-of-four-pairs', 'origin-refused-tab', 'origin-refused-newline', 'origin-refused-fullwidth', 'origin-refused-no-slashes',
      'origin-refused-backslash-scheme', 'origin-refused-backslash-end', 'origin-refused-empty-userinfo', 'origin-refused-unicode',
      'reject-verify-origins-tab', 'reject-verify-origins-newline', 'reject-verify-origins-fullwidth', 'reject-verify-origins-no-slashes', 'reject-verify-origins-backslash', 'reject-verify-origins-empty-userinfo',
      'reject-v2-base-percent', 'reject-verify-origins-percent', 'v-v1-two-origins', 'origin-refused-empty-query-fragment',
      'origin-refused-percent-fullwidth', 'origin-refused-percent-unicode', 'origin-refused-percent-ideographic-stop', 'origin-refused-percent-dot', 'origin-refused-comma',
      'reject-v2-base-tab', 'reject-v2-base-fullwidth', 'reject-v2-base-no-slashes', 'reject-v2-base-backslash', 'reject-v2-base-empty-userinfo', 'reject-v2-base-unicode',
    ]) {
      assert.ok(byId[id], `missing case ${id}`);
    }
    assert.ok(signCases.every((c) => c.version === 2));
    // Non-default ports, an uppercase host and a non-ASCII host are among the sign cases.
    assert.ok(signCases.some((c) => new URL(c.base).port !== '' && c.origin.endsWith(`:${new URL(c.base).port}`)));
    assert.ok(signCases.some((c) => c.base !== c.base.toLowerCase() && c.origin === c.origin.toLowerCase()));
    assert.ok(signCases.some((c) => c.base.includes('xn--') && c.origin === c.base));
    // Every value in the file is ASCII, and the Unicode spelling of a host is a refused origin.
    assert.ok(signCases.every((c) => /^[\x21-\x7e]+$/.test(c.base)));
    assert.equal(byId['origin-refused-unicode'].expect.origin, null);
    // The list-membership cases hold two origins of one Worker (its custom domain and its
    // workers.dev hostname), of which one matches; no expected list names another deployment.
    for (const id of ['v-origin-list-first-matches', 'v-origin-list-second-matches', 'v-first-of-four-pairs']) {
      assert.deepEqual(byId[id].expected_origins, [fixture.origins.custom_domain, fixture.origins.workers_dev]);
      assert.ok(byId[id].expected_origins.includes(byId[id].expect.origin));
    }
    for (const c of verifyCases) assert.ok(!(c.expected_origins ?? []).includes(fixture.origins.other_deployment), c.id);
    // The first-of-four case: two keys, two origins, the match on the first pair, four compares.
    const four = byId['v-first-of-four-pairs'];
    assert.deepEqual(four.keys, [fixture.keys.key1, fixture.keys.key2]);
    assert.equal(four.header, byId['get-stats'].header);
    assert.equal(four.expect.origin, four.expected_origins[0]);
    assert.equal(four.expect.compares, 4);
  });
});

describe('v2 sign cases: every vector recomputed from scratch', () => {
  for (const c of signCases) {
    test(`${c.id}: ${c.title}`, async () => {
      // The header's shape, by the module's regex and by the fixture's string.
      assert.match(c.header, HEADER_RE_V2);
      assert.match(c.header, RAW_RE_V2);
      assert.doesNotMatch(c.header, HEADER_RE);
      assert.equal(c.header, `v2 ${c.ts} ${c.nonce} ${c.body_sha256} ${c.sig}`);
      assert.match(c.nonce, NONCE_RE);
      // The URL, the canonical path and the origin.
      const u = new URL(c.path, c.base);
      assert.equal(c.path_with_query, u.pathname + u.search);
      assert.equal(c.url, u.href);
      assert.match(u.search.slice(1), QUERY_RE);
      assert.match(u.pathname, PATH_RE);
      assert.equal(c.origin, new URL(c.base).origin);
      assert.equal(c.origin, portOrigin(c.base));
      assert.equal(c.origin, u.origin);
      // The body hash: the empty-body constant for GET, HEAD and DELETE, else SHA-256 of the UTF-8 bytes.
      const bytes = Buffer.from(c.body ?? '', 'utf8');
      if (fixture.bodyless_methods.includes(c.method)) {
        assert.equal(c.body, null);
        assert.equal(c.body_sha256, EMPTY_BODY_SHA256);
      } else {
        assert.equal(c.body_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.equal(c.body_sha256, await webCryptoSha256Hex(bytes));
      }
      // The canonical string and the signature, with node:crypto and with WebCrypto.
      assert.equal(c.canonical, canonicalV2(c));
      assert.ok(c.canonical.startsWith('caddie-admin-v2\n') && c.canonical.endsWith(`\n${c.origin}\n`));
      assert.equal(c.sig, nodeHmacHex(c.key, canonicalV2(c)));
      assert.equal(c.sig, await webCryptoHmacHex(c.key, canonicalV2(c)));
      // The module reproduces the vector exactly, and verifies it.
      const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, body: c.body, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: 2 });
      assert.equal(r.header, c.header);
      assert.equal(r.url, c.url);
      assert.equal(r.pathWithQuery, c.path_with_query);
      assert.equal(r.bodySha256, c.body_sha256);
      assert.equal(r.canonical, c.canonical);
      assert.equal(r.version, 2);
      assert.equal(r.origin, c.origin);
      assert.equal(canonicalStringV2({ method: c.method, pathWithQuery: c.path_with_query, bodySha256: c.body_sha256, ts: c.ts, nonce: c.nonce, origin: c.origin }), c.canonical);
      for (const allowedVersions of [[2], [1, 2]]) {
        const v = verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts * 1000, allowedVersions, expectedOrigins: [c.base] });
        assert.deepEqual(v, { ok: true, reason: null, bodySha256: c.body_sha256, ts: c.ts, nonce: c.nonce, version: 2, origin: c.origin });
        assert.ok(bodyMatches(v.bodySha256, bytes));
      }
      const w = await verifyWithWebCrypto({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts, allowedVersions: [1, 2], expectedOrigins: [c.origin] });
      assert.equal(w.ok, true);
      assert.equal(w.origin, c.origin);
      // The default verifier (v1 only) answers a v2 header as malformed, as it always did.
      assert.deepEqual(verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts * 1000 }), { ok: false, reason: 'malformed', bodySha256: null });
      // An equivalence case has the same header as the case it names.
      if (c.same_header_as) {
        assert.equal(c.header, byId[c.same_header_as].header);
        assert.notEqual(c.base, byId[c.same_header_as].base);
      }
      // The v1 and v2 canonical strings of the same request differ, and so do their signatures.
      assert.notEqual(canonicalV1(c), c.canonical);
      assert.notEqual(nodeHmacHex(c.key, canonicalV1(c)), c.sig);
    });
  }

  test('origin case and port normalisation: four spellings of one origin sign one header', () => {
    const group = signCases.filter((c) => c.same_header_as === 'get-stats');
    assert.ok(group.length >= 3);
    const bases = new Set(group.map((c) => c.base));
    assert.ok([...bases].some((b) => b !== b.toLowerCase()), 'an uppercase spelling');
    assert.ok([...bases].some((b) => b.endsWith(':443')), 'a default-port spelling');
    for (const c of group) assert.equal(c.header, byId['get-stats'].header);
  });

  test('the same request signed for another origin differs in the signature only', () => {
    const a = byId['get-stats'];
    for (const id of ['get-stats-staging', 'get-stats-port-8443', 'get-stats-https-port-80']) {
      const b = byId[id];
      assert.notEqual(b.origin, a.origin);
      assert.equal(b.header.split(' ').slice(0, 4).join(' '), a.header.split(' ').slice(0, 4).join(' '));
      assert.notEqual(b.sig, a.sig);
    }
    assert.equal(byId['get-stats-port-8443'].origin, 'https://caddie.example:8443');
    assert.equal(byId['get-stats-https-port-80'].origin, 'https://caddie.example:80');
    assert.equal(byId['get-stats-http-default-port'].origin, 'http://localhost');
  });

  test('a flag in the body (allow_shrink) changes the hash and the signature only', () => {
    const a = byId['put-conferences'];
    const b = byId['put-body-flag'];
    assert.equal(a.ts, b.ts);
    assert.equal(a.nonce, b.nonce);
    assert.equal(a.origin, b.origin);
    assert.equal(a.path_with_query, b.path_with_query);
    assert.ok(JSON.parse(b.body).allow_shrink === true && JSON.parse(a.body).allow_shrink === undefined);
    assert.notEqual(a.body_sha256, b.body_sha256);
    assert.notEqual(a.sig, b.sig);
    assert.equal(bodyMatches(b.body_sha256, Buffer.from(a.body)), false);
    assert.equal(byId['v-body-flag-stripped'].expect.reason, 'signature');
  });

  test('a v2 signature needs a strict origin string as its base; v1 is unchanged', () => {
    const key = fixture.keys.key1;
    const lax = ['file:///', 'ftp://caddie.example', 'https://user:secret@caddie.example', 'https://@caddie.example', 'https:caddie.example', 'https://caddie.example\\', 'https://cad\tdie.example'];
    for (const base of [...lax, new URL('https://caddie.example')]) {
      assert.throws(() => signAdminRequest({ method: 'GET', path: '/admin/stats', base, key, version: 2 }), (e) => e instanceof UsageError && e.code === 'url', String(base));
    }
    // v1 kept accepting these bases (it binds no origin), and still does.
    for (const base of lax.slice(2)) assert.match(signAdminRequest({ method: 'GET', path: '/admin/stats', base, key, version: 1 }).header, HEADER_RE, base);
    assert.match(signAdminRequest({ method: 'GET', path: '/admin/stats', base: new URL('https://caddie.example'), key, version: 1 }).header, HEADER_RE);
    // From step (c) the default is v2, so the same bases are refused when no version is named.
    for (const base of [...lax, new URL('https://caddie.example')]) {
      assert.throws(() => signAdminRequest({ method: 'GET', path: '/admin/stats', base, key }), (e) => e instanceof UsageError && e.code === 'url', String(base));
    }
  });

  test('version 1 signs exactly the v1 vector, with the v1 result shape', () => {
    const c = v1.cases.find((x) => x.id === 'get-stats');
    const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: 1 });
    assert.equal(r.header, c.header);
    assert.deepEqual(Object.keys(r).sort(), ['bodySha256', 'canonical', 'header', 'method', 'nonce', 'pathWithQuery', 'ts', 'url']);
  });

  test('the default is v2 from step (c): no version signs exactly the v2 vector, with the v2 result shape', () => {
    const c = signCases.find((x) => x.id === 'get-stats');
    const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce });
    const explicit = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: 2 });
    assert.equal(r.header, c.header);
    assert.match(r.header, HEADER_RE_V2);
    assert.deepEqual(explicit, r);
    assert.equal(r.version, 2);
    assert.equal(r.origin, c.origin);
  });

  test('a fresh v2 signature has a fresh nonce and verifies for its origin only', () => {
    const key = fixture.keys.key1;
    const a = signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://Caddie.example:443', key, version: 2 });
    const b = signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://caddie.example', key, version: 2 });
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(a.origin, 'https://caddie.example');
    const check = (expectedOrigins) => verifyAdminSignature({ headerValue: a.header, method: 'GET', pathWithQuery: '/admin/stats', keys: [key], allowedVersions: [1, 2], expectedOrigins });
    assert.equal(check(['https://caddie.example']).ok, true);
    assert.equal(check(['https://caddie-staging.example']).reason, 'signature');
  });
});

describe('v2 verify cases: the module and a WebCrypto port agree with the fixture', () => {
  for (const c of verifyCases) {
    test(`${c.id}: ${c.title}`, async () => {
      let compares = 0;
      const counting = (a, b) => {
        compares++;
        return crypto.timingSafeEqual(a, b);
      };
      const got = verifyAdminSignature(moduleArgs(c, { timingSafeEqual: counting }));
      assert.equal(got.ok, c.expect.ok, JSON.stringify(got));
      const parsed = parseVersionedAdminHeader(c.header);
      if (c.expect.ok) {
        assert.equal(got.reason, null);
        assert.equal(got.bodySha256, c.expect.body_sha256);
        assert.equal(parsed.version, c.expect.version);
        assert.equal(got.ts, parsed.ts);
        assert.equal(got.nonce, parsed.nonce);
        if (c.expect.version === 2) {
          assert.equal(got.version, 2);
          assert.equal(got.origin, c.expect.origin);
        } else {
          // A v1 success keeps the exact shape it had before v2.
          assert.deepEqual(got, { ok: true, reason: null, bodySha256: c.expect.body_sha256, ts: parsed.ts, nonce: parsed.nonce });
          assert.equal(c.expect.origin, undefined);
        }
      } else {
        assert.equal(got.reason, c.expect.reason);
        assert.equal(got.bodySha256, null);
      }
      // No HMAC runs before the header shape, its version, the bodyless rule and the key presence
      // are checked; when it runs, every (held key, expected origin) pair is compared once, with
      // no early exit on the first match.
      const usable = c.keys.filter((k) => typeof k === 'string' && k.trim().length >= MIN_KEY_LENGTH).length;
      const beforeHmac = ['malformed', 'bodyless_body_hash', 'no_key'].includes(got.reason);
      const pairs = () => (parsed.version === 2 ? usable * new Set(c.expected_origins.map((o) => new URL(o).origin)).size : usable);
      assert.equal(compares, beforeHmac ? 0 : pairs());
      assert.equal(compares, c.expect.compares);
      const web = await verifyWithWebCrypto(portArgs(c));
      assert.equal(web.ok, got.ok);
      assert.equal(web.reason, got.reason);
      assert.equal(web.compares, compares);
      if (c.expect.ok) {
        assert.equal(web.bodySha256, c.expect.body_sha256);
        assert.equal(web.version, c.expect.version);
        assert.equal(web.origin, c.expect.origin ?? null);
      }
    });
  }

  test('a wrong origin is a plain signature failure: the same answer as a wrong key', () => {
    const wrongOrigin = verifyAdminSignature(moduleArgs(byId['v-wrong-origin']));
    const c = byId['v-ok-get'];
    const wrongKey = verifyAdminSignature(moduleArgs(c, { keys: ['00000000000000000000000000000000000000000000000000000000000000ff'] }));
    assert.deepEqual(wrongOrigin, { ok: false, reason: 'signature', bodySha256: null });
    assert.deepEqual(wrongKey, wrongOrigin);
  });

  test('the injected compare is the only comparison, and a compare that always fails rejects every good v2 header', () => {
    for (const c of verifyCases.filter((x) => x.expect.ok)) {
      assert.deepEqual(verifyAdminSignature(moduleArgs(c, { timingSafeEqual: () => false })), { ok: false, reason: 'signature', bodySha256: null }, c.id);
    }
  });

  test('skewSeconds is configurable under v2', () => {
    const c = byId['v-skew-plus-301'];
    assert.equal(verifyAdminSignature(moduleArgs(c, { skewSeconds: 301 })).ok, true);
  });

  test('the settings are checked before the header, so a misconfigured verifier refuses every request', () => {
    for (const headerValue of [null, '', 'garbage', byId['v-v1-ok-during-migration'].header, byId['v-ok-get'].header]) {
      assert.throws(() => verifyAdminSignature({ headerValue, method: 'GET', pathWithQuery: '/admin/stats', keys: [fixture.keys.key1], allowedVersions: [1, 2] }), (e) => e instanceof UsageError && e.code === 'expected_origins' && e.exitCode === 2);
      assert.throws(() => verifyAdminSignature({ headerValue, method: 'GET', pathWithQuery: '/admin/stats', keys: [fixture.keys.key1], allowedVersions: [] }), (e) => e instanceof UsageError && e.code === 'version');
    }
    // With v2 not allowed, expected origins are not needed and not read.
    const c = byId['v-v1-ok-during-migration'];
    assert.equal(verifyAdminSignature({ ...moduleArgs(c), allowedVersions: [1], expectedOrigins: undefined }).ok, true);
    assert.equal(verifyAdminSignature({ ...moduleArgs(c), allowedVersions: undefined, expectedOrigins: ['not an origin'] }).ok, true);
  });

  test('parseVersionedAdminHeader reports the version; parseAdminHeader still reads v1 only', () => {
    const c2 = byId['get-stats'];
    const c1 = v1.cases.find((x) => x.id === 'get-stats');
    assert.deepEqual(parseVersionedAdminHeader(c2.header), { version: 2, ts: c2.ts, nonce: c2.nonce, bodySha256: c2.body_sha256, sig: c2.sig });
    assert.deepEqual(parseVersionedAdminHeader(c1.header), { version: 1, ts: c1.ts, nonce: c1.nonce, bodySha256: c1.body_sha256, sig: c1.sig });
    assert.equal(parseAdminHeader(c2.header), null);
    assert.deepEqual(parseAdminHeader(c1.header), { ts: c1.ts, nonce: c1.nonce, bodySha256: c1.body_sha256, sig: c1.sig });
    for (const bad of [undefined, null, 42, '', 'v2', `${c2.header}\n`, c2.header.toUpperCase(), c2.header.replace(/^v2/, 'v3'), `${c2.header} ${c2.origin}`]) {
      assert.equal(parseVersionedAdminHeader(bad), null, String(bad));
    }
    for (const c of verifyCases.filter((x) => x.expect.reason === 'malformed' && !x.id.startsWith('v-v'))) assert.equal(parseVersionedAdminHeader(c.header), null, c.id);
  });
});

describe('v2 reject cases: refused before anything is sent or checked', () => {
  for (const c of rejectCases) {
    test(`${c.id}: ${c.title}`, async () => {
      const usage = (e) => e instanceof UsageError && e.code === c.reject && e.exitCode === 2;
      if (c.call === 'sign') {
        assert.throws(() => signAdminRequest({ ...c.input }), usage);
        return;
      }
      const i = c.input;
      const args = { headerValue: i.header, method: i.method, pathWithQuery: i.path_with_query, keys: i.keys, now: i.now * 1000, allowedVersions: i.allowed_versions, expectedOrigins: i.expected_origins };
      assert.throws(() => verifyAdminSignature(args), usage);
      // The port written the way the Worker's is refuses the same settings.
      await assert.rejects(verifyWithWebCrypto({ ...args, now: i.now }), (e) => e instanceof PortSettingsError && e.message === c.reject);
    });
  }
});

describe('origin cases: the normalisation both sides apply', () => {
  for (const c of originCases) {
    test(`${c.id}: ${c.title}`, () => {
      assert.equal(canonicalOrigin(c.input), c.expect.origin);
      assert.equal(portOrigin(c.input), c.expect.origin);
      if (c.expect.origin !== null) {
        assert.equal(c.expect.origin, new URL(c.input).origin);
        // An accepted value is a fixed point: its origin normalises to itself.
        assert.equal(canonicalOrigin(c.expect.origin), c.expect.origin);
      }
      // A request URL is refused as an origin value, while its own origin is what a Worker with
      // ADMIN_ORIGIN unset expects.
      if (c.request_url_origin !== undefined) assert.equal(new URL(c.input).origin, c.request_url_origin);
    });
  }

  test('non-strings are refused, a URL object included', () => {
    for (const x of [undefined, null, 42, {}, ['https://caddie.example'], new URL('https://caddie.example')]) assert.equal(canonicalOrigin(x), null);
  });

  test('every refused value that new URL() accepts would have been read as some origin: the strict rule is what refuses it', () => {
    const lax = originCases.filter((c) => c.expect.origin === null && c.input.trim() !== '' && (() => {
      try {
        return /^https?:$/.test(new URL(c.input).protocol);
      } catch {
        return false;
      }
    })());
    assert.ok(lax.length >= 8, `${lax.length}`);
    for (const id of ['origin-refused-tab', 'origin-refused-newline', 'origin-refused-fullwidth', 'origin-refused-no-slashes', 'origin-refused-backslash-scheme', 'origin-refused-backslash-end', 'origin-refused-empty-userinfo', 'origin-refused-unicode',
      'origin-refused-percent-fullwidth', 'origin-refused-percent-unicode', 'origin-refused-percent-ideographic-stop', 'origin-refused-percent-dot', 'origin-refused-percent-zero-width', 'origin-refused-triple-slash', 'origin-refused-dot-path', 'origin-refused-encoded-dot-path']) {
      assert.ok(lax.some((c) => c.id === id), id);
    }
    assert.equal(new URL(byId['origin-refused-newline'].input).origin, 'https://caddie.example.evil.example');
    assert.equal(new URL(byId['origin-refused-fullwidth'].input).origin, 'https://caddie.example');
    // Percent-encoding: the URL parser decodes a host and then maps it.
    assert.equal(new URL(byId['origin-refused-percent-ideographic-stop'].input).origin, 'https://caddie.example.evil.example');
    assert.equal(new URL(byId['origin-refused-percent-fullwidth'].input).origin, 'https://caddie.example');
    assert.equal(new URL(byId['origin-refused-percent-unicode'].input).origin, 'https://xn--bcher-kva.example');
    assert.equal(new URL(byId['origin-refused-percent-zero-width'].input).origin, 'https://caddie.example');
    assert.equal(new URL(byId['origin-refused-percent-dot'].input).origin, 'https://caddie.example');
  });

  test('the allowlist alone refuses everything the three named checks refuse', () => {
    for (const c of originCases) {
      const t = c.input.trim();
      if (!ORIGIN_CHARS_RE.test(t) || !ORIGIN_PREFIX_RE.test(t) || ORIGIN_FORBIDDEN_RE.test(t)) assert.doesNotMatch(t, ORIGIN_ALLOW_RE, c.id);
    }
  });
});

describe('scripts/lib/admin-origin.mjs: imports nothing, so the Worker can use it as it is', () => {
  test('the module has no import of any kind and touches no Node global', () => {
    const source = readFileSync(ORIGIN_MODULE_URL, 'utf8');
    const code = source.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bimport\s*[\s{*'"(]/, 'no static or dynamic import');
    assert.doesNotMatch(code, /\bexport\s*(?:\*|\{[^}]*\})\s*from\b/, 'no re-export from another module');
    assert.doesNotMatch(source, /['"]node:/, 'no node: specifier anywhere');
    assert.doesNotMatch(code, /\brequire\s*\(/);
    assert.doesNotMatch(code, /\b(?:Buffer|process|globalThis|__dirname|__filename)\b/);
    assert.ok(/^[\x00-\x7f]*$/.test(source));
  });

  test('admin-sign.mjs re-exports every export of admin-origin.mjs, as the same objects', () => {
    const names = Object.keys(originModule).sort();
    assert.deepEqual(names, ['ORIGIN_ALLOW_RE', 'ORIGIN_CHARS_RE', 'ORIGIN_FORBIDDEN_RE', 'ORIGIN_PREFIX_RE', 'SIG_VERSION_ENV', 'UsageError', 'canonicalOrigin', 'parseAdminOrigin', 'parseAdminSigMin', 'signVersionFromEnv']);
    for (const name of names) assert.equal(signModule[name], originModule[name], name);
    // The signer's own UsageErrors are instances of the one class.
    assert.throws(() => signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://caddie.example', key: 'short' }), (e) => e instanceof originModule.UsageError);
  });
});

describe('worker_config_cases: the Worker reads ADMIN_ORIGIN and ADMIN_SIG_MIN exactly so', () => {
  const configCases = fixture.worker_config_cases;
  test('the cases cover the agreed values', () => {
    const raws = (setting) => configCases.filter((c) => c.setting === setting).map((c) => (c.unset ? undefined : c.raw));
    for (const raw of [undefined, '', '  ', ',', 'https://caddie.example,']) assert.ok(raws('ADMIN_ORIGIN').includes(raw), JSON.stringify(raw));
    assert.ok(raws('ADMIN_ORIGIN').some((r) => typeof r === 'string' && r.includes('%')));
    assert.ok(raws('ADMIN_ORIGIN').some((r) => typeof r === 'string' && r !== r.trim() && r !== r.toLowerCase()));
    for (const raw of [undefined, '1', '2', '', ' 2', '02', 'v2', '3', '2\n']) assert.ok(raws('ADMIN_SIG_MIN').includes(raw), JSON.stringify(raw));
    for (const c of configCases) assert.equal('raw' in c, !c.unset, c.id);
    const ids = configCases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const c of configCases) {
    test(`${c.id}: ${c.title}`, () => {
      const raw = c.unset ? undefined : c.raw;
      if (c.setting === 'ADMIN_ORIGIN') {
        assert.deepEqual(parseAdminOrigin(raw), c.expect);
        // A list is what the Node verifier takes as expectedOrigins.
        if (c.expect.mode === 'list') assert.deepEqual(c.expect.origins, [...new Set(raw.split(',').map(portOrigin))]);
      } else {
        assert.deepEqual(parseAdminSigMin(raw), c.expect.allowed_versions);
      }
    });
  }

  test('the parsers on values an environment never holds', () => {
    assert.deepEqual(parseAdminOrigin(null), { mode: 'fallback', origins: [] });
    for (const raw of [42, {}, ['https://caddie.example'], true]) assert.deepEqual(parseAdminOrigin(raw), { mode: 'invalid', origins: [] });
    for (const raw of [null, 1, 2, ['2'], true, '2 ', '\t2', '+2', '2.0', 'two']) assert.equal(parseAdminSigMin(raw), null, JSON.stringify(raw));
  });

  test('a parsed ADMIN_ORIGIN list and ADMIN_SIG_MIN drive the Node verifier', () => {
    const c = byId['v-origin-list-second-matches'];
    const origins = parseAdminOrigin(`${fixture.origins.custom_domain}, ${fixture.origins.workers_dev}`);
    assert.equal(origins.mode, 'list');
    const r = verifyAdminSignature(moduleArgs(c, { expectedOrigins: origins.origins, allowedVersions: parseAdminSigMin('2') }));
    assert.equal(r.ok, true);
    assert.equal(r.origin, fixture.origins.workers_dev);
    const v1 = byId['v-v1-ok-during-migration'];
    assert.equal(verifyAdminSignature(moduleArgs(v1, { allowedVersions: parseAdminSigMin('2') })).reason, 'malformed');
    assert.equal(verifyAdminSignature(moduleArgs(v1, { allowedVersions: parseAdminSigMin(undefined) })).ok, true);
  });
});

describe('signVersionFromEnv: the client override of the signed version (steps c to d)', () => {
  test('unset or empty is 2; exactly "1" or "2" is that version', () => {
    assert.equal(SIG_VERSION_ENV, 'CADDIE_ADMIN_SIG_VERSION');
    assert.equal(signVersionFromEnv({}), 2);
    assert.equal(signVersionFromEnv({ [SIG_VERSION_ENV]: undefined }), 2);
    // GitHub Actions passes an undefined repository variable as the empty string.
    assert.equal(signVersionFromEnv({ [SIG_VERSION_ENV]: '' }), 2);
    assert.equal(signVersionFromEnv({ [SIG_VERSION_ENV]: '1' }), 1);
    assert.equal(signVersionFromEnv({ [SIG_VERSION_ENV]: '2' }), 2);
    assert.equal(signVersionFromEnv({ OTHER: '1' }), 2);
  });

  test('anything else is a UsageError "version" (exit 2), never a silent default', () => {
    for (const raw of [' 1', '1 ', '01', 'v1', 'v2', '3', '0', '2\n', 'one', ' ', 'true']) {
      assert.throws(() => signVersionFromEnv({ [SIG_VERSION_ENV]: raw }), (e) => e instanceof UsageError && e.code === 'version' && e.exitCode === 2, JSON.stringify(raw));
    }
    for (const env of [undefined, null, 'CADDIE_ADMIN_SIG_VERSION=1']) assert.throws(() => signVersionFromEnv(env), TypeError);
  });

  test('its result signs with signAdminRequest', () => {
    const c = byId['get-stats'];
    for (const [raw, version] of [['1', 1], ['2', 2], ['', 2]]) {
      const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: signVersionFromEnv({ [SIG_VERSION_ENV]: raw }) });
      assert.equal(parseVersionedAdminHeader(r.header).version, version);
      if (version === 2) assert.equal(r.header, c.header);
    }
  });
});

describe('v1 and v2 can never produce the same canonical string', () => {
  test('the first line separates the versions, and v2 has one line more', () => {
    for (const c of signCases) {
      const f = { method: c.method, pathWithQuery: c.path_with_query, bodySha256: c.body_sha256, ts: c.ts, nonce: c.nonce, origin: c.origin };
      const one = canonicalString(f);
      const two = canonicalStringV2(f);
      assert.notEqual(one, two);
      assert.equal(one.split('\n')[0], 'caddie-admin-v1');
      assert.equal(two.split('\n')[0], 'caddie-admin-v2');
      assert.equal(two.split('\n').length, one.split('\n').length + 1);
    }
    // Whatever the fields, a v1 string starts with "caddie-admin-v1\n" and a v2 string with
    // "caddie-admin-v2\n", so no choice of fields makes them equal.
    for (let i = 0; i < 200; i++) {
      const r = () => crypto.randomBytes(8).toString('base64url');
      const f = { method: 'POST', pathWithQuery: `/${r()}`, bodySha256: r(), ts: r(), nonce: r(), origin: `https://${r()}.example\ncaddie-admin-v1` };
      assert.notEqual(canonicalString(f), canonicalStringV2(f));
      assert.ok(canonicalStringV2(f).startsWith('caddie-admin-v2\n'));
    }
  });
});

describe('mutation checks: the vectors catch a canonical string that loses a line', () => {
  // Three broken v2 canonical strings, each one plausible mistake.
  const mutants = {
    'origin line dropped': (c) => `caddie-admin-v2\n${c.method}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n`,
    'domain-separation line dropped': (c) => `${c.method}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n${c.origin}\n`,
    'v1 domain line reused': (c) => `caddie-admin-v1\n${c.method}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n${c.origin}\n`,
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    test(`written out here: ${name} matches no sign vector`, () => {
      for (const c of signCases) assert.notEqual(nodeHmacHex(c.key, mutant(c)), c.sig, c.id);
    });
  }

  // The same mistakes made in the module's own source: a copy with one edit is imported, and the
  // vectors must reject it. The edit must apply exactly once, so the check cannot pass vacuously.
  const sourceMutations = {
    'origin line dropped': ['${nonce}\\n${origin}\\n`', '${nonce}\\n`'],
    'domain-separation line dropped': ['`caddie-admin-v2\\n${String(method)', '`${String(method)'],
  };
  // A verifier that stops comparing at the first match, in either loop, makes fewer comparisons than
  // expect.compares: the first-of-four case catches both.
  const exitMutations = {
    'early exit in the key loop': ['  for (const key of usable) {\n    const keyBuf', '  for (const key of usable) {\n    if (matched) break;\n    const keyBuf'],
    'early exit in the origin loop': ['        matchedOrigin = origin;\n', '        matchedOrigin = origin;\n        break;\n'],
  };
  for (const [name, [from, to]] of Object.entries(exitMutations)) {
    test(`in the module: ${name} fails the compare counts`, async () => {
      const source = readFileSync(MODULE_URL, 'utf8');
      assert.equal(source.split(from).length, 2, `the mutation "${name}" applies exactly once`);
      const dir = mkdtempSync(join(tmpdir(), 'v2-admin-sign-mutant-'));
      try {
        const file = join(dir, 'admin-sign.mjs');
        writeFileSync(file, source.replace(from, to));
        writeFileSync(join(dir, 'admin-origin.mjs'), readFileSync(ORIGIN_MODULE_URL, 'utf8'));
        const m = await import(pathToFileURL(file).href);
        const wrong = [];
        for (const c of verifyCases) {
          let compares = 0;
          const got = m.verifyAdminSignature(moduleArgs(c, { timingSafeEqual: (a, b) => (compares++, crypto.timingSafeEqual(a, b)) }));
          assert.equal(got.ok, c.expect.ok, c.id);
          if (compares !== c.expect.compares) wrong.push(c.id);
        }
        assert.ok(wrong.includes('v-first-of-four-pairs'), `the mutant's counts differ only in: ${wrong.join(', ')}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, [from, to]] of Object.entries(sourceMutations)) {
    test(`in the module: ${name} fails the sign and verify vectors`, async () => {
      const source = readFileSync(MODULE_URL, 'utf8');
      assert.equal(source.split(from).length, 2, `the mutation "${name}" applies exactly once`);
      const dir = mkdtempSync(join(tmpdir(), 'v2-admin-sign-mutant-'));
      try {
        const file = join(dir, 'admin-sign.mjs');
        writeFileSync(file, source.replace(from, to));
        writeFileSync(join(dir, 'admin-origin.mjs'), readFileSync(ORIGIN_MODULE_URL, 'utf8'));
        const m = await import(pathToFileURL(file).href);
        for (const c of signCases) {
          const r = m.signAdminRequest({ method: c.method, path: c.path, base: c.base, body: c.body, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: 2 });
          assert.notEqual(r.header, c.header, `${c.id} still matches`);
          const v = m.verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts * 1000, allowedVersions: [2], expectedOrigins: [c.origin] });
          assert.equal(v.ok, false, `${c.id} still verifies`);
        }
        // The v1 vectors do not depend on the v2 line, so the mutant still signs them: the
        // failure above is the v2 vectors' doing.
        const c1 = v1.cases.find((x) => x.id === 'get-stats');
        assert.equal(m.signAdminRequest({ method: c1.method, path: c1.path, base: c1.base, key: c1.key, now: c1.ts * 1000, nonce: c1.nonce, version: 1 }).header, c1.header);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
