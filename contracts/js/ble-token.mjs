// Reference implementation of Bluetooth derived tokens v1 (docs/contracts/ble-tokens.md).
//
//   ble_key = HMAC-SHA256(ble_master_secret, "caddie-ble-key-v1" || uint16be(n) || profile_id_utf8 || presence_nonce)
//             where n is the byte length of profile_id_utf8, presence_nonce is 16 bytes, and the
//             master secret is the one whose id is stored with the nonce (ble_master_id)
//   ble_key_id = base64url(first 8 bytes of HMAC-SHA256(ble_key, "caddie-ble-key-id-v1"))
//   token_w = first 16 bytes of HMAC-SHA256(ble_key, "caddie-ble-v1" || uint64be(w))
//   w       = floor(unix_seconds / window_s), window_s = 600
//
// The server never stores a ble_key. It stores a random 16-byte presence_nonce on the person's
// document, rotated on every presence write with ble: true, derives the key from its master secret,
// returns it to the device once and forgets it. The phone derives the token of the current window
// from that key with no network call. To resolve a sighting, the server derives the keys of the
// conference's live Bluetooth users again, matches the reported token against windows w - 1, w and
// w + 1 of its own clock, checks the match against the stored session, and applies the co-location
// rule and the per-device caps. Only node:crypto is used.

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

/**
 * The window index of a Unix time: floor(seconds / windowS), as a BigInt. Fractional seconds (a
 * number from Date.now() / 1000) are floored first.
 */
export function windowOf(unixSeconds, windowS = WINDOW_S) {
  const s = typeof unixSeconds === 'number' ? BigInt(Math.floor(unixSeconds)) : BigInt(unixSeconds);
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

/** The ASCII label of the key id HMAC. */
export const KEY_ID_LABEL = 'caddie-ble-key-id-v1';

/**
 * ble_key_id: base64url of the first 8 bytes of HMAC-SHA256(ble_key, "caddie-ble-key-id-v1"),
 * 11 characters. It names a key without revealing it: the server sends it with the key and with
 * every sightings answer, and a device whose stored key has another id writes presence with
 * ble: true again to get a fresh key.
 */
export function keyId(key) {
  const k = Buffer.from(key);
  if (k.length !== KEY_BYTES) throw new TypeError('ble_key must be 32 bytes');
  return crypto.createHmac('sha256', k).update(Buffer.from(KEY_ID_LABEL, 'ascii')).digest().subarray(0, 8).toString('base64url');
}

/** nonce_tag: the first 16 hex digits of sha256(presence_nonce). The token table names a session by it. */
export const nonceTag = (nonce) => crypto.createHash('sha256').update(Buffer.from(nonce)).digest('hex').slice(0, 16);

const asBytes = (v) => (typeof v === 'string' ? Buffer.from(v, 'base64url') : Buffer.from(v));
// masters: a Map or an object, master id -> secret (bytes or hex).
const masterFor = (masters, id) => {
  const m = masters instanceof Map ? masters.get(id) : masters?.[id];
  if (m === undefined) return null;
  return typeof m === 'string' ? Buffer.from(m, 'hex') : Buffer.from(m);
};

/**
 * The key of one stored presence session, or null when the master that issued its nonce is no
 * longer held (it was retired, for example after a leak). person is { profile_id, presence_nonce,
 * ble_master_id }, the nonce as bytes or base64url.
 */
export function sessionKey(masters, person) {
  const master = masterFor(masters, person.ble_master_id);
  if (!master) return null;
  return deriveBleKey(master, person.profile_id, asBytes(person.presence_nonce));
}

/**
 * The token table of a conference: token (base64url) -> { profile_id, nonce_tag } for every stored
 * Bluetooth session ([{ profile_id, presence_nonce, ble_master_id }]) and for windows w - 1, w and
 * w + 1 of the server's clock. Keys are derived and dropped; the table holds no key material. A
 * server may cache it per window (step 2 of the spec's resolution), because step 3 checks every
 * entry against the store again.
 */
export function tokenTable(masters, people, unixSeconds, windowS = WINDOW_S) {
  const w = windowOf(unixSeconds, windowS);
  const table = new Map();
  for (const person of people) {
    const key = sessionKey(masters, person);
    if (!key) continue;
    const entry = { profile_id: person.profile_id, nonce_tag: nonceTag(asBytes(person.presence_nonce)) };
    for (const d of ACCEPT_OFFSETS) {
      const wi = w + BigInt(d);
      if (wi < 0n || wi > UINT64_MAX) continue;
      table.set(encodeToken(deriveToken(key, wi)), entry);
    }
  }
  return table;
}

/**
 * Token (base64url) -> id for given keys ([{ id, key }]), windows w - 1, w and w + 1. A lower-level
 * helper for tests and tools; the server uses tokenTable.
 */
export function resolverAt(keys, unixSeconds, windowS = WINDOW_S) {
  const w = windowOf(unixSeconds, windowS);
  const table = new Map();
  for (const { id, key } of keys) {
    const k = typeof key === 'string' ? decodeKey(key) : Buffer.from(key);
    for (const d of ACCEPT_OFFSETS) {
      const wi = w + BigInt(d);
      if (wi < 0n || wi > UINT64_MAX) continue;
      table.set(encodeToken(deriveToken(k, wi)), id);
    }
  }
  return table;
}

/** Default caps on distinct people in one device's answers (Phase 4 mitigations). */
export const RESOLVE_CAPS = Object.freeze({ perHour: 30, perWindow: 10 });

/** The grid of presence cells, as server/people.mjs builds it: 0.001 degree of latitude (about 111 m). */
export const CELL_DEG = 0.001;
const rad = (deg) => (deg * Math.PI) / 180;
// The longitude step of the grid at a latitude (capped at one degree near the poles), as cellFor does.
const lonStepAt = (lat) => CELL_DEG / Math.max(Math.cos(rad(lat)), CELL_DEG);

/**
 * True when two cell centres are the same cell or one of its eight neighbours. A position near a
 * cell edge jitters between neighbouring cells from one fix to the next, so the 3 x 3 block around
 * a cell (about 330 m across) counts as co-located.
 */
export function neighbouringCells(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;
  if (Math.abs(a.lat - b.lat) > CELL_DEG * 1.5) return false;
  let dLon = Math.abs(a.lon - b.lon);
  if (dLon > 180) dLon = 360 - dLon;
  return dLon <= Math.max(lonStepAt(a.lat), lonStepAt(b.lat)) * 1.5;
}

/**
 * True when two people count as co-located for Bluetooth resolution: the same presence zone, or
 * both have a stored position in the same ~100 m cell or a neighbouring one.
 */
export function colocated(requester, person) {
  if (requester.zone && requester.zone === person.zone) return true;
  return neighbouringCells(requester.cell, person.cell);
}

/**
 * Resolves a sightings report the way the server does before ranking (docs/contracts/ble-tokens.md,
 * Resolution, steps 1 to 4):
 *   1. the strongest RSSI per token, dropping those under nearRssi;
 *   2. the token table entry of each token;
 *   3. only entries whose profile is in `current` (the store, read for this request) with the same
 *      nonce_tag and presence still live, and not the requester, so a cached table can never
 *      resolve a replaced session or one whose presence ended;
 *   4. only people co-located with the requester (unless colocationRequired is false).
 * current: Map profile_id -> { nonce_tag, presence_until (ms), zone, cell }, required unless the
 * co-location rule is off (a caller cannot apply the rule without the store, so it must not
 * silently skip it). requester: { profile_id, zone, cell }.
 * Returns [{ id, rssi }] strongest first. The caps apply later, to the final answer (applyCaps).
 */
export function resolveSightings(sightings, table, {
  nearRssi = -75, requester = {}, current = null, nowMs = Date.now(), colocationRequired = true,
} = {}) {
  if (colocationRequired && !current) throw new TypeError('the co-location rule needs the current store (current)');
  const best = new Map();
  for (const { token, rssi } of sightings) {
    const known = best.get(token);
    if (known === undefined || rssi > known) best.set(token, rssi);
  }
  const people = new Map();
  for (const [token, rssi] of best) {
    if (rssi < nearRssi) continue;
    const entry = table.get(token);
    if (!entry || entry.profile_id === requester.profile_id) continue;
    if (current) {
      const now = current.get(entry.profile_id);
      if (!now || now.nonce_tag !== entry.nonce_tag || !(now.presence_until > nowMs)) continue;
      if (colocationRequired && !colocated(requester, now)) continue;
    }
    if (!people.has(entry.profile_id) || rssi > people.get(entry.profile_id)) people.set(entry.profile_id, rssi);
  }
  return [...people].map(([id, rssi]) => ({ id, rssi })).sort((a, b) => b.rssi - a.rssi || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const HOUR_MS = 3_600_000;

/**
 * The per-device caps, applied to the final `nearby` answer (after blocks, ranking and the
 * strong-match rule), in its order. state is the device's record { entries: [{ id, at, w }] }:
 * each person returned, with the time (ms) and window it was returned in. It is kept where every
 * instance of the backend sees it (docs/contracts/ble-tokens.md, Phase 4 mitigations).
 *   - a person already returned to this device in the current window always passes;
 *   - anyone else needs fewer than caps.perWindow distinct people returned in the current window,
 *     and, unless returned within the last hour, fewer than caps.perHour distinct people returned
 *     in the rolling hour before nowMs.
 * Returns { kept, state }, the new state holding only the last hour's entries.
 */
export function applyCaps(nearby, state, { nowMs = Date.now(), windowS = WINDOW_S, caps = RESOLVE_CAPS } = {}) {
  const w = Number(windowOf(nowMs / 1000, windowS));
  const entries = (state?.entries ?? []).filter((e) => e.at > nowMs - HOUR_MS && e.at <= nowMs);
  const inWindow = new Set(entries.filter((e) => e.w === w).map((e) => e.id));
  const inHour = new Set(entries.map((e) => e.id));
  const kept = [];
  for (const item of nearby) {
    const id = item.id ?? item.ref;
    if (!inWindow.has(id)) {
      if (inWindow.size >= caps.perWindow) continue;
      if (!inHour.has(id) && inHour.size >= caps.perHour) continue;
      inWindow.add(id);
      inHour.add(id);
      entries.push({ id, at: nowMs, w });
    }
    kept.push(item);
  }
  return { kept, state: { entries } };
}
