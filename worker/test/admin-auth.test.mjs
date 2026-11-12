// The Worker's check of signed admin requests (W1) and its failed-auth limit (W4).
//
// First the verifier in src/lib/admin-auth.js against every "sign" and "verify" case of the shared
// fixture file test/fixtures/admin-sign.v1.json, which the signer (scripts/lib/admin-sign.mjs) is
// tested against too. Then the Worker's fetch handler, with stand-ins for both Durable Object
// namespaces that record what they receive: the nine steps in their order, which steps read the
// body (through a stand-in that records every access to it), what reaches the object, the second
// key of a rotation, and the failed-auth bucket, counting the HMACs the Worker computes. Nothing
// here reaches the network, and the keys are the fixture's fake ones.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { skip, worker, adminRoutes, namespace, withClock } from './helpers/harness.mjs';
import {
  BODYLESS_METHODS, EMPTY_BODY_SHA256, HEADER_RE, MIN_KEY_LENGTH, SKEW_SECONDS, bodyMatches, canonicalString, parseAdminHeader, verifyAdminHeader,
} from '../src/lib/admin-auth.js';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const signCases = fixture.cases.filter((c) => c.kind === 'sign');
const verifyCases = fixture.cases.filter((c) => c.kind === 'verify');
const KEY = fixture.keys.key1;
const KEY2 = fixture.keys.key2;
const BASE = 'https://caddie.example';
const SLUG = 'caddie-fixture-2099';
const OTHER = 'other-fixture-2099';

// ---------------------------------------------------------------------------------------------
// The verifier against the fixture.

const FIXTURE_RE = new RegExp(fixture.header_re);
const usableKeys = (keys) => keys.filter((k) => typeof k === 'string' && k.trim().length >= fixture.min_key_length);

// Whether a reason applies to a verify case, computed here from the fixture alone (node:crypto,
// the fixture's regular expression and constants), so a verifier that reports another reason than
// the case names is accepted only when that reason applies too.
function applies(reason, c) {
  const m = FIXTURE_RE.exec(c.header ?? '');
  const method = c.method.toUpperCase();
  switch (reason) {
    case 'malformed':
      return !m;
    case 'no_key':
      return usableKeys(c.keys).length === 0;
    case 'bodyless_body_hash':
      return Boolean(m) && fixture.bodyless_methods.includes(method) && m[3] !== fixture.empty_body_sha256;
    case 'signature': {
      if (!m || usableKeys(c.keys).length === 0) return false;
      const text = `caddie-admin-v1\n${method}\n${c.path_with_query}\n${m[3]}\n${m[1]}\n${m[2]}\n`;
      return !usableKeys(c.keys).some((k) => createHmac('sha256', k.trim()).update(text).digest('hex') === m[4]);
    }
    // Only after a valid signature: a stale request with a wrong key is a signature failure.
    case 'skew':
      return Boolean(m) && usableKeys(c.keys).length > 0 && !applies('signature', c) && Math.abs(c.now - Number(m[1])) > fixture.skew_seconds;
    default:
      return false;
  }
}

describe('the verifier against test/fixtures/admin-sign.v1.json', () => {
  test('its constants are the fixture\'s', () => {
    assert.equal(HEADER_RE.source, fixture.header_re);
    assert.equal(EMPTY_BODY_SHA256, fixture.empty_body_sha256);
    assert.equal(EMPTY_BODY_SHA256, createHash('sha256').update('').digest('hex'));
    assert.deepEqual([...BODYLESS_METHODS], fixture.bodyless_methods);
    assert.equal(SKEW_SECONDS, fixture.skew_seconds);
    assert.equal(MIN_KEY_LENGTH, fixture.min_key_length);
    // The fixture belongs to the signer's side and may grow; every case runs below.
    assert.ok(signCases.length >= 19, `${signCases.length} sign cases`);
    assert.ok(verifyCases.length >= 36, `${verifyCases.length} verify cases`);
  });

  for (const c of signCases) {
    test(`sign ${c.id}: the header is accepted for its method and path with now = ts`, async () => {
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], nowMs: c.ts * 1000, timingSafeEqual: nodeTimingSafeEqual, allowedVersions: [1] });
      assert.equal(v.ok, true, v.reason);
      assert.equal(v.header.bodySha256, c.body_sha256);
      assert.equal(v.header.ts, String(c.ts));
      assert.equal(v.header.nonce, c.nonce);
      assert.equal(canonicalString(c.method, c.path_with_query, parseAdminHeader(c.header)), c.canonical);
      const body = c.body === null ? new Uint8Array(0) : new TextEncoder().encode(c.body);
      assert.equal(await bodyMatches(v.header.bodySha256, body, nodeTimingSafeEqual), true);
      assert.equal(await bodyMatches(v.header.bodySha256, new TextEncoder().encode(`${c.body ?? ''} `), nodeTimingSafeEqual), false);
    });
  }

  for (const c of verifyCases) {
    test(`verify ${c.id}: ${c.expect.ok ? 'ok' : c.expect.reason}`, async () => {
      assert.ok(c.expect.ok || applies(c.expect.reason, c), `the fixture's own reason must apply (${c.expect.reason})`);
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, nowMs: c.now * 1000, timingSafeEqual: nodeTimingSafeEqual, allowedVersions: [1] });
      if (c.expect.ok) {
        assert.equal(v.ok, true, v.reason);
        assert.equal(v.header.bodySha256, c.expect.body_sha256);
      } else {
        assert.equal(v.ok, false);
        assert.ok(v.reason === c.expect.reason || applies(v.reason, c), `reason ${v.reason}, expected ${c.expect.reason}`);
      }
    });
  }

  test('the timestamp is used as the header carries it, and a refused pre-check computes nothing', async () => {
    const c = signCases[0];
    let calls = 0;
    const v = await verifyAdminHeader({
      headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], nowMs: c.ts * 1000,
      timingSafeEqual: (a, b) => {
        calls += 1;
        return nodeTimingSafeEqual(a, b);
      },
      mayTry: () => false,
      allowedVersions: [1],
    });
    assert.deepEqual([v.ok, v.reason, calls], [false, 'limited', 0]);
    // ts arrives as a string and is never re-formatted: an equal number spelled otherwise is malformed.
    assert.equal(parseAdminHeader(c.header.replace(` ${c.ts} `, ` 0${c.ts} `)), null);
    assert.equal(parseAdminHeader(c.header.replace(` ${c.ts} `, ` ${c.ts}.0 `)), null);
  });
});

// ---------------------------------------------------------------------------------------------
// The Worker's fetch handler, with stand-ins for the Durable Objects.

// Every HMAC the Worker computes goes through crypto.subtle.sign (the signer used here is
// node:crypto's createHmac, so it is not counted), and every compare through
// crypto.subtle.timingSafeEqual.
const counts = { hmac: 0, compare: 0 };
let restoreCrypto = null;
before(() => {
  const sign = crypto.subtle.sign;
  const compare = crypto.subtle.timingSafeEqual;
  crypto.subtle.sign = function countingSign(alg, key, data) {
    if ((alg?.name ?? alg) === 'HMAC') counts.hmac += 1;
    return sign.call(crypto.subtle, alg, key, data);
  };
  crypto.subtle.timingSafeEqual = function countingCompare(a, b) {
    counts.compare += 1;
    return compare.call(crypto.subtle, a, b);
  };
  restoreCrypto = () => {
    crypto.subtle.sign = sign;
    crypto.subtle.timingSafeEqual = compare;
  };
});
after(() => restoreCrypto?.());

// Durable Object stand-ins that record the method, path, headers and body bytes they receive. The
// directory knows SLUG and OTHER, so the Worker forwards admin requests for them.
function stubEnv(vars = { ADMIN_TOKEN: KEY }) {
  const received = [];
  const record = async (name, req) => {
    const u = new URL(req.url);
    received.push({ name, method: req.method, path: u.pathname, search: u.search, headers: Object.fromEntries(req.headers), body: new Uint8Array(await req.arrayBuffer()) });
  };
  const DIRECTORY = namespace((name) => ({
    async fetch(req) {
      if (new URL(req.url).pathname === '/internal/routes') {
        return Response.json({ conferences: [SLUG, OTHER].map((slug) => ({ slug, status: 'searchable', route_prefix: slug.slice(0, 6), has_object: true })) });
      }
      await record(`directory:${name}`, req);
      return Response.json({ upserted: 0, searchable: [] });
    },
  }));
  const CONFERENCE = namespace((name) => ({
    async fetch(req) {
      await record(`conference:${name}`, req);
      return Response.json({ ok: true });
    },
  }));
  return { env: { ...vars, DIRECTORY, CONFERENCE }, received };
}

let ipSeq = 0;
const freshIp = () => `2001:db8::${(++ipSeq).toString(16)}`;

// A request signed with signAdminRequest, version 1 (this file is the v1 suite; v2 is in
// admin-auth-v2.test.mjs). `send` replaces the body that is sent (the signed one by default) and
// `headers` adds or overrides headers.
function signedRequest(method, path, { body, key = KEY, now, nonce, ip = freshIp(), headers = {}, send } = {}) {
  const s = signAdminRequest({ method, path, base: BASE, body, key, now, nonce, version: 1 });
  const h = new Headers({ 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': ip });
  const payload = send !== undefined ? send : body;
  if (payload !== undefined && payload !== null) h.set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { req: new Request(s.url, { method, headers: h, body: payload ?? undefined }), signed: s };
}

// A header signed by hand, for what the signer refuses to make (a body hash on a bodyless method).
function handHeader({ method, pathWithQuery, bodySha256, ts = Math.floor(Date.now() / 1000), nonce = 'Q'.repeat(22), key = KEY }) {
  const sig = createHmac('sha256', key).update(`caddie-admin-v1\n${method}\n${pathWithQuery}\n${bodySha256}\n${ts}\n${nonce}\n`).digest('hex');
  return `v1 ${ts} ${nonce} ${bodySha256} ${sig}`;
}

// The request behind a proxy that records every access to its body.
const BODY_READERS = new Set(['body', 'bodyUsed', 'text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes', 'clone']);
function tracked(req) {
  const reads = [];
  const proxy = new Proxy(req, {
    get(target, prop) {
      if (BODY_READERS.has(prop)) reads.push(prop);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { proxy, reads };
}

// Calls the Worker with its one-line request log silenced. Returns the status, the parsed JSON
// body, which body readers the Worker touched, and how many HMACs and compares it computed.
async function call(env, req) {
  const { proxy, reads } = tracked(req);
  const before = { ...counts };
  const log = console.log;
  console.log = () => {};
  let res;
  try {
    res = await worker.fetch(proxy, env);
  } finally {
    console.log = log;
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json, reads, hmac: counts.hmac - before.hmac, compare: counts.compare - before.compare };
}

const BODY = JSON.stringify({ generation: 1, talks: [] });
const NOT_FOUND = { error: 'Not found' };

describe('the Worker\'s admin check, step by step', { skip }, () => {
  test('every /admin/* route goes through it: unsigned or bearer requests get 404 and reach no object', async () => {
    // The /admin/test/* fixtures are served only with ADMIN_TEST_ROUTES="1" (admin-test-routes.test.mjs).
    const { env, received } = stubEnv({ ADMIN_TOKEN: KEY, ADMIN_TEST_ROUTES: '1' });
    const routes = [...adminRoutes.map((r) => [r.method, r.path]), ['PUT', '/admin/conferences'], ['GET', '/admin/no-such-route'], ['POST', '/admin/x']];
    assert.ok(routes.some(([m, p]) => m === 'POST' && p === '/admin/test/profile'), 'the /admin/test/* fixtures are among them');
    for (const [method, path] of routes) {
      const url = `${BASE}${path}?event=${SLUG}`;
      const body = method === 'GET' || method === 'DELETE' ? undefined : '{}';
      for (const headers of [{}, { Authorization: `Bearer ${KEY}` }, { Authorization: `Bearer ${KEY}`, 'X-Caddie-Admin': `Bearer ${KEY}` }]) {
        const r = await call(env, new Request(url, { method, headers: { ...headers, 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIp() }, body }));
        assert.equal(r.status, 404, `${method} ${path}`);
        assert.deepEqual(r.json, NOT_FOUND);
        assert.deepEqual(r.reads, [], `${method} ${path} read the body`);
        assert.equal(r.hmac, 0);
      }
    }
    assert.equal(received.length, 0);

    // Signed, each known route reaches its object; an unknown one is a 404 after the check.
    for (const [method, path] of routes) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : '{}';
      const r = await call(env, signedRequest(method, `${path}?event=${SLUG}`, { body }).req);
      const known = path === '/admin/conferences' || adminRoutes.some((x) => x.path === path);
      assert.equal(r.status, known ? 200 : 404, `${method} ${path}`);
    }
    const reached = received.map((x) => `${x.method} ${x.path}`);
    assert.deepEqual(reached.sort(), [...adminRoutes.map((r) => `${r.method} ${r.path}`), 'PUT /admin/conferences'].sort());
  });

  test('steps 1 to 6 answer 404 and never touch the body', async () => {
    const path = `/admin/talks?event=${SLUG}`;
    const cases = [
      // 1. An Origin header, even on a correctly signed request.
      { why: 'origin', env: { ADMIN_TOKEN: KEY }, req: () => signedRequest('POST', path, { body: BODY, headers: { Origin: BASE } }).req, hmac: 0 },
      // 2. No usable ADMIN_TOKEN: missing, 31 characters, 31 after trimming, or only ADMIN_TOKEN_NEXT.
      { why: 'no token', env: {}, req: () => signedRequest('POST', path, { body: BODY }).req, hmac: 0 },
      { why: 'short token', env: { ADMIN_TOKEN: KEY.slice(0, 31) }, req: () => signedRequest('POST', path, { body: BODY }).req, hmac: 0 },
      { why: 'short after trim', env: { ADMIN_TOKEN: `  ${KEY.slice(0, 31)}  ` }, req: () => signedRequest('POST', path, { body: BODY }).req, hmac: 0 },
      { why: 'next only', env: { ADMIN_TOKEN_NEXT: KEY }, req: () => signedRequest('POST', path, { body: BODY }).req, hmac: 0 },
      // 3. The header absent, the old bearer form, malformed, or sent twice.
      { why: 'no header', env: { ADMIN_TOKEN: KEY }, req: () => new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY }), hmac: 0 },
      { why: 'bearer', env: { ADMIN_TOKEN: KEY }, req: () => new Request(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: BODY }), hmac: 0 },
      {
        why: 'uppercase sig', env: { ADMIN_TOKEN: KEY }, hmac: 0,
        req: () => {
          const { signed } = signedRequest('POST', path, { body: BODY });
          return new Request(signed.url, { method: 'POST', headers: { 'X-Caddie-Admin': signed.header.replace(/[0-9a-f]{64}$/, (s) => s.toUpperCase()), 'Content-Type': 'application/json' }, body: BODY });
        },
      },
      {
        why: 'sent twice', env: { ADMIN_TOKEN: KEY }, hmac: 0,
        req: () => {
          const { signed } = signedRequest('POST', path, { body: BODY });
          const h = new Headers({ 'Content-Type': 'application/json' });
          h.append('X-Caddie-Admin', signed.header);
          h.append('X-Caddie-Admin', signed.header);
          return new Request(signed.url, { method: 'POST', headers: h, body: BODY });
        },
      },
      // 4. A bodyless method whose header names a body hash, even with a valid HMAC over it.
      {
        why: 'DELETE with a body hash', env: { ADMIN_TOKEN: KEY }, hmac: 0,
        req: () => {
          const p = `/admin/test/profile?event=${SLUG}&profile_id=${'A'.repeat(22)}`;
          const header = handHeader({ method: 'DELETE', pathWithQuery: p, bodySha256: createHash('sha256').update(BODY).digest('hex') });
          return new Request(`${BASE}${p}`, { method: 'DELETE', headers: { 'X-Caddie-Admin': header, 'Content-Type': 'application/json' }, body: BODY });
        },
      },
      {
        why: 'GET with a body hash', env: { ADMIN_TOKEN: KEY }, hmac: 0,
        req: () => {
          const p = `/admin/stats?event=${SLUG}`;
          return new Request(`${BASE}${p}`, { headers: { 'X-Caddie-Admin': handHeader({ method: 'GET', pathWithQuery: p, bodySha256: 'a'.repeat(64) }) } });
        },
      },
      // 6. No held key reproduces the signature: another key, another path, another method, another body hash.
      { why: 'wrong key', env: { ADMIN_TOKEN: KEY }, req: () => signedRequest('POST', path, { body: BODY, key: KEY2 }).req, hmac: 1 },
      {
        why: 'other conference', env: { ADMIN_TOKEN: KEY }, hmac: 1,
        req: () => {
          const { signed } = signedRequest('POST', path, { body: BODY });
          return new Request(`${BASE}/admin/talks?event=${OTHER}`, { method: 'POST', headers: { 'X-Caddie-Admin': signed.header, 'Content-Type': 'application/json' }, body: BODY });
        },
      },
      {
        why: 'other method', env: { ADMIN_TOKEN: KEY }, hmac: 1,
        req: () => {
          const { signed } = signedRequest('POST', `/admin/topics?event=${SLUG}`, { body: BODY });
          return new Request(signed.url, { method: 'PUT', headers: { 'X-Caddie-Admin': signed.header, 'Content-Type': 'application/json' }, body: BODY });
        },
      },
      {
        why: 'other body hash', env: { ADMIN_TOKEN: KEY }, hmac: 1,
        req: () => {
          const { signed } = signedRequest('POST', path, { body: BODY });
          const forged = signed.header.replace(signed.bodySha256, createHash('sha256').update('{}').digest('hex'));
          return new Request(signed.url, { method: 'POST', headers: { 'X-Caddie-Admin': forged, 'Content-Type': 'application/json' }, body: '{}' });
        },
      },
    ];
    for (const c of cases) {
      const { env, received } = stubEnv(c.env);
      const req = c.req();
      req.headers.set('CF-Connecting-IP', freshIp());
      const r = await call(env, req);
      assert.equal(r.status, 404, c.why);
      assert.deepEqual(r.json, NOT_FOUND, c.why);
      assert.deepEqual(r.reads, [], `${c.why}: the body was touched`);
      assert.equal(r.hmac, c.hmac, `${c.why}: HMACs computed`);
      assert.equal(received.length, 0, c.why);
    }
  });

  test('step 7: a valid signature more than 300 seconds off answers 401 admin_skew before the body is read', async () => {
    const { env, received } = stubEnv();
    for (const off of [-400_000, 400_000]) {
      const r = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { body: BODY, now: Date.now() + off }).req);
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'admin_skew' });
      assert.deepEqual(r.reads, []);
    }
    // Within the window it passes.
    for (const off of [-200_000, 200_000]) {
      assert.equal((await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { body: BODY, now: Date.now() + off }).req)).status, 200);
    }
    assert.equal(received.length, 2);
    // Only a key holder ever sees the 401: a stale request with another key is a 404.
    const stale = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { body: BODY, key: KEY2, now: Date.now() - 400_000 }).req);
    assert.deepEqual([stale.status, stale.json, stale.hmac], [404, NOT_FOUND, 1]);
  });

  test('step 8: a body other than the signed one answers 401 admin_body and is not forwarded', async () => {
    const { env, received } = stubEnv();
    const path = `/admin/talks?event=${SLUG}`;
    const bad = [
      signedRequest('POST', path, { body: BODY, send: BODY.replace('1', '2') }).req, // same length, other bytes
      signedRequest('POST', path, { body: BODY, send: `${BODY} ` }).req,
      signedRequest('POST', path, { body: BODY, send: null }).req, // nothing sent
      signedRequest('POST', path, { body: undefined, send: BODY }).req, // signed as empty, a body sent
      signedRequest('DELETE', `/admin/test/profile?event=${SLUG}&profile_id=${'A'.repeat(22)}`, { send: BODY }).req,
    ];
    for (const req of bad) {
      const r = await call(env, req);
      assert.equal(r.status, 401, req.method);
      assert.deepEqual(r.json, { error: 'admin_body' });
      assert.equal(r.hmac, 1);
    }
    assert.equal(received.length, 0);
  });

  test('step 8: a body that arrives after the clock window answers 401 admin_skew and is not forwarded', async () => {
    await withClock(async (setOffset) => {
      const { env, received } = stubEnv();
      const path = `/admin/talks?event=${SLUG}`;
      const { signed } = signedRequest('POST', path, { body: BODY });
      // The header passes at once; the body is held back for 301 seconds.
      const stalled = (delay) => new Request(signed.url, {
        method: 'POST',
        duplex: 'half',
        headers: { 'X-Caddie-Admin': signed.header, 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIp() },
        body: new ReadableStream({
          pull(c) {
            setOffset(delay);
            c.enqueue(new TextEncoder().encode(BODY));
            c.close();
          },
        }, { highWaterMark: 0 }),
      });
      const late = await call(env, stalled(301_000));
      assert.deepEqual([late.status, late.json], [401, { error: 'admin_skew' }]);
      assert.ok(late.reads.includes('body'), 'refused after the body was read, not at step 7');
      assert.equal(received.length, 0);
      // Held back less than that, it goes through (the signature's own nonce, not yet used: the
      // stand-in object keeps no table).
      setOffset(0);
      assert.equal((await call(env, stalled(200_000))).status, 200);
      assert.equal(received.length, 1);
    });
  });

  test('step 8: a body over 4 MB answers 413, and only after a valid signature', async () => {
    const { env, received } = stubEnv();
    const big = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x20);
    const path = `/admin/talks?event=${SLUG}`;
    const signed = await call(env, signedRequest('POST', path, { body: big }).req);
    assert.equal(signed.status, 413);
    const unsigned = await call(env, signedRequest('POST', path, { body: '{}', key: KEY2, send: big }).req);
    assert.equal(unsigned.status, 404);
    assert.deepEqual(unsigned.reads, []);
    assert.equal(received.length, 0);
  });

  test('step 9: the object gets the buffered bytes and the verified nonce and timestamp, never the client\'s copies', async () => {
    const { env, received } = stubEnv();
    // A byte-order mark, a lone continuation byte and 0xff: bytes a text round trip would change.
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x80, 0x7d, 0xff, 0x0a]);
    const spoofed = { 'X-Caddie-Admin-Nonce': 'C'.repeat(22), 'X-Caddie-Admin-Ts': '1', 'X-Caddie-Slug': OTHER, 'X-Caddie-IP': '203.0.113.9', Authorization: 'Bearer nope' };
    for (const [method, path, name] of [['POST', `/admin/talks?event=${SLUG}`, `conference:${SLUG}`], ['PUT', '/admin/conferences', 'directory:global']]) {
      const ip = freshIp();
      const { req, signed } = signedRequest(method, path, { body: bytes, ip, headers: spoofed });
      const r = await call(env, req);
      assert.equal(r.status, 200, `${method} ${path}`);
      const got = received.pop();
      assert.equal(got.name, name);
      assert.deepEqual([...got.body], [...bytes]);
      assert.equal(got.headers['x-caddie-admin-nonce'], signed.nonce);
      assert.equal(got.headers['x-caddie-admin-ts'], String(signed.ts));
      assert.equal(got.headers['x-caddie-ip'], ip);
      assert.equal(got.headers['x-caddie-slug'], method === 'POST' ? SLUG : undefined);
      assert.equal(got.headers['x-caddie-admin'], undefined);
      assert.equal(got.headers.authorization, undefined);
      assert.equal(got.path + got.search, signed.pathWithQuery);
    }
    // A GET carries no body to the object.
    const { req, signed } = signedRequest('GET', `/admin/stats?event=${SLUG}`);
    assert.equal((await call(env, req)).status, 200);
    const got = received.pop();
    assert.deepEqual([got.method, got.body.length, got.headers['x-caddie-admin-nonce']], ['GET', 0, signed.nonce]);
  });

  test('the Authorization header is not read: a bearer alone is 404, a signed request with any bearer passes', async () => {
    const { env } = stubEnv();
    const bearer = new Request(`${BASE}/admin/stats?event=${SLUG}`, { headers: { Authorization: `Bearer ${KEY}`, 'CF-Connecting-IP': freshIp() } });
    const r = await call(env, bearer);
    assert.deepEqual([r.status, r.hmac], [404, 0]);
    const { req } = signedRequest('GET', `/admin/stats?event=${SLUG}`, { headers: { Authorization: 'Bearer something-else-entirely-0123456789' } });
    assert.equal((await call(env, req)).status, 200);
  });

  test('ADMIN_TOKEN_NEXT: either key is accepted during a rotation, and both are always tried', async () => {
    const rotating = stubEnv({ ADMIN_TOKEN: KEY, ADMIN_TOKEN_NEXT: KEY2 }).env;
    for (const key of [KEY, KEY2]) {
      const r = await call(rotating, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key }).req);
      assert.deepEqual([r.status, r.hmac, r.compare], [200, 2, 2]);
    }
    const third = await call(rotating, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: 'z'.repeat(40) }).req);
    assert.deepEqual([third.status, third.hmac], [404, 2]);
    // Without ADMIN_TOKEN_NEXT, or with one too short after trimming, the second key is not held.
    for (const vars of [{ ADMIN_TOKEN: KEY }, { ADMIN_TOKEN: KEY, ADMIN_TOKEN_NEXT: ` ${KEY2.slice(0, 31)} ` }, { ADMIN_TOKEN: KEY, ADMIN_TOKEN_NEXT: ' '.repeat(40) }]) {
      const r = await call(stubEnv(vars).env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: KEY2 }).req);
      assert.deepEqual([r.status, r.hmac], [404, 1]);
    }
    // Each secret is trimmed on read.
    const padded = stubEnv({ ADMIN_TOKEN: `\n${KEY}  `, ADMIN_TOKEN_NEXT: `\t${KEY2}\n` }).env;
    for (const key of [KEY, KEY2]) assert.equal((await call(padded, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key }).req)).status, 200);
  });
});

describe('the failed-auth limit (W4): 10 bad signatures a minute per address', { skip }, () => {
  test('100 correctly signed requests from one address within a minute all pass and take nothing', async () => {
    const { env, received } = stubEnv();
    const ip = freshIp();
    for (let i = 0; i < 100; i++) {
      const r = await call(env, signedRequest('POST', `/admin/embed-pending?event=${SLUG}`, { body: '{}', ip }).req);
      assert.equal(r.status, 200, `request ${i + 1}`);
    }
    assert.equal(received.length, 100);
    // The bucket is still full: ten bad signatures are each checked (one HMAC each) before the
    // eleventh is refused.
    for (let i = 0; i < 10; i++) assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: KEY2, ip }).req)).hmac, 1);
    assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: KEY2, ip }).req)).hmac, 0);
  });

  test('the eleventh bad signature within a minute is refused at step 5, without an HMAC', async () => {
    const { env } = stubEnv();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const r = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { body: BODY, key: KEY2, ip }).req);
      assert.deepEqual([r.status, r.hmac, r.compare, r.reads.length], [404, 1, 1, 0], `failure ${i + 1}`);
    }
    const r = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { body: BODY, key: KEY2, ip }).req);
    assert.deepEqual([r.status, r.json, r.hmac, r.compare, r.reads.length], [404, NOT_FOUND, 0, 0, 0]);
    // Malformed headers and a missing key never reach the bucket, and so never fill it.
    const other = freshIp();
    for (let i = 0; i < 20; i++) {
      await call(env, new Request(`${BASE}/admin/stats?event=${SLUG}`, { headers: { 'X-Caddie-Admin': 'v1 nonsense', 'CF-Connecting-IP': other } }));
    }
    assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { ip: other }).req)).status, 200);
  });

  test('after ten failures a valid request from that address is refused until the bucket refills; other addresses are not affected', async () => {
    await withClock(async (setOffset) => {
      const { env, received } = stubEnv();
      const ip = freshIp();
      const valid = () => call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { ip }).req);
      for (let i = 0; i < 10; i++) assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: KEY2, ip }).req)).status, 404);
      let r = await valid();
      assert.deepEqual([r.status, r.hmac], [404, 0]);
      assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { ip: freshIp() }).req)).status, 200);
      // One token comes back every 6 seconds (10 a minute).
      setOffset(5_000);
      r = await valid();
      assert.deepEqual([r.status, r.hmac], [404, 0]);
      setOffset(6_500);
      assert.equal((await valid()).status, 200);
      assert.equal((await valid()).status, 200, 'a valid request takes no token');
      // A bad one takes it again.
      assert.equal((await call(env, signedRequest('GET', `/admin/stats?event=${SLUG}`, { key: KEY2, ip }).req)).hmac, 1);
      assert.equal((await valid()).status, 404);
      // A full minute later the bucket is full again.
      setOffset(70_000);
      assert.equal((await valid()).status, 200);
      assert.equal(received.length, 4);
    });
  });
});
