// scripts/create-es-keys.mjs --operator against a stub of the few Elasticsearch security endpoints it
// uses: the key goes to a 0600 file and nowhere else, the role has no security privilege, an existing
// file is never overwritten, and --operator needs neither GC_PROJECT nor gcloud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINTED = 'minted-operator-key-VALUE-0123456789';
const ADMIN = 'setup-admin-key-VALUE-9876543210';

function stub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const operator = req.headers.authorization === `ApiKey ${MINTED}`;
      if (req.method === 'POST' && req.url === '/_security/api_key') return send(200, { id: 'x', encoded: MINTED });
      if (req.url.startsWith('/_security/role') && req.method === 'GET') return send(operator ? 403 : 200, {});
      if (req.url.startsWith('/_security/role') || req.url.startsWith('/_security/user/caddie-operator-svc')) return send(200, {});
      if (req.url === '/_security/user/_has_privileges') {
        const cluster = Object.fromEntries(body.cluster.map((p) => [p, p === 'monitor']));
        const ok = ['read', 'write', 'delete', 'maintenance', 'view_index_metadata'];
        const index = { 'caddie-people': Object.fromEntries(body.index[0].privileges.map((p) => [p, ok.includes(p)])) };
        return send(200, { cluster, index });
      }
      if (req.url.startsWith('/caddie-keycheck-not-ours')) return send(403, {});
      if (req.url.startsWith('/_cluster/health') || req.url.startsWith('/_cat/indices')) return send(200, {});
      return send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/create-es-keys.mjs', ...args], { cwd: ROOT, env: { PATH: '/usr/bin:/bin', ...env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('--operator mints a limited key into a 0600 file, prints no key, and needs no GC_PROJECT', async () => {
  const s = await stub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-opkey-'));
  const file = path.join(dir, 'sub', 'es-admin-key');
  try {
    const r = await run(['--operator', '--out', file, '--expiration', '30d'], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(file, 'utf8'), MINTED);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!r.out.includes(MINTED) && !r.out.includes(ADMIN), 'a key value reached the output');
    assert.doesNotMatch(r.out, /FAIL/);
    const role = s.calls.find((c) => c.method === 'PUT' && c.url === '/_security/role/caddie_operator').body;
    assert.deepEqual(role.indices, [{ names: ['caddie-*'], privileges: ['read', 'write', 'delete', 'maintenance', 'view_index_metadata'] }]);
    assert.ok(!role.cluster.some((p) => /security|manage$|all|inference/.test(p.replace('manage_own_api_key', ''))), role.cluster.join());
    const key = s.calls.find((c) => c.url === '/_security/api_key').body;
    assert.equal(key.expiration, '30d');
    assert.deepEqual(Object.values(key.role_descriptors)[0].cluster, ['monitor']);
    assert.ok(s.calls.some((c) => c.url === '/_security/user/caddie-operator-svc/_password'), 'the service user password was not reset');

    const again = await run(['--operator', '--out', file], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(again.status, 1);
    assert.match(again.out, /never overwrites/);
    assert.equal(fs.readFileSync(file, 'utf8'), MINTED);

    const bad = await run(['--operator', '--out', path.join(dir, 'other'), '--expiration', 'forever'], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(bad.status, 1);
  } finally {
    s.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without --operator the script still requires GC_PROJECT', async () => {
  const r = await run([], { ES_URL: 'http://127.0.0.1:1', ELASTISEARCH_API_KEY: ADMIN });
  assert.equal(r.status, 1);
  assert.match(r.out, /Set GC_PROJECT/);
});
