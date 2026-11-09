// Find people near me by Bluetooth (the Android companion): rotating tokens and sightings.
//
//   PUT  /api/presence { ..., ble: true }        (connect.mjs) mints a token with the presence write
//   POST /api/presence/ble/rotate { event }                      -> { ok, ble: { token, rotate_at } }
//   POST /api/presence/sightings  { event, sightings: [{ token, rssi }] } -> { nearby: [...] }
//
// Env: BLE_NEAR_RSSI (default -75), the weakest signal that still counts as "a few metres".
//
// How it works. A phone that turned the feature on advertises BLE_SERVICE_UUID with a 16-byte
// random token as service data and scans for the same UUID. The token lives on the owner's people
// document as ble_token / ble_token_until (10 minutes, never past presence_until) and means nothing
// to anyone but this server. Every ten seconds the phone reports the tokens it heard with their
// strongest RSSI; the server resolves them to people who are live, around, visible, not hidden and
// not blocked either way, keeps those at or above BLE_NEAR_RSSI, ranks them for the requester with
// the matches retriever restricted to those documents (people.mjs's peopleQuery, so nothing is
// ranked twice), and answers with the strong (non-broad) matches only.
//
// Rules this module keeps:
// - Symmetric by construction: both phones scan and both report, so each side learns on its own.
//   A device may ask who is near only while it is itself broadcasting a live token.
// - Nothing is stored and nothing is logged from a sightings report. Which tokens a device heard
//   exists on the server for the duration of the request only. No index holds sightings.
// - Tokens rotate every ten minutes and die with presence, so a token overheard by anyone else
//   cannot be followed from one place to the next, and an old token resolves to nobody.
// - The answer carries only what a match card already shows (ref, display name, evidence, speak
//   topics, zone), never a token, a distance, a signal strength or a profile id.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import {
  people, idx, docId, PEOPLE_INDEX, LIMITS,
  HttpError, UpstreamError, bad, sendJson, limit, jsonBody, requireDevice, isPlainObject,
  conferenceFor, authenticated, bulkOne, isAround, blockedIds, dispatch, topicsOf,
  peopleQuery, searchPeople, isBroad, toPerson,
} from './people.mjs';

/** The 128-bit service UUID the Android app advertises and scans for. Same value in BleConstants.kt. */
export const BLE_SERVICE_UUID = 'e52c391c-b926-4856-9a38-d46c3c10c733';
/** A token lives this long, never past presence_until. */
export const BLE_TOKEN_MS = 10 * 60_000;
export const BLE_OFF = { ble_token: null, ble_token_until: null };

const envRssi = Number(process.env.BLE_NEAR_RSSI);
const NEAR_RSSI = process.env.BLE_NEAR_RSSI !== undefined && Number.isFinite(envRssi) ? envRssi : -75;
const MAX_SIGHTINGS = 50;
const SIGHTINGS_PER_MINUTE = 6;
// Its own per-address bucket: a venue's Wi-Fi puts many phones behind one address, and a report
// every ten seconds from each must not starve their matches and inbox reads.
const SIGHTINGS_PER_MINUTE_IP = 300;
const RSSI_MIN = -127;
const RSSI_MAX = 20;
// 16 random bytes, base64url without padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });

/** The token fields for a presence write at nowMs; the token never outlives the presence. */
export function mintBleToken(nowMs, presenceUntilMs) {
  const until = Math.min(nowMs + BLE_TOKEN_MS, presenceUntilMs);
  return { ble_token: crypto.randomBytes(16).toString('base64url'), ble_token_until: iso(until) };
}

/** What the client gets back for the fields mintBleToken made. */
export const bleView = (fields) => ({ token: fields.ble_token, rotate_at: fields.ble_token_until });

const hasLiveToken = (me, nowMs) => typeof me.ble_token_until === 'string' && Date.parse(me.ble_token_until) > nowMs;

// ---------------------------------------------------------------------------------------------
// Rotate: a new token for a device whose presence is on.

const ROTATE_KEYS = new Set(['event']);

async function rotate(req, res) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  const body = await jsonBody(req, ROTATE_KEYS);
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me || me.open_to_meet !== true) throw profileRequired();
  if (!isAround(me)) throw new HttpError(403, { error: 'presence_required' });
  const fields = mintBleToken(Date.now(), Date.parse(me.presence_until));
  const status = await bulkOne({ update: { _id: docId(conf.slug, me.profile_id) } }, { doc: fields });
  if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
  sendJson(res, 200, { ok: true, ble: bleView(fields) });
}

// ---------------------------------------------------------------------------------------------
// Sightings: who, among the tokens this phone heard, is a strong match standing right here.

const SIGHTINGS_KEYS = new Set(['event', 'sightings']);
const SIGHTING_KEYS = new Set(['token', 'rssi']);

// Validates the report and returns a Map token -> strongest rssi. At most 50 entries, each a
// base64url token of 16 bytes and an integer RSSI in dBm.
function parseSightings(value) {
  if (!Array.isArray(value) || value.length > MAX_SIGHTINGS) throw bad(`sightings must be an array of at most ${MAX_SIGHTINGS} entries`);
  const heard = new Map();
  for (const s of value) {
    if (!isPlainObject(s)) throw bad('each sighting must be an object');
    for (const k of Object.keys(s)) if (!SIGHTING_KEYS.has(k)) throw bad(`Unknown key: sightings.${k.slice(0, 40)}`);
    if (typeof s.token !== 'string' || !TOKEN_RE.test(s.token)) throw bad('token must be 16 bytes, base64url');
    if (!Number.isInteger(s.rssi) || s.rssi < RSSI_MIN || s.rssi > RSSI_MAX) throw bad(`rssi must be an integer from ${RSSI_MIN} to ${RSSI_MAX}`);
    const known = heard.get(s.token);
    if (known === undefined || s.rssi > known) heard.set(s.token, s.rssi);
  }
  return heard;
}

async function sightings(req, res) {
  limit(`ble-sightings:ip:${clientIp(req)}`, SIGHTINGS_PER_MINUTE_IP);
  const device = requireDevice(req);
  limit(`ble-sightings:dev:${device.profileId}`, SIGHTINGS_PER_MINUTE);
  const body = await jsonBody(req, SIGHTINGS_KEYS);
  const heard = parseSightings(body.sightings);
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me || me.open_to_meet !== true) throw profileRequired();
  const now = Date.now();
  // Only a phone that is itself around and broadcasting a live token may ask who is near it.
  if (!isAround(me) || !hasLiveToken(me, now)) throw new HttpError(403, { error: 'ble_required' });

  const near = [...heard].filter(([, rssi]) => rssi >= NEAR_RSSI).map(([token]) => token);
  if (!near.length) {
    sendJson(res, 200, { nearby: [] });
    return;
  }

  // Tokens to people: live tokens of people who are around, visible conference-wide, not hidden
  // after reports and not the requester. Only the profile ids are read here.
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_search`, {
    size: near.length,
    _source: ['profile_id'],
    query: {
      bool: {
        filter: [
          { term: { event_id: conf.slug } },
          { terms: { ble_token: near } },
          { range: { ble_token_until: { gt: 'now' } } },
          { range: { presence_until: { gt: 'now' } } },
          { range: { visible_until: { gt: 'now' } } },
          { term: { open_to_meet: true } },
        ],
        must_not: [{ term: { hidden: true } }, { ids: { values: [docId(conf.slug, me.profile_id)] } }],
      },
    },
  });
  const blocked = await blockedIds(conf.slug, me.profile_id);
  const ids = [...new Set((json.hits?.hits ?? []).map((h) => h._source?.profile_id).filter((id) => typeof id === 'string' && id && !blocked.has(id)))];
  if (!ids.length) {
    sendJson(res, 200, { nearby: [] });
    return;
  }

  // The same ranking as POST /api/people/matches, as the requester, restricted to these people.
  const q = peopleQuery(me, [{ term: { open_to_meet: true } }, { ids: { values: ids.map((id) => docId(conf.slug, id)) } }], { size: ids.length, blocked, explain: true });
  if (!q) {
    sendJson(res, 200, { nearby: [] });
    return;
  }
  const [result, topics] = await Promise.all([searchPeople(q.body), topicsOf(conf.slug)]);
  const hits = (result.hits?.hits ?? []).filter((h) => !isBroad(h, q.legs, me, topics.common));
  const nearby = hits.map((h) => {
    const p = toPerson(h, me, topics.labels, new Map(), null);
    return { ref: p.ref, display_name: p.display_name, evidence: p.evidence, speak_topics: p.speak_topics, zone: p.zone };
  });
  sendJson(res, 200, { nearby });
}

// ---------------------------------------------------------------------------------------------

const ROUTES = {
  '/api/presence/ble/rotate': { POST: rotate },
  '/api/presence/sightings': { POST: sightings },
};

// Handles the Bluetooth token and sightings routes. Resolves to true when the request was handled.
export async function handleBleApi(req, res, url) {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  await dispatch(route, req, res, url);
  return true;
}
