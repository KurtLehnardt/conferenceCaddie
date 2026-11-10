// Find people near me by Bluetooth: derived tokens v1, the legacy server-minted tokens, and
// sightings.
//
//   PUT  /api/presence { ..., ble: true }  (connect.mjs) starts a Bluetooth session with the presence write
//   POST /api/presence/ble/rotate { event }                      -> { ok, ble: { token, rotate_at } }   (legacy)
//   POST /api/presence/sightings  { event, sightings: [{ token, rssi }] } -> { nearby: [...], ble_key_id? }
//
// Env: BLE_MASTER_KEYRING and BLE_NEAR_RSSI, read once by ble-config.mjs.
//
// Two kinds of token resolve here (docs/contracts/ble-tokens.md):
// - Derived tokens v1 (ble.mode derived-v1, when the master keyring is configured). A presence
//   write with ble: true mints a fresh 16-byte presence_nonce and stores it, as base64url, with
//   ble_master_id, the id of the current master; both are unindexed and never returned. The
//   response carries ble_key = HMAC-SHA256(master, label || len || profile_id || nonce) and its
//   ble_key_id once. The key is never stored or logged: the server derives it again from the
//   master and the stored nonce whenever it needs it. The phone derives the token of every
//   ten-minute window from the key without the network. The key derivation, the tokens, the token
//   table, the co-location rule and the caps are the reference implementation's
//   (contracts/js/ble-token.mjs), imported rather than copied, so the server and the reference
//   cannot drift.
// - Legacy server-minted tokens (the Capacitor APK). The same presence write also mints a random
//   16-byte ble_token for ten minutes (never past presence_until), and the old app fetches the next
//   one from the rotate route. Both are served until the old APKs are retired; a new app ignores
//   the legacy token, and an old app ignores ble_key.
//
// Sightings resolve both kinds through the same steps, and every one of the Phase 4 mitigations
// applies to every token, whichever kind it is and whichever mode the server advertises:
//   1. the strongest RSSI per token, dropping those under BLE_NEAR_RSSI;
//   2. derived tokens through the conference's token table (token -> profile id and nonce tag, for
//      windows w - 1, w and w + 1 of the server's clock), cached per instance and window and rebuilt
//      on a token it cannot find once it is older than 30 seconds; a token not in the table is
//      tried as a legacy token;
//   3. one query of the store for every hit: a derived hit counts only while the stored nonce still
//      has the table's tag and its master is held, a legacy hit only while its token is live, and
//      both only while the person is around, visible conference-wide, open to meet, not hidden
//      and not the requester, so a cached table never resolves an ended or replaced session;
//   4. co-location: the same zone, or the same or a neighbouring ~100 m cell (3 x 3 cells);
//   5. blocks in either direction, then the matches ranking restricted to these people and the
//      strong-match rule (people.mjs's peopleQuery, so nothing is ranked twice or differently);
//   6. the caps on the final answer, at most 10 new people per token window and 30 per rolling hour
//      for one device, recorded on the requester's own people document (ble_caps, a list of
//      { ref, at, w } pruned to the last hour, with ble_caps_until, written with the guarded
//      own-document update only when an answer adds someone new, and cleared by the purge once the
//      newest entry is an hour old); and a zone only for people in the requester's own zone.
//
// Rules this module keeps:
// - Symmetric by construction: both phones scan and both report, so each side learns on its own.
//   A device may ask who is near only while it is itself around with a live Bluetooth session:
//   otherwise 403 ble_required; a derived session whose master has been retired is 403 ble_rekey
//   (unless it is an old app's, whose rotated legacy token keeps it going), and the device fetches
//   a new key with a presence write.
// - No sighting is stored or logged. Which tokens a device heard exists on the server for the
//   duration of the request only. The caps record names only people the device was answered with.
// - The answer carries only what a match card already shows (ref, display name, evidence, speak
//   topics, zone), never a token, a key, a distance, a signal strength or a profile id; a
//   derived-v1 answer adds the requester's own ble_key_id.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import {
  NONCE_BYTES, windowOf, newPresenceNonce, deriveBleKey, encodeKey, keyId, nonceTag,
  sessionKey, tokenTable, colocated, applyCaps, RESOLVE_CAPS,
} from '../contracts/js/ble-token.mjs';
import { BLE_KEYRING, NEAR_RSSI, COLOCATION_REQUIRED } from './ble-config.mjs';
import {
  people, idx, docId, PEOPLE_INDEX, LIMITS, BLE_SESSION_OFF,
  HttpError, bad, sendJson, limit, jsonBody, requireDevice, isPlainObject,
  conferenceFor, authenticated, updateOwnProfile, isAround, cellOf, blockedIds, dispatch, topicsOf,
  peopleQuery, rankPeople, isBroad, toPerson, SEMANTIC_FLOORS,
} from './people.mjs';

/** The 128-bit service UUID the phones advertise and scan for. Same value in BleConstants.kt and the contract. */
export const BLE_SERVICE_UUID = 'e52c391c-b926-4856-9a38-d46c3c10c733';
/** A legacy token lives this long, never past presence_until. */
export const BLE_TOKEN_MS = 10 * 60_000;
/** The fields that end a Bluetooth session of either kind. */
export const BLE_OFF = BLE_SESSION_OFF;

const MAX_SIGHTINGS = 50;
const SIGHTINGS_PER_MINUTE = 6;
// Its own per-address bucket: a venue's Wi-Fi puts many phones behind one address, and a report
// every ten seconds from each must not starve their matches and inbox reads.
const SIGHTINGS_PER_MINUTE_IP = 300;
const RSSI_MIN = -127;
const RSSI_MAX = 20;
// 16 random bytes, base64url without padding: a token on the wire, and a stored nonce.
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 60 * 60_000;
// The token table: rebuilt at each window change, and on a token it cannot find once older than
// this, so a session minted on the other instance is found within half a minute.
const TABLE_STALE_MS = 30_000;
const TABLE_PAGE = 1000;
const TABLE_MAX_PAGES = 20;
const TABLES_MAX = 64;
// What step 3 reads of each sighted person: their session, liveness, zone and cell. Never returned.
const STORE_FIELDS = ['profile_id', 'presence_until', 'presence_zone', 'presence_cell', 'presence_nonce', 'ble_master_id', 'ble_token', 'ble_token_until'];

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });
const bleRequired = () => new HttpError(403, { error: 'ble_required' });
const bleRekey = () => new HttpError(403, { error: 'ble_rekey' });

/** The legacy token fields for a presence write at nowMs; the token never outlives the presence. */
export function mintBleToken(nowMs, presenceUntilMs) {
  const until = Math.min(nowMs + BLE_TOKEN_MS, presenceUntilMs);
  return { ble_token: crypto.randomBytes(16).toString('base64url'), ble_token_until: iso(until) };
}

/** What the client gets back for the fields mintBleToken made. */
export const bleView = (fields) => ({ token: fields.ble_token, rotate_at: fields.ble_token_until });

/**
 * A new Bluetooth session for a presence write with ble: true. Returns { fields, view }: the
 * fields to store with the presence (a legacy token, and with a keyring a fresh presence_nonce
 * under the current master), and the response fields (ble, and with a keyring ble_key and
 * ble_key_id). The key exists only in view; nothing stores it.
 */
export function mintBleSession(profileId, nowMs, presenceUntilMs, keyring = BLE_KEYRING) {
  const legacy = { ...mintBleToken(nowMs, presenceUntilMs), ble_rotated: null };
  if (!keyring) return { fields: { ...legacy, presence_nonce: null, ble_master_id: null }, view: { ble: bleView(legacy) } };
  const nonce = newPresenceNonce();
  const key = deriveBleKey(keyring.masters.get(keyring.current), profileId, nonce);
  return {
    fields: { ...legacy, presence_nonce: nonce.toString('base64url'), ble_master_id: keyring.current },
    view: { ble: bleView(legacy), ble_key: encodeKey(key), ble_key_id: keyId(key) },
  };
}

const hasLiveToken = (source, nowMs) => typeof source.ble_token === 'string' && typeof source.ble_token_until === 'string' && Date.parse(source.ble_token_until) > nowMs;

// The derived session a document carries, in the shape the reference's sessionKey and tokenTable
// take, or null when it has none (or a malformed one, which then resolves nobody).
function derivedSession(source) {
  if (typeof source.profile_id !== 'string' || !source.profile_id) return null;
  if (typeof source.presence_nonce !== 'string' || !TOKEN_RE.test(source.presence_nonce)) return null;
  if (typeof source.ble_master_id !== 'string' || !source.ble_master_id) return null;
  if (Buffer.from(source.presence_nonce, 'base64url').length !== NONCE_BYTES) return null;
  return { profile_id: source.profile_id, presence_nonce: source.presence_nonce, ble_master_id: source.ble_master_id };
}

// True when the master that issued a stored session is still in the keyring.
const held = (session) => Boolean(BLE_KEYRING && session && BLE_KEYRING.masters.has(session.ble_master_id));

// The key of a stored session, or null without a keyring, without a session, or when the master
// that issued it is no longer held.
const keyOfSession = (session) => (held(session) ? sessionKey(BLE_KEYRING.masters, session) : null);

// ---------------------------------------------------------------------------------------------
// Rotate (legacy): a new server-minted token for a device whose presence is on.

const ROTATE_KEYS = new Set(['event']);

async function rotate(req, res) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  const body = await jsonBody(req, ROTATE_KEYS);
  const conf = await conferenceFor(body.event);
  // Guarded by the sequence number of the profile read (updateOwnProfile), so a rotation that read
  // the profile just before a delete hid it cannot put a token back on the hidden document. It
  // leaves a derived session as it is.
  const { fields } = await updateOwnProfile(device, conf.slug, (me) => {
    if (!me || me.open_to_meet !== true) throw profileRequired();
    if (!isAround(me)) throw new HttpError(403, { error: 'presence_required' });
    const fields = mintBleToken(Date.now(), Date.parse(me.presence_until));
    // Only the old APK calls this route, so a rotated token marks a session of an old app
    // (sightings answers it under a retired master instead of asking it to re-key).
    return { doc: { ...fields, ble_rotated: true }, fields };
  });
  sendJson(res, 200, { ok: true, ble: bleView(fields) });
}

// ---------------------------------------------------------------------------------------------
// The token table of derived sessions, per conference, cached in this instance per window.

const tables = new Map(); // slug -> { w, builtAt, promise }, least recently used first

// Reads the conference's live sessions and derives their tokens for windows w - 1, w and w + 1.
// The table holds profile ids and nonce tags only; the keys are derived and dropped. Every presence
// write with ble: true stores a legacy token next to the nonce, and ble: false clears both, so only
// documents with a ble_token can hold a session (the nonce itself is not indexed).
async function buildTable(slug, nowMs) {
  const sessions = [];
  let after;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === TABLE_MAX_PAGES) {
      truncated = true;
      break;
    }
    const body = {
      size: TABLE_PAGE,
      _source: ['profile_id', 'presence_nonce', 'ble_master_id'],
      query: {
        bool: {
          filter: [
            { term: { event_id: slug } },
            { exists: { field: 'ble_token' } },
            { range: { presence_until: { gt: 'now' } } },
            { range: { visible_until: { gt: 'now' } } },
            { term: { open_to_meet: true } },
          ],
          must_not: [{ term: { hidden: true } }],
        },
      },
      sort: [{ profile_id: 'asc' }],
    };
    if (after) body.search_after = after;
    const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_search`, body);
    const hits = json.hits?.hits ?? [];
    for (const h of hits) {
      const session = derivedSession(h._source ?? {});
      if (session) sessions.push(session);
    }
    if (hits.length < TABLE_PAGE || !Array.isArray(hits[hits.length - 1].sort)) break;
    after = hits[hits.length - 1].sort;
  }
  // The count only: never a profile id, a nonce or a token.
  if (truncated) console.error(`The Bluetooth token table of ${slug} stopped at ${TABLE_MAX_PAGES * TABLE_PAGE} live documents; the rest do not resolve.`);
  return tokenTable(BLE_KEYRING.masters, sessions, Math.floor(nowMs / 1000));
}

// The table for the window of nowMs. With refresh, a table older than 30 seconds is rebuilt. At
// most TABLES_MAX conferences are kept; the one used least recently goes first.
function tableFor(slug, nowMs, { refresh = false } = {}) {
  const w = Number(windowOf(Math.floor(nowMs / 1000)));
  let entry = tables.get(slug);
  if (!entry || entry.w !== w || (refresh && nowMs - entry.builtAt > TABLE_STALE_MS)) {
    entry = { w, builtAt: nowMs, promise: buildTable(slug, nowMs) };
    const built = entry;
    // A failed build is not cached: the next request tries again.
    built.promise.catch(() => {
      if (tables.get(slug) === built) tables.delete(slug);
    });
  }
  tables.delete(slug);
  tables.set(slug, entry);
  if (tables.size > TABLES_MAX) tables.delete(tables.keys().next().value);
  return entry.promise;
}

// ---------------------------------------------------------------------------------------------
// The caps of mitigation 2, on the requester's own document.

const isEntry = (e) => isPlainObject(e) && typeof e.ref === 'string' && Number.isFinite(e.at) && Number.isInteger(e.w);
// The stored record as applyCaps's state ({ entries: [{ id, at, w }] }) at time t. An entry stamped
// later than t, by a request that started after this one but wrote first, or by the other instance
// with its clock ahead, counts as returned at t: applyCaps leaves out entries from after its now,
// and without the clamp such a request's people would not count against this one's caps.
const capsState = (source, t) => ({
  entries: (Array.isArray(source.ble_caps) ? source.ble_caps : []).filter(isEntry).map((e) => ({ id: e.ref, at: Math.min(e.at, t), w: e.w })),
});
// The fields to store for a state: the record, and when its newest entry leaves the rolling hour,
// after which the purge clears both (EXPIRED_CAPS_QUERY).
function capsFields(state) {
  if (!state.entries.length) return { ble_caps: [], ble_caps_until: null };
  const newest = Math.max(...state.entries.map((e) => e.at));
  return { ble_caps: state.entries.map((e) => ({ ref: e.id, at: e.at, w: e.w })), ble_caps_until: iso(newest + HOUR_MS) };
}
// applyCaps at time t on a stored record. added is true when the answer returns someone the record
// does not hold for this window, which is when the record must be written.
function capsAt(nearby, source, t) {
  const before = capsState(source, t).entries.filter((e) => e.at > t - HOUR_MS).length;
  const { kept, state } = applyCaps(nearby, capsState(source, t), { nowMs: t, caps: RESOLVE_CAPS });
  return { kept, state, added: state.entries.length > before };
}

/**
 * Applies the caps to the final answer (each item carries ref) and records whom it returned.
 * The record is written only when the answer adds someone new to it, guarded by the sequence
 * number of the profile read; on a conflict the profile is read again and the caps recomputed
 * from what is stored, at the time of that read. When a second conflict prevents the write, the
 * answer keeps only the people already returned to this device in this window, so the caps hold
 * either way. The write skips refresh=wait_for: the guard reads the document with a realtime GET,
 * and nothing searches for the record at once.
 */
async function capped(device, slug, me, nearby) {
  if (!nearby.length) return [];
  const t0 = Date.now();
  const first = capsAt(nearby, me, t0);
  if (!first.added) return first.kept;
  try {
    const { kept } = await updateOwnProfile(device, slug, (fresh) => {
      if (!fresh || fresh.open_to_meet !== true) throw profileRequired();
      const { kept, state } = capsAt(nearby, fresh, Date.now());
      return { doc: capsFields(state), kept };
    }, { current: me, refresh: false });
    return kept;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 409) throw err;
    const w = Number(windowOf(Math.floor(t0 / 1000)));
    const returned = new Set(capsState(me, t0).entries.filter((e) => e.w === w && e.at > t0 - HOUR_MS).map((e) => e.id));
    return nearby.filter((p) => returned.has(p.ref));
  }
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

  // Only a phone that is itself around with a live Bluetooth session may ask who is near it: a
  // derived session whose master is held, or a live legacy token. A derived session under a
  // retired master asks the device for a new key (403 ble_rekey), unless the session is an old
  // app's: its legacy token is live and was rotated, which only the old APK does, and the old APK
  // does not know ble_rekey. A new app never rotates, so it is asked to re-key at once.
  const session = BLE_KEYRING ? derivedSession(me) : null;
  const myKey = keyOfSession(session);
  const legacyLive = hasLiveToken(me, now);
  if (!isAround(me)) throw bleRequired();
  if (session && !myKey && !(legacyLive && me.ble_rotated === true)) throw bleRekey();
  if (!myKey && !legacyLive) throw bleRequired();
  const answer = (nearby) => sendJson(res, 200, myKey ? { nearby, ble_key_id: keyId(myKey) } : { nearby });

  // 1. The strongest RSSI per token (parseSightings) at or above the threshold.
  const near = [...heard].filter(([, rssi]) => rssi >= NEAR_RSSI);
  if (!near.length) {
    answer([]);
    return;
  }

  // 2. Derived tokens through the token table; the rest are tried as legacy tokens.
  const derived = new Map(); // profile_id -> { nonce_tag, rssi }
  const legacy = new Map(); // token -> rssi
  if (BLE_KEYRING) {
    let table = await tableFor(conf.slug, now);
    if (near.some(([token]) => !table.has(token))) table = await tableFor(conf.slug, now, { refresh: true });
    for (const [token, rssi] of near) {
      const entry = table.get(token);
      if (!entry) {
        legacy.set(token, rssi);
      } else if (entry.profile_id !== me.profile_id) {
        const known = derived.get(entry.profile_id);
        if (!known || rssi > known.rssi) derived.set(entry.profile_id, { nonce_tag: entry.nonce_tag, rssi });
      }
    }
  } else {
    for (const [token, rssi] of near) legacy.set(token, rssi);
  }
  const ids = [...derived.keys()];
  const tokens = [...legacy.keys()];
  if (!ids.length && !tokens.length) {
    answer([]);
    return;
  }

  // 3. One query of the store for every hit, then the session checks on what it returns.
  const should = [];
  if (tokens.length) should.push({ bool: { filter: [{ terms: { ble_token: tokens } }, { range: { ble_token_until: { gt: 'now' } } }] } });
  if (ids.length) should.push({ ids: { values: ids.map((id) => docId(conf.slug, id)) } });
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_search`, {
    size: tokens.length + ids.length,
    _source: STORE_FIELDS,
    query: {
      bool: {
        filter: [
          { term: { event_id: conf.slug } },
          { range: { presence_until: { gt: 'now' } } },
          { range: { visible_until: { gt: 'now' } } },
          { term: { open_to_meet: true } },
        ],
        should,
        minimum_should_match: 1,
        must_not: [{ term: { hidden: true } }, { ids: { values: [docId(conf.slug, me.profile_id)] } }],
      },
    },
  });
  const requester = { zone: me.presence_zone ?? null, cell: cellOf(me) };
  const found = new Set();
  for (const h of json.hits?.hits ?? []) {
    const s = h._source ?? {};
    const id = s.profile_id;
    if (typeof id !== 'string' || !id || id === me.profile_id || found.has(id) || !isAround(s)) continue;
    const byLegacy = hasLiveToken(s, now) && legacy.has(s.ble_token);
    const hit = derived.get(id);
    const stored = derivedSession(s);
    const byDerived = Boolean(hit && held(stored) && nonceTag(Buffer.from(stored.presence_nonce, 'base64url')) === hit.nonce_tag);
    if (!byLegacy && !byDerived) continue;
    // 4. Co-location: the same zone, or the same or a neighbouring ~100 m cell.
    if (COLOCATION_REQUIRED && !colocated(requester, { zone: s.presence_zone ?? null, cell: cellOf(s) })) continue;
    found.add(id);
  }

  // 5. Blocks in either direction, then the same ranking as POST /api/people/matches, as the
  // requester, restricted to these people, with the same keyword fallback when inference fails
  // (rankPeople), keeping the strong (non-broad) matches. The semantic legs use the stricter push
  // floor (SEMANTIC_FLOORS.push), so a text match must be close to reach a person who did not
  // search.
  const blocked = await blockedIds(conf.slug, me.profile_id);
  const candidates = [...found].filter((id) => !blocked.has(id));
  if (!candidates.length) {
    answer([]);
    return;
  }
  const build = (semantic) => peopleQuery(me, [{ term: { open_to_meet: true } }, { ids: { values: candidates.map((id) => docId(conf.slug, id)) } }], { size: candidates.length, blocked, explain: true, semantic, floor: SEMANTIC_FLOORS.push });
  const [ranked, topics] = await Promise.all([rankPeople(conf.slug, build), topicsOf(conf.slug)]);
  if (!ranked) {
    answer([]);
    return;
  }
  const { json: result, q } = ranked;
  const hits = (result.hits?.hits ?? []).filter((h) => !isBroad(h, q.legs, me, topics.common));
  // 6. The zone only within the requester's own zone, then the caps on this final list.
  const nearby = hits.map((h) => {
    const p = toPerson(h, me, topics.labels, new Map(), null);
    const zone = p.zone !== null && p.zone === me.presence_zone ? p.zone : null;
    return { ref: p.ref, display_name: p.display_name, evidence: p.evidence, speak_topics: p.speak_topics, zone };
  });
  answer(await capped(device, conf.slug, me, nearby));
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
