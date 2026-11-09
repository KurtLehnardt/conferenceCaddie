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
//   meets, and a meet attempt in either direction gets the same 403 { error: "blocked" }.
// - Presence lives on the people document and is written with a Bulk partial update of its six
//   fields only, so it never re-runs the embedding model. It ends 60 minutes after it was turned
//   on, or with until: 'day' at the end of the conference day, at the latest at the end of the
//   conference.
// - A position is optional: rounded to 5 decimals, dropped when its accuracy is worse than 200 m,
//   cleared with presence. It is never returned. It ranks nearby people higher and becomes a band
//   on a result (people.mjs); only an active meet turns it into a distance rounded to 10 m and a
//   bearing, for its two participants, through GET /api/meet/{id} and nowhere else.
// - A person's zone and spot reach another person only inside an active meet, which exists only
//   while both are around; a how-to-spot-me line reaches only the other participant, only while
//   the meet is active. Search results carry a zone only when both people are around (people.mjs).
// - "Not now" is silent: the requester keeps seeing "requested" until the request runs out at
//   the end of the conference day. Three "Not now" replies in one day pause the requester until
//   the next day. When a meet ends, only participants, topic, state and times are kept.
// - Spot lines, notes and spot-me lines pass the wordlist filter in moderation.mjs.
// - Nothing from a request body, header or document is logged.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import { refFor } from './device.mjs';
import { isFiltered, FILTERED } from './moderation.mjs';
import {
  people, idx, docId, BLOCKS_INDEX, MEETS_INDEX, LIMITS, REF_RE,
  HttpError, UpstreamError, bad, forbidden, sendJson, limit, jsonBody, requireDevice, text,
  conferenceFor, dayBounds, topicLabels, zonesFor, authenticated, bulkOne, isAround, PRESENCE_OFF,
  peopleByIds, docByRef, personByRef, blockedIds, blockedBetween, blockId, dispatch,
  locationOf, distanceM, bearingDeg,
} from './people.mjs';

const PRESENCE_MS = 60 * 60_000;
const ACTIVE_MS = 20 * 60_000;
const HOUR_MS = 60 * 60_000;
const SPOT_MAX = 60;
const ACCURACY_MAX_M = 200;
const COORD_DECIMALS = 5;
const DISTANCE_STEP_M = 10;
const NOTE_MAX = 140;
const MEET_REQUESTS_PER_HOUR = 10;
const DECLINES_PER_DAY = 3;
const INBOX_SIZE = 100;
const BLOCKS_SIZE = 1000;
const OPEN_STATES = ['requested', 'accepted', 'active'];
const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MEET_PATH_RE = /^\/api\/meet\/([A-Za-z0-9_-]{22})(?:\/(accept|decline|found|cancel|details))?$/;

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });
const blocked = () => new HttpError(403, { error: 'blocked' });
const notFound = () => new HttpError(404, { error: 'not_found' });

// The write and read rate limits of people.mjs, so the buckets are shared. Each returns the device.
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

// A short line other people will read: trimmed, capped, and passed through the wordlist filter.
// Returns null for an empty line.
function line(value, name, max) {
  const t = text(value, name, max);
  if (t && isFiltered(t)) throw new HttpError(400, FILTERED);
  return t || null;
}

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
  return { source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term };
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
}

// Both are around: the meet runs for 20 minutes, or until the request would have run out.
function activate(s, nowMs) {
  s.state = 'active';
  s.active_since = iso(nowMs);
  s.expires_at = iso(Math.min(nowMs + ACTIVE_MS, Date.parse(s.expires_at)));
}

const bothAround = (me, other) => isAround(me) && Boolean(other) && isAround(other);

// Closes every open meet that matches the filters, in the state endState(source) gives. A meet
// changed by someone else in the meantime keeps that change; its own transition applies then.
async function closeMeets(slug, filters, endState) {
  const { json } = await people('POST', `${idx(MEETS_INDEX)}/_search?ignore_unavailable=true&seq_no_primary_term=true`, {
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
  await people('POST', `${idx(MEETS_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
}

// The state one participant sees. "Not now" is silent, so the requester of a declined meet sees
// "requested" until it runs out, and "expired" afterwards.
function stateFor(s, me) {
  if (s.state !== 'declined' || s.requester_id !== me.profile_id) return s.state;
  return Date.parse(s.expires_at) > Date.now() ? 'requested' : 'expired';
}

const over = (s, me) => new HttpError(410, { error: 'over', state: stateFor(s, me) });

// What a participant may see of a meet. The other person's zone and spot appear only while the
// meet is active (so while both are around), their spot-me line only then as well. With
// withDistance (the meet read only, never the inbox or an action), an active meet between two
// people who both have a position adds the distance (to 10 m) and the bearing from me to them;
// otherwise neither key is present. No coordinate ever leaves here.
function meetView(s, me, other, labels, { withDistance = false } = {}) {
  const state = stateFor(s, me);
  const active = s.state === 'active';
  const otherId = (s.participants ?? []).find((p) => p !== me.profile_id) ?? null;
  const topic = s.topic_id && labels.has(s.topic_id) ? { topic_id: s.topic_id, label: labels.get(s.topic_id) } : null;
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
    topic,
    topic_label: topic?.label ?? null,
    note: s.note ?? null,
    created_at: s.created_at ?? null,
    active_since: s.active_since ?? null,
    active_until: active ? s.expires_at ?? null : null,
    expires_at: s.expires_at ?? null,
    rendezvous: s.rendezvous ?? null,
    mine: { spot_me: s.spot_me?.[me.profile_id] ?? null, around: isAround(me) },
    other: {
      ref: otherId ? refFor(s.event_id, otherId) : null,
      display_name: other?.display_name ?? '',
      about: other?.about ?? '',
      around: Boolean(other) && isAround(other),
      zone: active && bothAround(me, other) ? other.presence_zone ?? null : null,
      spot: active && bothAround(me, other) ? other.presence_spot ?? null : null,
      spot_me: active && otherId ? s.spot_me?.[otherId] ?? null : null,
      ...position,
    },
  };
}

// Loads a meet for one of its participants: 404 when there is none, 403 for anyone else.
async function participantMeet(device, id) {
  const meet = await loadMeet(id);
  if (!meet) throw notFound();
  const s = meet.source;
  const me = await authenticated(device, s.event_id);
  if (!me || !(s.participants ?? []).includes(me.profile_id)) throw forbidden();
  const otherId = s.participants.find((p) => p !== me.profile_id);
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
  await people('POST', `${idx(BLOCKS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
    query: { bool: { filter: [{ term: { event_id: conf.slug } }, { term: { blocker_id: me.profile_id } }, { term: { blocked_ref: ref } }] } },
  });
  sendJson(res, 200, { ok: true });
}

async function blocks(req, res, url) {
  const device = reader(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await requireProfile(device, conf.slug);
  const { json } = await people('POST', `${idx(BLOCKS_INDEX)}/_search?ignore_unavailable=true`, {
    size: BLOCKS_SIZE,
    _source: ['blocked_id', 'blocked_ref', 'created_at'],
    sort: [{ created_at: 'desc' }],
    query: { bool: { filter: [{ term: { event_id: conf.slug } }, { term: { blocker_id: me.profile_id } }] } },
  });
  const rows = (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((s) => s.blocked_ref);
  const docs = await peopleByIds(conf.slug, rows.map((s) => s.blocked_id));
  sendJson(res, 200, {
    refs: rows.map((s) => s.blocked_ref),
    blocks: rows.map((s) => ({ ref: s.blocked_ref, display_name: docs.get(s.blocked_id)?.display_name ?? null, created_at: s.created_at ?? null })),
  });
}

// ---------------------------------------------------------------------------------------------
// Presence.

const PRESENCE_KEYS = new Set(['event', 'zone', 'spot', 'location', 'until']);
const PRESENCE_MODES = new Set(['hour', 'day']);
const LOCATION_KEYS = new Set(['lat', 'lon', 'accuracy']);

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

async function putPresence(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, PRESENCE_KEYS);
  if (typeof body.zone !== 'string') throw bad('zone must be a string');
  const zone = body.zone.trim();
  const spot = line(body.spot, 'spot', SPOT_MAX);
  const location = locationFields(body.location);
  const mode = body.until === undefined || body.until === null ? 'hour' : body.until;
  if (!PRESENCE_MODES.has(mode)) throw bad("until must be 'hour' or 'day'");
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me || me.open_to_meet !== true) throw profileRequired();
  if (!(await zonesFor(conf.slug)).has(zone)) throw bad("zone must be one of the conference's zones");
  const now = Date.now();
  // 'hour' runs out in 60 minutes; 'day' at the end of the conference day (its time zone), when
  // the client's zone confirmation does the safeguarding instead. Never past visible_until.
  const span = mode === 'day' ? dayBounds(now, conf.timeZone).end : now + PRESENCE_MS;
  const untilMs = Math.min(span, Date.parse(conf.visibleUntil));
  if (untilMs <= now) throw bad('conference has ended');
  // Turning it on again while it is on extends it; since keeps the first time.
  const since = isAround(me) && typeof me.presence_since === 'string' ? me.presence_since : iso(now);
  // A write without a usable position clears any stored one, so the presence is zone-only again.
  const presence = { presence_zone: zone, presence_spot: spot, presence_since: since, presence_until: iso(untilMs), ...location };
  const status = await bulkOne({ update: { _id: docId(conf.slug, me.profile_id) } }, { doc: presence });
  if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
  sendJson(res, 200, { ok: true, zone, spot, until: mode, presence_since: since, presence_until: presence.presence_until, located: location.presence_location !== null });
}

async function deletePresence(req, res, url) {
  const device = writer(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await authenticated(device, conf.slug);
  if (me) {
    const status = await bulkOne({ update: { _id: docId(conf.slug, me.profile_id) } }, { doc: PRESENCE_OFF });
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
  const note = line(body.note, 'note', NOTE_MAX) ?? '';
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  limit(`meet-request:dev:${me.profile_id}`, MEET_REQUESTS_PER_HOUR, HOUR_MS);

  const them = await personByRef(me, ref);
  if (!them) throw notFound();
  if (await blockedBetween(conf.slug, me.profile_id, them.profile_id)) throw blocked();

  const now = Date.now();
  const day = dayBounds(now, conf.timeZone);
  const declined = await people('POST', `${idx(MEETS_INDEX)}/_count?ignore_unavailable=true`, {
    query: {
      bool: {
        filter: [{ term: { event_id: conf.slug } }, { term: { requester_id: me.profile_id } }, { term: { state: 'declined' } }, { range: { ended_at: { gte: iso(day.start) } } }],
      },
    },
  });
  if ((declined.json.count ?? 0) >= DECLINES_PER_DAY) {
    throw new HttpError(429, { error: 'paused', message: 'Three people said not now today. You can ask again tomorrow.', retry_at: iso(day.end) }, { 'Retry-After': String(Math.max(1, Math.ceil((day.end - now) / 1000))) });
  }

  const existing = await people('POST', `${idx(MEETS_INDEX)}/_search?ignore_unavailable=true`, {
    size: 1,
    _source: ['meet_id'],
    query: { bool: { filter: [{ term: { event_id: conf.slug } }, { term: { participants: me.profile_id } }, { term: { participants: them.profile_id } }, { terms: { state: OPEN_STATES } }, { range: { expires_at: { gt: 'now' } } }] } },
  });
  const openId = existing.json.hits?.hits?.[0]?._source?.meet_id;
  if (openId) throw new HttpError(409, { error: 'meet_open', meet_id: openId });

  const labels = await topicLabels(conf.slug);
  if (topicId !== null && !labels.has(topicId)) throw bad('topic_id is not a topic of this conference');
  const expiresMs = Math.min(day.end, Date.parse(conf.visibleUntil));
  if (expiresMs <= now) throw bad('conference has ended');

  const s = {
    event_id: conf.slug,
    meet_id: crypto.randomBytes(16).toString('base64url'),
    participants: [me.profile_id, them.profile_id],
    requester_id: me.profile_id,
    topic_id: topicId,
    note,
    rendezvous: null,
    spot_me: {},
    state: 'requested',
    created_at: iso(now),
    active_since: null,
    expires_at: iso(expiresMs),
    ended_at: null,
  };
  const { status } = await people('PUT', `${idx(MEETS_INDEX)}/_create/${encodeURIComponent(s.meet_id)}?refresh=wait_for`, s, { okStatuses: [409] });
  if (status === 409) throw new UpstreamError('meet id collision');
  sendJson(res, 200, { ok: true, ...meetView(s, me, them, labels) });
}

async function inbox(req, res, url) {
  const device = reader(req);
  const conf = await conferenceFor(eventOf(url));
  const me = await requireProfile(device, conf.slug);
  const [hidden, labels, { json }] = await Promise.all([
    blockedIds(conf.slug, me.profile_id),
    topicLabels(conf.slug),
    people('POST', `${idx(MEETS_INDEX)}/_search?ignore_unavailable=true`, {
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
  const meets = (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((s) => Array.isArray(s.participants));
  const otherIds = meets.map((s) => s.participants.find((p) => p !== me.profile_id));
  const others = await peopleByIds(conf.slug, otherIds);
  const incoming = [];
  const outgoing = [];
  for (const s of meets) {
    const otherId = s.participants.find((p) => p !== me.profile_id);
    const other = others.get(otherId);
    if (!other || hidden.has(otherId)) continue;
    const view = meetView(s, me, other, labels);
    if (s.requester_id === me.profile_id) outgoing.push({ ...view, to: { ref: view.other.ref, display_name: other.display_name ?? '' } });
    else incoming.push({ ...view, from: { ref: view.other.ref, display_name: other.display_name ?? '', about: other.about ?? '' } });
  }
  sendJson(res, 200, { incoming, outgoing });
}

async function getMeet(req, res, id) {
  const device = reader(req);
  const { meet, me, other, labels } = await participantMeet(device, id);
  let s = meet.source;
  const now = Date.now();
  // The transitions that time or presence cause are applied when the meet is read.
  if (OPEN_STATES.includes(s.state)) {
    let changed = false;
    if (Date.parse(s.expires_at) <= now || (s.state === 'active' && !bothAround(me, other))) {
      endMeet(s, 'expired', now);
      changed = true;
    } else if (s.state === 'accepted' && bothAround(me, other)) {
      activate(s, now);
      changed = true;
    }
    if (changed) {
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
      s.state = 'accepted';
      if (bothAround(me, other)) activate(s, now);
    } else {
      endMeet(s, 'declined', now);
    }
  } else if (name === 'found') {
    expectState(s, me, ['active']);
    endMeet(s, 'found', now);
  } else {
    expectState(s, me, OPEN_STATES);
    endMeet(s, 'cancelled', now);
  }
  await saveMeet(meet);
  // The person who acted sees the real state, so a decline answers "declined" to the recipient.
  sendJson(res, 200, { ok: true, ...meetView(s, me, other, labels), state: s.state });
}

async function putDetails(req, res, id) {
  const device = writer(req);
  const body = await jsonBody(req, DETAILS_KEYS);
  const { meet, me, other, labels } = await participantMeet(device, id);
  const s = meet.source;
  expectState(s, me, ['accepted', 'active']);
  if (body.spot_me !== undefined) {
    const spotMe = line(body.spot_me, 'spot_me', SPOT_MAX);
    s.spot_me = { ...(s.spot_me ?? {}) };
    if (spotMe) s.spot_me[me.profile_id] = spotMe;
    else delete s.spot_me[me.profile_id];
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
  sendJson(res, 200, { ok: true, ...meetView(s, me, other, labels) });
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
