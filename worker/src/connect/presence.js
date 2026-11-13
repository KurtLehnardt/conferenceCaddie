// "I'm around" presence and the Bluetooth token rotation (PLAN section 1.9, routes 20, 21 and
// 30), ported from server/connect.mjs and the rotate route of server/ble.mjs.
//
//   PUT    /api/presence { event, zone, spot?, location?, until?, ble? }
//   DELETE /api/presence?event=
//   POST   /api/presence/ble/rotate { event }
//
// Rules this module keeps:
// - Presence needs a live profile that is visible conference-wide (open_to_meet); otherwise 403
//   profile_required. The zone must be one of the conference's zones. The spot line passes the
//   filter (moderation.js); a spot line hidden after reports stays off until an operator unhides it.
// - Presence ends 60 minutes after it was turned on ('hour'), or at the end of the conference day
//   in its time zone ('day'), and never after the end of the conference. Turning it on again
//   while it is on keeps the first `since`.
// - until: 'keep' keeps the stored end (only ever lowered to the end of the conference) and the
//   first `since`, so a write that only changes Bluetooth, the zone, the spot or the position
//   never makes someone visible for longer than they chose. It needs live presence and never
//   starts it: without live presence the answer is 400 presence_not_active and nothing is
//   written, neither the presence row, nor a position, nor a Bluetooth session. As on tier 3
//   (server/connect.mjs), until and ble are checked before the spot line goes to the filter, and a
//   'keep' without live presence is refused on the profile read, also before the filter.
// - A position is optional: rounded to 5 decimals, dropped when its accuracy is worse than 200 m,
//   dropped too when it implies the device moved faster than 7 m/s since its previous fix of the
//   last ten minutes. It is held in memory only (Store.setLocation), never written to a row and
//   never returned; only an active meet turns it into a distance and a bearing (meets.js).
// - The presence row is written only on a real change: presence was off, or the zone, spot line,
//   mode or Bluetooth flag changed, or the write carries no position (an explicit turn-on, which
//   restarts the hour for 'hour' and 'day'). A position-only update, the client's every-30-seconds fix, writes no row.
//   With 'keep' the mode never counts as a change, and the row is written when the kept end has
//   to be lowered to the end of the conference.
// - After a presence row was written and the answer built, the nudge rule runs for this person
//   (push/nudge.js afterPresence, which never throws). A position-only update cannot change who
//   is in the same zone, so it does not run the rule.
// - Turning presence off deletes the presence row and the position whatever the person read before
//   the secret check held, and closes the person's active meets.
// - Bluetooth (lib/ble.js, docs/contracts/ble-tokens.md): ble: true starts a new session. It
//   always mints a legacy 22-character token valid 10 minutes (never past the presence) for the
//   old Android companion, and with the master keyring (derived-v1) also a fresh 16-byte
//   presence_nonce under the current master, whose ble_key and ble_key_id go back in this
//   response only; the key is never stored. ble: false ends the session, and a write that says
//   nothing leaves a live session as it was, except that one starting a new presence session
//   clears whatever an ended one left, because one nonce is one presence session. The rotate
//   route mints a fresh legacy token while presence is on and leaves a derived session alone.
// - Nothing from a request body, header or row is logged.

import { HttpError, bad, json, readJson } from '../lib/http.js';
import { dayEndAfter } from '../lib/time.js';
import { afterPresence } from '../push/nudge.js';
import { closeActiveMeetsOf } from './meets.js';
import { HOUR_MS, iso, profileRequired, writer, line, distanceM } from './common.js';
import { bleConfig, mintBleSession, mintBleToken, bleView, derivedSession, addSession, BLE_SESSION_OFF } from '../lib/ble.js';

const PRESENCE_MS = HOUR_MS;
const SPOT_MAX = 60;
const ACCURACY_MAX_M = 200;
const COORD_DECIMALS = 5;
// A new fix is checked against the previous one while that is younger than this ...
const JUMP_WINDOW_MS = 10 * 60_000;
// ... and dropped when it implies a faster move than this: a brisk run, never walking in a hall.
const JUMP_MAX_MPS = 7;

const PRESENCE_KEYS = new Set(['event', 'zone', 'spot', 'location', 'until', 'ble']);
// 'keep' keeps the stored end of presence; it never starts presence (putPresence).
const PRESENCE_MODES = new Set(['hour', 'day', 'keep']);
const LOCATION_KEYS = new Set(['lat', 'lon', 'accuracy']);
const ROTATE_KEYS = new Set(['event']);

// The answer to until: 'keep' without live presence, word for word as tier 3 gives it.
const presenceNotActive = () => new HttpError(400, { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." });

// The optional position of a presence write: { lat, lon, accuracy } with accuracy in metres.
// Returns { lat, lon, accuracy } rounded to 5 decimals and whole metres, or null when there is no
// position or it is worse than 200 m, in which case the presence is zone-only. A malformed
// location is 400.
function parseLocation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('location must be an object or null');
  for (const k of Object.keys(value)) if (!LOCATION_KEYS.has(k)) throw bad(`Unknown key: location.${k.slice(0, 40)}`);
  const { lat, lon, accuracy } = value;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) throw bad('location.lat must be a latitude');
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) throw bad('location.lon must be a longitude');
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) throw bad('location.accuracy must be metres');
  if (accuracy > ACCURACY_MAX_M) return null;
  const round = (v) => Number(v.toFixed(COORD_DECIMALS));
  return { lat: round(lat), lon: round(lon), accuracy: Math.round(accuracy) };
}

// True when a new fix implies the device moved faster than JUMP_MAX_MPS since its previous fix,
// and that fix is younger than JUMP_WINDOW_MS. Such a fix is not kept: a phone cannot jump across
// a venue, and a client that claims to is probing. Writes less than a second apart count as a
// second.
function implausibleJump(prev, next, nowMs) {
  if (!prev || !Number.isFinite(prev.lat) || !Number.isFinite(prev.lon) || !Number.isFinite(prev.at)) return false;
  if (nowMs - prev.at >= JUMP_WINDOW_MS) return false;
  return distanceM(prev, next) / Math.max(1, (nowMs - prev.at) / 1000) > JUMP_MAX_MPS;
}

// The caller's live, conference-wide visible profile, else 403 profile_required.
// authenticate reads the cached person before it awaits the secret check, and the people cache can
// be dropped and rebuilt in that gap (a talks finalize does that), so the person is read from the
// cache again once the check is done. A write then never acts on a stale copy, such as one that
// still holds a presence that a DELETE /api/presence removed in the gap. A row for the profile that
// no longer carries the secret hash that was checked is not the caller's, so it is profile_required.
async function visibleProfile(ctx, device) {
  const checked = await ctx.store.authenticate(device);
  const me = checked ? ctx.store.person(checked.profile_id) : null;
  if (!me || me.secret_hash !== checked.secret_hash || !ctx.store.isLive(me) || !me.open_to_meet) throw profileRequired();
  return me;
}

async function putPresence(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, PRESENCE_KEYS);
  if (typeof body.zone !== 'string') throw bad('zone must be a string');
  const zone = body.zone.trim();
  // The mode and ble are checked before the spot line goes to the filter.
  const mode = body.until === undefined || body.until === null ? 'hour' : body.until;
  if (!PRESENCE_MODES.has(mode)) throw bad("until must be 'hour', 'day' or 'keep'");
  if (body.ble !== undefined && typeof body.ble !== 'boolean') throw bad('ble must be a boolean');
  const location = parseLocation(body.location);
  const store = ctx.store;
  // 'keep' needs live presence, which needs the profile: it is read first, so a 'keep' without
  // live presence is refused before the filter and before anything is written. visibleProfile
  // reads the person again after its last await, and nothing awaits from there to the write, so
  // the read of the current presence and the write that follows cannot interleave with another
  // request, and a presence ended in between is never brought back.
  let me = null;
  if (mode === 'keep') {
    me = await visibleProfile(ctx, device);
    if (!store.isAround(me)) throw presenceNotActive();
  }
  const { text: spot, pending: spotPending } = line(body.spot, 'spot', SPOT_MAX);
  me ??= await visibleProfile(ctx, device);
  if (!store.zones().has(zone)) throw bad("zone must be one of the conference's zones");
  const now = Date.now();
  const around = store.isAround(me);
  // Checked again on the clock of this write: isAround reads the clock after `now`, so `around`
  // already means the presence ends after `now`. On Workers the clock does not move while
  // synchronous code runs, so this agrees with the first check there; where the clock does move
  // (Node), an end reached in between answers presence_not_active instead of reading the end of no
  // presence below.
  if (mode === 'keep' && !around) throw presenceNotActive();
  const cur = around ? me.presence : null;
  const end = Number.isFinite(ctx.conf.visible_until_ms) ? ctx.conf.visible_until_ms : Infinity;
  // 'hour' runs out in 60 minutes; 'day' at the end of the conference day (its time zone), when
  // the client's zone confirmation does the safeguarding instead; in the last second of a day,
  // once 23:59:59 has passed, at the end of the next day (dayEndAfter). 'keep' keeps the stored
  // end, which it may only lower to the end of the conference, never raise. Never past the
  // conference end.
  const dayUntil = Math.min(dayEndAfter(now, ctx.conf.time_zone), end);
  const untilMs = mode === 'keep' ? Math.min(cur.until_ms, end)
    : mode === 'day' ? dayUntil : Math.min(now + PRESENCE_MS, end);
  if (untilMs <= now) throw bad('conference has ended');

  // A spot line hidden after reports stays off until the operator unhides it.
  const storedSpot = me.spot_hidden ? null : spot;
  const held = Boolean(storedSpot) && spotPending;
  // The mode is not stored: a presence whose end is today's end of day was set with 'day'.
  const curMode = cur ? (cur.until_ms === dayUntil ? 'day' : 'hour') : null;
  const explicit = body.location === undefined || body.location === null;
  const bleChange = body.ble === true || (body.ble === false && Boolean(cur?.ble_token || cur?.presence_nonce));
  // 'keep' is not a mode of its own, so it never counts as a change of mode; a kept end that the
  // end of the conference lowers does.
  const changed = !cur || explicit || bleChange || cur.zone !== zone || (cur.spot ?? null) !== storedSpot
    || Boolean(cur.spot_pending) !== held || (mode === 'keep' ? cur.until_ms !== untilMs : curMode !== mode);

  let presence = cur;
  let session = null;
  if (changed) {
    // Turning it on again while it is on extends it ('hour', 'day'); since keeps the first time.
    const since = cur && Number.isFinite(cur.since_ms) ? cur.since_ms : now;
    const fields = { zone, spot: storedSpot, spot_pending: held, since_ms: since, until_ms: untilMs };
    if (body.ble === true) session = mintBleSession(bleConfig(ctx.env), me.profile_id, now, untilMs);
    if (session) Object.assign(fields, session.fields);
    else if (body.ble === false || !cur) Object.assign(fields, BLE_SESSION_OFF);
    // A token kept from before never outlives the presence.
    else if (cur?.ble_token && Number.isFinite(cur.ble_token_until_ms) && cur.ble_token_until_ms > untilMs) fields.ble_token_until_ms = untilMs;
    presence = store.setPresence(me.profile_id, fields);
    // The conference's cached token table learns the new session at once.
    if (session?.fields.presence_nonce) addSession(store, bleConfig(ctx.env), derivedSession(me), now);
  }
  // The position, in memory only. A write without a usable position clears the previous one, so
  // the presence is zone-only again; so does a fix that jumped implausibly far since the last one
  // (no error: the zone still counts).
  const prev = cur?.location ?? null;
  const fix = location && !implausibleJump(prev, location, now) ? { ...location, at: now } : null;
  store.setLocation(me.profile_id, fix);

  const res = json(200, {
    ok: true,
    zone,
    spot: storedSpot,
    spot_hidden: me.spot_hidden,
    until: mode,
    presence_since: iso(presence.since_ms),
    presence_until: iso(presence.until_ms),
    located: fix !== null,
    ...(session ? session.view : {}),
  });
  // After the answer: the push nudge for strong matches in this zone (it never throws).
  if (changed) ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 0)).then(() => afterPresence(ctx, me)));
  return res;
}

// Turning presence off. The person that authenticate returns was read before its await on the
// secret check, and the people cache can be dropped and a presence written in that gap (a talks
// finalize and a PUT /api/presence), so the copy may say there is no presence when there is one.
// The delete therefore never looks at it: clearPresence deletes the row, when there is one, and
// forgets the position either way, as tier 3's delete does.
async function deletePresence(ctx, req) {
  const device = writer(ctx, req);
  const me = await ctx.store.authenticate(device);
  if (me) {
    ctx.store.clearPresence(me.profile_id);
    // A meet that was active ends when either presence ends.
    closeActiveMeetsOf(ctx, me.profile_id);
  }
  return json(200, { ok: true });
}

async function rotate(ctx, req) {
  const device = writer(ctx, req);
  await readJson(req, ROTATE_KEYS);
  const me = await visibleProfile(ctx, device);
  if (!ctx.store.isAround(me)) throw new HttpError(403, { error: 'presence_required' });
  // A new legacy token; a derived session is left as it was. Only the old Android app calls this
  // route, so a rotated token marks a session of an old app (sightings answers it under a retired
  // master instead of asking it to re-key, as server/ble.mjs does).
  const fields = mintBleToken(Date.now(), me.presence.until_ms);
  ctx.store.setPresence(me.profile_id, { ...fields, ble_rotated: true });
  return json(200, { ok: true, ble: bleView(fields) });
}

const FAIL = 'People are temporarily unavailable';

export default [
  { method: 'PUT', path: '/api/presence', bucket: 'write', fail: FAIL, handler: putPresence },
  { method: 'DELETE', path: '/api/presence', bucket: 'write', fail: FAIL, handler: deletePresence },
  { method: 'POST', path: '/api/presence/ble/rotate', bucket: 'write', fail: FAIL, handler: rotate },
];
