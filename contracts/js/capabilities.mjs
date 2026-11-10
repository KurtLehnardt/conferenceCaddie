// Reference implementation of the capabilities contract v1 (docs/contracts/capabilities.md):
// backend URL rules, discovery, version negotiation and the effective feature set a client acts on.
//
// Producers validate their document against contracts/schema/capabilities.v1.schema.json in closed
// mode. Consumers do not: they read what they understand, ignore unknown fields, map unknown enum
// values to the most conservative known value, and treat a missing field as off. The one
// exception is a backend with no document at all, which is today's server before Phase 1 and is
// read as the full current feature set (LEGACY).

export const SERVICE_UUID = 'e52c391c-b926-4856-9a38-d46c3c10c733';
/** The major versions this implementation understands. */
export const CLIENT_API_VERSIONS = Object.freeze([1]);

/**
 * The effective capabilities of a backend that has no capabilities document but answers
 * GET /api/health with { "ok": true }: the existing tier 3 server as it was before Phase 1. It
 * serves every People API v1 route, legacy server-minted Bluetooth tokens, Web Push and both
 * server imports, and it has no talk bundles.
 */
export const LEGACY = deepFreeze({
  api_version: 1,
  tier: 'paid',
  talks: { bundle_base: null, server_search: true },
  people: { enabled: true, semantic: 'server', presence: true, gps_bands: true, meets: true, circles: true, reports: true, live: 'poll' },
  ble: { mode: 'server-rotate', service_uuid: SERVICE_UUID, near_rssi: -75, window_s: 600, sightings_min_interval_s: 10 },
  push: { apns: false, fcm: false, webpush: true },
  imports: { github: 'server', schedule: 'server' },
});

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObject(v) ? v : {});
const bool = (v) => v === true;
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const int = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/**
 * Picks the major version to speak with a backend. Returns { ok: true, version } or
 * { ok: false, reason }, where reason is 'invalid' (no usable api_version) or 'update_app' (the
 * backend serves only majors newer than this client knows).
 */
export function negotiate(doc, supported = CLIENT_API_VERSIONS) {
  if (!isObject(doc) || !Number.isInteger(doc.api_version) || doc.api_version < 1) return { ok: false, reason: 'invalid' };
  const max = doc.api_version;
  const min = Number.isInteger(doc.min_api_version) && doc.min_api_version >= 1 && doc.min_api_version <= max ? doc.min_api_version : max;
  const usable = supported.filter((v) => v >= min && v <= max);
  if (!usable.length) return { ok: false, reason: max > Math.max(...supported) ? 'update_app' : 'invalid' };
  return { ok: true, version: Math.max(...usable) };
}

/**
 * The feature set a v1 client acts on, from a document it has accepted with negotiate(). Every
 * field is present in the result. Unknown fields are dropped, unknown enum values become the most
 * conservative known value, a missing flag is off, and features that depend on others are turned
 * off with them (no Bluetooth without presence, no people features without reports).
 */
export function effectiveCapabilities(doc) {
  const d = obj(doc);
  const talks = obj(d.talks);
  const people = obj(d.people);
  const ble = obj(d.ble);
  const push = obj(d.push);
  const imports = obj(d.imports);

  const bundleBase = typeof talks.bundle_base === 'string' && isHttpsBase(talks.bundle_base) ? talks.bundle_base : null;
  // A backend that cannot take reports must not show other people's text at all.
  const peopleOn = bool(people.enabled) && bool(people.reports);
  const presence = peopleOn && bool(people.presence);
  let mode = oneOf(ble.mode, ['derived-v1', 'server-rotate', 'none'], 'none');
  if (!presence) mode = 'none';
  const windowS = mode === 'derived-v1' ? 600 : int(ble.window_s, 60, 3600, 600);
  const intervalMax = mode === 'derived-v1' ? windowS / 2 : 1800;

  return {
    api_version: 1,
    tier: oneOf(d.tier, ['demo', 'free', 'paid'], 'unknown'),
    talks: { bundle_base: bundleBase, server_search: bool(talks.server_search) },
    people: {
      enabled: peopleOn,
      semantic: peopleOn ? oneOf(people.semantic, ['server', 'client', 'off'], 'off') : 'off',
      presence,
      gps_bands: presence && bool(people.gps_bands),
      meets: presence && bool(people.meets),
      circles: peopleOn && bool(people.circles),
      reports: peopleOn,
      live: peopleOn ? oneOf(people.live, ['websocket', 'poll'], 'poll') : 'poll',
    },
    ble: {
      mode,
      service_uuid: SERVICE_UUID,
      near_rssi: int(ble.near_rssi, -127, 20, -75),
      window_s: windowS,
      sightings_min_interval_s: int(ble.sightings_min_interval_s, 10, intervalMax, Math.min(60, intervalMax)),
    },
    push: { apns: bool(push.apns), fcm: bool(push.fcm), webpush: bool(push.webpush) },
    imports: {
      github: oneOf(imports.github, ['device', 'server'], 'device'),
      schedule: oneOf(imports.schedule, ['device', 'server'], 'device'),
    },
  };
}

function isHttpsBase(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && s.endsWith('/') && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Normalises a backend URL the user typed in Settings, or that a deep link or QR code carries.
 * Returns { ok: true, base, origin } or { ok: false, reason }. https only, no credentials, no query
 * or fragment; the base keeps its path (a tier 1 Pages site lives under /<repo>) without a trailing
 * slash. allowLocalHttp admits http://localhost, 127.0.0.1 and 10.0.2.2 for debug builds and must
 * be false for a deep link or QR code.
 */
export function normaliseBackendUrl(input, { allowLocalHttp = false } = {}) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  const local = ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocalHttp && local && u.protocol === 'http:')) return { ok: false, reason: 'https_required' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_not_allowed' };
  if (u.search || u.hash) return { ok: false, reason: 'query_not_allowed' };
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, base, origin: u.origin };
}

/**
 * Reads a caddie://connect?url=<backend> deep link (or the same text from a QR code). It never
 * switches anything by itself: it returns what the confirmation screen must show, and the switch
 * happens only after the user confirms a prompt that names the origin. Plain http is refused.
 */
export function parseConnectLink(link) {
  let u;
  try {
    u = new URL(String(link));
  } catch {
    return { ok: false, reason: 'not_a_link' };
  }
  if (u.protocol !== 'caddie:' || u.hostname !== 'connect') return { ok: false, reason: 'not_a_connect_link' };
  const target = u.searchParams.get('url');
  if (!target) return { ok: false, reason: 'missing_url' };
  const n = normaliseBackendUrl(target, { allowLocalHttp: false });
  if (!n.ok) return n;
  return { ok: true, base: n.base, origin: n.origin, requiresConfirmation: true, prompt: `Switch to the server at ${n.origin}?` };
}

/**
 * Discovers a backend's capabilities. fetchFn(url) resolves to { status, json } where json is the
 * parsed body or undefined when the body was not JSON; it rejects on a network failure.
 *
 *   1. GET {base}/api/capabilities   (tiers 2 and 3)
 *   2. GET {base}/capabilities.json  (tier 1, a static site)
 *   3. Only when step 1 answered 404: GET {base}/api/health; { "ok": true } means a legacy server.
 *
 * Returns { source: 'api' | 'static' | 'legacy', version, doc, effective } on success, or
 * { source: 'none', reason } where reason is 'update_app' or 'unreachable'. The caller keeps the
 * last good result per backend origin and uses it on 'unreachable'; it never downgrades a backend
 * it once read a document from to legacy because of a failure.
 */
export async function discoverCapabilities(base, fetchFn) {
  let apiStatus = null;
  let tooNew = false;
  for (const [source, path] of [['api', '/api/capabilities'], ['static', '/capabilities.json']]) {
    let r;
    try {
      r = await fetchFn(`${base}${path}`);
    } catch {
      continue;
    }
    if (source === 'api') apiStatus = r.status;
    if (r.status !== 200 || !isObject(r.json)) continue;
    const n = negotiate(r.json);
    if (n.ok) return { source, version: n.version, doc: r.json, effective: effectiveCapabilities(r.json) };
    if (n.reason === 'update_app') tooNew = true;
  }
  if (tooNew) return { source: 'none', reason: 'update_app' };
  if (apiStatus === 404) {
    try {
      const h = await fetchFn(`${base}/api/health`);
      if (h.status === 200 && isObject(h.json) && h.json.ok === true) return { source: 'legacy', version: 1, doc: null, effective: structuredClone(LEGACY) };
    } catch {
      // fall through
    }
  }
  return { source: 'none', reason: 'unreachable' };
}
