// The device credential that protects a profile, ported from server/device.mjs to Web Crypto.
//
// The client generates a profile_id (16 random bytes) and a secret (32 random bytes), both
// base64url without padding, and sends them as "X-Caddie-Device: {profile_id}.{secret}". Only
// sha256(secret) in hex is stored, and hashes are compared in constant time. Neither value is
// ever logged or returned.

import { forbidden } from './http.js';

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_REF_SALT = 'conference-caddie-ref-v1';
const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function sha256Hex(textValue) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(textValue)));
}

// Returns { profileId, secret } or null when the header is missing or malformed.
export function parseDevice(req) {
  const raw = req.headers.get('x-caddie-device');
  if (typeof raw !== 'string' || raw.length > 80) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const profileId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!PROFILE_ID_RE.test(profileId) || !SECRET_RE.test(secret)) return null;
  return { profileId, secret };
}

// The device of the request, or 403 forbidden when the header is missing or malformed.
export function requireDevice(req) {
  const device = parseDevice(req);
  if (!device) throw forbidden();
  return device;
}

export const hashSecret = (secret) => sha256Hex(secret);

// True when sha256(secret) equals the stored hex hash, compared in constant time.
export async function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || !HASH_RE.test(storedHash) || typeof secret !== 'string') return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
  const b = fromHex(storedHash);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

// The opaque reference a result carries as a UI key, 16 hex characters. It cannot be turned back
// into a profile_id without the salt.
export async function refFor(env, eventId, profileId) {
  const salt = env?.REF_SALT || DEFAULT_REF_SALT;
  return (await sha256Hex(`${eventId}:${profileId}:${salt}`)).slice(0, 16);
}
