// The admin-auth plumbing of scripts/smoke.mjs: with SMOKE_ADMIN_AUTH=signed every admin call
// carries an X-Caddie-Admin header that verifies with scripts/lib/admin-sign.mjs and no
// Authorization header; a retried admin call is signed afresh (a new nonce); the default, bearer,
// sends Authorization: Bearer as before; and when the Worker's /admin/test/* fixtures answer 404
// while GET /admin/stats works, the checks that need them print SKIP naming ADMIN_TEST_ROUTES.
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
import { EMPTY_BODY_SHA256, verifyAdminSignature } from '../scripts/lib/admin-sign.mjs';

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
// everything else is 404. Every request is recorded with its auth headers.
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

const signedOk = (r) => r.signed !== null && verifyAdminSignature({ headerValue: r.signed, method: r.method, pathWithQuery: r.path, keys: [TOKEN] }).ok;
const bearerOk = (r) => r.authorization === `Bearer ${TOKEN}`;

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
  let signed;
  let bearer;
  before(async () => {
    // The two runs are independent, each with its own stub, so they run at once.
    const [s, b] = await Promise.all([stubWorker({ authOk: signedOk }), stubWorker({ authOk: bearerOk })]);
    const [rs, rb] = await Promise.all([
      runSmoke(s.port, { SMOKE_ADMIN_AUTH: 'signed' }),
      runSmoke(b.port, {}),
    ]);
    signed = { ...rs, requests: s.requests, server: s.server };
    bearer = { ...rb, requests: b.requests, server: b.server };
  });
  after(() => {
    signed?.server.close();
    bearer?.server.close();
  });

  test('the run reached the admin checks and finished', () => {
    for (const run of [signed, bearer]) {
      assert.ok(run.lines.some((l) => l.startsWith('PASS adm1:')), run.lines.filter((l) => l.includes('adm1')).join('\n'));
      assert.ok(run.lines.some((l) => l.startsWith('PASS p0:')), 'the people checks ran');
      assert.ok(adminCalls(run.requests, run === signed ? signedOk : bearerOk).length >= 3, 'the smoke made admin calls');
      assert.equal(run.code, 1, 'most checks fail against the stub');
    }
  });

  test('SMK-1: signed mode sends X-Caddie-Admin on every admin call, verified by the stub, and no Authorization', () => {
    const calls = adminCalls(signed.requests, signedOk);
    for (const r of calls) {
      assert.equal(r.authorization, null, `${r.method} ${r.path} carries an Authorization header`);
      const v = verifyAdminSignature({ headerValue: r.signed, method: r.method, pathWithQuery: r.path, keys: [TOKEN] });
      assert.equal(v.ok, true, `${r.method} ${r.path}: ${v.reason}`);
      // The header's body hash is the hash of the bytes the stub received.
      assert.equal(v.bodySha256, r.body.length === 0 ? EMPTY_BODY_SHA256 : createHash('sha256').update(r.body, 'utf8').digest('hex'));
      if (['GET', 'HEAD', 'DELETE'].includes(r.method)) assert.equal(r.body, '');
    }
    assert.ok(calls.some((r) => r.method === 'POST' && r.body.length > 0), 'a signed POST with a body');
    // adm1's three probes: no auth, a wrong key (exactly one signed header that does not verify,
    // sent before any call with the real key), and the real key with an Origin header.
    assert.ok(signed.requests.some((r) => r.path.startsWith('/admin/stats') && r.signed === null && r.authorization === null), 'a probe without auth');
    const wrong = wrongKeyProbes(signed.requests, signedOk);
    assert.equal(wrong.length, 1, 'exactly one request signed with a wrong key');
    assert.equal(`${wrong[0].method} ${wrong[0].path.split('?')[0]}`, 'GET /admin/stats');
    assert.equal(verifyAdminSignature({ headerValue: wrong[0].signed, method: 'GET', pathWithQuery: wrong[0].path, keys: [TOKEN] }).reason, 'signature');
    assert.ok(signed.requests.indexOf(wrong[0]) < signed.requests.indexOf(calls[0]), 'the wrong-key probe comes before the first real call');
    assert.ok(authed(signed.requests).some((r) => r.origin !== null && signedOk(r)), 'a probe with the real key and an Origin header');
    assert.ok(signed.requests.every((r) => r.authorization === null), 'no request carries Authorization in signed mode');
  });

  test('SMK-1: a retried admin call is signed afresh with a new nonce, never resent', () => {
    const failed = signed.requests.find((r) => r.answered === 503);
    assert.ok(failed, 'the stub failed one admin call');
    const retry = signed.requests.find((r) => r !== failed && r.method === failed.method && r.path === failed.path && signedOk(r));
    assert.ok(retry, 'the call was retried');
    assert.notEqual(retry.signed, failed.signed);
    assert.notEqual(retry.signed.split(' ')[2], failed.signed.split(' ')[2], 'a different nonce');
    assert.ok(signed.lines.some((l) => l.startsWith('NOTE ') && l.includes('answered 503 on the first attempt; retrying once')));
    // The bearer run retried too, with the same credentials each time.
    const bearerFailed = bearer.requests.find((r) => r.answered === 503);
    assert.ok(bearerFailed && bearer.requests.some((r) => r !== bearerFailed && r.path === bearerFailed.path && bearerOk(r)));
  });

  test('SMK-1: the default is bearer, which sends Authorization: Bearer and no X-Caddie-Admin', () => {
    const calls = adminCalls(bearer.requests, bearerOk);
    assert.ok(calls.length >= 3);
    for (const r of calls) {
      assert.equal(r.authorization, `Bearer ${TOKEN}`);
      assert.equal(r.signed, null);
    }
    const wrong = wrongKeyProbes(bearer.requests, bearerOk);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0].authorization, /^Bearer [0-9a-f]{64}$/);
    assert.ok(bearer.requests.every((r) => r.signed === null));
  });

  test('SMK-2: gated /admin/test/* routes make meter1, the expired profile, the aged presence and unav1 print SKIP naming ADMIN_TEST_ROUTES', () => {
    for (const run of [signed, bearer]) {
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

  test('SEC-3: the token never appears in the output, and the signed run never sends it in any header', () => {
    for (const run of [signed, bearer]) {
      assert.ok(!run.stdout.includes(TOKEN));
      assert.ok(!run.stderr.includes(TOKEN));
    }
    for (const r of signed.requests) {
      assert.ok(!(r.signed ?? '').includes(TOKEN));
      assert.ok(!r.path.includes(TOKEN));
    }
  });

  test('SEC-16: GET and DELETE admin calls carry no body', () => {
    for (const run of [signed, bearer]) {
      for (const r of adminCalls(run.requests, run === signed ? signedOk : bearerOk)) {
        if (['GET', 'HEAD', 'DELETE'].includes(r.method)) assert.equal(r.body, '');
      }
    }
  });
});

test('SMOKE_ADMIN_AUTH refuses an unknown value before any request', async () => {
  const { server, requests, port } = await stubWorker({ authOk: () => false });
  try {
    const run = await runSmoke(port, { SMOKE_ADMIN_AUTH: 'basic' });
    assert.equal(run.code, 1);
    assert.ok(run.stdout.includes('FAIL config: SMOKE_ADMIN_AUTH must be signed or bearer'));
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('signed mode refuses a token shorter than 32 characters before any request', async () => {
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
