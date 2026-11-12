// GET /api/capabilities: what this tier 2 backend can do (docs/contracts/capabilities.md and
// contracts/schema/capabilities.v1.schema.json), computed from the Worker's configuration so the
// document always says what the Worker serves. Public, cacheable for five minutes, and readable
// from any origin, because it carries nothing private and a tier 1 page may read it from another
// origin.
//
// Env:
//   TALKS_BUNDLE_BASE  where conferences.json and the talk bundles live: an https URL ending in "/",
//                      without credentials, query or fragment. Default: the official GitHub Pages
//                      site. An unusable value gives a null bundle_base and one logged line.
//   BLE_MASTER_KEYRING and BLE_NEAR_RSSI, through lib/ble.js (ble.mode and near_rssi).
//
// What the Worker serves, and so what the document says:
// - talks: the bundles on GitHub Pages, and the talk search routes (/api/search, /api/related,
//   /api/recommendations), so server_search is true.
// - people: every People API v1 route. Profile vectors are computed by the Worker with Workers AI,
//   with a keyword fallback, so semantic is "server". There is no WebSocket channel: live is "poll".
//   PUT /api/presence takes until: 'keep' (connect/presence.js), so presence_keep_until is true.
// - ble: derived-v1 with the master keyring, else server-rotate; the co-location rule and the caps
//   apply in both. Sightings may come every 60 seconds.
// - push: the Web Push routes are served (GET /api/push/vapid says whether keys are set); the
//   Worker holds no APNs or FCM key.
// - imports: POST /api/import/schedule and POST /api/import/github are served.

import { SERVICE_UUID, WINDOW_S } from '../../contracts/js/ble-token.mjs';
import { bleConfig, SIGHTINGS_MIN_INTERVAL_S } from './lib/ble.js';

export const DEFAULT_BUNDLE_BASE = 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
// The pattern of talks.bundle_base in the schema.
const BUNDLE_BASE_RE = /^https:\/\/[^/\s?#@]+(\/[^\s?#]*)?\/$/;
const BUNDLE_BASE_MAX = 2048;
export const CAPABILITIES_MAX_AGE_S = 300;

let warned = false;

// TALKS_BUNDLE_BASE checked against the schema's rules; the default when it is unset, null when
// it is set but unusable.
export function bundleBaseFrom(value) {
  if (value === undefined || value === '') return DEFAULT_BUNDLE_BASE;
  let ok = typeof value === 'string' && value.length <= BUNDLE_BASE_MAX && BUNDLE_BASE_RE.test(value);
  if (ok) {
    try {
      const u = new URL(value);
      ok = u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      ok = false;
    }
  }
  if (ok) return value;
  if (!warned) {
    warned = true;
    console.error('TALKS_BUNDLE_BASE is not an https URL ending in "/"; capabilities say bundle_base null');
  }
  return null;
}

export function capabilitiesDocument(env) {
  const ble = bleConfig(env);
  return {
    api_version: 1,
    tier: 'free',
    talks: { bundle_base: bundleBaseFrom(env?.TALKS_BUNDLE_BASE), server_search: true },
    people: { enabled: true, semantic: 'server', presence: true, presence_keep_until: true, gps_bands: true, meets: true, circles: true, reports: true, live: 'poll' },
    ble: {
      mode: ble.mode,
      service_uuid: SERVICE_UUID,
      near_rssi: ble.nearRssi,
      window_s: WINDOW_S,
      sightings_min_interval_s: SIGHTINGS_MIN_INTERVAL_S,
      colocation_required: ble.colocationRequired,
    },
    push: { apns: false, fcm: false, webpush: true },
    imports: { github: 'server', schedule: 'server' },
  };
}
