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
//   least one talk. Every people query filters on event_id and on visible_until > now, and
//   leaves out anyone the requester has blocked or who has blocked the requester.
// - secret_hash, text_hash and profile_id are never returned; results carry ref instead, which
//   is also stored on the document so a block or a meet request can name a person by it.
//   Request bodies, headers, profile fields and secrets are never logged; the only log lines here
//   name an Elasticsearch status.
// - Writes whose about, interests and expertise are unchanged use a Bulk API partial update that
//   omits those fields, so toggling visibility, sharing or presence never re-runs the model.
// - Presence (zone, spot, since, until) lives on the people document and is returned to another
//   person only while both are around. Blocks and meets are deleted with the profile.
//
// The block, presence and meet routes themselves are in connect.mjs, which uses the transport,
// plumbing and lookups exported here.

import crypto from 'node:crypto';
import { take, clientIp } from './ratelimit.mjs';
import { parseDevice, hashSecret, secretMatches, refFor } from './device.mjs';
import { CONFERENCES_PREFERENCE, PEOPLE_PURGE_PREFERENCE, conferencePreference, peoplePreference, withPreference } from './preference.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const PEOPLE_KEY = process.env.ES_PEOPLE_API_KEY || '';
const READ_KEY = process.env.ES_API_KEY || '';
export const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
export const BLOCKS_INDEX = process.env.ES_PEOPLE_BLOCKS_INDEX || 'caddie-people-blocks';
export const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
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
export class UpstreamError extends Error {}

export const bad = (message) => new HttpError(400, { error: message });
export const forbidden = () => new HttpError(403, { error: 'forbidden' });

// ---------------------------------------------------------------------------------------------
// Elasticsearch transport. Error bodies from Elasticsearch are never passed on or logged.

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
    await res.body?.cancel();
    throw new UpstreamError(`status ${res.status}`);
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
// expired (a Bulk partial update of the four presence fields, so nothing is re-embedded) and
// deletes meets whose expires_at has passed. A declined meet is the evidence for the daily
// "Not now" pause, so it is kept until its day is over (two days after ended_at, which covers a
// 25-hour day); once it has run out, its note, meeting point and spot-me lines are scrubbed. The
// purge CLI runs the same steps.
const PURGE_INTERVAL_MS = 60 * 60_000;
const PURGE_PRESENCE_PAGE = 500;
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
  source: "if (ctx._source.note == null && ctx._source.rendezvous == null && (ctx._source.spot_me == null || ctx._source.spot_me.isEmpty())) { ctx.op = 'noop'; } else { ctx._source.note = null; ctx._source.rendezvous = null; ctx._source.spot_me = [:]; }",
};
export const PRESENCE_OFF = { presence_zone: null, presence_spot: null, presence_since: null, presence_until: null };

async function purgeExpired() {
  if (!PEOPLE_KEY) return;
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

// The offset of a time zone from UTC at an instant, in milliseconds, through Intl.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// The instant at which a wall clock reading (given as a UTC timestamp of the same digits) occurs
// in a time zone. A conference without a time zone uses UTC-12, the last place on earth where
// that day ends.
function wallToInstant(wall, timeZone) {
  if (!timeZone) return wall + 12 * 3600_000;
  let t = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(t, timeZone);
}

// 23:59:59 on the conference's last day in its own time zone, as an ISO instant.
export function visibleUntil(endDate, timeZone) {
  const [y, m, d] = String(endDate).split('-').map(Number);
  return new Date(wallToInstant(Date.UTC(y, m - 1, d, 23, 59, 59), timeZone)).toISOString();
}

// The start (00:00:00) and end (23:59:59) of the current conference day, in milliseconds. Meet
// requests wait until the end of the day, and "Not now" replies are counted per day.
export function dayBounds(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const [y, m, d] = [get('year'), get('month'), get('day')];
  return { start: wallToInstant(Date.UTC(y, m - 1, d, 0, 0, 0), timeZone), end: wallToInstant(Date.UTC(y, m - 1, d, 23, 59, 59), timeZone) };
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

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

const PRESENCE_FIELDS = ['presence_zone', 'presence_spot', 'presence_since', 'presence_until'];
const OWN_FIELDS = ['secret_hash', 'text_hash', 'open_to_meet', 'shared_talk_ids', 'visible_until', 'learn_topics', 'speak_topics', 'interests', 'expertise', 'display_name', ...PRESENCE_FIELDS];
// What one participant of a meet, or a blocked person, may learn about the other.
const OTHER_FIELDS = ['profile_id', 'display_name', 'about', 'open_to_meet', 'shared_talk_ids', 'visible_until', 'sample', ...PRESENCE_FIELDS];

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

// One bulk action on the people index with refresh=wait_for. Returns the item status.
export async function bulkOne(action, doc) {
  const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
  const item = json.items?.[0] ?? {};
  const result = Object.values(item)[0] ?? {};
  return result.status ?? 500;
}

async function deleteDoc(id) {
  await people('DELETE', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`, undefined, { okStatuses: [404] });
}

// Other people's documents by profile id, as a Map profile_id -> source limited to OTHER_FIELDS.
// Missing documents are left out.
export async function peopleByIds(eventId, profileIds) {
  const ids = [...new Set(profileIds)].filter((id) => typeof id === 'string' && id);
  if (!ids.length) return new Map();
  // The _mget body takes _source per document only; a top-level _source is refused with a 400.
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_mget`, {
    docs: ids.map((id) => ({ _id: docId(eventId, id), _source: OTHER_FIELDS })),
  });
  const map = new Map();
  for (const d of json.docs ?? []) if (d.found && d._source?.profile_id) map.set(d._source.profile_id, d._source);
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
// qualifies: visible conference-wide, or sharing a talk the requester also shares for.
export async function personByRef(me, ref) {
  const s = await docByRef(me.event_id, ref);
  if (!s || s.profile_id === me.profile_id) return null;
  const mine = new Set(me.shared_talk_ids ?? []);
  if (s.open_to_meet !== true && !(s.shared_talk_ids ?? []).some((id) => mine.has(id))) return null;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Blocks. A block is one document per direction; every people query leaves out both directions.

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

// Everything that connects a person to others at one conference: their blocks in both directions
// and every meet they take part in. Runs when the profile is deleted. refresh=true, so the next
// request already sees them gone.
export async function deleteConnections(eventId, profileId) {
  await people('POST', `${idx(BLOCKS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
    query: {
      bool: {
        filter: [{ term: { event_id: eventId } }],
        should: [{ term: { blocker_id: profileId } }, { term: { blocked_id: profileId } }],
        minimum_should_match: 1,
      },
    },
  });
  await people('POST', `${idx(MEETS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
    query: { bool: { filter: [{ term: { event_id: eventId } }, { term: { participants: profileId } }] } },
  });
}

// ---------------------------------------------------------------------------------------------
// Ranking people relative to the requester: one rrf retriever over
//   1. my learn_topics against their speak_topics,
//   2. my speak_topics against their learn_topics,
//   3. the query, or my interests when there is none, against their expertise (semantic),
//   4. in a search, the same text against their about (semantic),
//   5. my expertise against their interests (semantic),
//   6. in a search, the query as a lexical match on their expertise and about,
// skipping any whose input is empty. Circles add a retriever that matches every member, so a
// member with nothing in common is still listed, below everyone who shares something. Every
// retriever is named so that the explanation of a hit says which ones it came from.

const HIGHLIGHT_BASE = { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'] };
const RESULT_FIELDS = ['profile_id', 'display_name', 'about', 'expertise', 'sample', 'learn_topics', 'speak_topics', 'shared_talk_ids', 'linkedin_url', 'contact_note', 'presence_zone', 'presence_until'];

// Returns { body, legs } where legs names each retriever in order ('topics', 'text' or
// 'everyone'), or null when there is nothing to rank by.
function peopleQuery(me, filters, { size, from = 0, includeEveryone = false, query = '', blocked = new Set(), explain = false }) {
  const filter = {
    bool: {
      filter: [{ term: { event_id: me.event_id } }, { range: { visible_until: { gt: 'now' } } }, ...filters],
      must_not: [{ ids: { values: [docId(me.event_id, me.profile_id)] } }, ...notBlocked(me.event_id, blocked)],
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

  const text = query || me.interests || '';
  if (me.learn_topics?.length) add('topics', topics('speak_topics', me.learn_topics));
  if (me.speak_topics?.length) add('topics', topics('learn_topics', me.speak_topics));
  if (text) {
    add('text', knn('expertise_semantic', text));
    highlight.expertise_semantic = { number_of_fragments: 1 };
  }
  if (query) {
    add('text', knn('about_semantic', query));
    highlight.about_semantic = { number_of_fragments: 1 };
  }
  if (me.expertise) {
    add('text', knn('interests_semantic', me.expertise));
    highlight.interests_semantic = { number_of_fragments: 1 };
  }
  if (query) {
    add('text', { query: { multi_match: { query, fields: ['expertise', 'about'], minimum_should_match: '2<60%' } } });
    highlight.expertise = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
    highlight.about = { fragment_size: PASSAGE_MAX, number_of_fragments: 1 };
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
const unescapeHtml = (s) => s.replace(/<\/?mark>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function cutText(raw, max) {
  let t = String(raw).replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '');
  if (t.length > max) {
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(' ');
    t = `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
  }
  return t;
}

function passageFrom(hit) {
  const hl = hit.highlight ?? {};
  const raw = hl.expertise_semantic?.[0] ?? hl.interests_semantic?.[0];
  return raw ? cutText(raw, PASSAGE_MAX) || null : null;
}

// The passage that matched, with <mark> tags as the only markup: a lexical fragment of expertise
// or about when the query matched words there, else the best semantic chunk of expertise or
// about, else the start of their expertise (or about). Null for a profile with no text at all.
function evidenceFor(hit) {
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
// reasons; zone is included only while both the requester and this person are around. A broad
// match carries no evidence and is labelled with the common topic it shares instead.
function toPerson(hit, me, labels, talkTitles, circleTalkId, { search = false, broad = false } = {}) {
  const s = hit._source ?? {};
  const topicsOf = (ids) => (ids ?? []).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) }));
  const evidence = broad ? null : evidenceFor(hit);
  const around = isAround(s);
  const zone = around && isAround(me) && s.presence_zone ? s.presence_zone : null;
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
    broad,
  };
}

async function circleCounts(slug, ids) {
  const { json } = await people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(slug)), {
    size: 0,
    query: {
      bool: {
        filter: [{ term: { event_id: slug } }, { range: { visible_until: { gt: 'now' } } }, { terms: { shared_talk_ids: ids } }],
      },
    },
    aggs: { talks: { terms: { field: 'shared_talk_ids', include: ids, size: ids.length } } },
  });
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const b of json.aggregations?.talks?.buckets ?? []) counts[b.key] = b.doc_count;
  return counts;
}

// The requester's stored profile, authenticated by the device secret. Throws 403 on a wrong
// secret; returns null when there is no live document.
export async function authenticated(device, slug) {
  const own = await ownDoc(slug, device.profileId);
  if (!own.found) return null;
  if (!secretMatches(device.secret, own.source.secret_hash)) throw forbidden();
  if (!isLive(own.source)) return null;
  return { ...own.source, event_id: slug, profile_id: device.profileId };
}

// ---------------------------------------------------------------------------------------------
// Handlers.

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
    if (own.found) {
      await deleteDoc(id);
      await deleteConnections(conf.slug, device.profileId);
    }
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
  const presence = own.found ? Object.fromEntries(PRESENCE_FIELDS.map((f) => [f, own.source[f] ?? null])) : PRESENCE_OFF;
  if (!body.open_to_meet) Object.assign(common, PRESENCE_OFF);

  let status;
  if (!own.found) {
    // op_type create: an existing document can never be taken over by a new device.
    status = await bulkOne(
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
        ...common,
      },
    );
    if (status === 409) throw forbidden();
  } else {
    const guard = { _id: id, if_seq_no: own.seqNo, if_primary_term: own.primaryTerm };
    if (own.source.text_hash === hash) {
      // Text unchanged: a Bulk partial update without the text fields reuses the embeddings.
      status = await bulkOne({ update: guard }, { doc: common });
    } else {
      status = await bulkOne(
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
          ...common,
        },
      );
    }
    if (status === 409) throw new HttpError(409, { error: 'The profile changed at the same time; try again' });
  }
  if (status < 200 || status > 299) throw new UpstreamError(`bulk item status ${status}`);
  sendJson(res, 200, { ok: true, open_to_meet: body.open_to_meet, shared_talk_ids: shared });
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
    await deleteDoc(docId(slug, device.profileId));
    await deleteConnections(slug, device.profileId);
  }
  sendJson(res, 200, { ok: true });
}

const MATCHES_KEYS = new Set(['event', 'interested_talk_ids', 'query', 'when', 'from', 'size']);

// Runs a people search. Should the cluster refuse the explanation, the search runs again without
// it and every hit is kept.
async function searchPeople(slug, body) {
  const path = withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(slug));
  try {
    return (await people('POST', path, body)).json;
  } catch (err) {
    if (!body.explain || !(err instanceof UpstreamError) || err.message !== 'status 400') throw err;
    const { explain, ...rest } = body;
    return (await people('POST', path, rest)).json;
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
// by a text retriever, or one whose explanation is missing, is specific.
function isBroad(hit, legs, me, common) {
  const matched = matchedLegs(hit, legs);
  if (!matched || matched.some((i) => legs[i] !== 'topics')) return false;
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
  const q = peopleQuery(me, filters, { size, from, query, blocked, explain: true });
  if (!q) {
    sendJson(res, 200, { results: [], from, size, has_more: false });
    return;
  }
  // Only talks the requester marked and also shared for are named in a reason, so a match never
  // reveals a talk circle the requester has not joined.
  const mine = new Set(me.shared_talk_ids ?? []);
  const talkIds = interested.filter((id) => mine.has(id));
  const [json, topics] = await Promise.all([searchPeople(conf.slug, q.body), topicsOf(conf.slug)]);
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
  const q = peopleQuery(me, [{ term: { shared_talk_ids: talkId } }], { size: MEMBERS_SIZE, includeEveryone: true, blocked });
  const [talks, { json }, labels] = await Promise.all([
    talksById(conf.slug, [talkId], ['title', 'start', 'end', 'url', 'speaker_profiles']),
    people('POST', withPreference(`${idx(PEOPLE_INDEX)}/_search`, peoplePreference(conf.slug)), q.body),
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
