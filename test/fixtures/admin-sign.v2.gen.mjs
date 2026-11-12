// Generates test/fixtures/admin-sign.v2.json, the vectors of the X-Caddie-Admin v2 request
// signature (scripts/lib/admin-sign.mjs), from scratch: the canonical strings, the hashes and the
// signatures are computed here with node:crypto, without the module, so the module and the file
// check each other. test/admin-sign-v2.test.mjs fails when the committed file differs from what
// this script builds.
//
//   node test/fixtures/admin-sign.v2.gen.mjs          writes the file
//   node test/fixtures/admin-sign.v2.gen.mjs --check  exits 1 when the file is out of date
//
// The keys are fake test values, the same two as in admin-sign.v1.json. Nothing here reaches the
// network. The output is ASCII: every non-ASCII character is written as a \u escape.

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_URL = new URL('./admin-sign.v2.json', import.meta.url);

const KEY1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const WRONG_KEY = '00000000000000000000000000000000000000000000000000000000000000ff';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TS = 1762848000;
const PROD = 'https://caddie.example';
// Another deployment (a staging Worker with its own token, or a fork): a request signed for it must
// never verify on PROD, and its origin is never listed beside PROD's.
const STAGING = 'https://caddie-staging.example';
// PROD is the Worker's custom domain; this is the same Worker's workers.dev hostname.
const WORKERS_DEV = 'https://conference-caddie.testconf.workers.dev';
const EVENT = 'testconf-2099';
const BODYLESS = ['GET', 'HEAD', 'DELETE'];
const HEADER_RE_V1_SRC = '^v1 (0|[1-9]\\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$';
const HEADER_RE_V2_SRC = '^v2 (0|[1-9]\\d{0,11}) ([A-Za-z0-9_-]{22}) ([0-9a-f]{64}) ([0-9a-f]{64})$';

const sha256Hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const hmacHex = (key, text) => createHmac('sha256', Buffer.from(key.trim(), 'utf8')).update(text, 'utf8').digest('hex');
const canonicalV1 = ({ method, pathWithQuery, bodySha256, ts, nonce }) => `caddie-admin-v1\n${method}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n`;
const canonicalV2 = ({ method, pathWithQuery, bodySha256, ts, nonce, origin }) => `caddie-admin-v2\n${method}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n${origin}\n`;
// The origin rule, written out here: trim; printable ASCII only; a literal http:// or https://
// prefix in any case; no "@" and no backslash; then an http: or https: URL with path "/" and no
// query, fragment, user name or password, whose .origin is the result.
function originOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[\x21-\x7e]+$/.test(text) || !/^https?:\/\//i.test(text) || /[@\\]/.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

// How many constant-time comparisons a verifier makes for a verify case: none when it stops before
// the HMAC (malformed or not-allowed version, bodyless rule, no usable key), else one per usable
// key for v1 and one per (usable key, distinct expected origin) pair for v2.
function expectedCompares({ header, method, keys, allowedVersions, expectedOrigins }) {
  const text = typeof header === 'string' ? header : '';
  const m1 = new RegExp(HEADER_RE_V1_SRC).exec(text);
  const m2 = new RegExp(HEADER_RE_V2_SRC).exec(text);
  const version = m1 ? 1 : m2 ? 2 : null;
  if (version === null || !allowedVersions.includes(version)) return 0;
  if (BODYLESS.includes(method) && (m1 ?? m2)[3] !== EMPTY) return 0;
  const usable = keys.filter((k) => typeof k === 'string' && k.trim().length >= 32).length;
  if (usable === 0) return 0;
  return version === 1 ? usable : usable * new Set(expectedOrigins.map(originOf)).size;
}

// A nonce of its own for each case that does not name one: 16 bytes derived from the case id.
const nonceFor = (id) => createHash('sha256').update(`admin-sign.v2 nonce ${id}`).digest().subarray(0, 16).toString('base64url');

// A v2 signature from scratch, for the origin of `base` (the verify cases also use it for
// requests signed for an origin no sign case has).
function sign2({ id, key = KEY1, method, path, base = PROD, body = null, ts = TS, nonce = nonceFor(id) }) {
  const u = new URL(path, base);
  const origin = originOf(base);
  if (origin === null) throw new Error(`the generator was given a base the origin rule refuses: ${base}`);
  const pathWithQuery = u.pathname + u.search;
  const bodySha256 = body === null ? EMPTY : sha256Hex(body);
  const fields = { method, pathWithQuery, bodySha256, ts, nonce, origin };
  const canonical = canonicalV2(fields);
  const sig = hmacHex(key, canonical);
  return { origin, url: u.href, pathWithQuery, bodySha256, ts, nonce, canonical, sig, header: `v2 ${ts} ${nonce} ${bodySha256} ${sig}` };
}

function signCase({ id, title, note, key = KEY1, keyName = 'key1', method, path, base = PROD, body = null, ts = TS, nonce = nonceFor(id), sameHeaderAs }) {
  const s = sign2({ id, key, method, path, base, body, ts, nonce });
  return {
    id,
    kind: 'sign',
    title,
    ...(note ? { note } : {}),
    key,
    key_name: keyName,
    method,
    path,
    base,
    body,
    version: 2,
    origin: s.origin,
    url: s.url,
    path_with_query: s.pathWithQuery,
    ts: s.ts,
    nonce: s.nonce,
    body_sha256: s.bodySha256,
    canonical: s.canonical,
    sig: s.sig,
    header: s.header,
    ...(sameHeaderAs ? { same_header_as: sameHeaderAs } : {}),
  };
}

const okExpect = (bodySha256, version, origin) => ({ ok: true, body_sha256: bodySha256, version, ...(origin ? { origin } : {}) });
const failExpect = (reason) => ({ ok: false, reason });

function verifyCase({ id, title, note, header, method, pathWithQuery, keys = [KEY1], allowedVersions = [1, 2], expectedOrigins = [PROD], now = TS, expect }) {
  return {
    id,
    kind: 'verify',
    title,
    ...(note ? { note } : {}),
    header,
    method,
    path_with_query: pathWithQuery,
    keys,
    allowed_versions: allowedVersions,
    ...(expectedOrigins === undefined ? {} : { expected_origins: expectedOrigins }),
    now,
    expect: { ...expect, compares: expectedCompares({ header, method, keys, allowedVersions, expectedOrigins }) },
  };
}

const rejectSign = ({ id, title, note, input, reject }) => ({
  id,
  kind: 'reject',
  title,
  ...(note ? { note } : {}),
  call: 'sign',
  input: { base: PROD, key: KEY1, body: null, method: 'GET', path: '/admin/stats', version: 2, ...input },
  reject,
});

const originCase = ({ id, title, note, input, origin, requestUrlOrigin }) => ({
  id,
  kind: 'origin',
  title,
  ...(note ? { note } : {}),
  input,
  expect: { origin },
  ...(requestUrlOrigin ? { request_url_origin: requestUrlOrigin } : {}),
});

export function buildFixture() {
  const cases = [];
  const push = (c) => {
    cases.push(c);
    return c;
  };

  // ---- sign ------------------------------------------------------------------------------
  const statsPath = `/admin/stats?event=${EVENT}`;
  const getStats = push(signCase({ id: 'get-stats', title: 'GET without a body, signed for https://caddie.example', method: 'GET', path: statsPath, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' }));
  push(signCase({ id: 'get-stats-uppercase-host', title: 'An uppercase scheme and host sign the lowercase origin: the same header as get-stats', note: 'new URL(base).origin lowercases the scheme and the host.', method: 'GET', path: statsPath, base: 'HTTPS://CADDIE.Example', nonce: getStats.nonce, sameHeaderAs: 'get-stats' }));
  push(signCase({ id: 'get-stats-default-port', title: 'The default port 443 is dropped: the same header as get-stats', method: 'GET', path: statsPath, base: 'https://caddie.example:443', nonce: getStats.nonce, sameHeaderAs: 'get-stats' }));
  push(signCase({ id: 'get-stats-trailing-slash', title: 'A base with a trailing "/" is the same origin: the same header as get-stats', method: 'GET', path: statsPath, base: 'https://caddie.example/', nonce: getStats.nonce, sameHeaderAs: 'get-stats' }));
  const staging = push(signCase({ id: 'get-stats-staging', title: 'The same request signed for another origin: only the signature differs from get-stats', method: 'GET', path: statsPath, base: STAGING, nonce: getStats.nonce }));
  const workersDev = push(signCase({ id: 'get-stats-workers-dev', title: 'The same request signed for the workers.dev hostname of the same Worker: only the signature differs from get-stats', method: 'GET', path: statsPath, base: WORKERS_DEV, nonce: getStats.nonce }));
  const port8443 = push(signCase({ id: 'get-stats-port-8443', title: 'A non-default port is part of the origin', method: 'GET', path: statsPath, base: 'https://caddie.example:8443', nonce: getStats.nonce }));
  push(signCase({ id: 'get-stats-https-port-80', title: 'Port 80 on https: is not the default port, so it stays', method: 'GET', path: statsPath, base: 'https://caddie.example:80', nonce: getStats.nonce }));
  push(signCase({ id: 'get-stats-loopback', title: 'A local Worker (wrangler dev) on http://127.0.0.1:8787', method: 'GET', path: statsPath, base: 'http://127.0.0.1:8787' }));
  const ipv6 = push(signCase({ id: 'get-stats-ipv6', title: 'An IPv6 loopback with a port', method: 'GET', path: statsPath, base: 'http://[::1]:8787' }));
  push(signCase({ id: 'get-stats-http-default-port', title: 'The default port 80 of http: is dropped', method: 'GET', path: statsPath, base: 'http://localhost:80' }));
  const puny = push(signCase({ id: 'get-stats-punycode', title: 'An internationalised host is given and signed in its punycode form', note: 'Every origin value is printable ASCII: the Unicode form "https://B\u00fccher.example" is refused (origin-refused-unicode, reject-v2-base-unicode).', method: 'GET', path: statsPath, base: 'https://xn--bcher-kva.example' }));
  push(signCase({ id: 'get-since-iso', title: 'GET with since=<ISO instant>: the v1 query charset holds under v2', method: 'GET', path: `/admin/moderation?event=${EVENT}&since=2026-11-10T08:00:00Z` }));
  const postModeration = push(signCase({ id: 'post-moderation', title: 'POST with a JSON body', method: 'POST', path: `/admin/moderation?event=${EVENT}`, body: '{"action":"unhide","kind":"profile","id":"0123456789abcdef"}', nonce: 'Jq2FZrk0Vwhoqk5B1gUwPg' }));
  const secondKey = push(signCase({ id: 'post-second-key', title: 'POST signed with the second key (ADMIN_TOKEN_NEXT during a rotation)', key: KEY2, keyName: 'key2', method: 'POST', path: `/admin/moderation?event=${EVENT}`, body: '{"action":"purge"}' }));
  push(signCase({ id: 'post-non-ascii', title: 'POST with a non-ASCII body: the hash covers the UTF-8 bytes', method: 'POST', path: `/admin/test/profile?event=${EVENT}`, body: '{"display_name":"Zo\u00eb \u0141ukasz \u65e5\u672c\u8a9e \ud83d\ude42"}' }));
  const putConferences = push(signCase({ id: 'put-conferences', title: 'PUT /admin/conferences with a JSON body', method: 'PUT', path: '/admin/conferences', body: `{"conferences":[{"slug":"${EVENT}","name":"Test Conf 2099","status":"searchable"}]}`, nonce: 'c3F2b2xnbm5tdXNrZHBxZw' }));
  const putFlag = push(signCase({ id: 'put-body-flag', title: 'The body of put-conferences with allow_shrink: the hash and the signature change', note: 'Same key, method, path, origin, ts and nonce as put-conferences; only the body differs.', method: 'PUT', path: '/admin/conferences', body: `{"conferences":[{"slug":"${EVENT}","name":"Test Conf 2099","status":"searchable"}],"allow_shrink":true}`, nonce: putConferences.nonce }));
  const deleteEmpty = push(signCase({ id: 'delete-empty', title: 'DELETE without a body: the empty-body hash', method: 'DELETE', path: `/admin/test/profile?event=${EVENT}&profile_id=Jq2FZrk0Vwhoqk5B1gUwPg` }));
  push(signCase({ id: 'head-empty', title: 'HEAD without a body: the empty-body hash', method: 'HEAD', path: '/admin/stats' }));
  push(signCase({ id: 'get-ts-small', title: 'A one-digit timestamp (the header allows 1 to 12 digits)', method: 'GET', path: statsPath, ts: 7 }));

  // ---- verify ----------------------------------------------------------------------------
  const v = (o) => push(verifyCase(o));
  const getArgs = { method: 'GET', pathWithQuery: getStats.path_with_query };
  const postArgs = { method: 'POST', pathWithQuery: postModeration.path_with_query };
  v({ id: 'v-ok', title: 'A v2 POST verifies for its origin', header: postModeration.header, ...postArgs, expect: okExpect(postModeration.body_sha256, 2, PROD) });
  v({ id: 'v-ok-get', title: 'A v2 GET verifies for its origin', header: getStats.header, ...getArgs, expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-ok-min-2', title: 'With allowed_versions [2] (ADMIN_SIG_MIN=2) a v2 header verifies', header: getStats.header, ...getArgs, allowedVersions: [2], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-second-key-accepted', title: 'The second key is accepted when both are held (rotation overlap)', header: secondKey.header, method: 'POST', pathWithQuery: secondKey.path_with_query, keys: [KEY1, KEY2], expect: okExpect(secondKey.body_sha256, 2, PROD) });
  v({ id: 'v-second-key-missing', title: 'A header signed with key2 fails when only key1 is held: signature', header: secondKey.header, method: 'POST', pathWithQuery: secondKey.path_with_query, keys: [KEY1], expect: failExpect('signature') });
  v({ id: 'v-wrong-key', title: 'A wrong key: signature', header: postModeration.header, ...postArgs, keys: [WRONG_KEY], expect: failExpect('signature') });
  v({ id: 'v-key-untrimmed', title: 'A held key with surrounding whitespace is trimmed', header: postModeration.header, ...postArgs, keys: [`\n${KEY1}  `], expect: okExpect(postModeration.body_sha256, 2, PROD) });

  // Origins.
  v({ id: 'v-wrong-origin', title: 'Signed for another origin (staging), verified by production: signature, with no reason of its own', header: staging.header, ...getArgs, expect: failExpect('signature') });
  v({ id: 'v-wrong-origin-port', title: 'Signed for https://caddie.example:8443, verified for https://caddie.example: signature', header: port8443.header, ...getArgs, expect: failExpect('signature') });
  const httpProd = sign2({ id: 'x-http', method: 'GET', path: statsPath, base: 'http://caddie.example', nonce: getStats.nonce });
  v({ id: 'v-wrong-origin-scheme', title: 'Signed for http://caddie.example, verified for https://caddie.example: signature', header: httpProd.header, ...getArgs, expect: failExpect('signature') });
  const trailingDot = sign2({ id: 'x-dot', method: 'GET', path: statsPath, base: 'https://caddie.example.', nonce: getStats.nonce });
  v({ id: 'v-wrong-origin-trailing-dot', title: 'Signed for the trailing-dot host https://caddie.example. (another origin string): signature', header: trailingDot.header, ...getArgs, expect: failExpect('signature') });
  const lookalike = sign2({ id: 'x-lookalike', method: 'POST', path: postModeration.path, base: 'https://caddie.example.evil.example', body: '{"action":"unhide","kind":"profile","id":"0123456789abcdef"}', nonce: postModeration.nonce });
  v({ id: 'v-wrong-origin-hostile', title: 'A request signed for a look-alike host and replayed to production: signature', note: 'The replay v1 cannot stop: the same request, nonce and time, signed for https://caddie.example.evil.example.', header: lookalike.header, ...postArgs, expect: failExpect('signature') });
  v({ id: 'v-origin-list-first-matches', title: 'Two origins of the same Worker, its custom domain and its workers.dev hostname (ADMIN_ORIGIN "https://caddie.example,https://conference-caddie.testconf.workers.dev"): the first matches', header: getStats.header, ...getArgs, expectedOrigins: [PROD, WORKERS_DEV], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-origin-list-second-matches', title: 'Two origins of the same Worker: the second (workers.dev) matches', header: workersDev.header, ...getArgs, expectedOrigins: [PROD, WORKERS_DEV], expect: okExpect(EMPTY, 2, WORKERS_DEV) });
  v({ id: 'v-origin-list-none-matches', title: 'Two expected origins, neither the signed one: signature', header: getStats.header, ...getArgs, expectedOrigins: [WORKERS_DEV, 'https://caddie.example:8443'], expect: failExpect('signature') });
  v({ id: 'v-first-of-four-pairs', title: 'Two held keys and two expected origins, signed with the first key for the first origin: the match is the first of four pairs, and all four are compared', note: 'expect.compares is 4: a verifier that stops at the first match, in the key loop or in the origin loop, compares fewer.', header: getStats.header, ...getArgs, keys: [KEY1, KEY2], expectedOrigins: [PROD, WORKERS_DEV], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-origin-list-duplicates', title: 'Two spellings of one origin count once', note: 'After normalisation the list is one origin, so each held key is compared once.', header: getStats.header, ...getArgs, expectedOrigins: [PROD, 'HTTPS://CADDIE.EXAMPLE:443/'], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-expected-uppercase', title: 'An expected origin written in upper case is normalised', header: getStats.header, ...getArgs, expectedOrigins: ['HTTPS://Caddie.EXAMPLE'], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-expected-default-port', title: 'An expected origin with the default port is normalised', header: getStats.header, ...getArgs, expectedOrigins: ['https://caddie.example:443'], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-expected-trailing-slash', title: 'An expected origin with a trailing "/" is normalised', header: getStats.header, ...getArgs, expectedOrigins: ['https://caddie.example/'], expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-expected-punycode', title: 'An expected punycode origin written in upper case matches the punycode the client signed', header: puny.header, ...getArgs, expectedOrigins: ['https://XN--BCHER-KVA.example'], expect: okExpect(EMPTY, 2, puny.origin) });
  v({ id: 'v-expected-ipv6-long', title: 'An expected IPv6 origin written in full matches the compressed form', header: ipv6.header, ...getArgs, expectedOrigins: ['http://[0:0:0:0:0:0:0:1]:8787'], expect: okExpect(EMPTY, 2, ipv6.origin) });

  // Versions.
  const v1Get = { canonical: canonicalV1({ method: 'GET', pathWithQuery: getStats.path_with_query, bodySha256: EMPTY, ts: TS, nonce: getStats.nonce }) };
  v1Get.sig = hmacHex(KEY1, v1Get.canonical);
  v1Get.header = `v1 ${TS} ${getStats.nonce} ${EMPTY} ${v1Get.sig}`;
  v({ id: 'v-v2-header-over-v1-canonical', title: 'A v2 header whose signature is over the v1 canonical string: signature', note: 'The signature of a valid v1 request (v-v1-ok-during-migration) with "v1" changed to "v2".', header: `v2 ${TS} ${getStats.nonce} ${EMPTY} ${v1Get.sig}`, ...getArgs, expect: failExpect('signature') });
  v({ id: 'v-v1-header-over-v2-canonical', title: 'A v1 header whose signature is over the v2 canonical string: signature', note: 'The signature of get-stats with "v2" changed to "v1".', header: `v1 ${TS} ${getStats.nonce} ${EMPTY} ${getStats.sig}`, ...getArgs, expect: failExpect('signature') });
  v({ id: 'v-v1-ok-during-migration', title: 'A valid v1 header verifies while both versions are allowed (step b)', header: v1Get.header, ...getArgs, expect: okExpect(EMPTY, 1) });
  v({ id: 'v-v1-not-origin-bound', title: 'A v1 header verifies whatever the expected origins are: v1 binds no origin, hence step d', header: v1Get.header, ...getArgs, expectedOrigins: [WORKERS_DEV], expect: okExpect(EMPTY, 1) });
  v({ id: 'v-v1-refused-min-2', title: 'A valid v1 header with allowed_versions [2] (ADMIN_SIG_MIN=2): malformed', header: v1Get.header, ...getArgs, allowedVersions: [2], expect: failExpect('malformed') });
  v({ id: 'v-v2-refused-v1-only', title: 'A valid v2 header with allowed_versions [1] (a verifier before step b): malformed', note: 'No expected origins are needed when 2 is not allowed.', header: getStats.header, ...getArgs, allowedVersions: [1], expectedOrigins: undefined, expect: failExpect('malformed') });

  // Body, keys and tampering.
  const getWithBody = sign2({ id: 'x-get-body', method: 'GET', path: statsPath, body: '{}' });
  v({ id: 'v-get-with-body-hash', title: 'A v2 GET whose header carries a non-empty body hash: refused before any HMAC', header: getWithBody.header, ...getArgs, expect: failExpect('bodyless_body_hash') });
  v({ id: 'v-delete-with-body-hash', title: 'A v2 DELETE whose header carries a non-empty body hash: refused before any HMAC', header: deleteEmpty.header.replace(EMPTY, postModeration.body_sha256), method: 'DELETE', pathWithQuery: deleteEmpty.path_with_query, expect: failExpect('bodyless_body_hash') });
  v({ id: 'v-no-key', title: 'No usable key: no_key', header: getStats.header, ...getArgs, keys: ['short', ''], expect: failExpect('no_key') });
  v({ id: 'v-tampered-path', title: 'A changed path: signature', header: getStats.header, method: 'GET', pathWithQuery: '/admin/stats?event=other-2099', expect: failExpect('signature') });
  v({ id: 'v-tampered-method', title: 'A changed method: signature', header: postModeration.header, method: 'PUT', pathWithQuery: postModeration.path_with_query, expect: failExpect('signature') });
  v({ id: 'v-tampered-nonce', title: 'A changed nonce: signature', header: postModeration.header.replace(postModeration.nonce, 'BBBBBBBBBBBBBBBBBBBBBB'), ...postArgs, expect: failExpect('signature') });
  v({ id: 'v-tampered-ts', title: 'A changed timestamp: signature', header: postModeration.header.replace(` ${TS} `, ` ${TS + 1} `), ...postArgs, expect: failExpect('signature') });
  v({ id: 'v-body-flag-accepted', title: 'The header of put-body-flag verifies and returns the hash of the body with the flag', header: putFlag.header, method: 'PUT', pathWithQuery: putFlag.path_with_query, expect: okExpect(putFlag.body_sha256, 2, PROD) });
  v({ id: 'v-body-flag-stripped', title: 'The signature of put-body-flag over the hash of the body without the flag: signature', note: 'Removing allow_shrink from a captured request changes the body hash, which the signature covers.', header: putFlag.header.replace(putFlag.body_sha256, putConferences.body_sha256), method: 'PUT', pathWithQuery: putFlag.path_with_query, expect: failExpect('signature') });

  // The clock.
  v({ id: 'v-skew-plus-300', title: 'now = ts + 300: inside the window', header: getStats.header, ...getArgs, now: TS + 300, expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-skew-plus-301', title: 'now = ts + 301: skew', header: getStats.header, ...getArgs, now: TS + 301, expect: failExpect('skew') });
  v({ id: 'v-skew-minus-300', title: 'now = ts - 300 (a client clock ahead): inside the window', header: getStats.header, ...getArgs, now: TS - 300, expect: okExpect(EMPTY, 2, PROD) });
  v({ id: 'v-skew-minus-301', title: 'now = ts - 301: skew', header: getStats.header, ...getArgs, now: TS - 301, expect: failExpect('skew') });
  v({ id: 'v-skew-after-wrong-origin', title: 'A wrong origin with a stale timestamp fails on the signature, never on the skew', header: staging.header, ...getArgs, now: TS + 100000, expect: failExpect('signature') });

  // Malformed v2 headers.
  const h = getStats.header;
  const [, , nonce, bodySha256, sig] = h.split(' ');
  const malformed = [
    ['v-malformed-missing', 'No header', null],
    ['v-malformed-empty', 'An empty header', ''],
    ['v-malformed-v3', 'Version v3', h.replace(/^v2 /, 'v3 ')],
    ['v-malformed-uppercase-version', 'Version "V2" in upper case', h.replace(/^v2 /, 'V2 ')],
    ['v-malformed-origin-field', 'The origin sent as a sixth field: the origin never travels in the header', `${h} ${PROD}`],
    ['v-malformed-nonce-21', 'A 21-character nonce', `v2 ${TS} ${nonce.slice(1)} ${bodySha256} ${sig}`],
    ['v-malformed-nonce-padded', 'A nonce with base64 padding', `v2 ${TS} ${nonce.slice(0, 20)}== ${bodySha256} ${sig}`],
    ['v-malformed-sig-63', 'A 63-character signature', `v2 ${TS} ${nonce} ${bodySha256} ${sig.slice(0, 63)}`],
    ['v-malformed-sig-uppercase', 'An uppercase hex signature', `v2 ${TS} ${nonce} ${bodySha256} ${sig.toUpperCase()}`],
    ['v-malformed-bodysha-uppercase', 'An uppercase hex body hash', `v2 ${TS} ${nonce} ${bodySha256.toUpperCase()} ${sig}`],
    ['v-malformed-ts-leading-zero', 'A timestamp with a leading zero', `v2 0${TS} ${nonce} ${bodySha256} ${sig}`],
    ['v-malformed-ts-13-digits', 'A 13-digit timestamp (milliseconds by mistake)', `v2 ${TS}000 ${nonce} ${bodySha256} ${sig}`],
    ['v-malformed-ts-negative', 'A negative timestamp', `v2 -${TS} ${nonce} ${bodySha256} ${sig}`],
    ['v-malformed-double-space', 'Two spaces between fields', h.replace(/^v2 /, 'v2  ')],
    ['v-malformed-leading-space', 'A leading space', ` ${h}`],
    ['v-malformed-trailing-newline', 'A trailing newline', `${h}\n`],
    ['v-malformed-joined-twice', 'The header value sent twice and joined by the HTTP layer ("<h>, <h>")', `${h}, ${h}`],
    ['v-malformed-joined-v1-v2', 'A v1 and a v2 value joined by the HTTP layer', `${v1Get.header}, ${h}`],
  ];
  for (const [id, title, header] of malformed) v({ id, title: `${title}: malformed`, header, ...getArgs, expect: failExpect('malformed') });

  // ---- reject: the signer ------------------------------------------------------------------
  const r = (o) => push(rejectSign(o));
  r({ id: 'reject-version-3', title: 'Version 3', input: { version: 3 }, reject: 'version' });
  r({ id: 'reject-version-string', title: 'Version "2" as a string: the version is the number 1 or 2', input: { version: '2' }, reject: 'version' });
  r({ id: 'reject-version-null', title: 'Version null (only an absent version means the default)', input: { version: null }, reject: 'version' });
  r({ id: 'reject-v2-base-file', title: 'A file: base has the opaque origin "null"', input: { base: 'file:///' }, reject: 'url' });
  r({ id: 'reject-v2-base-ftp', title: 'A base that is neither http: nor https:', input: { base: 'ftp://caddie.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-credentials', title: 'A base with a user name and password', input: { base: 'https://user:secret@caddie.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-unicode', title: 'An internationalised host in its Unicode form: give its punycode form', input: { base: 'https://B\u00fccher.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-tab', title: 'A tab inside the base, which the URL parser would strip', input: { base: 'https://cad\tdie.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-fullwidth', title: 'Full-width letters, which the URL parser would map to ASCII', input: { base: 'https://\uff43\uff41\uff44\uff44\uff49\uff45.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-no-slashes', title: 'https:host without the two slashes', input: { base: 'https:caddie.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-backslash', title: 'A backslash, which the URL parser reads as "/"', input: { base: 'https://caddie.example\\' }, reject: 'url' });
  r({ id: 'reject-v2-base-empty-userinfo', title: 'An empty userinfo ("@" before the host)', input: { base: 'https://@caddie.example' }, reject: 'url' });
  r({ id: 'reject-v2-base-with-path', title: 'A base with a path (as in v1)', input: { base: 'https://caddie.example/prefix' }, reject: 'url' });
  r({ id: 'reject-v2-base-not-url', title: 'A base that is not a URL (as in v1)', input: { base: 'caddie.example' }, reject: 'url' });
  r({ id: 'reject-v2-path-double-slash', title: 'A path starting with "//" (as in v1)', input: { path: '//admin/stats' }, reject: 'path_charset' });
  r({ id: 'reject-v2-query-percent', title: 'q=a%20b in the query (as in v1)', input: { path: `/admin/people/search?event=${EVENT}&q=a%20b` }, reject: 'query_charset' });
  r({ id: 'reject-v2-get-with-body', title: 'A GET with a body (as in v1)', input: { body: '{}' }, reject: 'body_on_bodyless_method' });
  r({ id: 'reject-v2-key-short', title: 'A key shorter than 32 characters (as in v1)', input: { key: 'too-short' }, reject: 'key_too_short' });
  r({ id: 'reject-v2-body-object', title: 'An unserialised object as the body (as in v1)', input: { method: 'POST', path: '/admin/conferences', body: { conferences: [] } }, reject: 'body_type' });
  r({ id: 'reject-v2-no-method', title: 'No method (as in v1)', input: { method: '' }, reject: 'method' });
  r({ id: 'reject-v2-nonce-bad', title: 'A nonce that is not 22 base64url characters (tests only, as in v1)', input: { nonce: 'short' }, reject: 'nonce' });
  r({ id: 'reject-v2-ts-bad', title: 'A signing time out of range (tests only, as in v1)', note: 'now is milliseconds here, as Date.now() gives it.', input: { now: -1000 }, reject: 'ts' });

  // ---- reject: the verifier's own settings -------------------------------------------------
  const rv = ({ id, title, note, nodeApiOnly = false, allowedVersions = [1, 2], expectedOrigins, reject }) => push({
    id,
    kind: 'reject',
    title,
    ...(note ? { note } : {}),
    call: 'verify',
    node_api_only: nodeApiOnly,
    input: {
      header: getStats.header,
      method: 'GET',
      path_with_query: getStats.path_with_query,
      keys: [KEY1],
      now: TS,
      allowed_versions: allowedVersions,
      ...(expectedOrigins === undefined ? {} : { expected_origins: expectedOrigins }),
    },
    reject,
  });
  const unset = 'A Worker has no equivalent: with ADMIN_ORIGIN unset or empty it expects new URL(request.url).origin (worker_admin_origin).';
  rv({ id: 'reject-verify-origins-missing', title: 'Node API only: v2 allowed and no expectedOrigins', note: unset, nodeApiOnly: true, reject: 'expected_origins' });
  rv({ id: 'reject-verify-origins-empty', title: 'Node API only: v2 allowed and an empty expectedOrigins list', note: unset, nodeApiOnly: true, expectedOrigins: [], reject: 'expected_origins' });
  rv({ id: 'reject-verify-origins-min-2-empty', title: 'Node API only: only v2 allowed and an empty expectedOrigins list', note: unset, nodeApiOnly: true, allowedVersions: [2], expectedOrigins: [], reject: 'expected_origins' });
  rv({ id: 'reject-verify-origins-not-list', title: 'Node API only: expectedOrigins as one string rather than a list', note: 'The Worker reads ADMIN_ORIGIN as a string and splits it on ",".', nodeApiOnly: true, expectedOrigins: PROD, reject: 'expected_origins' });
  const entry = (id, title, value) => rv({ id, title: `${title}: the whole list is refused`, note: 'On the Worker, ADMIN_ORIGIN set with this entry is invalid configuration: 404 for every admin request, v1 included, with no failed-auth charge.', expectedOrigins: [PROD, value], reject: 'expected_origins' });
  entry('reject-verify-origins-empty-entry', 'An empty entry (ADMIN_ORIGIN with a trailing comma)', '');
  entry('reject-verify-origins-no-scheme', 'An entry without a scheme', 'caddie.example');
  entry('reject-verify-origins-path', 'An entry with a path', 'https://caddie.example/admin');
  entry('reject-verify-origins-query', 'An entry with a query', 'https://caddie.example/?x=1');
  entry('reject-verify-origins-ftp', 'An entry that is neither http: nor https:', 'ftp://caddie.example');
  entry('reject-verify-origins-file', 'A file: entry, whose origin is the opaque "null"', 'file:///');
  entry('reject-verify-origins-null', 'The entry "null"', 'null');
  entry('reject-verify-origins-credentials', 'An entry with a user name and password', 'https://user:secret@caddie.example');
  entry('reject-verify-origins-empty-userinfo', 'An entry with an empty userinfo', 'https://@caddie.example');
  entry('reject-verify-origins-tab', 'An entry with a tab inside', 'https://cad\tdie.example');
  entry('reject-verify-origins-newline', 'An entry with a newline inside', 'https://caddie.example\n.evil.example');
  entry('reject-verify-origins-fullwidth', 'An entry in full-width letters', 'https://\uff43\uff41\uff44\uff44\uff49\uff45.example');
  entry('reject-verify-origins-unicode', 'An internationalised entry in its Unicode form', 'https://B\u00fccher.example');
  entry('reject-verify-origins-no-slashes', 'An entry written https:host', 'https:caddie.example');
  entry('reject-verify-origins-backslash', 'An entry with backslashes for slashes', 'https:\\\\caddie.example');
  const sigMin = 'A Worker has no list of versions: its equivalent is an ADMIN_SIG_MIN other than unset, "1" or "2" (worker_admin_sig_min).';
  rv({ id: 'reject-verify-versions-empty', title: 'Node API only: no allowed version', note: sigMin, nodeApiOnly: true, allowedVersions: [], expectedOrigins: [PROD], reject: 'version' });
  rv({ id: 'reject-verify-versions-3', title: 'Node API only: an unknown version in the list', note: sigMin, nodeApiOnly: true, allowedVersions: [1, 3], expectedOrigins: [PROD], reject: 'version' });
  rv({ id: 'reject-verify-versions-string', title: 'Node API only: a version as a string', note: sigMin, nodeApiOnly: true, allowedVersions: ['2'], expectedOrigins: [PROD], reject: 'version' });
  rv({ id: 'reject-verify-versions-not-list', title: 'Node API only: the allowed versions as a number rather than a list', note: sigMin, nodeApiOnly: true, allowedVersions: 2, expectedOrigins: [PROD], reject: 'version' });

  // ---- origin --------------------------------------------------------------------------------
  const o = (id, title, input, origin, extra = {}) => push(originCase({ id, title, input, origin, ...extra }));
  o('origin-plain', 'A bare https: origin is itself', PROD, PROD);
  o('origin-uppercase', 'The scheme and the host are lowercased', 'HTTPS://Caddie.EXAMPLE', PROD);
  o('origin-default-port-https', 'Port 443 on https: is dropped', 'https://caddie.example:443', PROD);
  o('origin-default-port-http', 'Port 80 on http: is dropped', 'http://caddie.example:80', 'http://caddie.example');
  o('origin-other-port', 'Port 80 on https: stays', 'https://caddie.example:80', 'https://caddie.example:80');
  o('origin-trailing-slash', 'A trailing "/" is not a path', 'https://caddie.example/', PROD);
  o('origin-empty-query-fragment', 'An empty "?" and "#" leave nothing', 'https://caddie.example/?#', PROD);
  o('origin-surrounding-spaces', 'Surrounding whitespace is trimmed first (String.prototype.trim)', ' https://caddie.example ', PROD);
  o('origin-surrounding-tab-newline', 'A surrounding tab and newline are trimmed too', '\thttps://caddie.example\n', PROD);
  o('origin-workers-dev', 'A workers.dev hostname', WORKERS_DEV, WORKERS_DEV);
  o('origin-loopback', 'A loopback with a port', 'http://127.0.0.1:8787', 'http://127.0.0.1:8787');
  o('origin-ipv4-hex', 'A hexadecimal IPv4 part is normalised', 'https://0x7f.0.0.1', 'https://127.0.0.1');
  o('origin-ipv6-long', 'An IPv6 address is compressed', 'http://[0:0:0:0:0:0:0:1]:8787', 'http://[::1]:8787');
  o('origin-punycode', 'A punycode host is kept as it is', 'https://xn--bcher-kva.example', 'https://xn--bcher-kva.example');
  o('origin-punycode-uppercase', 'A punycode host in upper case is lowercased', 'https://XN--BCHER-KVA.example', 'https://xn--bcher-kva.example');
  o('origin-trailing-dot', 'A trailing dot stays: it is another origin string', 'https://caddie.example.', 'https://caddie.example.');
  o('origin-refused-empty', 'An empty string', '', null);
  o('origin-refused-whitespace', 'Whitespace only', ' \t ', null);
  o('origin-refused-no-scheme', 'No scheme', 'caddie.example', null);
  o('origin-refused-no-slashes', 'https:host without the two slashes (the URL parser would accept it)', 'https:caddie.example', null);
  o('origin-refused-no-slashes-uppercase', 'HTTPS:host without the two slashes', 'HTTPS:caddie.example', null);
  o('origin-refused-backslash-scheme', 'Backslashes for the two slashes (the URL parser would read them as "/")', 'https:\\\\caddie.example', null);
  o('origin-refused-backslash-end', 'A trailing backslash (the URL parser would read it as the path "/")', 'https://caddie.example\\', null);
  o('origin-refused-empty-userinfo', 'An empty userinfo (the URL parser would drop it)', 'https://@caddie.example', null);
  o('origin-refused-credentials', 'A user name and password', 'https://user:secret@caddie.example', null);
  o('origin-refused-tab', 'A tab inside (the URL parser would strip it)', 'https://cad\tdie.example', null);
  o('origin-refused-newline', 'A newline inside (the URL parser would strip it and read caddie.example.evil.example)', 'https://caddie.example\n.evil.example', null);
  o('origin-refused-fullwidth', 'Full-width letters (the URL parser would map them to "caddie")', 'https://\uff43\uff41\uff44\uff44\uff49\uff45.example', null);
  o('origin-refused-unicode', 'An internationalised host in its Unicode form: write its punycode form', 'https://B\u00fccher.example', null);
  o('origin-refused-nbsp-inside', 'A no-break space inside', 'https://caddie\u00a0.example', null);
  o('origin-refused-path', 'A path', 'https://caddie.example/admin', null);
  o('origin-refused-query', 'A query', 'https://caddie.example/?x=1', null);
  o('origin-refused-fragment', 'A fragment', 'https://caddie.example/#top', null);
  o('origin-refused-ftp', 'Neither http: nor https:', 'ftp://caddie.example', null);
  o('origin-refused-wss', 'wss: is not an origin the Worker serves admin requests on', 'wss://caddie.example', null);
  o('origin-refused-file', 'file: has the opaque origin "null"', 'file:///', null);
  o('origin-refused-null', 'The string "null"', 'null', null);
  o('origin-refused-request-url', 'A request URL with a path is not an origin value', `${PROD}${statsPath}`, null, {
    note: 'canonicalOrigin(request.url) is null for any request with a path. A Worker whose ADMIN_ORIGIN is unset or empty takes new URL(request.url).origin instead, given here as request_url_origin, without canonicalOrigin.',
    requestUrlOrigin: PROD,
  });

  return {
    about: [
      'Test vectors for the X-Caddie-Admin v2 request signature (scripts/lib/admin-sign.mjs), which binds a signed admin request to the origin it is sent to, so a request that reaches another host cannot be replayed to the Worker.',
      'Generated by test/fixtures/admin-sign.v2.gen.mjs, never edited by hand: npm test fails when this file and the generator disagree.',
      'Everything test/fixtures/admin-sign.v1.json says holds for v2 unless stated here: the keys (UTF-8 after trimming, never hex-decoded, at least 32 characters), the path and query charsets, the body hash and the bodyless methods, the clock (`now` is Math.floor(Date.now() / 1000); all times are Unix seconds), and the order of the checks.',
      'Header: "v2 <ts> <nonce> <bodySha256> <sig>", single spaces, matching header_re: the v1 field grammar with "v2" in front (ts has no leading zero, nonce is 22 base64url characters, bodySha256 and sig are lowercase hex).',
      'Canonical string, UTF-8, exactly seven lines, each followed by one "\\n" (LF, so the string ends with "\\n"; no other separator, no "\\r"): line 1 "caddie-admin-v2"; line 2 the method in upper case; line 3 new URL(path, base).pathname + search; line 4 bodySha256 as in the header; line 5 ts as in the header; line 6 nonce; line 7 the origin. That is canonical_format. sig is the lowercase hex HMAC-SHA256 of it. v1 has the same layout with "caddie-admin-v1" on line 1 and no line 7, so no v1 string equals a v2 string.',
      'The origin is not in the header. The client signs the origin of its base; the verifier holds a list of expected origins, normalises each the same way, drops duplicates and tries every (key, origin) pair, running every comparison. A signature made for an origin outside the list fails as "signature", with no reason of its own (Worker: 404).',
      'Origin values are read strictly by both sides (origin_rule, the "origin" cases): after trimming, printable ASCII only, a literal http:// or https:// prefix in any case, no "@" and no backslash, then new URL(x) must be an http: or https: URL with path "/" or none and no query, fragment, user name or password, and the value is new URL(x).origin (lowercase scheme and host, the default port dropped). An internationalised host is written in its punycode form; its Unicode form is refused.',
      'On the Worker (worker_admin_origin, worker_admin_sig_min): ADMIN_ORIGIN, when set, is the comma list of expected origins; when it is unset or empty, the expected origin is new URL(request.url).origin. Only a set ADMIN_ORIGIN with a refused entry, or an ADMIN_SIG_MIN other than unset, "1" or "2", is invalid configuration, which answers 404 to every admin request, v1 included, with no failed-auth charge.',
      'Four kinds of case. "sign": signer input with version 2 and the exact origin, canonical string and header it must produce; same_header_as names a case whose header must be identical. "verify": what the verifier answers for a header given the keys it holds, its allowed_versions, its expected_origins (absent means none were given) and its clock; expect.version is the header\'s version, expect.origin the expected origin that matched (v2 only), and expect.compares the number of constant-time comparisons made (no early exit). "reject": input refused before anything is sent or checked; call "sign" is signAdminRequest(input), call "verify" is verifyAdminSignature() refusing its own settings whatever the header. A reject case with node_api_only true has no Worker equivalent (see its note); the others are a set ADMIN_ORIGIN holding a refused entry. "origin": the normalisation of one value; origin null means refused.',
    ].join(' '),
    version: 'v2',
    header_name: 'X-Caddie-Admin',
    header_format: 'v2 <ts> <nonce> <bodySha256> <sig>',
    header_re: HEADER_RE_V2_SRC,
    canonical_format: 'caddie-admin-v2\\n<METHOD>\\n<pathname + search>\\n<bodySha256>\\n<ts>\\n<nonce>\\n<origin>\\n',
    v1_header_re: HEADER_RE_V1_SRC,
    v1_canonical_format: 'caddie-admin-v1\\n<METHOD>\\n<pathname + search>\\n<bodySha256>\\n<ts>\\n<nonce>\\n',
    origin_rule: 'x is a string; t = x.trim() (String.prototype.trim); t matches ^[\\x21-\\x7e]+$ (printable ASCII) and ^https?:// (case-insensitive) and holds no "@" and no "\\"; new URL(t) has protocol http: or https:, pathname "/", and empty search, hash, username and password; the result is new URL(t).origin. Anything else is refused.',
    worker_admin_origin: 'ADMIN_ORIGIN set (non-empty after trimming): split on ",", apply origin_rule to each entry, drop duplicates; any refused entry, including the empty one a trailing comma leaves, is invalid configuration (404 for every admin request, v1 included, no failed-auth charge). ADMIN_ORIGIN unset or empty: the expected origins are [new URL(request.url).origin], computed without origin_rule. List only hostnames that route to this Worker, never another deployment\'s origin.',
    worker_admin_sig_min: 'ADMIN_SIG_MIN unset or "1": allowed_versions [1, 2]. "2": allowed_versions [2]. Any other value is invalid configuration (404 for every admin request, no failed-auth charge).',
    origin_protocols: ['http:', 'https:'],
    query_re: '^[A-Za-z0-9_.:=&,-]*$',
    path_re: '^\\/(?:[A-Za-z0-9_.-]+\\/)*[A-Za-z0-9_.-]*$',
    empty_body_sha256: EMPTY,
    bodyless_methods: BODYLESS,
    skew_seconds: 300,
    min_key_length: 32,
    keys: { key1: KEY1, key2: KEY2 },
    origins: { custom_domain: PROD, workers_dev: WORKERS_DEV, other_deployment: STAGING },
    default_sign_version: 1,
    default_allowed_versions: [1],
    verify_reasons: {
      _note: 'The reference verifier first checks its own settings (see the reject cases with call "verify"), then the header in this order: malformed, bodyless_body_hash, no_key, signature, skew, and reports the first that applies. A verifier may check no_key before malformed (the Worker does). When several reasons apply, any one of those applying reasons is acceptable; all map to 404, except skew, which is 401 admin_skew and can only follow a valid signature.',
      malformed: 'the header is absent, matches neither header_re nor v1_header_re, or is of a version not in allowed_versions (Worker: 404)',
      bodyless_body_hash: 'GET, HEAD or DELETE with a bodySha256 other than empty_body_sha256 (Worker: 404)',
      no_key: 'the verifier holds no usable key (Worker: 404)',
      signature: 'no held key reproduces sig: for v1 over the v1 canonical string, for v2 over the v2 canonical string with any expected origin; a wrong origin is this reason (Worker: take() the failed-auth bucket, 404)',
      skew: '|now - ts| > skew_seconds, checked only after the signature matched (Worker: 401 admin_skew)',
    },
    reject_reasons: {
      _note: 'Each reject case names the UsageError.code thrown: by signAdminRequest(input) for call "sign", by verifyAdminSignature() for call "verify". Together with admin-sign.v1.json these are all the codes the module has.',
      version: 'sign: version is neither the number 1 nor the number 2; verify (Node API only): allowed_versions is not a non-empty list of the numbers 1 and 2',
      expected_origins: 'verify: 2 is allowed and expected_origins is missing, not a list or empty (Node API only), or holds an entry origin_rule refuses (fail closed: one bad entry refuses the list; on the Worker, a set ADMIN_ORIGIN with such an entry)',
      url: 'sign: the base is not a URL or not an origin (as in v1), and for v2 also a base that origin_rule refuses (not printable ASCII, no literal http:// or https://, an "@" or a backslash, another scheme, credentials) or that is not a string',
      path_charset: 'sign: as in v1',
      query_charset: 'sign: as in v1',
      body_on_bodyless_method: 'sign: as in v1',
      key_too_short: 'sign: as in v1',
      body_type: 'sign: as in v1',
      method: 'sign: as in v1',
      nonce: 'sign: as in v1',
      ts: 'sign: as in v1',
    },
    cases,
  };
}

// JSON with two-space indentation and a final newline, every non-ASCII character escaped, as in
// admin-sign.v1.json.
export function serialise(fixture) {
  return `${JSON.stringify(fixture, null, 2).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = serialise(buildFixture());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(FIXTURE_URL, 'utf8');
    } catch {}
    if (current !== text) {
      process.stderr.write('test/fixtures/admin-sign.v2.json is out of date: run node test/fixtures/admin-sign.v2.gen.mjs\n');
      process.exit(1);
    }
  } else {
    writeFileSync(FIXTURE_URL, text);
  }
}
