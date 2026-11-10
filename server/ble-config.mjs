// Bluetooth settings, read from the environment once when the server starts. server/ble.mjs
// applies them and server/capabilities.mjs advertises them, so the capabilities document always
// says what the server does.
//
// Env:
//   BLE_MASTER_KEYRING  the master keyring of derived tokens v1 (server/ble-keyring.mjs), mounted
//                       from the Secret Manager secret caddie-ble-master by scripts/deploy.sh.
//                       Unset or empty: the server serves the legacy server-minted tokens only
//                       (ble.mode server-rotate). Set but unusable, including a current id that is
//                       not one of its keys: importing this module throws, so the server refuses
//                       to start rather than issue sessions that another instance could not resolve.
//                       It is never logged, and no error quotes it.
//   BLE_NEAR_RSSI       the weakest RSSI, in dBm, that counts as right near (default -75), rounded
//                       and clamped to -100..-30 as the capabilities contract requires.

import { parseKeyring, KeyringError } from './ble-keyring.mjs';

/** The range of ble.near_rssi in the capabilities document. */
export const NEAR_RSSI_MIN = -100;
export const NEAR_RSSI_MAX = -30;
export const NEAR_RSSI_DEFAULT = -75;

/** BLE_NEAR_RSSI as an integer in -100..-30, or -75 when it is unset or not a number. */
export function nearRssiFrom(value) {
  if (value === undefined || value === null || String(value).trim() === '') return NEAR_RSSI_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return NEAR_RSSI_DEFAULT;
  return Math.min(NEAR_RSSI_MAX, Math.max(NEAR_RSSI_MIN, Math.round(n)));
}

/**
 * The keyring from BLE_MASTER_KEYRING: null when it is unset or empty, else { current, masters }.
 * Throws when it is set but unusable, with a message that names the rule and never the value.
 */
export function keyringFrom(text) {
  if (text === undefined || text === '') return null;
  try {
    return parseKeyring(text);
  } catch (err) {
    const why = err instanceof KeyringError ? err.message : 'it could not be read';
    throw new Error(`BLE_MASTER_KEYRING is unusable: ${why}. The server refuses to start; fix or remove the caddie-ble-master secret (scripts/ble-master.mjs).`);
  }
}

/** The master keyring, or null when derived tokens are not configured. */
export const BLE_KEYRING = keyringFrom(process.env.BLE_MASTER_KEYRING);
/** derived-v1 when the keyring is configured; otherwise only the legacy server-minted tokens. */
export const BLE_MODE = BLE_KEYRING ? 'derived-v1' : 'server-rotate';
export const NEAR_RSSI = nearRssiFrom(process.env.BLE_NEAR_RSSI);
/** Tier 3 accepts a sightings report every 10 seconds from each device (the sightings bucket allows 6 a minute). */
export const SIGHTINGS_MIN_INTERVAL_S = 10;
/**
 * The co-location rule of the Phase 4 mitigations. This server applies it to every sightings
 * report, legacy tokens included, so the capabilities document says true in both modes.
 */
export const COLOCATION_REQUIRED = true;
