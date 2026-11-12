// scripts/build-facets.mjs reads the caddie-facets alias first and sends POST /_aliases only when the
// alias does not already point at the index, so a key without index management can rebuild facets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stub({ aliased }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url.split('?')[0]}`);
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.method === 'HEAD') return send(200, {});
      if (req.url.startsWith('/_alias/caddie-facets')) return aliased ? send(200, { 'caddie-facets-v1': { aliases: { 'caddie-facets': {} } } }) : send(404, {});
      if (req.url === '/_aliases') return send(200, { acknowledged: true });
      if (req.url.startsWith('/caddie-talks/_search')) return send(200, { hits: { hits: [] } });
      if (req.url.startsWith('/caddie-facets-v1/_delete_by_query')) return send(200, {});
      return send(500, { error: `unexpected ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build-facets.mjs', 'some-conference'], { cwd: ROOT, env: { PATH: '/usr/bin:/bin', ES_URL: url, ELASTISEARCH_API_KEY: 'dummy-key-value' } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('an existing alias is left alone: no POST /_aliases', async () => {
  const s = await stub({ aliased: true });
  try {
    const r = await run(s.url);
    assert.equal(r.status, 0, r.out);
    assert.ok(s.calls.includes('GET /_alias/caddie-facets'));
    assert.ok(!s.calls.includes('POST /_aliases'), s.calls.join('\n'));
  } finally { s.server.close(); }
});

test('a missing alias is created with POST /_aliases', async () => {
  const s = await stub({ aliased: false });
  try {
    const r = await run(s.url);
    assert.equal(r.status, 0, r.out);
    assert.ok(s.calls.includes('POST /_aliases'), s.calls.join('\n'));
  } finally { s.server.close(); }
});
