// The clients of the Worker's admin routes sign every request (W8): adminClient in
// worker/ingest/lib.mjs (push-ingest.mjs, topics-local.mjs and migrate-from-backup.mjs use it) and
// worker/scripts/moderation.mjs. A local HTTP server on 127.0.0.1 records what each one sends, and
// every recorded request must verify with verifyAdminSignature() from scripts/lib/admin-sign.mjs,
// carry the body it signed and no Authorization header; a retried request must be signed afresh.
// The key is the shared fixture's fake one; nothing leaves this machine.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EMPTY_BODY_SHA256, bodyMatches, parseAdminHeader, verifyAdminSignature } from '../../scripts/lib/admin-sign.mjs';
import { AdminError, UsageError, adminClient, drainPending } from '../ingest/lib.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const SLUG = 'caddie-fixture-2099';
const MODERATION = fileURLToPath(new URL('../scripts/moderation.mjs', import.meta.url));

// A server that records each request (method, path with query, headers, body bytes) and answers
// with the next of `answers` ({ status, headers, body, drop }), then 200 {} once they run out.
// `drop` closes the connection without an answer.
const servers = [];
function recorder(answers = []) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const a = answers.shift() ?? { status: 200, body: {} };
      if (a.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json', ...(a.headers ?? {}) });
      res.end(JSON.stringify(a.body ?? {}));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

// A server whose answers send their headers and one byte of a 100-byte body, then, in turn,
// stall (`stall`), break the connection (`break`), or send a whole JSON body (`ok`), as the next
// entry of `plan` says ({ status, then }).
function halfBody(plan) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    const { status, then } = plan.shift() ?? { status: 200, then: 'ok' };
    if (then === 'ok') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 300 ? { ok: true } : { error: 'not_found' }));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': '100', ...(status >= 300 && status < 400 ? { Location: 'http://127.0.0.1:9/elsewhere' } : {}) });
    res.write('{');
    if (then === 'break') setTimeout(() => res.socket?.destroy(), 20);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ hits, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// A server on localhost (another origin than the recorder's 127.0.0.1) that answers every request
// with `status` and a Location on `target`, and counts the requests it gets.
function redirector(status, target) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    res.writeHead(status, { Location: `${target}/elsewhere` });
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => resolve({ hits, base: `http://localhost:${server.address().port}` }));
  });
}
const ACCESS = { CF_ACCESS_CLIENT_ID: 'fake-id.access', CF_ACCESS_CLIENT_SECRET: 'fake-access-secret' };

// One recorded request: signed for exactly what was sent, with the key and no other credential.
function assertSigned(r) {
  assert.equal(r.headers.authorization, undefined, 'no Authorization header');
  for (const v of Object.values(r.headers)) assert.ok(!String(v).includes(KEY), 'no header carries the key');
  const v = verifyAdminSignature({ headerValue: r.headers['x-caddie-admin'], method: r.method, pathWithQuery: r.url, keys: [KEY], now: Date.now() });
  assert.equal(v.ok, true, `${r.method} ${r.url}: ${v.reason}`);
  assert.ok(bodyMatches(v.bodySha256, r.body), `${r.method} ${r.url}: the body is the one signed`);
  if (r.body.length === 0) assert.equal(v.bodySha256, EMPTY_BODY_SHA256);
  return v;
}

describe('adminClient (worker/ingest/lib.mjs)', () => {
  test('every request is signed and verifies, carries no Authorization header, and keeps its flags in the body', async () => {
    const { seen, base } = await recorder([{}, {}, { body: { topics: [] } }, {}, { body: { embedded: 0, pending: 0 } }]);
    const admin = adminClient(base, KEY, { retries: 0, env: {} });
    await admin('PUT', '/admin/conferences', { conferences: [{ slug: SLUG, name: 'Ünïcode — fixture' }] });
    await admin('POST', `/admin/talks?event=${SLUG}`, { generation: 1, talks: [] });
    await admin('GET', `/admin/topics?event=${SLUG}`);
    await admin('POST', `/admin/talks/finalize?event=${SLUG}`, { generation: 1, allow_shrink: true });
    assert.equal(await drainPending(admin, SLUG), 0);
    assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [
      'PUT /admin/conferences', `POST /admin/talks?event=${SLUG}`, `GET /admin/topics?event=${SLUG}`,
      `POST /admin/talks/finalize?event=${SLUG}`, `POST /admin/embed-pending?event=${SLUG}`,
    ]);
    for (const r of seen) {
      assertSigned(r);
      assert.equal(r.headers['cf-access-client-id'], undefined);
      assert.equal(r.headers['content-type'], r.method === 'GET' ? undefined : 'application/json');
    }
    assert.equal(seen[2].body.length, 0);
    assert.deepEqual(JSON.parse(seen[3].body), { generation: 1, allow_shrink: true });
    assert.ok(!seen[3].url.includes('allow_shrink'));
    // Every request has its own nonce.
    assert.equal(new Set(seen.map((r) => parseAdminHeader(r.headers['x-caddie-admin']).nonce)).size, seen.length);
  });

  test('a retried request is signed afresh: a new nonce and a later timestamp, after a 5xx and after a dropped connection', async () => {
    const { seen, base } = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { drop: true }, { body: { ok: true } }]);
    const admin = adminClient(base, KEY, { retries: 2, env: {} });
    assert.deepEqual(await admin('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), { ok: true });
    assert.equal(seen.length, 3);
    const headers = seen.map((r) => parseAdminHeader(r.headers['x-caddie-admin']));
    for (const r of seen) assertSigned(r);
    assert.equal(new Set(headers.map((h) => h.nonce)).size, 3);
    assert.ok(headers[1].ts > headers[0].ts && headers[2].ts > headers[1].ts, headers.map((h) => h.ts).join(' '));
    assert.ok(seen.every((r) => r.body.equals(seen[0].body)));
  });

  test('an unretire_incomplete answer names its cause and the slugs not unretired; with cause daily_limit first it stops at once, otherwise it is retried', async () => {
    const body = (status, cause) => ({ status, headers: { 'Retry-After': '1' }, body: { cause, error: 'unretire_incomplete', unretire_failed: [SLUG, 'Bad Slug\nFAKE', 7, SLUG], upserted: 3, searchable: 2, synced: 1, skipped_retired: [] } });
    const limited = await recorder([body(503, 'daily_limit')]);
    await assert.rejects(adminClient(limited.base, KEY, { retries: 3, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
      assert.equal(e.status, 503);
      assert.match(e.message, /status 503 \(unretire_incomplete, cause daily_limit\)/);
      assert.ok(e.message.includes(`not unretired, the object did not take the document: ${SLUG};`), e.message);
      assert.ok(e.message.includes('the rest of the batch was applied (upserted 3)'), e.message);
      assert.ok(!e.message.includes('FAKE') && !e.message.includes('Bad Slug'), e.message);
      assert.match(e.message, /daily limit is reached/);
      return true;
    });
    assert.equal(limited.seen.length, 1, 'a daily limit is not retried');
    const superseded = await recorder([body(502, 'unretire_superseded'), { body: { upserted: 3, searchable: 2, synced: 2, skipped_retired: [] } }]);
    assert.deepEqual(await adminClient(superseded.base, KEY, { retries: 1, env: {} })('PUT', '/admin/conferences', { conferences: [] }), { upserted: 3, searchable: 2, synced: 2, skipped_retired: [] });
    assert.equal(superseded.seen.length, 2, 'a 502 is retried');
    const gaveUp = await recorder([body(502, 'unretire_superseded')]);
    await assert.rejects(adminClient(gaveUp.base, KEY, { retries: 0, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
      assert.ok(e.message.includes(`status 502 (unretire_incomplete, cause unretire_superseded): not unretired, the object did not take the document: ${SLUG}; the rest of the batch was applied (upserted 3)`), e.message);
      return true;
    });
  });

  // Asserts that nothing the client sent in a header (the signed header, its nonce and signature,
  // the Access secret) or the key reaches the error's message, `earlier` or `body`, and that the
  // error carries no other own property.
  function assertNoSecret(e, seen) {
    assert.deepEqual(Object.keys(e).sort(), ['body', 'earlier', 'status']);
    const shown = [e.message, JSON.stringify(e.earlier), JSON.stringify(e.body)].join('\n');
    const secrets = [KEY, ACCESS.CF_ACCESS_CLIENT_ID, ACCESS.CF_ACCESS_CLIENT_SECRET];
    for (const r of seen) {
      const h = parseAdminHeader(r.headers['x-caddie-admin']);
      secrets.push(r.headers['x-caddie-admin'], h.nonce, h.sig);
    }
    for (const s of secrets) assert.ok(!shown.includes(s), 'a header value or the key reached the error');
  }
  const mismatch = (mismatched) => ({ status: 409, body: { error: 'status_mismatch', mismatched } });

  test('a 409 status_mismatch after a 502 unretire_incomplete keeps the answer, shows expected→actual and the earlier attempt, and says to repeat the unretire', async () => {
    const incomplete = { status: 502, headers: { 'Retry-After': '1' }, body: { cause: 'unretire_superseded', error: 'unretire_incomplete', unretire_failed: [SLUG], upserted: 1, searchable: 1, synced: 0, skipped_retired: [] } };
    const answer = mismatch([
      { slug: SLUG, expected: null, actual: 'searchable' },
      { slug: 'Bad Slug\nFAKE', expected: null, actual: 'searchable' },
      { slug: 'other-fixture-2099', expected: 'x\u001b[31mFAKE', actual: null },
      'FAKE',
    ]);
    const { seen, base } = await recorder([incomplete, answer]);
    const admin = adminClient(base, KEY, { retries: 3, env: ACCESS });
    await assert.rejects(admin('PUT', '/admin/conferences', { conferences: [{ slug: SLUG, unretire: true, expect_status: null }] }), (e) => {
      assert.ok(e instanceof AdminError);
      assert.equal(e.status, 409);
      assert.deepEqual(e.body, answer.body);
      assert.deepEqual(e.earlier, ['status 502 (unretire_incomplete, cause unretire_superseded)']);
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual, null for no row): ${SLUG} null→searchable (3 malformed entries not shown). An earlier attempt answered status 502 (unretire_incomplete, cause unretire_superseded); it may have been applied, so the actual status can be the one it set; repeat the unretire without expect_status until it answers 200.`);
      assert.ok(!e.message.includes('FAKE') && !e.message.includes('\u001b'), e.message);
      assertNoSecret(e, seen);
      return true;
    });
    assert.equal(seen.length, 2, 'the 409 is not retried');
  });

  test('a status_mismatch after no answer says the attempt may have been applied; after a 429, or for another error, the earlier attempts are only listed', async () => {
    const dropped = await recorder([{ drop: true }, mismatch([{ slug: SLUG, expected: 'searchable', actual: 'unavailable' }])]);
    await assert.rejects(adminClient(dropped.base, KEY, { retries: 1, env: ACCESS })('PUT', '/admin/conferences', { conferences: [{ slug: SLUG, status: 'unavailable', expect_status: 'searchable' }] }), (e) => {
      assert.deepEqual([e.status, e.earlier], [409, ['no answer (network error)']]);
      assert.ok(e.message.endsWith(`${SLUG} searchable→unavailable. An earlier attempt got no answer (network error); it may have been applied, so the actual status can be the one it set; check the conference, then send the request again with the actual status or without expect_status.`), e.message);
      assertNoSecret(e, dropped.seen);
      return true;
    });
    const limited = await recorder([{ status: 429, headers: { 'Retry-After': '1' }, body: { error: 'rate_limited' } }, mismatch([{ slug: SLUG, expected: null, actual: 'searchable' }])]);
    await assert.rejects(adminClient(limited.base, KEY, { retries: 1, env: {} })('PUT', '/admin/conferences', { conferences: [{ slug: SLUG, unretire: true, expect_status: null }] }), (e) => {
      assert.deepEqual([e.status, e.earlier], [409, ['status 429 (rate_limited)']]);
      assert.ok(e.message.endsWith(`${SLUG} null→searchable. An earlier attempt answered status 429 (rate_limited).`), e.message);
      return true;
    });
    const other = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { drop: true }, { status: 404, body: { error: 'not_found', detail: 'FAKE' } }]);
    await assert.rejects(adminClient(other.base, KEY, { retries: 2, env: ACCESS })('GET', `/admin/stats?event=${SLUG}`), (e) => {
      assert.deepEqual([e.status, e.body, e.earlier], [404, { error: 'not_found', detail: 'FAKE' }, ['status 503 (busy)', 'no answer (network error)']]);
      assert.equal(e.message, 'GET /admin/stats: status 404 (not_found). Earlier attempts: answered status 503 (busy); got no answer (network error).');
      assertNoSecret(e, other.seen);
      return true;
    });
  });

  test('a first answer of 409 status_mismatch carries its body and no earlier attempt; giving up keeps the last answer and lists the attempts before it', async () => {
    const first = await recorder([mismatch([{ slug: SLUG, expected: 'unavailable', actual: 'searchable' }])]);
    await assert.rejects(adminClient(first.base, KEY, { retries: 3, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
      assert.deepEqual([e.status, e.earlier, e.body.mismatched], [409, [], [{ slug: SLUG, expected: 'unavailable', actual: 'searchable' }]]);
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual, null for no row): ${SLUG} unavailable→searchable`);
      return true;
    });
    const busy = (n) => ({ status: 502, headers: { 'Retry-After': '1' }, body: { error: 'busy', n } });
    const gaveUp = await recorder([busy(1), busy(2), { status: 502, body: ['not', 'an', 'object'] }]);
    await assert.rejects(adminClient(gaveUp.base, KEY, { retries: 2, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.deepEqual([e.status, e.body, e.earlier], [0, null, ['status 502 (busy)', 'status 502 (busy)']]);
      assert.equal(e.message, 'POST /admin/moderation: status 502 (gave up after 3 attempts). Earlier attempts: answered status 502 (busy); answered status 502 (busy).');
      return true;
    });
  });

  test('a 401 is not retried and names its code', async () => {
    const { seen, base } = await recorder([{ status: 401, body: { error: 'admin_skew' } }]);
    const admin = adminClient(base, KEY, { retries: 3, env: {} });
    await assert.rejects(admin('GET', `/admin/stats?event=${SLUG}`), (e) => e.status === 401 && /admin_skew/.test(e.message));
    assert.equal(seen.length, 1);
  });

  test('the Cloudflare Access headers are sent only when both values are set', async () => {
    const { seen, base } = await recorder();
    await adminClient(base, KEY, { retries: 0, env: { CF_ACCESS_CLIENT_ID: 'fake-id.access', CF_ACCESS_CLIENT_SECRET: 'fake-access-secret' } })('GET', `/admin/stats?event=${SLUG}`);
    await adminClient(base, KEY, { retries: 0, env: { CF_ACCESS_CLIENT_ID: 'fake-id.access' } })('GET', `/admin/stats?event=${SLUG}`);
    await adminClient(base, KEY, { retries: 0, env: { CF_ACCESS_CLIENT_ID: ' ', CF_ACCESS_CLIENT_SECRET: 'fake-access-secret' } })('GET', `/admin/stats?event=${SLUG}`);
    assert.deepEqual([seen[0].headers['cf-access-client-id'], seen[0].headers['cf-access-client-secret']], ['fake-id.access', 'fake-access-secret']);
    for (const r of seen.slice(1)) assert.deepEqual([r.headers['cf-access-client-id'], r.headers['cf-access-client-secret']], [undefined, undefined]);
    for (const r of seen) assertSigned(r);
  });

  test('a redirect is never followed: the call fails at once, and neither the signature nor the Access secret reaches the other origin', async () => {
    const target = await recorder();
    for (const status of [301, 302, 303, 307, 308]) {
      const from = await redirector(status, target.base);
      const admin = adminClient(from.base, KEY, { retries: 3, env: ACCESS });
      await assert.rejects(
        admin('POST', `/admin/talks?event=${SLUG}`, { generation: 1, talks: [] }),
        (e) => e instanceof AdminError && e.status === status && /never follow redirects/.test(e.message),
        String(status),
      );
      assert.equal(from.hits.length, 1, `${status} was retried`);
    }
    assert.equal(target.seen.length, 0, 'the redirect target got a request');
  });

  test('a redirect whose body stalls is refused at once, before the body is read, and sent once', async () => {
    const server = await halfBody([{ status: 302, then: 'stall' }, { status: 302, then: 'stall' }, { status: 302, then: 'stall' }]);
    const admin = adminClient(server.base, KEY, { retries: 2, timeoutMs: 300, env: {} });
    const started = Date.now();
    await assert.rejects(admin('GET', `/admin/stats?event=${SLUG}`), (e) => e instanceof AdminError && e.status === 302 && /a redirect\. Admin calls never follow redirects/.test(e.message));
    assert.equal(server.hits.length, 1);
    assert.ok(Date.now() - started < 300, 'did not wait for the stalled body');
  });

  test('any other answer whose body breaks is still retried as a network failure', async () => {
    const server = await halfBody([{ status: 200, then: 'break' }, { status: 200, then: 'ok' }, { status: 404, then: 'break' }, { status: 404, then: 'ok' }]);
    const admin = adminClient(server.base, KEY, { retries: 1, timeoutMs: 2_000, env: {} });
    assert.deepEqual(await admin('GET', `/admin/stats?event=${SLUG}`), { ok: true });
    assert.equal(server.hits.length, 2);
    await assert.rejects(admin('GET', `/admin/stats?event=${SLUG}`), (e) => e instanceof AdminError && e.status === 404);
    assert.equal(server.hits.length, 4);
  });

  test('a request the signer refuses is a usage error before anything is sent, and the message holds no key', async () => {
    const { seen, base } = await recorder();
    const refused = [
      [adminClient(`${base}/prefix`, KEY, { env: {} }), 'GET', `/admin/stats?event=${SLUG}`],
      [adminClient(base, KEY, { env: {} }), 'GET', '/admin/stats?event=a%20b'],
      [adminClient(base, KEY, { env: {} }), 'GET', '/admin//stats'],
      [adminClient(base, KEY.slice(0, 31), { env: {} }), 'GET', `/admin/stats?event=${SLUG}`],
    ];
    for (const [admin, method, path] of refused) {
      await assert.rejects(admin(method, path), (e) => e instanceof UsageError && !e.message.includes(KEY.slice(0, 31)), path);
    }
    assert.equal(seen.length, 0);
  });
});

// Runs moderation.mjs against the recorder; resolves with the exit code and both outputs.
function moderation(base, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [MODERATION, '--event', SLUG, '--api', base, ...args], {
      env: { ...process.env, ADMIN_TOKEN: KEY, ADMIN_TOKEN_FILE: '/nonexistent/admin-token', CADDIE_API_BASE: '', CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

describe('worker/scripts/moderation.mjs', () => {
  test('signs each request, sends no Authorization header, and never prints the key', async () => {
    const { seen, base } = await recorder([{ body: { hidden: [] } }, { body: { reports: [] } }, { body: { ok: true, removed: 2 } }]);
    const runs = [
      await moderation(base, ['--hidden']),
      await moderation(base, ['--since', '2026-11-10T08:00:00Z']),
      await moderation(base, ['--unhide', `profile:${'0123456789abcdef'}`]),
    ];
    for (const r of runs) {
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
    }
    assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [
      `GET /admin/moderation?event=${SLUG}`,
      `GET /admin/moderation?event=${SLUG}&since=2026-11-10T08:00:00.000Z`,
      `POST /admin/moderation?event=${SLUG}`,
    ]);
    for (const r of seen) {
      assertSigned(r);
      assert.equal(r.headers['cf-access-client-id'], undefined);
    }
    assert.deepEqual(JSON.parse(seen[2].body), { action: 'unhide', kind: 'profile', id: '0123456789abcdef' });
  });

  test('sends the Cloudflare Access headers when both values are set, as adminClient does', async () => {
    const { seen, base } = await recorder([{ body: { hidden: [] } }]);
    const r = await moderation(base, ['--hidden'], { CF_ACCESS_CLIENT_ID: 'fake-id.access', CF_ACCESS_CLIENT_SECRET: 'fake-access-secret' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('fake-access-secret') && !r.stderr.includes('fake-access-secret'));
    assert.deepEqual([seen[0].headers['cf-access-client-id'], seen[0].headers['cf-access-client-secret']], ['fake-id.access', 'fake-access-secret']);
    assertSigned(seen[0]);
  });

  test('never follows a redirect, so the signature and the Access secret stay with the Worker\'s origin', async () => {
    const target = await recorder();
    const from = await redirector(307, target.base);
    const r = await moderation(from.base, ['--hidden'], ACCESS);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /status 307, a redirect\. Admin calls never follow redirects/);
    assert.equal(from.hits.length, 1);
    assert.equal(target.seen.length, 0);
  });

  test('refuses a redirect whose body stalls without waiting for the body', { timeout: 10_000 }, async () => {
    const server = await halfBody([{ status: 302, then: 'stall' }]);
    const started = Date.now();
    const r = await moderation(server.base, ['--hidden']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /status 302, a redirect\. Admin calls never follow redirects/);
    assert.equal(server.hits.length, 1);
    assert.ok(Date.now() - started < 8_000, 'the 30-second fetch timeout was not waited for');
  });

  test('plain http is refused for anything but localhost', async () => {
    for (const api of ['http://example.com', 'http://192.0.2.1:8787']) {
      const r = await moderation(api, ['--hidden']);
      assert.equal(r.code, 2, api);
      assert.match(r.stderr, /plain http is allowed for localhost only/);
    }
  });

  test('a base with a path is refused before a request is made', async () => {
    const { seen, base } = await recorder();
    const r = await moderation(`${base}/prefix`, ['--hidden']);
    assert.equal(r.code, 2);
    assert.equal(seen.length, 0);
  });
});
