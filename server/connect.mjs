// Find & connect: blocks, "I'm around" presence and ask-to-talk-shop meets.
//
//   POST|DELETE /api/people/block        GET /api/people/blocks?event=
//   PUT|DELETE  /api/presence
//   POST /api/meet                       GET /api/meet/inbox?event=
//   GET  /api/meet/{id}                  PUT /api/meet/{id}/details
//   POST /api/meet/{id}/accept | decline | found | cancel
//
// Env: as people.mjs; ES_PEOPLE_BLOCKS_INDEX (default caddie-people-blocks) and
// ES_PEOPLE_MEETS_INDEX (default caddie-people-meets) hold blocks and meets.
//
// Rules this module keeps:
// - Every route needs the device header and a live profile of the requester at that conference.
//   A meet is read or changed only by its two participants; everyone else gets 403.
// - A block is symmetric and silent: both people vanish from each other's matches, circles and
//   meets, and a meet attempt in either direction gets the same 403 { error: "blocked" }. It lasts
//   until the blocker lifts it, deletes their own profile, or the conference ends (expires_at,
//   which the purge honours); the blocked person deleting and re-creating their profile does not
//   lift it.
// - Presence lives on the people document and is written with a Bulk partial update of its own
//   fields only, so it never re-runs the embedding model. It ends 60 minutes after it was turned
//   on, or with until: 'day' at the end of the conference day, at the latest at the end of the
//   conference. until: 'keep' keeps the stored end, so a write that only changes Bluetooth (or the
//   zone, spot or position) never makes someone visible for longer than they chose; it needs live
//   presence (400 presence_not_active otherwise) and never starts it.
// - A position is optional: rounded to 5 decimals, dropped when its accuracy is worse than 200 m,
//   dropped too when it implies the device moved faster than 7 m/s since its previous fix of the
//   last ten minutes, cleared with presence. It is stored with the centre of its ~100 m cell
//   (presence_cell) and the time of the fix. It is never returned. Its cell ranks nearby people
//   higher and becomes a band on a result (people.mjs); only an active meet turns the precise fix
//   into a distance rounded to 10 m and a bearing, for its two participants, through
//   GET /api/meet/{id} and nowhere else.
// - A person's zone and spot reach another person only inside an active meet, which exists only
//   while both are around; a how-to-spot-me line reaches only the other participant, only while
//   the meet is active. Search results carry a zone only when both people are around (people.mjs).
// - Asks are now-only: you can ask only someone who is around, and only while you are around
//   yourself; the ask runs out 15 minutes after it was made; accept means now, so it moves the
//   meet straight to active (20 minutes). Nothing is booked for later. The legacy state
//   "accepted" is never written; a document still carrying it reads as expired.
// - "Not now" is silent: the requester keeps seeing "requested" until the request runs out, with
//   the same note, meeting point, own spot-me line and same-zone view as before, and can still
//   save their own details or cancel. Three "Not now" replies in one day pause the requester
//   until the next day. When a meet ends, only participants, topic, state and times are kept; a
//   declined meet keeps the requester's view until it runs out, and the purge scrubs it then.
// - Spot lines, notes and spot-me lines pass the filter in moderation.mjs (rules, then the
//   classifier). A rejected line is 400 filtered; a held line is stored with a *_pending flag,
//   shown only to its author, answered with `held` on the 200 and reported as 'classifier'.
// - After a presence write has been answered, nudge.mjs runs the push rule for that person.
// - Nothing from a request body, header or document is logged.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import { refFor } from './device.mjs';
import { moderate, HELD } from './moderation.mjs';
import { classifierReport } from './report.mjs';
import { nudgeAfterPresence } from './nudge.mjs';
import { mintBleSession, BLE_OFF } from './ble.mjs';
import { peoplePreference, withPreference } from './preference.mjs';
import {
  people, idx, docId, BLOCKS_INDEX, MEETS_INDEX, LIMITS, REF_RE,
  HttpError, UpstreamError, bad, forbidden, sendJson, limit, jsonBody, requireDevice, text,
  conferenceFor, dayBounds, topicLabels, zonesFor, authenticated, updateOwnProfile, bulkOne, isAround, PRESENCE_OFF,
  peopleByIds, docByRef, personByRef, blockedIds, blockedBetween, blockId, dispatch, deleteWhere,
  locationOf, cellFor, distanceM, bearingDeg, reembedPending,
} from './people.mjs';

const PRESENCE_MS = 60 * 60_000;
const ACTIVE_MS = 20 * 60_000;
const REQUEST_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const SPOT_MAX = 60;
const ACCURACY_MAX_M = 200;
const COORD_DECIMALS = 5;
// A new fix is checked against the previous one while that is younger than this ...
const JUMP_WINDOW_MS = 10 * 60_000;
// ... and dropped when it implies a faster move than this: a brisk run, never walking in a hall.
const JUMP_MAX_MPS = 7;
const DISTANCE_STEP_M = 10;
const PRESENCE_OFF_RETRIES = 3;
const NOTE_MAX = 140;
const MEET_REQUESTS_PER_HOUR = 10;
const DECLINES_PER_DAY = 3;
const INBOX_SIZE = 100;
const BLOCKS_SIZE = 1000;
// "accepted" (a request accepted for later) is no longer a state: asks are now-only.
const OPEN_STATES = ['requested', 'active'];
const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MEET_PATH_RE = /^\/api\/meet\/([A-Za-z0-9_-]{22})(?:\/(accept|decline|found|cancel|details))?$/;

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });
const blocked = () => new HttpError(403, { error: 'blocked' });
const notFound = () => new HttpError(404, { error: 'not_found' });
const presenceRequired = () => new HttpError(403, { error: 'presence_required', message: "Turn on 'Around and up for a conversation' first." });
const presenceNotActive = () => new HttpError(400, { error: 'presence_not_active', message: "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." });
const notAround = () => new HttpError(409, { error: 'not_around', message: "They're not around right now." });

// The write and read rate limits of people.mjs, so the buckets are shared. Each returns the device.
// The inbox and meet polls run in the background on every device that is around, and attendees
// often share one venue Wi-Fi address, so they have their own buckets: a large per-address one
// and a per-device one. Searches, circles and blocks keep the shared read buckets.
function writer(req) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  return device;
}
function reader(req) {
  limit(`people-read:ip:${clientIp(req)}`, LIMITS.readIp);
  const device = requireDevice(req);
  limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);
  return device;
}
function poller(req) {
  limit(`people-poll:ip:${clientIp(req)}`, LIMITS.pollIp);
  const device = requireDevice(req);
  limit(`people-poll:dev:${device.profileId}`, LIMITS.pollDevice);
  return device;
}

// A short line other people will read: trimmed, capped, and passed through the filter.
// Returns { text, pending }: text is null for an empty line; pending is true when the classifier
// held it (the line is then stored but shown only to its author until it is cleared).
async function line(value, name, max) {
  const t = text(value, name, max);
  if (!t) return { text: null, pending: false };
  const verdict = await moderate(t);
  if (verdict.outcome === 'reject') throw new HttpError(400, verdict.body);
  return { text: t, pending: verdict.outcome === 'hold' };
}
// The extra key on a 200 response when a field was held. Old clients ignore it.
const heldInfo = (fields) => (fields.length ? { held: { fields, message: HELD.message } } : {});

function refOf(body) {
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a result reference');
  return body.ref;
}

function eventOf(url) {
  const slug = url.searchParams.get('event');
  if (typeof slug !== 'string') throw bad('event must be a conference slug');
  return slug;
}

// The requester's live profile at the conference, else 403 profile_required.
async function requireProfile(device, slug) {
  const me = await authenticated(device, slug);
  if (!me) throw profileRequired();
  return me;
}

// ---------------------------------------------------------------------------------------------
// Meets: documents and transitions.

async function loadMeet(id) {
  const { status, json } = await people('GET', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
  if (status === 404 || !json.found) return null;
  const source = json._source ?? {};
  // A document from before asks were now-only: tolerated on read, never written again.
  if (source.state === 'accepted') source.state = 'expired';
  return { source, seqNo: json._seq_no, primaryTerm: json._primary_term };
}

// Writes a meet back, guarded by the sequence number it was read with.
async function saveMeet(meet) {
  const s = meet.source;
  const { status } = await people(
    'PUT',
    `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(s.meet_id)}?if_seq_no=${meet.seqNo}&if_primary_term=${meet.primaryTerm}&refresh=wait_for`,
    s,
    { okStatuses: [409] },
  );
  if (status === 409) throw new HttpError(409, { error: 'The meet changed at the same time; try again' });
}

// Closes a meet. Afterwards only participants, topic, state and times remain.
function endMeet(s, state, nowMs) {
  s.state = state;
  s.ended_at = iso(nowMs);
  s.note = null;
  s.rendezvous = null;
  s.spot_me = {};
  s.spot_me_pending = {};
  s.note_pending = false;
}

// "Not now" is silent, so a decline keeps what the requester sees until the ask runs out: the
// note, the meeting point, the requester's own spot-me line and same_zone. The decliner's own
// spot-me line is dropped, since the requester never sees it before a meet is active. The purge
// scrubs the kept fields once expires_at has passed.
function declineMeet(s, nowMs) {
  const requesterSpot = s.spot_me?.[s.requester_id];
  s.state = 'declined';
  s.ended_at = iso(nowMs);
  const requesterPending = s.spot_me_pending?.[s.requester_id] === true;
  s.spot_me = requesterSpot ? { [s.requester_id]: requesterSpot } : {};
  s.spot_me_pending = requesterSpot && requesterPending ? { [s.requester_id]: true } : {};
}

// True when me asked, the other person silently declined, the ask has not run out and the
// requester has not cancelled it. The requester then still sees and may change their ask.
function silentlyDeclined(s, me) {
  return s.state === 'declined' && s.requester_id === me.profile_id && s.requester_cancelled !== true && Date.parse(s.expires_at) > Date.now();
}

// Accept means now: both are around, and the meet runs for 20 minutes from this moment. In the
// same zone the shared zone is the meeting point unless someone set another.
function activate(s, me, other, nowMs) {
  s.state = 'active';
  s.active_since = iso(nowMs);
  s.expires_at = iso(nowMs + ACTIVE_MS);
  s.same_zone = sameZone(me, other);
  if (s.same_zone && !s.rendezvous) s.rendezvous = me.presence_zone;
}

// Around, for a meet: live presence on a profile that is visible conference-wide. Presence needs
// that visibility and is cleared with it, so this differs from isAround only for a document a
// presence write reached after a delete hid it, and such a person counts as not around.
const present = (p) => Boolean(p) && p.open_to_meet === true && isAround(p);
const bothAround = (me, other) => present(me) && present(other);
const sameZone = (me, other) => bothAround(me, other) && typeof me.presence_zone === 'string' && me.presence_zone === other.presence_zone;

// Closes every open meet that matches the filters, in the state endState(source) gives. _bulk
// answers 200 even when an item fails, so each item's result is checked: a meet that someone else
// changed in the meantime (a version conflict) is read again and closed from its new state.
async function closeMeets(slug, filters, endState) {
  const { json } = await people('POST', withPreference(`${idx(MEETS_INDEX)}/_search?ignore_unavailable=true&seq_no_primary_term=true`, peoplePreference(slug)), {
    size: INBOX_SIZE,
    query: { bool: { filter: [{ term: { event_id: slug } }, { terms: { state: OPEN_STATES } }, ...filters] } },
  });
  const hits = json.hits?.hits ?? [];
  if (!hits.length) return;
  const now = Date.now();
  const body = hits.map((h) => {
    const s = h._source ?? {};
    endMeet(s, endState(s), now);
    return `${JSON.stringify({ index: { _id: h._id, if_seq_no: h._seq_no, if_primary_term: h._primary_term } })}\n${JSON.stringify(s)}\n`;
  }).join('');
  const { json: result } = await people('POST', `${idx(MEETS_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
  const conflicts = [];
  for (const item of result.items ?? []) {
    const r = item.index ?? {};
    if (r.status === 409) conflicts.push(r._id);
    else if (!(r.status >= 200 && r.status <= 299)) throw new UpstreamError(`bulk item status ${r.status}`);
  }
  await Promise.all(conflicts.map((id) => closeMeet(id, endState)));
}

const CLOSE_ATTEMPTS = 5;

// Closes one meet by id, reading it again after each version conflict, until it is closed or no
// longer open.
async function closeMeet(id, endState) {
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt++) {
    const meet = await loadMeet(id);
    if (!meet || !OPEN_STATES.includes(meet.source.state)) return;
    endMeet(meet.source, endState(meet.source), Date.now());
    try {
      await saveMeet(meet);
      return;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
  throw new UpstreamError('a meet kept changing while it was being closed');
}

// The state one participant sees. An open meet past expires_at reads "expired" even before a
// read has written that. "Not now" is silent, so the requester of a declined meet sees
// "requested" until it runs out, and "expired" afterwards; once they cancel it, "cancelled".
function stateFor(s, me) {
  const ranOut = Date.parse(s.expires_at) <= Date.now();
  if (OPEN_STATES.includes(s.state)) return ranOut ? 'expired' : s.state;
  if (s.state !== 'declined' || s.requester_id !== me.profile_id) return s.state;
  if (s.requester_cancelled === true) return 'cancelled';
  return ranOut ? 'expired' : 'requested';
}

const over = (s, me) => new HttpError(410, { error: 'over', state: stateFor(s, me) });

// What a participant may see of a meet. The other person's zone and spot appear only while the
// meet is active (so while both are around), their spot-me line only then as well. A same-zone
// ask also carries the zone while it waits: both are around and it is the reader's own zone. The
// requester of a silently declined ask sees it exactly as a waiting ask, zone included. With
// withDistance (the meet read only, never the inbox or an action), an active meet between two
// people who both have a position adds the distance (to 10 m) and the bearing from me to them;
// otherwise neither key is present. No coordinate ever leaves here.
function meetView(s, me, other, labels, { withDistance = false } = {}) {
  const state = stateFor(s, me);
  const active = s.state === 'active';
  const otherId = (s.participants ?? []).find((p) => p !== me.profile_id) ?? null;
  const topic = s.topic_id && labels.has(s.topic_id) ? { topic_id: s.topic_id, label: labels.get(s.topic_id) } : null;
  const together = bothAround(me, other);
  const showZone = together && (active || (state === 'requested' && s.same_zone === true && sameZone(me, other)));
  const position = {};
  if (withDistance && active && other) {
    const a = locationOf(me);
    const b = locationOf(other);
    if (a && b) {
      position.distance_m = Math.round(distanceM(a, b) / DISTANCE_STEP_M) * DISTANCE_STEP_M;
      position.bearing_deg = Math.round(bearingDeg(a, b)) % 360;
    }
  }
  return {
    meet_id: s.meet_id,
    state,
    requested_by_me: s.requester_id === me.profile_id,
    same_zone: s.same_zone === true,
    topic,
    topic_label: topic?.label ?? null,
    // A held note reaches only its author until the filter clears it.
    note: s.note_pending === true && s.requester_id !== me.profile_id ? '' : s.note ?? null,
    created_at: s.created_at ?? null,
    active_since: s.active_since ?? null,
    active_until: active ? s.expires_at ?? null : null,
    expires_at: s.expires_at ?? null,
    rendezvous: s.rendezvous ?? null,
    mine: { spot_me: s.spot_me?.[me.profile_id] ?? null, around: present(me) },
    other: {
      ref: otherId ? refFor(s.event_id, otherId) : null,
      display_name: other?.display_name ?? '',
      about: other?.about ?? '',
      around: present(other),
      zone: showZone ? other.presence_zone ?? null : null,
      spot: active && together && other.presence_spot_pending !== true ? other.presence_spot ?? null : null,
      spot_me: active && together && otherId && s.spot_me_pending?.[otherId] !== true ? s.spot_me?.[otherId] ?? null : null,
      ...position,
    },
  };
}

// Loads a meet for one of its participants: 404 when there is none, 403 for anyone else. A pair
// with a block in either direction gets the same 403 { error: "blocked" } as an ask between them,
// whatever state the meet document is in, so a meet a block failed to close reveals nothing.
async function participantMeet(device, id) {
  const meet = await loadMeet(id);
  if (!meet) throw notFound();
  const s = meet.source;
  const me = await authenticated(device, s.event_id);
  if (!me || !(s.participants ?? []).includes(me.profile_id)) throw forbidden();
  // A meet hidden after reports exists only for the reported participant.
  if (s.hidden === true && s.hidden_owner_id !== me.profile_id) throw notFound();
  const otherId = s.participants.find((p) => p !== me.profile_id);
  if (await blockedBetween(s.event_id, me.profile_id, otherId)) throw blocked();
  const [other, labels] = await Promise.all([peopleByIds(s.event_id, [otherId]).then((m) => m.get(otherId) ?? null), topicLabels(s.event_id)]);
  return { meet, me, other, labels };
}

// A transition needs an open meet that has not run out, in one of the allowed states.
function expectState(s, me, allowed) {
  if (!OPEN_STATES.includes(s.state) || Date.parse(s.expires_at) <= Date.now()) throw over(s, me);
  if (!allowed.includes(s.state)) throw new HttpError(409, { error: 'state', state: s.state });
}

// Actions carry an empty JSON object, or no body at all.
async function emptyBody(req) {
  if (req.headers['content-length'] && req.headers['content-length'] !== '0') await jsonBody(req, new Set());
}

// ---------------------------------------------------------------------------------------------
// Blocks.

const BLOCK_KEYS = new Set(['event', 'ref']);

// When the purge may delete a block: the latest of the conference's end and the visible_until of
// the two profiles, so a block never runs out while either of them can still be found. A later end
// date set after the block was written reaches the block only when it is written again (blocking
// the same person again rewrites it); until then the block runs out at the end it was written
// with.
function blockExpiry(conf, me, them) {
  const ends = [conf.visibleUntil, me.visible_until, them.visible_until].filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return ends.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

async function block(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, BLOCK_KEYS);
  const ref = refOf(body);
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  const them = await docByRef(conf.slug, ref);
  if (!them || them.profile_id === me.profile_id) throw notFound();
  await people('PUT', `${idx(BLOCKS_INDEX)}/_doc/${encodeURIComponent(blockId(conf.slug, me.profile_id, them.profile_id))}?refresh=wait_for`, {
    event_id: conf.slug,
    blocker_id: me.profile_id,
    blocked_id: them.profile_id,
    blocked_ref: ref,
    created_at: iso(Date.now()),
    expires_at: blockExpiry(conf, me, them),
  });
  // An open meet between the two ends: silently when the blocker was asked, as a cancellation
  // when the blocker asked.
  await closeMeets(conf.slug, [{ term: { participants: me.profile_id } }, { term: { participants: them.profile_id } }],
    (s) => (s.requester_id === me.profile_id ? 'cancelled' : 'declined'));
  sendJson(res, 200, { ok: true });
}

async function unblock(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, BLOCK_KEYS);
  const ref = refOf(body);
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  // By the stored ref, so a block can be lifted after the blocked person deleted their profile.
  await deleteWhere(BLOCKS_INDEX, conf.slug, { bool: { filter: [{ term: { event_id: conf.slug } }, { term: { blocker_id: me.profile_id } }, { term: { blocked_ref: ref } }] } });
  sendJson(res, 200, { ok: true });
}

async function blocks(req, res, url) {
  const device = reader(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await requireProfile(device, conf.slug);
  const { json } = await people('POST', withPreference(`${idx(BLOCKS_INDEX)}/_search?ignore_unavailable=true`, peoplePreference(conf.slug)), {
    size: BLOCKS_SIZE,
    _source: ['blocked_id', 'blocked_ref', 'created_at'],
    sort: [{ created_at: 'desc' }],
    query: { bool: { filter: [{ term: { event_id: conf.slug } }, { term: { blocker_id: me.profile_id } }] } },
  });
  const rows = (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((s) => s.blocked_ref);
  // A block outlives the blocked profile; once that profile is gone or being deleted, its row
  // keeps the ref (so it can still be lifted) with display_name null.
  const docs = await peopleByIds(conf.slug, rows.map((s) => s.blocked_id));
  sendJson(res, 200, {
    refs: rows.map((s) => s.blocked_ref),
    blocks: rows.map((s) => ({ ref: s.blocked_ref, display_name: docs.get(s.blocked_id)?.display_name ?? null, created_at: s.created_at ?? null })),
  });
}

// ---------------------------------------------------------------------------------------------
// Presence.

const PRESENCE_KEYS = new Set(['event', 'zone', 'spot', 'location', 'until', 'ble']);
// 'keep' keeps the stored presence_until; it never starts presence (putPresence).
const PRESENCE_MODES = new Set(['hour', 'day', 'keep']);
const LOCATION_KEYS = new Set(['lat', 'lon', 'accuracy']);

const NO_POSITION = { presence_location: null, presence_accuracy: null, presence_cell: null, presence_located_at: null };

// The optional position of a presence write: { lat, lon, accuracy } with accuracy in metres.
// Returns { presence_location: { lat, lon }, presence_accuracy } rounded to 5 decimals and whole
// metres, or the two fields as null when there is no position or it is worse than 200 m, in
// which case the presence is zone-only. A malformed location is 400.
function locationFields(value) {
  const none = { presence_location: null, presence_accuracy: null };
  if (value === undefined || value === null) return none;
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('location must be an object or null');
  for (const k of Object.keys(value)) if (!LOCATION_KEYS.has(k)) throw bad(`Unknown key: location.${k.slice(0, 40)}`);
  const { lat, lon, accuracy } = value;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) throw bad('location.lat must be a latitude');
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) throw bad('location.lon must be a longitude');
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) throw bad('location.accuracy must be metres');
  if (accuracy > ACCURACY_MAX_M) return none;
  const round = (v) => Number(v.toFixed(COORD_DECIMALS));
  return { presence_location: { lat: round(lat), lon: round(lon) }, presence_accuracy: Math.round(accuracy) };
}

// True when a new fix implies the device moved faster than JUMP_MAX_MPS since its previous stored
// fix, and that fix is younger than JUMP_WINDOW_MS. Such a fix is not stored: a phone cannot jump
// across a venue, and a client that claims to is probing. (The bands do not depend on this:
// people.mjs computes them from cells only.) Writes less than a second apart count as a second.
function implausibleJump(me, next, nowMs) {
  const prev = locationOf(me);
  const at = Date.parse(me.presence_located_at);
  if (!prev || !Number.isFinite(at) || nowMs - at >= JUMP_WINDOW_MS) return false;
  return distanceM(prev, next) / Math.max(1, (nowMs - at) / 1000) > JUMP_MAX_MPS;
}

// The position fields a presence write stores: the fix, its accuracy, its cell and its time, or
// all four null for a zone-only presence.
function positionFields(location, me, nowMs) {
  const fix = location.presence_location;
  if (!fix || implausibleJump(me, fix, nowMs)) return NO_POSITION;
  return { ...location, presence_cell: cellFor(fix), presence_located_at: iso(nowMs) };
}

async function putPresence(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, PRESENCE_KEYS);
  if (typeof body.zone !== 'string') throw bad('zone must be a string');
  const zone = body.zone.trim();
  const { text: spot, pending: spotPending } = await line(body.spot, 'spot', SPOT_MAX);
  const location = locationFields(body.location);
  const mode = body.until === undefined || body.until === null ? 'hour' : body.until;
  if (!PRESENCE_MODES.has(mode)) throw bad("until must be 'hour', 'day' or 'keep'");
  if (body.ble !== undefined && typeof body.ble !== 'boolean') throw bad('ble must be a boolean');
  const conf = await conferenceFor(body.event);
  // Guarded by the sequence number of the profile read (updateOwnProfile), so a presence write
  // that read the profile just before a delete hid it cannot bring presence back on the hidden
  // document: the write conflicts, the profile is read again and is no longer there.
  const { me, presence, position, bleAnswer, held, storedSpot, since } = await updateOwnProfile(device, conf.slug, async (me) => {
    if (!me || me.open_to_meet !== true) throw profileRequired();
    if (!(await zonesFor(conf.slug)).has(zone)) throw bad("zone must be one of the conference's zones");
    const now = Date.now();
    // 'hour' runs out in 60 minutes; 'day' at the end of the conference day (its time zone), when
    // the client's zone confirmation does the safeguarding instead. 'keep' writes back the end this
    // read found and is refused when there is none or it has passed, so it never starts presence.
    // The write is guarded by this read's sequence number: when a delete, the purge or another
    // write changed the document in between, it is read and judged again, so 'keep' cannot bring
    // back an end that is gone. Never past visible_until.
    const storedUntilMs = typeof me.presence_until === 'string' ? Date.parse(me.presence_until) : NaN;
    const live = storedUntilMs > now;
    if (mode === 'keep' && !live) throw presenceNotActive();
    const span = mode === 'keep' ? storedUntilMs : mode === 'day' ? dayBounds(now, conf.timeZone).end : now + PRESENCE_MS;
    const untilMs = Math.min(span, Date.parse(conf.visibleUntil));
    if (untilMs <= now) throw bad('conference has ended');
    // Turning it on again while it is on extends it ('hour', 'day'); since keeps the first time.
    const since = live && typeof me.presence_since === 'string' ? me.presence_since : iso(now);
    // A spot line hidden after reports stays off until the operator unhides it.
    const storedSpot = me.spot_hidden === true ? null : spot;
    // A write without a usable position clears any stored one, so the presence is zone-only again;
    // so does a fix that jumped implausibly far since the last one (no error: the zone still counts).
    const held = Boolean(storedSpot) && spotPending;
    const position = positionFields(location, me, now);
    // 'keep' writes the stored string back as it was unless visible_until cut it short.
    const presenceUntil = mode === 'keep' && untilMs === storedUntilMs ? me.presence_until : iso(untilMs);
    const presence = { presence_zone: zone, presence_spot: storedSpot, presence_spot_pending: held, presence_since: since, presence_until: presenceUntil, ...position };
    // Bluetooth (ble.mjs): ble: true starts a new session in the same bulk update as the presence
    // (a legacy ten-minute token, and with the master keyring a fresh nonce whose key goes back in
    // this response only); ble: false ends it. A write that says nothing leaves a live session as
    // it was, except that one starting a new presence session clears whatever an ended one left,
    // because one nonce is one presence session.
    const session = body.ble === true ? mintBleSession(me.profile_id, now, untilMs) : null;
    const ble = session ? session.fields : body.ble === false || !live ? BLE_OFF : {};
    return { doc: { ...presence, ...ble }, presence, position, bleAnswer: session?.view ?? {}, held, storedSpot, since };
  });
  if (held) await classifierReport(conf.slug, 'spot', refFor(conf.slug, me.profile_id), me.profile_id);
  // A profile save that could not embed its text kept it in the pending fields (people.mjs); the
  // owner's next presence write embeds it once that works again. It never fails the presence.
  if (me.text_pending === true) {
    try {
      await reembedPending(conf.slug, me.profile_id);
    } catch (err) {
      console.error(`Embedding pending profile text failed: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'error')}`);
    }
  }
  sendJson(res, 200, { ok: true, zone, spot: storedSpot, spot_hidden: me.spot_hidden === true, until: mode, presence_since: since, presence_until: presence.presence_until, located: position.presence_location !== null, ...bleAnswer, ...heldInfo(held ? ['spot'] : []) });
  // After the answer: the push nudge for strong matches in this zone (nudge.mjs never throws).
  void nudgeAfterPresence({ ...me, ...presence }, conf);
}

async function deletePresence(req, res, url) {
  const device = writer(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await authenticated(device, conf.slug);
  if (me) {
    // Unguarded on purpose (it only clears); a concurrent write is retried by Elasticsearch.
    const status = await bulkOne({ update: { _id: docId(conf.slug, me.profile_id), retry_on_conflict: PRESENCE_OFF_RETRIES } }, { doc: PRESENCE_OFF });
    if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
    // A meet that was active ends when either presence ends.
    await closeMeets(conf.slug, [{ term: { participants: me.profile_id } }, { term: { state: 'active' } }], () => 'expired');
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------------------------
// Meets.

const MEET_KEYS = new Set(['event', 'ref', 'topic_id', 'note']);
const DETAILS_KEYS = new Set(['spot_me', 'rendezvous']);

async function requestMeet(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, MEET_KEYS);
  const ref = refOf(body);
  const topicId = body.topic_id === undefined || body.topic_id === null ? null : body.topic_id;
  if (topicId !== null && (typeof topicId !== 'string' || !TOPIC_ID_RE.test(topicId))) throw bad('topic_id must be a topic id or null');
  const { text: noteText, pending: notePending } = await line(body.note, 'note', NOTE_MAX);
  const note = noteText ?? '';
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  // A profile hidden after reports must not surface in anyone's inbox.
  if (me.hidden === true) throw new HttpError(403, { error: 'hidden' });
  limit(`meet-request:dev:${me.profile_id}`, MEET_REQUESTS_PER_HOUR, HOUR_MS);

  const them = await personByRef(me, ref);
  if (!them) throw notFound();
  if (await blockedBetween(conf.slug, me.profile_id, them.profile_id)) throw blocked();
  // Now-only: both must be around. A match who is not around is watched on the device, not booked.
  if (!present(me)) throw presenceRequired();
  if (!present(them)) throw notAround();

  const now = Date.now();
  const day = dayBounds(now, conf.timeZone);
  const declined = await people('POST', withPreference(`${idx(MEETS_INDEX)}/_count?ignore_unavailable=true`, peoplePreference(conf.slug)), {
    query: {
      bool: {
        filter: [{ term: { event_id: conf.slug } }, { term: { requester_id: me.profile_id } }, { term: { state: 'declined' } }, { range: { ended_at: { gte: iso(day.start) } } }],
      },
    },
  });
  if ((declined.json.count ?? 0) >= DECLINES_PER_DAY) {
    throw new HttpError(429, { error: 'paused', message: 'Three people said not now today. You can ask again tomorrow.', retry_at: iso(day.end) }, { 'Retry-After': String(Math.max(1, Math.ceil((day.end - now) / 1000))) });
  }

  // "Not now" is silent: the requester of a declined ask still sees it as waiting until it runs out
  // or they cancel it (silentlyDeclined), so asking again answers the same 409 meet_open as a
  // pending ask and notifies nobody. requester_cancelled is not in the mapping, so that flag is
  // checked on the returned documents.
  const existing = await people('POST', withPreference(`${idx(MEETS_INDEX)}/_search?ignore_unavailable=true`, peoplePreference(conf.slug)), {
    size: 10,
    _source: ['meet_id', 'state', 'requester_id', 'requester_cancelled', 'expires_at'],
    query: {
      bool: {
        filter: [{ term: { event_id: conf.slug } }, { term: { participants: me.profile_id } }, { term: { participants: them.profile_id } }, { range: { expires_at: { gt: 'now' } } }],
        should: [
          { terms: { state: OPEN_STATES } },
          { bool: { filter: [{ term: { state: 'declined' } }, { term: { requester_id: me.profile_id } }] } },
        ],
        minimum_should_match: 1,
      },
    },
  });
  const openId = (existing.json.hits?.hits ?? [])
    .map((h) => h._source ?? {})
    .find((m) => OPEN_STATES.includes(m.state) || silentlyDeclined(m, me))?.meet_id;
  if (openId) throw new HttpError(409, { error: 'meet_open', meet_id: openId });

  const labels = await topicLabels(conf.slug);
  if (topicId !== null && !labels.has(topicId)) throw bad('topic_id is not a topic of this conference');
  // The ask runs out in 15 minutes: an answer later than that would be a booking.
  const expiresMs = Math.min(now + REQUEST_MS, Date.parse(conf.visibleUntil));
  if (expiresMs <= now) throw bad('conference has ended');

  const s = {
    event_id: conf.slug,
    meet_id: crypto.randomBytes(16).toString('base64url'),
    participants: [me.profile_id, them.profile_id],
    requester_id: me.profile_id,
    topic_id: topicId,
    note,
    note_pending: notePending,
    rendezvous: null,
    spot_me: {},
    spot_me_pending: {},
    state: 'requested',
    same_zone: sameZone(me, them),
    created_at: iso(now),
    active_since: null,
    expires_at: iso(expiresMs),
    ended_at: null,
  };
  const { status } = await people('PUT', `${idx(MEETS_INDEX)}/_create/${encodeURIComponent(s.meet_id)}?refresh=wait_for`, s, { okStatuses: [409] });
  if (status === 409) throw new UpstreamError('meet id collision');
  if (notePending) await classifierReport(conf.slug, 'meet', s.meet_id, me.profile_id);
  sendJson(res, 200, { ok: true, ...meetView(s, me, them, labels), ...heldInfo(notePending ? ['note'] : []) });
}

async function inbox(req, res, url) {
  const device = poller(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await requireProfile(device, conf.slug);
  const [hidden, labels, { json }] = await Promise.all([
    blockedIds(conf.slug, me.profile_id),
    topicLabels(conf.slug),
    people('POST', withPreference(`${idx(MEETS_INDEX)}/_search?ignore_unavailable=true&seq_no_primary_term=true`, peoplePreference(conf.slug)), {
      size: INBOX_SIZE,
      sort: [{ created_at: 'desc' }],
      query: {
        bool: {
          filter: [{ term: { event_id: conf.slug } }, { term: { participants: me.profile_id } }, { range: { expires_at: { gt: 'now' } } }],
          should: [
            { terms: { state: OPEN_STATES } },
            { bool: { filter: [{ term: { state: 'declined' } }, { term: { requester_id: me.profile_id } }] } },
          ],
          minimum_should_match: 1,
        },
      },
    }),
  ]);
  const meets = (json.hits?.hits ?? [])
    .map((h) => ({ source: h._source ?? {}, seqNo: h._seq_no, primaryTerm: h._primary_term }))
    .filter((m) => Array.isArray(m.source.participants));
  const otherIds = meets.map((m) => m.source.participants.find((p) => p !== me.profile_id));
  const others = await peopleByIds(conf.slug, otherIds);
  const now = Date.now();
  const incoming = [];
  const outgoing = [];
  const ended = [];
  for (const meet of meets) {
    const s = meet.source;
    const otherId = s.participants.find((p) => p !== me.profile_id);
    const other = others.get(otherId);
    // A meet hidden after reports reaches only the reported participant; a profile hidden after
    // reports is treated like a missing document, as is one being deleted (peopleByIds leaves
    // those out).
    if (s.hidden === true && s.hidden_owner_id !== me.profile_id) continue;
    if (!other || other.hidden === true || hidden.has(otherId)) continue;
    // The transitions getMeet applies: an active meet with either presence gone is over, so its
    // card, with the zone, spot and spot-me lines, is left out.
    if (s.state === 'active' && (Date.parse(s.expires_at) <= now || !bothAround(me, other))) {
      endMeet(s, 'expired', now);
      ended.push(meet);
      continue;
    }
    const view = meetView(s, me, other, labels);
    // A silently declined ask the requester has cancelled is over for them.
    if (!OPEN_STATES.includes(view.state)) continue;
    if (s.requester_id === me.profile_id) outgoing.push({ ...view, to: { ref: view.other.ref, display_name: other.display_name ?? '' } });
    else incoming.push({ ...view, from: { ref: view.other.ref, display_name: other.display_name ?? '', about: other.about ?? '' } });
  }
  // Written back as getMeet does; a meet the other participant changed first keeps that change.
  await Promise.all(ended.map((m) => saveMeet(m).catch((err) => {
    if (!(err instanceof HttpError && err.status === 409)) throw err;
  })));
  sendJson(res, 200, { incoming, outgoing });
}

async function getMeet(req, res, id) {
  const device = poller(req);
  const { meet, me, other, labels } = await participantMeet(device, id);
  let s = meet.source;
  const now = Date.now();
  // The transitions that time or presence cause are applied when the meet is read: an ask or an
  // active meet past expires_at, or an active meet with either presence gone, is over.
  if (OPEN_STATES.includes(s.state)) {
    if (Date.parse(s.expires_at) <= now || (s.state === 'active' && !bothAround(me, other))) {
      endMeet(s, 'expired', now);
      try {
        await saveMeet(meet);
      } catch (err) {
        // The other participant's poll applied a change first; this read shows the stored state.
        if (!(err instanceof HttpError && err.status === 409)) throw err;
        const again = await loadMeet(id);
        if (!again) throw notFound();
        s = again.source;
      }
    }
  }
  if (!OPEN_STATES.includes(stateFor(s, me))) throw over(s, me);
  sendJson(res, 200, meetView(s, me, other, labels, { withDistance: true }));
}

async function action(req, res, id, name) {
  const device = writer(req);
  await emptyBody(req);
  const { meet, me, other, labels } = await participantMeet(device, id);
  const s = meet.source;
  const now = Date.now();
  if (name === 'accept' || name === 'decline') {
    if (s.requester_id === me.profile_id) throw forbidden();
    expectState(s, me, ['requested']);
    if (name === 'accept') {
      // Accept means now. The one accepting must be around; if the asker has meanwhile left,
      // the ask is over.
      if (!present(me)) throw presenceRequired();
      if (!bothAround(me, other)) {
        endMeet(s, 'expired', now);
        await saveMeet(meet);
        throw over(s, me);
      }
      activate(s, me, other, now);
    } else {
      declineMeet(s, now);
    }
  } else if (name === 'found') {
    // A silently declined ask answers exactly as a waiting one would.
    if (silentlyDeclined(s, me)) throw new HttpError(409, { error: 'state', state: 'requested' });
    expectState(s, me, ['active']);
    endMeet(s, 'found', now);
  } else if (silentlyDeclined(s, me)) {
    // The requester cancels an ask that was silently declined. It stays "declined" in the store,
    // so it still counts towards the daily pause, and the requester sees "cancelled" from now on.
    endMeet(s, 'declined', Date.parse(s.ended_at) || now);
    s.requester_cancelled = true;
  } else {
    expectState(s, me, OPEN_STATES);
    endMeet(s, 'cancelled', now);
  }
  await saveMeet(meet);
  // The person who acted sees their own state, so a decline answers "declined" to the recipient
  // and the requester of a silently declined ask sees "cancelled" after cancelling it.
  sendJson(res, 200, { ok: true, ...meetView(s, me, other, labels), state: stateFor(s, me) });
}

async function putDetails(req, res, id) {
  const device = writer(req);
  const body = await jsonBody(req, DETAILS_KEYS);
  const { meet, me, other, labels } = await participantMeet(device, id);
  const s = meet.source;
  // Either participant may write their line or a meeting point while the meet is open; the
  // other person sees a spot-me line only once the meet is active. The requester of a silently
  // declined ask may still save theirs: it is stored and shown back to them, and the decliner
  // never sees it.
  if (!silentlyDeclined(s, me)) expectState(s, me, OPEN_STATES);
  let heldFields = [];
  if (body.spot_me !== undefined) {
    const { text: spotMe, pending } = await line(body.spot_me, 'spot_me', SPOT_MAX);
    s.spot_me = { ...(s.spot_me ?? {}) };
    s.spot_me_pending = { ...(s.spot_me_pending ?? {}) };
    if (spotMe) s.spot_me[me.profile_id] = spotMe;
    else delete s.spot_me[me.profile_id];
    if (spotMe && pending) s.spot_me_pending[me.profile_id] = true;
    else delete s.spot_me_pending[me.profile_id];
    heldFields = spotMe && pending ? ['spot_me'] : [];
  }
  if (body.rendezvous !== undefined) {
    if (body.rendezvous === null || body.rendezvous === '') {
      s.rendezvous = null;
    } else {
      if (typeof body.rendezvous !== 'string') throw bad('rendezvous must be a zone or null');
      const zone = body.rendezvous.trim();
      if (!(await zonesFor(s.event_id)).has(zone)) throw bad("rendezvous must be one of the conference's zones");
      s.rendezvous = zone;
    }
  }
  await saveMeet(meet);
  if (heldFields.length) await classifierReport(s.event_id, 'meet', s.meet_id, me.profile_id);
  sendJson(res, 200, { ok: true, ...meetView(s, me, other, labels), ...heldInfo(heldFields) });
}

// ---------------------------------------------------------------------------------------------

const ROUTES = {
  '/api/people/block': { POST: block, DELETE: unblock },
  '/api/people/blocks': { GET: blocks },
  '/api/presence': { PUT: putPresence, DELETE: deletePresence },
  '/api/meet': { POST: requestMeet },
  '/api/meet/inbox': { GET: inbox },
};

// Handles the block, presence and meet routes. Resolves to true when the request was handled.
export async function handleConnectApi(req, res, url) {
  let route = ROUTES[url.pathname];
  if (!route) {
    const m = MEET_PATH_RE.exec(url.pathname);
    if (!m) return false;
    const [, id, name] = m;
    if (!name) route = { GET: (rq, rs) => getMeet(rq, rs, id) };
    else if (name === 'details') route = { PUT: (rq, rs) => putDetails(rq, rs, id) };
    else route = { POST: (rq, rs) => action(rq, rs, id, name) };
  }
  await dispatch(route, req, res, url);
  return true;
}
