// Native push (server/native-push.mjs) on its own: the APNs provider token (shape, signature,
// caching and renewal) and the FCM access token from the metadata server (caching, renewal and
// back-off), the requests each channel sends, how each answer of APNs and FCM is handled, the
// configuration and what it logs, the token formats, and the real HTTP/2 transport against a local
// plain-text HTTP/2 server.
//
// Run with `npm test`. Nothing here reaches Apple or Google: the channels get injected transports,
// and the one real HTTP/2 test talks to a server on 127.0.0.1 (a port from 8702 to 8709). Every key
// is generated for this run; the .p8 files the APNs channel reads are written only to a temporary
// directory that is removed when the run ends (test/helpers/apns-key.mjs).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { writeKeyFile, missingKeyFile } from './helpers/apns-key.mjs';

const SETTINGS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_FILE', 'APNS_BUNDLE_ID', 'FCM_PROJECT_ID', 'PUSH_TRANSPORT', 'PUSH_STUB_URL'];
for (const k of SETTINGS) delete process.env[k];

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
// The .p8 key is read from the file APNS_KEY_FILE names, as Cloud Run mounts the secret.
const KEY_FILE = writeKeyFile(P8);
const APNS_ENV = { APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_KEY_FILE: KEY_FILE };
// FCM needs no key: only the Firebase project id.
const FCM_ENV = { FCM_PROJECT_ID: 'caddie-test-project' };
// The access token the stand-in metadata server hands out; it must never reach a log line.
const ACCESS_TOKEN_PREFIX = 'ya29.stand-in-access-token-';

// The module reads this server's own settings, and the APNs key from its file, when it is imported.
Object.assign(process.env, APNS_ENV, FCM_ENV);
const native = await import('../server/native-push.mjs');
const { AUTH_FAILURES_MAX, createNativePush, nativeTokenOf, signJwt, http2Transport, apnsConfigFrom, fcmConfigFrom, APNS_ORIGINS, FCM_TOKEN_URL, fcmSendUrl, NATIVE_ALERT, APNS_BODY, fcmMessageOf } = native;
for (const k of SETTINGS) delete process.env[k];

const APNS_TOKEN = crypto.randomBytes(32).toString('hex');
const FCM_TOKEN = `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
// The generic alert, byte for byte: what every native push shows, whoever it is for.
const ALERT_TITLE = 'Conference Caddie';
const ALERT_BODY = 'Someone whose experience matches yours is in your zone right now';
const APNS_BYTES = `{"aps":{"alert":{"title":"${ALERT_TITLE}","body":"${ALERT_BODY}"},"sound":"default"},"deepLink":"caddie://people?around=1"}`;
const fcmBytes = (token, ttl = 600) => `{"message":{"token":"${token}","notification":{"title":"${ALERT_TITLE}","body":"${ALERT_BODY}"},"data":{"deepLink":"caddie://people?around=1"},"android":{"ttl":"${ttl}s","priority":"normal","notification":{"tag":"caddie-nudge"}}}}`;
const T0 = Date.UTC(2099, 5, 1, 9, 0, 0);
const MIN = 60_000;

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const until = async (cond, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// A clock the test moves, and a log that collects lines.
function harness() {
  const clock = { t: T0 };
  const lines = [];
  return { clock, now: () => clock.t, lines, log: (line) => lines.push(String(line)) };
}

// No log line may carry key material, a token or a JWT.
function assertClean(lines, extra = []) {
  const secrets = [P8, RSA_PEM, APNS_TOKEN, FCM_TOKEN, ACCESS_TOKEN_PREFIX, ...extra];
  for (const line of lines) {
    for (const s of secrets) {
      for (const piece of String(s).split(/\s+/).filter((p) => p.length >= 12 && !p.startsWith('-----'))) {
        assert.ok(!line.includes(piece.slice(0, 24)), `a log line carries secret material: ${line.slice(0, 60)}`);
      }
    }
    assert.doesNotMatch(line, /eyJ[A-Za-z0-9_-]{10,}/, 'a log line carries a JWT');
    assert.doesNotMatch(line, /BEGIN|PRIVATE KEY/);
  }
}

// An APNs transport that answers from a list (the last answer repeats) and records each request.
function apnsStub(...answers) {
  const calls = [];
  const transport = async (origin, req) => {
    calls.push({ origin, ...req, payload: JSON.parse(req.body) });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { status: a.status, body: a.reason ? JSON.stringify({ reason: a.reason, ...(a.status === 410 ? { timestamp: T0 } : {}) }) : '' };
  };
  return { transport, calls };
}

function apnsChannel(answers, env = {}) {
  const h = harness();
  const stub = apnsStub(...answers);
  const push = createNativePush({ ...APNS_ENV, ...env }, { apnsTransport: stub.transport, now: h.now, log: h.log });
  return { ...h, ...stub, push };
}

const reg = (over = {}) => ({ platform: 'apns', token: APNS_TOKEN, environment: 'production', ...over });

describe('APNs', () => {
  test('the provider token is an ES256 JWT with kid, iss and iat, signed by the .p8 key', async () => {
    const { push, calls } = apnsChannel([{ status: 200 }]);
    assert.equal(await push.send(reg()), 'sent');
    const auth = calls[0].headers.authorization;
    assert.match(auth, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [h, c, s] = auth.slice('bearer '.length).split('.');
    assert.deepEqual(decode(h), { alg: 'ES256', kid: 'ABCDE12345' });
    assert.deepEqual(decode(c), { iss: 'TEAM123456', iat: Math.floor(T0 / 1000) });
    const signature = Buffer.from(s, 'base64url');
    assert.equal(signature.length, 64, 'JOSE ES256 is the raw 64-byte r||s, not DER');
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: other, dsaEncoding: 'ieee-p1363' }, signature), false);
  });

  test('the request: host by environment, /3/device/{token}, the topic, alert, priority 5, expiry in 600 s, and the generic alert only', async () => {
    const { push, calls } = apnsChannel([{ status: 200 }], { APNS_BUNDLE_ID: 'app.conferencecaddie.dev' });
    await push.send(reg(), { ttl: 600 });
    await push.send(reg({ environment: 'sandbox' }), { ttl: 600 });
    assert.equal(calls[0].origin, 'https://api.push.apple.com');
    assert.equal(calls[1].origin, 'https://api.sandbox.push.apple.com');
    assert.equal(APNS_ORIGINS.production, 'https://api.push.apple.com');
    assert.equal(calls[0].path, `/3/device/${APNS_TOKEN}`);
    const { authorization, ...headers } = calls[0].headers;
    assert.ok(authorization);
    assert.deepEqual(headers, {
      'apns-topic': 'app.conferencecaddie.dev',
      'apns-push-type': 'alert',
      'apns-priority': '5',
      'apns-expiration': String(Math.floor(T0 / 1000) + 600),
      'apns-collapse-id': 'caddie-nudge',
      'content-type': 'application/json',
    });
    assert.equal(calls[0].body, APNS_BYTES, 'the exact bytes: the constant alert and the deep link, nothing else');
    assert.equal(calls[1].body, APNS_BYTES);
    assert.equal(APNS_BODY, APNS_BYTES);
  });

  test('the topic defaults to app.conferencecaddie', async () => {
    const { push, calls } = apnsChannel([{ status: 200 }]);
    await push.send(reg());
    assert.equal(calls[0].headers['apns-topic'], 'app.conferencecaddie');
    assert.equal(calls[0].headers['apns-expiration'], String(Math.floor(T0 / 1000) + 600), 'the default TTL is the Web Push one, 600 s');
  });

  test('the provider token is reused for 40 minutes, then renewed', async () => {
    const { push, calls, clock } = apnsChannel([{ status: 200 }]);
    await push.send(reg());
    clock.t += 39 * MIN;
    await push.send(reg());
    clock.t += 1 * MIN;
    await push.send(reg());
    const tokens = calls.map((c) => c.headers.authorization);
    assert.equal(tokens[0], tokens[1], 'reused within 40 minutes');
    assert.notEqual(tokens[1], tokens[2], 'renewed at 40 minutes');
    assert.equal(decode(tokens[2].split('.')[1]).iat, Math.floor((T0 + 40 * MIN) / 1000));
  });

  test('410 and 400 BadDeviceToken mean the token is gone', async () => {
    for (const answer of [{ status: 410, reason: 'Unregistered' }, { status: 410, reason: 'ExpiredToken' }, { status: 400, reason: 'BadDeviceToken' }]) {
      const { push, lines } = apnsChannel([answer]);
      assert.equal(await push.send(reg()), 'gone', JSON.stringify(answer));
      assert.deepEqual(lines, []);
    }
  });

  test('other refusals, rate limits and server errors fail without deleting, with one clean log line', async () => {
    // DeviceTokenNotForTopic is what every token gives when APNS_BUNDLE_ID is wrong: deleting on it
    // would wipe every registration, so it only fails.
    for (const answer of [{ status: 400, reason: 'DeviceTokenNotForTopic' }, { status: 400, reason: 'BadExpirationDate' }, { status: 400, reason: 'BadTopic' }, { status: 429, reason: 'TooManyRequests' }, { status: 500, reason: 'InternalServerError' }, { status: 503, reason: 'ServiceUnavailable' }, { status: 413, reason: 'PayloadTooLarge' }]) {
      const { push, lines, calls } = apnsChannel([answer]);
      assert.equal(await push.send(reg()), 'failed', JSON.stringify(answer));
      assert.equal(calls.length, 1, 'no retry');
      assert.deepEqual(lines, [`Native push failed: apns ${answer.status} ${answer.reason}`]);
      assertClean(lines);
    }
    const odd = apnsChannel([{ status: 400, reason: 'Bad Device "token" <x>' }]);
    assert.equal(await odd.push.send(reg()), 'failed');
    assert.deepEqual(odd.lines, ['Native push failed: apns 400'], 'a reason that is not a plain code is not logged');
  });

  test('a transport that fails or times out fails the push with the error class only', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const reset = Object.assign(new Error(`connect ECONNRESET ${APNS_TOKEN}`), { code: 'ECONNRESET' });
    for (const [err, want] of [[timeout, 'timeout'], [reset, 'ECONNRESET'], [new Error(`odd ${APNS_TOKEN}`), 'network error']]) {
      const { push, lines } = apnsChannel([err]);
      assert.equal(await push.send(reg()), 'failed');
      assert.deepEqual(lines, [`Native push failed: apns ${want}`]);
      assertClean(lines);
    }
  });

  test('403 ExpiredProviderToken or InvalidProviderToken renews the provider token and retries once', async () => {
    for (const reason of ['ExpiredProviderToken', 'InvalidProviderToken']) {
      const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason }, { status: 200 }]);
      await push.send(reg());
      clock.t += 25 * MIN;
      assert.equal(await push.send(reg()), 'sent', reason);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].headers.authorization, calls[0].headers.authorization, 'the cached token was tried first');
      assert.notEqual(calls[2].headers.authorization, calls[1].headers.authorization, 'the retry has a new token');
      assert.equal(decode(calls[2].headers.authorization.split('.')[1]).iat, Math.floor((T0 + 25 * MIN) / 1000));
      assert.deepEqual(lines, []);
    }
  });

  test('a renewed token that is refused again fails after exactly one retry', async () => {
    const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason: 'ExpiredProviderToken' }]);
    await push.send(reg());
    clock.t += 30 * MIN;
    assert.equal(await push.send(reg()), 'failed');
    assert.equal(calls.length, 3, 'the first send, the refused one and one retry');
    assert.deepEqual(lines, ['Native push failed: apns 403 ExpiredProviderToken']);
  });

  test('a provider token younger than 20 minutes is not renewed on a 403, because Apple refuses renewals that frequent', async () => {
    const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason: 'InvalidProviderToken' }]);
    await push.send(reg());
    clock.t += 5 * MIN;
    assert.equal(await push.send(reg()), 'failed');
    assert.equal(calls.length, 2, 'no retry');
    assert.deepEqual(lines, ['Native push failed: apns 403 InvalidProviderToken']);
    const first = apnsChannel([{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }]);
    assert.equal(await first.push.send(reg()), 'failed', 'a token minted for this very push is not renewed either');
    assert.equal(first.calls.length, 1);
  });

  test('a 403 ExpiredProviderToken retries with the current token when another push has renewed it meanwhile', async () => {
    const h = harness();
    const auths = [];
    let releaseFirst;
    const transport = async (origin, req) => {
      auths.push(req.headers.authorization);
      const n = auths.length;
      if (n === 2) await new Promise((resolve) => (releaseFirst = resolve));
      if (n === 2 || n === 3) return { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) };
      return { status: 200, body: '' };
    };
    const push = createNativePush(APNS_ENV, { apnsTransport: transport, now: h.now, log: h.log });
    assert.equal(await push.send(reg()), 'sent', 'the first token, T1');
    h.clock.t += 25 * MIN;
    // A is refused with T1 but only answered after B has been refused with T1 too and has renewed
    // the token to T2 (T1 is 25 minutes old, so B may renew it).
    const a = push.send(reg());
    await until(() => auths.length === 2);
    assert.equal(await push.send(reg()), 'sent', 'B: renewed and retried');
    releaseFirst();
    assert.equal(await a, 'sent', 'A: retried with the token B renewed, though it is younger than 20 minutes');
    const [t1] = auths;
    assert.deepEqual(auths.map((x) => (x === t1 ? 'T1' : 'T2')), ['T1', 'T1', 'T1', 'T2', 'T2']);
    assert.deepEqual(h.lines, []);
  });

  test('403 for another reason is not retried', async () => {
    const { push, calls, clock } = apnsChannel([{ status: 200 }, { status: 403, reason: 'BadCertificateEnvironment' }, { status: 200 }]);
    await push.send(reg());
    clock.t += 30 * MIN;
    assert.equal(await push.send(reg()), 'failed');
    assert.equal(calls.length, 2);
  });
});

// A fetch for FCM: the metadata server answers tokens t1, t2, ... valid for expiresIn seconds (or
// the answers in token, the last one repeating); the send URL answers from a list (the last answer
// repeats).
function fcmStub({ sends = [{ status: 200, body: { name: 'projects/caddie-test-project/messages/1' } }], token = [], expiresIn = 3600 } = {}) {
  const calls = [];
  let tokens = 0;
  let sent = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === FCM_TOKEN_URL) {
      const a = token[Math.min(tokens, token.length - 1)];
      tokens++;
      if (a instanceof Error) throw a;
      if (a) return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
      return new Response(JSON.stringify({ access_token: `${ACCESS_TOKEN_PREFIX}t${tokens}`, expires_in: expiresIn, token_type: 'Bearer' }), { status: 200 });
    }
    const a = sends[Math.min(sent, sends.length - 1)];
    sent++;
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
  };
  return { fetchImpl, calls, tokenCalls: () => calls.filter((c) => c.url === FCM_TOKEN_URL), sendCalls: () => calls.filter((c) => c.url !== FCM_TOKEN_URL) };
}

function fcmChannel(opts = {}, env = {}) {
  const h = harness();
  const stub = fcmStub(opts);
  const push = createNativePush({ ...FCM_ENV, ...env }, { fetch: stub.fetchImpl, now: h.now, log: h.log });
  return { ...h, ...stub, push };
}

const fcmReg = (over = {}) => ({ platform: 'fcm', token: FCM_TOKEN, environment: 'production', ...over });
const bearer = (n) => `Bearer ${ACCESS_TOKEN_PREFIX}t${n}`;
const fcmError = (code, status, errorCode, extra = []) => ({ status: code, body: { error: { code, message: 'x', status, details: [...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []), ...extra] } } });
const tokenViolation = { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token', description: 'The registration token is not a valid FCM registration token' }] };

describe('FCM', () => {
  test('the access token is the runtime service account\'s, from the metadata server, with no key and only the firebase.messaging scope', async () => {
    const { push, tokenCalls } = fcmChannel();
    assert.equal(await push.send(fcmReg()), 'sent');
    const [call] = tokenCalls();
    assert.equal(call.url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/firebase.messaging');
    assert.deepEqual(new URL(call.url).searchParams.getAll('scopes'), ['https://www.googleapis.com/auth/firebase.messaging'], 'not cloud-platform');
    assert.equal(call.init.method, undefined, 'a GET');
    assert.equal(call.init.body, undefined);
    assert.deepEqual(call.init.headers, { 'Metadata-Flavor': 'Google' });
    assert.ok(call.init.signal instanceof AbortSignal, 'the token request has a timeout');
  });

  test('the send: the project URL, the access token, and the generic alert with a 600 s TTL at normal priority', async () => {
    const { push, sendCalls } = fcmChannel();
    await push.send(fcmReg(), { ttl: 600 });
    const [call] = sendCalls();
    assert.equal(call.url, 'https://fcm.googleapis.com/v1/projects/caddie-test-project/messages:send');
    assert.equal(call.url, fcmSendUrl('caddie-test-project'));
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, { Authorization: bearer(1), 'Content-Type': 'application/json' });
    assert.equal(call.init.body, fcmBytes(FCM_TOKEN), 'the exact bytes: the token, the constant alert and the deep link, nothing else');
    assert.deepEqual(JSON.parse(call.init.body), {
      message: {
        token: FCM_TOKEN,
        notification: { title: ALERT_TITLE, body: ALERT_BODY },
        data: { deepLink: 'caddie://people?around=1' },
        android: { ttl: '600s', priority: 'normal', notification: { tag: 'caddie-nudge' } },
      },
    });
    assert.deepEqual(fcmMessageOf(FCM_TOKEN, 600), JSON.parse(call.init.body));
    assert.ok(call.init.signal instanceof AbortSignal, 'every request has a timeout');
  });

  test('FCM_PROJECT_ID names the project the messages are sent through', async () => {
    const { push, sendCalls } = fcmChannel({}, { FCM_PROJECT_ID: 'caddie-other-project' });
    await push.send(fcmReg());
    assert.equal(sendCalls()[0].url, 'https://fcm.googleapis.com/v1/projects/caddie-other-project/messages:send');
  });

  test('the access token is cached until a minute before it expires, and concurrent sends share one request', async () => {
    const { push, tokenCalls, sendCalls, clock } = fcmChannel();
    await Promise.all([push.send(fcmReg()), push.send(fcmReg()), push.send(fcmReg())]);
    assert.equal(tokenCalls().length, 1, 'one token request for three concurrent sends');
    clock.t += 58 * MIN;
    await push.send(fcmReg());
    assert.equal(tokenCalls().length, 1, 'still cached at 58 minutes of 60');
    clock.t += 1 * MIN;
    await push.send(fcmReg());
    assert.equal(tokenCalls().length, 2, 'renewed at 59 minutes');
    assert.deepEqual(sendCalls().map((c) => c.init.headers.Authorization), [bearer(1), bearer(1), bearer(1), bearer(1), bearer(2)]);
  });

  test('401 renews the access token and retries once', async () => {
    const ok = fcmChannel({ sends: [fcmError(401, 'UNAUTHENTICATED'), { status: 200, body: {} }] });
    assert.equal(await ok.push.send(fcmReg()), 'sent');
    assert.deepEqual(ok.sendCalls().map((c) => c.init.headers.Authorization), [bearer(1), bearer(2)]);
    assert.deepEqual(ok.lines, []);
    const again = fcmChannel({ sends: [fcmError(401, 'UNAUTHENTICATED')] });
    assert.equal(await again.push.send(fcmReg()), 'failed');
    assert.equal(again.sendCalls().length, 2, 'exactly one retry');
    assert.deepEqual(again.lines, ['Native push failed: fcm 401 UNAUTHENTICATED']);
  });

  test('404 UNREGISTERED and 400 INVALID_ARGUMENT on message.token mean the token is gone', async () => {
    for (const answer of [fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', [tokenViolation])]) {
      const { push, lines } = fcmChannel({ sends: [answer] });
      assert.equal(await push.send(fcmReg()), 'gone', JSON.stringify(answer));
      assert.deepEqual(lines, []);
    }
  });

  test('a 404 without UNREGISTERED (a wrong project) and an INVALID_ARGUMENT that does not name the token keep the registration', async () => {
    const otherField = { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.android.ttl', description: 'x' }] };
    for (const [answer, line] of [
      [fcmError(404, 'NOT_FOUND'), 'Native push failed: fcm 404 NOT_FOUND'],
      [fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', [otherField]), 'Native push failed: fcm 400 INVALID_ARGUMENT'],
      [fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'), 'Native push failed: fcm 400 INVALID_ARGUMENT'],
      [fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), 'Native push failed: fcm 403 SENDER_ID_MISMATCH'],
      [fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'), 'Native push failed: fcm 429 QUOTA_EXCEEDED'],
      [fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), 'Native push failed: fcm 503 UNAVAILABLE'],
      [{ status: 500 }, 'Native push failed: fcm 500'],
    ]) {
      const { push, lines, sendCalls } = fcmChannel({ sends: [answer] });
      assert.equal(await push.send(fcmReg()), 'failed', line);
      assert.equal(sendCalls().length, 1, 'no retry');
      assert.deepEqual(lines, [line]);
      assertClean(lines);
    }
  });

  test('a refused or broken token request fails the push and logs only its status or error class', async () => {
    const refused = fcmChannel({ token: [{ status: 403, body: { error: 'forbidden', error_description: `bad ${ACCESS_TOKEN_PREFIX}x` } }] });
    assert.equal(await refused.push.send(fcmReg()), 'failed');
    assert.equal(refused.sendCalls().length, 0);
    assert.deepEqual(refused.lines, ['Native push failed: fcm token 403']);
    const empty = fcmChannel({ token: [{ status: 200, body: { token_type: 'Bearer' } }] });
    assert.equal(await empty.push.send(fcmReg()), 'failed');
    assert.deepEqual(empty.lines, ['Native push failed: fcm token invalid response']);
    const nowhere = fcmChannel({ token: [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })] });
    assert.equal(await nowhere.push.send(fcmReg()), 'failed', 'no metadata server, as on a laptop');
    assert.deepEqual(nowhere.lines, ['Native push failed: fcm token ENOTFOUND']);
    const down = fcmChannel({ sends: [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })] });
    assert.equal(await down.push.send(fcmReg()), 'failed');
    assert.deepEqual(down.lines, ['Native push failed: fcm ENOTFOUND']);
    const slow = fcmChannel({ sends: [new DOMException('The operation was aborted due to timeout', 'TimeoutError')] });
    assert.equal(await slow.push.send(fcmReg()), 'failed');
    assert.deepEqual(slow.lines, ['Native push failed: fcm timeout']);
    assertClean([...refused.lines, ...empty.lines, ...nowhere.lines, ...down.lines, ...slow.lines]);
  });

  test('after a failed token request no other is made for a minute: sends fail at once and keep their registrations', async () => {
    const { push, lines, clock, tokenCalls, sendCalls } = fcmChannel({ token: [{ status: 500, body: {} }, null] });
    // Two concurrent sends share the failed request.
    assert.deepEqual(await Promise.all([push.send(fcmReg()), push.send(fcmReg())]), ['failed', 'failed']);
    assert.equal(tokenCalls().length, 1);
    clock.t += 59_000;
    assert.equal(await push.send(fcmReg()), 'failed', 'failed, not gone: the registration is kept');
    assert.equal(tokenCalls().length, 1, 'no token request during the back-off');
    assert.equal(sendCalls().length, 0);
    clock.t += 1_000;
    assert.equal(await push.send(fcmReg()), 'sent', 'a minute later the token is asked for again');
    assert.equal(tokenCalls().length, 2);
    assert.deepEqual(lines, ['Native push failed: fcm token 500', 'Native push failed: fcm token 500', 'Native push failed: fcm token backoff']);
    // A later failure starts a new back-off.
    const again = fcmChannel({ token: [null, { status: 503, body: {} }, null], expiresIn: 120 });
    assert.equal(await again.push.send(fcmReg()), 'sent');
    again.clock.t += 61_000;
    assert.equal(await again.push.send(fcmReg()), 'failed');
    again.clock.t += 30_000;
    assert.equal(await again.push.send(fcmReg()), 'failed');
    assert.equal(again.tokenCalls().length, 2);
    assert.deepEqual(again.lines, ['Native push failed: fcm token 503', 'Native push failed: fcm token backoff']);
  });
});

describe('a channel the platform keeps refusing turns itself off', () => {
  test('APNs: five 403s in a row from the production host turn push.apns off, once, until restart', async () => {
    assert.equal(AUTH_FAILURES_MAX, 5);
    const { push, calls, lines } = apnsChannel([{ status: 403, reason: 'InvalidProviderToken' }]);
    for (let i = 1; i < AUTH_FAILURES_MAX; i++) assert.equal(await push.send(reg()), 'failed');
    assert.equal(push.apns, true, 'four in a row are not enough');
    assert.equal(await push.send(reg()), 'failed');
    assert.equal(push.apns, false, 'the fifth turns it off');
    assert.equal(await push.send(reg()), 'failed');
    assert.equal(calls.length, AUTH_FAILURES_MAX, 'no request once it is off');
    assert.deepEqual(lines.filter((l) => !l.startsWith('Native push failed')), ['APNs push is off: 5 authentication failures in a row.']);
    assert.equal(lines.filter((l) => l === 'Native push failed: apns 403 InvalidProviderToken').length, AUTH_FAILURES_MAX);
  });

  test('APNs: any answer past authentication resets the count, and 403s from the sandbox host never count', async () => {
    const reset = apnsChannel([
      ...Array(4).fill({ status: 403, reason: 'InvalidProviderToken' }),
      { status: 410, reason: 'Unregistered' },
      ...Array(4).fill({ status: 403, reason: 'Forbidden' }),
      { status: 400, reason: 'BadDeviceToken' },
      ...Array(4).fill({ status: 403, reason: 'InvalidProviderToken' }),
      { status: 200 },
    ]);
    for (let i = 0; i < 15; i++) await reset.push.send(reg());
    assert.equal(reset.push.apns, true);
    // Rate limits and server errors say nothing about the key either way.
    const busy = apnsChannel([...Array(4).fill({ status: 403, reason: 'InvalidProviderToken' }), { status: 429, reason: 'TooManyRequests' }, { status: 503, reason: 'ServiceUnavailable' }, { status: 403, reason: 'InvalidProviderToken' }]);
    for (let i = 0; i < 7; i++) await busy.push.send(reg());
    assert.equal(busy.push.apns, false, '4 + 1 refusals in a row, with only a 429 and a 503 between them');
    const sandbox = apnsChannel([{ status: 403, reason: 'BadEnvironmentKeyInToken' }]);
    for (let i = 0; i < 2 * AUTH_FAILURES_MAX; i++) assert.equal(await sandbox.push.send(reg({ environment: 'sandbox' })), 'failed');
    assert.equal(sandbox.push.apns, true, 'a client chooses sandbox, so it cannot turn APNs off for everyone');
  });

  test('FCM: five refusals of this server\'s access in a row turn push.fcm off; a token\'s own refusals and token request failures do not', async () => {
    const denied = fcmChannel({ sends: [fcmError(403, 'PERMISSION_DENIED')] });
    for (let i = 0; i < AUTH_FAILURES_MAX; i++) assert.equal(await denied.push.send(fcmReg()), 'failed');
    assert.equal(denied.push.fcm, false);
    assert.equal(await denied.push.send(fcmReg()), 'failed');
    assert.equal(denied.sendCalls().length, AUTH_FAILURES_MAX, 'no request once it is off');
    assert.deepEqual(denied.lines.filter((l) => !l.startsWith('Native push failed')), ['FCM push is off: 5 authentication failures in a row.']);

    const unauthenticated = fcmChannel({ sends: [fcmError(401, 'UNAUTHENTICATED')] });
    for (let i = 0; i < AUTH_FAILURES_MAX; i++) await unauthenticated.push.send(fcmReg());
    assert.equal(unauthenticated.push.fcm, false, 'a 401 that a fresh token did not cure');

    for (const code of ['SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR']) {
      const status = code === 'SENDER_ID_MISMATCH' ? 403 : 401;
      const one = fcmChannel({ sends: [fcmError(status, status === 403 ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED', code)] });
      for (let i = 0; i < 2 * AUTH_FAILURES_MAX; i++) assert.equal(await one.push.send(fcmReg()), 'failed');
      assert.equal(one.push.fcm, true, `${code} is about one registration token, so a client cannot turn FCM off with it`);
    }
    const metadata = fcmChannel({ token: [{ status: 500, body: {} }] });
    for (let i = 0; i < 2 * AUTH_FAILURES_MAX; i++) {
      assert.equal(await metadata.push.send(fcmReg()), 'failed');
      metadata.clock.t += 61_000;
    }
    assert.equal(metadata.push.fcm, true, 'a failing metadata server backs off instead');
    const reset = fcmChannel({ sends: [...Array(4).fill(fcmError(403, 'PERMISSION_DENIED')), fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), ...Array(4).fill(fcmError(403, 'PERMISSION_DENIED'))] });
    for (let i = 0; i < 9; i++) await reset.push.send(fcmReg());
    assert.equal(reset.push.fcm, true, 'an UNREGISTERED in between resets the count');
  });

  test('each channel turns off on its own', async () => {
    const h = harness();
    const stub = apnsStub({ status: 403, reason: 'InvalidProviderToken' });
    const both = createNativePush({ ...APNS_ENV, ...FCM_ENV }, { apnsTransport: stub.transport, fetch: fcmStub().fetchImpl, now: h.now, log: h.log });
    for (let i = 0; i < AUTH_FAILURES_MAX; i++) await both.send(reg());
    assert.deepEqual([both.apns, both.fcm], [false, true]);
    assert.equal(await both.send(fcmReg()), 'sent');
  });
});

describe('both channels', () => {
  test('every native push is the same generic alert: no zone, passage, name, ref, profile id, conference or spot line', async () => {
    const apns = apnsChannel([{ status: 200 }]);
    const fcm = fcmChannel();
    const otherApns = crypto.randomBytes(32).toString('hex');
    const otherFcm = `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
    await apns.push.send(reg());
    await apns.push.send(reg({ token: otherApns, environment: 'sandbox' }));
    await fcm.push.send(fcmReg());
    await fcm.push.send(fcmReg({ token: otherFcm }));
    assert.deepEqual(apns.calls.map((c) => c.body), [APNS_BYTES, APNS_BYTES], 'the same bytes for every APNs push');
    assert.deepEqual(fcm.sendCalls().map((c) => c.init.body), [fcmBytes(FCM_TOKEN), fcmBytes(otherFcm)], 'the same bytes for every FCM push but the token');
    assert.deepEqual(NATIVE_ALERT, { title: ALERT_TITLE, body: ALERT_BODY, deepLink: 'caddie://people?around=1' });
    assert.ok(Object.isFrozen(NATIVE_ALERT));
    // Nothing a nudge knows about the people or the place can be in it: the payload holds only
    // these keys and these constant strings.
    const keys = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    assert.deepEqual(keys(JSON.parse(APNS_BYTES)).sort(), ['aps.alert.body', 'aps.alert.title', 'aps.sound', 'deepLink']);
    assert.deepEqual(keys(JSON.parse(fcmBytes(FCM_TOKEN))).sort(), ['message.android.notification.tag', 'message.android.priority', 'message.android.ttl', 'message.data.deepLink', 'message.notification.body', 'message.notification.title', 'message.token']);
    for (const text of [APNS_BYTES, fcmBytes(FCM_TOKEN)]) {
      assert.doesNotMatch(text, /"url"|\/e\/|testconf|worked on|Hall|zone":|profile_id|"ref"|"name"|spot|distance/);
    }
  });

  test('a channel that is off, or an unknown platform, fails without a request', async () => {
    const h = harness();
    const stub = apnsStub({ status: 200 });
    const push = createNativePush({}, { apnsTransport: stub.transport, now: h.now, log: h.log });
    assert.equal(push.apns, false);
    assert.equal(push.fcm, false);
    assert.equal(await push.send(reg()), 'failed');
    const both = createNativePush({ ...APNS_ENV, ...FCM_ENV }, { apnsTransport: stub.transport, fetch: fcmStub().fetchImpl, now: h.now, log: h.log });
    assert.equal(await both.send({ platform: '__proto__', token: APNS_TOKEN }), 'failed');
    assert.equal(await both.send({ platform: 'webpush', token: APNS_TOKEN }), 'failed');
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(h.lines, []);
  });
});

describe('configuration', () => {
  test('nothing set: both channels off, and nothing is logged', () => {
    const h = harness();
    const push = createNativePush({ APNS_BUNDLE_ID: 'app.conferencecaddie' }, { log: h.log });
    assert.deepEqual([push.apns, push.fcm], [false, false]);
    assert.deepEqual(h.lines, []);
  });

  test('complete settings turn each channel on independently', () => {
    const h = harness();
    assert.deepEqual([createNativePush(APNS_ENV, { log: h.log }).apns, createNativePush(APNS_ENV, { log: h.log }).fcm], [true, false]);
    assert.deepEqual([createNativePush(FCM_ENV, { log: h.log }).apns, createNativePush(FCM_ENV, { log: h.log }).fcm], [false, true]);
    const both = createNativePush({ ...APNS_ENV, ...FCM_ENV }, { log: h.log });
    assert.deepEqual([both.apns, both.fcm], [true, true]);
    assert.deepEqual(h.lines, []);
  });

  test('unusable APNs settings keep APNs off with one line that names the setting and never the value', () => {
    const otherCurve = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const notAKey = 'APNs push is off: the file APNS_KEY_FILE names is not a .p8 key (a PKCS#8 P-256 private key).';
    const cases = [
      [{ APNS_KEY_ID: 'ABCDE12345' }, 'APNs push is off: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_FILE are not all set.'],
      [{ APNS_KEY_FILE: KEY_FILE }, 'APNs push is off: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_FILE are not all set.'],
      [{ ...APNS_ENV, APNS_KEY_ID: 'abc' }, 'APNs push is off: APNS_KEY_ID is not a 10-character key id.'],
      [{ ...APNS_ENV, APNS_TEAM_ID: 'team 12345' }, 'APNs push is off: APNS_TEAM_ID is not a 10-character team id.'],
      [{ ...APNS_ENV, APNS_BUNDLE_ID: 'app/../x' }, 'APNs push is off: APNS_BUNDLE_ID is not a bundle id.'],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile(P8.replace(/\n/g, '\\n')) }, notAKey],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile(RSA_PEM) }, notAKey],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile(otherCurve) }, notAKey],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile(P8.slice(0, 120)) }, notAKey],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile('') }, notAKey],
      [{ ...APNS_ENV, APNS_KEY_FILE: writeKeyFile(P8 + ' '.repeat(16 * 1024)) }, notAKey],
    ];
    for (const [env, line] of cases) {
      const h = harness();
      const push = createNativePush(env, { log: h.log });
      assert.equal(push.apns, false, line);
      assert.deepEqual(h.lines, [line]);
      assertClean(h.lines, [otherCurve]);
      assert.equal(apnsConfigFrom(env).config, undefined);
    }
  });

  test('an APNS_KEY_FILE with no readable file behind it (nothing mounted) keeps APNs off with one line, and nothing else fails', () => {
    for (const file of [missingKeyFile(), path.dirname(KEY_FILE)]) {
      const h = harness();
      const push = createNativePush({ ...APNS_ENV, ...FCM_ENV, APNS_KEY_FILE: file }, { log: h.log });
      assert.deepEqual([push.apns, push.fcm], [false, true], 'FCM is unaffected');
      assert.deepEqual(h.lines, ['APNs push is off: APNS_KEY_FILE names no readable file.']);
      assert.ok(!h.lines[0].includes(file), 'the path is not logged either');
    }
  });

  test('the key file is read only once the other APNs settings are usable', () => {
    const reads = [];
    const readFile = (file) => {
      reads.push(file);
      return P8;
    };
    assert.match(apnsConfigFrom({ ...APNS_ENV, APNS_KEY_ID: 'abc' }, { readFile }).problem, /APNS_KEY_ID/);
    assert.deepEqual(reads, []);
    assert.equal(apnsConfigFrom(APNS_ENV, { readFile }).config.keyId, 'ABCDE12345');
    assert.deepEqual(reads, [KEY_FILE]);
  });

  test('an unusable FCM_PROJECT_ID keeps FCM off with one line that names the setting and never the value', () => {
    for (const value of ['Bad_Project', 'abc', 'caddie test project', '1caddie-project', `${'a'.repeat(31)}`, 'caddie-project-']) {
      const h = harness();
      const push = createNativePush({ FCM_PROJECT_ID: value }, { log: h.log });
      assert.equal(push.fcm, false, value);
      assert.deepEqual(h.lines, ['FCM push is off: FCM_PROJECT_ID is not a project id.']);
      assert.equal(fcmConfigFrom({ FCM_PROJECT_ID: value }).config, undefined);
    }
    assert.deepEqual(fcmConfigFrom({ FCM_PROJECT_ID: 'caddie-test-project' }), { config: { projectId: 'caddie-test-project' } });
    assert.deepEqual(fcmConfigFrom({}), { config: null });
    // A service account key is not a setting any more: it turns nothing on.
    assert.deepEqual(fcmConfigFrom({ FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"caddie-test-project"}' }), { config: null });
  });

  test('this server read its settings and its APNs key file at import, and the key was never in the environment', () => {
    assert.equal(native.NATIVE_PUSH.apns, true);
    assert.equal(native.NATIVE_PUSH.fcm, true);
    const keyLine = P8.split('\n').find((l) => l.length > 40);
    assert.ok(!Object.values(process.env).some((v) => String(v).includes(keyLine)), 'no environment variable holds the key');
    assert.equal(fs.readFileSync(KEY_FILE, 'utf8'), P8, 'the key file is left as it was');
  });
});

test('token formats: APNs hex of 32 to 100 bytes, lowercased; FCM base64url with a colon, 32 to 4096 characters', () => {
  assert.equal(nativeTokenOf('apns', APNS_TOKEN), APNS_TOKEN);
  assert.equal(nativeTokenOf('apns', APNS_TOKEN.toUpperCase()), APNS_TOKEN);
  assert.equal(nativeTokenOf('apns', 'ab'.repeat(100)), 'ab'.repeat(100));
  for (const bad of ['ab'.repeat(31), 'ab'.repeat(101), `${APNS_TOKEN}a`, `${APNS_TOKEN.slice(2)}zz`, `<${APNS_TOKEN.slice(2)}>`, '', null, 42]) {
    assert.equal(nativeTokenOf('apns', bad), null, String(bad).slice(0, 20));
  }
  assert.equal(nativeTokenOf('fcm', FCM_TOKEN), FCM_TOKEN);
  assert.equal(nativeTokenOf('fcm', 'a'.repeat(4096)), 'a'.repeat(4096));
  for (const bad of ['a'.repeat(31), 'a'.repeat(4097), `${FCM_TOKEN} `, `${FCM_TOKEN}/x`, `${FCM_TOKEN}.x`, `${FCM_TOKEN}=`, '']) {
    assert.equal(nativeTokenOf('fcm', bad), null, bad.slice(0, 20));
  }
  assert.equal(nativeTokenOf('webpush', FCM_TOKEN), null);
});

test('signJwt: ES256 signatures are 64 bytes and verify with the public key', () => {
  const es = signJwt({ alg: 'ES256', kid: 'K' }, { a: 1 }, ec.privateKey).split('.');
  assert.equal(Buffer.from(es[2], 'base64url').length, 64);
  assert.equal(crypto.verify('sha256', Buffer.from(`${es[0]}.${es[1]}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(es[2], 'base64url')), true);
});

// ---------------------------------------------------------------------------------------------
// The real HTTP/2 transport, against a plain-text HTTP/2 server on 127.0.0.1.

const PORTS = [8702, 8703, 8704, 8705, 8706, 8707, 8708, 8709];

async function listen(server) {
  for (const port of PORTS) {
    const ok = await new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error('no free port from 8702 to 8709');
}

describe('the HTTP/2 transport', () => {
  const server = http2.createServer();
  const serverSessions = [];
  const requests = [];
  let port;
  server.on('session', (s) => serverSessions.push(s));
  // /goaway/{name}: the first time, held until two are in flight on one session; then the server
  // sends GOAWAY with the first one's stream id as the last it will process, and answers that one
  // a moment later on the closing session. Any later time: answered at once.
  const goawaySeen = new Set();
  const goawayHeld = [];
  server.on('stream', (stream, headers) => {
    requests.push(headers);
    const path = headers[':path'];
    if (path.startsWith('/slow')) return; // never answers
    if (path.startsWith('/goaway/') && !goawaySeen.has(path)) {
      goawaySeen.add(path);
      stream.on('error', () => undefined); // the stream above the last id is refused
      goawayHeld.push(stream);
      if (goawayHeld.length === 2) {
        const [first] = goawayHeld;
        first.session.goaway(http2.constants.NGHTTP2_NO_ERROR, first.id);
        setTimeout(() => {
          first.respond({ ':status': 200 });
          first.end();
        }, 150);
      }
      return;
    }
    let body = '';
    stream.on('data', (c) => {
      body += c;
    });
    stream.on('end', () => {
      requests.at(-1).body = body;
      if (path.includes(`/3/device/${'dead'.repeat(16)}`)) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: T0 }));
        return;
      }
      stream.respond({ ':status': 200, 'apns-id': crypto.randomUUID() });
      stream.end();
    });
  });

  after(async () => {
    for (const s of serverSessions) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('reuses one session, opens a new one after GOAWAY, and drops a session whose request timed out', async () => {
    port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const transport = http2Transport({ timeoutMs: 300 });
    try {
      const a = await transport(origin, { path: '/3/device/aa', headers: { 'apns-topic': 't' }, body: '{"x":1}' });
      const b = await transport(origin, { path: '/3/device/bb', headers: {}, body: '{}' });
      assert.deepEqual([a.status, b.status], [200, 200]);
      assert.equal(serverSessions.length, 1, 'two requests, one session');
      assert.equal(requests[0][':method'], 'POST');
      assert.equal(requests[0]['apns-topic'], 't');
      assert.equal(requests[0].body, '{"x":1}');

      serverSessions[0].goaway();
      await until(() => transport.sessions.size === 0);
      assert.equal((await transport(origin, { path: '/3/device/cc', headers: {}, body: '{}' })).status, 200);
      assert.equal(serverSessions.length, 2, 'GOAWAY: the next request opened a new session');

      await assert.rejects(transport(origin, { path: '/slow', headers: {}, body: '{}' }), { name: 'TimeoutError' });
      assert.equal(transport.sessions.size, 0, 'the timed-out session is dropped');
      assert.equal((await transport(origin, { path: '/3/device/dd', headers: {}, body: '{}' })).status, 200);
      assert.equal(serverSessions.length, 3, 'the next request opened a new session');
    } finally {
      transport.close();
    }
  });

  test('GOAWAY with pushes in flight: the one above the last stream id is rejected at once and sent again on a fresh session', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const transport = http2Transport({ timeoutMs: 5000 });
    const sessionsBefore = serverSessions.length;
    const done = {};
    const t0 = Date.now();
    try {
      const a = transport(origin, { path: '/goaway/a', headers: {}, body: '{}' }).then((r) => {
        done.a = Date.now() - t0;
        return r;
      });
      const b = transport(origin, { path: '/goaway/b', headers: {}, body: '{}' }).then((r) => {
        done.b = Date.now() - t0;
        return r;
      });
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepEqual([ra.status, rb.status], [200, 200], 'both pushes arrive');
      assert.ok(done.b < done.a, 'the refused push was sent again before the server even answered the other one');
      assert.ok(done.b < 1000, `rejected at once, not after the 5 s timeout (${done.b} ms)`);
      assert.equal(serverSessions.length, sessionsBefore + 2, 'the retry opened a fresh session');
      assert.equal(requests.filter((r) => r[':path'] === '/goaway/b').length, 2, 'b was sent twice: once refused, once answered');
      assert.equal(requests.filter((r) => r[':path'] === '/goaway/a').length, 1, 'a finished on the closing session, without a retry');
    } finally {
      transport.close();
    }
  });

  test('a refused connection fails at once after one retry on a fresh connection, and the next push connects again', async () => {
    // A port from 8702 to 8709 that nothing listens on: taken, then released.
    const probe = net.createServer();
    const free = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${free}`;
    let connects = 0;
    const transport = http2Transport({ timeoutMs: 5000, connect: (o) => {
      connects++;
      return http2.connect(o);
    } });
    try {
      const t0 = Date.now();
      await assert.rejects(transport(origin, { path: '/3/device/aa', headers: {}, body: '{}' }), { code: 'ECONNREFUSED' });
      assert.ok(Date.now() - t0 < 1000, 'not after the timeout');
      assert.equal(connects, 2, 'one retry, on a new connection');
      assert.equal(transport.sessions.size, 0);
      const h = harness();
      const push = createNativePush(APNS_ENV, { apnsTransport: (o, req) => transport(origin, req), now: h.now, log: h.log });
      assert.equal(await push.send(reg()), 'failed');
      assert.equal(connects, 4);
      assert.deepEqual(h.lines, ['Native push failed: apns ECONNREFUSED']);
      assertClean(h.lines);
    } finally {
      transport.close();
    }
  });

  test('the APNs channel over a real HTTP/2 connection: sent, and gone on 410', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const real = http2Transport({ timeoutMs: 1000 });
    const origins = [];
    const h = harness();
    // The channel always names Apple's hosts; this transport sends to the local server instead.
    const push = createNativePush(APNS_ENV, { apnsTransport: (o, req) => origins.push(o) && real(origin, req), now: h.now, log: h.log });
    try {
      const before = requests.length;
      assert.equal(await push.send(reg()), 'sent');
      assert.equal(await push.send(reg({ token: 'dead'.repeat(16) })), 'gone');
      assert.deepEqual(origins, ['https://api.push.apple.com', 'https://api.push.apple.com']);
      const got = requests[before];
      assert.equal(got[':path'], `/3/device/${APNS_TOKEN}`);
      assert.equal(got['apns-push-type'], 'alert');
      assert.equal(got['apns-priority'], '5');
      assert.match(got.authorization, /^bearer ey/);
      assert.equal(got.body, APNS_BYTES);
      assert.deepEqual(h.lines, []);
    } finally {
      real.close();
    }
  });
});
