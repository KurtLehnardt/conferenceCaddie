// Bluetooth settings and derived tokens v1 for the Worker (docs/contracts/ble-tokens.md), the
// tier 2 port of server/ble-config.mjs, server/ble-keyring.mjs and the session half of
// server/ble.mjs on origin/feat/tier3-capabilities-ble. The key derivation, the tokens, the token
// table, the co-location rule and the caps are the reference implementation's
// (contracts/js/ble-token.mjs), imported rather than copied, so the Worker and the reference cannot
// drift. They use node:crypto, which the Worker gets from the nodejs_compat flag in wrangler.toml.
//
// Env:
//   BLE_MASTER_KEYRING  a Worker secret (never a [vars] entry): the master keyring as JSON,
//                       { "current": "<id>", "keys": { "<id>": "<secret>", ... } }, each secret at
//                       least 32 random bytes as base64url without padding. Unset or empty: only the
//                       legacy server-minted tokens are served (ble.mode server-rotate). Set but
//                       unusable: the Worker logs the rule that failed (never the value) and serves
//                       server-rotate, so the capabilities document still says what it does.
//   BLE_NEAR_RSSI       the weakest RSSI, in dBm, that counts as right near (default -75), rounded
//                       and clamped to -100..-30 as the capabilities contract requires.
//
// The keyring text is the secret itself, so no error raised or logged here quotes any part of it.

import {
  MASTER_MIN_BYTES, NONCE_BYTES, newPresenceNonce, deriveBleKey, encodeKey, keyId, nonceTag, sessionKey, tokenTable, windowOf,
  encodeToken, deriveToken, ACCEPT_OFFSETS, colocated,
} from '../../../contracts/js/ble-token.mjs';

export const NEAR_RSSI_MIN = -100;
export const NEAR_RSSI_MAX = -30;
export const NEAR_RSSI_DEFAULT = -75;
// Tier 2 accepts a sightings report every 60 seconds from each device (capabilities.md; the
// sightings bucket itself allows 6 a minute).
export const SIGHTINGS_MIN_INTERVAL_S = 60;
// The co-location rule of the Phase 4 mitigations, applied to every sightings report, legacy
// tokens included, so the capabilities document says true in both modes.
export const COLOCATION_REQUIRED = true;
// A legacy token lives this long, never past the presence.
export const BLE_TOKEN_MS = 10 * 60_000;
const BLE_TOKEN_BYTES = 16;

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_KEYS = 8;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class KeyringError extends Error {}

// Parses and checks keyring text, as server/ble-keyring.mjs does. Returns { current, masters }
// (masters: Map id -> bytes). Throws a KeyringError whose message never holds secret material.
export function parseKeyring(textValue) {
  if (typeof textValue !== 'string' || !textValue.trim()) throw new KeyringError('the keyring is empty');
  let raw;
  try {
    raw = JSON.parse(textValue);
  } catch {
    throw new KeyringError('the keyring is not valid JSON');
  }
  if (!isPlainObject(raw)) throw new KeyringError('the keyring must be a JSON object');
  for (const k of Object.keys(raw)) if (k !== 'current' && k !== 'keys') throw new KeyringError('the keyring may hold only "current" and "keys"');
  if (!isPlainObject(raw.keys)) throw new KeyringError('"keys" must be an object of key id to secret');
  const entries = Object.entries(raw.keys);
  if (!entries.length) throw new KeyringError('the keyring holds no key');
  if (entries.length > MAX_KEYS) throw new KeyringError(`the keyring holds more than ${MAX_KEYS} keys; retire the old ones`);
  const masters = new Map();
  for (const [id, secret] of entries) {
    if (!KEY_ID_RE.test(id)) throw new KeyringError('a key id must be 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or digit');
    if (typeof secret !== 'string' || !B64URL_RE.test(secret)) throw new KeyringError(`the secret of key ${id} is not base64url without padding`);
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.toString('base64url') !== secret) throw new KeyringError(`the secret of key ${id} is not canonical base64url`);
    if (bytes.length < MASTER_MIN_BYTES) throw new KeyringError(`the secret of key ${id} is shorter than ${MASTER_MIN_BYTES} bytes`);
    masters.set(id, bytes);
  }
  if (typeof raw.current !== 'string' || !masters.has(raw.current)) throw new KeyringError('the current key id is not one of the keys');
  return { current: raw.current, masters };
}

// BLE_NEAR_RSSI as an integer in -100..-30, or -75 when it is unset or not a number.
export function nearRssiFrom(value) {
  if (value === undefined || value === null || String(value).trim() === '') return NEAR_RSSI_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return NEAR_RSSI_DEFAULT;
  return Math.min(NEAR_RSSI_MAX, Math.max(NEAR_RSSI_MIN, Math.round(n)));
}

// The parsed configuration, per env text (an isolate holds one env, but tests may pass others).
let cached = { text: undefined, rssi: undefined, config: null };

// { keyring (or null), mode: 'derived-v1' | 'server-rotate', nearRssi, colocationRequired }.
export function bleConfig(env) {
  const textValue = env?.BLE_MASTER_KEYRING;
  const rssi = env?.BLE_NEAR_RSSI;
  if (cached.config && cached.text === textValue && cached.rssi === rssi) return cached.config;
  let keyring = null;
  if (typeof textValue === 'string' && textValue !== '') {
    try {
      keyring = parseKeyring(textValue);
    } catch (err) {
      const why = err instanceof KeyringError ? err.message : 'it could not be read';
      console.error(`BLE_MASTER_KEYRING is unusable: ${why}; serving legacy Bluetooth tokens only`);
    }
  }
  const config = { keyring, mode: keyring ? 'derived-v1' : 'server-rotate', nearRssi: nearRssiFrom(rssi), colocationRequired: COLOCATION_REQUIRED };
  cached = { text: textValue, rssi, config };
  return config;
}

const iso = (ms) => new Date(ms).toISOString();

// The legacy token fields for a presence write at nowMs; the token never outlives the presence.
export function mintBleToken(nowMs, presenceUntilMs) {
  return { ble_token: Buffer.from(crypto.getRandomValues(new Uint8Array(BLE_TOKEN_BYTES))).toString('base64url'), ble_token_until_ms: Math.min(nowMs + BLE_TOKEN_MS, presenceUntilMs) };
}

export const bleView = (fields) => ({ token: fields.ble_token, rotate_at: iso(fields.ble_token_until_ms) });

// The fields that end a Bluetooth session of either kind.
export const BLE_SESSION_OFF = Object.freeze({ ble_token: null, ble_token_until_ms: null, presence_nonce: null, ble_master_id: null, ble_rotated: false });

// A new Bluetooth session for a presence write with ble: true. Returns { fields, view }: the
// presence fields to store (a legacy token, and with a keyring a fresh presence_nonce under the
// current master), and the response fields (ble, and with a keyring ble_key and ble_key_id). The
// key exists only in view; nothing stores or logs it.
export function mintBleSession(config, profileId, nowMs, presenceUntilMs) {
  const legacy = { ...mintBleToken(nowMs, presenceUntilMs), ble_rotated: false };
  if (!config.keyring) return { fields: { ...legacy, presence_nonce: null, ble_master_id: null }, view: { ble: bleView(legacy) } };
  const nonce = newPresenceNonce();
  const key = deriveBleKey(config.keyring.masters.get(config.keyring.current), profileId, nonce);
  return {
    fields: { ...legacy, presence_nonce: nonce.toString('base64url'), ble_master_id: config.keyring.current },
    view: { ble: bleView(legacy), ble_key: encodeKey(key), ble_key_id: keyId(key) },
  };
}

// The derived session a person's presence carries ({ profile_id, presence_nonce, ble_master_id }),
// or null when it has none or a malformed one.
export function derivedSession(person) {
  const pr = person?.presence;
  if (!pr || typeof pr.presence_nonce !== 'string' || !NONCE_RE.test(pr.presence_nonce)) return null;
  if (typeof pr.ble_master_id !== 'string' || !pr.ble_master_id) return null;
  if (Buffer.from(pr.presence_nonce, 'base64url').length !== NONCE_BYTES) return null;
  return { profile_id: person.profile_id, presence_nonce: pr.presence_nonce, ble_master_id: pr.ble_master_id };
}

export const sessionHeld = (config, session) => Boolean(config.keyring && session && config.keyring.masters.has(session.ble_master_id));

// The key of a stored session, or null without a keyring or session, or when its master is retired.
export const keyOfSession = (config, session) => (sessionHeld(config, session) ? sessionKey(config.keyring.masters, session) : null);

export const tagOf = (session) => nonceTag(Buffer.from(session.presence_nonce, 'base64url'));

export { keyId, windowOf };

// ---------------------------------------------------------------------------------------------
// The token table of a conference (step 2 of the resolution), cached in the ConferenceDO's memory
// per window. It is rebuilt at each window change and, on a token it cannot find, when it is older
// than 30 seconds; a session minted in this object is added at once (addSession). Step 3 checks
// every hit against the store again, so a stale entry never resolves an ended or replaced session.

const TABLE_STALE_MS = 30_000;

// sessions: the live derived sessions of the conference.
export function tableFor(holder, config, sessionsFn, nowMs, { refresh = false } = {}) {
  const w = windowOf(Math.floor(nowMs / 1000));
  const t = holder.bleTable;
  if (t && t.w === w && !(refresh && nowMs - t.builtAt > TABLE_STALE_MS)) return t.table;
  const table = tokenTable(config.keyring.masters, sessionsFn(), Math.floor(nowMs / 1000));
  holder.bleTable = { w, builtAt: nowMs, table };
  return table;
}

// Adds one new session's tokens to a cached table of the current window.
export function addSession(holder, config, session, nowMs) {
  const t = holder.bleTable;
  const w = windowOf(Math.floor(nowMs / 1000));
  if (!t || t.w !== w) return;
  const key = keyOfSession(config, session);
  if (!key) return;
  const entry = { profile_id: session.profile_id, nonce_tag: tagOf(session) };
  for (const d of ACCEPT_OFFSETS) {
    const wi = w + BigInt(d);
    if (wi >= 0n) t.table.set(encodeToken(deriveToken(key, wi)), entry);
  }
}

// ---------------------------------------------------------------------------------------------
// Steps 1 to 4 of the resolution, for both kinds of token, as a pure function so the sightings
// route and the parity run over contracts/fixtures/ble/resolution-cases.v1.json
// (worker/scripts/ble-parity.mjs) share it.
//
//   heard: Map token -> strongest rssi (already one entry per token).
//   table: the derived-token table (tableFor), or null without a keyring.
//   current: Map profile_id -> the store's view of every person who may resolve, read for this
//            request: { session (derivedSession or null), ble_token, ble_token_until_ms,
//            presence_until_ms, zone, cell }. The caller leaves out anyone who is not live, not
//            open to meet or hidden.
//   requester: { profile_id, zone, cell }.
// Returns [{ id, rssi }], strongest first. Steps 5 and 6 (blocks, ranking, caps, zone) follow.
export function resolveTokens(config, { heard, table, current, requester, nowMs }) {
  const byLegacy = new Map();
  for (const [id, p] of current) if (p.ble_token && p.ble_token_until_ms > nowMs) byLegacy.set(p.ble_token, id);
  const people = new Map();
  for (const [token, rssi] of heard) {
    // 1. The threshold.
    if (rssi < config.nearRssi) continue;
    // 2. The token table, then the legacy tokens.
    const entry = table?.get(token) ?? null;
    const id = entry ? entry.profile_id : byLegacy.get(token);
    if (!id || id === requester.profile_id) continue;
    // 3. The store, read for this request: the same session (nonce tag, master still held) or the
    // same live legacy token, and presence still live.
    const p = current.get(id);
    if (!p || !(p.presence_until_ms > nowMs)) continue;
    if (entry) {
      if (!p.session || !sessionHeld(config, p.session) || tagOf(p.session) !== entry.nonce_tag) continue;
    } else if (!(p.ble_token === token && p.ble_token_until_ms > nowMs)) {
      continue;
    }
    // 4. Co-location: the same zone, or the same or a neighbouring ~100 m cell.
    if (config.colocationRequired && !colocated(requester, { zone: p.zone ?? null, cell: p.cell ?? null })) continue;
    if (!people.has(id) || rssi > people.get(id)) people.set(id, rssi);
  }
  return [...people].map(([id, rssi]) => ({ id, rssi })).sort((a, b) => b.rssi - a.rssi || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
