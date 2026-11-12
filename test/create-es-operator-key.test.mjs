// scripts/create-es-keys.mjs --operator against a stub of the Elasticsearch security endpoints it uses.
// The stub derives every answer for the operator key from the role descriptors the script minted, so
// the test fails when the role is wrong, not only when the script prints the wrong thing.

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
const KEY_ID = 'abcDEF123keyid';
const ADMIN = 'setup-admin-key-VALUE-9876543210';

const EXPECTED_ROLE_INDICES = [
  { names: ['caddie-*'], privileges: ['read', 'write', 'view_index_metadata', 'monitor', 'maintenance'] },
  { names: ['caddie-topicwork-*'], privileges: ['create_index', 'delete_index'] },
];
const EXPECTED_CLUSTER = ['cluster:monitor/health', 'cluster:monitor/state'];

const globMatch = (pattern, name) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);

function stub({ breakInference = false } = {}) {
  const calls = [];
  let descriptor = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const operator = req.headers.authorization === `ApiKey ${MINTED}`;
      const granted = (name, priv) => descriptor?.indices.some((i) => i.names.some((n) => globMatch(n, name)) && i.privileges.includes(priv));
      if (req.method === 'POST' && req.url === '/_security/api_key') { descriptor = Object.values(body.role_descriptors)[0]; return send(200, { id: KEY_ID, encoded: MINTED }); }
      if (req.method === 'DELETE' && req.url === '/_security/api_key') return send(200, { invalidated_api_keys: body.ids });
      if (req.url.startsWith('/_security/role') && req.method === 'GET') return send(operator ? 403 : 200, {});
      if (req.url.startsWith('/_security/role') || req.url.startsWith('/_security/user/caddie-operator-svc')) return send(200, {});
      if (req.url === '/_security/user/_has_privileges') {
        const cluster = Object.fromEntries(body.cluster.map((p) => [p, descriptor.cluster.includes(p) || (breakInference && p === 'monitor_inference')]));
        const index = Object.fromEntries(body.index.map((i) => [i.names[0], Object.fromEntries(i.privileges.map((p) => [p, !!granted(i.names[0], p)]))]));
        return send(200, { cluster, index });
      }
      if (req.url.startsWith('/_inference/')) return send(operator && !breakInference ? 403 : 200, {});
      if (req.url.startsWith('/keycheck-outside-never')) return send(granted('keycheck-outside-never', 'read') ? 200 : 403, {});
      if (req.url.startsWith('/_cluster/health')) return send(descriptor.cluster.includes('cluster:monitor/health') ? 200 : 403, {});
      if (req.url.startsWith('/_cat/indices')) return send(granted('caddie-talks', 'monitor') && descriptor.cluster.includes('cluster:monitor/state') ? 200 : 403, [{ index: 'caddie-talks-v3', 'docs.count': '12' }, { index: 'caddie-people-v2', 'docs.count': '3' }]);
      const topicwork = /^\/(caddie-topicwork-[^/?]+)$/.exec(req.url);
      if (topicwork && (req.method === 'PUT' || req.method === 'DELETE')) return send(granted(topicwork[1], req.method === 'PUT' ? 'create_index' : 'delete_index') ? 200 : 403, {});
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

test('--operator mints the exact limited role into a 0600 file, prints the id but no key, and needs no GC_PROJECT', async () => {
  const s = await stub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-opkey-'));
  const file = path.join(dir, 'sub', 'es-admin-key');
  try {
    const r = await run(['--operator', '--out', file, '--expiration', '30d'], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(file, 'utf8'), MINTED);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!r.out.includes(MINTED) && !r.out.includes(ADMIN), 'a key value reached the output');
    assert.ok(r.out.includes(KEY_ID), 'the key id is printed');
    assert.doesNotMatch(r.out, /FAIL/);
    const role = s.calls.find((c) => c.method === 'PUT' && c.url === '/_security/role/caddie_operator').body;
    assert.deepEqual(role.indices, EXPECTED_ROLE_INDICES);
    assert.deepEqual(role.cluster, [...EXPECTED_CLUSTER, 'manage_own_api_key']);
    const key = s.calls.find((c) => c.url === '/_security/api_key' && c.method === 'POST').body;
    assert.equal(key.expiration, '30d');
    assert.deepEqual(Object.values(key.role_descriptors)[0], { cluster: EXPECTED_CLUSTER, indices: EXPECTED_ROLE_INDICES });
    assert.ok(s.calls.some((c) => c.url === '/_security/user/caddie-operator-svc/_password'), 'the service user password was not reset');
    assert.ok(!s.calls.some((c) => c.method === 'DELETE' && c.url === '/_security/api_key'), 'a good key must not be invalidated');

    const again = await run(['--operator', '--out', file], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(again.status, 1);
    assert.match(again.out, /never overwrites/);
    assert.equal(fs.readFileSync(file, 'utf8'), MINTED);
  } finally {
    s.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--expiration is capped at 365 days and must be a duration', async () => {
  const s = await stub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-opkey-'));
  try {
    for (const bad of ['forever', '366d', '9000h', '600000m', '0d']) {
      const r = await run(['--operator', '--out', path.join(dir, 'k'), '--expiration', bad], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
      assert.equal(r.status, 1, bad);
      assert.match(r.out, /at most 365d/, bad);
    }
    const ok = await run(['--operator', '--out', path.join(dir, 'k'), '--expiration', '365d'], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(ok.status, 0, ok.out);
  } finally {
    s.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed self-check (inference reachable) invalidates the new key with the setup key and removes the file', async () => {
  const s = await stub({ breakInference: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-opkey-'));
  const file = path.join(dir, 'es-admin-key');
  try {
    const r = await run(['--operator', '--out', file], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL/);
    assert.ok(!fs.existsSync(file), 'the key file must be removed');
    const del = s.calls.find((c) => c.method === 'DELETE' && c.url === '/_security/api_key');
    assert.ok(del, 'the new key must be invalidated');
    assert.deepEqual(del.body, { ids: [KEY_ID] });
    assert.equal(del.auth, `ApiKey ${ADMIN}`, 'invalidated with the setup key');
    assert.ok(!r.out.includes(MINTED));
  } finally {
    s.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key file that cannot be written invalidates the new key', async () => {
  const s = await stub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-opkey-'));
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file where a directory is needed');
  try {
    const r = await run(['--operator', '--out', path.join(dir, 'blocker', 'es-admin-key')], { ES_URL: s.url, ELASTISEARCH_API_KEY: ADMIN });
    assert.equal(r.status, 1, r.out);
    assert.ok(s.calls.some((c) => c.method === 'DELETE' && c.url === '/_security/api_key'));
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
