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
//   ES_PEOPLE_PUSH_INDEX  default caddie-people-push (Web Push subscriptions, push.mjs).
//   ES_PEOPLE_NUDGES_INDEX default caddie-people-nudges (nudges sent, nudge.mjs).
//   REF_SALT              optional salt for the opaque result reference.
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
//   Request bodies, headers, profile fields and secrets are never logged; the only log lines here
//   name an Elasticsearch status.
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
import { PRESENCE_OFF, BLE_SESSION_OFF, PENDING_DELETE_QUERY, isPendingDelete, visibleUntil, dayBounds } from './people-shared.mjs';

// Re-exported, so the other server modules and the scripts that import them from here keep working.
export { PRESENCE_OFF, BLE_SESSION_OFF, PENDING_DELETE_QUERY, isPendingDelete, visibleUntil, dayBounds };

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
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
// The Bluetooth session of ble.mjs (the legacy token, the derived-token nonce and the id of its
// master) and the record of whom Bluetooth answers returned (ble_caps). The owner's own document
// carries them; they are never returned, and only ble.mjs reads them on another person's document,
// to check a sighted token against the store.
const BLE_FIELDS = ['ble_token', 'ble_token_until', 'presence_nonce', 'ble_master_id', 'ble_caps'];
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
async function bulkItem(action, doc) {
  const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
  const item = json.items?.[0] ?? {};
  const result = Object.values(item)[0] ?? {};
  return { status: result.status ?? 500, error: result.error };
}

// One bulk action on the people index with refresh=wait_for. Returns the item status.
export async function bulkOne(action, doc) {
  return (await bulkItem(action, doc)).status;
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

const DELETE_BATCH = 1000;
const DELETE_ROUNDS = 20;

// Deletes every document of one event's index that matches the query, so the next request already
// sees them gone. The people key holds read and write but not the refresh privilege that
// _delete_by_query?refresh=true needs (it answers 403 after deleting), so the ids are searched for
// and removed with a Bulk delete and refresh=wait_for, which write covers.
export async function deleteWhere(index, eventId, query) {
  for (let round = 0; round < DELETE_ROUNDS; round++) {
    const { json } = await people('POST', withPreference(`${idx(index)}/_search?ignore_unavailable=true`, peoplePreference(eventId)), {
      size: DELETE_BATCH,
      _source: false,
      query,
    });
    const ids = (json.hits?.hits ?? []).map((h) => h._id);
    if (!ids.length) return;
    const body = ids.map((id) => `${JSON.stringify({ delete: { _id: id } })}\n`).join('');
    const { json: result } = await people('POST', `${idx(index)}/_bulk?refresh=wait_for`, body, { ndjson: true });
    for (const item of result.items ?? []) {
      const status = item.delete?.status ?? 500;
      if (status !== 404 && (status < 200 || status > 299)) throw new UpstreamError(`bulk item status ${status}`);
    }
    if (ids.length < DELETE_BATCH) return;
  }
  throw new UpstreamError('too many documents to delete');
}

const errorText = (err) => (err instanceof UpstreamError ? err.message : (err?.name ?? 'error'));

// Every meet a person takes part in, their push subscriptions and the nudge records they were
// part of, at one conference. The three indices are cleared concurrently; a failure is thrown only
// once all three have finished, so nothing is still deleting when the caller answers or retries.
async function deleteMeetsPushAndNudges(eventId, profileId) {
  const results = await Promise.allSettled([
    deleteWhere(MEETS_INDEX, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { participants: profileId } }] } }),
    deleteWhere(PUSH_INDEX, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { profile_id: profileId } }] } }),
    deleteWhere(NUDGES_INDEX, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { profile_ids: profileId } }] } }),
  ]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// The blocks a person made at one conference. Blocks other people made of them are not touched.
export const ownBlocksQuery = (eventId, profileId) => ({ bool: { filter: [{ term: { event_id: eventId } }, { term: { blocker_id: profileId } }] } });
const deleteOwnBlocks = (eventId, profileId) => deleteWhere(BLOCKS_INDEX, eventId, ownBlocksQuery(eventId, profileId));

// Everything that connects a person to others at one conference and goes with their profile:
// meets, push subscriptions and nudge records, then the blocks they made
// (deleteProfileAndConnections says why those go last). Blocks others made of this person stay
// until the conference ends, so deleting and re-creating the profile from the same device never
// lifts them. Runs when the profile is deleted, and the next request already sees them gone.
export async function deleteConnections(eventId, profileId) {
  await deleteMeetsPushAndNudges(eventId, profileId);
  await deleteOwnBlocks(eventId, profileId);
}

// The partial update that hides a profile while it is being deleted. Matches, the Around view,
// nudges and Bluetooth sightings require open_to_meet; circle members, circle counts and For
// you's circle counts require a shared talk; asks (personByRef) require either. Presence and the
// Bluetooth token are cleared as a presence delete clears them. The result is the state
// isPendingDelete recognises. visible_until is left alone, so the hourly purge does not take the
// document for an expired one; it finishes the delete instead (finishPendingDeletes).
const HIDE_FOR_DELETE = { open_to_meet: false, shared_talk_ids: [], ...PRESENCE_OFF };
// A presence write or a report landing on the document at the same moment is a version conflict
// that Elasticsearch retries itself, instead of failing the delete with a 502.
const HIDE_RETRIES = 3;

// Deletes a profile and everything that connects it to others, in an order that keeps every
// failure safe to retry:
// 1. One partial update hides the profile and waits for the refresh, so from then on no match,
//    circle, ask, nudge or Bluetooth sighting finds the person, whatever happens next. A 404 means
//    the document went between the caller's read and this write, and the delete answers 200 as
//    it does when the read finds no document. It is a plain update (no upsert), so it never
//    creates a document.
// 2. Meets, push subscriptions and nudge records are deleted concurrently, and then the blocks
//    this person made. Blocks go last because a delete that fails part-way leaves a hidden
//    profile that its owner can make visible again with a profile write, and it must still carry
//    every block when that happens.
// 3. The document is deleted last. Until then, any failed step answers 502, and trying again
//    authenticates against the document and runs the whole delete again. A delete that is never
//    tried again is finished by the hourly purge (finishPendingDeletes); until then the hidden
//    document is found by nothing, every route but this one and the profile write treat it as no
//    profile (authenticated), and the export leaves it out.
// The hide stops new lookups, not requests already under way: an ask that passed personByRef just
// before the hide, a nudge that was already ranking, or the owner's own device blocking someone
// or subscribing to push, can still write a meet, a nudge record, a block or a push subscription
// after step 2 has finished with that index. The second pass, after the document is gone, removes
// what has landed by then. It is best effort: a failure there is logged and the delete still
// answers 200, because trying again would find no profile and change nothing. A write that lands
// even later stays: the purge removes such a meet once it runs out, and a push subscription, a
// nudge record or a block once the conference ends.
async function deleteProfileAndConnections(eventId, profileId) {
  const id = docId(eventId, profileId);
  const status = await bulkOne({ update: { _id: id, retry_on_conflict: HIDE_RETRIES } }, { doc: HIDE_FOR_DELETE });
  if (status === 404) return;
  if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
  await deleteConnections(eventId, profileId);
  await deleteDoc(id);
  try {
    await deleteConnections(eventId, profileId);
  } catch (err) {
    console.error(`Deleting a deleted profile's connections again failed: ${errorText(err)}`);
  }
}

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
// skipping any whose input is empty. Circles add a retriever that matches every member, so a
// member with nothing in common is still listed, below everyone who shares something. Every
// retriever is named so that the explanation of a hit says which ones it came from.

const HIGHLIGHT_BASE = { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'] };
const DISTANCE_PIVOT = '100m';
// presence_cell is read to compute the band of a result and is never passed on; another person's
// precise presence_location is never read here.
const RESULT_FIELDS = ['profile_id', 'display_name', 'about', 'expertise', 'sample', 'learn_topics', 'speak_topics', 'shared_talk_ids', 'linkedin_url', 'contact_note', 'presence_zone', 'presence_until', 'presence_cell'];

// Returns { body, legs } where legs names each retriever in order ('topics', 'text', 'distance'
// or 'everyone'), or null when there is nothing to rank by. nudge.mjs and ble.mjs run the same
// query as the person whose presence was just written or who is scanning, so the push rule, the
// Bluetooth matches and the matches view agree.
export function peopleQuery(me, filters, { size, from = 0, includeEveryone = false, query = '', blocked = new Set(), explain = false, origin = null, semantic = true }) {
  const filter = {
    bool: {
      filter: [{ term: { event_id: me.event_id } }, { range: { visible_until: { gt: 'now' } } }, ...filters],
      must_not: [{ ids: { values: [docId(me.event_id, me.profile_id)] } }, { term: { hidden: true } }, ...notBlocked(me.event_id, blocked)],
    },
  };
  const legs = [];
  const retrievers = [];
  const highlight = {};
  const add = (kind, standard) => {
    legs.push(kind);
    retrievers.push({ standard: { ...standard, _name: `${kind}-${legs.length}` } });
  };
  const knn = (field, modelText) => ({
    query: {
      knn: {
        field,
        k: KNN_K,
        num_candidates: KNN_CANDIDATES,
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
  return { body, legs };
}

// The retrievers a hit was found by, as indexes into legs, read from the rrf explanation: one
// detail per retriever, whose value is the hit's rank there and 0 when it was not found. Returns
// null when the response carries no explanation, so the caller keeps the hit.
function matchedLegs(hit, legs) {
  if (legs.length === 1) return [0];
  const details = hit._explanation?.details;
  if (!Array.isArray(details) || details.length !== legs.length) return null;
  return details.map((d, i) => (d && d.value > 0 && !/not found/.test(d.description ?? '') ? i : -1)).filter((i) => i >= 0);
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

// The reason templates of the product brief, filled from this result's own fields.
function reasonsFor(me, them, labels, talkTitles, passage, circleTalkId, { evidence = null, zone = null } = {}) {
  const reasons = [];
  const named = (ids) => ids.filter((id) => labels.has(id)).map((id) => labels.get(id));
  const theirSpeak = new Set(them.speak_topics ?? []);
  const theirLearn = new Set(them.learn_topics ?? []);
  const theirShared = new Set(them.shared_talk_ids ?? []);
  const canSpeak = named((me.learn_topics ?? []).filter((t) => theirSpeak.has(t)));
  const wantLearn = named((me.speak_topics ?? []).filter((t) => theirLearn.has(t)));
  if (evidence) reasons.push(`They've worked on ${cutText(unescapeHtml(evidence), PASSAGE_MAX)}.`);
  if (canSpeak.length) reasons.push(`They can speak to ${listFormat.format(canSpeak.slice(0, 4))}, which you want to learn about.`);
  if (wantLearn.length) reasons.push(`They want to learn about ${listFormat.format(wantLearn.slice(0, 4))}, which you can speak to.`);
  const both = [...talkTitles.keys()].filter((id) => id !== circleTalkId && theirShared.has(id));
  if (both.length) reasons.push(`You are both interested in ${listFormat.format(both.slice(0, 2).map((id) => talkTitles.get(id)))}.`);
  if (passage && !evidence) reasons.push(`Ask them about ${passage}.`);
  if (circleTalkId && talkTitles.has(circleTalkId)) reasons.push(`You are both interested in ${talkTitles.get(circleTalkId)}.`);
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
// uses instead of reading it again; a conflict still reads it afresh.
export async function updateOwnProfile(device, slug, build, { current = null } = {}) {
  for (let attempt = 1; ; attempt++) {
    const me = attempt === 1 && current ? current : await authenticated(device, slug);
    const write = await build(me);
    const action = { update: { _id: docId(slug, me.profile_id), if_seq_no: me._seq_no, if_primary_term: me._primary_term } };
    const status = await bulkOne(action, { doc: write.doc });
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
  const profile = validateProfile(body.profile);
  const shared = idList(body.shared_talk_ids, 'shared_talk_ids', 50, TALK_ID_RE);
  const conf = await conferenceFor(body.event);
  const id = docId(conf.slug, device.profileId);

  const own = await ownDoc(conf.slug, device.profileId);
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

// Runs a people search. Should the cluster refuse the explanation, the search runs again without
// it and every hit is kept.
export async function searchPeople(slug, body) {
  const path = withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(slug));
  try {
    return (await people('POST', path, body)).json;
  } catch (err) {
    if (!body.explain || !(err instanceof UpstreamError) || err.message !== 'status 400') throw err;
    const { explain, ...rest } = body;
    return (await people('POST', path, rest)).json;
  }
}

// Runs the people query that build(semantic) returns (peopleQuery's { body, legs }, or null when
// there is nothing to rank by), semantic when semantic.mjs allows it. When the semantic legs fail
// because the inference endpoint did (isInferenceFailure), semantic queries pause for a minute and
// the same request runs again with keyword legs; any other failure propagates. matches, circle
// members, the push nudge (nudge.mjs) and Bluetooth sightings (ble.mjs) all rank through this.
// Returns { json, q, semantic } with the query that answered, or null when build gave none.
export async function rankPeople(slug, build) {
  const semantic = semanticAvailable();
  const q = build(semantic);
  if (!q) return null;
  try {
    return { json: await searchPeople(slug, q.body), q, semantic };
  } catch (err) {
    if (!semantic || !q.legs.includes('text') || !isInferenceFailure(err)) throw err;
    pauseSemantic(err);
    const fallback = build(false);
    return { json: await searchPeople(slug, fallback.body), q: fallback, semantic: false };
  }
}

// The topics a hit shares with the requester, in either direction.
function sharedTopics(me, s) {
  const theirSpeak = new Set(s.speak_topics ?? []);
  const theirLearn = new Set(s.learn_topics ?? []);
  return [...new Set([...(me.learn_topics ?? []).filter((t) => theirSpeak.has(t)), ...(me.speak_topics ?? []).filter((t) => theirLearn.has(t))])];
}

// The specificity rule: a hit is a broad match when it was found only by the topic retrievers and
// every topic it shares with the requester is one of the conference's ten most common. A hit found
// by a text retriever, or one whose explanation is missing, is specific. Being nearby is not
// experience, so the distance leg counts neither way.
export function isBroad(hit, legs, me, common) {
  const matched = matchedLegs(hit, legs);
  if (!matched || matched.some((i) => legs[i] !== 'topics' && legs[i] !== 'distance')) return false;
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
  const broad = new Set(all.filter((h) => isBroad(h, q.legs, me, topics.common)));
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
  const membersQuery = (semantic) => peopleQuery(me, [{ term: { shared_talk_ids: talkId } }], { size: MEMBERS_SIZE, includeEveryone: true, blocked, semantic });
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
