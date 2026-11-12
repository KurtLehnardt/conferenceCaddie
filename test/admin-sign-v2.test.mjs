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
// without its domain-separation line fails these vectors.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import {
  BODYLESS_METHODS, DEFAULT_SIGN_VERSION, EMPTY_BODY_SHA256, HEADER_NAME, HEADER_RE, HEADER_RE_V2, MIN_KEY_LENGTH, NONCE_RE, PATH_RE, QUERY_RE, SKEW_SECONDS, UsageError, VERSION, VERSION_V2,
  bodyMatches, canonicalOrigin, canonicalString, canonicalStringV2, parseAdminHeader, parseVersionedAdminHeader, signAdminRequest, verifyAdminSignature,
} from '../scripts/lib/admin-sign.mjs';
import { FIXTURE_URL, buildFixture, serialise } from './fixtures/admin-sign.v2.gen.mjs';

const MODULE_URL = new URL('../scripts/lib/admin-sign.mjs', import.meta.url);
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

// The origin rule, written out here from the fixture's constants rather than the module.
function portOrigin(value) {
  if (typeof value !== 'string') return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (!fixture.origin_protocols.includes(u.protocol)) return null;
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null;
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
    // The defaults stay on v1 until step (c).
    assert.equal(fixture.default_sign_version, 1);
    assert.equal(DEFAULT_SIGN_VERSION, 1);
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
    for (const phrase of ['exactly seven lines', 'line 1 "caddie-admin-v2"', 'line 7 the origin', 'new URL(base).origin', 'new URL(x).origin', 'no v1 string equals a v2 string', 'Math.floor(Date.now() / 1000)', 'no user name or password']) {
      assert.ok(fixture.about.includes(phrase), `about names: ${phrase}`);
    }
    assert.ok(fixture.verify_reasons.signature.includes('a wrong origin is this reason'));
    assert.ok(fixture.verify_reasons.malformed.includes('not in allowed_versions'));
  });

  test('the reject codes are exactly the codes the module throws', () => {
    const codes = Object.keys(fixture.reject_reasons).filter((k) => !k.startsWith('_')).sort();
    const source = readFileSync(MODULE_URL, 'utf8');
    const thrown = [...new Set([...source.matchAll(/new UsageError\([\s\S]*?, '([a-z_]+)'\);/g)].map((m) => m[1]))].sort();
    assert.deepEqual(codes, thrown);
    assert.ok(rejectCases.every((c) => codes.includes(c.reject) && ['sign', 'verify'].includes(c.call)));
    for (const code of codes) assert.ok(rejectCases.some((c) => c.reject === code), `no reject case for ${code}`);
    assert.ok(rejectCases.some((c) => c.call === 'verify' && c.reject === 'expected_origins'));
    assert.ok(rejectCases.some((c) => c.call === 'verify' && c.reject === 'version'));
    assert.ok(rejectCases.some((c) => c.call === 'sign' && c.reject === 'version'));
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
      'origin-uppercase', 'origin-default-port-https', 'origin-punycode', 'origin-refused-path',
    ]) {
      assert.ok(byId[id], `missing case ${id}`);
    }
    assert.ok(signCases.every((c) => c.version === 2));
    // Non-default ports, an uppercase host and a non-ASCII host are among the sign cases.
    assert.ok(signCases.some((c) => new URL(c.base).port !== '' && c.origin.endsWith(`:${new URL(c.base).port}`)));
    assert.ok(signCases.some((c) => c.base !== c.base.toLowerCase() && c.origin === c.origin.toLowerCase()));
    assert.ok(signCases.some((c) => /[^\x00-\x7f]/.test(c.base) && c.origin.includes('xn--')));
    // The list-membership cases hold two expected origins, of which one matches.
    for (const id of ['v-origin-list-first-matches', 'v-origin-list-second-matches']) {
      assert.equal(byId[id].expected_origins.length, 2);
      assert.ok(byId[id].expected_origins.includes(byId[id].expect.origin));
    }
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

  test('a v2 signature needs an http: or https: base without credentials; v1 is unchanged', () => {
    const key = fixture.keys.key1;
    for (const base of ['file:///', 'ftp://caddie.example', 'https://user:secret@caddie.example']) {
      assert.throws(() => signAdminRequest({ method: 'GET', path: '/admin/stats', base, key, version: 2 }), (e) => e instanceof UsageError && e.code === 'url', base);
    }
    // v1 kept accepting these bases (it binds no origin), and still does.
    assert.match(signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://user:secret@caddie.example', key }).header, HEADER_RE);
    // A base given as a URL object signs as its string does.
    const c = byId['get-stats-port-8443'];
    assert.equal(signAdminRequest({ method: 'GET', path: c.path, base: new URL(c.base), key, now: c.ts * 1000, nonce: c.nonce, version: 2 }).header, c.header);
  });

  test('the default is v1: no version signs exactly the v1 vector, with the v1 result shape', () => {
    const c = v1.cases.find((x) => x.id === 'get-stats');
    const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce });
    const explicit = signAdminRequest({ method: c.method, path: c.path, base: c.base, key: c.key, now: c.ts * 1000, nonce: c.nonce, version: 1 });
    assert.equal(r.header, c.header);
    assert.deepEqual(explicit, r);
    assert.deepEqual(Object.keys(r).sort(), ['bodySha256', 'canonical', 'header', 'method', 'nonce', 'pathWithQuery', 'ts', 'url']);
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
    });
  }

  test('non-strings are refused', () => {
    for (const x of [undefined, null, 42, {}, ['https://caddie.example']]) assert.equal(canonicalOrigin(x), null);
    assert.equal(canonicalOrigin(new URL('HTTPS://Caddie.example:443')), 'https://caddie.example');
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
  for (const [name, [from, to]] of Object.entries(sourceMutations)) {
    test(`in the module: ${name} fails the sign and verify vectors`, async () => {
      const source = readFileSync(MODULE_URL, 'utf8');
      assert.equal(source.split(from).length, 2, `the mutation "${name}" applies exactly once`);
      const dir = mkdtempSync(join(tmpdir(), 'v2-admin-sign-mutant-'));
      try {
        const file = join(dir, 'admin-sign.mjs');
        writeFileSync(file, source.replace(from, to));
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
        assert.equal(m.signAdminRequest({ method: c1.method, path: c1.path, base: c1.base, key: c1.key, now: c1.ts * 1000, nonce: c1.nonce }).header, c1.header);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
