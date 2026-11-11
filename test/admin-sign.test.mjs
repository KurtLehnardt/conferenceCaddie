// The X-Caddie-Admin v1 request signature (scripts/lib/admin-sign.mjs) against the shared fixture
// file test/fixtures/admin-sign.v1.json, which the Worker's verifier is tested against too.
//
// Run with `npm test`. Nothing here reaches the network. Every "sign" vector is recomputed here
// from scratch, twice: with node:crypto and with WebCrypto (crypto.subtle), building the canonical
// string in this file rather than through the module, so the fixture and the module check each
// other. Every "verify" vector runs through the module's verifier and through a WebCrypto port
// written here the way the Worker's is, and every "reject" vector must throw a UsageError with
// the named code before anything would be sent.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import {
  BODYLESS_METHODS, EMPTY_BODY_SHA256, HEADER_NAME, HEADER_RE, MIN_KEY_LENGTH, NONCE_RE, PATH_RE, QUERY_RE, SKEW_SECONDS, UsageError,
  bodyMatches, canonicalString, canonicalUrl, parseAdminHeader, randomNonce, signAdminRequest, verifyAdminSignature,
} from '../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const signCases = fixture.cases.filter((c) => c.kind === 'sign');
const verifyCases = fixture.cases.filter((c) => c.kind === 'verify');
const rejectCases = fixture.cases.filter((c) => c.kind === 'reject');
const byId = Object.fromEntries(fixture.cases.map((c) => [c.id, c]));

const hex = (buf) => Buffer.from(buf).toString('hex');
// The canonical string, written out here independently of the module.
const canonical = (c) => `caddie-admin-v1\n${c.method.toUpperCase()}\n${c.path_with_query}\n${c.body_sha256}\n${c.ts}\n${c.nonce}\n`;

async function webCryptoHmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}
const webCryptoSha256Hex = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

// A WebCrypto port of verifyAdminSignature(), written the way the Worker's verifier is: the
// fixture's header_re compiled from its string (not the module's constant), bodyless check, HMAC
// with every held key, constant-time compare, then the clock.
const FIXTURE_HEADER_RE = new RegExp(fixture.header_re);
async function verifyWithWebCrypto({ headerValue, method, pathWithQuery, keys, now }) {
  const m = FIXTURE_HEADER_RE.exec(typeof headerValue === 'string' ? headerValue : '');
  if (!m) return { ok: false, reason: 'malformed' };
  const [, ts, nonce, bodySha256, sig] = m;
  if (['GET', 'HEAD', 'DELETE'].includes(method.toUpperCase()) && bodySha256 !== EMPTY_BODY_SHA256) return { ok: false, reason: 'bodyless_body_hash' };
  const usable = keys.filter((k) => typeof k === 'string' && k.trim().length >= 32);
  if (usable.length === 0) return { ok: false, reason: 'no_key' };
  const text = `caddie-admin-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n`;
  let matched = false;
  for (const key of usable) {
    const expected = Buffer.from(await webCryptoHmacHex(key, text), 'hex');
    if (crypto.timingSafeEqual(Buffer.from(sig, 'hex'), expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'signature' };
  if (Math.abs(now - Number(ts)) > 300) return { ok: false, reason: 'skew' };
  return { ok: true, reason: null, bodySha256 };
}

describe('the fixture file states the scheme the module implements', () => {
  test('constants', () => {
    assert.equal(fixture.version, 'v1');
    assert.equal(fixture.header_name, HEADER_NAME);
    assert.equal(fixture.header_re, HEADER_RE.source);
    assert.equal(fixture.query_re, QUERY_RE.source);
    assert.equal(fixture.path_re, PATH_RE.source);
    assert.ok(fixture.about.includes('Math.floor(Date.now() / 1000)'));
    assert.ok(fixture.about.includes('base is an origin'));
    assert.ok(fixture.verify_reasons._note.includes('any one of those applying reasons is acceptable'));
    // The fixture names every code the module throws, and nothing else.
    const codes = Object.keys(fixture.reject_reasons).filter((k) => !k.startsWith('_')).sort();
    assert.deepEqual(codes, ['body_on_bodyless_method', 'body_type', 'key_too_short', 'method', 'nonce', 'path_charset', 'query_charset', 'ts', 'url']);
    const source = readFileSync(new URL('../scripts/lib/admin-sign.mjs', import.meta.url), 'utf8');
    const thrown = [...new Set([...source.matchAll(/new UsageError\([\s\S]*?, '([a-z_]+)'\);/g)].map((m) => m[1]))].sort();
    assert.deepEqual(thrown, codes);
    assert.ok(rejectCases.every((c) => codes.includes(c.reject)));
    for (const code of codes) assert.ok(rejectCases.some((c) => c.reject === code), `no reject case for ${code}`);
    assert.equal(fixture.empty_body_sha256, EMPTY_BODY_SHA256);
    assert.equal(EMPTY_BODY_SHA256, crypto.createHash('sha256').update('').digest('hex'));
    assert.deepEqual(fixture.bodyless_methods, [...BODYLESS_METHODS]);
    assert.equal(fixture.skew_seconds, SKEW_SECONDS);
    assert.equal(fixture.min_key_length, MIN_KEY_LENGTH);
    assert.ok(fixture.keys.key1.length >= 32 && fixture.keys.key2.length >= 32 && fixture.keys.key1 !== fixture.keys.key2);
  });

  test('CLI-12: the required cases are present', () => {
    for (const id of ['get-stats', 'post-moderation', 'get-since-iso', 'get-q64', 'post-non-ascii', 'post-four-bytes', 'delete-empty', 'head-empty', 'post-second-key', 'post-one-byte-diff', 'post-key-trimmed', 'put-body-flag', 'get-trailing-question', 'get-fields-comma', 'reject-query-percent', 'reject-path-empty-segment', 'reject-base-with-path', 'reject-query-space', 'reject-path-non-ascii', 'reject-path-space', 'reject-path-double-slash', 'reject-path-backslash', 'v-second-key-accepted', 'v-skew-plus-301', 'v-malformed-missing', 'v-malformed-ts-leading-zero', 'v-malformed-joined-twice', 'v-malformed-bodysha-uppercase']) {
      assert.ok(byId[id], `missing case ${id}`);
    }
    assert.ok(signCases.some((c) => c.path.includes('event=')));
    assert.ok(signCases.some((c) => c.path.includes('since=2026-11-10T08:00:00Z')));
    assert.ok(signCases.some((c) => c.path.includes('q64=')));
    assert.equal(Buffer.byteLength(byId['post-four-bytes'].body, 'utf8'), 4);
    assert.ok(Buffer.byteLength(byId['post-non-ascii'].body, 'utf8') > byId['post-non-ascii'].body.length);
    const ids = fixture.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  });
});

describe('sign cases: every vector recomputed from scratch', () => {
  for (const c of signCases) {
    test(`${c.id}: ${c.title}`, async () => {
      // The header's shape.
      assert.match(c.header, HEADER_RE);
      assert.equal(c.header, `v1 ${c.ts} ${c.nonce} ${c.body_sha256} ${c.sig}`);
      assert.match(c.nonce, NONCE_RE);
      // The canonical path is new URL(path, base).pathname + search, and its query passes the charset.
      const u = new URL(c.path, c.base);
      assert.equal(c.path_with_query, u.pathname + u.search);
      assert.equal(c.url, u.href);
      assert.match(u.search.slice(1), QUERY_RE);
      assert.match(u.pathname, PATH_RE);
      assert.match(c.header, FIXTURE_HEADER_RE);
      // The body hash: the empty-body constant for GET, HEAD and DELETE, else SHA-256 of the UTF-8 bytes.
      const bytes = Buffer.from(c.body ?? '', 'utf8');
      if (['GET', 'HEAD', 'DELETE'].includes(c.method)) {
        assert.equal(c.body, null);
        assert.equal(c.body_sha256, EMPTY_BODY_SHA256);
      } else {
        assert.equal(c.body_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.equal(c.body_sha256, await webCryptoSha256Hex(bytes));
      }
      // The canonical string and the signature, with node:crypto and with WebCrypto.
      assert.equal(c.canonical, canonical(c));
      assert.equal(c.sig, crypto.createHmac('sha256', Buffer.from(c.key.trim(), 'utf8')).update(canonical(c), 'utf8').digest('hex'));
      assert.equal(c.sig, await webCryptoHmacHex(c.key, canonical(c)));
      // The module reproduces the vector exactly, and verifies it.
      const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, body: c.body, key: c.key, now: c.ts * 1000, nonce: c.nonce });
      assert.equal(r.header, c.header);
      assert.equal(r.url, c.url);
      assert.equal(r.pathWithQuery, c.path_with_query);
      assert.equal(r.bodySha256, c.body_sha256);
      assert.equal(canonicalString({ method: c.method, pathWithQuery: c.path_with_query, bodySha256: c.body_sha256, ts: c.ts, nonce: c.nonce }), c.canonical);
      const v = verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts * 1000 });
      assert.deepEqual(v, { ok: true, reason: null, bodySha256: c.body_sha256, ts: c.ts, nonce: c.nonce });
      assert.ok(bodyMatches(v.bodySha256, bytes));
      const w = await verifyWithWebCrypto({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], now: c.ts });
      assert.deepEqual(w, { ok: true, reason: null, bodySha256: c.body_sha256 });
    });
  }

  test('a one-byte body difference changes the hash and the signature only', () => {
    const a = byId['post-moderation'];
    const b = byId['post-one-byte-diff'];
    assert.equal(a.ts, b.ts);
    assert.equal(a.nonce, b.nonce);
    assert.equal(a.path_with_query, b.path_with_query);
    assert.equal(a.body.length, b.body.length);
    assert.equal([...a.body].filter((ch, i) => ch !== b.body[i]).length, 1);
    assert.notEqual(a.body_sha256, b.body_sha256);
    assert.notEqual(a.sig, b.sig);
    assert.equal(bodyMatches(a.body_sha256, Buffer.from(b.body)), false);
  });

  test('a flag in the body (allow_shrink, unretire) is covered by the hash and the signature', () => {
    const a = byId['put-conferences'];
    const b = byId['put-body-flag'];
    assert.equal(a.ts, b.ts);
    assert.equal(a.nonce, b.nonce);
    assert.equal(a.path_with_query, b.path_with_query);
    assert.ok(JSON.parse(b.body).allow_shrink === true && JSON.parse(a.body).allow_shrink === undefined);
    assert.notEqual(a.body_sha256, b.body_sha256);
    assert.notEqual(a.sig, b.sig);
    assert.equal(JSON.parse(byId['post-unretire-flag'].body).unretire, true);
    // The same flag in the query is refused outright: the charset has no room for it to hide, and
    // even allow_shrink=1 (which would pass the charset) would sit outside the body hash, so the
    // CLI and the smoke put every flag in the body.
    assert.throws(() => signAdminRequest({ method: 'PUT', path: '/admin/conferences?allow_shrink=true&x=a b', base: a.base, body: a.body, key: a.key }), (e) => e instanceof UsageError && e.code === 'query_charset');
  });

  test('SEC-7: the key is trimmed, so a padded key signs exactly as the bare key', () => {
    const bare = byId['get-stats'];
    const padded = byId['post-key-trimmed'];
    assert.notEqual(padded.key, bare.key);
    assert.equal(padded.key.trim(), bare.key);
    assert.equal(padded.header, bare.header);
    const r = signAdminRequest({ method: 'GET', path: bare.path, base: bare.base, key: `\r\n  ${bare.key} \t`, now: bare.ts * 1000, nonce: bare.nonce });
    assert.equal(r.header, bare.header);
  });

  test('the second key signs a different signature for the same request', () => {
    const c = byId['post-second-key'];
    const withKey1 = signAdminRequest({ method: c.method, path: c.path, base: c.base, body: c.body, key: fixture.keys.key1, now: c.ts * 1000, nonce: c.nonce });
    assert.notEqual(withKey1.header, c.header);
    assert.equal(withKey1.header.split(' ').slice(0, 4).join(' '), c.header.split(' ').slice(0, 4).join(' '));
  });

  test('SEC-16: GET, HEAD and DELETE always carry the empty-body hash', () => {
    for (const method of ['GET', 'HEAD', 'DELETE']) {
      const r = signAdminRequest({ method, path: '/admin/stats?event=testconf-2099', base: 'https://caddie.example', key: fixture.keys.key1 });
      assert.equal(r.bodySha256, EMPTY_BODY_SHA256);
      assert.equal(parseAdminHeader(r.header).bodySha256, EMPTY_BODY_SHA256);
      for (const body of ['{}', 'x', new Uint8Array([1])]) {
        assert.throws(() => signAdminRequest({ method, path: '/admin/stats', base: 'https://caddie.example', body, key: fixture.keys.key1 }), (e) => e instanceof UsageError && e.code === 'body_on_bodyless_method');
      }
      // An empty string is the empty body.
      assert.equal(signAdminRequest({ method, path: '/admin/stats', base: 'https://caddie.example', body: '', key: fixture.keys.key1 }).bodySha256, EMPTY_BODY_SHA256);
    }
  });

  test('a body given as bytes hashes the same as the string it encodes', () => {
    const c = byId['post-non-ascii'];
    const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, body: new TextEncoder().encode(c.body), key: c.key, now: c.ts * 1000, nonce: c.nonce });
    assert.equal(r.header, c.header);
  });

  test('a fresh signature has a fresh nonce and the current time', () => {
    const before = Math.floor(Date.now() / 1000);
    const a = signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://caddie.example', key: fixture.keys.key1 });
    const b = signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://caddie.example', key: fixture.keys.key1 });
    assert.notEqual(a.nonce, b.nonce);
    assert.ok(a.ts >= before && a.ts <= before + 2);
    assert.equal(verifyAdminSignature({ headerValue: a.header, method: 'GET', pathWithQuery: '/admin/stats', keys: [fixture.keys.key1] }).ok, true);
  });
});

describe('verify cases: the module and a WebCrypto port agree with the fixture', () => {
  for (const c of verifyCases) {
    test(`${c.id}: ${c.title}`, async () => {
      let compares = 0;
      const counting = (a, b) => {
        compares++;
        return crypto.timingSafeEqual(a, b);
      };
      const got = verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now * 1000, timingSafeEqual: counting });
      assert.equal(got.ok, c.expect.ok, JSON.stringify(got));
      if (c.expect.ok) {
        assert.equal(got.reason, null);
        assert.equal(got.bodySha256, c.expect.body_sha256);
      } else {
        assert.equal(got.reason, c.expect.reason);
        assert.equal(got.bodySha256, null);
      }
      // No HMAC runs before the header shape, the bodyless rule and the key presence are checked;
      // when it runs, every held key is compared (no early exit on the first match).
      const usable = c.keys.filter((k) => typeof k === 'string' && k.trim().length >= 32).length;
      const beforeHmac = ['malformed', 'bodyless_body_hash', 'no_key'].includes(got.reason);
      assert.equal(compares, beforeHmac ? 0 : usable);
      const web = await verifyWithWebCrypto({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now });
      assert.equal(web.ok, got.ok);
      assert.equal(web.reason, got.reason);
    });
  }

  test('the injected compare is the only comparison, and a compare that always fails rejects every good header', () => {
    const c = byId['v-ok'];
    const r = verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now * 1000, timingSafeEqual: () => false });
    assert.deepEqual(r, { ok: false, reason: 'signature', bodySha256: null });
  });

  test('skewSeconds is configurable', () => {
    const c = byId['v-skew-plus-301'];
    assert.equal(verifyAdminSignature({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, now: c.now * 1000, skewSeconds: 301 }).ok, true);
  });

  test('parseAdminHeader', () => {
    const c = byId['get-stats'];
    assert.deepEqual(parseAdminHeader(c.header), { ts: c.ts, nonce: c.nonce, bodySha256: c.body_sha256, sig: c.sig });
    for (const bad of [undefined, null, 42, '', 'v1', `${c.header}\n`, c.header.toUpperCase()]) assert.equal(parseAdminHeader(bad), null);
  });
});

describe('reject cases: the signer refuses before anything is sent', () => {
  for (const c of rejectCases) {
    test(`${c.id}: ${c.title}`, () => {
      assert.throws(
        () => signAdminRequest({ ...c.input }),
        (e) => e instanceof UsageError && e.code === c.reject && e.exitCode === 2,
      );
    });
  }

  test('SEC-14: the query charset, through canonicalUrl', () => {
    assert.equal(canonicalUrl('/admin/moderation?event=x-1&since=2026-11-10T08:00:00Z', 'https://caddie.example').pathWithQuery, '/admin/moderation?event=x-1&since=2026-11-10T08:00:00Z');
    assert.equal(canonicalUrl('/admin/people/view?event=x&ref=0123456789abcdef&fields=text,contact', 'https://caddie.example').pathWithQuery, '/admin/people/view?event=x&ref=0123456789abcdef&fields=text,contact');
    for (const q of ['q=a%20b', 'q=a b', 'q=a+b', 'q=a/b', 'q=a?b', 'q=%41', 'q=a;b', 'q=a@b', 'q=a~b', 'q="a"', "q='a'", 'q=Zoë']) {
      assert.throws(() => canonicalUrl(`/admin/people/search?event=x&${q}`, 'https://caddie.example'), (e) => e instanceof UsageError && e.code === 'query_charset', q);
    }
    // The path charset: one leading slash, nothing that the URL parser would rewrite or encode.
    for (const path of ['/admin/Zoë', '/admin/a b', '//admin/stats', '/admin//stats', '/admin/stats//', '/admin\\stats', 'admin/stats', '', 'https://caddie.example/admin/stats', '/admin/%2e%2e', '/admin/st;ats', '/admin/st@ts', '/admin/st:ats', '/admin/st~ats']) {
      assert.throws(() => canonicalUrl(path, 'https://caddie.example'), (e) => e instanceof UsageError && e.code === 'path_charset', JSON.stringify(path));
    }
    assert.throws(() => canonicalUrl('/admin/x?a=1/b', 'https://caddie.example'), (e) => e instanceof UsageError && e.code === 'query_charset');
    // The base is an origin: a path, query or fragment on it is refused rather than silently dropped.
    for (const base of ['https://caddie.example/prefix', 'https://caddie.example/?x=1', 'https://caddie.example/#f', 'not a url', '']) {
      assert.throws(() => canonicalUrl('/admin/stats', base), (e) => e instanceof UsageError && e.code === 'url', base);
    }
    assert.equal(canonicalUrl('/admin/stats', 'https://caddie.example/').pathWithQuery, '/admin/stats');
    assert.equal(canonicalUrl('/admin/stats/', 'https://caddie.example').pathWithQuery, '/admin/stats/');
    // A fragment is dropped before either check, so a bad fragment is neither sent nor refused.
    assert.equal(canonicalUrl('/admin/stats?x=1#/y z', 'https://caddie.example').pathWithQuery, '/admin/stats?x=1');
    assert.equal(canonicalUrl('/admin/people/search?event=x', 'https://caddie.example').pathWithQuery, '/admin/people/search?event=x');
    assert.equal(canonicalUrl('/admin/a_b-c.d/x', 'https://caddie.example').pathWithQuery, '/admin/a_b-c.d/x');
    // A dot segment is normalised the same way on both sides.
    assert.equal(canonicalUrl('/admin/./stats', 'https://caddie.example').pathWithQuery, '/admin/stats');
    assert.equal(canonicalUrl('/admin/stats?', 'https://caddie.example').pathWithQuery, '/admin/stats');
    // The leading-zero rule, read from the fixture's string and from the module.
    const c0 = byId['v-malformed-ts-leading-zero'];
    assert.doesNotMatch(c0.header, FIXTURE_HEADER_RE);
    assert.doesNotMatch(c0.header, HEADER_RE);
    assert.equal(parseAdminHeader(c0.header), null);
    // A fragment is not part of what is sent, so it is neither signed nor refused, and the base's
    // own query does not leak into the path.
    assert.equal(canonicalUrl('/admin/stats?event=x#frag', 'https://caddie.example').pathWithQuery, '/admin/stats?event=x');
    assert.throws(() => canonicalUrl('/admin/stats?event=x', 'https://caddie.example/?other=1'), (e) => e.code === 'url');
  });

  test('randomNonce: 22 base64url characters without padding, never repeating', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const n = randomNonce();
      assert.match(n, NONCE_RE);
      assert.equal(Buffer.from(n, 'base64url').length, 16);
      seen.add(n);
    }
    assert.equal(seen.size, 2000);
    assert.throws(() => signAdminRequest({ method: 'GET', path: '/admin/stats', base: 'https://caddie.example', key: fixture.keys.key1, nonce: 'short' }), (e) => e.code === 'nonce');
  });

  test('the signer never puts the key in the header, the URL or the canonical string', () => {
    const c = byId['post-moderation'];
    const r = signAdminRequest({ method: c.method, path: c.path, base: c.base, body: c.body, key: c.key, now: c.ts * 1000, nonce: c.nonce });
    for (const text of [r.header, r.url, r.canonical, r.pathWithQuery]) assert.ok(!text.includes(c.key.trim()));
  });
});
