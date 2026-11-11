// The push service allowlist and its use at send time. Runs under plain node --test:
// `npm --prefix worker test`. Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { PUSH_SERVICE_HOSTS, isPushServiceEndpoint } from '../src/push/webpush.js';
import { sendPush } from '../src/push/send.js';

test('PUSH_SERVICE_HOSTS stays a flat array of strings', () => {
  assert.ok(Array.isArray(PUSH_SERVICE_HOSTS));
  assert.ok(PUSH_SERVICE_HOSTS.every((h) => typeof h === 'string'));
});

test('jmt17.google.com (Chrome Beta, Dev, Canary and Chromium) is accepted as an exact host', () => {
  assert.equal(isPushServiceEndpoint('https://jmt17.google.com/fcm/send/abc'), true);
  assert.ok(PUSH_SERVICE_HOSTS.includes('jmt17.google.com'));
});

test('jmt17.google.com is not a suffix match and is not widened to google.com', () => {
  for (const url of [
    'https://x.jmt17.google.com/fcm/send/abc',
    'https://jmt17.google.com.evil.com/fcm/send/abc',
    'https://google.com/fcm/send/abc',
    'https://www.google.com/fcm/send/abc',
    'https://jmt17.google.com:8443/fcm/send/abc',
    'http://jmt17.google.com/fcm/send/abc',
    'https://user:pw@jmt17.google.com/fcm/send/abc',
  ]) {
    assert.equal(isPushServiceEndpoint(url), false, url);
  }
});

test('the other known hosts still work and unknown hosts are refused', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://db5p.notify.windows.com/?token=abc',
    'https://web.push.apple.com/abc',
  ]) {
    assert.equal(isPushServiceEndpoint(url), true, url);
  }
  for (const url of ['https://example.com/x', 'https://192.0.2.10/push', 'https://push.services.mozilla.com.evil.com/x', 'not a url']) {
    assert.equal(isPushServiceEndpoint(url), false, url);
  }
});

// A ctx holding one stored row; records the ids the Worker deletes.
function fakeCtx(row, env) {
  const deleted = [];
  const ctx = {
    env,
    sql: {
      exec(query, ...args) {
        if (query.startsWith('DELETE')) {
          deleted.push(args[0]);
          return { toArray: () => [] };
        }
        return { toArray: () => [row] };
      },
    },
  };
  return { ctx, deleted };
}

function vapidEnv() {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:owner@example.com',
  };
}

function subscriber(endpoint) {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  return { id: 1, profile_id: 'p', endpoint, p256dh: browser.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

async function withStubs(fetchStub, fn) {
  const logs = [];
  const realError = console.error;
  const realFetch = globalThis.fetch;
  console.error = (...a) => logs.push(a.join(' '));
  globalThis.fetch = fetchStub;
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = realError;
    globalThis.fetch = realFetch;
  }
}

test('a stored row off the allowlist is skipped and logged by host only, never deleted or sent to', async () => {
  const { ctx, deleted } = fakeCtx(subscriber('https://new-push-host.example/secret/path?token=SECRETVALUE'), vapidEnv());
  let fetched = 0;
  const { result, logs } = await withStubs(
    async () => {
      fetched++;
      return new Response(null, { status: 201 });
    },
    () => sendPush(ctx, ['p']),
  );
  assert.equal(result, 0);
  assert.deepEqual(deleted, [], 'the row is kept');
  assert.equal(fetched, 0, 'nothing is sent to an unknown host');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /new-push-host\.example/);
  assert.doesNotMatch(logs[0], /secret|SECRETVALUE/i, 'the path and query are never logged');
});

test('a row on the allowlist is still deleted on the push service 404 or 410, and kept on 201', async () => {
  for (const [status, gone] of [[404, true], [410, true], [201, false]]) {
    const { ctx, deleted } = fakeCtx(subscriber('https://jmt17.google.com/fcm/send/abc'), vapidEnv());
    const { result } = await withStubs(
      async (url) => {
        assert.equal(new URL(url).host, 'jmt17.google.com');
        return new Response(null, { status });
      },
      () => sendPush(ctx, ['p']),
    );
    assert.deepEqual(deleted, gone ? [1] : [], `status ${status}`);
    assert.equal(result, status === 201 ? 1 : 0);
  }
});
