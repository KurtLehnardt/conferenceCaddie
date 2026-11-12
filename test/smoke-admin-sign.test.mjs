// The admin-auth plumbing of scripts/smoke.mjs: every admin call carries an X-Caddie-Admin header
// that verifies with scripts/lib/admin-sign.mjs and no Authorization header; the signature is v2,
// bound to the stub's origin, by default (CADDIE_ADMIN_SIG_VERSION unset or empty) and v1 with
// CADDIE_ADMIN_SIG_VERSION=1, and any other value exits 2 before any request; a retried admin call
// is signed afresh (a new nonce); bearer mode is gone, so SMOKE_ADMIN_AUTH=bearer is a config FAIL
// and no request ever carries Authorization; with a token, an API_BASE (or BASE_URL) that
// canonicalOrigin refuses as typed is a config FAIL before any request; and when the Worker's
// /admin/test/* fixtures answer 404 while GET /admin/stats works, the checks that need them print
// SKIP naming ADMIN_TEST_ROUTES.
//
// Run with `npm test`. The smoke runs as a child process against a loopback stub that answers
// 404 to everything it does not know, so most of its checks fail here; only the admin lines
// matter. Nothing reaches the network: BASE_URL, API_BASE and SMOKE_BUNDLE_BASE all point at the
// stub, the bundle scan and the one external GET are skipped, and the stub records every request.
// The token is a dummy value that the test asserts never appears in the output.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capabilitiesDocument } from '../worker/src/capabilities.js';
import { EMPTY_BODY_SHA256, HEADER_RE, HEADER_RE_V2, verifyAdminSignature } from '../scripts/lib/admin-sign.mjs';
import * as BLE from '../contracts/js/ble-token.mjs';

const SMOKE = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));
const TOKEN = 'smoke-test-admin-token-0123456789abcdef0123456789abcdef';
const PRIMARY = 'kubecon-cloudnativecon-north-america-2026';
const CIRCLE_TALK_TITLE = 'From Bytes to Traces: A Deep Dive into OpenTelemetry eBPF Instrumentation Internals';
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// A stub Worker: /api/health is healthy, /admin/stats answers counts to an authenticated caller,
// /admin/test/* is gated (404), the first authenticated admin request answers 503 once, and
// everything else is 404. Every request is recorded with its auth headers and the stub's own origin
// (stubOrigin), the one origin a v2 signature must be bound to, as on the Worker without
// ADMIN_ORIGIN.
function stubWorker({ authOk }) {
  const requests = [];
  let failedOnce = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stub');
      const record = {
        method: req.method,
        path: url.pathname + url.search,
        body: body.toString('utf8'),
        authorization: req.headers.authorization ?? null,
        signed: req.headers['x-caddie-admin'] ?? null,
        origin: req.headers.origin ?? null,
        stubOrigin: `http://127.0.0.1:${server.address().port}`,
      };
      requests.push(record);
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      // The people checks start by finding the circle talk; without it they never reach p1b.
      if (url.pathname === '/api/search' && req.method === 'POST') return json(res, 200, { results: [{ talk_id: `${PRIMARY}:circle`, title: CIRCLE_TALK_TITLE, conference: PRIMARY }] });
      // A profile write must succeed, or the people block stops before the presence checks (q7).
      if (url.pathname === '/api/people/profile' && req.method === 'PUT') {
        let shared = [];
        try { shared = JSON.parse(body.toString('utf8')).shared_talk_ids ?? []; } catch { /* keep [] */ }
        return json(res, 200, { ok: true, ref: randomBytes(8).toString('hex'), shared_talk_ids: shared });
      }
      if (url.pathname.startsWith('/admin/')) {
        if (record.origin !== null || !authOk(record)) return json(res, 404, { error: 'Not found' });
        if (!failedOnce) {
          failedOnce = true;
          record.answered = 503;
          return json(res, 503, { error: 'try again' });
        }
        if (url.pathname.startsWith('/admin/test/')) return json(res, 404, { error: 'Not found' });
        if (url.pathname === '/admin/stats') return json(res, 200, { usage: { day: '2099-01-01', requests: 1, rows_read: 1, rows_written: 1 }, talks: 0, people: 0 });
        if (url.pathname === '/admin/moderation' && req.method === 'POST') return json(res, 200, { ok: true });
        return json(res, 404, { error: 'Not found' });
      }
      return json(res, 404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

// The stub's verifier, as the Worker's with ADMIN_ORIGIN unset: v1 or v2, a v2 signature bound to
// the stub's own origin. verifyOn names the versions and origins for a narrower check.
const verifyOn = (r, { versions = [1, 2], origins = [r.stubOrigin] } = {}) => verifyAdminSignature({ headerValue: r.signed, method: r.method, pathWithQuery: r.path, keys: [TOKEN], allowedVersions: versions, expectedOrigins: origins });
const signedOk = (r) => r.signed !== null && verifyOn(r).ok;
const versionOf = (r) => (HEADER_RE_V2.test(r.signed ?? '') ? 2 : HEADER_RE.test(r.signed ?? '') ? 1 : null);

function runSmoke(port, extraEnv) {
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BASE_URL: `http://127.0.0.1:${port}`,
      SMOKE_API: 'worker',
      ADMIN_TOKEN: TOKEN,
      SMOKE_SKIP_BUNDLE: '1',
      SMOKE_SKIP_EXTERNAL: '1',
      SMOKE_TALKS: 'data',
      SMOKE_BUNDLE_BASE: `http://127.0.0.1:${port}/bundles/`,
      SMOKE_UNAVAILABLE: PRIMARY,
      // The loopback stub stands for a deployed Worker unless a test says otherwise (SMOKE_TREAT_AS_REMOTE is
      // test-only): a gated fixture is a SKIP there and a FAIL with a hint against a local one.
      SMOKE_TREAT_AS_REMOTE: '1',
      ...extraEnv,
    };
    const child = spawn(process.execPath, [SMOKE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, lines: stdout.split('\n') }));
  });
}

// The smoke's own admin() calls: authenticated with the real token and without an Origin header.
// adm1's probes (no auth, a wrong key, the real key with an Origin header) are not among them.
const authed = (requests) => requests.filter((r) => r.path.startsWith('/admin/') && (r.signed !== null || r.authorization !== null));
const adminCalls = (requests, ok) => authed(requests).filter((r) => r.origin === null && ok(r));
const wrongKeyProbes = (requests, ok) => authed(requests).filter((r) => r.origin === null && !ok(r));
const skipLine = (lines, check) => lines.find((l) => l.startsWith(`SKIP ${check}:`));

describe('scripts/smoke.mjs admin auth', { timeout: 300_000 }, () => {
  let v2;
  let v1;
  before(async () => {
    // The two runs are independent, each with its own stub, so they run at once: the default
    // (CADDIE_ADMIN_SIG_VERSION unset) and the rollback to v1.
    const [a, b] = await Promise.all([stubWorker({ authOk: signedOk }), stubWorker({ authOk: signedOk })]);
    const [ra, rb] = await Promise.all([
      runSmoke(a.port, {}),
      runSmoke(b.port, { CADDIE_ADMIN_SIG_VERSION: '1' }),
    ]);
    v2 = { ...ra, requests: a.requests, server: a.server };
    v1 = { ...rb, requests: b.requests, server: b.server };
  });
  after(() => {
    v2?.server.close();
    v1?.server.close();
  });

  test('the run reached the admin checks and finished', () => {
    for (const run of [v2, v1]) {
      assert.ok(run.lines.some((l) => l.startsWith('PASS adm1:')), run.lines.filter((l) => l.includes('adm1')).join('\n'));
      assert.ok(run.lines.some((l) => l.startsWith('PASS p0:')), 'the people checks ran');
      assert.ok(adminCalls(run.requests, signedOk).length >= 3, 'the smoke made admin calls');
      assert.equal(run.code, 1, 'most checks fail against the stub');
    }
  });

  test('SMK-1: every admin call carries X-Caddie-Admin, verified by the stub, and no Authorization', () => {
    for (const run of [v2, v1]) {
      const calls = adminCalls(run.requests, signedOk);
      for (const r of calls) {
        assert.equal(r.authorization, null, `${r.method} ${r.path} carries an Authorization header`);
        const v = verifyOn(r);
        assert.equal(v.ok, true, `${r.method} ${r.path}: ${v.reason}`);
        // The header's body hash is the hash of the bytes the stub received.
        assert.equal(v.bodySha256, r.body.length === 0 ? EMPTY_BODY_SHA256 : createHash('sha256').update(r.body, 'utf8').digest('hex'));
        if (['GET', 'HEAD', 'DELETE'].includes(r.method)) assert.equal(r.body, '');
      }
      assert.ok(calls.some((r) => r.method === 'POST' && r.body.length > 0), 'a signed POST with a body');
      // adm1's three probes: no auth, a wrong key (exactly one signed header that does not verify,
      // sent before any call with the real key), and the real key with an Origin header.
      assert.ok(run.requests.some((r) => r.path.startsWith('/admin/stats') && r.signed === null && r.authorization === null), 'a probe without auth');
      const wrong = wrongKeyProbes(run.requests, signedOk);
      assert.equal(wrong.length, 1, 'exactly one request signed with a wrong key');
      assert.equal(`${wrong[0].method} ${wrong[0].path.split('?')[0]}`, 'GET /admin/stats');
      assert.equal(verifyOn(wrong[0]).reason, 'signature');
      assert.ok(run.requests.indexOf(wrong[0]) < run.requests.indexOf(calls[0]), 'the wrong-key probe comes before the first real call');
      assert.ok(authed(run.requests).some((r) => r.origin !== null && signedOk(r)), 'a probe with the real key and an Origin header');
    }
  });

  test('the default signs v2, bound to the origin of API_BASE: another origin does not verify', () => {
    const signed = v2.requests.filter((r) => r.signed !== null);
    assert.ok(signed.length >= 5);
    // Every signed request, the probes included, is v2.
    for (const r of signed) assert.equal(versionOf(r), 2, r.signed.split(' ')[0]);
    const other = `http://127.0.0.1:${v1.server.address().port}`;
    for (const r of adminCalls(v2.requests, signedOk)) {
      const v = verifyOn(r, { versions: [2] });
      assert.equal(v.ok, true, `${r.method} ${r.path}: ${v.reason}`);
      assert.equal(v.origin, r.stubOrigin);
      // The same header for any other origin (another port, localhost for 127.0.0.1, https) is a
      // plain signature failure, and a v1-only verifier reads it as malformed.
      for (const origin of [other, r.stubOrigin.replace('127.0.0.1', 'localhost'), r.stubOrigin.replace('http:', 'https:')]) {
        assert.equal(verifyOn(r, { versions: [2], origins: [origin] }).reason, 'signature', origin);
      }
      assert.equal(verifyOn(r, { versions: [1] }).reason, 'malformed');
    }
  });

  test('CADDIE_ADMIN_SIG_VERSION=1 signs every admin call v1, the rollback until step d, and says so once', () => {
    // The rollback is never silent: one NOTE that v1 is not bound to a host and that the variable
    // must be unset afterwards. The default run prints none.
    const notes = (run) => run.lines.filter((l) => l.startsWith('NOTE CADDIE_ADMIN_SIG_VERSION=1:'));
    assert.equal(notes(v1).length, 1, v1.stdout);
    assert.match(notes(v1)[0], /signed with v1, which is not bound to a host/);
    assert.match(notes(v1)[0], /unset CADDIE_ADMIN_SIG_VERSION as soon as the rollback is over/);
    assert.ok(v1.lines.indexOf(notes(v1)[0]) < v1.lines.findIndex((l) => /^(PASS|FAIL|SKIP) /.test(l)), 'before the first check');
    assert.equal(notes(v2).length, 0);
    const signed = v1.requests.filter((r) => r.signed !== null);
    assert.ok(signed.length >= 5);
    for (const r of signed) assert.equal(versionOf(r), 1, r.signed.split(' ')[0]);
    for (const r of adminCalls(v1.requests, signedOk)) {
      const v = verifyOn(r, { versions: [1] });
      assert.equal(v.ok, true, `${r.method} ${r.path}: ${v.reason}`);
      assert.equal(v.version, undefined, 'a v1 result has the v1 shape');
      // A v2-only verifier (step d) reads it as malformed.
      assert.equal(verifyOn(r, { versions: [2] }).reason, 'malformed');
    }
  });

  test('SMK-1: a retried admin call is signed afresh with a new nonce, never resent', () => {
    for (const run of [v2, v1]) {
      const failed = run.requests.find((r) => r.answered === 503);
      assert.ok(failed, 'the stub failed one admin call');
      const retry = run.requests.find((r) => r !== failed && r.method === failed.method && r.path === failed.path && signedOk(r));
      assert.ok(retry, 'the call was retried');
      assert.notEqual(retry.signed, failed.signed);
      assert.notEqual(retry.signed.split(' ')[2], failed.signed.split(' ')[2], 'a different nonce');
      assert.equal(versionOf(retry), versionOf(failed), 'the retry signs the same version');
      assert.ok(run.lines.some((l) => l.startsWith('NOTE ') && l.includes('answered 503 on the first attempt; retrying once')));
    }
  });

  test('bearer mode is gone: no request of either run carries an Authorization header', () => {
    for (const run of [v2, v1]) {
      assert.ok(run.requests.length > 20);
      assert.ok(run.requests.every((r) => r.authorization === null), 'no request carries Authorization');
    }
  });

  test('SMK-2: gated /admin/test/* routes make meter1, the expired profile, the aged presence and unav1 print SKIP naming ADMIN_TEST_ROUTES', () => {
    for (const run of [v2, v1]) {
      // q8b ages a presence too, but against this stub it stops earlier (no profile gets a ref),
      // so only q7 stands for the aged presence here.
      for (const check of ['meter1', 'p1b', 'p7', 'q7', 'unav1']) {
        const line = skipLine(run.lines, check);
        assert.ok(line, `no SKIP for ${check}:\n${run.lines.filter((l) => l.includes(`${check}:`)).join('\n')}`);
        assert.ok(line.includes('ADMIN_TEST_ROUTES'), line);
        assert.ok(!run.lines.some((l) => l.startsWith(`FAIL ${check}:`)), `${check} also failed`);
      }
      // The gate was decided from GET /admin/stats answering 200 after the first fixture 404, and
      // no fixture write was attempted after that: one profile write at most (the gated one).
      const fixtureWrites = run.requests.filter((r) => r.path.startsWith('/admin/test/profile') && r.method === 'POST');
      assert.ok(fixtureWrites.length <= 1);
      // The expired profile's cleanup (DELETE /admin/test/profile) is not sent when it was never written.
      assert.ok(!run.requests.some((r) => r.path.startsWith('/admin/test/profile') && r.method === 'DELETE'));
    }
  });

  test('SEC-3: the token never appears in the output or in any request', () => {
    for (const run of [v2, v1]) {
      assert.ok(!run.stdout.includes(TOKEN));
      assert.ok(!run.stderr.includes(TOKEN));
      for (const r of run.requests) {
        assert.ok(!(r.signed ?? '').includes(TOKEN));
        assert.ok(!r.path.includes(TOKEN));
        assert.ok(!r.body.includes(TOKEN));
      }
    }
  });

  test('SEC-16: GET and DELETE admin calls carry no body', () => {
    for (const run of [v2, v1]) {
      for (const r of adminCalls(run.requests, signedOk)) {
        if (['GET', 'HEAD', 'DELETE'].includes(r.method)) assert.equal(r.body, '');
      }
    }
  });
});

test('an empty CADDIE_ADMIN_SIG_VERSION counts as unset: v2, and no Authorization', async () => {
  const { server, requests, port } = await stubWorker({ authOk: signedOk });
  try {
    await runSmoke(port, { CADDIE_ADMIN_SIG_VERSION: '', SMOKE_ADMIN_AUTH: 'signed' });
    const calls = adminCalls(requests, signedOk);
    assert.ok(calls.length >= 3);
    assert.ok(requests.filter((r) => r.signed !== null).every((r) => versionOf(r) === 2));
    assert.ok(requests.every((r) => r.authorization === null));
  } finally {
    server.close();
  }
});

test('CADDIE_ADMIN_SIG_VERSION other than unset, empty, "1" or "2" exits 2 before any request', async () => {
  const { server, requests, port } = await stubWorker({ authOk: signedOk });
  try {
    for (const raw of ['3', ' 2', 'v2', '1 ']) {
      const run = await runSmoke(port, { CADDIE_ADMIN_SIG_VERSION: raw });
      assert.equal(run.code, 2, JSON.stringify(raw));
      assert.ok(run.stdout.includes('FAIL config: CADDIE_ADMIN_SIG_VERSION must be exactly "1" or "2" when it is set'), run.stdout);
      assert.equal(requests.length, 0, JSON.stringify(raw));
    }
  } finally {
    server.close();
  }
});

// The raw API base goes through canonicalOrigin before any URL parsing: a full-width digit or a
// user name that new URL() would map or drop, landing on the stub's own origin, is refused before
// any request, with a token and against the Worker without one (adm1 signs a probe there), so
// nothing is signed for a host the operator did not type.
test('an API_BASE or BASE_URL that canonicalOrigin refuses as typed is a config FAIL before any request, with or without a token', async () => {
  const { server, requests, port } = await stubWorker({ authOk: signedOk });
  try {
    const wide = `http://\uff11\uff12\uff17.0.0.1:${port}`;
    const user = `http://smoke@127.0.0.1:${port}`;
    assert.equal(new URL(wide).origin, `http://127.0.0.1:${port}`, 'the URL parser maps it to the stub');
    for (const env of [{ API_BASE: wide }, { API_BASE: user }, { BASE_URL: wide }, { BASE_URL: `${user}/app` }, { API_BASE: `http://127.0.0.%31:${port}` }, { API_BASE: wide, ADMIN_TOKEN: '' }, { BASE_URL: wide, ADMIN_TOKEN: '' }]) {
      const run = await runSmoke(port, env);
      assert.equal(run.code, 1, JSON.stringify(env));
      assert.ok(run.lines.some((l) => l.startsWith('FAIL config: ') && l.includes("must be the Worker's origin as plain ASCII")), `${JSON.stringify(env)}\n${run.stdout}`);
      assert.equal(requests.length, 0, JSON.stringify(env));
      assert.ok(!run.stdout.includes('smoke@') && !run.stdout.includes('\uff11'), 'the value is not echoed');
    }
    // The same base typed plainly runs, signed for the stub's origin.
    const ok = await runSmoke(port, { API_BASE: `HTTP://127.0.0.1:${port}/` });
    assert.ok(ok.lines.some((l) => l.startsWith('PASS adm1:')), ok.stdout);
    assert.ok(adminCalls(requests, signedOk).length >= 3);
  } finally {
    server.close();
  }
});

test('gated fixtures FAIL with the .dev.vars hint against a loopback API, and SKIP against a deployed one', async () => {
  const { server, port } = await stubWorker({ authOk: signedOk });
  try {
    const local = await runSmoke(port, { SMOKE_TREAT_AS_REMOTE: '' });
    const hint = 'set ADMIN_TEST_ROUTES=1 in worker/.dev.vars (or run npm --prefix worker run dev-vars, which adds it when absent)';
    for (const check of ['meter1', 'p1b', 'p7', 'q7', 'unav1']) {
      const fail = local.lines.find((l) => l.startsWith(`FAIL ${check}:`));
      assert.ok(fail?.includes(hint), `${check} must FAIL with the hint:\n${local.lines.filter((l) => l.includes(`${check}:`)).join('\n')}`);
      assert.ok(!skipLine(local.lines, check), `${check} must not SKIP against a loopback API`);
    }
    assert.ok(!local.lines.some((l) => l.includes('SMOKE_TREAT_AS_REMOTE')), 'no NOTE when the override is off');
    const remote = await runSmoke(port, {});
    assert.ok(remote.lines.includes('NOTE SMOKE_TREAT_AS_REMOTE=1: a loopback API counts as deployed'), 'the override prints its NOTE');
    for (const check of ['meter1', 'p1b', 'p7', 'q7', 'unav1']) {
      assert.ok(skipLine(remote.lines, check)?.includes('ADMIN_TEST_ROUTES'), `${check} must SKIP against a deployed Worker`);
      assert.ok(!remote.lines.some((l) => l.startsWith(`FAIL ${check}:`)));
    }
  } finally {
    server.close();
  }
});

// A redirect on an API request (api(); the stub redirects /api/search) is never followed either: the target is never called and
// the check FAILs naming 302.
test('a 302 on an API request is a FAIL naming 302, never followed or retried', async () => {
  const other = await stubWorker({ authOk: () => true });
  const { server, port } = await stubWorker({ authOk: signedOk });
  const base = server.listeners('request')[0];
  server.removeAllListeners('request');
  let searches = 0;
  server.on('request', (req, res) => {
    if (req.url.startsWith('/api/search')) {
      searches++;
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}${req.url}` });
      return res.end('moved');
    }
    return base(req, res);
  });
  try {
    const run = await runSmoke(port, {});
    assert.equal(other.requests.length, 0, 'the redirect target was called');
    assert.ok(run.lines.some((l) => l.startsWith('FAIL ') && l.includes('answered 302')), 'a FAIL names 302');
    assert.ok(!run.lines.some((l) => l.startsWith('NOTE ') && l.includes('/api/search')), 'no retry NOTE for the redirect');
    assert.ok(searches > 0);
  } finally {
    server.close();
    other.server.close();
  }
});

// cap1 compares the Worker's bundle_base with the configured base (SMOKE_BUNDLE_BASE, then
// CADDIE_BUNDLE_BASE, then the default), so a fork with its own TALKS_BUNDLE_BASE passes.
describe('cap1 and the configured bundle base', { timeout: 120_000 }, () => {
  const OWN = 'https://fork.example.github.io/caddie-fork/bundles/';
  const OTHER = 'https://other.example.github.io/x/bundles/';
  const DEFAULT = 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
  async function run(advertised, env) {
    const { server, port } = await stubWorker({ authOk: signedOk });
    const base = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/api/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify(capabilitiesDocument({ TALKS_BUNDLE_BASE: advertised })));
      }
      return base(req, res);
    });
    try {
      const r = await runSmoke(port, { SMOKE_BUNDLE_BASE: '', ...env });
      return { ...r, cap1: r.lines.find((l) => /^(PASS|FAIL) cap1:/.test(l)) };
    } finally {
      server.close();
    }
  }
  test('SMOKE_BUNDLE_BASE is the expected base', async () => {
    const r = await run(OWN, { SMOKE_BUNDLE_BASE: OWN });
    assert.ok(r.cap1?.startsWith('PASS cap1:'), r.cap1);
  });
  test('CADDIE_BUNDLE_BASE is used when SMOKE_BUNDLE_BASE is not set', async () => {
    const r = await run(OWN, { CADDIE_BUNDLE_BASE: OWN });
    assert.ok(r.cap1?.startsWith('PASS cap1:'), r.cap1);
  });
  test('cap1 order: SMOKE_CAPS_BUNDLE_BASE, then CADDIE_BUNDLE_BASE, then an https SMOKE_BUNDLE_BASE', async () => {
    const a = await run(OWN, { SMOKE_CAPS_BUNDLE_BASE: OWN, CADDIE_BUNDLE_BASE: OTHER, SMOKE_BUNDLE_BASE: OTHER });
    assert.ok(a.cap1?.startsWith('PASS cap1:'), a.cap1);
    const b = await run(OWN, { CADDIE_BUNDLE_BASE: OWN, SMOKE_BUNDLE_BASE: OTHER });
    assert.ok(b.cap1?.startsWith('PASS cap1:'), b.cap1);
  });
  test('an http loopback SMOKE_BUNDLE_BASE does not make cap1 fail: the Worker advertises https', async () => {
    const r = await run(DEFAULT, { SMOKE_BUNDLE_BASE: 'http://127.0.0.1:9/bundles/' });
    assert.ok(r.cap1?.startsWith('PASS cap1:'), r.cap1);
    const caps = await run(OWN, { SMOKE_BUNDLE_BASE: 'http://127.0.0.1:9/bundles/', SMOKE_CAPS_BUNDLE_BASE: OWN });
    assert.ok(caps.cap1?.startsWith('PASS cap1:'), caps.cap1);
  });
  test('a base that differs from the Worker\'s FAILs cap1 naming bundle_base', async () => {
    const r = await run(OWN, { SMOKE_BUNDLE_BASE: OTHER });
    assert.ok(r.cap1?.startsWith('FAIL cap1:') && r.cap1.includes('bundle_base'), r.cap1);
  });
  test('with nothing configured the default is expected', async () => {
    const r = await run(DEFAULT, {});
    assert.ok(r.cap1?.startsWith('PASS cap1:'), r.cap1);
    const fork = await run(OWN, {});
    assert.ok(fork.cap1?.startsWith('FAIL cap1:') && fork.cap1.includes('SMOKE_CAPS_BUNDLE_BASE'), fork.cap1);
  });
  test('the default base against a remote API prints one NOTE naming SMOKE_BUNDLE_BASE; a configured base prints none', async () => {
    const note = (r) => r.lines.filter((l) => l.startsWith('NOTE the default bundle base is used against a remote API'));
    const remote = await run(DEFAULT, {});
    assert.equal(note(remote).length, 1);
    assert.ok(note(remote)[0].includes('SMOKE_BUNDLE_BASE'));
    assert.equal(note(await run(OWN, { SMOKE_BUNDLE_BASE: OWN })).length, 0);
    assert.equal(note(await run(OWN, { CADDIE_BUNDLE_BASE: OWN })).length, 0);
    assert.equal(note(await run(DEFAULT, { SMOKE_TREAT_AS_REMOTE: '' })).length, 0, 'a loopback API prints none');
  });
});

test('SMOKE_ADMIN_AUTH refuses an unknown value before any request', async () => {
  const { server, requests, port } = await stubWorker({ authOk: () => false });
  try {
    const run = await runSmoke(port, { SMOKE_ADMIN_AUTH: 'basic' });
    assert.equal(run.code, 1);
    assert.ok(run.stdout.includes('FAIL config: SMOKE_ADMIN_AUTH must be signed (or unset)'));
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

// Bearer mode sent the raw token in Authorization to whatever host API_BASE named; it is removed,
// and asking for it is a config FAIL before any request, never a silent fallback to signing.
test('SMOKE_ADMIN_AUTH=bearer is a config FAIL before any request: bearer mode is removed', async () => {
  const { server, requests, port } = await stubWorker({ authOk: () => true });
  try {
    for (const value of ['bearer', 'Bearer']) {
      const run = await runSmoke(port, { SMOKE_ADMIN_AUTH: value });
      assert.equal(run.code, 1);
      assert.ok(run.stdout.includes('FAIL config: SMOKE_ADMIN_AUTH=bearer was removed'), run.stdout);
      assert.ok(!run.stdout.includes(TOKEN));
      assert.equal(requests.length, 0);
    }
  } finally {
    server.close();
  }
});

test('a token shorter than 32 characters is refused before any request', async () => {
  const { server, requests, port } = await stubWorker({ authOk: () => false });
  try {
    const run = await runSmoke(port, { SMOKE_ADMIN_AUTH: 'signed', ADMIN_TOKEN: 'short-token' });
    assert.equal(run.code, 1);
    assert.ok(run.stdout.includes('FAIL config: the admin token must have at least 32 characters'));
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

// SEC: an admin request never follows a redirect. The stub answers every /admin/ request with a 302
// to a second loopback server (another origin); a followed redirect would carry X-Caddie-Admin and
// the signed body there. The second server must never be called, the check must FAIL naming 302, and
// the 3xx must never be retried (no NOTE line, and no second request for the same signed call).
for (const [mode, env] of [['v2', {}], ['v1', { CADDIE_ADMIN_SIG_VERSION: '1' }]]) {
  test(`a 302 from the API on an admin request is a FAIL naming 302, never followed or retried (${mode})`, async () => {
    const other = await stubWorker({ authOk: () => true });
    const { server, requests, port } = await stubWorker({ authOk: signedOk });
    const base = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url.startsWith('/admin/') && req.headers['x-caddie-admin'] && !req.headers.origin) {
        requests.push({ method: req.method, path: req.url, signed: req.headers['x-caddie-admin'] ?? null, authorization: req.headers.authorization ?? null, origin: null, redirected: true });
        res.writeHead(302, { location: `http://127.0.0.1:${other.port}${req.url}` });
        return res.end('moved');
      }
      return base(req, res);
    });
    try {
      const run = await runSmoke(port, env);
      assert.equal(other.requests.length, 0, `the redirect target was called: ${JSON.stringify(other.requests.map((r) => r.path))}`);
      const fails = run.lines.filter((l) => l.startsWith('FAIL ') && /\b302\b/.test(l));
      assert.ok(fails.length > 0, 'a FAIL line names 302');
      assert.ok(run.lines.some((l) => l.startsWith('FAIL ') && l.includes('answered 302')), 'admin() fails naming 302');
      assert.ok(!run.lines.some((l) => l.startsWith('NOTE ') && l.includes('(admin)')), 'no admin retry NOTE');
      const redirected = requests.filter((r) => r.redirected && r.origin === null);
      const nonces = redirected.map((r) => r.signed);
      assert.ok(redirected.length > 0);
      assert.ok(redirected.every((r) => r.signed.startsWith(`${mode} `) && r.authorization === null), 'the version asked for, and no Authorization');
      assert.equal(new Set(nonces).size, nonces.length, 'no signed header was sent twice');
      assert.ok(!run.stdout.includes(TOKEN));
    } finally {
      server.close();
      other.server.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The Bluetooth checks (cap3, ble0 to ble3 and the key part of l) against a tier 3 stub: an
// in-memory stand-in built on the reference implementation (contracts/js/ble-token.mjs) that mints
// keys, keeps a w-1..w+1 token table, applies zone co-location and the caps, and answers 404 to
// everything else. Its window is a day rather than 600 s, so ble3 never waits for a window boundary
// in a test (cap3 then fails on window_s, which these tests do not look at).

const BLE_WINDOW_S = 86_400;

function stubTier3({ mode = 'derived-v1', fault = '' } = {}) {
  const devices = new Map();
  let lastKey = null;
  const dev = (id) => {
    if (!devices.has(id)) devices.set(id, { name: null, ref: createHash('sha256').update(String(id)).digest('hex').slice(0, 16), presence: null, caps: { entries: [] } });
    return devices.get(id);
  };
  const iso = (ms) => new Date(ms).toISOString();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep {} */ }
      const url = new URL(req.url, 'http://stub');
      const p = url.pathname;
      const device = req.headers['x-caddie-device'] ?? '';
      const now = Date.now();
      if (p === '/api/health') return json(res, 200, { ok: true });
      if (p === '/api/search' && req.method === 'POST') return json(res, 200, { results: [{ talk_id: `${PRIMARY}:circle`, title: CIRCLE_TALK_TITLE, conference: PRIMARY }] });
      if (p === '/api/capabilities') {
        return json(res, 200, {
          api_version: 1, tier: 'paid', talks: { bundle_base: 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/', server_search: true },
          people: { enabled: true, semantic: 'server', presence: true, gps_bands: true, meets: true, circles: true, reports: true, live: 'poll' },
          ble: { mode, service_uuid: BLE.SERVICE_UUID, near_rssi: -75, window_s: BLE_WINDOW_S, sightings_min_interval_s: 10, colocation_required: true },
          push: { apns: false, fcm: false, webpush: false }, imports: { github: 'server', schedule: 'server' },
        });
      }
      if (p === '/api/people/profile' && req.method === 'PUT') {
        dev(device).name = body.profile?.display_name ?? null;
        return json(res, 200, { ok: true, ref: dev(device).ref, shared_talk_ids: [...new Set(body.shared_talk_ids ?? [])] });
      }
      if (p === '/api/presence' && req.method === 'PUT') {
        const d = dev(device);
        const out = { ok: true, zone: body.zone, spot: body.spot || null, spot_hidden: false, until: 'hour', presence_since: iso(now), presence_until: iso(now + 3_600_000), located: false };
        if (body.ble === true) {
          const key = randomBytes(32);
          d.presence = { zone: body.zone, key, legacy: randomBytes(16).toString('base64url') };
          out.ble = { token: d.presence.legacy, rotate_at: iso(now + 600_000) };
          if (mode === 'derived-v1') {
            out.ble_key = BLE.encodeKey(key);
            out.ble_key_id = BLE.keyId(key);
            lastKey = out.ble_key;
          }
        } else if (body.ble === false) {
          d.presence = null;
        } else if (d.presence) {
          d.presence.zone = body.zone;
        }
        return json(res, 200, out);
      }
      if (p === '/api/presence' && req.method === 'DELETE') {
        dev(device).presence = null;
        // fault 'leak': the answer carries the last key minted, which only its own write may.
        return json(res, 200, fault === 'leak' && lastKey ? { ok: true, note: lastKey } : { ok: true });
      }
      if (p === '/api/presence/sightings' && req.method === 'POST') {
        const d = dev(device);
        if (!d.presence) return json(res, 403, { error: 'ble_required' });
        const w = BLE.windowOf(now / 1000, BLE_WINDOW_S);
        const table = new Map();
        for (const o of devices.values()) {
          if (!o.presence) continue;
          if (mode === 'derived-v1') for (const dw of [-1n, 0n, 1n]) table.set(BLE.encodeToken(BLE.deriveToken(o.presence.key, w + dw)), o);
          table.set(o.presence.legacy, o);
        }
        const hits = [...new Set((body.sightings ?? []).map((s) => table.get(s.token)).filter((o) => o && o !== d))];
        // fault '503': a report in which no token is known gets a 503, never a 200 naming nobody.
        if (fault === '503' && hits.length === 0) return json(res, 503, { error: 'unavailable' });
        // fault 'nocoloc': the co-location rule is missing, so a person in another zone resolves.
        const near = hits.filter((o) => fault === 'nocoloc' || o.presence.zone === d.presence.zone).map((o) => ({ id: o.ref, o }));
        const { kept, state } = BLE.applyCaps(near, d.caps, { nowMs: now, windowS: BLE_WINDOW_S });
        d.caps = state;
        const out = { nearby: kept.map(({ o }) => ({ ref: o.ref, display_name: o.name, evidence: 'x', speak_topics: [], zone: o.presence.zone })) };
        if (mode === 'derived-v1') out.ble_key_id = BLE.keyId(d.presence.key);
        return json(res, 200, out);
      }
      return json(res, 404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A tier 3 run: no admin token, SMOKE_API=cloudrun, and a loopback API unless remote is set, in
// which case ble2 and ble3 skip as they would against a deployed service.
const runTier3 = (port, { remote = false, ...env } = {}) => runSmoke(port, {
  SMOKE_API: 'cloudrun',
  ADMIN_TOKEN: '',
  SMOKE_UNAVAILABLE: '',
  SMOKE_TREAT_AS_REMOTE: remote ? '1' : '',
  ...env,
});
const line = (lines, check) => lines.find((l) => /^(PASS|FAIL|SKIP) /.test(l) && l.slice(5).startsWith(`${check}:`));

describe('scripts/smoke.mjs Bluetooth checks against a tier 3 stub', { timeout: 300_000 }, () => {
  const stubs = [];
  let ok;
  let rotate;
  let fail503;
  let leak;
  let nocoloc;
  before(async () => {
    const [a, b, c, d, e] = await Promise.all([
      stubTier3({ mode: 'derived-v1' }),
      stubTier3({ mode: 'server-rotate' }),
      stubTier3({ mode: 'derived-v1', fault: '503' }),
      stubTier3({ mode: 'derived-v1', fault: 'leak' }),
      stubTier3({ mode: 'derived-v1', fault: 'nocoloc' }),
    ]);
    stubs.push(a, b, c, d, e);
    [ok, rotate, fail503, leak, nocoloc] = await Promise.all([
      runTier3(a.port, { SMOKE_BLE_MODE: 'derived-v1' }),
      runTier3(b.port, { remote: true, SMOKE_BLE_MODE: 'derived-v1' }),
      runTier3(c.port, {}),
      runTier3(d.port, { remote: true }),
      runTier3(e.port, {}),
    ]);
  });
  after(() => {
    for (const s of stubs) s.server.close();
  });

  test('a correct derived-v1 server passes ble0 to ble3 and the key part of l', () => {
    for (const check of ['ble0', 'ble1', 'ble2', 'ble3', 'l']) {
      const l = line(ok.lines, check);
      assert.ok(l?.startsWith('PASS '), `${check}: ${l}`);
    }
    assert.match(line(ok.lines, 'l'), /Bluetooth keys only in the answers that minted them/);
  });

  test('server-rotate with SMOKE_BLE_MODE=derived-v1 FAILs ble0, and ble3 skips', () => {
    assert.ok(line(rotate.lines, 'ble0')?.startsWith('FAIL '), line(rotate.lines, 'ble0'));
    assert.match(line(rotate.lines, 'ble0'), /ble\.mode server-rotate, expected derived-v1/);
    assert.ok(line(rotate.lines, 'ble3')?.startsWith('SKIP '));
  });

  test('a 503 to a sightings report is never read as "nobody"', () => {
    const ble1 = line(fail503.lines, 'ble1');
    const ble3 = line(fail503.lines, 'ble3');
    assert.ok(ble1?.startsWith('FAIL ') && ble1.includes('503'), ble1);
    assert.ok(ble3?.startsWith('FAIL '), ble3);
    for (const what of ['the token of window -2: sightings gave 503', 'the token of window +2: sightings gave 503', 'after the re-key, the old key\'s token: sightings gave 503']) assert.ok(ble3.includes(what), `${what}: ${ble3}`);
  });

  test('ble2 FAILs when a person in another zone resolves (its probe is not hidden behind the cap)', () => {
    const l = line(nocoloc.lines, 'ble2');
    assert.ok(l?.startsWith('FAIL '), l);
    assert.match(l, /a person in Expo hall resolved for a requester in Registration/);
  });

  test('check l FAILs when a minted Bluetooth key comes back in another response', () => {
    const l = line(leak.lines, 'l');
    assert.ok(l?.startsWith('FAIL '), l);
    assert.match(l, /the Bluetooth key minted by BT-presence-ble in /);
  });
});

test('SMOKE_BLE_MODE refuses an unknown value before any request', async () => {
  const { server, port } = await stubTier3();
  try {
    const run = await runTier3(port, { SMOKE_BLE_MODE: 'bogus' });
    assert.equal(run.code, 1);
    assert.ok(run.lines.some((l) => l.startsWith('FAIL config: SMOKE_BLE_MODE must be')), run.stdout.slice(0, 400));
  } finally {
    server.close();
  }
});
