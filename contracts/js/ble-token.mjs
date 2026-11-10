// Reference implementation of Bluetooth derived tokens v1 (docs/contracts/ble-tokens.md).
//
//   ble_key = HMAC-SHA256(ble_master_secret, "caddie-ble-key-v1" || uint16be(n) || profile_id_utf8 || presence_nonce)
//             where n is the byte length of profile_id_utf8 and presence_nonce is 16 bytes
//   token_w = first 16 bytes of HMAC-SHA256(ble_key, "caddie-ble-v1" || uint64be(w))
//   w       = floor(unix_seconds / window_s), window_s = 600
//
// The server never stores a ble_key. It stores a random 16-byte presence_nonce on the person's
// document, rotated on every presence write with ble: true, derives the key from its master secret,
// returns it to the device once and forgets it. The phone derives the token of the current window
// from that key with no network call. To resolve a sighting, the server derives the keys of the
// conference's live Bluetooth users again and matches the reported token against windows w - 1, w
// and w + 1 of its own clock. Only node:crypto is used.

import crypto from 'node:crypto';

/** The ASCII label that starts every token HMAC message; it binds a token to this protocol version. */
export const LABEL = 'caddie-ble-v1';
/** The ASCII label that starts every key-derivation HMAC message. */
export const KEY_LABEL = 'caddie-ble-key-v1';
export const KEY_BYTES = 32;
export const NONCE_BYTES = 16;
/** The master secret is at least this long. */
export const MASTER_MIN_BYTES = 32;
export const TOKEN_BYTES = 16;
/** Window length of protocol v1, in seconds. The capabilities document advertises it as ble.window_s. */
export const WINDOW_S = 600;
/** Windows the server accepts around its own current window w: w - 1, w and w + 1. */
export const ACCEPT_OFFSETS = [-1, 0, 1];
/** The 128-bit service UUID every phone advertises and scans for (unchanged from the Android companion). */
export const SERVICE_UUID = 'e52c391c-b926-4856-9a38-d46c3c10c733';
/** The GATT characteristic, inside SERVICE_UUID, whose value is the current payload. Read only. */
export const TOKEN_CHARACTERISTIC_UUID = '944ddf9a-6eea-4583-978f-9da68fc3f562';
/** First byte of a v1 payload: service data and the GATT value are 0x01 followed by the token. */
export const PAYLOAD_FORMAT_V1 = 0x01;
export const PAYLOAD_V1_BYTES = 1 + TOKEN_BYTES;

const UINT64_MAX = (1n << 64n) - 1n;
const B64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const B64URL_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** A fresh presence_nonce: 16 random bytes, minted by the server on every presence write with ble: true. */
export function newPresenceNonce() {
  return crypto.randomBytes(NONCE_BYTES);
}

/**
 * The key-derivation message: the ASCII label "caddie-ble-key-v1", the byte length of the UTF-8
 * profile_id as an unsigned 16-bit big-endian integer, the UTF-8 profile_id, then the 16-byte nonce.
 * The length prefix and the fixed nonce length make the split between profile_id and nonce
 * unambiguous.
 */
export function keyMessage(profileId, nonce) {
  if (typeof profileId !== 'string' || !profileId) throw new TypeError('profile_id must be a non-empty string');
  const id = Buffer.from(profileId, 'utf8');
  if (id.length > 0xffff) throw new RangeError('profile_id is too long');
  const n = Buffer.from(nonce);
  if (n.length !== NONCE_BYTES) throw new TypeError('presence_nonce must be 16 bytes');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(id.length, 0);
  return Buffer.concat([Buffer.from(KEY_LABEL, 'ascii'), len, id, n]);
}

/** ble_key for one presence session: HMAC-SHA256(master, keyMessage(profileId, nonce)), 32 bytes. */
export function deriveBleKey(master, profileId, nonce) {
  const m = Buffer.from(master);
  if (m.length < MASTER_MIN_BYTES) throw new RangeError('ble_master_secret must be at least 32 bytes');
  return crypto.createHmac('sha256', m).update(keyMessage(profileId, nonce)).digest();
}

/** The key as it travels in the PUT /api/presence response: base64url without padding, 43 characters. */
export const encodeKey = (key) => Buffer.from(key).toString('base64url');

/** Decodes and checks a ble_key from base64url. Throws on anything but exactly 32 bytes. */
export function decodeKey(text) {
  if (typeof text !== 'string' || !B64URL_KEY.test(text)) throw new TypeError('ble_key must be 43 base64url characters');
  const key = Buffer.from(text, 'base64url');
  // 43 characters carry 258 bits; the last character's two spare bits must be zero.
  if (key.length !== KEY_BYTES || key.toString('base64url') !== text) throw new TypeError('ble_key is not canonical base64url of 32 bytes');
  return key;
}

/** The window index of a Unix time in whole seconds: floor(seconds / windowS), as a BigInt. */
export function windowOf(unixSeconds, windowS = WINDOW_S) {
  const s = BigInt(unixSeconds);
  if (s < 0n) throw new RangeError('unix seconds must not be negative');
  return s / BigInt(windowS);
}

/** The 21-byte HMAC message for window w: the ASCII label, then w as an unsigned 64-bit big-endian integer. */
export function message(w) {
  const big = BigInt(w);
  if (big < 0n || big > UINT64_MAX) throw new RangeError('w must fit an unsigned 64-bit integer');
  const out = Buffer.alloc(LABEL.length + 8);
  out.write(LABEL, 0, 'ascii');
  out.writeBigUInt64BE(big, LABEL.length);
  return out;
}

/** The full 32-byte HMAC-SHA256 for a key and window (tests and debugging only). */
export function hmac(key, w) {
  if (Buffer.from(key).length !== KEY_BYTES) throw new TypeError('ble_key must be 32 bytes');
  return crypto.createHmac('sha256', Buffer.from(key)).update(message(w)).digest();
}

/** token_w: the first 16 bytes of the HMAC. */
export const deriveToken = (key, w) => hmac(key, w).subarray(0, TOKEN_BYTES);

/** The token as the sightings API carries it: base64url without padding, 22 characters. */
export const encodeToken = (token) => Buffer.from(token).toString('base64url');

export function decodeToken(text) {
  if (typeof text !== 'string' || !B64URL_TOKEN.test(text)) throw new TypeError('token must be 22 base64url characters');
  const token = Buffer.from(text, 'base64url');
  if (token.length !== TOKEN_BYTES || token.toString('base64url') !== text) throw new TypeError('token is not canonical base64url of 16 bytes');
  return token;
}

/** The token a phone with this key advertises at a Unix time. */
export const tokenAt = (key, unixSeconds, windowS = WINDOW_S) => deriveToken(key, windowOf(unixSeconds, windowS));

/** The over-the-air payload of v1: one format byte (0x01), then the 16 token bytes. */
export function encodePayload(token) {
  const t = Buffer.from(token);
  if (t.length !== TOKEN_BYTES) throw new TypeError('token must be 16 bytes');
  return Buffer.concat([Buffer.from([PAYLOAD_FORMAT_V1]), t]);
}

/**
 * Reads service data or a GATT value heard from another phone. Returns { format, token } or null.
 * A 17-byte value starting with 0x01 is a derived v1 token. A bare 16-byte value is the legacy
 * server-minted token of the Android companion (server-rotate mode); it is reported the same way.
 * Anything else is ignored, so a later format cannot be mistaken for this one.
 */
export function decodePayload(bytes) {
  const b = Buffer.from(bytes);
  if (b.length === PAYLOAD_V1_BYTES && b[0] === PAYLOAD_FORMAT_V1) return { format: 'derived-v1', token: b.subarray(1) };
  if (b.length === TOKEN_BYTES) return { format: 'server-rotate', token: b };
  return null;
}

/**
 * The server's lookup table for one moment, built from what it stores: token (base64url) ->
 * profile_id for every live Bluetooth user of a conference ([{ profile_id, nonce }], nonce as bytes
 * or base64url), for windows w - 1, w and w + 1 of the server's clock. The keys are derived again
 * from the master secret and never kept.
 */
export function resolverForPeople(master, people, unixSeconds, windowS = WINDOW_S) {
  const keys = people.map(({ profile_id: id, nonce }) => ({
    id,
    key: deriveBleKey(master, id, typeof nonce === 'string' ? Buffer.from(nonce, 'base64url') : nonce),
  }));
  return resolverAt(keys, unixSeconds, windowS);
}

/**
 * The lookup table for given keys: token (base64url) -> owner id for windows w - 1, w and w + 1.
 * keys is [{ id, key }], key as bytes or base64url. A real server caches the table per window and
 * rebuilds it when w changes or a nonce changes.
 */
export function resolverAt(keys, unixSeconds, windowS = WINDOW_S) {
  const w = windowOf(unixSeconds, windowS);
  const table = new Map();
  for (const { id, key } of keys) {
    const k = typeof key === 'string' ? decodeKey(key) : Buffer.from(key);
    for (const d of ACCEPT_OFFSETS) {
      const wi = w + BigInt(d);
      if (wi < 0n) continue;
      table.set(encodeToken(deriveToken(k, wi)), id);
    }
  }
  return table;
}

/**
 * Resolves a sightings report the way the server does before ranking: the strongest RSSI per
 * token, those at or above nearRssi, then the owners of the tokens that resolve, without
 * duplicates and without the reporter. Returns [{ id, rssi }] strongest first.
 */
export function resolveSightings(sightings, table, { nearRssi = -75, self = null } = {}) {
  const best = new Map();
  for (const { token, rssi } of sightings) {
    const known = best.get(token);
    if (known === undefined || rssi > known) best.set(token, rssi);
  }
  const people = new Map();
  for (const [token, rssi] of best) {
    if (rssi < nearRssi) continue;
    const id = table.get(token);
    if (id === undefined || id === self) continue;
    if (!people.has(id) || rssi > people.get(id)) people.set(id, rssi);
  }
  return [...people].map(([id, rssi]) => ({ id, rssi })).sort((a, b) => b.rssi - a.rssi || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
