// The Bluetooth master keyring of derived tokens v1 (docs/contracts/ble-tokens.md, Keys): parsing,
// checking and writing it. Importing this module has no side effects and reads no env, so the
// operator script scripts/ble-master.mjs shares it with the server (server/ble-config.mjs).
//
// The keyring is JSON: { "current": "<id>", "keys": { "<id>": "<secret>", ... } }, where each
// secret is at least 32 random bytes as base64url without padding and exactly one id is current.
// New sessions are issued under the current master; the others are kept so that sessions issued
// under them still resolve until they are retired.
//
// The keyring text is the secret itself, so no error raised here quotes it or any part of it: the
// messages name the rule that failed and, at most, a key id, which is not secret. JSON.parse's own
// message is dropped for that reason, because it can quote the text it failed on.

import crypto from 'node:crypto';
import { MASTER_MIN_BYTES } from '../contracts/js/ble-token.mjs';

/** A key id: short, starting with a letter or digit, so it can never be "__proto__" or the like. */
export const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** More masters than this means old ones were never retired. */
export const MAX_KEYS = 8;
/** Bytes of a secret that scripts/ble-master.mjs generates. */
export const NEW_SECRET_BYTES = 32;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A keyring that cannot be used. Its message never contains secret material. */
export class KeyringError extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parses and checks keyring text. Returns { current, masters } with masters a Map from key id to
 * the secret's bytes. Throws a KeyringError when the text is not a usable keyring, including when
 * the current id is not one of the keys.
 */
export function parseKeyring(text) {
  if (typeof text !== 'string' || !text.trim()) throw new KeyringError('the keyring is empty');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeyringError('the keyring is not valid JSON');
  }
  return checkKeyring(raw);
}

/** Checks a parsed keyring object; the same rules and result as parseKeyring. */
export function checkKeyring(raw) {
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

/** The keyring as the JSON text that Secret Manager holds. */
export function serializeKeyring({ current, masters }) {
  const keys = Object.fromEntries([...masters].map(([id, bytes]) => [id, Buffer.from(bytes).toString('base64url')]));
  const text = JSON.stringify({ current, keys });
  // Never write a keyring the server would refuse to start with.
  checkKeyring(JSON.parse(text));
  return text;
}

/** A new random master secret. */
export const newMasterSecret = () => crypto.randomBytes(NEW_SECRET_BYTES);

/**
 * A new key id that is not in use: the UTC date and four random hex digits, for example
 * "2026-11-10-3fa2", so an operator can tell the keys apart by age.
 */
export function newKeyId(existing = new Map(), now = new Date()) {
  for (;;) {
    const id = `${now.toISOString().slice(0, 10)}-${crypto.randomBytes(2).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
}
