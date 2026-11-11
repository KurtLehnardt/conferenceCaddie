// GET /api/capabilities: what this backend can do (docs/contracts/capabilities.md), computed from
// the server's configuration when it starts, so the document always matches what the server
// serves. push.apns and push.fcm are read at every request, because native-push.mjs turns a
// channel off at runtime when its platform keeps refusing it. Public, cacheable for five minutes,
// and readable from any origin, because it carries nothing private and a tier 1 page may read it
// from another origin.
//
// Env:
//   TALKS_BUNDLE_BASE  where conferences.json and the talk bundles live (an https URL ending in
//                      "/", without credentials, query or fragment); default the official GitHub
//                      Pages site. An unusable value stops the server at start.
//   BLE_MASTER_KEYRING and BLE_NEAR_RSSI, through server/ble-config.mjs (ble.mode and near_rssi).
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT: push.webpush is true only when all
//                      three are set, which is when nudge.mjs can send.
//   APNS_* and FCM_PROJECT_ID, through server/native-push.mjs: push.apns is true only when the
//                      APNs key, its key id and the team id are all set and well-formed, and
//                      push.fcm only when FCM_PROJECT_ID is, which is when nudge.mjs can send
//                      through them; either turns false after five authentication failures in a
//                      row, until the server restarts.
//
// Tier 3 serves every People API v1 route with server-side ranking and polling, the talk search
// routes and both server imports. Only the official deployment holds the APNs key and may send
// through the app's Firebase project, so on every other tier 3 server push.apns and push.fcm are
// false.

import { take, clientIp } from './ratelimit.mjs';
import { SERVICE_UUID, WINDOW_S } from '../contracts/js/ble-token.mjs';
import { BLE_MODE, NEAR_RSSI, SIGHTINGS_MIN_INTERVAL_S, COLOCATION_REQUIRED } from './ble-config.mjs';
import { NATIVE_PUSH } from './native-push.mjs';

export const DEFAULT_BUNDLE_BASE = 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
// The pattern of talks.bundle_base in contracts/schema/capabilities.v1.schema.json.
const BUNDLE_BASE_RE = /^https:\/\/[^/\s?#@]+(\/[^\s?#]*)?\/$/;
const BUNDLE_BASE_MAX = 2048;
// Cheap and cached by clients, but polled at every cold start of every app behind one venue
// address, so its per-address limit is as generous as the health check's.
const CAPABILITIES_PER_MIN = 600;
const MAX_AGE_S = 300;

/** TALKS_BUNDLE_BASE checked against the schema's rules, or the default when it is unset. */
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
  if (!ok) throw new Error('TALKS_BUNDLE_BASE must be an https URL ending in "/" without credentials, query or fragment.');
  return value;
}

/** True when Web Push can be sent: the three VAPID settings nudge.mjs needs are all set. */
export const webPushConfigured = (env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

/**
 * The capabilities document of this tier 3 server for a configuration:
 * { bleMode: 'derived-v1' | 'server-rotate', nearRssi, webpush, apns, fcm, bundleBase }, where
 * apns and fcm default to false.
 */
export function capabilitiesDocument({ bleMode, nearRssi, webpush, apns = false, fcm = false, bundleBase }) {
  return {
    api_version: 1,
    tier: 'paid',
    talks: { bundle_base: bundleBase, server_search: true },
    people: { enabled: true, semantic: 'server', presence: true, gps_bands: true, meets: true, circles: true, reports: true, live: 'poll' },
    ble: {
      mode: bleMode,
      service_uuid: SERVICE_UUID,
      near_rssi: nearRssi,
      window_s: WINDOW_S,
      sightings_min_interval_s: SIGHTINGS_MIN_INTERVAL_S,
      colocation_required: COLOCATION_REQUIRED,
    },
    push: { apns, fcm, webpush },
    imports: { github: 'server', schedule: 'server' },
  };
}

// What the start fixed. An unusable TALKS_BUNDLE_BASE throws here, so the server never starts.
const FIXED = Object.freeze({
  bleMode: BLE_MODE,
  nearRssi: NEAR_RSSI,
  webpush: webPushConfigured(process.env),
  bundleBase: bundleBaseFrom(process.env.TALKS_BUNDLE_BASE),
});

/** This server's document now. */
export const currentCapabilities = () => capabilitiesDocument({ ...FIXED, apns: NATIVE_PUSH.apns, fcm: NATIVE_PUSH.fcm });

// The body for each pair of native push flags, built once.
const bodies = new Map();
function body() {
  const key = `${NATIVE_PUSH.apns}:${NATIVE_PUSH.fcm}`;
  if (!bodies.has(key)) bodies.set(key, JSON.stringify(currentCapabilities()));
  return bodies.get(key);
}

function send(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Answers GET or HEAD /api/capabilities. */
export function handleCapabilities(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    return;
  }
  const rate = take(`capabilities:${clientIp(req)}`, CAPABILITIES_PER_MIN);
  if (!rate.ok) {
    send(res, 429, JSON.stringify({ error: 'Too many requests' }), { 'Retry-After': String(rate.retryAfterSec), 'Cache-Control': 'no-store' });
    return;
  }
  send(res, 200, body(), { 'Cache-Control': `public, max-age=${MAX_AGE_S}`, 'Access-Control-Allow-Origin': '*' });
}
