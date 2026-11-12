// The Worker's check of admin signatures during the move to v2 (step b of "Admin signature v2" in
// DECISIONS.md): the Worker accepts v1 and v2, a v2 signature is bound to an origin this Worker
// serves, and ADMIN_SIG_MIN and ADMIN_ORIGIN choose what is accepted.
//
// First the verifier and the configuration reader in src/lib/admin-auth.js against every case of
// the shared fixture file test/fixtures/admin-sign.v2.json, which the signer
// (scripts/lib/admin-sign.mjs) is tested against too: the sign, verify, reject and origin cases and
// the worker_config_cases. Then the Worker's fetch handler, with stand-ins for both Durable Object
// namespaces (and, for the replay, real objects on node:sqlite), counting the HMACs and the
// constant-time compares the Worker makes. Nothing here reaches the network, and the keys are the
// fixture's fake ones. test/fixtures/admin-sign.v1.json stays covered by admin-auth.test.mjs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { skip, worker, adminRoutes, ConferenceDO, DirectoryDO, fakeState, namespace } from './helpers/harness.mjs';
import {
  BODYLESS_METHODS, EMPTY_BODY_SHA256, HEADER_RE, HEADER_RE_V2, MIN_KEY_LENGTH, SKEW_SECONDS, WORKER_DEFAULT_SIG_MIN,
  adminConfig, canonicalString, canonicalStringV2, parseVersionedAdminHeader, verifyAdminHeader,
} from '../src/lib/admin-auth.js';
import { signAdminRequest } from '../../scripts/lib/admin-sign.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v2.json', import.meta.url), 'utf8'));
const byKind = (kind, call) => fixture.cases.filter((c) => c.kind === kind && (call === undefined || c.call === call));
const signCases = byKind('sign');
const verifyCases = byKind('verify');
const rejectSignCases = byKind('reject', 'sign');
const rejectVerifyCases = byKind('reject', 'verify');
const originCases = byKind('origin');
const configCases = fixture.worker_config_cases;

const KEY = fixture.keys.key1;
const KEY2 = fixture.keys.key2;
const CUSTOM = fixture.origins.custom_domain;
const WORKERS_DEV = fixture.origins.workers_dev;
const STAGING = fixture.origins.other_deployment;
const SLUG = 'caddie-fixture-2099';
const NOT_FOUND = { error: 'Not found' };
// A request URL whose origin is in no case's list, so a case that sets ADMIN_ORIGIN can only pass
// through the list, never through the request-URL fallback.
const ELSEWHERE = 'https://not-listed.invalid';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const envFor = (setting, c) => (c.unset ? {} : { [setting]: c.raw });

// A constant-time compare that counts its calls.
function countingCompare() {
  const counter = { n: 0 };
  counter.fn = (a, b) => {
    counter.n += 1;
    return nodeTimingSafeEqual(a, b);
  };
  return counter;
}

// ---------------------------------------------------------------------------------------------
// The verifier and the configuration reader against the fixture.

const V1_RE = new RegExp(fixture.v1_header_re);
const V2_RE = new RegExp(fixture.header_re);
const usableKeys = (keys) => keys.filter((k) => typeof k === 'string' && k.trim().length >= fixture.min_key_length);

function rawHeader(value) {
  for (const [version, re] of [[1, V1_RE], [2, V2_RE]]) {
    const m = re.exec(value ?? '');
    if (m) return { version, ts: m[1], nonce: m[2], bodySha256: m[3], sig: m[4] };
  }
  return null;
}

// Whether a reason applies to a verify case, computed here from the fixture alone (node:crypto,
// the fixture's regular expressions, and new URL(x).origin for the expected origins, all of which
// the fixture writes as plain origins), so a verifier that reports another reason than the case
// names is accepted only when that reason applies too.
function applies(reason, c) {
  const h = rawHeader(c.header);
  const method = c.method.toUpperCase();
  const keys = usableKeys(c.keys);
  switch (reason) {
    case 'malformed':
      return !h || !c.allowed_versions.includes(h.version);
    case 'no_key':
      return keys.length === 0;
    case 'bodyless_body_hash':
      return Boolean(h) && fixture.bodyless_methods.includes(method) && h.bodySha256 !== fixture.empty_body_sha256;
    case 'signature': {
      if (applies('malformed', c) || keys.length === 0) return false;
      const fields = `${method}\n${c.path_with_query}\n${h.bodySha256}\n${h.ts}\n${h.nonce}\n`;
      const texts = h.version === 1 ? [`caddie-admin-v1\n${fields}`] : (c.expected_origins ?? []).map((o) => `caddie-admin-v2\n${fields}${new URL(o).origin}\n`);
      return !keys.some((k) => texts.some((t) => createHmac('sha256', k.trim()).update(t).digest('hex') === h.sig));
    }
    // Only after a valid signature: a stale request with a wrong origin is a signature failure.
    case 'skew':
      return !applies('malformed', c) && keys.length > 0 && !applies('signature', c) && Math.abs(c.now - Number(h.ts)) > fixture.skew_seconds;
    default:
      return false;
  }
}

// The Worker's reading of a verify case's settings. allowed_versions [1, 2] is ADMIN_SIG_MIN "1"
// and [2] is "2"; [1] is a Worker from before step b, which has no setting, so the list is passed
// as it is. expected_origins is ADMIN_ORIGIN, the entries joined with ",", read by adminConfig().
function workerSettings(c) {
  const sigMin = same(c.allowed_versions, [1, 2]) ? '1' : same(c.allowed_versions, [2]) ? '2' : undefined;
  const env = {};
  if (sigMin !== undefined) env.ADMIN_SIG_MIN = sigMin;
  if (c.expected_origins !== undefined) env.ADMIN_ORIGIN = c.expected_origins.join(',');
  const cfg = adminConfig(env, `${ELSEWHERE}${c.path_with_query}`);
  assert.equal(cfg.ok, true, `the settings of ${c.id} are valid`);
  if (sigMin === undefined) return { allowedVersions: c.allowed_versions, origins: c.expected_origins === undefined ? [] : cfg.origins };
  assert.ok(c.expected_origins !== undefined || !c.allowed_versions.includes(2));
  return { allowedVersions: cfg.allowedVersions, origins: c.expected_origins === undefined ? [] : cfg.origins };
}

describe('the verifier against test/fixtures/admin-sign.v2.json', () => {
  test('its constants are the fixture\'s, and the default minimum is "1" in this step', () => {
    assert.equal(HEADER_RE_V2.source, fixture.header_re);
    assert.equal(HEADER_RE.source, fixture.v1_header_re);
    assert.equal(EMPTY_BODY_SHA256, fixture.empty_body_sha256);
    assert.deepEqual([...BODYLESS_METHODS], fixture.bodyless_methods);
    assert.equal(SKEW_SECONDS, fixture.skew_seconds);
    assert.equal(MIN_KEY_LENGTH, fixture.min_key_length);
    // Step d of the migration changes this to "2" in the source.
    assert.equal(WORKER_DEFAULT_SIG_MIN, '1');
    // The fixture belongs to the signer's side and may grow; every case runs below.
    assert.ok(signCases.length >= 21, `${signCases.length} sign cases`);
    assert.ok(verifyCases.length >= 61, `${verifyCases.length} verify cases`);
    assert.ok(rejectSignCases.length >= 23, `${rejectSignCases.length} reject sign cases`);
    assert.ok(rejectVerifyCases.length >= 24, `${rejectVerifyCases.length} reject verify cases`);
    assert.ok(originCases.length >= 49, `${originCases.length} origin cases`);
    assert.ok(configCases.length >= 19, `${configCases.length} worker config cases`);
  });

  for (const c of signCases) {
    test(`sign ${c.id}: the header is accepted for its method and path with now = ts, through the request-URL fallback and through ADMIN_ORIGIN`, async () => {
      const header = parseVersionedAdminHeader(c.header);
      assert.equal(header.version, 2);
      assert.equal(canonicalStringV2(c.method, c.path_with_query, header, c.origin), c.canonical);
      // The fallback: ADMIN_ORIGIN unset, the origin of the URL the request was sent to.
      const settings = [
        ['fallback', adminConfig({}, c.url)],
        ['fallback, v2 only', adminConfig({ ADMIN_SIG_MIN: '2' }, c.url)],
        ['ADMIN_ORIGIN', adminConfig({ ADMIN_ORIGIN: c.base }, `${ELSEWHERE}${c.path_with_query}`)],
      ];
      for (const [why, cfg] of settings) {
        assert.equal(cfg.ok, true, why);
        assert.deepEqual(cfg.origins, [c.origin], why);
        const compare = countingCompare();
        const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], nowMs: c.ts * 1000, timingSafeEqual: compare.fn, allowedVersions: cfg.allowedVersions, origins: cfg.origins });
        assert.equal(v.ok, true, `${why}: ${v.reason}`);
        assert.deepEqual([v.version, v.origin, compare.n], [2, c.origin, 1], why);
        assert.deepEqual(v.header, { version: 2, ts: String(c.ts), nonce: c.nonce, bodySha256: c.body_sha256, sig: c.sig }, why);
      }
      // The same header against any other origin is a signature failure.
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], nowMs: c.ts * 1000, timingSafeEqual: nodeTimingSafeEqual, allowedVersions: [1, 2], origins: [c.origin === CUSTOM ? STAGING : CUSTOM] });
      assert.deepEqual([v.ok, v.reason], [false, 'signature']);
      if (c.same_header_as) assert.equal(c.header, signCases.find((x) => x.id === c.same_header_as).header);
    });
  }

  for (const c of verifyCases) {
    test(`verify ${c.id}: ${c.expect.ok ? `ok (v${c.expect.version})` : c.expect.reason}, ${c.expect.compares} compares`, async () => {
      assert.ok(c.expect.ok || applies(c.expect.reason, c), `the fixture's own reason must apply (${c.expect.reason})`);
      const { allowedVersions, origins } = workerSettings(c);
      const compare = countingCompare();
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: c.keys, nowMs: c.now * 1000, timingSafeEqual: compare.fn, allowedVersions, origins });
      if (c.expect.ok) {
        assert.equal(v.ok, true, v.reason);
        assert.equal(v.header.bodySha256, c.expect.body_sha256);
        assert.equal(v.version, c.expect.version);
        if (c.expect.version === 2) assert.equal(v.origin, c.expect.origin);
        else assert.equal(v.origin, undefined);
      } else {
        assert.equal(v.ok, false);
        assert.ok(v.reason === c.expect.reason || applies(v.reason, c), `reason ${v.reason}, expected ${c.expect.reason}`);
      }
      // Every comparison runs, even after a match: no early exit in the key loop or the origin loop.
      assert.equal(compare.n, c.expect.compares, 'constant-time compares');
    });
  }

  for (const c of rejectSignCases) {
    test(`reject ${c.id}: the signer refuses it (${c.reject}), so the Worker never sees it`, () => {
      assert.throws(() => signAdminRequest(c.input), (err) => err.name === 'UsageError' && err.code === c.reject);
    });
  }

  for (const c of rejectVerifyCases) {
    const input = c.input;
    if (!c.node_api_only) {
      test(`reject ${c.id}: ADMIN_ORIGIN with this entry is invalid configuration`, () => {
        assert.equal(c.reject, 'expected_origins');
        const cfg = adminConfig({ ADMIN_ORIGIN: input.expected_origins.join(',') }, `${CUSTOM}${input.path_with_query}`);
        assert.deepEqual(cfg, { ok: false, invalid: 'ADMIN_ORIGIN' });
      });
    } else if (c.reject === 'expected_origins') {
      // No Worker equivalent: an unset ADMIN_ORIGIN means the request URL's own origin, and the
      // Worker reads ADMIN_ORIGIN as one string.
      test(`reject ${c.id}: node API only; the Worker falls back to the request URL's origin or reads the string`, async () => {
        const env = typeof input.expected_origins === 'string' ? { ADMIN_ORIGIN: input.expected_origins } : {};
        if (same(input.allowed_versions, [2])) env.ADMIN_SIG_MIN = '2';
        const cfg = adminConfig(env, `${CUSTOM}${input.path_with_query}`);
        assert.deepEqual(cfg.origins, [CUSTOM]);
        const v = await verifyAdminHeader({ headerValue: input.header, method: input.method, pathWithQuery: input.path_with_query, keys: input.keys, nowMs: input.now * 1000, timingSafeEqual: nodeTimingSafeEqual, allowedVersions: cfg.allowedVersions, origins: cfg.origins });
        assert.deepEqual([v.ok, v.origin], [true, CUSTOM]);
      });
    } else {
      // No Worker equivalent either (the Worker reads ADMIN_SIG_MIN), but the pure verifier given
      // such a list fails closed rather than accepting anything.
      test(`reject ${c.id}: node API only; the verifier given these versions refuses every header`, async () => {
        assert.equal(c.reject, 'version');
        const compare = countingCompare();
        const v = await verifyAdminHeader({ headerValue: input.header, method: input.method, pathWithQuery: input.path_with_query, keys: input.keys, nowMs: input.now * 1000, timingSafeEqual: compare.fn, allowedVersions: input.allowed_versions, origins: input.expected_origins });
        assert.deepEqual([v.ok, v.reason, compare.n], [false, 'config', 0]);
      });
    }
  }

  test('the verifier\'s own settings fail closed: v2 allowed with no origin, an empty origin, or no version', async () => {
    const c = signCases[0];
    for (const [allowedVersions, origins] of [[[1, 2], []], [[2], undefined], [[2], ['']], [[2], [null]], [[], [CUSTOM]], [undefined, [CUSTOM]]]) {
      const compare = countingCompare();
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys: [c.key], nowMs: c.ts * 1000, timingSafeEqual: compare.fn, allowedVersions, origins });
      if (allowedVersions === undefined) {
        // The default is [1], a verifier from before v2: the v2 header is malformed.
        assert.deepEqual([v.ok, v.reason, compare.n], [false, 'malformed', 0]);
      } else {
        assert.deepEqual([v.ok, v.reason, compare.n], [false, 'config', 0], JSON.stringify([allowedVersions, origins]));
      }
    }
  });

  for (const c of originCases) {
    test(`origin ${c.id}: ADMIN_ORIGIN = this value reads as ${c.expect.origin ?? 'refused'}`, () => {
      const requestUrl = `${ELSEWHERE}/admin/stats`;
      const cfg = adminConfig({ ADMIN_ORIGIN: c.input }, requestUrl);
      if (c.input.trim() === '') {
        // Empty after trimming is unset: the request-URL fallback, never an accepted entry.
        assert.equal(c.expect.origin, null);
        assert.deepEqual(cfg, { ok: true, allowedVersions: [1, 2], origins: [ELSEWHERE] });
      } else if (c.expect.origin === null) {
        assert.deepEqual(cfg, { ok: false, invalid: 'ADMIN_ORIGIN' });
      } else {
        assert.deepEqual(cfg, { ok: true, allowedVersions: [1, 2], origins: [c.expect.origin] });
      }
      // The fallback takes a request URL's origin as it is, path and all, without the origin rule.
      if (c.request_url_origin !== undefined) assert.deepEqual(adminConfig({}, c.input).origins, [c.request_url_origin]);
    });
  }

  for (const c of configCases) {
    test(`config ${c.id}: ${c.setting} ${c.unset ? 'unset' : JSON.stringify(c.raw)}`, () => {
      const requestUrl = `${CUSTOM}/admin/stats?event=${SLUG}`;
      const cfg = adminConfig(envFor(c.setting, c), requestUrl);
      if (c.setting === 'ADMIN_ORIGIN') {
        if (c.expect.mode === 'invalid') assert.deepEqual(cfg, { ok: false, invalid: 'ADMIN_ORIGIN' });
        else if (c.expect.mode === 'fallback') assert.deepEqual(cfg, { ok: true, allowedVersions: [1, 2], origins: [CUSTOM] });
        else assert.deepEqual(cfg, { ok: true, allowedVersions: [1, 2], origins: c.expect.origins });
      } else {
        assert.equal(c.setting, 'ADMIN_SIG_MIN');
        if (c.expect.allowed_versions === null) assert.deepEqual(cfg, { ok: false, invalid: 'ADMIN_SIG_MIN' });
        else assert.deepEqual(cfg, { ok: true, allowedVersions: c.expect.allowed_versions, origins: [CUSTOM] });
      }
    });
  }

  test('ADMIN_SIG_MIN is never loosened: a value that is not a string never means "1"', () => {
    for (const raw of [2, 1, '', false, 0, ['2'], ' 1', '1 ', '1\n']) {
      assert.deepEqual(adminConfig({ ADMIN_SIG_MIN: raw }, CUSTOM), { ok: false, invalid: 'ADMIN_SIG_MIN' }, JSON.stringify(raw));
    }
    for (const raw of [1, ['https://caddie.example'], {}, true]) {
      assert.deepEqual(adminConfig({ ADMIN_ORIGIN: raw }, CUSTOM), { ok: false, invalid: 'ADMIN_ORIGIN' }, JSON.stringify(raw));
    }
    // An absent setting is the source default, "1" in this step. The Worker reads it with ??, so
    // null (which a Worker's environment never holds) counts as absent too, on purpose: it takes
    // the default rather than failing closed, which keeps step d's default of "2" in force for it.
    assert.deepEqual(adminConfig({ ADMIN_SIG_MIN: undefined }, CUSTOM).allowedVersions, [1, 2]);
    assert.deepEqual(adminConfig({ ADMIN_SIG_MIN: null }, CUSTOM), { ok: true, allowedVersions: [1, 2], origins: [CUSTOM] });
  });

  test('the verifier tries each distinct origin once: a list with a duplicate costs one compare per key', async () => {
    const c = signCases.find((x) => x.origin === CUSTOM) ?? signCases[0];
    for (const keys of [[c.key], [c.key, c.key === KEY ? KEY2 : KEY]]) {
      const compare = countingCompare();
      const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys, nowMs: c.ts * 1000, timingSafeEqual: compare.fn, allowedVersions: [1, 2], origins: [c.origin, c.origin] });
      assert.deepEqual([v.ok, v.origin, compare.n], [true, c.origin, keys.length]);
    }
  });

  test('the v1 and v2 canonical strings differ for the same fields, so neither header can carry the other\'s signature', () => {
    const h = { ts: '1762848000', nonce: 'A'.repeat(22), bodySha256: EMPTY_BODY_SHA256 };
    const v1 = canonicalString('get', '/admin/stats', h);
    const v2 = canonicalStringV2('get', '/admin/stats', h, CUSTOM);
    assert.equal(v1, `caddie-admin-v1\nGET\n/admin/stats\n${EMPTY_BODY_SHA256}\n1762848000\n${'A'.repeat(22)}\n`);
    assert.equal(v2, `caddie-admin-v2\nGET\n/admin/stats\n${EMPTY_BODY_SHA256}\n1762848000\n${'A'.repeat(22)}\n${CUSTOM}\n`);
  });
});

// ---------------------------------------------------------------------------------------------
// test/fixtures/admin-sign.v1.json under this step's settings. admin-auth.test.mjs runs it with the
// verifier's default, [1]; the Worker now passes adminConfig()'s ([1, 2] and the request-URL
// origin), and every v1 case must keep its result there. The one intended change is
// v-malformed-version: a v2 header, malformed to a v1-only verifier, is now read and fails its
// signature, which the Worker charges to the failed-auth bucket like any bad signature.

const v1Fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const V1_CHANGED = new Map([['v-malformed-version', { ok: false, reason: 'signature' }]]);

describe('test/fixtures/admin-sign.v1.json under step b\'s settings', () => {
  const v1Cases = v1Fixture.cases.filter((c) => c.kind === 'sign' || c.kind === 'verify');

  test('the fixture still has its cases, and the only changed one is a v2 header', () => {
    assert.ok(v1Cases.length >= 55, `${v1Cases.length} v1 sign and verify cases`);
    for (const id of V1_CHANGED.keys()) assert.equal(parseVersionedAdminHeader(v1Cases.find((c) => c.id === id).header).version, 2, id);
  });

  for (const c of v1Cases) {
    test(`v1 ${c.kind} ${c.id}: the same result with ADMIN_SIG_MIN and ADMIN_ORIGIN unset${V1_CHANGED.has(c.id) ? ' (changed on purpose)' : ''}`, async () => {
      const keys = c.kind === 'sign' ? [c.key] : c.keys;
      const nowMs = (c.kind === 'sign' ? c.ts : c.now) * 1000;
      const cfg = adminConfig({}, `${CUSTOM}${c.path_with_query}`);
      assert.deepEqual(cfg, { ok: true, allowedVersions: [1, 2], origins: [CUSTOM] });
      const run = async (settings) => {
        const compare = countingCompare();
        const v = await verifyAdminHeader({ headerValue: c.header, method: c.method, pathWithQuery: c.path_with_query, keys, nowMs, timingSafeEqual: compare.fn, ...settings });
        return { ok: v.ok, reason: v.reason, header: v.header ?? null, version: v.version ?? null, compares: compare.n };
      };
      const v1Only = await run({});
      const stepB = await run({ allowedVersions: cfg.allowedVersions, origins: cfg.origins });
      if (V1_CHANGED.has(c.id)) {
        assert.deepEqual([v1Only.ok, v1Only.reason], [false, 'malformed']);
        assert.deepEqual({ ok: stepB.ok, reason: stepB.reason }, V1_CHANGED.get(c.id));
      } else {
        assert.deepEqual(stepB, v1Only);
        if (stepB.ok) assert.equal(stepB.version, 1);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The Worker's fetch handler.

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
  crypto.subtle.timingSafeEqual = function countingTimingSafeEqual(a, b) {
    counts.compare += 1;
    return compare.call(crypto.subtle, a, b);
  };
  restoreCrypto = () => {
    crypto.subtle.sign = sign;
    crypto.subtle.timingSafeEqual = compare;
  };
});
after(() => restoreCrypto?.());

// Durable Object stand-ins that record what they receive. The directory knows SLUG.
function stubEnv(vars = {}) {
  const received = [];
  const record = (name, req) => received.push({ name, method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) });
  const DIRECTORY = namespace((name) => ({
    async fetch(req) {
      if (new URL(req.url).pathname === '/internal/routes') {
        return Response.json({ conferences: [{ slug: SLUG, status: 'searchable', route_prefix: SLUG.slice(0, 6), has_object: true }] });
      }
      record(`directory:${name}`, req);
      return Response.json({ upserted: 0, searchable: [] });
    },
  }));
  const CONFERENCE = namespace((name) => ({
    async fetch(req) {
      record(`conference:${name}`, req);
      return Response.json({ ok: true });
    },
  }));
  return { env: { ADMIN_TOKEN: KEY, ...vars, DIRECTORY, CONFERENCE }, received };
}

let ipSeq = 0;
const freshIp = () => `2001:db8:2::${(++ipSeq).toString(16)}`;

// A request signed with signAdminRequest for `signFor` (an origin; v2 binds it) and sent to `sendTo`
// (the same origin by default). `headers` adds or overrides headers.
function signedRequest(method, path, { version = 2, signFor = CUSTOM, sendTo, body, key = KEY, now, nonce, ip = freshIp(), headers = {} } = {}) {
  const s = signAdminRequest({ method, path, base: signFor, body, key, now, nonce, version });
  const h = new Headers({ 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': ip });
  if (body !== undefined) h.set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const url = `${sendTo ?? signFor}${s.pathWithQuery}`;
  return { req: new Request(url, { method, headers: h, body }), signed: s };
}

// A header signed by hand, for what the signer never makes: a v1 header over the v2 canonical
// string, and the reverse.
function crossHeader({ headerVersion, signedVersion, method, pathWithQuery, origin = CUSTOM, ts = Math.floor(Date.now() / 1000), nonce = 'X'.repeat(22) }) {
  const fields = `${method}\n${pathWithQuery}\n${EMPTY_BODY_SHA256}\n${ts}\n${nonce}\n`;
  const text = signedVersion === 1 ? `caddie-admin-v1\n${fields}` : `caddie-admin-v2\n${fields}${origin}\n`;
  return `v${headerVersion} ${ts} ${nonce} ${EMPTY_BODY_SHA256} ${createHmac('sha256', KEY).update(text).digest('hex')}`;
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

// Calls the Worker and captures what it logs. Returns the status, the parsed JSON body, which body
// readers the Worker touched, the HMACs and compares it computed, and its log lines other than the
// one-line request log.
async function call(env, req) {
  const { proxy, reads } = tracked(req);
  const before = { ...counts };
  const logs = [];
  const { log, error } = console;
  console.log = (...a) => {
    const line = a.join(' ');
    if (!/^[A-Z]+ \/\S* \d{3} \d+ms$/.test(line)) logs.push(line);
  };
  console.error = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await worker.fetch(proxy, env);
  } finally {
    console.log = log;
    console.error = error;
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json, reads, logs, hmac: counts.hmac - before.hmac, compare: counts.compare - before.compare };
}

const STATS = `/admin/stats?event=${SLUG}`;
const configLine = (line) => line.startsWith('admin config');
const BODY = JSON.stringify({ generation: 1, talks: [] });

// Whether the failed-auth bucket of `ip` is still full enough for a valid request: after ten
// failures it is empty, and a valid request is refused without an HMAC.
async function bucketTaken(env, ip, failures) {
  for (let i = 1; i < failures; i++) await call(env, signedRequest('GET', STATS, { key: KEY2, ip }).req);
  return call(env, signedRequest('GET', STATS, { ip }).req);
}

describe('the Worker during the move to v2', { skip }, () => {
  test('a v2 request signed for the origin it reaches is accepted, and the object gets its nonce and timestamp', async () => {
    for (const vars of [{}, { ADMIN_SIG_MIN: '1' }, { ADMIN_SIG_MIN: '2' }]) {
      const { env, received } = stubEnv(vars);
      for (const [method, path, body, name] of [['GET', STATS, undefined, `conference:${SLUG}`], ['POST', `/admin/talks?event=${SLUG}`, BODY, `conference:${SLUG}`], ['PUT', '/admin/conferences', BODY, 'directory:global']]) {
        const { req, signed } = signedRequest(method, path, { body });
        const r = await call(env, req);
        // One compare for the signature, and one more for the body hash when there is a body.
        assert.deepEqual([r.status, r.hmac, r.compare, r.logs.filter(configLine)], [200, 1, body === undefined ? 1 : 2, []], `${JSON.stringify(vars)} ${method} ${path}`);
        const got = received.pop();
        assert.equal(got.name, name);
        assert.equal(got.headers['x-caddie-admin-nonce'], signed.nonce);
        assert.equal(got.headers['x-caddie-admin-ts'], String(signed.ts));
        assert.equal(got.headers['x-caddie-admin'], undefined);
      }
    }
  });

  test('a v2 request signed for another origin answers 404, reads no body, and takes from the failed-auth bucket', async () => {
    const { env, received } = stubEnv();
    // Another deployment, another port, http: for https:, a trailing dot, a look-alike host.
    for (const signFor of [STAGING, WORKERS_DEV, `${CUSTOM}:8443`, CUSTOM.replace('https:', 'http:'), `${CUSTOM}.`, 'https://caddie.example.evil.example']) {
      const r = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { signFor, sendTo: CUSTOM, body: BODY }).req);
      assert.deepEqual([r.status, r.json, r.reads, r.hmac, r.compare, r.logs.filter(configLine)], [404, NOT_FOUND, [], 1, 1, []], signFor);
    }
    // A Host or forwarding header that names the signed origin changes nothing: the fallback is
    // the request URL's origin.
    const spoofed = await call(env, signedRequest('GET', STATS, { signFor: STAGING, sendTo: CUSTOM, headers: { Host: 'caddie-staging.example', 'X-Forwarded-Host': 'caddie-staging.example', 'CF-Worker': 'caddie-staging.example' } }).req);
    assert.deepEqual([spoofed.status, spoofed.hmac], [404, 1]);
    // A wrong origin with a stale timestamp fails on the signature (404), never the clock (401).
    const stale = await call(env, signedRequest('GET', STATS, { signFor: STAGING, sendTo: CUSTOM, now: Date.now() - 400_000 }).req);
    assert.deepEqual([stale.status, stale.json], [404, NOT_FOUND]);
    assert.equal(received.length, 0);

    // Each one takes a token: after ten from one address, a valid request from it is refused at
    // step 5 without an HMAC, while another address is not affected.
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const r = await call(env, signedRequest('GET', STATS, { signFor: STAGING, sendTo: CUSTOM, ip }).req);
      assert.deepEqual([r.status, r.hmac], [404, 1], `failure ${i + 1}`);
    }
    for (const version of [1, 2]) {
      const r = await call(env, signedRequest('GET', STATS, { version, ip }).req);
      assert.deepEqual([r.status, r.json, r.hmac, r.compare], [404, NOT_FOUND, 0, 0], `v${version} after ten wrong origins`);
    }
    assert.equal((await call(env, signedRequest('GET', STATS).req)).status, 200);
  });

  test('ADMIN_ORIGIN as a list: a v2 request for each listed origin is accepted, any other is refused, and v1 is not bound to it', async () => {
    const { env, received } = stubEnv({ ADMIN_ORIGIN: ` ${CUSTOM.toUpperCase()}:443 , ${WORKERS_DEV}/ ` });
    for (const origin of [CUSTOM, WORKERS_DEV]) {
      // Sent to either listed hostname: both route to this one Worker.
      for (const sendTo of [CUSTOM, WORKERS_DEV]) {
        const r = await call(env, signedRequest('GET', STATS, { signFor: origin, sendTo }).req);
        assert.deepEqual([r.status, r.hmac, r.compare], [200, 2, 2], `${origin} via ${sendTo}`);
      }
    }
    assert.equal(received.length, 4);
    // Not listed: another deployment, another port, and the request URL's own origin, which the
    // list replaces rather than adds to.
    for (const [signFor, sendTo] of [[STAGING, CUSTOM], [`${CUSTOM}:8443`, CUSTOM], [STAGING, STAGING], ['http://127.0.0.1:8787', 'http://127.0.0.1:8787']]) {
      const r = await call(env, signedRequest('GET', STATS, { signFor, sendTo }).req);
      assert.deepEqual([r.status, r.json, r.hmac, r.compare], [404, NOT_FOUND, 2, 2], `${signFor} via ${sendTo}`);
    }
    // v1 carries no origin: accepted whatever the list, until step d.
    assert.equal((await call(env, signedRequest('GET', STATS, { version: 1, signFor: STAGING }).req)).status, 200);
    assert.equal(received.length, 5);
  });

  test('an invalid ADMIN_ORIGIN or ADMIN_SIG_MIN answers 404 to every admin request, charges nothing, and logs the setting\'s name only', async () => {
    const invalid = [
      ...configCases.filter((c) => c.expect.mode === 'invalid' || c.expect.allowed_versions === null).map((c) => [c.setting, c.raw]),
      ...rejectVerifyCases.filter((c) => !c.node_api_only).map((c) => ['ADMIN_ORIGIN', c.input.expected_origins.join(',')]),
      ['ADMIN_SIG_MIN', 2],
      ['ADMIN_ORIGIN', 1],
    ];
    assert.ok(invalid.length >= 25);
    const routes = [...adminRoutes.map((r) => [r.method, r.path]), ['PUT', '/admin/conferences'], ['GET', '/admin/stats'], ['GET', '/admin/no-such-route']];
    for (const [setting, raw] of invalid) {
      const { env, received } = stubEnv({ [setting]: raw, ADMIN_TEST_ROUTES: '1' });
      const ip = freshIp();
      for (const [method, path] of routes) {
        for (const version of [1, 2]) {
          const body = method === 'GET' || method === 'DELETE' ? undefined : '{}';
          const r = await call(env, signedRequest(method, `${path}?event=${SLUG}`, { version, body, ip }).req);
          const why = `${setting}=${JSON.stringify(raw)} v${version} ${method} ${path}`;
          assert.deepEqual([r.status, r.json, r.reads, r.hmac, r.compare], [404, NOT_FOUND, [], 0, 0], why);
          assert.deepEqual(r.logs, [`admin config invalid: ${setting}`], why);
        }
      }
      // An unsigned request is refused the same way.
      const bare = await call(env, new Request(`${CUSTOM}${STATS}`, { headers: { 'CF-Connecting-IP': ip } }));
      assert.deepEqual([bare.status, bare.logs], [404, [`admin config invalid: ${setting}`]]);
      assert.equal(received.length, 0);
      // None of those took a token: with the setting fixed, the same address is served at once.
      const fixed = await call(stubEnv().env, signedRequest('GET', STATS, { ip }).req);
      assert.deepEqual([fixed.status, fixed.logs.filter(configLine)], [200, []], `${setting}=${JSON.stringify(raw)}: the bucket was charged`);
    }
    // The public API does not read either setting.
    const { env } = stubEnv({ ADMIN_ORIGIN: ',', ADMIN_SIG_MIN: '' });
    const health = await call(env, new Request(`${CUSTOM}/api/health`, { headers: { 'CF-Connecting-IP': freshIp() } }));
    assert.equal(health.logs.length, 0);
    // An Origin header is still refused first, before the configuration is read.
    const origin = await call(env, signedRequest('GET', STATS, { headers: { Origin: CUSTOM } }).req);
    assert.deepEqual([origin.status, origin.logs.filter(configLine)], [404, []]);
  });

  test('ADMIN_SIG_MIN "2" refuses v1 as a malformed header, without an HMAC or a charge; v2 passes', async () => {
    const { env, received } = stubEnv({ ADMIN_SIG_MIN: '2' });
    const ip = freshIp();
    for (let i = 0; i < 12; i++) {
      const r = await call(env, signedRequest('GET', STATS, { version: 1, ip }).req);
      assert.deepEqual([r.status, r.json, r.hmac, r.reads], [404, NOT_FOUND, 0, []]);
    }
    const post = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { version: 1, body: BODY, ip }).req);
    assert.deepEqual([post.status, post.hmac, post.reads], [404, 0, []]);
    assert.equal(received.length, 0);
    assert.equal((await call(env, signedRequest('GET', STATS, { ip }).req)).status, 200);
  });

  test('ADMIN_SIG_MIN unset or "1" accepts v1 and v2', async () => {
    for (const vars of [{}, { ADMIN_SIG_MIN: '1' }, { ADMIN_SIG_MIN: undefined }]) {
      const { env, received } = stubEnv(vars);
      for (const version of [1, 2]) {
        const r = await call(env, signedRequest('POST', `/admin/talks?event=${SLUG}`, { version, body: BODY }).req);
        assert.deepEqual([r.status, r.hmac, r.compare], [200, 1, 2], `${JSON.stringify(vars)} v${version}`);
      }
      assert.equal(received.length, 2);
    }
  });

  test('a v1 header cannot carry a v2 signature, nor a v2 header a v1 signature: 404, charged', async () => {
    const { env, received } = stubEnv();
    const ip = freshIp();
    for (const [headerVersion, signedVersion] of [[1, 2], [2, 1], [1, 2], [2, 1], [1, 2]]) {
      const header = crossHeader({ headerVersion, signedVersion, method: 'GET', pathWithQuery: STATS });
      const r = await call(env, new Request(`${CUSTOM}${STATS}`, { headers: { 'X-Caddie-Admin': header, 'CF-Connecting-IP': ip } }));
      assert.deepEqual([r.status, r.json, r.hmac, r.compare], [404, NOT_FOUND, 1, 1], `v${headerVersion} header, v${signedVersion} signature`);
    }
    // The control: each header over its own canonical string passes.
    for (const v of [1, 2]) {
      const header = crossHeader({ headerVersion: v, signedVersion: v, method: 'GET', pathWithQuery: STATS, nonce: `${v}`.repeat(22) });
      assert.equal((await call(env, new Request(`${CUSTOM}${STATS}`, { headers: { 'X-Caddie-Admin': header, 'CF-Connecting-IP': freshIp() } }))).status, 200);
    }
    assert.equal(received.length, 2);
    // The five failures above took five tokens.
    const r = await bucketTaken(env, ip, 6);
    assert.deepEqual([r.status, r.hmac], [404, 0]);
  });
});

describe('the nonce table with v2', { skip }, () => {
  // The Worker's environment with real objects on node:sqlite.
  function realEnv(vars = {}) {
    const CONFERENCE = namespace(() => new ConferenceDO(fakeState(), { EMBED_FAKE: '1' }));
    const DIRECTORY = namespace(() => new DirectoryDO(fakeState(), {}));
    return { ADMIN_TOKEN: KEY, EMBED_FAKE: '1', ...vars, CONFERENCE, DIRECTORY };
  }
  const conf = { slug: SLUG, name: SLUG, status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC' };

  test('a v2 replay is refused by the nonce table, and v1 and v2 share it', async () => {
    const env = realEnv();
    const send = (s) => call(env, new Request(s.url, { method: s.method, headers: { 'X-Caddie-Admin': s.header, 'CF-Connecting-IP': freshIp(), 'Content-Type': 'application/json' }, body: s.body }));
    const sign = (method, path, opts = {}) => ({ ...signAdminRequest({ method, path, base: CUSTOM, key: KEY, version: 2, ...opts }), body: opts.body });

    const put = sign('PUT', '/admin/conferences', { body: JSON.stringify({ conferences: [conf] }) });
    assert.equal((await send(put)).status, 200);
    const again = await send(put);
    assert.deepEqual([again.status, again.json], [401, { error: 'admin_replay' }]);

    const stats = sign('GET', STATS);
    assert.equal((await send(stats)).status, 200);
    for (let i = 0; i < 2; i++) assert.deepEqual(await send(stats).then((r) => [r.status, r.json]), [401, { error: 'admin_replay' }]);

    // One nonce, signed once as v1 and once as v2: the second is a replay, in either order.
    for (const [first, second] of [[1, 2], [2, 1]]) {
      const nonce = `${first}${second}`.repeat(11);
      assert.equal((await send(sign('GET', STATS, { nonce, version: first }))).status, 200);
      const r = await send(sign('GET', STATS, { nonce, version: second }));
      assert.deepEqual([r.status, r.json], [401, { error: 'admin_replay' }], `v${first} then v${second}`);
    }
  });
});
