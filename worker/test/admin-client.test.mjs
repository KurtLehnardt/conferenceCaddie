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
import { UsageError, adminClient, drainPending } from '../ingest/lib.mjs';

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
  for (const s of servers) s.close();
});

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
