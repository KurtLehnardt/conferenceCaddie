// The device credential that protects a people document.
//
// The client generates a profile_id (16 random bytes) and a secret (32 random bytes), both
// base64url without padding, and sends them on every people write and circle read as the
// header "X-Caddie-Device: {profile_id}.{secret}". The server stores only sha256(secret) in hex
// and compares hashes in constant time. Neither value is ever logged or returned.

import crypto from 'node:crypto';

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_REF_SALT = 'conference-caddie-ref-v1';

// Returns { profileId, secret } or null when the header is missing or malformed.
export function parseDevice(req) {
  const raw = req.headers['x-caddie-device'];
  if (typeof raw !== 'string' || raw.length > 80) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const profileId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!PROFILE_ID_RE.test(profileId) || !SECRET_RE.test(secret)) return null;
  return { profileId, secret };
}

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

// True when sha256(secret) equals the stored hex hash. The comparison of the two 32-byte
// digests is constant time.
export function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The opaque reference a result carries as a UI key. It cannot be turned back into a profile_id.
export function refFor(eventId, profileId) {
  const salt = process.env.REF_SALT || DEFAULT_REF_SALT;
  return crypto.createHash('sha256').update(`${eventId}:${profileId}:${salt}`, 'utf8').digest('hex').slice(0, 16);
}

// Random credentials in the client's format, for the seed script.
export function newDevice() {
  return {
    profileId: crypto.randomBytes(16).toString('base64url'),
    secret: crypto.randomBytes(32).toString('base64url'),
  };
}
