// The clients of the Worker's admin routes sign every request (W8): adminClient in
// worker/ingest/lib.mjs (push-ingest.mjs, topics-local.mjs and migrate-from-backup.mjs use it) and
// the deprecated worker/scripts/moderation.mjs, which now only names the caddie-admin command to use
// and sends nothing. A local HTTP server on 127.0.0.1 records what each one sends, and every
// recorded request must verify with verifyAdminSignature() from scripts/lib/admin-sign.mjs,
// carry the body it signed and no Authorization header; a retried request must be signed afresh.
// adminClient signs v2, bound to the origin of its base, always: the override
// CADDIE_ADMIN_SIG_VERSION was removed in step e of the migration (DECISIONS.md "Admin signature
// v2"), so every recorded request is verified as v2 only, for the recorder's origin only, and the
// last test of this file checks that no server here ever received a v1 header.
// The key is the shared fixture's fake one; nothing leaves this machine.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_BODY_SHA256, bodyMatches, parseVersionedAdminHeader, verifyAdminSignature } from '../../scripts/lib/admin-sign.mjs';
import { AdminError, UsageError, adminClient, drainPending, normalizeApiBase } from '../ingest/lib.mjs';
import { run as migrateFromBackup } from '../ingest/migrate-from-backup.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/admin-sign.v1.json', import.meta.url), 'utf8'));
const KEY = fixture.keys.key1;
const SLUG = 'caddie-fixture-2099';
const MODERATION = fileURLToPath(new URL('../scripts/moderation.mjs', import.meta.url));
const TOPICS_LOCAL = fileURLToPath(new URL('../ingest/topics-local.mjs', import.meta.url));
const PUSH_INGEST = fileURLToPath(new URL('../ingest/push-ingest.mjs', import.meta.url));
const DATA = fileURLToPath(new URL('../../data/', import.meta.url));

// A server that records each request (method, path with query, headers, body bytes) and answers
// with the next of `answers` ({ status, headers, body, drop }), then 200 {} once they run out.
// `drop` closes the connection without an answer.
const servers = [];
// Every X-Caddie-Admin header any server of this file received, for the last test: none is v1.
const adminHeaders = [];
const noteHeader = (req) => {
  if (req.headers['x-caddie-admin'] !== undefined) adminHeaders.push(req.headers['x-caddie-admin']);
};
// Each record also holds `origin`, the recorder's own origin, which a v2 signature must name.
function recorder(answers = []) {
  const seen = [];
  let origin = '';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      noteHeader(req);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), origin });
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
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ seen, base: origin });
    });
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
    noteHeader(req);
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
    noteHeader(req);
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
// The verifier accepts v2 only, and the signature must name the recorder's origin.
function assertSigned(r) {
  assert.equal(r.headers.authorization, undefined, 'no Authorization header');
  for (const v of Object.values(r.headers)) assert.ok(!String(v).includes(KEY), 'no header carries the key');
  assert.match(r.headers['x-caddie-admin'], /^v2 /);
  const v = verifyAdminSignature({ headerValue: r.headers['x-caddie-admin'], method: r.method, pathWithQuery: r.url, keys: [KEY], now: Date.now(), allowedVersions: [2], expectedOrigins: [r.origin] });
  assert.equal(v.ok, true, `${r.method} ${r.url}: ${v.reason}`);
  assert.equal(v.version, 2);
  assert.equal(v.origin, r.origin);
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
    assert.equal(new Set(seen.map((r) => parseVersionedAdminHeader(r.headers['x-caddie-admin']).nonce)).size, seen.length);
  });

  test('a retried request is signed afresh with v2: a new nonce and a later timestamp, after a 5xx and after a dropped connection', async () => {
    const { seen, base } = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { drop: true }, { body: { ok: true } }]);
    const admin = adminClient(base, KEY, { retries: 2, env: {} });
    assert.deepEqual(await admin('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), { ok: true });
    assert.equal(seen.length, 3);
    const headers = seen.map((r) => parseVersionedAdminHeader(r.headers['x-caddie-admin']));
    for (const r of seen) assertSigned(r);
    assert.deepEqual(headers.map((h) => h.version), [2, 2, 2]);
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
      const h = parseVersionedAdminHeader(r.headers['x-caddie-admin']);
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
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual): ${SLUG} (no row)→searchable (3 malformed entries not shown). An earlier attempt answered status 502 (unretire_incomplete, cause unretire_superseded); it may have been applied, so the actual status can be the one it set; repeat the unretire without expect_status until it answers 200.`);
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
      assert.ok(e.message.endsWith(`${SLUG} (no row)→searchable. An earlier attempt answered status 429 (rate_limited).`), e.message);
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
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual): ${SLUG} unavailable→searchable`);
      return true;
    });
    const busy = (n) => ({ status: 502, headers: { 'Retry-After': '1' }, body: { error: 'busy', n } });
    const gaveUp = await recorder([busy(1), busy(2), busy(3)]);
    await assert.rejects(adminClient(gaveUp.base, KEY, { retries: 2, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.deepEqual([e.status, e.body, e.earlier], [0, { error: 'busy', n: 3 }, ['status 502 (busy)', 'status 502 (busy)']]);
      assert.equal(e.message, 'POST /admin/moderation: status 502 (busy) (gave up after 3 attempts). Earlier attempts: answered status 502 (busy); answered status 502 (busy).');
      return true;
    });
    // A last answer that is not a JSON object gives no body.
    const notObject = await recorder([{ status: 502, body: ['not', 'an', 'object'] }]);
    await assert.rejects(adminClient(notObject.base, KEY, { retries: 0, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.deepEqual([e.status, e.body, e.earlier], [0, null, []]);
      assert.equal(e.message, 'POST /admin/moderation: status 502 (gave up after 1 attempts)');
      return true;
    });
  });

  test('a status_mismatch shows no row as (no row) and quotes a status that reads as null, and names at most 20 entries', async () => {
    const OTHER = 'other-fixture-2099';
    const shown = await recorder([mismatch([
      { slug: SLUG, expected: 'searchable', actual: null },
      { slug: OTHER, expected: 'null', actual: null },
      { slug: SLUG, expected: null, actual: 'NULL' },
    ])]);
    await assert.rejects(adminClient(shown.base, KEY, { retries: 0, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual): ${SLUG} searchable→(no row), ${OTHER} "null"→(no row), ${SLUG} (no row)→"NULL"`);
      return true;
    });
    const many = Array.from({ length: 23 }, (_, i) => ({ slug: `fixture-${i}-2099`, expected: null, actual: 'searchable' }));
    const long = await recorder([mismatch(many)]);
    await assert.rejects(adminClient(long.base, KEY, { retries: 0, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
      assert.ok(e.message.includes('fixture-19-2099 (no row)→searchable and 3 more'), e.message);
      assert.ok(!e.message.includes('fixture-20-2099'), e.message);
      return true;
    });
  });

  test('the unretire advice is given only when a mismatching document is one the request unretires', async () => {
    const OTHER = 'other-fixture-2099';
    const batch = { conferences: [{ slug: SLUG, unretire: true, expect_status: null }, { slug: OTHER, status: 'unavailable', expect_status: 'searchable' }] };
    const busy = { status: 502, headers: { 'Retry-After': '1' }, body: { error: 'busy' } };
    const notUnretired = await recorder([busy, mismatch([{ slug: OTHER, expected: 'searchable', actual: 'unavailable' }])]);
    await assert.rejects(adminClient(notUnretired.base, KEY, { retries: 1, env: {} })('PUT', '/admin/conferences', batch), (e) => {
      assert.ok(e.message.endsWith(`${OTHER} searchable→unavailable. An earlier attempt answered status 502 (busy); it may have been applied, so the actual status can be the one it set; check the conference, then send the request again with the actual status or without expect_status.`), e.message);
      return true;
    });
    const unretired = await recorder([busy, mismatch([{ slug: SLUG, expected: null, actual: 'searchable' }])]);
    await assert.rejects(adminClient(unretired.base, KEY, { retries: 1, env: {} })('PUT', '/admin/conferences', batch), (e) => {
      assert.ok(e.message.endsWith(`${SLUG} (no row)→searchable. An earlier attempt answered status 502 (busy); it may have been applied, so the actual status can be the one it set; repeat the unretire without expect_status until it answers 200.`), e.message);
      return true;
    });
  });

  test('a message that ends a sentence gets no second period before the earlier attempts', async () => {
    const limited = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { status: 503, body: { error: 'daily_limit' } }]);
    await assert.rejects(adminClient(limited.base, KEY, { retries: 3, env: {} })('GET', `/admin/stats?event=${SLUG}`), (e) => {
      assert.equal(e.message, 'GET /admin/stats: status 503 (daily_limit). The daily limit is reached; try again after the reset. An earlier attempt answered status 503 (busy).');
      return true;
    });
    assert.equal(limited.seen.length, 2);
  });

  test('the 400 for a misspelt expect_status or unretire key reaches the message and names the key as it must be written', async () => {
    for (const key of ['expect_status', 'unretire']) {
      const { base } = await recorder([{ status: 400, body: { error: `the key must be written exactly as ${key}` } }]);
      await assert.rejects(adminClient(base, KEY, { retries: 3, env: {} })('PUT', '/admin/conferences', { conferences: [] }), (e) => {
        assert.equal(e.status, 400);
        assert.equal(e.message, `PUT /admin/conferences: status 400 (the key must be written exactly as ${key})`);
        return true;
      });
    }
  });

  test('a stale body from an earlier attempt never becomes the error\'s body: a last answer that is not a JSON object, or no answer, gives null', async () => {
    const busy = (n) => ({ status: 502, headers: { 'Retry-After': '1' }, body: { error: 'busy', n } });
    const notObject = await recorder([busy(1), busy(2), { status: 502, body: ['not', 'an', 'object'] }]);
    await assert.rejects(adminClient(notObject.base, KEY, { retries: 2, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.ok(e instanceof AdminError);
      assert.equal(e.body, null);
      assert.deepEqual([e.status, e.earlier], [0, ['status 502 (busy)', 'status 502 (busy)']]);
      assert.equal(e.message, 'POST /admin/moderation: status 502 (gave up after 3 attempts). Earlier attempts: answered status 502 (busy); answered status 502 (busy).');
      return true;
    });
    assert.equal(notObject.seen.length, 3);
    const dropped = await recorder([busy(1), { drop: true }]);
    await assert.rejects(adminClient(dropped.base, KEY, { retries: 1, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.ok(e instanceof AdminError);
      assert.equal(e.body, null);
      assert.deepEqual([e.status, e.earlier], [0, ['status 502 (busy)']]);
      assert.equal(e.message, 'POST /admin/moderation: network error (gave up after 2 attempts). An earlier attempt answered status 502 (busy).');
      return true;
    });
    assert.equal(dropped.seen.length, 2);
    // The headers of the last answer arrive, but its body breaks: the earlier JSON object must
    // not survive as the error's body.
    const broken = await halfBody([{ status: 502, then: 'ok' }, { status: 502, then: 'break' }]);
    await assert.rejects(adminClient(broken.base, KEY, { retries: 1, timeoutMs: 2_000, env: {} })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), (e) => {
      assert.ok(e instanceof AdminError);
      assert.equal(e.body, null);
      assert.equal(e.status, 0);
      assert.match(e.message, /^POST \/admin\/moderation: network error \(gave up after 2 attempts\)/);
      return true;
    });
    assert.equal(broken.hits.length, 2);
  });

  test('a status_mismatch that names both unretired and other documents gives each its own advice and names the slugs', async () => {
    const OTHER = 'other-fixture-2099';
    const THIRD = 'third-fixture-2099';
    const batch = { conferences: [
      { slug: SLUG, unretire: true, expect_status: null },
      { slug: OTHER, status: 'unavailable', expect_status: 'searchable' },
      { slug: THIRD, unretire: true, expect_status: null },
    ] };
    const busy = { status: 502, headers: { 'Retry-After': '1' }, body: { error: 'busy' } };
    const { seen, base } = await recorder([busy, mismatch([
      { slug: SLUG, expected: null, actual: 'searchable' },
      { slug: OTHER, expected: 'searchable', actual: 'unavailable' },
      { slug: THIRD, expected: null, actual: 'unavailable' },
      { slug: 'Bad Slug\nFAKE', expected: null, actual: 'searchable' },
    ])]);
    await assert.rejects(adminClient(base, KEY, { retries: 1, env: ACCESS })('PUT', '/admin/conferences', batch), (e) => {
      assert.equal(e.message, `PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status (expected→actual): ${SLUG} (no row)→searchable, ${OTHER} searchable→unavailable, ${THIRD} (no row)→unavailable (1 malformed entry not shown). An earlier attempt answered status 502 (busy); it may have been applied, so the actual status can be the one it set; repeat the unretire of ${SLUG}, ${THIRD} without expect_status until it answers 200; for ${OTHER}, check the conference, then send the request again with the actual status or without expect_status.`);
      assert.ok(!e.message.includes('FAKE'), e.message);
      assertNoSecret(e, seen);
      return true;
    });
  });

  test('a first answer of 503 daily_limit keeps the period that ends its sentence, because there is no earlier attempt to append', async () => {
    const { seen, base } = await recorder([{ status: 503, body: { error: 'daily_limit' } }]);
    await assert.rejects(adminClient(base, KEY, { retries: 3, env: {} })('GET', `/admin/stats?event=${SLUG}`), (e) => {
      assert.equal(e.message, 'GET /admin/stats: status 503 (daily_limit). The daily limit is reached; try again after the reset.');
      assert.deepEqual([e.status, e.earlier, e.body], [503, [], { error: 'daily_limit' }]);
      return true;
    });
    assert.equal(seen.length, 1);
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

describe('adminClient: always v2, and the API base (steps c and e of admin signature v2)', () => {
  const ENV_NAME = 'CADDIE_ADMIN_SIG_VERSION';
  // Every value the removed override could hold: unset, empty, the two versions it named, and
  // values it used to refuse. None of them changes the version any more.
  const VALUES = [undefined, '', '1', '2', '3', ' 1', 'fake-stale-sig-version'];

  test('v2 for the base\'s origin whatever CADDIE_ADMIN_SIG_VERSION holds, which a verifier for another origin or for v1 only refuses', async () => {
    for (const value of VALUES) {
      const env = value === undefined ? {} : { [ENV_NAME]: value };
      const { seen, base } = await recorder();
      const admin = adminClient(base, KEY, { retries: 0, env });
      await admin('GET', `/admin/stats?event=${SLUG}`);
      await admin('POST', `/admin/talks?event=${SLUG}`, { generation: 1, talks: [] });
      assert.equal(await drainPending(admin, SLUG), null);
      assert.equal(seen.length, 3, JSON.stringify(env));
      for (const r of seen) {
        assert.match(r.headers['x-caddie-admin'], /^v2 /, JSON.stringify(env));
        assertSigned(r);
        const verify = (opts) => verifyAdminSignature({ headerValue: r.headers['x-caddie-admin'], method: r.method, pathWithQuery: r.url, keys: [KEY], now: Date.now(), ...opts });
        assert.equal(verify({ allowedVersions: [2], expectedOrigins: [r.origin.replace('127.0.0.1', 'localhost')] }).reason, 'signature');
        assert.equal(verify({ allowedVersions: [2], expectedOrigins: ['https://conference-caddie.krlehnardt.workers.dev'] }).reason, 'signature');
        assert.equal(verify({ allowedVersions: [1] }).reason, 'malformed');
      }
    }
  });

  test('CADDIE_ADMIN_SIG_VERSION=1, the old rollback value, still signs every attempt v2, retries included, each with a fresh nonce', async () => {
    const { seen, base } = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { body: { ok: true } }]);
    const admin = adminClient(base, KEY, { retries: 1, env: { [ENV_NAME]: '1' } });
    assert.deepEqual(await admin('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), { ok: true });
    assert.equal(seen.length, 2);
    for (const r of seen) assertSigned(r);
    const headers = seen.map((r) => parseVersionedAdminHeader(r.headers['x-caddie-admin']));
    assert.deepEqual(headers.map((h) => h.version), [2, 2]);
    assert.notEqual(headers[0].nonce, headers[1].nonce);
    assert.ok(headers[1].ts > headers[0].ts);
  });

  test('a value set before or after the client is created changes nothing, fails nothing and is never repeated', async () => {
    const { seen, base } = await recorder();
    const env = { [ENV_NAME]: 'fake-stale-sig-version' };
    const admin = adminClient(base, KEY, { retries: 0, env });
    env[ENV_NAME] = '1';
    await admin('GET', `/admin/stats?event=${SLUG}`);
    for (const value of ['0', 'v1', 2, 1]) await adminClient(base, KEY, { retries: 0, env: { [ENV_NAME]: value } })('GET', `/admin/stats?event=${SLUG}`);
    assert.equal(seen.length, 5);
    for (const r of seen) assertSigned(r);
  });

  test('a base that is not a canonical origin is refused before any request, by normalizeApiBase and by adminClient, and the message never repeats it', async () => {
    const { seen, base } = await recorder();
    const port = new URL(base).port;
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (...a) => {
      calls.push(a[0]);
      return realFetch(...a);
    };
    try {
      const refused = [
        ['a full-width dot', `http://127。0。0。1:${port}`],
        ['a full-width dot in a name', 'https://conference-caddie。krlehnardt.workers.dev'],
        ['a percent-encoded dot', `http://127%2e0%2e0%2e1:${port}`],
        ['a percent-encoded full-width dot', 'https://conference-caddie.krlehnardt.workers.dev%E3%80%82evil.example'],
        ['a user name and password', `http://fake-user:fake-password@127.0.0.1:${port}`],
        ['an empty userinfo', `http://@127.0.0.1:${port}`],
        ['a backslash', `http:\\\\127.0.0.1:${port}`],
        ['a trailing path', `${base}/prefix`],
        ['a trailing path with a slash', 'https://conference-caddie.krlehnardt.workers.dev/api/'],
        ['a dot path', `${base}/.`],
        ['a query', `${base}/?x=1`],
        ['a fragment', `${base}/#x`],
        ['a Unicode host', 'https://bücher.example'],
        ['full-width letters', `http://ｌｏｃａｌｈｏｓｔ:${port}`],
        ['a tab inside', `http://127.0.0.1:\t${port}`],
        ['no slashes after the scheme', `http:127.0.0.1:${port}`],
        ['three slashes', `http:///127.0.0.1:${port}`],
        ['another scheme', 'ftp://conference-caddie.krlehnardt.workers.dev'],
        ['a comma', 'https://conference-caddie.krlehnardt.workers.dev,https://evil.example'],
      ];
      for (const [what, value] of refused) {
        const usage = (e) => e instanceof UsageError && /must be the Worker's origin only/.test(e.message) && !e.message.includes(value) && !e.message.includes('fake-password');
        assert.throws(() => normalizeApiBase(value), usage, `normalizeApiBase: ${what}`);
        assert.throws(() => adminClient(value, KEY, { retries: 0, env: {} }), usage, `adminClient: ${what}`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls, []);
    assert.equal(seen.length, 0);
  });

  test('valid bases are read as before: the origin, lower case, without a default port or a final slash; plain http only for loopback', async () => {
    const same = [
      ['https://conference-caddie.krlehnardt.workers.dev', 'https://conference-caddie.krlehnardt.workers.dev'],
      ['https://conference-caddie.krlehnardt.workers.dev/', 'https://conference-caddie.krlehnardt.workers.dev'],
      ['  https://Conference-Caddie.KRLehnardt.workers.dev:443/  ', 'https://conference-caddie.krlehnardt.workers.dev'],
      ['HTTPS://caddie.example.org:8443', 'https://caddie.example.org:8443'],
      ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
      ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
      ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
      ['http://localhost:8787', 'http://localhost:8787'],
      ['http://[::1]:8787', 'http://[::1]:8787'],
    ];
    for (const [value, origin] of same) assert.equal(normalizeApiBase(value), origin, value);
    for (const value of ['http://conference-caddie.krlehnardt.workers.dev', 'http://10.0.0.1:8787', 'http://caddie.example.org/']) {
      assert.throws(() => normalizeApiBase(value), (e) => e instanceof UsageError && /must be https \(plain http is allowed for localhost only\)/.test(e.message), value);
      assert.throws(() => adminClient(value, KEY, { env: {} }), UsageError, value);
    }
    for (const value of [undefined, null, '']) assert.throws(() => normalizeApiBase(value), (e) => e instanceof UsageError && e.message === '--api <base URL> is required.');
    // A base with a final slash, as normalizeApiBase leaves it or not, signs for the same origin.
    const { seen, base } = await recorder();
    await adminClient(`${base}/`, KEY, { retries: 0, env: {} })('GET', `/admin/stats?event=${SLUG}`);
    await adminClient(normalizeApiBase(`${base}/`), KEY, { retries: 0, env: {} })('GET', `/admin/stats?event=${SLUG}`);
    assert.equal(seen.length, 2);
    for (const r of seen) assertSigned(r);
  });
});

// The path the scripts and CI used for the rollback: the scripts create their client without an
// `env` option, so the removed override would have reached them only through process.env, which the
// CI workflow filled from the repository variable until step e. Each script now signs v2 whatever
// the variable holds, and says once, on stderr, that a non-empty value is ignored.
describe('CADDIE_ADMIN_SIG_VERSION in the process environment is ignored with one warning (step e)', () => {
  const ENV_NAME = 'CADDIE_ADMIN_SIG_VERSION';
  const STALE = 'fake-stale-sig-version';
  // The warning the scripts print, and how many times it appears in a text.
  const WARNING = /^Admin signature: CADDIE_ADMIN_SIG_VERSION was removed in step e of the admin signature migration \(DECISIONS\.md, "Admin signature v2"\) and is ignored: every admin request is signed with v2; unset it\.$/;
  const warnings = (text) => text.split('\n').filter((l) => l.includes(ENV_NAME));
  // Unset, empty: no warning. "1", "2" and any other value: one warning. Every case signs v2.
  const CASES = [[undefined, false], ['', false], ['1', true], ['2', true], [STALE, true]];
  // A committed conference with a talk file, for the scripts that read one.
  const slug = readdirSync(DATA).filter((d) => existsSync(join(DATA, d, 'talks.ndjson'))).sort()[0];
  const home = mkdtempSync(join(tmpdir(), 'caddie-sig-env-'));
  after(() => rmSync(home, { recursive: true, force: true }));

  // Runs a script with only PATH, an empty HOME, no token file and `env`, so nothing from the
  // environment of the test run (CADDIE_ADMIN_SIG_VERSION included) leaks into it.
  function run(script, args, env) {
    return new Promise((resolve) => {
      execFile(process.execPath, [script, ...args], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { PATH: process.env.PATH, HOME: home, ADMIN_TOKEN_FILE: join(home, 'no-admin-token'), ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
  }
  const withValue = (value) => (value === undefined ? {} : { [ENV_NAME]: value });

  // Sets process.env[ENV_NAME] to `value` (undefined deletes it) for the length of `fn`.
  async function withProcessEnv(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, ENV_NAME);
    const saved = process.env[ENV_NAME];
    try {
      if (value === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = value;
      return await fn();
    } finally {
      if (had) process.env[ENV_NAME] = saved;
      else delete process.env[ENV_NAME];
    }
  }

  test('without an env option the client reads nothing of it from process.env: v2 for every value, and no failure', async () => {
    const { seen, base } = await recorder();
    for (const [value] of CASES) {
      await withProcessEnv(value, async () => {
        await adminClient(base, KEY)('GET', `/admin/stats?event=${SLUG}`);
        await adminClient(base, KEY, { retries: 0 })('GET', `/admin/stats?event=${SLUG}`);
      });
      const sent = seen.splice(0);
      assert.equal(sent.length, 2, JSON.stringify(value));
      for (const r of sent) assertSigned(r);
    }
  });

  test('with "1" in process.env and no env option, a retried request signs v2 on every attempt', async () => {
    const { seen, base } = await recorder([{ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'busy' } }, { body: { ok: true } }]);
    await withProcessEnv('1', async () => {
      assert.deepEqual(await adminClient(base, KEY, { retries: 1 })('POST', `/admin/moderation?event=${SLUG}`, { action: 'purge' }), { ok: true });
    });
    assert.equal(seen.length, 2);
    for (const r of seen) assertSigned(r);
    const headers = seen.map((r) => parseVersionedAdminHeader(r.headers['x-caddie-admin']));
    assert.deepEqual(headers.map((h) => h.version), [2, 2]);
    assert.notEqual(headers[0].nonce, headers[1].nonce);
  });

  test('topics-local.mjs --api signs v2 for every value, and warns once exactly when the value is not empty', async () => {
    assert.ok(slug, 'a committed conference with a talk file under data/');
    for (const [value, warned] of CASES) {
      const { seen, base } = await recorder([{ body: { topics: [] } }]);
      const r = await run(TOPICS_LOCAL, ['--event', slug, '--api', base, '--top', '1'], { ADMIN_TOKEN: KEY, ...withValue(value) });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /topics \(built\)/);
      assert.equal(seen.length, 1, JSON.stringify(value));
      assertSigned(seen[0]);
      const lines = warnings(r.stderr);
      assert.equal(lines.length, warned ? 1 : 0, `${JSON.stringify(value)}: ${r.stderr}`);
      if (warned) assert.match(lines[0], WARNING);
      assert.ok(!warnings(r.stdout).length, 'the warning goes to stderr only');
      assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
      assert.ok(!r.stdout.includes(STALE) && !r.stderr.includes(STALE), 'the value is never printed');
    }
  });

  test('push-ingest.mjs warns once, before anything else, also in a dry run without a token, and signs v2 in a dry run with one', async () => {
    const args = (base) => ['--api', base, '--event', slug, '--dry-run'];
    for (const [value, warned] of CASES) {
      // Without a token the dry run creates no client and signs nothing (it reads only the public
      // GET /api/conferences), but still says it.
      const quiet = await recorder();
      const bare = await run(PUSH_INGEST, args(quiet.base), withValue(value));
      assert.equal(bare.code, 0, bare.stderr);
      assert.match(bare.stdout, /\(dry run\)/);
      assert.ok(quiet.seen.every((req) => req.url.startsWith('/api/') && req.headers['x-caddie-admin'] === undefined), quiet.seen.map((req) => req.url).join(' '));
      // With a token the dry run reads the stored topics through the admin client.
      const { seen, base } = await recorder([{ body: { topics: [] } }]);
      const r = await run(PUSH_INGEST, args(base), { ADMIN_TOKEN: KEY, ...withValue(value) });
      assert.equal(r.code, 0, r.stderr);
      const signed = seen.filter((req) => req.url.startsWith('/admin/'));
      assert.ok(signed.length >= 1, `${JSON.stringify(value)}: the dry run with a token signed a request`);
      for (const req of signed) assertSigned(req);
      for (const out of [bare, r]) {
        const lines = warnings(out.stderr);
        assert.equal(lines.length, warned ? 1 : 0, `${JSON.stringify(value)}: ${out.stderr}`);
        if (warned) {
          assert.match(lines[0], WARNING);
          assert.equal(out.stderr.split('\n')[0], lines[0], 'the warning comes first');
        }
        assert.ok(!warnings(out.stdout).length, 'the warning goes to stderr only');
        assert.ok(!out.stdout.includes(STALE) && !out.stderr.includes(STALE), 'the value is never printed');
        assert.ok(!out.stdout.includes(KEY) && !out.stderr.includes(KEY));
      }
    }
  });

  test('migrate-from-backup.mjs warns once through warn before it reads the backup, and signs v2', async () => {
    const backup = mkdtempSync(join(home, 'backup-'));
    writeFileSync(join(backup, 'caddie-conferences-v1.ndjson'), '');
    for (const [value, warned] of CASES) {
      for (const dryRun of [true, false]) {
        const { seen, base } = await recorder([{ body: { upserted: 0, skipped_retired: [] } }]);
        const args = ['--backup', backup, '--api', base, '--only', 'conferences', ...(dryRun ? ['--dry-run'] : [])];
        const out = [];
        const err = [];
        const warn = [];
        const code = await withProcessEnv(value, () => migrateFromBackup(args, { readToken: () => (dryRun ? '' : KEY), log: (l) => out.push(l), error: (l) => err.push(l), warn: (l) => warn.push(l) }));
        const what = `${JSON.stringify(value)}${dryRun ? ' (dry run)' : ''}`;
        assert.equal(code, 0, `${what}: ${err.join('\n')}`);
        assert.deepEqual(err, [], what);
        assert.equal(warn.length, warned ? 1 : 0, `${what}: ${warn.join('\n')}`);
        if (warned) assert.match(warn[0], WARNING);
        assert.ok(![...out, ...warn].join('\n').includes(STALE), 'the value is never printed');
        assert.equal(seen.length, dryRun ? 0 : 1, what);
        for (const r of seen) assertSigned(r);
        if (dryRun) assert.ok(out.includes('Dry run: nothing was sent.'), out.join('\n'));
      }
    }
    // A stale value with a backup directory that does not exist: the warning still comes first.
    const warn = [];
    const err = [];
    const code = await withProcessEnv(STALE, () => migrateFromBackup(['--backup', join(home, 'missing'), '--api', 'http://127.0.0.1:9', '--dry-run'], { readToken: () => '', log: () => {}, error: (l) => err.push(l), warn: (l) => warn.push(l) }));
    assert.equal(code, 1);
    assert.equal(warn.length, 1);
    assert.match(err.join('\n'), /The backup directory does not exist\./);
  });
});

// Runs the deprecated moderation.mjs with the given arguments and a token and Access values in its
// environment; resolves with the exit code and both outputs.
function moderation(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [MODERATION, ...args], {
      env: { ...process.env, ADMIN_TOKEN: KEY, ADMIN_TOKEN_FILE: '/nonexistent/admin-token', CADDIE_API_BASE: '', ...ACCESS, ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

describe('worker/scripts/moderation.mjs (deprecated in favour of caddie-admin)', () => {
  const REF = '0123456789abcdef';
  const MEET = 'AbCdEfGhIjKlMnOpQrSt_-';
  const CLI = 'node scripts/caddie-admin.mjs';

  test('each action names its caddie-admin command on stderr, exits 2 and sends no request, with a token and the Access values set', async () => {
    const { seen, base } = await recorder();
    const cases = [
      [['--hidden'], `${CLI} moderation queue --event ${SLUG}`],
      [['--hidden', '--show-content'], `${CLI} moderation queue --event ${SLUG} --show-content`],
      [['--since', '2026-11-10T08:00:00Z'], `${CLI} moderation queue --event ${SLUG} --since 2026-11-10T08:00:00Z`],
      [['--unhide', `profile:${REF}`], `${CLI} moderation unhide --event ${SLUG} profile:${REF} --yes --confirm profile:${REF}`],
      [['--delete', `meet:${MEET}`], `${CLI} moderation delete --event ${SLUG} meet:${MEET} --yes --confirm meet:${MEET}`],
      [['--delete', `spot:${REF}`], `${CLI} moderation delete --event ${SLUG} spot:${REF} --yes --confirm spot:${REF}`],
      [['--purge'], `${CLI} moderation purge-reports --event ${SLUG} --yes --confirm ${SLUG}`],
    ];
    for (const [args, command] of cases) {
      const r = await moderation(['--event', SLUG, '--api', base, ...args]);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^worker\/scripts\/moderation\.mjs is deprecated and makes no request/);
      assert.ok(r.stderr.includes(`The equivalent command: ${command}\n`), r.stderr);
      assert.ok(r.stderr.includes('docs/ADMIN_CLI.md'), r.stderr);
      for (const secret of [KEY, ACCESS.CF_ACCESS_CLIENT_ID, ACCESS.CF_ACCESS_CLIENT_SECRET]) assert.ok(!r.stderr.includes(secret));
    }
    assert.equal(seen.length, 0, 'the deprecated script sent a request');
  });

  test('without an action, with two actions, with an unknown option or with -h it prints the whole mapping and exits 2', async () => {
    for (const args of [[], ['--event', SLUG], ['--event', SLUG, '--hidden', '--purge'], ['--event', SLUG, '--bogus'], ['-h']]) {
      const r = await moderation(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.ok(!r.stderr.includes('The equivalent command'), r.stderr);
      for (const command of ['moderation queue --event <slug> [--show-content]', 'moderation queue --event <slug> --since <iso>', 'moderation unhide --event <slug> <kind>:<id> --yes --confirm <kind>:<id>', 'moderation delete --event <slug> <kind>:<id> --yes --confirm <kind>:<id>', 'moderation purge-reports --event <slug> --yes --confirm <slug>']) {
        assert.ok(r.stderr.includes(`${CLI} ${command}`), `${args.join(' ')}: ${command}`);
      }
      assert.ok(r.stderr.includes('docs/ADMIN_CLI.md'));
      assert.ok(r.stderr.includes('except on Windows, where the CLI reads only ADMIN_TOKEN and no token file'), r.stderr);
    }
  });

  test('it imports only node:util and holds no fetch, signer, socket or child process, so it cannot send a request at all', () => {
    // The code without its comments, so a comment may name what the script does not do. A line
    // comment starts at the beginning of a line or after white space, so "https://" in a string stays.
    const code = readFileSync(MODERATION, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    // Every static import and re-export, with either quote, including a bare `import 'x'`.
    const specifiers = [...code.matchAll(/(?:^|[;\s])(?:import|export)\b(?:[^'"`;]*?\bfrom)?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
    assert.deepEqual(specifiers, ['node:util']);
    assert.ok(!/\bimport\s*\(/.test(code), 'a dynamic import');
    assert.ok(!/\brequire\s*\(/.test(code), 'require');
    for (const word of ['fetch', 'signAdminRequest', 'adminClient', 'http', 'node:net', 'node:tls', 'node:dgram', 'child_process', 'XMLHttpRequest', 'WebSocket', 'process.binding', 'createRequire']) assert.ok(!code.includes(word), word);
  });

  test('a value without the shape of its field is shown as a placeholder, never as it was typed', async () => {
    const r = await moderation(['--event', 'Bad Slug\u001b[31m', '--unhide', 'profile:FAKE\nline', '--api', 'http://127.0.0.1:9']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(`The equivalent command: ${CLI} moderation unhide --event <slug> <kind>:<id> --yes --confirm <kind>:<id>`), r.stderr);
    assert.ok(!r.stderr.includes('FAKE') && !r.stderr.includes('\u001b') && !r.stderr.includes('Bad Slug'), r.stderr);
    const since = await moderation(['--event', SLUG, '--since', 'yesterday; rm']);
    assert.ok(since.stderr.includes(`${CLI} moderation queue --event ${SLUG} --since <iso>`), since.stderr);
    assert.ok(!since.stderr.includes('yesterday'), since.stderr);
  });
});

// Step e: no client sends v1. Every X-Caddie-Admin header that reached a server of this file, from
// adminClient in this process and from the scripts run as child processes, under every value of
// CADDIE_ADMIN_SIG_VERSION above, is v2. This is an end-of-file sweep: it reads the headers that
// the earlier tests recorded, so it comes last, and it needs the whole file to run. Under a test
// name filter the other tests may not have run, so the count is not checked then; the headers that
// were recorded must still all be v2. Each test that uses recorder() also checks its own requests
// with assertSigned, which fails on a v1 header in the test that sent it.
const FILTERED = process.execArgv.some((a) => /^--test-(name-pattern|skip-pattern|only)\b/.test(a));
test('no server of this file ever received a v1 header', () => {
  if (!FILTERED) assert.ok(adminHeaders.length >= 40, `only ${adminHeaders.length} headers were recorded`);
  for (const h of adminHeaders) assert.match(h, /^v2 /);
});
