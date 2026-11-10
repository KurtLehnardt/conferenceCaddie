// Native push (server/native-push.mjs) on its own: the APNs provider token and the FCM OAuth
// assertion (shape, signature, caching and renewal), the requests each channel sends, how each
// answer of APNs and FCM is handled, the configuration and what it logs, the token formats, and
// the real HTTP/2 transport against a local plain-text HTTP/2 server.
//
// Run with `npm test`. Nothing here reaches Apple or Google: the channels get injected transports,
// and the one real HTTP/2 test talks to a server on 127.0.0.1 (a port from 8702 to 8709). Every key
// is generated for this run and never written anywhere.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';

const SETTINGS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_BUNDLE_ID', 'FCM_SERVICE_ACCOUNT_JSON', 'FCM_PROJECT_ID', 'PUSH_TRANSPORT', 'PUSH_STUB_URL'];
for (const k of SETTINGS) delete process.env[k];

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PRIVATE_KEY_ID = crypto.randomBytes(20).toString('hex');
const ACCOUNT = { type: 'service_account', project_id: 'caddie-test-project', private_key_id: PRIVATE_KEY_ID, private_key: RSA_PEM, client_email: 'push@caddie-test-project.iam.gserviceaccount.com' };
const APNS_ENV = { APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_KEY_P8: P8 };
const FCM_ENV = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(ACCOUNT) };

// The module reads this server's own settings when it is imported, and takes the two secrets out
// of the environment.
Object.assign(process.env, APNS_ENV, FCM_ENV);
const native = await import('../server/native-push.mjs');
const { createNativePush, nativeTokenOf, signJwt, http2Transport, apnsConfigFrom, fcmConfigFrom, APNS_ORIGINS, FCM_TOKEN_URL, FCM_SCOPE, fcmSendUrl } = native;
for (const k of SETTINGS) delete process.env[k];

const APNS_TOKEN = crypto.randomBytes(32).toString('hex');
const FCM_TOKEN = `${crypto.randomBytes(8).toString('base64url')}:APA91b${crypto.randomBytes(100).toString('base64url')}`;
const PAYLOAD = { title: 'Conference Caddie', body: "Someone who's worked on eBPF probes is in Hall A right now", data: { url: '/e/testconf-2099#/people?around=1' } };
const T0 = Date.UTC(2099, 5, 1, 9, 0, 0);
const MIN = 60_000;

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// A clock the test moves, and a log that collects lines.
function harness() {
  const clock = { t: T0 };
  const lines = [];
  return { clock, now: () => clock.t, lines, log: (line) => lines.push(String(line)) };
}

// No log line may carry key material, a token or a JWT.
function assertClean(lines, extra = []) {
  const secrets = [P8, RSA_PEM, APNS_TOKEN, FCM_TOKEN, PRIVATE_KEY_ID, ...extra];
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
    assert.equal(await push.send(reg(), PAYLOAD), 'sent');
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

  test('the request: host by environment, /3/device/{token}, the topic, alert, priority 5, expiry in 600 s, and the nudge only', async () => {
    const { push, calls } = apnsChannel([{ status: 200 }], { APNS_BUNDLE_ID: 'app.conferencecaddie.dev' });
    await push.send(reg(), PAYLOAD, { ttl: 600 });
    await push.send(reg({ environment: 'sandbox' }), PAYLOAD, { ttl: 600 });
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
    assert.deepEqual(calls[0].payload, { aps: { alert: { title: PAYLOAD.title, body: PAYLOAD.body }, sound: 'default' }, deepLink: 'caddie://people?around=1', data: { url: PAYLOAD.data.url } });
  });

  test('the topic defaults to app.conferencecaddie', async () => {
    const { push, calls } = apnsChannel([{ status: 200 }]);
    await push.send(reg(), PAYLOAD);
    assert.equal(calls[0].headers['apns-topic'], 'app.conferencecaddie');
    assert.equal(calls[0].headers['apns-expiration'], String(Math.floor(T0 / 1000) + 600), 'the default TTL is the Web Push one, 600 s');
  });

  test('the provider token is reused for 40 minutes, then renewed', async () => {
    const { push, calls, clock } = apnsChannel([{ status: 200 }]);
    await push.send(reg(), PAYLOAD);
    clock.t += 39 * MIN;
    await push.send(reg(), PAYLOAD);
    clock.t += 1 * MIN;
    await push.send(reg(), PAYLOAD);
    const tokens = calls.map((c) => c.headers.authorization);
    assert.equal(tokens[0], tokens[1], 'reused within 40 minutes');
    assert.notEqual(tokens[1], tokens[2], 'renewed at 40 minutes');
    assert.equal(decode(tokens[2].split('.')[1]).iat, Math.floor((T0 + 40 * MIN) / 1000));
  });

  test('410 and 400 BadDeviceToken or DeviceTokenNotForTopic mean the token is gone', async () => {
    for (const answer of [{ status: 410, reason: 'Unregistered' }, { status: 410, reason: 'ExpiredToken' }, { status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'DeviceTokenNotForTopic' }]) {
      const { push, lines } = apnsChannel([answer]);
      assert.equal(await push.send(reg(), PAYLOAD), 'gone', JSON.stringify(answer));
      assert.deepEqual(lines, []);
    }
  });

  test('other refusals, rate limits and server errors fail without deleting, with one clean log line', async () => {
    for (const answer of [{ status: 400, reason: 'BadExpirationDate' }, { status: 400, reason: 'BadTopic' }, { status: 429, reason: 'TooManyRequests' }, { status: 500, reason: 'InternalServerError' }, { status: 503, reason: 'ServiceUnavailable' }, { status: 413, reason: 'PayloadTooLarge' }]) {
      const { push, lines, calls } = apnsChannel([answer]);
      assert.equal(await push.send(reg(), PAYLOAD), 'failed', JSON.stringify(answer));
      assert.equal(calls.length, 1, 'no retry');
      assert.deepEqual(lines, [`Native push failed: apns ${answer.status} ${answer.reason}`]);
      assertClean(lines);
    }
    const odd = apnsChannel([{ status: 400, reason: 'Bad Device "token" <x>' }]);
    assert.equal(await odd.push.send(reg(), PAYLOAD), 'failed');
    assert.deepEqual(odd.lines, ['Native push failed: apns 400'], 'a reason that is not a plain code is not logged');
  });

  test('a transport that fails or times out fails the push with the error class only', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const reset = Object.assign(new Error(`connect ECONNRESET ${APNS_TOKEN}`), { code: 'ECONNRESET' });
    for (const [err, want] of [[timeout, 'timeout'], [reset, 'ECONNRESET'], [new Error(`odd ${APNS_TOKEN}`), 'network error']]) {
      const { push, lines } = apnsChannel([err]);
      assert.equal(await push.send(reg(), PAYLOAD), 'failed');
      assert.deepEqual(lines, [`Native push failed: apns ${want}`]);
      assertClean(lines);
    }
  });

  test('403 ExpiredProviderToken or InvalidProviderToken renews the provider token and retries once', async () => {
    for (const reason of ['ExpiredProviderToken', 'InvalidProviderToken']) {
      const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason }, { status: 200 }]);
      await push.send(reg(), PAYLOAD);
      clock.t += 25 * MIN;
      assert.equal(await push.send(reg(), PAYLOAD), 'sent', reason);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].headers.authorization, calls[0].headers.authorization, 'the cached token was tried first');
      assert.notEqual(calls[2].headers.authorization, calls[1].headers.authorization, 'the retry has a new token');
      assert.equal(decode(calls[2].headers.authorization.split('.')[1]).iat, Math.floor((T0 + 25 * MIN) / 1000));
      assert.deepEqual(lines, []);
    }
  });

  test('a renewed token that is refused again fails after exactly one retry', async () => {
    const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason: 'ExpiredProviderToken' }]);
    await push.send(reg(), PAYLOAD);
    clock.t += 30 * MIN;
    assert.equal(await push.send(reg(), PAYLOAD), 'failed');
    assert.equal(calls.length, 3, 'the first send, the refused one and one retry');
    assert.deepEqual(lines, ['Native push failed: apns 403 ExpiredProviderToken']);
  });

  test('a provider token younger than 20 minutes is not renewed on a 403, because Apple refuses renewals that frequent', async () => {
    const { push, calls, clock, lines } = apnsChannel([{ status: 200 }, { status: 403, reason: 'InvalidProviderToken' }]);
    await push.send(reg(), PAYLOAD);
    clock.t += 5 * MIN;
    assert.equal(await push.send(reg(), PAYLOAD), 'failed');
    assert.equal(calls.length, 2, 'no retry');
    assert.deepEqual(lines, ['Native push failed: apns 403 InvalidProviderToken']);
    const first = apnsChannel([{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }]);
    assert.equal(await first.push.send(reg(), PAYLOAD), 'failed', 'a token minted for this very push is not renewed either');
    assert.equal(first.calls.length, 1);
  });

  test('403 for another reason is not retried', async () => {
    const { push, calls, clock } = apnsChannel([{ status: 200 }, { status: 403, reason: 'BadCertificateEnvironment' }, { status: 200 }]);
    await push.send(reg(), PAYLOAD);
    clock.t += 30 * MIN;
    assert.equal(await push.send(reg(), PAYLOAD), 'failed');
    assert.equal(calls.length, 2);
  });
});

// A fetch for FCM: the OAuth token endpoint answers tokens t1, t2, ... valid for expiresIn
// seconds; the send URL answers from a list (the last answer repeats).
function fcmStub({ sends = [{ status: 200, body: { name: 'projects/caddie-test-project/messages/1' } }], token = [], expiresIn = 3600 } = {}) {
  const calls = [];
  let tokens = 0;
  let sent = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === FCM_TOKEN_URL) {
      const a = token[Math.min(tokens, token.length - 1)];
      tokens++;
      if (a) return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
      return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: expiresIn, token_type: 'Bearer' }), { status: 200 });
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
const fcmError = (code, status, errorCode, extra = []) => ({ status: code, body: { error: { code, message: 'x', status, details: [...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []), ...extra] } } });
const tokenViolation = { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token', description: 'The registration token is not a valid FCM registration token' }] };

describe('FCM', () => {
  test('the OAuth assertion is an RS256 JWT for the messaging scope, signed by the service account key', async () => {
    const { push, tokenCalls } = fcmChannel();
    assert.equal(await push.send(fcmReg(), PAYLOAD), 'sent');
    const [call] = tokenCalls();
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.init.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = form.get('assertion').split('.');
    assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT', kid: PRIVATE_KEY_ID });
    const iat = Math.floor(T0 / 1000);
    assert.deepEqual(decode(c), { iss: ACCOUNT.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
    assert.equal(FCM_SCOPE, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s, 'base64url')), true);
  });

  test('the send: the project URL, the access token, and the nudge with a 600 s TTL at normal priority', async () => {
    const { push, sendCalls } = fcmChannel();
    await push.send(fcmReg(), PAYLOAD, { ttl: 600 });
    const [call] = sendCalls();
    assert.equal(call.url, 'https://fcm.googleapis.com/v1/projects/caddie-test-project/messages:send');
    assert.equal(call.url, fcmSendUrl('caddie-test-project'));
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, { Authorization: 'Bearer t1', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(call.init.body), {
      message: {
        token: FCM_TOKEN,
        notification: { title: PAYLOAD.title, body: PAYLOAD.body },
        data: { url: PAYLOAD.data.url, deepLink: 'caddie://people?around=1' },
        android: { ttl: '600s', priority: 'normal', notification: { tag: 'caddie-nudge' } },
      },
    });
    assert.ok(call.init.signal instanceof AbortSignal, 'every request has a timeout');
  });

  test('FCM_PROJECT_ID overrides the service account project', async () => {
    const { push, sendCalls } = fcmChannel({}, { FCM_PROJECT_ID: 'caddie-other-project' });
    await push.send(fcmReg(), PAYLOAD);
    assert.equal(sendCalls()[0].url, 'https://fcm.googleapis.com/v1/projects/caddie-other-project/messages:send');
  });

  test('the access token is cached until five minutes before it expires, and concurrent sends share one request', async () => {
    const { push, tokenCalls, sendCalls, clock } = fcmChannel();
    await Promise.all([push.send(fcmReg(), PAYLOAD), push.send(fcmReg(), PAYLOAD), push.send(fcmReg(), PAYLOAD)]);
    assert.equal(tokenCalls().length, 1, 'one token request for three concurrent sends');
    clock.t += 54 * MIN;
    await push.send(fcmReg(), PAYLOAD);
    assert.equal(tokenCalls().length, 1, 'still cached at 54 minutes of 60');
    clock.t += 1 * MIN;
    await push.send(fcmReg(), PAYLOAD);
    assert.equal(tokenCalls().length, 2, 'renewed at 55 minutes');
    assert.deepEqual(sendCalls().map((c) => c.init.headers.Authorization), ['Bearer t1', 'Bearer t1', 'Bearer t1', 'Bearer t1', 'Bearer t2']);
  });

  test('401 renews the access token and retries once', async () => {
    const ok = fcmChannel({ sends: [fcmError(401, 'UNAUTHENTICATED'), { status: 200, body: {} }] });
    assert.equal(await ok.push.send(fcmReg(), PAYLOAD), 'sent');
    assert.deepEqual(ok.sendCalls().map((c) => c.init.headers.Authorization), ['Bearer t1', 'Bearer t2']);
    assert.deepEqual(ok.lines, []);
    const again = fcmChannel({ sends: [fcmError(401, 'UNAUTHENTICATED')] });
    assert.equal(await again.push.send(fcmReg(), PAYLOAD), 'failed');
    assert.equal(again.sendCalls().length, 2, 'exactly one retry');
    assert.deepEqual(again.lines, ['Native push failed: fcm 401 UNAUTHENTICATED']);
  });

  test('404 UNREGISTERED and 400 INVALID_ARGUMENT on message.token mean the token is gone', async () => {
    for (const answer of [fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', [tokenViolation])]) {
      const { push, lines } = fcmChannel({ sends: [answer] });
      assert.equal(await push.send(fcmReg(), PAYLOAD), 'gone', JSON.stringify(answer));
      assert.deepEqual(lines, []);
    }
  });

  test('a 404 without UNREGISTERED (a wrong project) and an INVALID_ARGUMENT on another field keep the registration', async () => {
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
      assert.equal(await push.send(fcmReg(), PAYLOAD), 'failed', line);
      assert.equal(sendCalls().length, 1, 'no retry');
      assert.deepEqual(lines, [line]);
      assertClean(lines);
    }
  });

  test('a refused or broken token request fails the push and logs only its status', async () => {
    const refused = fcmChannel({ token: [{ status: 400, body: { error: 'invalid_grant', error_description: `bad ${PRIVATE_KEY_ID}` } }] });
    assert.equal(await refused.push.send(fcmReg(), PAYLOAD), 'failed');
    assert.equal(refused.sendCalls().length, 0);
    assert.deepEqual(refused.lines, ['Native push failed: fcm token 400']);
    const empty = fcmChannel({ token: [{ status: 200, body: { token_type: 'Bearer' } }] });
    assert.equal(await empty.push.send(fcmReg(), PAYLOAD), 'failed');
    assert.deepEqual(empty.lines, ['Native push failed: fcm token invalid response']);
    const down = fcmChannel({ sends: [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })] });
    assert.equal(await down.push.send(fcmReg(), PAYLOAD), 'failed');
    assert.deepEqual(down.lines, ['Native push failed: fcm ENOTFOUND']);
    const slow = fcmChannel({ sends: [new DOMException('The operation was aborted due to timeout', 'TimeoutError')] });
    assert.equal(await slow.push.send(fcmReg(), PAYLOAD), 'failed');
    assert.deepEqual(slow.lines, ['Native push failed: fcm timeout']);
    assertClean([...refused.lines, ...empty.lines, ...down.lines, ...slow.lines]);
  });
});

describe('both channels', () => {
  test('a push carries the nudge title, body and URL and nothing else from the payload', async () => {
    const apns = apnsChannel([{ status: 200 }]);
    const fcm = fcmChannel();
    // Fields a nudge payload never has; were one ever added, it must still not reach the phone.
    const leaky = { ...PAYLOAD, name: 'Ada Lovelace', ref: '0123456789abcdef', profile_id: 'AAECAwQFBgcICQoLDA0ODw', distance_m: 12, spot: 'by the coffee', data: { ...PAYLOAD.data, ref: '0123456789abcdef' } };
    await apns.push.send(reg(), leaky);
    await fcm.push.send(fcmReg(), leaky);
    const sent = JSON.stringify([apns.calls[0].payload, JSON.parse(fcm.sendCalls()[0].init.body)]);
    for (const leak of ['Ada', '0123456789abcdef', 'AAECAwQFBgcICQoLDA0ODw', 'distance', 'coffee', 'spot', 'profile_id', '"ref"', '"name"']) {
      assert.ok(!sent.includes(leak), `${leak} reached the push`);
    }
  });

  test('a channel that is off, or an unknown platform, fails without a request', async () => {
    const h = harness();
    const stub = apnsStub({ status: 200 });
    const push = createNativePush({}, { apnsTransport: stub.transport, now: h.now, log: h.log });
    assert.equal(push.apns, false);
    assert.equal(push.fcm, false);
    assert.equal(await push.send(reg(), PAYLOAD), 'failed');
    const both = createNativePush({ ...APNS_ENV, ...FCM_ENV }, { apnsTransport: stub.transport, fetch: fcmStub().fetchImpl, now: h.now, log: h.log });
    assert.equal(await both.send({ platform: '__proto__', token: APNS_TOKEN }, PAYLOAD), 'failed');
    assert.equal(await both.send({ platform: 'webpush', token: APNS_TOKEN }, PAYLOAD), 'failed');
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(h.lines, []);
  });
});

describe('configuration', () => {
  test('nothing set: both channels off, and nothing is logged', () => {
    const h = harness();
    const push = createNativePush({ APNS_BUNDLE_ID: 'app.conferencecaddie', FCM_PROJECT_ID: 'caddie-test-project' }, { log: h.log });
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
    const cases = [
      [{ APNS_KEY_ID: 'ABCDE12345' }, 'APNs push is off: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_P8 are not all set.'],
      [{ APNS_KEY_P8: P8 }, 'APNs push is off: APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_P8 are not all set.'],
      [{ ...APNS_ENV, APNS_KEY_ID: 'abc' }, 'APNs push is off: APNS_KEY_ID is not a 10-character key id.'],
      [{ ...APNS_ENV, APNS_TEAM_ID: 'team 12345' }, 'APNs push is off: APNS_TEAM_ID is not a 10-character team id.'],
      [{ ...APNS_ENV, APNS_BUNDLE_ID: 'app/../x' }, 'APNs push is off: APNS_BUNDLE_ID is not a bundle id.'],
      [{ ...APNS_ENV, APNS_KEY_P8: P8.replace(/\n/g, '\\n') }, 'APNs push is off: APNS_KEY_P8 is not the text of a .p8 key (a PKCS#8 P-256 private key).'],
      [{ ...APNS_ENV, APNS_KEY_P8: RSA_PEM }, 'APNs push is off: APNS_KEY_P8 is not the text of a .p8 key (a PKCS#8 P-256 private key).'],
      [{ ...APNS_ENV, APNS_KEY_P8: otherCurve }, 'APNs push is off: APNS_KEY_P8 is not the text of a .p8 key (a PKCS#8 P-256 private key).'],
      [{ ...APNS_ENV, APNS_KEY_P8: P8.slice(0, 120) }, 'APNs push is off: APNS_KEY_P8 is not the text of a .p8 key (a PKCS#8 P-256 private key).'],
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

  test('unusable FCM settings keep FCM off with one line that names the setting and never the value', () => {
    const json = (over) => JSON.stringify({ ...ACCOUNT, ...over });
    const cases = [
      // JSON.parse would quote the text around the error; the line must not.
      [{ FCM_SERVICE_ACCOUNT_JSON: `{"private_key": "${RSA_PEM.slice(30, 90)}" oops}` }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON is not JSON.'],
      [{ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify([ACCOUNT]) }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON is not a JSON object.'],
      [{ FCM_SERVICE_ACCOUNT_JSON: json({ client_email: 'not an email' }) }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON has no usable client_email.'],
      [{ FCM_SERVICE_ACCOUNT_JSON: json({ project_id: undefined }) }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON has no usable project_id.'],
      [{ FCM_SERVICE_ACCOUNT_JSON: json({}), FCM_PROJECT_ID: 'Bad_Project' }, 'FCM push is off: FCM_PROJECT_ID is not a project id.'],
      [{ FCM_SERVICE_ACCOUNT_JSON: json({ private_key: P8 }) }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON has no usable private_key (an RSA private key).'],
      [{ FCM_SERVICE_ACCOUNT_JSON: json({ private_key: RSA_PEM.slice(0, 200) }) }, 'FCM push is off: FCM_SERVICE_ACCOUNT_JSON has no usable private_key (an RSA private key).'],
    ];
    for (const [env, line] of cases) {
      const h = harness();
      const push = createNativePush(env, { log: h.log });
      assert.equal(push.fcm, false, line);
      assert.deepEqual(h.lines, [line]);
      assertClean(h.lines);
      assert.equal(fcmConfigFrom(env).config, undefined);
    }
  });

  test('this server read its settings at import and took the two secrets out of the environment', () => {
    assert.equal(native.NATIVE_PUSH.apns, true);
    assert.equal(native.NATIVE_PUSH.fcm, true);
    assert.equal(process.env.APNS_KEY_P8, undefined);
    assert.equal(process.env.FCM_SERVICE_ACCOUNT_JSON, undefined);
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

test('signJwt: ES256 signatures are 64 bytes and RS256 ones verify with the public key', () => {
  const es = signJwt({ alg: 'ES256', kid: 'K' }, { a: 1 }, ec.privateKey).split('.');
  assert.equal(Buffer.from(es[2], 'base64url').length, 64);
  const rs = signJwt({ alg: 'RS256', typ: 'JWT' }, { a: 1 }, rsa.privateKey).split('.');
  assert.equal(crypto.verify('sha256', Buffer.from(`${rs[0]}.${rs[1]}`), rsa.publicKey, Buffer.from(rs[2], 'base64url')), true);
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
  server.on('stream', (stream, headers) => {
    requests.push(headers);
    const path = headers[':path'];
    if (path.startsWith('/slow')) return; // never answers
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

  const until = async (cond) => {
    const deadline = Date.now() + 2000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

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

  test('the APNs channel over a real HTTP/2 connection: sent, and gone on 410', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const real = http2Transport({ timeoutMs: 1000 });
    const origins = [];
    const h = harness();
    // The channel always names Apple's hosts; this transport sends to the local server instead.
    const push = createNativePush(APNS_ENV, { apnsTransport: (o, req) => origins.push(o) && real(origin, req), now: h.now, log: h.log });
    try {
      const before = requests.length;
      assert.equal(await push.send(reg(), PAYLOAD), 'sent');
      assert.equal(await push.send(reg({ token: 'dead'.repeat(16) }), PAYLOAD), 'gone');
      assert.deepEqual(origins, ['https://api.push.apple.com', 'https://api.push.apple.com']);
      const got = requests[before];
      assert.equal(got[':path'], `/3/device/${APNS_TOKEN}`);
      assert.equal(got['apns-push-type'], 'alert');
      assert.equal(got['apns-priority'], '5');
      assert.match(got.authorization, /^bearer ey/);
      assert.deepEqual(JSON.parse(got.body).aps.alert, { title: PAYLOAD.title, body: PAYLOAD.body });
      assert.deepEqual(h.lines, []);
    } finally {
      real.close();
    }
  });
});

test('the native deep link names the apps\' own scheme for the nudge route only', async () => {
  const { deepLinkOf } = await import('../server/native-push.mjs');
  assert.equal(deepLinkOf('/e/testconf-2099#/people?around=1'), 'caddie://people?around=1');
  assert.equal(deepLinkOf('/e/testconf-2099#/people'), 'caddie://people');
  assert.equal(deepLinkOf(''), 'caddie://people');
});
