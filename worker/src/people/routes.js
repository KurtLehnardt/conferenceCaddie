// People routes of the ConferenceDO (PLAN section 1.8 and section 2 rows 12 to 19, 27 and 31):
// profiles, matches, circle counts and members, blocks, reports and Bluetooth sightings. Ported
// from server/people.mjs, the block routes of server/connect.mjs, server/report.mjs and the
// sightings route of server/ble.mjs, with the same request and response shapes.
//
// Every privacy gate is enforced here, server-side (INVENTORY 8.7, PLAN section 1.8):
//  1. every people read is scoped to this conference object and to live, not hidden, not blocked
//     (either direction) people, never the caller (rankPeople's candidates);
//  2. matches need the caller live and open_to_meet, else 403 visibility_required;
//  3. conference-wide matches list only open_to_meet people; sharing never leaks into them;
//  4. circle members need the caller to share for that talk, else 403 share_required with count;
//  5. reasons name only talks the caller both marked and shares for;
//  6. no profile_id, secret_hash, text_hash, position or anyone else's Bluetooth token is ever
//     returned; contact fields only in matches and circle members;
//  7. zone and band only while both are around (view.js);
//  8. a hidden profile is visible only to its owner (hidden_for_owner);
//  9. a ref resolves only to someone the caller could see (common.js visibleByRef), except that a
//     hidden person stays blockable and reportable;
// 10. a block hides both people from each other and closes any open meet between them;
// 11. expiry is filtered at read (store.people) and deleting a profile deletes it everywhere;
// 12. nothing from a body, a profile or a header is logged.

import { HttpError, bad, json, readJson, text, idList, isPlainObject, TALK_ID_RE, TOPIC_ID_RE, LINKEDIN_RE, REF_RE, MEET_ID_RE } from '../lib/http.js';
import { requireDevice, refFor } from '../lib/device.js';
import { rankPeople } from './rank.js';
import { toPerson, cellOf } from './view.js';
import { applyCaps, RESOLVE_CAPS } from '../../../contracts/js/ble-token.mjs';
import { bleConfig, derivedSession, keyOfSession, keyId, tableFor, resolveTokens } from '../lib/ble.js';
import {
  LIMITS, writer, reader, requireProfile, liveByRef, ownRow, notFound, profileRequired, visibilityRequired,
} from './common.js';

const FAIL = 'People are temporarily unavailable';
const MATCHES_SIZE = 20;
const MATCHES_FROM_MAX = 1000;
const MEMBERS_SIZE = 50;
const QUERY_MAX = 300;
const HOUR_MS = 60 * 60_000;
const REPORTS_PER_HOUR = 20;
// Distinct reporters at which a target is hidden from everyone but its owner.
const HIDE_AT = 2;
const MAX_SIGHTINGS = 50;
const SIGHTINGS_PER_MINUTE = 6;
const SIGHTINGS_PER_MINUTE_IP = 300;
const RSSI_MIN = -127;
const RSSI_MAX = 20;
const BLE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const OPEN_MEET_STATES = ['requested', 'active'];

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Titles of talks of this conference, as a Map id -> title, for the ids given.
function titlesOf(ctx, ids) {
  const out = new Map();
  for (const id of ids) {
    const t = ctx.store.talk(id);
    if (t) out.set(id, t.title ?? '');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Profiles.

const PUT_KEYS = new Set(['event', 'profile', 'open_to_meet', 'shared_talk_ids']);
const PROFILE_KEYS = new Set(['display_name', 'about', 'interests', 'expertise', 'learn_topics', 'speak_topics', 'linkedin_url', 'contact_note']);

function validateProfile(p) {
  if (!isPlainObject(p)) throw bad('profile must be an object');
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.has(k)) throw bad(`Unknown key: profile.${k.slice(0, 40)}`);
  let linkedin = null;
  if (p.linkedin_url !== undefined && p.linkedin_url !== null && p.linkedin_url !== '') {
    if (typeof p.linkedin_url !== 'string' || !LINKEDIN_RE.test(p.linkedin_url.trim())) {
      throw bad('linkedin_url must be a https://www.linkedin.com/in/... address or null');
    }
    linkedin = p.linkedin_url.trim();
  }
  return {
    display_name: text(p.display_name, 'display_name', 60, { required: true }),
    about: text(p.about, 'about', 280),
    interests: text(p.interests, 'interests', 500),
    expertise: text(p.expertise, 'expertise', 500),
    learn_topics: idList(p.learn_topics, 'learn_topics', 30, TOPIC_ID_RE),
    speak_topics: idList(p.speak_topics, 'speak_topics', 30, TOPIC_ID_RE),
    linkedin_url: linkedin,
    contact_note: text(p.contact_note, 'contact_note', 120) || null,
  };
}

// The topic ids to store. A topic the stored profile already holds may have been removed from the
// conference's list by a later topics run; it is dropped so the profile can still be saved. Any
// other unknown topic is rejected.
function checkTopics(ctx, ids, name, stored = []) {
  if (!ids.length) return ids;
  const labels = ctx.store.topics().labels;
  const kept = ids.filter((id) => labels.has(id) || !stored.includes(id));
  if (!kept.every((id) => labels.has(id))) throw bad(`${name} contains an unknown topic`);
  return kept.filter((id) => labels.has(id));
}

// The shared talk ids to store. An id of another conference is rejected. An id of this conference
// that is not in its schedule is dropped instead of rejected: a talk the device shared for can leave
// the schedule (a cancelled session or a takedown, removed by the next ingest), and the app sends its
// stored list with every write, so rejecting it would block every profile write until the person
// stopped sharing for everything. The answer echoes the list that was stored, which the app keeps.
function checkSharedTalks(ctx, ids) {
  if (!ids.length) return ids;
  if (!ids.every((id) => id.startsWith(`${ctx.slug}:`))) throw bad('shared_talk_ids must be talks of this conference');
  return ids.filter((id) => ctx.store.talk(id));
}

// The report flags of a profile that is being created: reports outlive the profile row, so a
// profile hidden after reports whose owner deletes it and makes it again is hidden again. Only the
// operator's unhide (which deletes the reports) undoes a hide.
function reportFlags(ctx, ref) {
  const counts = { profile: 0, spot: 0 };
  for (const r of ctx.sql.exec("SELECT target_kind, COUNT(*) AS n FROM reports WHERE target_kind IN ('profile', 'spot') AND target_id = ? GROUP BY target_kind", ref)) {
    counts[r.target_kind] = r.n;
  }
  return { hidden: counts.profile >= HIDE_AT, spot_hidden: counts.spot >= HIDE_AT };
}

async function putProfile(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, PUT_KEYS);
  if (typeof body.open_to_meet !== 'boolean') throw bad('open_to_meet must be a boolean');
  const profile = validateProfile(body.profile);
  const shared = checkSharedTalks(ctx, idList(body.shared_talk_ids, 'shared_talk_ids', 50, TALK_ID_RE));
  const store = ctx.store;
  const own = await ownRow(ctx, device);

  // Both visibility choices off: the profile must not exist, nor anything that connected it.
  if (!body.open_to_meet && !shared.length) {
    if (own) store.deletePersonEverywhere(device.profileId);
    return json(200, { ok: true, open_to_meet: false, shared_talk_ids: [] });
  }

  if (!ctx.conf.visible_until_ms || ctx.conf.visible_until_ms <= ctx.now) throw bad('conference has ended');
  profile.learn_topics = checkTopics(ctx, profile.learn_topics, 'learn_topics', own?.learn_topics ?? []);
  profile.speak_topics = checkTopics(ctx, profile.speak_topics, 'speak_topics', own?.speak_topics ?? []);

  const fields = {
    ...profile,
    open_to_meet: body.open_to_meet,
    sample: false,
    visible_until_ms: ctx.conf.visible_until_ms,
  };
  let p;
  const live = own && store.isLive(own);
  const hashBefore = live ? own.text_hash : null;
  if (live) {
    // Only changed columns are written; the FTS row only when the text changed.
    p = await store.savePerson(device.profileId, fields, { sharedTalkIds: shared });
  } else {
    const flags = reportFlags(ctx, await refFor(ctx.env, ctx.slug, device.profileId));
    p = await store.claim(device, { ...fields, ...flags, shared_talk_ids: shared });
  }
  if (!p) throw new HttpError(409, { error: 'The profile changed at the same time; try again' });
  // Presence needs conference-wide visibility, so turning that off clears it.
  if (!body.open_to_meet && p.presence) store.clearPresence(p.profile_id);

  // A text change is embedded at once. When the AI is unavailable the profile stays saved with its
  // text (the keyword legs find it), text_pending stays set and the cron retries.
  let degraded = false;
  if (p.text_pending && (!live || p.text_hash !== hashBefore)) {
    const r = await store.embedPeople(ctx, [p.profile_id]);
    degraded = r.pending > 0;
  }
  return json(200, {
    ok: true,
    open_to_meet: body.open_to_meet,
    shared_talk_ids: shared,
    hidden_for_owner: p.hidden === true,
    ...(degraded ? { degraded: { semantic: true } } : {}),
  });
}

async function deleteProfile(ctx, req) {
  const device = writer(ctx, req);
  const own = await ownRow(ctx, device);
  if (own) ctx.store.deletePersonEverywhere(device.profileId);
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------------------------
// Matches.

const MATCHES_KEYS = new Set(['event', 'interested_talk_ids', 'query', 'when', 'from', 'size']);

async function matches(ctx, req) {
  const device = requireDevice(req);
  const body = await readJson(req, MATCHES_KEYS);
  const when = body.when === undefined || body.when === null ? 'anyone' : body.when;
  // The Around refresh and the in-app nudge check are timer-driven, and attendees on venue Wi-Fi
  // share a few addresses, so around_now uses the large per-address poll bucket. The per-device
  // bucket stays the read one.
  ctx.limit(when === 'around_now' ? `people-poll:ip:${ctx.ip}` : `people-read:ip:${ctx.ip}`, when === 'around_now' ? LIMITS.pollIp : LIMITS.readIp);
  ctx.limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);
  const interested = idList(body.interested_talk_ids, 'interested_talk_ids', 100, TALK_ID_RE);
  const query = text(body.query, 'query', QUERY_MAX);
  if (when !== 'anyone' && when !== 'around_now') throw bad("when must be 'anyone' or 'around_now'");
  const from = body.from === undefined || body.from === null ? 0 : body.from;
  if (!Number.isInteger(from) || from < 0 || from > MATCHES_FROM_MAX) throw bad(`from must be an integer from 0 to ${MATCHES_FROM_MAX}`);
  const size = body.size === undefined || body.size === null ? MATCHES_SIZE : body.size;
  if (!Number.isInteger(size) || size < 1 || size > MATCHES_SIZE) throw bad(`size must be an integer from 1 to ${MATCHES_SIZE}`);

  const store = ctx.store;
  const me = await store.authenticate(device);
  if (!me || !me.open_to_meet) throw visibilityRequired();

  const { hits: all, degraded } = await rankPeople(ctx, me, { query, when, from, size });
  // Broad matches are dropped from a text search and from the "anyone" view. The "around now" view
  // keeps those who are in the caller's own zone right now, after every specific match.
  const myZone = store.isAround(me) ? me.presence.zone : null;
  const sameZone = (h) => myZone && store.isAround(h.person) && h.person.presence.zone === myZone;
  const specific = all.filter((h) => !h.broad);
  const hits = query || when !== 'around_now' ? specific : [...specific, ...all.filter((h) => h.broad && sameZone(h))];
  // Only talks the caller marked and also shares for are named in a reason (gate 5).
  const mine = new Set(me.shared_talk_ids);
  const used = interested.filter((id) => mine.has(id) && hits.some((h) => h.person.shared_talk_ids.includes(id)));
  const titles = titlesOf(ctx, used);
  const { labels } = store.topics();
  return json(200, {
    results: hits.map((h) => toPerson(ctx, h, me, labels, titles, null, { search: Boolean(query), broad: h.broad })),
    ...(degraded ? { degraded: { semantic: true } } : {}),
    from,
    size,
    has_more: all.length === size,
  });
}

// ---------------------------------------------------------------------------------------------
// Circles.

const COUNTS_KEYS = new Set(['event', 'talk_ids']);

async function counts(ctx, req) {
  ctx.limit(`circles-counts:ip:${ctx.ip}`, LIMITS.publicIp);
  const body = await readJson(req, COUNTS_KEYS);
  const ids = idList(body.talk_ids, 'talk_ids', 100, TALK_ID_RE);
  return json(200, { counts: ids.length ? ctx.store.circleCounts(ids) : {} });
}

const MEMBERS_KEYS = new Set(['event', 'talk_id']);

async function members(ctx, req) {
  const device = reader(ctx, req);
  const body = await readJson(req, MEMBERS_KEYS);
  if (typeof body.talk_id !== 'string' || !TALK_ID_RE.test(body.talk_id)) throw bad('talk_id must be a talk id');
  const talkId = body.talk_id;
  const store = ctx.store;
  const me = await store.authenticate(device);
  const count = store.circleCounts([talkId])[talkId] ?? 0;
  if (!me || !me.shared_talk_ids.includes(talkId)) throw new HttpError(403, { error: 'share_required', count });
  const talk = store.talk(talkId);
  if (!talk) throw new HttpError(404, { error: 'talk not found' });

  const { hits } = await rankPeople(ctx, me, { size: MEMBERS_SIZE, includeEveryone: true, circleTalkId: talkId });
  const titles = new Map([[talkId, talk.title ?? '']]);
  const { labels } = store.topics();
  return json(200, {
    talk: { title: talk.title ?? '', start: talk.start ?? null, end: talk.end ?? null, url: talk.url ?? null },
    speakers: Array.isArray(talk.speaker_profiles) ? talk.speaker_profiles : [],
    count,
    members: hits.map((h) => toPerson(ctx, h, me, labels, titles, talkId)),
  });
}

// ---------------------------------------------------------------------------------------------
// Blocks. A block is symmetric and silent: both people vanish from each other's matches, circles
// and meets, and a meet in either direction gets the same 403 { error: "blocked" } (T4). It belongs
// to the blocker and lasts until the blocker lifts it, deletes their own profile, or it runs out
// (blockExpiry); the blocked person deleting and re-creating their profile does not lift it.

const BLOCK_KEYS = new Set(['event', 'ref']);

function refOf(body) {
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a result reference');
  return body.ref;
}

// When the purge may delete a block: the latest of the conference's end and the visible_until of
// the two profiles, so a block never runs out while either of them can still be found
// (blockExpiry in server/connect.mjs).
function blockExpiry(ctx, me, them) {
  const ends = [ctx.conf?.visible_until_ms, me.visible_until_ms, them.visible_until_ms].filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : me.visible_until_ms;
}

async function block(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, BLOCK_KEYS);
  const ref = refOf(body);
  const me = await requireProfile(ctx, device);
  // A hidden person stays blockable, so the lookup is not limited to visible people.
  const them = liveByRef(ctx, me, ref);
  if (!them) throw notFound();
  const now = Date.now();
  ctx.transactionSync(() => {
    ctx.store.addBlock(me.profile_id, them.profile_id, them.ref, blockExpiry(ctx, me, them));
    // An open meet between the two ends: as a cancellation when the blocker asked, as a decline
    // when the blocker was asked. Its note, meeting point and spot-me lines go with it.
    ctx.sql.exec(
      `UPDATE meets SET state = CASE WHEN requester_id = ? THEN 'cancelled' ELSE 'declined' END, ended_at_ms = ?,
         note = NULL, note_pending = 0, rendezvous = NULL, spot_me = '{}', spot_me_pending = '{}', version = version + 1
       WHERE state IN (${OPEN_MEET_STATES.map(() => '?').join(', ')})
         AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
      me.profile_id, now, ...OPEN_MEET_STATES, me.profile_id, them.profile_id, them.profile_id, me.profile_id,
    );
  });
  return json(200, { ok: true });
}

async function unblock(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, BLOCK_KEYS);
  const ref = refOf(body);
  const me = await requireProfile(ctx, device);
  await ctx.store.removeBlockByRef(me.profile_id, ref);
  return json(200, { ok: true });
}

async function blocks(ctx, req) {
  const device = reader(ctx, req);
  const me = await requireProfile(ctx, device);
  const rows = [];
  // A block outlives the blocked profile; once that profile is gone or has expired, its row keeps
  // the ref (so it can still be lifted) with display_name null.
  for (const r of ctx.store.blocksBy(me.profile_id)) {
    const p = ctx.store.person(r.profile_id);
    const live = p && ctx.store.isLive(p) ? p : null;
    rows.push({ ref: r.ref ?? (await refFor(ctx.env, ctx.slug, r.profile_id)), display_name: live?.display_name ?? null, created_at: iso(r.created_at_ms) });
  }
  return json(200, { refs: rows.map((r) => r.ref), blocks: rows });
}

// ---------------------------------------------------------------------------------------------
// Reports. One report per reporter per target ({kind}:{target}:{reporter}), so sending the same
// report twice is harmless. Two distinct reporters hide the target through store.hideTarget. The
// reporter never learns who else reported; no profile_id or reporter id leaves the object.

const REPORT_KINDS = new Set(['profile', 'meet', 'spot']);
const REASONS = new Set(['harassment', 'hate', 'sexual', 'spam', 'other']);
const REPORT_KEYS = new Set(['event', 'ref', 'context', 'reason']);
const CONTEXT_KEYS = new Set(['kind', 'id']);

function validateReport(body) {
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a result reference');
  if (!isPlainObject(body.context)) throw bad('context must be an object');
  for (const k of Object.keys(body.context)) if (!CONTEXT_KEYS.has(k)) throw bad(`Unknown key: context.${k.slice(0, 40)}`);
  const { kind, id } = body.context;
  if (typeof kind !== 'string' || !REPORT_KINDS.has(kind)) throw bad("context.kind must be 'profile', 'meet' or 'spot'");
  if (typeof id !== 'string') throw bad('context.id must be a string');
  if (kind === 'meet') {
    if (!MEET_ID_RE.test(id)) throw bad('context.id must be a meet id');
  } else if (id !== body.ref) {
    throw bad("context.id must be the reported person's ref");
  }
  if (typeof body.reason !== 'string' || !REASONS.has(body.reason)) throw bad("reason must be 'harassment', 'hate', 'sexual', 'spam' or 'other'");
  return { ref: body.ref, kind, id, reason: body.reason };
}

// The profile_id of the person a report is about. A profile or spot report names them by ref; a
// meet report names a meet the reporter takes part in, whose other participant the ref must be.
async function reportTarget(ctx, me, { ref, kind, id }) {
  if (kind === 'meet') {
    const m = ctx.sql.exec('SELECT requester_id, recipient_id FROM meets WHERE meet_id = ?', id).toArray()[0];
    if (!m || (m.requester_id !== me.profile_id && m.recipient_id !== me.profile_id)) throw notFound();
    const other = m.requester_id === me.profile_id ? m.recipient_id : m.requester_id;
    const otherRef = ctx.store.person(other)?.ref ?? (await refFor(ctx.env, ctx.slug, other));
    if (otherRef !== ref) throw bad('ref must name the other participant of the meet');
    return other;
  }
  // A hidden person stays reportable.
  const them = liveByRef(ctx, me, ref);
  if (!them) throw notFound();
  return them.profile_id;
}

async function report(ctx, req) {
  ctx.limit(`people-write:ip:${ctx.ip}`, LIMITS.writeIp);
  const device = requireDevice(req);
  // 20 reports an hour per device, counted over the rows that exist anyway.
  const since = Date.now() - HOUR_MS;
  const recent = ctx.sql.exec('SELECT COUNT(*) AS n, MIN(created_at_ms) AS first FROM reports WHERE reporter_id = ? AND created_at_ms > ?', device.profileId, since).one();
  if (recent.n >= REPORTS_PER_HOUR) {
    const retry = Math.max(1, Math.ceil((recent.first + HOUR_MS - Date.now()) / 1000));
    throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(retry) });
  }
  const body = await readJson(req, REPORT_KEYS);
  const r = validateReport(body);
  const me = await ctx.store.authenticate(device);
  if (!me) throw profileRequired();
  const profileId = await reportTarget(ctx, me, r);

  ctx.sql.exec(
    `INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    `${r.kind}:${r.id}:${me.profile_id}`, r.kind, r.id, profileId, me.profile_id, r.reason, Date.now(),
  );
  const n = ctx.sql.exec('SELECT COUNT(*) AS n FROM reports WHERE target_kind = ? AND target_id = ?', r.kind, r.id).one().n;
  const hidden = n >= HIDE_AT;
  if (hidden) ctx.store.hideTarget(r.kind, r.id, profileId);
  return json(200, { ok: true, hidden });
}

// ---------------------------------------------------------------------------------------------
// Bluetooth sightings: who, among the tokens this phone heard, is a strong match standing right
// here (docs/contracts/ble-tokens.md, Resolution on the server; the tier 3 server's port is
// server/ble.mjs on the feat/tier3-capabilities-ble branch). Both kinds of token resolve through
// the same steps, and every Phase 4 mitigation applies to both, whichever mode the Worker
// advertises:
//   1. the strongest RSSI per token, dropping those under ble.near_rssi;
//   2. derived tokens through the conference's token table (windows w - 1, w and w + 1), cached in
//      this object per window and rebuilt on a token it cannot find once older than 30 seconds; a
//      token not in the table is tried as a legacy token;
//   3. every hit checked against the store: a derived hit only while the stored nonce still has the
//      table's tag and its master is held, a legacy hit only while its token is live, and both only
//      while the person is around, live, open to meet, not hidden and not the requester;
//   4. co-location: the same zone, or the same or a neighbouring ~100 m cell (3 x 3 cells);
//   5. blocks in either direction, then the matches ranking restricted to these people, keeping
//      the strong (not broad) matches (rankPeople);
//   6. the caps on the final answer, at most 10 new people per token window and 30 per rolling
//      hour for one device, recorded in this object's SQLite (ble_caps), and a zone only for people
//      in the requester's own zone.
// Nothing about a sighting is stored or logged; the caps record names only people the device was
// answered with. The answer carries only what a match card shows, plus the requester's own
// ble_key_id in derived-v1.

const SIGHTINGS_KEYS = new Set(['event', 'sightings']);
const SIGHTING_KEYS = new Set(['token', 'rssi']);

function parseSightings(value) {
  if (!Array.isArray(value) || value.length > MAX_SIGHTINGS) throw bad(`sightings must be an array of at most ${MAX_SIGHTINGS} entries`);
  const heard = new Map();
  for (const s of value) {
    if (!isPlainObject(s)) throw bad('each sighting must be an object');
    for (const k of Object.keys(s)) if (!SIGHTING_KEYS.has(k)) throw bad(`Unknown key: sightings.${k.slice(0, 40)}`);
    if (typeof s.token !== 'string' || !BLE_TOKEN_RE.test(s.token)) throw bad('token must be 16 bytes, base64url');
    if (!Number.isInteger(s.rssi) || s.rssi < RSSI_MIN || s.rssi > RSSI_MAX) throw bad(`rssi must be an integer from ${RSSI_MIN} to ${RSSI_MAX}`);
    const known = heard.get(s.token);
    if (known === undefined || s.rssi > known) heard.set(s.token, s.rssi);
  }
  return heard;
}

const hasLiveToken = (p, now) => Boolean(p.presence?.ble_token) && p.presence.ble_token_until_ms > now;

async function sightings(ctx, req) {
  ctx.limit(`ble-sightings:ip:${ctx.ip}`, SIGHTINGS_PER_MINUTE_IP);
  const device = requireDevice(req);
  ctx.limit(`ble-sightings:dev:${device.profileId}`, SIGHTINGS_PER_MINUTE);
  const body = await readJson(req, SIGHTINGS_KEYS);
  const heard = parseSightings(body.sightings);
  const store = ctx.store;
  const config = bleConfig(ctx.env);
  const me = await store.authenticate(device);
  if (!me || !me.open_to_meet) throw profileRequired();
  const now = Date.now();

  // Only a phone that is itself around with a live Bluetooth session may ask who is near it: a
  // derived session whose master is held, or a live legacy token. A derived session under a
  // retired master asks the device for a new key (403 ble_rekey), unless the session is an old
  // app's: its legacy token is live and was rotated, which only the old APK does, and the old APK
  // does not know ble_rekey. A new app never rotates, so it is asked to re-key at once.
  const session = config.keyring ? derivedSession(me) : null;
  const myKey = keyOfSession(config, session);
  const legacyLive = hasLiveToken(me, now);
  if (!store.isAround(me)) throw new HttpError(403, { error: 'ble_required' });
  if (session && !myKey && !(legacyLive && me.presence.ble_rotated)) throw new HttpError(403, { error: 'ble_rekey' });
  if (!myKey && !legacyLive) throw new HttpError(403, { error: 'ble_required' });
  const answer = (nearby) => json(200, myKey ? { nearby, ble_key_id: keyId(myKey) } : { nearby });

  if (![...heard.values()].some((rssi) => rssi >= config.nearRssi)) return answer([]);

  // Steps 1 to 4 (lib/ble.js resolveTokens): the threshold, the token table (rebuilt once on a
  // token it cannot find, when older than 30 seconds) and the legacy tokens, the store, and
  // co-location. Only people who are live, open to meet, not hidden and around can resolve.
  const current = new Map();
  for (const p of store.people()) {
    if (p.profile_id === me.profile_id || !p.open_to_meet || p.hidden || !store.isAround(p)) continue;
    current.set(p.profile_id, {
      session: derivedSession(p),
      ble_token: p.presence.ble_token,
      ble_token_until_ms: p.presence.ble_token_until_ms,
      presence_until_ms: p.presence.until_ms,
      zone: p.presence.zone ?? null,
      cell: cellOf(store, p),
    });
  }
  let table = null;
  if (config.keyring) {
    const sessions = () => store.people().filter((p) => p.open_to_meet && !p.hidden && store.isAround(p)).map(derivedSession).filter(Boolean);
    table = tableFor(store, config, sessions, now);
    if ([...heard.keys()].some((token) => !table.has(token))) table = tableFor(store, config, sessions, now, { refresh: true });
  }
  const requester = { profile_id: me.profile_id, zone: me.presence.zone ?? null, cell: cellOf(store, me) };
  const ids = resolveTokens(config, { heard, table, current, requester, nowMs: now }).map((h) => h.id);
  if (!ids.length) return answer([]);

  // 5. Blocks, hidden people and the caller are left out by rankPeople; strong matches only.
  const { hits } = await rankPeople(ctx, me, { onlyIds: ids, size: ids.length });
  const { labels } = store.topics();
  // 6. The zone only within the requester's own zone, then the caps on this final list.
  const nearby = hits.filter((h) => !h.broad).map((h) => {
    const p = toPerson(ctx, h, me, labels, new Map(), null);
    const zone = p.zone !== null && p.zone === me.presence.zone ? p.zone : null;
    return { ref: p.ref, display_name: p.display_name, evidence: p.evidence, speak_topics: p.speak_topics, zone };
  });
  if (!nearby.length) return answer([]);
  // Read, applied and written with no await in between, at the time of the read: the object runs
  // one request at a time between awaits, so concurrent reports of one device cannot overrun the caps.
  const t = Date.now();
  const before = store.bleCaps(me.profile_id, t);
  const { kept, state } = applyCaps(nearby, before, { nowMs: t, caps: RESOLVE_CAPS });
  const added = state.entries.slice(before.entries.length);
  if (added.length) store.addBleCaps(me.profile_id, added, t);
  return answer(kept);
}

// ---------------------------------------------------------------------------------------------

const route = (method, path, bucket, handler) => ({ method, path, bucket, fail: FAIL, handler });

export default [
  route('POST', '/api/circles/counts', 'public', counts),
  route('PUT', '/api/people/profile', 'write', putProfile),
  route('DELETE', '/api/people/profile', 'write', deleteProfile),
  route('POST', '/api/people/matches', 'read', matches),
  route('POST', '/api/circles/members', 'read', members),
  route('POST', '/api/people/block', 'write', block),
  route('DELETE', '/api/people/block', 'write', unblock),
  route('GET', '/api/people/blocks', 'read', blocks),
  route('POST', '/api/people/report', 'write', report),
  route('POST', '/api/presence/sightings', 'read', sightings),
];

