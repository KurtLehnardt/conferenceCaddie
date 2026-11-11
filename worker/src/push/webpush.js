// Web Push with Web Crypto only (PLAN section 1.11): VAPID authentication (RFC 8292, an ES256
// JWT) and payload encryption (RFC 8291, the aes128gcm content coding of RFC 8188 with one
// record of 4,096 bytes). No npm push library is used.
//
// Keys: VAPID_PRIVATE_KEY is the base64url 32-byte private scalar and VAPID_PUBLIC_KEY the
// base64url 65-byte uncompressed point, the same format the web-push package uses. Both are
// secrets set with `wrangler secret put`; VAPID_SUBJECT (a mailto: or https: URL) is a var.
//
// Rules this module keeps:
// - Key material, JWTs, endpoints and payloads are never logged or returned. Errors thrown here
//   carry fixed messages only.
// - The signed JWT is cached in memory per audience (the push service origin) and reused while it
//   has more than an hour left, so a send usually costs one ECDH, two HKDF and one AES-GCM.
// - encrypt() accepts an injected salt and ephemeral key pair so a scratch script can check it
//   against the RFC 8291 section 5 test vector; production calls never pass them.

const enc = new TextEncoder();

export const RECORD_SIZE = 4096;
export const TTL_SECONDS = 600;
const JWT_LIFETIME_S = 12 * 3600;
const JWT_REUSE_MARGIN_S = 3600;
const JWT_CACHE_MAX = 64;
const TAG_BYTES = 16;
const KEY_INFO = enc.encode('WebPush: info\0');
const CEK_INFO = enc.encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = enc.encode('Content-Encoding: nonce\0');

// ---------------------------------------------------------------------------------------------
// base64url

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const B64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

// Decodes base64url (padding optional). Returns null for anything that is not base64url.
export function b64urlDecode(str) {
  if (typeof str !== 'string' || !B64URL_RE.test(str)) return null;
  const s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) return null;
  let bin;
  try {
    bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Keys

// A P-256 uncompressed point (65 bytes, 0x04 || x || y) as a JWK's x and y, or null.
function pointXY(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) return null;
  return { x: b64urlEncode(raw.subarray(1, 33)), y: b64urlEncode(raw.subarray(33, 65)) };
}

// Imports a private scalar plus its public point as a P-256 private key for alg ('ECDSA' or
// 'ECDH'). Throws a fixed-message Error when the pair is malformed or does not match.
async function importPrivate(dB64, publicRaw, alg, usages) {
  const d = b64urlDecode(dB64);
  const xy = pointXY(publicRaw);
  if (!d || d.length !== 32 || !xy) throw new Error('invalid key pair');
  try {
    return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64urlEncode(d), ...xy, ext: false }, { name: alg, namedCurve: 'P-256' }, false, usages);
  } catch {
    throw new Error('invalid key pair');
  }
}

// True when a base64url string is a valid P-256 public point (65 bytes, on the curve). Used to
// validate a browser's p256dh before it is stored.
export async function isValidP256Point(b64) {
  const raw = b64urlDecode(b64);
  if (!raw || raw.length !== 65 || raw[0] !== 4) return false;
  try {
    await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// RFC 8291 encryption

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// Encrypts payload (a string or bytes) for one subscription's keys ({ p256dh, auth }, base64url)
// and returns the aes128gcm request body: salt(16) || rs(4) || idlen(1) || as_public(65) ||
// ciphertext. The plaintext is the payload followed by the last-record delimiter 0x02, with no
// further padding, in a single record.
//
// options.salt (16 bytes) and options.ephemeral ({ privateKey: base64url d, publicKey: base64url
// 65-byte point }) are for test vectors only; normally both are fresh and random.
export async function encrypt(payload, keys, options = {}) {
  const uaPublic = b64urlDecode(keys?.p256dh);
  const authSecret = b64urlDecode(keys?.auth);
  if (!uaPublic || uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('invalid subscription key');
  if (!authSecret || authSecret.length !== 16) throw new Error('invalid subscription secret');
  const recordSize = options.recordSize ?? RECORD_SIZE;
  const plaintext = typeof payload === 'string' ? enc.encode(payload) : new Uint8Array(payload);
  if (plaintext.length + 1 + TAG_BYTES > recordSize) throw new Error('payload too large');

  const salt = options.salt ? new Uint8Array(options.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('invalid salt');

  let asPrivate;
  let asPublic;
  if (options.ephemeral) {
    asPublic = b64urlDecode(options.ephemeral.publicKey);
    asPrivate = await importPrivate(options.ephemeral.privateKey, asPublic, 'ECDH', ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }

  let uaKey;
  try {
    uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new Error('invalid subscription key');
  }
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  // IKM = HKDF(salt = auth_secret, IKM = ecdh_secret, info = key_info, 32)
  const ikm = await hkdf(authSecret, ecdhSecret, concat(KEY_INFO, uaPublic, asPublic), 32);
  // CEK and NONCE from PRK = HKDF-Extract(salt, IKM)
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------------------------
// RFC 8292 VAPID

// One import of the signing key per public key (the secrets do not change during an isolate's
// life, but a redeploy with new secrets gets a new isolate anyway).
let signer = null; // { publicKey, privateKey, key }
const jwtCache = new Map(); // `${publicKey}\n${audience}` -> { token, exp }

// True when the three VAPID settings are present. Nothing is sent otherwise.
export function vapidConfigured(env) {
  return Boolean(env?.VAPID_PUBLIC_KEY && env?.VAPID_PRIVATE_KEY && env?.VAPID_SUBJECT);
}

async function signingKey(env) {
  if (signer && signer.publicKey === env.VAPID_PUBLIC_KEY && signer.privateKey === env.VAPID_PRIVATE_KEY) return signer.key;
  const key = await importPrivate(env.VAPID_PRIVATE_KEY, b64urlDecode(env.VAPID_PUBLIC_KEY), 'ECDSA', ['sign']);
  signer = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, key };
  return key;
}

// The VAPID JWT for one audience (the origin of a push endpoint): ES256 over
// { aud, exp: now + 12 h, sub: VAPID_SUBJECT }. Cached per audience and reused while more than an
// hour of its life is left.
export async function vapidJwt(env, audience, nowMs = Date.now()) {
  if (!vapidConfigured(env)) throw new Error('VAPID is not configured');
  const now = Math.floor(nowMs / 1000);
  const cacheKey = `${env.VAPID_PUBLIC_KEY}\n${audience}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - now > JWT_REUSE_MARGIN_S) return hit.token;

  const key = await signingKey(env);
  const exp = now + JWT_LIFETIME_S;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT })));
  const unsigned = `${header}.${claims}`;
  // Web Crypto's ECDSA signature is already the raw r || s (64 bytes) that JWS ES256 uses.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  const token = `${unsigned}.${b64urlEncode(sig)}`;

  if (jwtCache.size >= JWT_CACHE_MAX) jwtCache.delete(jwtCache.keys().next().value);
  jwtCache.set(cacheKey, { token, exp });
  return token;
}

// The hosts of the browser push services this Worker delivers to: Chrome, Edge and other
// Chromium browsers (FCM), Firefox (Mozilla autopush), legacy Edge (WNS) and Safari (Apple).
// An entry that starts with a dot matches any subdomain of it. Anything else is refused, so a
// subscription can never make the Worker send signed requests to a host the person chose.
export const PUSH_SERVICE_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'android.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  'web.push.apple.com',
  '.push.apple.com',
]);

// True when value is a https URL on a known push service host, on the default port, with no
// user name or password. IP literals never match, because no allowed host is an IP address.
export function isPushServiceEndpoint(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host.endsWith('.')) return false;
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
}

// The fetch() arguments that deliver payload (a string) to one subscription
// ({ endpoint, p256dh, auth }). Throws a fixed-message Error on a malformed subscription.
export async function buildPushRequest(env, sub, payload, nowMs = Date.now()) {
  let audience;
  try {
    const u = new URL(sub.endpoint);
    audience = u.origin;
  } catch {
    throw new Error('invalid endpoint');
  }
  const body = await encrypt(payload, { p256dh: sub.p256dh, auth: sub.auth });
  const jwt = await vapidJwt(env, audience, nowMs);
  return {
    url: sub.endpoint,
    init: {
      method: 'POST',
      headers: {
        TTL: String(TTL_SECONDS),
        Urgency: 'normal',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      },
      body,
    },
  };
}
