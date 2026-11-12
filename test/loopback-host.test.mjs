import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost } from '../scripts/lib/loopback-host.mjs';

const host = (u) => new URL(u).hostname;
test('loopback hosts', () => {
  for (const u of ['http://localhost:8787', 'http://api.localhost', 'http://127.0.0.1', 'http://127.1.2.3:80', 'http://0.0.0.0', 'http://[::1]:8787', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]/', 'http://LOCALHOST']) {
    assert.equal(isLoopbackHost(host(u)), true, u);
  }
});
test('non-loopback hosts', () => {
  for (const u of ['https://caddie.example.workers.dev', 'http://localhost.evil.example', 'http://evil-localhost', 'http://128.0.0.1', 'http://10.0.0.1', 'http://[::2]', 'http://[::ffff:8.8.8.8]', 'http://127.0.0.1.evil.example']) {
    assert.equal(isLoopbackHost(host(u)), false, u);
  }
});
