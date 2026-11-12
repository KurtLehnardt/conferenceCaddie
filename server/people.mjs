// People and talk circles: the /api/people/* and /api/circles/* endpoints.
//
// Env:
//   ES_URL                shared with the search module.
//   ES_PEOPLE_API_KEY     reads and writes the people index only.
//   ES_API_KEY            the read-only key, used here for conferences, topics and talk titles.
//   ES_PEOPLE_INDEX       default caddie-people.
//   ES_INDEX              talks, default caddie-talks.
//   ES_TOPICS_INDEX       default caddie-topics.
//   ES_CONFERENCES_INDEX  default caddie-conferences.
//   ES_PEOPLE_BLOCKS_INDEX default caddie-people-blocks (who blocked whom).
//   ES_PEOPLE_MEETS_INDEX default caddie-people-meets (ask to talk shop).
//   ES_PEOPLE_PUSH_INDEX  default caddie-people-push (Web Push subscriptions and native push
//                         registrations, push.mjs).
//   ES_PEOPLE_NUDGES_INDEX default caddie-people-nudges (nudges sent, nudge.mjs).
//   REF_SALT              optional salt for the opaque result reference.
//   PEOPLE_SEMANTIC_MIN_SIMILARITY, PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY and
//   PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY the lowest cosine similarity a semantic people leg keeps in
//                         a search, in matches without a query, and in the nudge and Bluetooth
//                         sightings (defaults 0.82, 0.84 and 0.87, measured for caddie-e5-small;
//                         "off" for no floor; see SEMANTIC_FLOORS).
//
// Rules this module keeps:
// - Elasticsearch does all matching, ranking and filtering. People are ranked by one rrf
//   retriever; this module only builds queries and reshapes hits in the order returned. The
//   reasons shown with a result are built from the topic lists and titles of that result, which
//   explains a rank but never changes it. The one exception is the specificity rule in matches:
//   a person whose only link to the requester is a topic the whole conference shares is a broad
//   match, left out of a text search, and shown in the "around now" view only when both are in
//   the same zone, after the specific matches of the page.
// - A people document exists only while its owner is visible conference-wide or shares for at
//   least one talk. The one exception is transient: a delete first hides the document
//   (open_to_meet false, no shared talk, presence off) and removes it last, so a delete that fails
//   part-way leaves it hidden until a retry or the hourly purge finishes the delete
//   (isPendingDelete). Every people query filters on event_id and on visible_until > now, and
//   leaves out anyone the requester has blocked or who has blocked the requester.
// - secret_hash, text_hash and profile_id are never returned; results carry ref instead, which
//   is also stored on the document so a block or a meet request can name a person by it.
//   Request bodies, headers, profile fields and secrets are never logged; the log lines here name
//   an Elasticsearch status, a count, or a conference slug and a number of legs (warnRarely).
// - Writes whose about, interests and expertise are unchanged use a Bulk API partial update that
//   omits those fields, so toggling visibility, sharing or presence never re-runs the model.
// - Presence (zone, spot, since, until, and an optional rounded location with its accuracy, the
//   centre of its ~100 m cell and the time of the fix) lives on the people document and is
//   returned to another person only while both are around. The location itself is returned to
//   nobody and never read for anyone but its owner outside a meet: ranking (a distance_feature
//   leg) and the band on a result (same_zone, near, around, venue) use only the cells, so no
//   sequence of positions a requester claims can measure anyone more finely than a cell; only an
//   active meet learns a distance and a bearing, from the precise fixes (connect.mjs). Meets and
//   the blocks the person made are deleted with the profile; blocks others made of the person
//   stay until the conference ends, so deleting and re-creating a profile never lifts a block.
//
// The block, presence and meet routes themselves are in connect.mjs, which uses the transport,
// plumbing and lookups exported here.

import crypto from 'node:crypto';
import { take, clientIp } from './ratelimit.mjs';
import { parseDevice, hashSecret, secretMatches, refFor } from './device.mjs';
import { CONFERENCES_PREFERENCE, PEOPLE_PURGE_PREFERENCE, conferencePreference, peoplePreference, withPreference } from './preference.mjs';
import { pauseSemantic, semanticAvailable, isInferenceFailure, esErrorInfo } from './semantic.mjs';
import { reportCountsFor, HIDE_AT } from './report.mjs';
import { PRESENCE_OFF, BLE_SESSION_OFF, BLE_CAPS_OFF, EXPIRED_CAPS_QUERY, PENDING_DELETE_QUERY, isPendingDelete, visibleUntil, dayBounds } from './people-shared.mjs';
import { createProfileDelete, ownBlocksQuery } from './people-delete.mjs';

// Re-exported, so the other server modules and the scripts that import them from here keep working.
export { PRESENCE_OFF, BLE_SESSION_OFF, BLE_CAPS_OFF, EXPIRED_CAPS_QUERY, PENDING_DELETE_QUERY, isPendingDelete, visibleUntil, dayBounds };

import { ES_URL } from './es-url.mjs';
const PEOPLE_KEY = process.env.ES_PEOPLE_API_KEY || '';
const READ_KEY = process.env.ES_API_KEY || '';
export const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
export const BLOCKS_INDEX = process.env.ES_PEOPLE_BLOCKS_INDEX || 'caddie-people-blocks';
export const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
export const PUSH_INDEX = process.env.ES_PEOPLE_PUSH_INDEX || 'caddie-people-push';
export const NUDGES_INDEX = process.env.ES_PEOPLE_NUDGES_INDEX || 'caddie-people-nudges';
const TALKS_INDEX = process.env.ES_INDEX || 'caddie-talks';
const TOPICS_INDEX = process.env.ES_TOPICS_INDEX || 'caddie-topics';
const CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const ES_TIMEOUT_MS = 10_000;

const MAX_BODY = 8192;
const CONFERENCES_TTL_MS = 60_000;
const TOPICS_TTL_MS = 10 * 60_000;
const ZONES_TTL_MS = 10 * 60_000;
const MATCHES_SIZE = 20;
const MATCHES_FROM_MAX = 1000;
const MEMBERS_SIZE = 50;
const RANK_WINDOW = 100;
const KNN_K = 100;
const KNN_CANDIDATES = 500;
const PASSAGE_MAX = 200;
const EVIDENCE_FALLBACK = 160;
const QUERY_MAX = 300;
const COMMON_TOPICS = 10;
const BLOCKS_MAX = 1000;

// The lowest cosine similarity a semantic people leg keeps, passed as the knn query's `similarity`
// (Elasticsearch compares it with the raw cosine of a profile's best chunk, not with the score).
// Without it a knn leg returns the k nearest profiles whatever their score, and with the E5 small
// model that is nearly everyone: on 2026-11-10 the best of the 132 KubeCon sample profiles scored
// 0.79 to 0.83 against the smoke's made-up text, which none of them has anything to do with, while
// the profiles written with that text scored 0.88 to 0.94. Every profile joined every semantic
// leg, so anyone who also shared a common topic outranked the one person whose text matched.
//
// The floor depends on who asked (DECISIONS.md has the measurements):
// - search, 0.82: a search with a query, which also has the keyword leg. Short tool names score
//   low against whole profiles ("Kyverno" reached 0.823 at best on a profile that names it), so
//   the floor stays low and the keyword leg finds the exact names.
// - profile, 0.84: matches without a query and circle members, which rank by the requester's own
//   interests and expertise with no keyword leg behind them. 0.84 kept a relevant profile for each
//   of ten realistic interests and left out all but 29 of 943 unrelated pairs.
// - push, 0.87: the push nudge (nudge.mjs) and Bluetooth sightings (ble.mjs), which reach a person
//   who did not search, so a text leg must be close to count as a specific match there. A generic
//   text ("Kubernetes, cloud native platforms and AI") reached 109 of 131 sample profiles at 0.84
//   and 26 at 0.87.
// The values belong to the model behind the people index's semantic_text fields: a new inference
// endpoint needs a new measurement. Each can be set, or turned off, through its variable.
const FLOOR_SETTINGS = [
  ['search', 'PEOPLE_SEMANTIC_MIN_SIMILARITY', 0.82],
  ['profile', 'PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY', 0.84],
  ['push', 'PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY', 0.87],
];

/**
 * A floor variable's value: { floor, warning }. Unset or empty gives the fallback; "off", "none"
 * and "false" give null (no floor); a number is clamped to -1..1. warning says why a set value was
 * not used as given, and never quotes it.
 */
export function floorFrom(value, fallback) {
  const v = value === undefined || value === null ? '' : String(value).trim().toLowerCase();
  if (v === '') return { floor: fallback, warning: null };
  if (v === 'off' || v === 'none' || v === 'false') return { floor: null, warning: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { floor: fallback, warning: `is not a number or "off", so ${fallback} applies` };
  const floor = Math.min(1, Math.max(-1, n));
  return { floor, warning: floor === n ? null : `is outside -1..1, so ${floor} applies` };
}

/** The floors in effect, read once at start: { search, profile, push }, each a cosine or null. */
export const SEMANTIC_FLOORS = Object.freeze(Object.fromEntries(FLOOR_SETTINGS.map(([path, name, fallback]) => {
  const { floor, warning } = floorFrom(process.env[name], fallback);
  if (warning) console.warn(`${name} ${warning}.`);
  return [path, floor];
})));

/** One line for the start-up log that names the floors in effect. */
export function semanticFloorsLine() {
  const f = (v) => (v === null ? 'off' : String(v));
  return `semantic people floors: search ${f(SEMANTIC_FLOORS.search)}, matches ${f(SEMANTIC_FLOORS.profile)}, nudge and Bluetooth ${f(SEMANTIC_FLOORS.push)}`;
}

// Zones a person can say they are in, besides the conference's room names.
export const FIXED_ZONES = ['Expo hall', 'Registration', 'Food and coffee', 'Hallway', 'Outside'];

export const LIMITS = {
  writeDevice: 20,
  writeIp: 60,
  readDevice: 30,
  readIp: 90,
  // The inbox and meet polls (every 20 and 10 seconds per device), kept apart from the read
  // buckets so that many attendees behind one venue address do not starve searches.
  pollDevice: 30,
  pollIp: 1200,
  publicIp: 60,
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;
export const REF_RE = /^[0-9a-f]{16}$/;

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error ?? 'error');
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
// An Elasticsearch request that failed. The message names a status or an error class and is the
// only part that is logged; details carry `status`, and the error `types` and `inferenceReason`
// of esErrorInfo (semantic.mjs) so a caller can tell an inference failure from anything else.
export class UpstreamError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.status = details.status ?? null;
    this.types = details.types ?? [];
    this.inferenceReason = details.inferenceReason === true;
  }
}

export const bad = (message) => new HttpError(400, { error: message });
export const forbidden = () => new HttpError(403, { error: 'forbidden' });

// ---------------------------------------------------------------------------------------------
// Elasticsearch transport. Error bodies from Elasticsearch are never passed on or logged; an
// error response is read only for its status and error types (esErrorInfo).

async function es(key, method, path, body, { ndjson = false, okStatuses = [] } = {}) {
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method,
      headers: {
        Authorization: `ApiKey ${key}`,
        'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json',
      },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(ES_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(err?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    let info = {};
    try {
      info = esErrorInfo((await res.json())?.error);
    } catch {
      // Not JSON, or the body could not be read: the status alone.
    }
    throw new UpstreamError(`status ${res.status}`, { status: res.status, ...info });
  }
  try {
    return { status: res.status, json: await res.json() };
  } catch {
    throw new UpstreamError('invalid response');
  }
}

export const people = (method, path, body, opts) => es(PEOPLE_KEY, method, path, body, opts);
const readOnly = (method, path, body, opts) => es(READ_KEY, method, path, body, opts);
export const idx = (name) => `/${encodeURIComponent(name)}`;
export const docId = (eventId, profileId) => `${eventId}:${profileId}`;

// Profiles are stored only until their conference ends. Queries already hide a document once its
// visible_until has passed; this deletes it as well. It runs when the server starts, which covers
// every cold start, and then once an hour while an instance stays up. A document without
// visible_until is never live, so it is deleted too. The same pass clears presence that has
// expired (a Bulk partial update of the presence fields, so nothing is re-embedded) and
// deletes meets whose expires_at has passed. A declined meet is the evidence for the daily
// "Not now" pause, so it is kept until its day is over (two days after ended_at, which covers a
// 25-hour day); once it has run out, its note, meeting point and spot-me lines are scrubbed. Then
// it deletes push subscriptions, nudge records and blocks whose expires_at (the end of their
// conference) has passed. Before all of that it finishes profile deletes that hid a profile and
// then failed (finishPendingDeletes). The purge CLI runs the same steps.
const PURGE_INTERVAL_MS = 60 * 60_000;
const PURGE_PRESENCE_PAGE = 500;
const PURGE_PENDING_PAGE = 100;
const PURGE_PENDING_PAGES = 50;
const PENDING_DELETE_SORT = [{ updated_at: 'asc' }, { profile_id: 'asc' }];
export const EXPIRED_PEOPLE_QUERY = {
  bool: {
    should: [{ range: { visible_until: { lt: 'now' } } }, { bool: { must_not: { exists: { field: 'visible_until' } } } }],
    minimum_should_match: 1,
  },
};
export const EXPIRED_PRESENCE_QUERY = { range: { presence_until: { lt: 'now' } } };
export const EXPIRED_MEETS_QUERY = {
  bool: {
    should: [
      { bool: { filter: [{ range: { expires_at: { lt: 'now' } } }], must_not: [{ term: { state: 'declined' } }] } },
      { bool: { filter: [{ term: { state: 'declined' } }, { range: { expires_at: { lt: 'now' } } }], must_not: [{ range: { ended_at: { gte: 'now-2d' } } }] } },
    ],
    minimum_should_match: 1,
  },
};
// Declined meets that have run out but are still kept for the pause: their requester-visible
// fields are cleared. A meet that is already clear is left untouched.
export const RUN_OUT_DECLINED_QUERY = { bool: { filter: [{ term: { state: 'declined' } }, { range: { expires_at: { lt: 'now' } } }] } };
export const SCRUB_MEET_SCRIPT = {
  lang: 'painless',
  source: "if (ctx._source.note == null && ctx._source.rendezvous == null && (ctx._source.spot_me == null || ctx._source.spot_me.isEmpty()) && (ctx._source.spot_me_pending == null || ctx._source.spot_me_pending.isEmpty()) && ctx._source.note_pending != true) { ctx.op = 'noop'; } else { ctx._source.note = null; ctx._source.rendezvous = null; ctx._source.spot_me = [:]; ctx._source.spot_me_pending = [:]; ctx._source.note_pending = false; }",
};
export const EXPIRED_AT_QUERY = { range: { expires_at: { lt: 'now' } } };

// Exported for the tests.
export async function purgeExpired() {
  if (!PEOPLE_KEY) return;
  try {
    await finishPendingDeletes();
  } catch (err) {
    console.error(`Finishing pending profile deletes failed: ${err.message}`);
  }
  try {
    const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_delete_by_query?conflicts=proceed`, {
      query: EXPIRED_PEOPLE_QUERY,
    });
    if (json.deleted) console.log(`Deleted ${json.deleted} expired people profiles.`);
  } catch (err) {
    console.error(`Deleting expired people profiles failed: ${err.message}`);
  }
  try {
    const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search`, PEOPLE_PURGE_PREFERENCE), {
      size: PURGE_PRESENCE_PAGE,
      _source: false,
      query: EXPIRED_PRESENCE_QUERY,
    });
    const ids = (json.hits?.hits ?? []).map((h) => h._id);
    if (ids.length) {
      const body = ids.map((id) => `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc: PRESENCE_OFF })}\n`).join('');
      await people('POST', `${idx(PEOPLE_INDEX)}/_bulk`, body, { ndjson: true });
      console.log(`Cleared ${ids.length} expired presence entries.`);
    }
  } catch (err) {
    console.error(`Clearing expired presence failed: ${err.message}`);
  }
  // Bluetooth caps records whose newest entry has left the rolling hour (ble.mjs). Each clear is
  // guarded by the sequence number the search returned, so a record that a sightings answer wrote
  // after the search is kept; the next run finds it again once it has run out.
  try {
    const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search?seq_no_primary_term=true`, PEOPLE_PURGE_PREFERENCE), {
      size: PURGE_PRESENCE_PAGE,
      _source: false,
      query: EXPIRED_CAPS_QUERY,
    });
    const hits = (json.hits?.hits ?? []).filter((h) => Number.isInteger(h._seq_no) && Number.isInteger(h._primary_term));
    if (hits.length) {
      const body = hits.map((h) => `${JSON.stringify({ update: { _id: h._id, if_seq_no: h._seq_no, if_primary_term: h._primary_term } })}\n${JSON.stringify({ doc: BLE_CAPS_OFF })}\n`).join('');
      const { json: result } = await people('POST', `${idx(PEOPLE_INDEX)}/_bulk`, body, { ndjson: true });
      const cleared = (result.items ?? []).filter((i) => i.update?.status >= 200 && i.update?.status <= 299).length;
      if (cleared) console.log(`Cleared ${cleared} run-out Bluetooth caps records.`);
    }
  } catch (err) {
    console.error(`Clearing run-out Bluetooth caps records failed: ${err.message}`);
  }
  try {
    const { json } = await people('POST', `${idx(MEETS_INDEX)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, {
      query: EXPIRED_MEETS_QUERY,
    });
    if (json.deleted) console.log(`Deleted ${json.deleted} expired meets.`);
  } catch (err) {
    console.error(`Deleting expired meets failed: ${err.message}`);
  }
  try {
    const { json } = await people('POST', `${idx(MEETS_INDEX)}/_update_by_query?conflicts=proceed&ignore_unavailable=true`, {
      query: RUN_OUT_DECLINED_QUERY,
      script: SCRUB_MEET_SCRIPT,
    });
    if (json.updated) console.log(`Scrubbed ${json.updated} run-out declined meets.`);
  } catch (err) {
    console.error(`Scrubbing run-out declined meets failed: ${err.message}`);
  }
  // A block without expires_at matches nothing here and stays; npm run people:setup gives one to
  // every block written before blocks carried it, when it can find the block's conference.
  for (const [name, what] of [[PUSH_INDEX, 'push subscriptions'], [NUDGES_INDEX, 'nudge records'], [BLOCKS_INDEX, 'blocks']]) {
    try {
      const { json } = await people('POST', `${idx(name)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, {
        query: EXPIRED_AT_QUERY,
      });
      if (json.deleted) console.log(`Deleted ${json.deleted} expired ${what}.`);
    } catch (err) {
      console.error(`Deleting expired ${what} failed: ${err.message}`);
    }
  }
}

purgeExpired();
setInterval(purgeExpired, PURGE_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------------------------
// Conferences, topics and talks (read-only key).

let conferencesCache = null; // { at, promise }

async function fetchConferences() {
  const { json } = await readOnly('POST', withPreference(`${idx(CONFERENCES_INDEX)}/_search`, CONFERENCES_PREFERENCE), {
    size: 500,
    _source: ['slug', 'status', 'end_date', 'time_zone'],
    query: { match_all: {} },
  });
  const map = new Map();
  for (const h of json.hits?.hits ?? []) if (h._source?.slug) map.set(h._source.slug, h._source);
  return map;
}

function conferences() {
  const now = Date.now();
  if (!conferencesCache || now - conferencesCache.at > CONFERENCES_TTL_MS) {
    const promise = fetchConferences();
    conferencesCache = { at: now, promise };
    promise.catch(() => {
      if (conferencesCache?.promise === promise) conferencesCache = null;
    });
  }
  return conferencesCache.promise;
}


// Returns { slug, visibleUntil, timeZone } for a searchable conference, or throws 400.
export async function conferenceFor(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('event must be a conference slug');
  const conf = (await conferences()).get(slug);
  if (!conf || conf.status !== 'searchable' || !conf.end_date) throw bad('conference is not available');
  return { slug, visibleUntil: visibleUntil(conf.end_date, conf.time_zone), timeZone: conf.time_zone || null };
}

const topicsCache = new Map(); // slug -> { at, promise }

// Every topic of a conference: labels by id, and the ids of the ten topics on the most talks,
// which match so many people that an overlap on one of them alone says little.
async function fetchTopics(slug) {
  const { json } = await readOnly('POST', withPreference(`${idx(TOPICS_INDEX)}/_search`, conferencePreference(slug)), {
    size: 1000,
    _source: ['topic_id', 'label', 'talk_count'],
    query: { term: { conference: slug } },
    sort: [{ talk_count: 'desc' }, { topic_id: 'asc' }],
  });
  const labels = new Map();
  const common = new Set();
  for (const h of json.hits?.hits ?? []) {
    const s = h._source ?? {};
    if (!s.topic_id) continue;
    labels.set(s.topic_id, s.label ?? s.topic_id);
    if (common.size < COMMON_TOPICS) common.add(s.topic_id);
  }
  return { labels, common };
}

// { labels: Map topic_id -> label, common: Set of topic ids } for one conference, cached for
// ten minutes.
export function topicsOf(slug) {
  const now = Date.now();
  const hit = topicsCache.get(slug);
  if (hit && now - hit.at <= TOPICS_TTL_MS) return hit.promise;
  const promise = fetchTopics(slug);
  topicsCache.set(slug, { at: now, promise });
  promise.catch(() => {
    if (topicsCache.get(slug)?.promise === promise) topicsCache.delete(slug);
  });
  return promise;
}

export const topicLabels = (slug) => topicsOf(slug).then((t) => t.labels);

const zonesCache = new Map(); // slug -> { at, promise }

// The conference's room names, from its talks, plus the fixed zones.
async function fetchZones(slug) {
  const { json } = await readOnly('POST', withPreference(`${idx(TALKS_INDEX)}/_search`, conferencePreference(slug)), {
    size: 0,
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }] } },
    aggs: { rooms: { terms: { field: 'room', size: 200 } } },
  });
  const rooms = (json.aggregations?.rooms?.buckets ?? []).map((b) => String(b.key).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return new Set([...FIXED_ZONES, ...rooms]);
}

// The Set of zones a person at this conference can be in, cached for ten minutes.
export function zonesFor(slug) {
  const now = Date.now();
  const hit = zonesCache.get(slug);
  if (hit && now - hit.at <= ZONES_TTL_MS) return hit.promise;
  const promise = fetchZones(slug);
  zonesCache.set(slug, { at: now, promise });
  promise.catch(() => {
    if (zonesCache.get(slug)?.promise === promise) zonesCache.delete(slug);
  });
  return promise;
}

// Talks of one conference by id, kind "talk" only. Returns a Map talk_id -> _source.
async function talksById(slug, ids, fields) {
  if (!ids.length) return new Map();
  const { json } = await readOnly('POST', withPreference(`${idx(TALKS_INDEX)}/_search`, conferencePreference(slug)), {
    size: ids.length,
    _source: ['talk_id', ...fields],
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }, { terms: { talk_id: ids } }] } },
  });
  const map = new Map();
  for (const h of json.hits?.hits ?? []) map.set(h._source?.talk_id ?? h._id, h._source ?? {});
  return map;
}

// ---------------------------------------------------------------------------------------------
// Request plumbing.

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function limit(key, perWindow, windowMs) {
  const r = take(key, perWindow, windowMs);
  if (!r.ok) throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(r.retryAfterSec) });
}

// A browser always sends Origin on these methods; it must name this host. curl sends none.
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let ok = false;
  try {
    const u = new URL(origin);
    ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.host === req.headers.host;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, { error: 'cross-origin request' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, { error: 'Request body is too large' }, { Connection: 'close' });
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(tooLarge());
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(tooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        reject(bad('Could not read the request body'));
      }
    });
  });
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function jsonBody(req, allowedKeys) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, { error: 'Content-Type must be application/json' });
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bad('Malformed JSON');
  }
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!allowedKeys.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  return body;
}

export function requireDevice(req) {
  const device = parseDevice(req);
  if (!device) throw forbidden();
  return device;
}

// ---------------------------------------------------------------------------------------------
// Validation.

export function text(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${name} must be a string`);
  const t = value.replace(/\r\n?/g, '\n').trim();
  if (t.length > max) throw bad(`${name} must be at most ${max} characters`);
  if (required && !t.length) throw bad(`${name} is required`);
  return t;
}

function idList(value, name, max, re) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((v) => typeof v === 'string' && re.test(v))) {
    throw bad(`${name} must be an array of at most ${max} ids`);
  }
  return [...new Set(value)];
}

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

// Returns the topic ids to store. A topic the stored profile already holds may have been removed
// from the conference's list by a later topics run; it is dropped, so the profile can still be
// saved. Any other unknown topic is rejected.
async function checkTopics(slug, ids, name, stored = []) {
  if (!ids.length) return ids;
  const labels = await topicLabels(slug);
  const kept = ids.filter((id) => labels.has(id) || !stored.includes(id));
  if (!kept.every((id) => labels.has(id))) throw bad(`${name} contains an unknown topic`);
  return kept.filter((id) => labels.has(id));
}

async function checkSharedTalks(slug, ids) {
  if (!ids.length) return;
  if (!ids.every((id) => id.startsWith(`${slug}:`))) throw bad('shared_talk_ids must be talks of this conference');
  const found = await talksById(slug, ids, []);
  if (found.size !== ids.length) throw bad('shared_talk_ids contains an unknown talk');
}

// The hash that tells whether a write changes the embedded text. The seed script uses it too.
export const textHash = (p) => crypto.createHash('sha256').update(JSON.stringify([p.about, p.interests, p.expertise]), 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------
// People documents (people key).

const PRESENCE_FIELDS = ['presence_zone', 'presence_spot', 'presence_spot_pending', 'presence_since', 'presence_until', 'presence_location', 'presence_accuracy', 'presence_cell', 'presence_located_at'];
// The Bluetooth session of ble.mjs (the legacy token and whether it was rotated, the derived-token
// nonce and the id of its master) and the record of whom Bluetooth answers returned (ble_caps and
// ble_caps_until). The owner's own document carries them; they are never returned, and only ble.mjs
// reads them on another person's document, to check a sighted token against the store.
const BLE_FIELDS = ['ble_token', 'ble_token_until', 'ble_rotated', 'presence_nonce', 'ble_master_id', 'ble_caps', 'ble_caps_until'];
const OWN_FIELDS = ['secret_hash', 'text_hash', 'text_pending', 'sample', 'open_to_meet', 'shared_talk_ids', 'visible_until', 'learn_topics', 'speak_topics', 'interests', 'expertise', 'display_name', 'hidden', 'spot_hidden', ...PRESENCE_FIELDS, ...BLE_FIELDS];
// What one participant of a meet, or a blocked person, may learn about the other.
const OTHER_FIELDS = ['profile_id', 'display_name', 'about', 'open_to_meet', 'shared_talk_ids', 'visible_until', 'sample', 'hidden', ...PRESENCE_FIELDS];

// Returns { found, source, seqNo, primaryTerm } for the caller's own document.
export async function ownDoc(eventId, profileId) {
  const { status, json } = await people(
    'GET',
    `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(docId(eventId, profileId))}?_source_includes=${OWN_FIELDS.join(',')}`,
    undefined,
    { okStatuses: [404] },
  );
  if (status === 404 || !json.found) return { found: false };
  return { found: true, source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term };
}

export const isLive = (source) => typeof source.visible_until === 'string' && Date.parse(source.visible_until) > Date.now();
// True while the person has said they are around and that has not run out.
export const isAround = (source) => typeof source.presence_until === 'string' && Date.parse(source.presence_until) > Date.now();

// ---------------------------------------------------------------------------------------------
// Positions. A stored location is { lat, lon } rounded to 5 decimals (about a metre), stored with
// presence_cell, the centre of the ~100 m grid cell it falls in (cellFor), in the same write. The
// precise location is read only inside an active meet, for a distance and a bearing between its
// two participants (connect.mjs). Everything a stranger can observe, the band on a result and the
// order the distance leg gives, comes from cells alone, so a requester who claims any positions
// they like learns at most which cell someone is in, never where in it.

// The grid: latitude snapped to 0.001 degrees (about 111 m), longitude to the step that spans the
// same distance at the snapped latitude, so the cells of one row are about square.
export const CELL_DEG = 0.001;
const CELL_DECIMALS = 6;
// Cell centres closer than this make two people 'around' each other; the same cell is 'near'.
export const PROXIMITY_AROUND_M = 300;
const EARTH_RADIUS_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;
const roundCell = (v) => Number(v.toFixed(CELL_DECIMALS));

// The centre of the grid cell a position falls in, as { lat, lon }.
export function cellFor({ lat, lon }) {
  const cLat = Math.max(-90, Math.min(90, Math.round(lat / CELL_DEG) * CELL_DEG));
  // Near a pole the longitude step is capped at one degree.
  const lonStep = CELL_DEG / Math.max(Math.cos(rad(cLat)), CELL_DEG);
  let cLon = Math.round(lon / lonStep) * lonStep;
  if (cLon > 180) cLon -= 360;
  if (cLon < -180) cLon += 360;
  return { lat: roundCell(cLat), lon: roundCell(cLon) };
}

// The cell of a person who is around and opted in to a position, else null.
export function cellOf(source) {
  if (!isAround(source)) return null;
  const c = source.presence_cell;
  if (!c || typeof c !== 'object' || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  return { lat: c.lat, lon: c.lon };
}

// The precise location of a person who is around and opted in, else null. Read only for the
// owner's own document and for the two participants of an active meet (connect.mjs).
export function locationOf(source) {
  if (!isAround(source)) return null;
  const l = source.presence_location;
  if (!l || typeof l !== 'object' || !Number.isFinite(l.lat) || !Number.isFinite(l.lon)) return null;
  return { lat: l.lat, lon: l.lon };
}

// Great-circle distance in metres (haversine).
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, 0 to 360 degrees clockwise from north.
export function bearingDeg(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// The band between two people who are both around: the same zone first; then, when both have a
// cell, 'near' for the same cell and 'around' for cell centres under 300 m apart; else the venue
// as a whole. Never a number, and never from a precise location.
export function proximityBand(me, them) {
  if (me.presence_zone && me.presence_zone === them.presence_zone) return 'same_zone';
  const a = cellOf(me);
  const b = cellOf(them);
  if (!a || !b) return 'venue';
  if (a.lat === b.lat && a.lon === b.lon) return 'near';
  if (distanceM(a, b) < PROXIMITY_AROUND_M) return 'around';
  return 'venue';
}

// One bulk action on the people index with refresh=wait_for. Returns the item's { status, error }:
// the item status (500 when the answer has none) and its Elasticsearch error object, if any, which
// is read for its types only (esErrorInfo) and never logged.
async function bulkItem(action, doc, { refresh = true } = {}) {
  const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_bulk${refresh ? '?refresh=wait_for' : ''}`, body, { ndjson: true });
  const item = json.items?.[0] ?? {};
  const result = Object.values(item)[0] ?? {};
  return { status: result.status ?? 500, error: result.error };
}

// One bulk action on the people index, with refresh=wait_for unless refresh is false. Returns the
// item status.
export async function bulkOne(action, doc, { refresh = true } = {}) {
  return (await bulkItem(action, doc, { refresh })).status;
}

// Deletes one people document and returns the status (404 when it was already gone). With a
// guard ({ seqNo, primaryTerm }) the delete applies only while the document is unchanged since it
// was read, and answers 409 otherwise.
async function deleteDoc(id, guard = null) {
  const cas = guard ? `&if_seq_no=${guard.seqNo}&if_primary_term=${guard.primaryTerm}` : '';
  const { status } = await people('DELETE', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(id)}?refresh=wait_for${cas}`, undefined, { okStatuses: guard ? [404, 409] : [404] });
  return status;
}

// Other people's documents by profile id, as a Map profile_id -> source limited to OTHER_FIELDS.
// Missing documents are left out, and so are profiles whose delete has not finished yet
// (isPendingDelete): a meet or a block list shows such a person as gone.
export async function peopleByIds(eventId, profileIds) {
  const ids = [...new Set(profileIds)].filter((id) => typeof id === 'string' && id);
  if (!ids.length) return new Map();
  // The _mget body takes _source per document only; a top-level _source is refused with a 400.
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_mget`, {
    docs: ids.map((id) => ({ _id: docId(eventId, id), _source: OTHER_FIELDS })),
  });
  const map = new Map();
  for (const d of json.docs ?? []) if (d.found && d._source?.profile_id && !isPendingDelete(d._source)) map.set(d._source.profile_id, d._source);
  return map;
}

// The live document a result's ref points at, limited to OTHER_FIELDS, or null.
export async function docByRef(eventId, ref) {
  const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(eventId)), {
    size: 1,
    _source: OTHER_FIELDS,
    query: { bool: { filter: [{ term: { event_id: eventId } }, { term: { ref } }, { range: { visible_until: { gt: 'now' } } }] } },
  });
  const s = json.hits?.hits?.[0]?._source;
  return s?.profile_id ? s : null;
}

// The person a result's ref points at, or null. Only someone the requester could have seen
// qualifies: visible conference-wide, or sharing a talk the requester also shares for, and not
// hidden after reports. docByRef stays unfiltered: a hidden person must stay blockable and
// reportable.
export async function personByRef(me, ref) {
  const s = await docByRef(me.event_id, ref);
  if (!s || s.profile_id === me.profile_id) return null;
  if (s.hidden === true) return null;
  const mine = new Set(me.shared_talk_ids ?? []);
  if (s.open_to_meet !== true && !(s.shared_talk_ids ?? []).some((id) => mine.has(id))) return null;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Blocks. A block is one document per direction; every people query leaves out both directions.
// A block belongs to its blocker: it goes with the blocker's profile, with an unblock, or with
// the purge once its expires_at (the end of the conference) has passed. The blocked person's
// delete leaves it in place, so a profile re-created from the same device (the same profile_id)
// is still blocked.

export const blockId = (eventId, blockerId, blockedId) => `${eventId}:${blockerId}:${blockedId}`;

// The profile ids this person has blocked or been blocked by, at one conference.
export async function blockedIds(eventId, profileId) {
  const { json } = await people('POST', withPreference(`${idx(BLOCKS_INDEX)}/_search?ignore_unavailable=true`, peoplePreference(eventId)), {
    size: BLOCKS_MAX,
    _source: ['blocker_id', 'blocked_id'],
    query: {
      bool: {
        filter: [{ term: { event_id: eventId } }],
        should: [{ term: { blocker_id: profileId } }, { term: { blocked_id: profileId } }],
        minimum_should_match: 1,
      },
    },
  });
  const ids = new Set();
  for (const h of json.hits?.hits ?? []) {
    const s = h._source ?? {};
    ids.add(s.blocker_id === profileId ? s.blocked_id : s.blocker_id);
  }
  ids.delete(undefined);
  return ids;
}

// True when either person has blocked the other.
export async function blockedBetween(eventId, a, b) {
  const { json } = await people('POST', `${idx(BLOCKS_INDEX)}/_mget`, {
    docs: [blockId(eventId, a, b), blockId(eventId, b, a)].map((id) => ({ _id: id, _source: false })),
  }, { okStatuses: [404] });
  return (json.docs ?? []).some((d) => d.found);
}

// The filter clause that hides blocked pairs from a people query.
const notBlocked = (eventId, ids) => (ids.size ? [{ ids: { values: [...ids].map((id) => docId(eventId, id)) } }] : []);

// The profile delete lives in server/people-delete.mjs, a module with no side effect at import
// that the caddie-admin CLI (scripts/caddie-admin.mjs) runs too with the operator's admin key,
// so one implementation serves DELETE /api/people/profile, the profile write with both choices
// off, and the operator's delete, and test/delete-profile.test.mjs is the one oracle for the
// order and the retry safety. It is built here with this module's transport.
const errorText = (err) => (err instanceof UpstreamError ? err.message : (err?.name ?? 'error'));
const profileDelete = createProfileDelete({
  people,
  bulkOne,
  deleteDoc,
  withPreference,
  peoplePreference,
  indices: { people: PEOPLE_INDEX, meets: MEETS_INDEX, push: PUSH_INDEX, nudges: NUDGES_INDEX, blocks: BLOCKS_INDEX },
  UpstreamError,
  log: (message) => console.error(message),
});
const { deleteMeetsPushAndNudges, deleteOwnBlocks, deleteProfileAndConnections } = profileDelete;
// Exported as before, for connect.mjs (a block delete) and push.mjs (a subscription delete).
export const { deleteWhere, deleteConnections } = profileDelete;
export { ownBlocksQuery };

// Finishes one pending delete the purge found (finishPendingDeletes). Returns 'finished', 'kept'
// when the profile changed since the search, or 'skipped' for a hit that is not a profile.
// 1. A realtime read of the document (a GET, which the search's refresh interval does not delay).
//    Nothing is touched unless it is still a pending delete with the sequence number and primary
//    term the search returned; a profile its owner made visible again keeps its meets, push
//    subscriptions, nudge records and blocks. One still pending is found again by the next run.
// 2. Its meets, push subscriptions and nudge records.
// 3. The document, guarded by the sequence number of the read: a change in the few milliseconds
//    since then (the owner made it visible again, a report marked it) answers 409 and keeps it.
//    Elasticsearch also answers a guarded delete of a missing document with 409, so the document
//    is read again; gone means the owner's own retry deleted it in the meantime.
// 4. The blocks it made, unless that last read finds a document: a profile re-created from the
//    same device right after the delete keeps every block. Between that read and the blocks
//    delete a re-creation still has a window of a few milliseconds; it would lose the blocks the
//    old profile made, which the delete was removing anyway.
// The blocks go after the document for the reason they go last in deleteProfileAndConnections.
async function finishPendingDelete(hit) {
  const { event_id: eventId, profile_id: profileId } = hit._source ?? {};
  if (typeof eventId !== 'string' || typeof profileId !== 'string' || hit._id !== docId(eventId, profileId)) return 'skipped';
  const own = await ownDoc(eventId, profileId);
  if (!own.found || !isPendingDelete(own.source) || own.seqNo !== hit._seq_no || own.primaryTerm !== hit._primary_term) return 'kept';
  await deleteMeetsPushAndNudges(eventId, profileId);
  const status = await deleteDoc(hit._id, { seqNo: own.seqNo, primaryTerm: own.primaryTerm });
  const after = await ownDoc(eventId, profileId);
  if (after.found) return status === 409 ? 'kept' : 'finished';
  await deleteOwnBlocks(eventId, profileId);
  return 'finished';
}

// Finishes profile deletes that hid the profile, then failed, and were never tried again (step 1
// of deleteProfileAndConnections without step 3), one page of 100 at a time in the order of
// updated_at and profile_id, at most 50 pages a run. finishPendingDelete says how each one is
// checked and finished. A failure is logged and leaves the document for the next run; one after
// the document is gone leaves blocks that run out with the conference.
export async function finishPendingDeletes() {
  let finished = 0;
  let kept = 0;
  let after;
  for (let page = 0; page < PURGE_PENDING_PAGES; page++) {
    const body = { size: PURGE_PENDING_PAGE, _source: ['event_id', 'profile_id'], query: PENDING_DELETE_QUERY, sort: PENDING_DELETE_SORT };
    if (after) body.search_after = after;
    const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search?seq_no_primary_term=true`, PEOPLE_PURGE_PREFERENCE), body);
    const hits = json.hits?.hits ?? [];
    for (const h of hits) {
      try {
        const outcome = await finishPendingDelete(h);
        if (outcome === 'finished') finished++;
        else if (outcome === 'kept') kept++;
      } catch (err) {
        console.error(`Finishing a pending profile delete failed: ${errorText(err)}`);
      }
    }
    if (hits.length < PURGE_PENDING_PAGE || !Array.isArray(hits[hits.length - 1].sort)) break;
    after = hits[hits.length - 1].sort;
  }
  if (finished) console.log(`Finished ${finished} pending profile deletes.`);
  if (kept) console.log(`Kept ${kept} pending profile deletes that changed since they were found.`);
}

// ---------------------------------------------------------------------------------------------
// Ranking people relative to the requester: one rrf retriever over
//   1. my learn_topics against their speak_topics,
//   2. my speak_topics against their learn_topics,
//   3. the query, or my interests when there is none, against their expertise (semantic),
//   4. in a search, the same text against their about (semantic),
//   5. my expertise against their interests (semantic),
//   6. in a search, the query as a lexical match on their expertise and about,
//   7. in matches, when the requester is around with a location, a distance_feature on
//      presence_cell (100 m pivot, origin the requester's own cell) over people who are around
//      now, so nearby people rank higher; it is a ranking signal and nothing else, and like the
//      band it sees cells only,
// skipping any whose input is empty. Each semantic leg keeps only the profiles at or above the
// floor of its path (SEMANTIC_FLOORS). Circles add a retriever that matches every member, so a
// member with nothing in common is still listed, below everyone who shares something. Every
// retriever is named so that the explanation of a hit says which ones it came from.

const HIGHLIGHT_BASE = { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'] };
const DISTANCE_PIVOT = '100m';
// presence_cell is read to compute the band of a result and is never passed on; another person's
// precise presence_location is never read here.
const RESULT_FIELDS = ['profile_id', 'display_name', 'about', 'expertise', 'sample', 'learn_topics', 'speak_topics', 'shared_talk_ids', 'linkedin_url', 'contact_note', 'presence_zone', 'presence_until', 'presence_cell'];

// Returns { body, legs, fields } where legs names each retriever in order ('topics', 'text',
// 'distance' or 'everyone') and fields names the semantic_text field of each semantic leg (null
// for the others), or null when there is nothing to rank by. nudge.mjs and ble.mjs run the same
// query as the person whose presence was just written or who is scanning, so the push rule, the
// Bluetooth matches and the matches view agree; they pass the push floor (SEMANTIC_FLOORS.push)
// as `floor`. Without one, a search with a query uses the search floor and anything else the
// profile floor; null sends no floor.
export function peopleQuery(me, filters, { size, from = 0, includeEveryone = false, query = '', blocked = new Set(), explain = false, origin = null, semantic = true, floor }) {
  const minSimilarity = floor === undefined ? (query ? SEMANTIC_FLOORS.search : SEMANTIC_FLOORS.profile) : floor;
  const filter = {
    bool: {
      filter: [{ term: { event_id: me.event_id } }, { range: { visible_until: { gt: 'now' } } }, ...filters],
      must_not: [{ ids: { values: [docId(me.event_id, me.profile_id)] } }, { term: { hidden: true } }, ...notBlocked(me.event_id, blocked)],
    },
  };
  const legs = [];
  const fields = [];
  const retrievers = [];
  const highlight = {};
  const add = (kind, standard) => {
    legs.push(kind);
    fields.push(standard.query.knn?.field ?? null);
    retrievers.push({ standard: { ...standard, _name: `${kind}-${legs.length}` } });
  };
  const knn = (field, modelText) => ({
    query: {
      knn: {
        field,
        k: KNN_K,
        num_candidates: KNN_CANDIDATES,
        ...(minSimilarity === null || minSimilarity === undefined ? {} : { similarity: minSimilarity }),
        filter,
        query_vector_builder: { text_embedding: { model_text: modelText } },
      },
    },
  });
  const topics = (theirField, mine) => ({
    query: { bool: { should: mine.map((t) => ({ term: { [theirField]: t } })), minimum_should_match: 1 } },
  });

  // With semantic off (the inference endpoint is unavailable, see semantic.mjs) each knn leg
  // becomes a keyword match on the same text, so matching keeps working with less recall.
  const lexical = (fields, modelText) => ({ query: { multi_match: { query: modelText, fields, minimum_should_match: '2<60%' } } });
  const text = query || me.interests || '';
  if (me.learn_topics?.length) add('topics', topics('speak_topics', me.learn_topics));
  if (me.speak_topics?.length) add('topics', topics('learn_topics', me.speak_topics));
  if (text) {
    add('text', semantic ? knn('expertise_semantic', text) : lexical(['expertise'], text));
    if (semantic) highlight.expertise_semantic = { number_of_fragments: 1 };
    else highlight.expertise = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
  }
  if (query) {
    add('text', semantic ? knn('about_semantic', query) : lexical(['about'], query));
    if (semantic) highlight.about_semantic = { number_of_fragments: 1 };
    else highlight.about = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
  }
  if (me.expertise) {
    add('text', semantic ? knn('interests_semantic', me.expertise) : lexical(['interests'], me.expertise));
    if (semantic) highlight.interests_semantic = { number_of_fragments: 1 };
    else highlight.interests = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
  }
  if (query && semantic) {
    add('text', { query: { multi_match: { query, fields: ['expertise', 'about'], minimum_should_match: '2<60%' } } });
    highlight.expertise = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
    highlight.about = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
  }
  if (origin) {
    add('distance', {
      query: {
        bool: {
          must: [{ distance_feature: { field: 'presence_cell', pivot: DISTANCE_PIVOT, origin } }],
          filter: [{ range: { presence_until: { gt: 'now' } } }],
        },
      },
    });
  }
  if (includeEveryone) add('everyone', { query: { match_all: {} }, sort: [{ updated_at: 'desc' }] });
  if (!retrievers.length) return null;

  const body = {
    size,
    from,
    _source: RESULT_FIELDS,
    retriever: retrievers.length === 1
      ? { standard: { ...retrievers[0].standard, filter } }
      : { rrf: { retrievers, filter, rank_window_size: Math.max(RANK_WINDOW, from + size) } },
  };
  if (explain) body.explain = true;
  if (Object.keys(highlight).length) body.highlight = { ...HIGHLIGHT_BASE, fields: highlight };
  return { body, legs, fields };
}

// The rrf node of a hit's explanation: the node whose description reads "rrf score: [..] computed
// for initial ranks [..]" and which has one detail per retriever, each with the hit's rank in that
// retriever as its value (0, "result not found in query", when the retriever did not find it).
// Elasticsearch 9.5 does not put that node at the top: on an index with nested fields (the
// semantic_text chunks) the top is a "sum of:" whose details are the rrf node and the filter that
// keeps nested chunk documents out of the hits ("FieldExistsQuery [field=_primary_term]", which
// only top-level documents have), so the top level always has two details whatever the number of
// retrievers. The node is looked for down to RRF_NODE_DEPTH levels below the top; null when there
// is none.
const RRF_NODE_DEPTH = 3;
const RRF_NODE_RE = /^rrf score: .*computed for initial ranks/;
const RRF_LEG_RE = /in query at index \[(\d+)\] \[([^\]]+)\]/;
function rrfNode(node, n, depth = 0) {
  if (!node || typeof node !== 'object' || depth > RRF_NODE_DEPTH) return null;
  const details = Array.isArray(node.details) ? node.details : [];
  if (RRF_NODE_RE.test(node.description ?? '') && details.length === n) return node;
  for (const d of details) {
    const found = rrfNode(d, n, depth + 1);
    if (found) return found;
  }
  return null;
}

// The retrievers a hit was found by, as indexes into legs, read from the rrf node of its
// explanation. A detail that names its retriever ("in query at index [i] [topics-1]") must name
// the leg at its position, as peopleQuery names them. Returns null when the legs are unknown: the
// response carries no explanation (the cluster refused it, see searchPeople), none whose shape is
// recognised, or one whose retriever names do not match.
export function matchedLegs(hit, legs) {
  if (legs.length === 1) return [0];
  const node = rrfNode(hit._explanation, legs.length);
  if (!node) return null;
  const named = node.details.map((d, i) => {
    const m = RRF_LEG_RE.exec(d?.description ?? '');
    return !m || (Number(m[1]) === i && m[2] === `${legs[i]}-${i + 1}`);
  });
  if (!named.every(Boolean)) return null;
  return node.details.map((d, i) => (d && d.value > 0 && !/not found/.test(d.description ?? '') ? i : -1)).filter((i) => i >= 0);
}

// Semantic highlights come back for every hit that has the field, whether or not the semantic leg
// on that field found it (checked on 9.5.6: all 21 hits that a knn leg with a 0.95 floor did not
// find carried an expertise_semantic highlight). A chunk is evidence only when that leg found the
// hit, so the others are removed and evidenceFor falls back as for a profile with no chunk; the
// push nudge and Bluetooth sightings then never quote a passage the floor judged unrelated. When
// the legs are unknown, no semantic highlight is kept.
const SEMANTIC_FIELDS = ['expertise_semantic', 'about_semantic', 'interests_semantic'];
function keepFoundChunks(hits, q) {
  for (const h of hits) {
    if (!h.highlight) continue;
    const found = new Set((matchedLegs(h, q.legs) ?? []).map((i) => q.fields?.[i]).filter(Boolean));
    for (const f of SEMANTIC_FIELDS) if (f in h.highlight && !found.has(f)) delete h.highlight[f];
  }
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const unescapeHtml = (s) => s.replace(/<\/?mark>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function cutText(raw, max) {
  let t = String(raw).replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '');
  if (t.length > max) {
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(' ');
    t = `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
  }
  return t;
}

// The lexical fallback highlights carry <mark> tags from the html encoder; passages are plain text.
const unmark = (f) => (typeof f === 'string' ? f.replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim() : f);

function passageFrom(hit) {
  const hl = hit.highlight ?? {};
  const raw = hl.expertise_semantic?.[0] ?? hl.interests_semantic?.[0] ?? unmark(hl.expertise?.[0]) ?? unmark(hl.interests?.[0]);
  return raw ? cutText(raw, PASSAGE_MAX) || null : null;
}

// The passage that matched, with <mark> tags as the only markup: a lexical fragment of expertise
// or about when the query matched words there, else the best semantic chunk of expertise or
// about, else the start of their expertise (or about). Null for a profile with no text at all.
export function evidenceFor(hit) {
  const hl = hit.highlight ?? {};
  const s = hit._source ?? {};
  const lexical = [hl.expertise?.[0], hl.about?.[0]].find((f) => typeof f === 'string' && f.includes('<mark>'));
  if (lexical) return lexical.replace(/\s+/g, ' ').trim();
  const chunk = hl.expertise_semantic?.[0] ?? hl.about_semantic?.[0];
  if (chunk && cutText(chunk, PASSAGE_MAX)) return escapeHtml(cutText(chunk, PASSAGE_MAX));
  const plain = cutText(s.expertise || s.about || '', EVIDENCE_FALLBACK);
  return plain ? escapeHtml(plain) : null;
}

// Closes a reason with a period, unless its inserted text already ends a sentence (a talk title
// such as "... Here's What the Data Says." or "Why Not?", or a cut passage ending in an ellipsis),
// so no reason ends in "..", "?." or "!.". Closing quotes, brackets and highlight tags after the
// punctuation are allowed. The same rule as sentence() in worker/src/people/view.js.
const ENDS_SENTENCE = /[.!?\u2026]["'\u2019\u201d)\]]*(?:<\/?[a-z]+>)*\s*$/i;
const sentence = (text) => (ENDS_SENTENCE.test(text) ? text.trimEnd() : `${text}.`);

// The reason templates of the product brief, filled from this result's own fields.
export function reasonsFor(me, them, labels, talkTitles, passage, circleTalkId, { evidence = null, zone = null } = {}) {
  const reasons = [];
  const named = (ids) => ids.filter((id) => labels.has(id)).map((id) => labels.get(id));
  const theirSpeak = new Set(them.speak_topics ?? []);
  const theirLearn = new Set(them.learn_topics ?? []);
  const theirShared = new Set(them.shared_talk_ids ?? []);
  const canSpeak = named((me.learn_topics ?? []).filter((t) => theirSpeak.has(t)));
  const wantLearn = named((me.speak_topics ?? []).filter((t) => theirLearn.has(t)));
  if (evidence) reasons.push(sentence(`They've worked on ${cutText(unescapeHtml(evidence), PASSAGE_MAX)}`));
  if (canSpeak.length) reasons.push(`They can speak to ${listFormat.format(canSpeak.slice(0, 4))}, which you want to learn about.`);
  if (wantLearn.length) reasons.push(`They want to learn about ${listFormat.format(wantLearn.slice(0, 4))}, which you can speak to.`);
  const both = [...talkTitles.keys()].filter((id) => id !== circleTalkId && theirShared.has(id));
  if (both.length) reasons.push(sentence(`You are both interested in ${listFormat.format(both.slice(0, 2).map((id) => talkTitles.get(id)))}`));
  if (passage && !evidence) reasons.push(sentence(`Ask them about ${passage}`));
  if (circleTalkId && talkTitles.has(circleTalkId)) reasons.push(sentence(`You are both interested in ${talkTitles.get(circleTalkId)}`));
  if (zone) reasons.push(`They're in ${zone} right now.`);
  return reasons;
}

// Shapes one hit for the requester. In a text search (query given) the evidence leads the
// reasons; zone and the proximity band are included only while both the requester and this
// person are around. A broad match carries no evidence and is labelled with the common topic it
// shares instead. The cell a hit carries is read for the band and goes no further.
export function toPerson(hit, me, labels, talkTitles, circleTalkId, { search = false, broad = false } = {}) {
  const s = hit._source ?? {};
  const topicsOf = (ids) => (ids ?? []).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) }));
  const evidence = broad ? null : evidenceFor(hit);
  const around = isAround(s);
  const both = around && isAround(me);
  const zone = both && s.presence_zone ? s.presence_zone : null;
  const proximity = both ? proximityBand(me, s) : null;
  let reasons;
  if (broad) {
    const shared = sharedTopics(me, s).filter((t) => labels.has(t)).map((t) => labels.get(t));
    reasons = shared.length ? [`Also interested in ${listFormat.format(shared.slice(0, 4))}.`] : [];
    if (zone) reasons.push(`They're in ${zone} right now.`);
  } else {
    reasons = reasonsFor(me, s, labels, talkTitles, passageFrom(hit), circleTalkId, { evidence: search ? evidence : null, zone });
  }
  return {
    ref: refFor(me.event_id, s.profile_id ?? hit._id),
    display_name: s.display_name ?? '',
    about: s.about ?? '',
    sample: s.sample === true,
    learn_topics: topicsOf(s.learn_topics),
    speak_topics: topicsOf(s.speak_topics),
    reasons,
    opener: reasons[0] ?? null,
    contact: { linkedin_url: s.linkedin_url ?? null, contact_note: s.contact_note ?? null },
    evidence,
    around,
    zone,
    proximity,
    broad,
  };
}

async function circleCounts(slug, ids) {
  const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(slug)), {
    size: 0,
    query: {
      bool: {
        filter: [{ term: { event_id: slug } }, { range: { visible_until: { gt: 'now' } } }, { terms: { shared_talk_ids: ids } }],
        must_not: [{ term: { hidden: true } }],
      },
    },
    aggs: { talks: { terms: { field: 'shared_talk_ids', include: ids, size: ids.length } } },
  });
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const b of json.aggregations?.talks?.buckets ?? []) counts[b.key] = b.doc_count;
  return counts;
}

// The requester's stored profile, authenticated by the device secret. Throws 403 on a wrong
// secret; returns null when there is no live document, or when the document is a delete that has
// not finished (isPendingDelete): someone who asked to be deleted blocks, asks, reports and
// subscribes no more. Only the profile write (which can make it visible again) and the delete
// read the document themselves. _seq_no and _primary_term are those of this read, for
// updateOwnProfile.
export async function authenticated(device, slug) {
  const own = await ownDoc(slug, device.profileId);
  if (!own.found) return null;
  if (!secretMatches(device.secret, own.source.secret_hash)) throw forbidden();
  if (!isLive(own.source) || isPendingDelete(own.source)) return null;
  return { ...own.source, event_id: slug, profile_id: device.profileId, _seq_no: own.seqNo, _primary_term: own.primaryTerm };
}

const OWN_UPDATE_ATTEMPTS = 2;
// A profile save that lost to another write of the same document is read and built again once.
const PROFILE_WRITE_ATTEMPTS = 2;

// A Bulk partial update of the requester's own document that applies only while the document is
// still the one authenticated() read (if_seq_no and if_primary_term). build(me) gets the result of
// authenticated(), null included, throws to refuse the request (it must for null), and returns
// { doc, ...anything } where doc is
// the partial document to write. When the document changed or went away between the read and the
// write, it is read and built again once; so a write that read the profile before a delete hid
// it can never put presence or a Bluetooth token back on the hidden document: the second read
// finds no profile. A second conflict answers 409, and a document gone again by the second write
// answers 403 profile_required. Resolves to { me, ...what build returned }. A caller that has just
// read the profile with authenticated() may pass it as `current`, which the first attempt then
// uses instead of reading it again; a conflict still reads it afresh. refresh: false skips
// refresh=wait_for, for a write that nothing searches for at once (the guard itself reads the
// document with a realtime GET).
export async function updateOwnProfile(device, slug, build, { current = null, refresh = true } = {}) {
  for (let attempt = 1; ; attempt++) {
    const me = attempt === 1 && current ? current : await authenticated(device, slug);
    const write = await build(me);
    const action = { update: { _id: docId(slug, me.profile_id), if_seq_no: me._seq_no, if_primary_term: me._primary_term } };
    const status = await bulkOne(action, { doc: write.doc }, { refresh });
    if (status >= 200 && status <= 299) return { me, ...write };
    if ((status === 409 || status === 404) && attempt < OWN_UPDATE_ATTEMPTS) continue;
    if (status === 409) throw new HttpError(409, { error: 'The profile changed at the same time; try again' });
    if (status === 404) throw new HttpError(403, { error: 'profile_required' });
    throw new UpstreamError(`bulk item status ${status}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Handlers.

// True when a failed bulk item says the text could not be embedded: a 429 (what the inference
// service's trial limit answers with), or an error whose types or reason name an inference failure
// (isInferenceFailure). A version conflict (409) or a mapping error (400) is not one.
function embeddingFailed(item) {
  if (item.status >= 200 && item.status <= 299) return false;
  return item.status === 429 || isInferenceFailure(esErrorInfo(item.error));
}

// Writes a profile document. Indexing about/interests/expertise asks Elasticsearch to embed them
// (semantic_text copy_to), so while the inference endpoint is unavailable (semantic.mjs) the same
// document is written without those three fields, with text_hash null and text_pending true, and
// with the text kept in pending_about, pending_interests and pending_expertise, which are mapped
// unindexed and never copied anywhere, so nothing embeds them. The person stays visible and can
// share meanwhile; only their text is missing from matching until the owner's next write: a
// profile save is a full reindex (text_hash null never equals a hash), and a presence write calls
// reembedPending. Either embeds the real text and drops the pending fields once the endpoint is
// back. Only an embedding failure (embeddingFailed, or a request that failed with
// isInferenceFailure) pauses and writes without text; any other failure is returned or thrown as
// it is.
async function writeProfileDoc(action, doc) {
  const hasText = 'about' in doc;
  const withoutText = () => {
    const { about, interests, expertise, ...rest } = doc;
    return { ...rest, text_hash: null, text_pending: true, pending_about: about, pending_interests: interests, pending_expertise: expertise };
  };
  if (!hasText) return { status: await bulkOne(action, doc), degraded: false };
  if (!semanticAvailable()) return { status: await bulkOne(action, withoutText()), degraded: true };
  let failure;
  try {
    const item = await bulkItem(action, doc);
    if (!embeddingFailed(item)) return { status: item.status, degraded: false };
    failure = new UpstreamError(`bulk item status ${item.status}`, { status: item.status, ...esErrorInfo(item.error) });
  } catch (err) {
    if (!(err instanceof UpstreamError) || !isInferenceFailure(err)) throw err;
    failure = err;
  }
  pauseSemantic(failure);
  return { status: await bulkOne(action, withoutText()), degraded: true };
}

// Indexes the owner's document again with the text a degraded write left in the pending fields,
// once semantic matching is available, so the text is embedded and the pending fields go. Runs on
// the owner's presence writes (connect.mjs); a profile save needs no call, since its full reindex
// carries the text from the request. Guarded by the sequence number it read, so a write that
// lands in between wins (409, ignored). Returns true when the text was embedded; throws an
// UpstreamError when the write failed for another reason. A document whose text was dropped
// before the pending fields existed has none to embed and keeps text_hash null for the next save.
export async function reembedPending(eventId, profileId) {
  if (!semanticAvailable()) return false;
  const id = docId(eventId, profileId);
  const { status, json } = await people('GET', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
  if (status === 404 || !json.found) return false;
  // The semantic fields are filled by copy_to and are not part of a document's source; they are
  // left out here in case a cluster returns them.
  const { pending_about, pending_interests, pending_expertise, text_pending, about_semantic, interests_semantic, expertise_semantic, _inference_fields, ...rest } = json._source ?? {};
  if (text_pending !== true || [pending_about, pending_interests, pending_expertise].every((v) => typeof v !== 'string')) return false;
  const text = { about: pending_about ?? '', interests: pending_interests ?? '', expertise: pending_expertise ?? '' };
  const guard = { _id: id, if_seq_no: json._seq_no, if_primary_term: json._primary_term };
  const written = await writeProfileDoc({ index: guard }, { ...rest, ...text, text_hash: textHash(text) });
  if (written.status === 409) return false;
  if (written.status < 200 || written.status > 299) throw new UpstreamError(`bulk item status ${written.status}`);
  return !written.degraded;
}

// The report flags for a profile document that is being created or fully reindexed: the flags it
// already carries, and hidden or spot_hidden again when its reports (which outlive the document,
// see report.mjs) reach HIDE_AT. Fails closed: when counting fails, a reindex keeps the stored
// flags and never unhides, and a create (which has no stored flags to keep) fails with the error,
// so a deleted and re-made profile is never created visible on a guess.
async function reportFlags(slug, ref, own) {
  const stored = { hidden: own.found && own.source.hidden === true, spot_hidden: own.found && own.source.spot_hidden === true };
  let counts;
  try {
    counts = await reportCountsFor(slug, ref);
  } catch (err) {
    if (!own.found) throw err;
    console.error(`Counting reports failed; keeping the stored flags: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'error')}`);
    return stored;
  }
  return { hidden: stored.hidden || counts.profile >= HIDE_AT, spot_hidden: stored.spot_hidden || counts.spot >= HIDE_AT };
}

async function putProfile(req, res) {
  const ip = clientIp(req);
  limit(`people-write:ip:${ip}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);

  const body = await jsonBody(req, PUT_KEYS);
  if (typeof body.open_to_meet !== 'boolean') throw bad('open_to_meet must be a boolean');
  const input = validateProfile(body.profile);
  const shared = idList(body.shared_talk_ids, 'shared_talk_ids', 50, TALK_ID_RE);
  const conf = await conferenceFor(body.event);
  const id = docId(conf.slug, device.profileId);

  for (let attempt = 1; ; attempt++) {
    const own = await ownDoc(conf.slug, device.profileId);
    const profile = { ...input };
    if (own.found && !secretMatches(device.secret, own.source.secret_hash)) throw forbidden();

    // Both visibility choices off: the document must not exist, nor anything that connected it.
    if (!body.open_to_meet && !shared.length) {
      if (own.found) await deleteProfileAndConnections(conf.slug, device.profileId);
      sendJson(res, 200, { ok: true, open_to_meet: false, shared_talk_ids: [] });
      return;
    }

    if (Date.parse(conf.visibleUntil) <= Date.now()) throw bad('conference has ended');
    profile.learn_topics = await checkTopics(conf.slug, profile.learn_topics, 'learn_topics', own.found ? own.source.learn_topics ?? [] : []);
    profile.speak_topics = await checkTopics(conf.slug, profile.speak_topics, 'speak_topics', own.found ? own.source.speak_topics ?? [] : []);
    await checkSharedTalks(conf.slug, shared);

    const hash = textHash(profile);
    const common = {
      ref: refFor(conf.slug, device.profileId),
      display_name: profile.display_name,
      learn_topics: profile.learn_topics,
      speak_topics: profile.speak_topics,
      open_to_meet: body.open_to_meet,
      shared_talk_ids: shared,
      visible_until: conf.visibleUntil,
      updated_at: new Date().toISOString(),
      linkedin_url: profile.linkedin_url,
      contact_note: profile.contact_note,
    };
    // Presence needs conference-wide visibility, so turning that off clears it. Otherwise a full
    // reindex carries the stored presence over and a partial update leaves it alone.
    const presence = own.found ? Object.fromEntries([...PRESENCE_FIELDS, ...BLE_FIELDS].map((f) => [f, own.source[f] ?? null])) : { ...PRESENCE_OFF };
    if (!body.open_to_meet) Object.assign(common, PRESENCE_OFF);
    // The report flags live on the document too, and a create or a full reindex writes them from the
    // stored flags and the reports on file (reportFlags), so neither unhides silently, not even after
    // the owner deleted the document. A partial update leaves them as they are.
    const partial = own.found && own.source.text_hash === hash;
    const flags = partial ? null : await reportFlags(conf.slug, common.ref, own);
    if (flags?.spot_hidden) presence.presence_spot = null;

    let status;
    let degraded = false;
    if (!own.found) {
      // op_type create: an existing document can never be taken over by a new device.
      ({ status, degraded } = await writeProfileDoc(
        { create: { _id: id } },
        {
          event_id: conf.slug,
          profile_id: device.profileId,
          about: profile.about,
          interests: profile.interests,
          expertise: profile.expertise,
          sample: false,
          secret_hash: hashSecret(device.secret),
          text_hash: hash,
          ...flags,
          ...common,
        },
      ));
      if (status === 409) throw forbidden();
    } else {
      const guard = { _id: id, if_seq_no: own.seqNo, if_primary_term: own.primaryTerm };
      if (partial) {
        // Text unchanged: a Bulk partial update without the text fields reuses the embeddings.
        status = await bulkOne({ update: guard }, { doc: common });
      } else {
        ({ status, degraded } = await writeProfileDoc(
          { index: guard },
          {
            event_id: conf.slug,
            profile_id: device.profileId,
            about: profile.about,
            interests: profile.interests,
            expertise: profile.expertise,
            sample: false,
            secret_hash: own.source.secret_hash,
            text_hash: hash,
            ...presence,
            ...flags,
            ...common,
          },
        ));
      }
      // Another write to the document won (a presence write, or the Bluetooth caps record of a
      // sightings answer): read it again and build the write from what is stored now, once.
      if (status === 409 && attempt < PROFILE_WRITE_ATTEMPTS) continue;
      if (status === 409) throw new HttpError(409, { error: 'The profile changed at the same time; try again' });
    }
    if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
    sendJson(res, 200, {
      ok: true,
      open_to_meet: body.open_to_meet,
      shared_talk_ids: shared,
      hidden_for_owner: flags ? flags.hidden : own.source.hidden === true,
      // Present only when the text could not be embedded and was left off the document for now.
      ...(degraded ? { degraded: { semantic: true } } : {}),
    });
    return;
  }
}

async function deleteProfile(req, res, url) {
  const ip = clientIp(req);
  limit(`people-write:ip:${ip}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  const slug = url.searchParams.get('event');
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('event must be a conference slug');

  const own = await ownDoc(slug, device.profileId);
  if (own.found) {
    if (!secretMatches(device.secret, own.source.secret_hash)) throw forbidden();
    await deleteProfileAndConnections(slug, device.profileId);
  }
  sendJson(res, 200, { ok: true });
}

const MATCHES_KEYS = new Set(['event', 'interested_talk_ids', 'query', 'when', 'from', 'size']);

// Warnings that the specificity rule fell back, at most one of each kind per WARN_EVERY_MS. They
// name the conference and the number of legs and nothing about any person.
const WARN_EVERY_MS = 10 * 60_000;
const lastWarned = new Map();
function warnRarely(kind, text) {
  const now = Date.now();
  if (now - (lastWarned.get(kind) ?? -Infinity) < WARN_EVERY_MS) return;
  lastWarned.set(kind, now);
  console.warn(text);
}
const retrieverCount = (body) => body.retriever?.rrf?.retrievers?.length ?? 1;

// Runs a people search. Should the cluster refuse the explanation, the search runs again without
// it; the legs of every hit are then unknown, which isBroad resolves per caller.
export async function searchPeople(slug, body) {
  const path = withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(slug));
  try {
    return (await people('POST', path, body)).json;
  } catch (err) {
    if (!body.explain || !(err instanceof UpstreamError) || err.message !== 'status 400') throw err;
    warnRarely('refused', `People search for ${slug}: the cluster refused the explanation of a ${retrieverCount(body)}-leg query, so the specificity rule falls back (isBroad).`);
    const { explain, ...rest } = body;
    return (await people('POST', path, rest)).json;
  }
}

// Runs the people query that build(semantic) returns (peopleQuery's { body, legs, fields }, or
// null when there is nothing to rank by), semantic when semantic.mjs allows it. When the semantic
// legs fail because the inference endpoint did (isInferenceFailure), semantic queries pause for a
// minute and the same request runs again with keyword legs; any other failure propagates. matches,
// circle members, the push nudge (nudge.mjs) and Bluetooth sightings (ble.mjs) all rank through
// this. Semantic highlights a hit's legs do not back are removed (keepFoundChunks), and an
// explanation whose legs cannot be read is logged (warnRarely). Returns { json, q, semantic } with
// the query that answered, or null when build gave none.
export async function rankPeople(slug, build) {
  const semantic = semanticAvailable();
  let q = build(semantic);
  if (!q) return null;
  let json;
  let used = semantic;
  try {
    json = await searchPeople(slug, q.body);
  } catch (err) {
    if (!semantic || !q.legs.includes('text') || !isInferenceFailure(err)) throw err;
    pauseSemantic(err);
    q = build(false);
    used = false;
    json = await searchPeople(slug, q.body);
  }
  const hits = json.hits?.hits ?? [];
  if (q.body.explain && q.legs.length > 1 && hits.some((h) => h._explanation && !matchedLegs(h, q.legs))) {
    warnRarely('unrecognised', `People search for ${slug}: the explanation of a ${q.legs.length}-leg query was not recognised, so the specificity rule falls back (isBroad).`);
  }
  keepFoundChunks(hits, q);
  return { json, q, semantic: used };
}

// The topics a hit shares with the requester, in either direction.
function sharedTopics(me, s) {
  const theirSpeak = new Set(s.speak_topics ?? []);
  const theirLearn = new Set(s.learn_topics ?? []);
  return [...new Set([...(me.learn_topics ?? []).filter((t) => theirSpeak.has(t)), ...(me.speak_topics ?? []).filter((t) => theirLearn.has(t))])];
}

// The specificity rule: a hit is a broad match when it was found only by the topic retrievers and
// every topic it shares with the requester is one of the conference's ten most common. A hit found
// by a text retriever is specific. Being nearby is not experience, so the distance leg counts
// neither way.
//
// When the legs that found a hit are unknown (matchedLegs gives null), `unknown` decides. With
// 'topics', the default, the hit is judged by its shared topics alone, as if only the topic legs
// had found it: it is broad unless it shares a topic outside the common ones. The push nudge
// (nudge.mjs) and Bluetooth sightings (ble.mjs) use the default, because they reach a person who
// did not search, and a generic match there costs a notification. With 'specific' the hit is
// kept; the matches view uses it, so that a person searching never loses a real match to an
// explanation this module cannot read. The two answers differ on purpose: an unreadable
// explanation costs the matches view some precision and the nudge and sightings some recall.
export function isBroad(hit, legs, me, common, { unknown = 'topics' } = {}) {
  const matched = matchedLegs(hit, legs);
  if (!matched) {
    if (unknown === 'specific') return false;
  } else if (matched.some((i) => legs[i] !== 'topics' && legs[i] !== 'distance')) {
    return false;
  }
  return sharedTopics(me, hit._source ?? {}).every((t) => common.has(t));
}

async function matches(req, res) {
  const ip = clientIp(req);
  limit(`people-read:ip:${ip}`, LIMITS.readIp);
  const device = requireDevice(req);
  limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);

  const body = await jsonBody(req, MATCHES_KEYS);
  const interested = idList(body.interested_talk_ids, 'interested_talk_ids', 100, TALK_ID_RE);
  const query = text(body.query, 'query', QUERY_MAX);
  const when = body.when === undefined || body.when === null ? 'anyone' : body.when;
  if (when !== 'anyone' && when !== 'around_now') throw bad("when must be 'anyone' or 'around_now'");
  const from = body.from === undefined || body.from === null ? 0 : body.from;
  if (!Number.isInteger(from) || from < 0 || from > MATCHES_FROM_MAX) throw bad(`from must be an integer from 0 to ${MATCHES_FROM_MAX}`);
  const size = body.size === undefined || body.size === null ? MATCHES_SIZE : body.size;
  if (!Number.isInteger(size) || size < 1 || size > MATCHES_SIZE) throw bad(`size must be an integer from 1 to ${MATCHES_SIZE}`);
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me || me.open_to_meet !== true) throw new HttpError(403, { error: 'visibility_required' });

  const filters = [{ term: { open_to_meet: true } }];
  if (when === 'around_now') filters.push({ range: { presence_until: { gt: 'now' } } });
  const blocked = await blockedIds(conf.slug, me.profile_id);
  // A requester who is around with a position gets the distance leg; the origin is their own
  // stored cell and never leaves the query.
  const build = (semantic) => peopleQuery(me, filters, { size, from, query, blocked, explain: true, origin: cellOf(me), semantic });
  // When the semantic legs fail because inference did, the same request is answered with keyword
  // legs and says so; semantic queries pause for a minute (rankPeople, semantic.mjs).
  const [ranked, topics] = await Promise.all([rankPeople(conf.slug, build), topicsOf(conf.slug)]);
  if (!ranked) {
    sendJson(res, 200, { results: [], from, size, has_more: false });
    return;
  }
  const { json, q, semantic } = ranked;
  // Only talks the requester marked and also shared for are named in a reason, so a match never
  // reveals a talk circle the requester has not joined.
  const mine = new Set(me.shared_talk_ids ?? []);
  const talkIds = interested.filter((id) => mine.has(id));
  const all = json.hits?.hits ?? [];
  // Broad matches are dropped from a text search and from the "anyone" view. The "around now"
  // view keeps those who are in the requester's own zone right now, after every specific match
  // on the page; that is the only place this module changes the order Elasticsearch returned.
  const broad = new Set(all.filter((h) => isBroad(h, q.legs, me, topics.common, { unknown: 'specific' })));
  const sameZone = (h) => isAround(me) && isAround(h._source ?? {}) && h._source.presence_zone === me.presence_zone;
  const specific = all.filter((h) => !broad.has(h));
  const hits = query || when !== 'around_now' ? specific : [...specific, ...all.filter((h) => broad.has(h) && sameZone(h))];
  const usedTalks = talkIds.filter((id) => hits.some((h) => (h._source?.shared_talk_ids ?? []).includes(id)));
  const talks = await talksById(conf.slug, usedTalks, ['title']);
  const titles = new Map([...talks].map(([id, s]) => [id, s.title ?? '']));
  sendJson(res, 200, {
    results: hits.map((h) => toPerson(h, me, topics.labels, titles, null, { search: Boolean(query), broad: broad.has(h) })),
    ...(semantic || !q.legs.includes('text') ? {} : { degraded: { semantic: true } }),
    from,
    size,
    has_more: all.length === size,
  });
}

const COUNTS_KEYS = new Set(['event', 'talk_ids']);

async function counts(req, res) {
  limit(`circles-counts:ip:${clientIp(req)}`, LIMITS.publicIp);
  const body = await jsonBody(req, COUNTS_KEYS);
  const ids = idList(body.talk_ids, 'talk_ids', 100, TALK_ID_RE);
  const conf = await conferenceFor(body.event);
  sendJson(res, 200, { counts: ids.length ? await circleCounts(conf.slug, ids) : {} });
}

const MEMBERS_KEYS = new Set(['event', 'talk_id']);

async function members(req, res) {
  const ip = clientIp(req);
  limit(`people-read:ip:${ip}`, LIMITS.readIp);
  const device = requireDevice(req);
  limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);

  const body = await jsonBody(req, MEMBERS_KEYS);
  if (typeof body.talk_id !== 'string' || !TALK_ID_RE.test(body.talk_id)) throw bad('talk_id must be a talk id');
  const conf = await conferenceFor(body.event);
  const talkId = body.talk_id;
  const me = await authenticated(device, conf.slug);
  const count = (await circleCounts(conf.slug, [talkId]))[talkId] ?? 0;
  if (!me || !(me.shared_talk_ids ?? []).includes(talkId)) throw new HttpError(403, { error: 'share_required', count });

  const blocked = await blockedIds(conf.slug, me.profile_id);
  // The explanation says which semantic legs found a member, so that only their chunks are
  // evidence (keepFoundChunks).
  const membersQuery = (semantic) => peopleQuery(me, [{ term: { shared_talk_ids: talkId } }], { size: MEMBERS_SIZE, includeEveryone: true, blocked, explain: true, semantic });
  const [talks, { json }, labels] = await Promise.all([
    talksById(conf.slug, [talkId], ['title', 'start', 'end', 'url', 'speaker_profiles']),
    rankPeople(conf.slug, membersQuery),
    topicLabels(conf.slug),
  ]);
  const talk = talks.get(talkId);
  if (!talk) throw new HttpError(404, { error: 'talk not found' });
  const titles = new Map([[talkId, talk.title ?? '']]);
  sendJson(res, 200, {
    talk: { title: talk.title ?? '', start: talk.start ?? null, end: talk.end ?? null, url: talk.url ?? null },
    speakers: Array.isArray(talk.speaker_profiles) ? talk.speaker_profiles : [],
    count,
    members: (json.hits?.hits ?? []).map((h) => toPerson(h, me, labels, titles, talkId)),
  });
}

// ---------------------------------------------------------------------------------------------

const ROUTES = {
  '/api/people/profile': { PUT: putProfile, DELETE: deleteProfile },
  '/api/people/matches': { POST: matches },
  '/api/circles/counts': { POST: counts },
  '/api/circles/members': { POST: members },
};

// Runs the handler of one route table entry for the request's method, with the shared error
// handling: 405 for a method the route lacks, the status and body of an HttpError, and a fixed
// 502 for anything else. connect.mjs uses it for the block, presence and meet routes.
export async function dispatch(route, req, res, url) {
  const handler = route[req.method];
  if (!handler) {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: Object.keys(route).join(', ') });
    return;
  }
  try {
    checkOrigin(req);
    await handler(req, res, url);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
    } else if (err instanceof HttpError) {
      sendJson(res, err.status, err.body, err.headers);
    } else if (err instanceof UpstreamError) {
      console.error(`People request to Elasticsearch failed: ${err.message}`);
      sendJson(res, 502, { error: 'People are temporarily unavailable' });
    } else {
      console.error(`People handler error: ${err?.name ?? 'Error'}`);
      sendJson(res, 502, { error: 'People are temporarily unavailable' });
    }
  }
}

// Handles the profile, matches and circle routes. Resolves to true when the request was handled;
// the other /api/people/* paths (block, blocks) belong to connect.mjs.
export async function handlePeopleApi(req, res, url) {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  await dispatch(route, req, res, url);
  return true;
}
