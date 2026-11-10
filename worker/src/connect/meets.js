// Asks, waves and meets (PLAN section 1.9, routes 22 to 26), ported from server/connect.mjs.
//
//   POST /api/meet                        GET /api/meet/inbox?event=
//   GET  /api/meet/{id}                   PUT /api/meet/{id}/details
//   POST /api/meet/{id}/accept | decline | found | cancel
//
// Rules this module keeps:
// - Every route needs the device header and a live profile of the caller at this conference. A
//   meet is read or changed only by its two participants; everyone else gets 403.
// - A block is symmetric and silent: a meet between a blocked pair answers the same 403
//   { error: "blocked" } to both, whatever its state, and an open one is closed when it is seen.
// - Asks are now-only: you can ask only someone who is around, and only while you are around
//   yourself; the ask runs out 15 minutes after it was made; accept means now, so it moves the
//   meet straight to active (20 minutes). A wave is an ask with the client's default note.
// - "Not now" is silent: the requester keeps seeing "requested" until the ask runs out, with the
//   same note, meeting point, own spot-me line and same-zone view as before, and can still save
//   their own details or cancel. Three "Not now" replies in one conference day pause the
//   requester until the next day (a COUNT over the declined meets, which the purge keeps for two
//   days). When a meet ends, only participants, topic, state and times are kept.
// - At most 10 asks an hour per device: an in-memory bucket as today, plus a COUNT over the meets
//   created in the last hour, so the cap survives an evicted object.
// - The other person's zone, spot line and spot-me line appear only inside an active meet (so
//   while both are around); the distance (to 10 m) and the bearing only on GET /api/meet/{id} of
//   an active meet, from the two positions held in memory. No coordinate ever leaves here.
// - Every state change is one guarded UPDATE that bumps version, inside one synchronous
//   transaction when several meets change together. The Durable Object is the only writer and
//   no await separates a read from its write, so a change never interleaves with another.
// - A meet id is the conference's 6-character route prefix plus 16 random base64url characters,
//   so the Worker can route GET /api/meet/{id} to the right conference.
// - Nothing from a request body, header or row is logged.

import { HttpError, bad, forbidden, json, readJson, TOPIC_ID_RE } from '../lib/http.js';
import { dayBounds } from '../lib/time.js';
import { parseObj } from '../store.js';
import {
  HOUR_MS, iso, blocked, notFound, presenceRequired, notAround, writer, poller, requireProfile, refOf,
  line, personByRef, emptyBody, randomId, locationOf, distanceM, bearingDeg,
} from './common.js';

const ACTIVE_MS = 20 * 60_000;
const REQUEST_MS = 15 * 60_000;
const SPOT_MAX = 60;
const NOTE_MAX = 140;
const DISTANCE_STEP_M = 10;
const MEET_REQUESTS_PER_HOUR = 10;
const DECLINES_PER_DAY = 3;
const INBOX_SIZE = 100;
const OPEN_STATES = ['requested', 'active'];
const PREFIX_RE = /^[A-Za-z0-9_-]{6}$/;

// ---------------------------------------------------------------------------------------------
// Rows and writes.

function meetFromRow(r) {
  return {
    meet_id: r.meet_id,
    requester_id: r.requester_id,
    recipient_id: r.recipient_id,
    topic_id: r.topic_id ?? null,
    note: r.note ?? null,
    note_pending: r.note_pending === 1,
    state: r.state === 'accepted' ? 'expired' : r.state,
    same_zone: r.same_zone === 1,
    hidden: r.hidden === 1,
    hidden_owner_id: r.hidden_owner_id ?? null,
    requester_cancelled: r.requester_cancelled === 1,
    rendezvous: r.rendezvous ?? null,
    spot_me: parseObj(r.spot_me),
    spot_me_pending: parseObj(r.spot_me_pending),
    created_at_ms: r.created_at_ms,
    active_since_ms: r.active_since_ms ?? null,
    expires_at_ms: r.expires_at_ms,
    ended_at_ms: r.ended_at_ms ?? null,
    version: r.version ?? 0,
  };
}

function loadMeet(ctx, id) {
  const r = ctx.sql.exec('SELECT * FROM meets WHERE meet_id = ?', id).toArray()[0];
  return r ? meetFromRow(r) : null;
}

// Writes the mutable fields of a meet back, guarded by the version it was read with, and bumps
// the version. hidden and hidden_owner_id belong to the report and moderation paths and are
// never written here.
function saveMeet(ctx, m) {
  const rows = ctx.sql.exec(
    `UPDATE meets SET topic_id = ?, note = ?, note_pending = ?, state = ?, same_zone = ?, requester_cancelled = ?,
       rendezvous = ?, spot_me = ?, spot_me_pending = ?, active_since_ms = ?, expires_at_ms = ?, ended_at_ms = ?,
       version = version + 1
     WHERE meet_id = ? AND version = ? RETURNING version`,
    m.topic_id, m.note, m.note_pending ? 1 : 0, m.state, m.same_zone ? 1 : 0, m.requester_cancelled ? 1 : 0,
    m.rendezvous, JSON.stringify(m.spot_me ?? {}), JSON.stringify(m.spot_me_pending ?? {}),
    m.active_since_ms, m.expires_at_ms, m.ended_at_ms, m.meet_id, m.version,
  ).toArray();
  if (!rows.length) throw new HttpError(409, { error: 'The meet changed at the same time; try again' });
  m.version = rows[0].version;
}

const inTransaction = (ctx, fn) => (typeof ctx.transactionSync === 'function' ? ctx.transactionSync(fn) : fn());

// ---------------------------------------------------------------------------------------------
// Transitions.

// Closes a meet. Afterwards only participants, topic, state and times remain.
function endMeet(m, state, nowMs) {
  m.state = state;
  m.ended_at_ms = nowMs;
  m.note = null;
  m.rendezvous = null;
  m.spot_me = {};
  m.spot_me_pending = {};
  m.note_pending = false;
}

// "Not now" is silent, so a decline keeps what the requester sees until the ask runs out: the
// note, the meeting point, the requester's own spot-me line and same_zone. The decliner's own
// spot-me line is dropped, since the requester never sees it before a meet is active. The purge
// scrubs the kept fields once expires_at has passed.
function declineMeet(m, nowMs) {
  const requesterSpot = m.spot_me?.[m.requester_id];
  const requesterPending = m.spot_me_pending?.[m.requester_id] === true;
  m.state = 'declined';
  m.ended_at_ms = nowMs;
  m.spot_me = requesterSpot ? { [m.requester_id]: requesterSpot } : {};
  m.spot_me_pending = requesterSpot && requesterPending ? { [m.requester_id]: true } : {};
}

// True when me asked, the other person silently declined, the ask has not run out and the
// requester has not cancelled it. The requester then still sees and may change their ask.
function silentlyDeclined(m, me, nowMs) {
  return m.state === 'declined' && m.requester_id === me.profile_id && !m.requester_cancelled && m.expires_at_ms > nowMs;
}

const bothAround = (store, me, other) => store.isAround(me) && Boolean(other) && store.isAround(other);
const sameZone = (store, me, other) =>
  bothAround(store, me, other) && typeof me.presence.zone === 'string' && me.presence.zone === other.presence.zone;

// Accept means now: both are around, and the meet runs for 20 minutes from this moment. In the
// same zone the shared zone is the meeting point unless someone set another.
function activate(store, m, me, other, nowMs) {
  m.state = 'active';
  m.active_since_ms = nowMs;
  m.expires_at_ms = nowMs + ACTIVE_MS;
  m.same_zone = sameZone(store, me, other);
  if (m.same_zone && !m.rendezvous) m.rendezvous = me.presence.zone;
}

// The state one participant sees. An open meet past expires_at reads "expired" even before a
// read has written that. "Not now" is silent, so the requester of a declined meet sees
// "requested" until it runs out, and "expired" afterwards; once they cancel it, "cancelled".
function stateFor(m, me, nowMs) {
  const ranOut = m.expires_at_ms <= nowMs;
  if (OPEN_STATES.includes(m.state)) return ranOut ? 'expired' : m.state;
  if (m.state !== 'declined' || m.requester_id !== me.profile_id) return m.state;
  if (m.requester_cancelled) return 'cancelled';
  return ranOut ? 'expired' : 'requested';
}

const over = (m, me, nowMs) => new HttpError(410, { error: 'over', state: stateFor(m, me, nowMs) });

// A transition needs an open meet that has not run out, in one of the allowed states.
function expectState(m, me, allowed, nowMs) {
  if (!OPEN_STATES.includes(m.state) || m.expires_at_ms <= nowMs) throw over(m, me, nowMs);
  if (!allowed.includes(m.state)) throw new HttpError(409, { error: 'state', state: m.state });
}

// Closes every open meet that matches the SQL condition, in the state endState(meet) gives, in
// one transaction. Returns the number closed.
function closeMeets(ctx, where, binds, endState) {
  const rows = ctx.sql.exec(`SELECT * FROM meets WHERE state IN ('requested', 'active') AND (${where}) LIMIT ${INBOX_SIZE}`, ...binds).toArray();
  if (!rows.length) return 0;
  const now = Date.now();
  inTransaction(ctx, () => {
    for (const r of rows) {
      const m = meetFromRow(r);
      endMeet(m, endState(m), now);
      saveMeet(ctx, m);
    }
  });
  return rows.length;
}

// Closes the open meets between two people after one blocked the other. A waiting ask to the
// blocker ends as a silent "Not now" ("declined"), as today; every other open meet, including an
// active one, ends as "cancelled", so it is over for both participants and stays over after an
// unblock. For the block route (people module, T3), which calls it right after Store.addBlock;
// the meet routes below also close such a meet whenever they see one. Returns the number closed.
export function closeMeetsBetween(ctx, blockerId, otherId) {
  return closeMeets(
    ctx,
    '(requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)',
    [blockerId, otherId, otherId, blockerId],
    (m) => (m.state === 'requested' && m.recipient_id === blockerId ? 'declined' : 'cancelled'),
  );
}

// Closes the caller's active meets when their presence ends.
export function closeActiveMeetsOf(ctx, profileId) {
  return closeMeets(ctx, "state = 'active' AND (requester_id = ? OR recipient_id = ?)", [profileId, profileId], () => 'expired');
}

// ---------------------------------------------------------------------------------------------
// Views.

// What a participant may see of a meet. The other person's zone and spot appear only while the
// meet is active (so while both are around), their spot-me line only then as well. A same-zone
// ask also carries the zone while it waits: both are around and it is the reader's own zone. The
// requester of a silently declined ask sees it exactly as a waiting ask, zone included. With
// withDistance (the meet read only, never the inbox or an action), an active meet between two
// people who both have a position adds the distance (to 10 m) and the bearing from me to them;
// otherwise neither key is present.
function meetView(ctx, m, me, other, labels, { withDistance = false } = {}) {
  const store = ctx.store;
  const now = Date.now();
  const state = stateFor(m, me, now);
  const active = m.state === 'active';
  const otherId = m.requester_id === me.profile_id ? m.recipient_id : m.requester_id;
  const topic = m.topic_id && labels.has(m.topic_id) ? { topic_id: m.topic_id, label: labels.get(m.topic_id) } : null;
  const together = bothAround(store, me, other);
  const showZone = together && (active || (state === 'requested' && m.same_zone && sameZone(store, me, other)));
  const position = {};
  if (withDistance && active && together) {
    const a = locationOf(store, me);
    const b = locationOf(store, other);
    if (a && b) {
      position.distance_m = Math.round(distanceM(a, b) / DISTANCE_STEP_M) * DISTANCE_STEP_M;
      position.bearing_deg = Math.round(bearingDeg(a, b)) % 360;
    }
  }
  const op = other?.presence ?? null;
  return {
    meet_id: m.meet_id,
    state,
    requested_by_me: m.requester_id === me.profile_id,
    same_zone: m.same_zone,
    topic,
    topic_label: topic?.label ?? null,
    // A held note reaches only its author.
    note: m.note_pending && m.requester_id !== me.profile_id ? '' : m.note ?? null,
    created_at: iso(m.created_at_ms),
    active_since: iso(m.active_since_ms),
    active_until: active ? iso(m.expires_at_ms) : null,
    expires_at: iso(m.expires_at_ms),
    rendezvous: m.rendezvous ?? null,
    mine: { spot_me: m.spot_me?.[me.profile_id] ?? null, around: store.isAround(me) },
    other: {
      ref: other?.ref ?? null,
      display_name: other?.display_name ?? '',
      about: other?.about ?? '',
      around: Boolean(other) && store.isAround(other),
      zone: showZone ? op?.zone ?? null : null,
      spot: active && together && !op?.spot_pending ? op?.spot ?? null : null,
      spot_me: active && together && otherId && m.spot_me_pending?.[otherId] !== true ? m.spot_me?.[otherId] ?? null : null,
      ...position,
    },
  };
}

// The extra key on a 200 response when a field was held. Nothing is held on the free stack, so
// it is always empty; it stays for the shape of today's responses.
const heldInfo = () => ({});

// Loads a meet for one of its participants: 404 when there is none, 403 for anyone else. A pair
// with a block in either direction gets the same 403 { error: "blocked" } as an ask between them,
// whatever state the meet is in; an open meet between them is closed first, so it stays over
// after an unblock.
async function participantMeet(ctx, device, id) {
  const me = await ctx.store.authenticate(device);
  // From here on nothing awaits, so the read and any write that follows cannot interleave.
  const m = loadMeet(ctx, id);
  if (!m) throw notFound();
  if (!me || (m.requester_id !== me.profile_id && m.recipient_id !== me.profile_id)) throw forbidden();
  // A meet hidden after reports exists only for the reported participant.
  if (m.hidden && m.hidden_owner_id !== me.profile_id) throw notFound();
  const otherId = m.requester_id === me.profile_id ? m.recipient_id : m.requester_id;
  if (ctx.store.blockedBetween(me.profile_id, otherId)) {
    if (OPEN_STATES.includes(m.state)) {
      endMeet(m, 'cancelled', Date.now());
      saveMeet(ctx, m);
    }
    throw blocked();
  }
  const other = ctx.store.person(otherId);
  return { m, me, other, labels: ctx.store.topics().labels };
}

// ---------------------------------------------------------------------------------------------
// Handlers.

const MEET_KEYS = new Set(['event', 'ref', 'topic_id', 'note']);
const DETAILS_KEYS = new Set(['spot_me', 'rendezvous']);

async function requestMeet(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, MEET_KEYS);
  const ref = refOf(body);
  const topicId = body.topic_id === undefined || body.topic_id === null ? null : body.topic_id;
  if (topicId !== null && (typeof topicId !== 'string' || !TOPIC_ID_RE.test(topicId))) throw bad('topic_id must be a topic id or null');
  const { text: noteText, pending: notePending } = line(body.note, 'note', NOTE_MAX);
  const note = noteText ?? '';
  const me = await requireProfile(ctx, device);
  // From here on nothing awaits.
  // A profile hidden after reports must not surface in anyone's inbox.
  if (me.hidden) throw new HttpError(403, { error: 'hidden' });
  ctx.limit(`meet-request:dev:${me.profile_id}`, MEET_REQUESTS_PER_HOUR, HOUR_MS);
  const now = Date.now();
  const lastHour = ctx.sql.exec('SELECT COUNT(*) AS n, MIN(created_at_ms) AS first FROM meets WHERE requester_id = ? AND created_at_ms > ?', me.profile_id, now - HOUR_MS).one();
  if (lastHour.n >= MEET_REQUESTS_PER_HOUR) {
    const retry = Math.max(1, Math.ceil((lastHour.first + HOUR_MS - now) / 1000));
    throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(retry) });
  }

  const them = personByRef(ctx, me, ref);
  if (!them) throw notFound();
  if (ctx.store.blockedBetween(me.profile_id, them.profile_id)) throw blocked();
  // Now-only: both must be around. A match who is not around is watched on the device, not booked.
  if (!ctx.store.isAround(me)) throw presenceRequired();
  if (!ctx.store.isAround(them)) throw notAround();

  const day = dayBounds(now, ctx.conf.time_zone);
  const declined = ctx.sql.exec(
    "SELECT COUNT(*) AS n FROM meets WHERE requester_id = ? AND state = 'declined' AND ended_at_ms >= ?",
    me.profile_id, day.start,
  ).one().n;
  if (declined >= DECLINES_PER_DAY) {
    throw new HttpError(
      429,
      { error: 'paused', message: 'Three people said not now today. You can ask again tomorrow.', retry_at: iso(day.end) },
      { 'Retry-After': String(Math.max(1, Math.ceil((day.end - now) / 1000))) },
    );
  }

  // "Not now" is silent: the requester of a declined ask still sees it as waiting until it runs
  // out or they cancel it, so asking again answers the same 409 meet_open as a pending ask and
  // notifies nobody.
  const existing = ctx.sql.exec(
    `SELECT * FROM meets
     WHERE ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)) AND expires_at_ms > ?
     ORDER BY created_at_ms DESC LIMIT 10`,
    me.profile_id, them.profile_id, them.profile_id, me.profile_id, now,
  ).toArray().map(meetFromRow);
  const open = existing.find((m) => OPEN_STATES.includes(m.state) || silentlyDeclined(m, me, now));
  if (open) throw new HttpError(409, { error: 'meet_open', meet_id: open.meet_id });

  const labels = ctx.store.topics().labels;
  if (topicId !== null && !labels.has(topicId)) throw bad('topic_id is not a topic of this conference');
  // The ask runs out in 15 minutes: an answer later than that would be a booking.
  const expiresMs = Math.min(now + REQUEST_MS, ctx.conf.visible_until_ms ?? Infinity);
  if (expiresMs <= now) throw bad('conference has ended');
  const prefix = ctx.conf.route_prefix;
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) throw new Error('conference has no route prefix');

  const m = {
    meet_id: prefix + randomId(12),
    requester_id: me.profile_id,
    recipient_id: them.profile_id,
    topic_id: topicId,
    note,
    note_pending: notePending,
    state: 'requested',
    same_zone: sameZone(ctx.store, me, them),
    hidden: false,
    hidden_owner_id: null,
    requester_cancelled: false,
    rendezvous: null,
    spot_me: {},
    spot_me_pending: {},
    created_at_ms: now,
    active_since_ms: null,
    expires_at_ms: expiresMs,
    ended_at_ms: null,
    version: 0,
  };
  ctx.sql.exec(
    `INSERT INTO meets (meet_id, requester_id, recipient_id, topic_id, note, note_pending, state, same_zone,
       created_at_ms, expires_at_ms, version)
     VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, 0)`,
    m.meet_id, m.requester_id, m.recipient_id, m.topic_id, m.note, m.note_pending ? 1 : 0, m.same_zone ? 1 : 0, m.created_at_ms, m.expires_at_ms,
  );
  return json(200, { ok: true, ...meetView(ctx, m, me, them, labels), ...heldInfo() });
}

async function inbox(ctx, req) {
  const device = poller(ctx, req);
  const me = await requireProfile(ctx, device);
  // From here on nothing awaits.
  const now = Date.now();
  const rows = ctx.sql.exec(
    `SELECT * FROM meets WHERE requester_id = ? AND expires_at_ms > ? AND state IN ('requested', 'active', 'declined')
     UNION ALL
     SELECT * FROM meets WHERE recipient_id = ? AND expires_at_ms > ? AND state IN ('requested', 'active')
     ORDER BY created_at_ms DESC LIMIT ${INBOX_SIZE}`,
    me.profile_id, now, me.profile_id, now,
  ).toArray();
  const labels = ctx.store.topics().labels;
  const incoming = [];
  const outgoing = [];
  const closed = [];
  for (const r of rows) {
    const m = meetFromRow(r);
    const otherId = m.requester_id === me.profile_id ? m.recipient_id : m.requester_id;
    // A meet hidden after reports reaches only the reported participant.
    if (m.hidden && m.hidden_owner_id !== me.profile_id) continue;
    if (ctx.store.blockedBetween(me.profile_id, otherId)) {
      // A block closes an open meet between the two, whoever sees it first.
      if (OPEN_STATES.includes(m.state)) {
        endMeet(m, 'cancelled', now);
        closed.push(m);
      }
      continue;
    }
    const other = ctx.store.person(otherId);
    // A missing or hidden profile is left out.
    if (!other || other.hidden) continue;
    // An active meet with either presence gone is over, so its card, with the zone, spot and
    // spot-me lines, is left out, and the end is written back as the meet read does.
    if (m.state === 'active' && (m.expires_at_ms <= now || !bothAround(ctx.store, me, other))) {
      endMeet(m, 'expired', now);
      closed.push(m);
      continue;
    }
    const view = meetView(ctx, m, me, other, labels);
    // A silently declined ask the requester has cancelled is over for them.
    if (!OPEN_STATES.includes(view.state)) continue;
    if (m.requester_id === me.profile_id) outgoing.push({ ...view, to: { ref: view.other.ref, display_name: other.display_name ?? '' } });
    else incoming.push({ ...view, from: { ref: view.other.ref, display_name: other.display_name ?? '', about: other.about ?? '' } });
  }
  if (closed.length) inTransaction(ctx, () => closed.forEach((m) => saveMeet(ctx, m)));
  return json(200, { incoming, outgoing });
}

async function getMeet(ctx, req, [id]) {
  const device = poller(ctx, req);
  const { m, me, other, labels } = await participantMeet(ctx, device, id);
  const now = Date.now();
  // The transitions that time or presence cause are applied when the meet is read: an ask or an
  // active meet past expires_at, or an active meet with either presence gone, is over.
  if (OPEN_STATES.includes(m.state) && (m.expires_at_ms <= now || (m.state === 'active' && !bothAround(ctx.store, me, other)))) {
    endMeet(m, 'expired', now);
    saveMeet(ctx, m);
  }
  if (!OPEN_STATES.includes(stateFor(m, me, now))) throw over(m, me, now);
  return json(200, meetView(ctx, m, me, other, labels, { withDistance: true }));
}

async function action(ctx, req, [id, name]) {
  const device = writer(ctx, req);
  await emptyBody(req);
  const { m, me, other, labels } = await participantMeet(ctx, device, id);
  const now = Date.now();
  if (name === 'accept' || name === 'decline') {
    if (m.requester_id === me.profile_id) throw forbidden();
    expectState(m, me, ['requested'], now);
    if (name === 'accept') {
      // Accept means now. The one accepting must be around; if the asker has meanwhile left, the
      // ask is over.
      if (!ctx.store.isAround(me)) throw presenceRequired();
      if (!bothAround(ctx.store, me, other)) {
        endMeet(m, 'expired', now);
        saveMeet(ctx, m);
        throw over(m, me, now);
      }
      activate(ctx.store, m, me, other, now);
    } else {
      declineMeet(m, now);
    }
  } else if (name === 'found') {
    // A silently declined ask answers exactly as a waiting one would.
    if (silentlyDeclined(m, me, now)) throw new HttpError(409, { error: 'state', state: 'requested' });
    expectState(m, me, ['active'], now);
    endMeet(m, 'found', now);
  } else if (silentlyDeclined(m, me, now)) {
    // The requester cancels an ask that was silently declined. It stays "declined" in the store,
    // so it still counts towards the daily pause, and the requester sees "cancelled" from now on.
    endMeet(m, 'declined', m.ended_at_ms ?? now);
    m.requester_cancelled = true;
  } else {
    expectState(m, me, OPEN_STATES, now);
    endMeet(m, 'cancelled', now);
  }
  saveMeet(ctx, m);
  // The person who acted sees their own state, so a decline answers "declined" to the recipient
  // and the requester of a silently declined ask sees "cancelled" after cancelling it.
  return json(200, { ok: true, ...meetView(ctx, m, me, other, labels), state: stateFor(m, me, now) });
}

async function putDetails(ctx, req, [id]) {
  const device = writer(ctx, req);
  const body = await readJson(req, DETAILS_KEYS);
  const { m, me, other, labels } = await participantMeet(ctx, device, id);
  const now = Date.now();
  // Either participant may write their line or a meeting point while the meet is open; the other
  // person sees a spot-me line only once the meet is active. The requester of a silently declined
  // ask may still save theirs: it is stored and shown back to them, and the decliner never sees it.
  if (!silentlyDeclined(m, me, now)) expectState(m, me, OPEN_STATES, now);
  if (body.spot_me !== undefined) {
    const { text: spotMe, pending } = line(body.spot_me, 'spot_me', SPOT_MAX);
    m.spot_me = { ...(m.spot_me ?? {}) };
    m.spot_me_pending = { ...(m.spot_me_pending ?? {}) };
    if (spotMe) m.spot_me[me.profile_id] = spotMe;
    else delete m.spot_me[me.profile_id];
    if (spotMe && pending) m.spot_me_pending[me.profile_id] = true;
    else delete m.spot_me_pending[me.profile_id];
  }
  if (body.rendezvous !== undefined) {
    if (body.rendezvous === null || body.rendezvous === '') {
      m.rendezvous = null;
    } else {
      if (typeof body.rendezvous !== 'string') throw bad('rendezvous must be a zone or null');
      const zone = body.rendezvous.trim();
      if (!ctx.store.zones().has(zone)) throw bad("rendezvous must be one of the conference's zones");
      m.rendezvous = zone;
    }
  }
  saveMeet(ctx, m);
  return json(200, { ok: true, ...meetView(ctx, m, me, other, labels), ...heldInfo() });
}

const FAIL = 'People are temporarily unavailable';

export default [
  { method: 'POST', path: '/api/meet', bucket: 'write', fail: FAIL, handler: requestMeet },
  { method: 'GET', path: '/api/meet/inbox', bucket: 'poll', fail: FAIL, handler: inbox },
  { method: 'GET', path: /^\/api\/meet\/([A-Za-z0-9_-]{22})$/, bucket: 'poll', fail: FAIL, handler: getMeet },
  { method: 'POST', path: /^\/api\/meet\/([A-Za-z0-9_-]{22})\/(accept|decline|found|cancel)$/, bucket: 'write', fail: FAIL, handler: action },
  { method: 'PUT', path: /^\/api\/meet\/([A-Za-z0-9_-]{22})\/details$/, bucket: 'write', fail: FAIL, handler: putDetails },
];
