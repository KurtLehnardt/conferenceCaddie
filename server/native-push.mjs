// Native push to the official apps: APNs over node:http2 with a token-based (.p8) key, and FCM
// HTTP v1 with the runtime service account's own access token. server/nudge.mjs sends the nudge
// through it to the native registrations of server/push.mjs (PUT /api/push/native), beside Web
// Push, and server/capabilities.mjs advertises push.apns and push.fcm from it.
//
// Env (read once when the module is imported; each channel is on only when its settings are all
// present and usable):
//   APNS_KEY_ID               the 10-character id of the APNs key (not a secret).
//   APNS_TEAM_ID              the 10-character id of the Apple developer team (not a secret).
//   APNS_KEY_P8               the text of the .p8 key file, a PKCS#8 EC P-256 private key (secret;
//                             Secret Manager caddie-apns-key).
//   APNS_BUNDLE_ID            the app's bundle id, sent as apns-topic; default app.conferencecaddie.
//   FCM_PROJECT_ID            the id of the app's Firebase project (not a secret). FCM is on when
//                             it is set. There is no FCM key: the access token comes from the
//                             Cloud Run metadata server for the runtime service account, which
//                             holds the role Firebase Cloud Messaging API Admin on that project.
//   PUSH_TRANSPORT=stub       (tests only) replaces the APNs and FCM transports with a recorder at
//                             PUSH_STUB_URL, as it replaces web-push in nudge.mjs.
//
// Rules this module keeps:
// - Only the official deployment pushes natively (docs/NATIVE_PLAN.md, section 14, decision 3): it
//   holds the APNs key and its service account may send through the app's Firebase project. A
//   backend without them advertises push.apns and push.fcm false; a third-party operator leaves
//   every one of these settings unset.
// - A setting that is present but unusable keeps its channel off, and one log line at start
//   names the setting and the rule, never its value. APNS_KEY_P8 is deleted from process.env as
//   soon as it is read (see the end of this file). No key, JWT, access token or device token is
//   ever logged.
// - The message is a generic alert, the same bytes for every push: the constant title and body of
//   NATIVE_ALERT and the constant deep link caddie://people?around=1. APNs and FCM payloads reach
//   Apple and Google in plain text, unlike Web Push payloads, which are end-to-end encrypted, so a
//   native push carries nothing about anyone: no zone, no passage, no name, no ref, no profile_id,
//   no conference and no spot line. The app opens Around now, which shows the match through the
//   authenticated API.
// - Every push has one outcome: 'sent'; 'gone', when the platform says the token will never work
//   again (APNs 410, or 400 BadDeviceToken or DeviceTokenNotForTopic; FCM 404 UNREGISTERED, or
//   400 INVALID_ARGUMENT naming message.token), and the caller then deletes the registration; or
//   'failed', with one log line that names the platform, the status and the platform's reason
//   code. send() never rejects.

import crypto from 'node:crypto';
import http2 from 'node:http2';

export const DEFAULT_BUNDLE_ID = 'app.conferencecaddie';
export const APNS_ORIGINS = Object.freeze({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
// The runtime service account's access token on Cloud Run. Its scope there is cloud-platform, which
// messages.send accepts beside firebase.messaging.
export const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
export const fcmSendUrl = (projectId) => `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

// apns-priority 5 is APNs' "normal": delivered with the device's power state in mind. It is what
// FCM maps its own normal priority to, and it matches the Web Push nudge's urgency normal; a
// nudge is a suggestion, and one that waits past its 600 seconds is dropped rather than shown late.
export const APNS_PRIORITY = '5';
// The tag the web app's service worker shows a nudge under, so a newer nudge replaces an older
// one on the phone as it does in the browser.
export const NUDGE_TAG = 'caddie-nudge';
const DEFAULT_TTL_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 10_000;
// A provider token is used for 40 minutes; Apple refuses one older than an hour, and one renewed
// more often than every 20 minutes (TooManyProviderTokenUpdates), so a refused token is renewed
// early only when it is at least 20 minutes old.
const PROVIDER_TOKEN_TTL_MS = 40 * 60_000;
const PROVIDER_TOKEN_MIN_AGE_MS = 20 * 60_000;
// An access token is used until a minute before it expires (as server/moderation.mjs does with the
// same metadata server). After a failed token request no other is made for a minute: a send in
// that time fails at once and keeps its registration.
const ACCESS_TOKEN_MARGIN_MS = 60_000;
const TOKEN_BACKOFF_MS = 60_000;
// An idle HTTP/2 session to APNs is closed after this long; the next push opens a new one.
const SESSION_IDLE_MS = 10 * 60_000;
// The most of a response body that is read: APNs and FCM error bodies are a few hundred bytes.
const BODY_MAX = 16 * 1024;

// Device tokens. An APNs token is the bytes Apple gives the app, as hex (32 bytes today; Apple
// says it may grow), and is stored lowercase. An FCM registration token is base64url text with a
// colon; the length is left generous.
const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){32,100}$/;
const FCM_TOKEN_RE = /^[A-Za-z0-9_:-]{32,4096}$/;

/** The token in its stored form, or null when it is not a token of that platform. */
export function nativeTokenOf(platform, value) {
  if (typeof value !== 'string') return null;
  if (platform === 'apns') {
    const token = value.toLowerCase();
    return APNS_TOKEN_RE.test(token) ? token : null;
  }
  if (platform === 'fcm') return FCM_TOKEN_RE.test(value) ? value : null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// JWTs, signed with node:crypto.

const segment = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

/** A compact JWS signed with ES256: a P-256 key and the raw r||s signature JOSE requires. */
export function signJwt(header, claims, key) {
  const input = `${segment(header)}.${segment(claims)}`;
  const signature = crypto.sign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

// ---------------------------------------------------------------------------------------------
// Configuration.

const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const set = (v) => typeof v === 'string' && v.trim() !== '';

function privateKeyOf(pem) {
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    return null;
  }
}

/**
 * The APNs settings: { config: { keyId, teamId, bundleId, key } }, { config: null } when none of
 * the three required settings is set, or { problem } naming what is wrong (never a value).
 */
export function apnsConfigFrom(env) {
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_KEY_P8: p8 } = env;
  if (!set(keyId) && !set(teamId) && !set(p8)) return { config: null };
  if (!set(keyId) || !set(teamId) || !set(p8)) return { problem: 'APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY_P8 are not all set' };
  if (!KEY_ID_RE.test(keyId)) return { problem: 'APNS_KEY_ID is not a 10-character key id' };
  if (!KEY_ID_RE.test(teamId)) return { problem: 'APNS_TEAM_ID is not a 10-character team id' };
  const bundleId = set(env.APNS_BUNDLE_ID) ? env.APNS_BUNDLE_ID : DEFAULT_BUNDLE_ID;
  if (!BUNDLE_ID_RE.test(bundleId)) return { problem: 'APNS_BUNDLE_ID is not a bundle id' };
  const key = privateKeyOf(p8);
  if (!key || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { problem: 'APNS_KEY_P8 is not the text of a .p8 key (a PKCS#8 P-256 private key)' };
  }
  return { config: { keyId, teamId, bundleId, key } };
}

/**
 * The FCM settings: { config: { projectId } }, { config: null } when FCM_PROJECT_ID is not set, or
 * { problem } naming what is wrong (never a value).
 */
export function fcmConfigFrom(env) {
  const projectId = env.FCM_PROJECT_ID;
  if (!set(projectId)) return { config: null };
  if (!PROJECT_ID_RE.test(projectId)) return { problem: 'FCM_PROJECT_ID is not a project id' };
  return { config: { projectId } };
}

// ---------------------------------------------------------------------------------------------
// Transports.

const timeoutError = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });

/**
 * The APNs transport over node:http2: (origin, { path, headers, body }) resolves to
 * { status, body }. One session per origin is kept and reused for every push, as Apple asks. A
 * session that receives GOAWAY, closes, fails, times out a request or stays idle is dropped,
 * and the next push opens a new one. Sessions are unref'd, so they never keep the process alive.
 */
export function http2Transport({ timeoutMs = REQUEST_TIMEOUT_MS, idleMs = SESSION_IDLE_MS, connect = http2.connect } = {}) {
  const sessions = new Map();
  const drop = (origin, session) => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  function sessionFor(origin) {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    sessions.set(origin, session);
    session.on('error', () => drop(origin, session));
    session.on('goaway', () => {
      drop(origin, session);
      session.close();
    });
    session.on('close', () => drop(origin, session));
    session.setTimeout(idleMs, () => {
      drop(origin, session);
      session.close();
    });
    session.unref();
    return session;
  }
  const request = (origin, { path, headers, body }) => new Promise((resolve, reject) => {
    let session;
    let stream;
    try {
      session = sessionFor(origin);
      stream = session.request({ ':method': 'POST', ':path': path, ...headers });
    } catch (err) {
      if (session) {
        drop(origin, session);
        session.destroy();
      }
      reject(err);
      return;
    }
    let status = 0;
    let size = 0;
    const chunks = [];
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // A push that gets no answer in time points at a dead connection: the session is dropped.
    const timer = setTimeout(() => {
      settle(reject, timeoutError());
      drop(origin, session);
      session.destroy();
    }, timeoutMs);
    stream.on('response', (h) => {
      status = Number(h[':status']) || 0;
    });
    stream.on('data', (chunk) => {
      if (size < BODY_MAX) chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => settle(resolve, { status, body: Buffer.concat(chunks).toString('utf8').slice(0, BODY_MAX) }));
    stream.on('error', (err) => settle(reject, err));
    stream.on('close', () => settle(reject, Object.assign(new Error('stream closed'), { code: 'ERR_STREAM_CLOSED' })));
    stream.end(body);
  });
  request.close = () => {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  };
  request.sessions = sessions;
  return request;
}

// Test-only transports (PUSH_TRANSPORT=stub): each push is posted as JSON to PUSH_STUB_URL and
// the stub's status and body are the platform's answer. The Authorization header is left out of
// the record, and the metadata server's token request is answered here with a stand-in token.
function stubTransports(env) {
  const url = env.PUSH_STUB_URL;
  const record = async (entry) => {
    if (!url) throw new Error('PUSH_STUB_URL is not set');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
    return { status: res.status, body: await res.text() };
  };
  return {
    apns: (origin, { path, headers, body }) => {
      const { authorization, ...rest } = headers;
      return record({ platform: 'apns', origin, path, headers: rest, payload: JSON.parse(body) });
    },
    fetch: async (target, init) => {
      if (target === METADATA_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'stub-access-token', expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
      const r = await record({ platform: 'fcm', url: target, payload: JSON.parse(init.body) });
      return new Response(r.body || null, { status: r.status });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The channels.

class PushFailure extends Error {
  constructor(what) {
    super(what);
    this.name = 'PushFailure';
  }
}

// Only fixed codes from the platforms are ever logged.
const reasonOf = (value, re) => (typeof value === 'string' && re.test(value) ? value : null);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const errorClass = (err) => {
  if (err instanceof PushFailure) return err.message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  const code = err?.code ?? err?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'network error';
};

// The one notification every native push shows. The body follows the web app's push notice ("Nudges
// tell you when someone whose experience matches yours is in your zone. They never say who until
// you open the app"). The deep link is the apps' own scheme, which the iOS app delegate and the
// Android activity accept only when it starts with caddie://; it opens the People tab on Around now
// of the conference the app has open.
export const NATIVE_ALERT = Object.freeze({
  title: 'Conference Caddie',
  body: 'Someone whose experience matches yours is in your zone right now',
  deepLink: 'caddie://people?around=1',
});

// The APNs body, the same bytes for every push.
export const APNS_BODY = JSON.stringify({ aps: { alert: { title: NATIVE_ALERT.title, body: NATIVE_ALERT.body }, sound: 'default' }, deepLink: NATIVE_ALERT.deepLink });

/** The FCM HTTP v1 message for one registration token: the same for every push but the token. */
export const fcmMessageOf = (token, ttl) => ({
  message: {
    token,
    notification: { title: NATIVE_ALERT.title, body: NATIVE_ALERT.body },
    data: { deepLink: NATIVE_ALERT.deepLink },
    android: { ttl: `${ttl}s`, priority: 'normal', notification: { tag: NUDGE_TAG } },
  },
});

function apnsChannel(config, { transport, now, log }) {
  let provider = null; // { token, issuedAt }
  const mint = () => {
    const issuedAt = now();
    const token = signJwt({ alg: 'ES256', kid: config.keyId }, { iss: config.teamId, iat: Math.floor(issuedAt / 1000) }, config.key);
    provider = { token, issuedAt };
    return token;
  };
  const providerToken = () => {
    const age = provider ? now() - provider.issuedAt : Infinity;
    return age >= 0 && age < PROVIDER_TOKEN_TTL_MS ? provider.token : mint();
  };
  // After a 403 ExpiredProviderToken or InvalidProviderToken: a new token, unless the current one
  // is younger than 20 minutes (a new one would be refused as too frequent, and one that young
  // was refused for another reason). Null when there is none to retry with.
  const renewedToken = () => {
    const age = provider ? now() - provider.issuedAt : Infinity;
    return age >= 0 && age < PROVIDER_TOKEN_MIN_AGE_MS ? null : mint();
  };

  return async function send(registration, { ttl }) {
    const origin = registration.environment === 'sandbox' ? APNS_ORIGINS.sandbox : APNS_ORIGINS.production;
    const attempt = (token) => transport(origin, {
      path: `/3/device/${registration.token}`,
      headers: {
        authorization: `bearer ${token}`,
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': APNS_PRIORITY,
        'apns-expiration': String(Math.floor(now() / 1000) + ttl),
        'apns-collapse-id': NUDGE_TAG,
        'content-type': 'application/json',
      },
      body: APNS_BODY,
    });
    let res = await attempt(providerToken());
    let reason = reasonOf(parse(res.body)?.reason, /^[A-Za-z]{1,64}$/);
    if (res.status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) {
      const renewed = renewedToken();
      if (renewed) {
        res = await attempt(renewed);
        reason = reasonOf(parse(res.body)?.reason, /^[A-Za-z]{1,64}$/);
      }
    }
    // APNs answers 200; any 2xx (a stand-in's 201) counts as sent.
    if (res.status >= 200 && res.status <= 299) return 'sent';
    if (res.status === 410 || (res.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) return 'gone';
    log(`Native push failed: apns ${res.status}${reason ? ` ${reason}` : ''}`);
    return 'failed';
  };
}

// The FCM error code of an error body: the errorCode of its FcmError detail, else its status.
function fcmCodeOf(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  const fcm = details.find((d) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('google.firebase.fcm.v1.FcmError'));
  return reasonOf(fcm?.errorCode, /^[A-Z_]{1,40}$/) ?? reasonOf(error?.status, /^[A-Z_]{1,40}$/);
}

// True when a 400 says that the token is what is invalid (a BadRequest field violation on
// message.token). Any other INVALID_ARGUMENT would be this server's message, and deleting the
// registration for it would lose a working token.
function tokenRefused(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  return details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === 'message.token'));
}

async function readJson(res) {
  try {
    const text = await res.text();
    return parse(text.slice(0, BODY_MAX));
  } catch {
    return null;
  }
}

function fcmChannel(config, { fetch: fetchImpl, now, log, timeoutMs }) {
  let access = null; // { token, expiresAt }
  let pending = null;
  let failedAt = null; // when the last token request failed
  const sendUrl = fcmSendUrl(config.projectId);

  // The runtime service account's token from the metadata server. No key is held here: Cloud Run
  // mints it for the service's own identity.
  async function requestAccessToken() {
    let res;
    try {
      res = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PushFailure(`token ${errorClass(err)}`);
    }
    const json = await readJson(res);
    if (!res.ok) throw new PushFailure(`token ${res.status}`);
    if (typeof json?.access_token !== 'string' || !json.access_token) throw new PushFailure('token invalid response');
    const seconds = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 300;
    access = { token: json.access_token, expiresAt: now() + seconds * 1000 };
    return access.token;
  }

  // The cached access token, or a new one when it is about to expire or when force is set (after
  // a 401). Concurrent callers share one token request. For a minute after a failed request every
  // caller fails at once with 'token backoff', so a metadata server in trouble is not asked again
  // for each push.
  function accessToken(force = false) {
    if (!force && access && now() < access.expiresAt - ACCESS_TOKEN_MARGIN_MS) return Promise.resolve(access.token);
    if (!pending) {
      if (failedAt !== null && now() - failedAt < TOKEN_BACKOFF_MS) return Promise.reject(new PushFailure('token backoff'));
      pending = requestAccessToken().then(
        (token) => {
          failedAt = null;
          return token;
        },
        (err) => {
          failedAt = now();
          throw err;
        },
      ).finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  return async function send(registration, { ttl }) {
    const body = JSON.stringify(fcmMessageOf(registration.token, ttl));
    const post = (token) => fetchImpl(sendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await post(await accessToken());
    if (res.status === 401) {
      await res.body?.cancel();
      access = null;
      res = await post(await accessToken(true));
    }
    if (res.ok) {
      await res.body?.cancel();
      return 'sent';
    }
    const error = (await readJson(res))?.error;
    const code = fcmCodeOf(error);
    if (res.status === 404 && code === 'UNREGISTERED') return 'gone';
    if (res.status === 400 && code === 'INVALID_ARGUMENT' && tokenRefused(error)) return 'gone';
    log(`Native push failed: fcm ${res.status}${code ? ` ${code}` : ''}`);
    return 'failed';
  };
}

/**
 * The native push channels of one configuration. Options exist for the tests: apnsTransport
 * ((origin, request) => { status, body }), fetch (for the metadata server's token and FCM), now
 * and log.
 * Returns { apns, fcm, send(registration, { ttl }) }, where apns and fcm say whether the channel is
 * on and registration is { platform, token, environment }. send pushes NATIVE_ALERT, and nothing
 * else, and resolves to 'sent', 'gone' or 'failed'.
 */
export function createNativePush(env, { apnsTransport, fetch: fetchImpl, now = Date.now, log = (line) => console.error(line), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const stub = env.PUSH_TRANSPORT === 'stub' ? stubTransports(env) : null;
  const apnsSettings = apnsConfigFrom(env);
  const fcmSettings = fcmConfigFrom(env);
  if (apnsSettings.problem) log(`APNs push is off: ${apnsSettings.problem}.`);
  if (fcmSettings.problem) log(`FCM push is off: ${fcmSettings.problem}.`);
  let transport = apnsTransport ?? stub?.apns ?? null;
  const channels = {
    apns: apnsSettings.config
      ? apnsChannel(apnsSettings.config, { transport: (origin, req) => (transport ??= http2Transport({ timeoutMs }))(origin, req), now, log })
      : null,
    fcm: fcmSettings.config
      ? fcmChannel(fcmSettings.config, { fetch: fetchImpl ?? stub?.fetch ?? ((url, init) => fetch(url, init)), now, log, timeoutMs })
      : null,
  };
  return Object.freeze({
    apns: Boolean(channels.apns),
    fcm: Boolean(channels.fcm),
    async send(registration, { ttl = DEFAULT_TTL_SECONDS } = {}) {
      const platform = registration?.platform;
      const channel = platform === 'apns' || platform === 'fcm' ? channels[platform] : null;
      if (!channel) return 'failed';
      try {
        return await channel(registration, { ttl });
      } catch (err) {
        log(`Native push failed: ${platform} ${errorClass(err)}`);
        return 'failed';
      }
    },
  });
}

// This server's channels. The settings are copied into `settings`, and then the one secret among
// them, APNS_KEY_P8, is deleted from process.env. That removes it from what this process hands to
// a child process and from anything in this process that reads process.env later, such as a
// diagnostic dump. It does not erase the value from memory, from the environment block the process
// started with (on Linux, /proc/self/environ still shows it), or from the Cloud Run revision,
// which holds it as a reference to Secret Manager.
const SETTINGS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_BUNDLE_ID', 'FCM_PROJECT_ID', 'PUSH_TRANSPORT', 'PUSH_STUB_URL'];
const settings = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k]]));
delete process.env.APNS_KEY_P8;
/** The native push channels of this server; push.apns and push.fcm are its apns and fcm. */
export const NATIVE_PUSH = createNativePush(settings);
