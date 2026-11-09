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
//   REF_SALT              optional salt for the opaque result reference.
//
// Rules this module keeps:
// - Elasticsearch does all matching, ranking and filtering. People are ranked by one rrf
//   retriever; this module only builds queries and reshapes hits in the order returned. The
//   reasons shown with a result are built from the topic lists and titles of that result, which
//   explains a rank but never changes it.
// - A people document exists only while its owner is visible conference-wide or shares for at
//   least one talk. Every people query filters on event_id and on visible_until > now.
// - secret_hash, text_hash and profile_id are never returned. Request bodies, headers, profile
//   fields and secrets are never logged; the only log lines here name an Elasticsearch status.
// - Writes whose about, interests and expertise are unchanged use a Bulk API partial update that
//   omits those fields, so toggling visibility or sharing never re-runs the embedding model.

import crypto from 'node:crypto';
import { take } from './ratelimit.mjs';
import { parseDevice, hashSecret, secretMatches, refFor } from './device.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const PEOPLE_KEY = process.env.ES_PEOPLE_API_KEY || '';
const READ_KEY = process.env.ES_API_KEY || '';
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const TALKS_INDEX = process.env.ES_INDEX || 'caddie-talks';
const TOPICS_INDEX = process.env.ES_TOPICS_INDEX || 'caddie-topics';
const CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const ES_TIMEOUT_MS = 10_000;

const MAX_BODY = 8192;
const CONFERENCES_TTL_MS = 60_000;
const TOPICS_TTL_MS = 10 * 60_000;
const MATCHES_SIZE = 20;
const MEMBERS_SIZE = 50;
const RANK_WINDOW = 100;
const KNN_K = 100;
const KNN_CANDIDATES = 500;
const PASSAGE_MAX = 200;

const LIMITS = {
  writeDevice: 20,
  writeIp: 60,
  readDevice: 30,
  readIp: 90,
  publicIp: 60,
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error ?? 'error');
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
class UpstreamError extends Error {}

const bad = (message) => new HttpError(400, { error: message });
const forbidden = () => new HttpError(403, { error: 'forbidden' });

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

const people = (method, path, body, opts) => es(PEOPLE_KEY, method, path, body, opts);
const readOnly = (method, path, body, opts) => es(READ_KEY, method, path, body, opts);
const idx = (name) => `/${encodeURIComponent(name)}`;
const docId = (eventId, profileId) => `${eventId}:${profileId}`;

// ---------------------------------------------------------------------------------------------
// Conferences, topics and talks (read-only key).

let conferencesCache = null; // { at, promise }

async function fetchConferences() {
  const { json } = await readOnly('POST', `${idx(CONFERENCES_INDEX)}/_search`, {
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

// 23:59:59 on the conference's last day in its own time zone, as an ISO instant. A conference
// without a time zone uses UTC-12, the last place on earth where that day ends.
export function visibleUntil(endDate, timeZone) {
  const [y, m, d] = String(endDate).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
  if (!timeZone) return new Date(wall + 12 * 3600_000).toISOString();
  let t = wall - zoneOffsetMs(wall, timeZone);
  t = wall - zoneOffsetMs(t, timeZone);
  return new Date(t).toISOString();
}

// Returns { slug, visibleUntil } for a searchable conference, or throws 400.
async function conferenceFor(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('event must be a conference slug');
  const conf = (await conferences()).get(slug);
  if (!conf || conf.status !== 'searchable' || !conf.end_date) throw bad('conference is not available');
  return { slug, visibleUntil: visibleUntil(conf.end_date, conf.time_zone) };
}

const topicsCache = new Map(); // slug -> { at, promise }

async function fetchTopics(slug) {
  const { json } = await readOnly('POST', `${idx(TOPICS_INDEX)}/_search`, {
    size: 1000,
    _source: ['topic_id', 'label'],
    query: { term: { conference: slug } },
  });
  const map = new Map();
  for (const h of json.hits?.hits ?? []) if (h._source?.topic_id) map.set(h._source.topic_id, h._source.label ?? h._source.topic_id);
  return map;
}

// topic_id -> label for one conference, cached for ten minutes.
function topicLabels(slug) {
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

// Talks of one conference by id, kind "talk" only. Returns a Map talk_id -> _source.
async function talksById(slug, ids, fields) {
  if (!ids.length) return new Map();
  const { json } = await readOnly('POST', `${idx(TALKS_INDEX)}/_search`, {
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

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || 'unknown';
}

function limit(key, perMinute) {
  const r = take(key, perMinute);
  if (!r.ok) throw new HttpError(429, { error: 'Too many requests' }, { 'Retry-After': String(r.retryAfterSec) });
}

// A browser always sends Origin on these methods; it must name this host. curl sends none.
function checkOrigin(req) {
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

async function jsonBody(req, allowedKeys) {
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

function requireDevice(req) {
  const device = parseDevice(req);
  if (!device) throw forbidden();
  return device;
}

// ---------------------------------------------------------------------------------------------
// Validation.

function text(value, name, max, { required = false } = {}) {
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

async function checkTopics(slug, ids, name) {
  if (!ids.length) return;
  const labels = await topicLabels(slug);
  if (!ids.every((id) => labels.has(id))) throw bad(`${name} contains an unknown topic`);
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

const OWN_FIELDS = ['secret_hash', 'text_hash', 'open_to_meet', 'shared_talk_ids', 'visible_until', 'learn_topics', 'speak_topics', 'interests', 'expertise'];

// Returns { found, source, seqNo, primaryTerm } for the caller's own document.
async function ownDoc(eventId, profileId) {
  const { status, json } = await people(
    'GET',
    `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(docId(eventId, profileId))}?_source_includes=${OWN_FIELDS.join(',')}`,
    undefined,
    { okStatuses: [404] },
  );
  if (status === 404 || !json.found) return { found: false };
  return { found: true, source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term };
}

const isLive = (source) => typeof source.visible_until === 'string' && Date.parse(source.visible_until) > Date.now();

// One bulk action with refresh=wait_for. Returns the item status.
async function bulkOne(action, doc) {
  const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
  const item = json.items?.[0] ?? {};
  const result = Object.values(item)[0] ?? {};
  return result.status ?? 500;
}

async function deleteDoc(id) {
  await people('DELETE', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`, undefined, { okStatuses: [404] });
}

// ---------------------------------------------------------------------------------------------
// Ranking people relative to the requester: one rrf retriever over
//   1. my learn_topics against their speak_topics,
//   2. my speak_topics against their learn_topics,
//   3. my interests against their expertise (semantic),
//   4. my expertise against their interests (semantic),
// skipping any whose input is empty. Circles add a fifth retriever that matches every member, so
// a member with nothing in common is still listed, below everyone who shares something.

function peopleQuery(me, filters, size, { includeEveryone = false } = {}) {
  const filter = {
    bool: {
      filter: [{ term: { event_id: me.event_id } }, { range: { visible_until: { gt: 'now' } } }, ...filters],
      must_not: [{ ids: { values: [docId(me.event_id, me.profile_id)] } }],
    },
  };
  const knn = (field, modelText) => ({
    standard: {
      query: {
        knn: {
          field,
          k: KNN_K,
          num_candidates: KNN_CANDIDATES,
          filter,
          query_vector_builder: { text_embedding: { model_text: modelText } },
        },
      },
    },
  });
  const topics = (theirField, mine) => ({
    standard: { query: { bool: { should: mine.map((t) => ({ term: { [theirField]: t } })), minimum_should_match: 1 } } },
  });

  const retrievers = [];
  const highlight = {};
  if (me.learn_topics?.length) retrievers.push(topics('speak_topics', me.learn_topics));
  if (me.speak_topics?.length) retrievers.push(topics('learn_topics', me.speak_topics));
  if (me.interests) {
    retrievers.push(knn('expertise_semantic', me.interests));
    highlight.expertise_semantic = { number_of_fragments: 1 };
  }
  if (me.expertise) {
    retrievers.push(knn('interests_semantic', me.expertise));
    highlight.interests_semantic = { number_of_fragments: 1 };
  }
  if (includeEveryone) {
    retrievers.push({ standard: { query: { match_all: {} }, sort: [{ updated_at: 'desc' }] } });
  }
  if (!retrievers.length) return null;

  const body = {
    size,
    _source: ['profile_id', 'display_name', 'about', 'sample', 'learn_topics', 'speak_topics', 'shared_talk_ids', 'linkedin_url', 'contact_note'],
    retriever: retrievers.length === 1
      ? { standard: { ...retrievers[0].standard, filter } }
      : { rrf: { retrievers, filter, rank_window_size: RANK_WINDOW } },
  };
  if (Object.keys(highlight).length) body.highlight = { fields: highlight };
  return body;
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function passageFrom(hit) {
  const hl = hit.highlight ?? {};
  const raw = hl.expertise_semantic?.[0] ?? hl.interests_semantic?.[0];
  if (!raw) return null;
  let t = raw.replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '');
  if (!t) return null;
  if (t.length > PASSAGE_MAX) {
    const cut = t.slice(0, PASSAGE_MAX);
    const space = cut.lastIndexOf(' ');
    t = `${space > PASSAGE_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
  }
  return t;
}

// The reason templates of the product brief, filled from this result's own fields.
function reasonsFor(me, them, labels, talkTitles, passage, circleTalkId) {
  const reasons = [];
  const named = (ids) => ids.filter((id) => labels.has(id)).map((id) => labels.get(id));
  const theirSpeak = new Set(them.speak_topics ?? []);
  const theirLearn = new Set(them.learn_topics ?? []);
  const theirShared = new Set(them.shared_talk_ids ?? []);
  const canSpeak = named((me.learn_topics ?? []).filter((t) => theirSpeak.has(t)));
  const wantLearn = named((me.speak_topics ?? []).filter((t) => theirLearn.has(t)));
  if (canSpeak.length) reasons.push(`They can speak to ${listFormat.format(canSpeak.slice(0, 4))}, which you want to learn about.`);
  if (wantLearn.length) reasons.push(`They want to learn about ${listFormat.format(wantLearn.slice(0, 4))}, which you can speak to.`);
  const both = [...talkTitles.keys()].filter((id) => id !== circleTalkId && theirShared.has(id));
  if (both.length) reasons.push(`You are both interested in ${listFormat.format(both.slice(0, 2).map((id) => talkTitles.get(id)))}.`);
  if (passage) reasons.push(`Ask them about ${passage}.`);
  if (circleTalkId && talkTitles.has(circleTalkId)) reasons.push(`You are both interested in ${talkTitles.get(circleTalkId)}.`);
  return reasons;
}

function toPerson(hit, me, labels, talkTitles, circleTalkId) {
  const s = hit._source ?? {};
  const topicsOf = (ids) => (ids ?? []).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) }));
  const reasons = reasonsFor(me, s, labels, talkTitles, passageFrom(hit), circleTalkId);
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
  };
}

async function circleCounts(slug, ids) {
  const { json } = await people('POST', `${idx(PEOPLE_INDEX)}/_search`, {
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
async function authenticated(device, slug) {
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

  // Both visibility choices off: the document must not exist.
  if (!body.open_to_meet && !shared.length) {
    if (own.found) await deleteDoc(id);
    sendJson(res, 200, { ok: true, open_to_meet: false, shared_talk_ids: [] });
    return;
  }

  if (Date.parse(conf.visibleUntil) <= Date.now()) throw bad('conference has ended');
  await checkTopics(conf.slug, profile.learn_topics, 'learn_topics');
  await checkTopics(conf.slug, profile.speak_topics, 'speak_topics');
  await checkSharedTalks(conf.slug, shared);

  const hash = textHash(profile);
  const common = {
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
  }
  sendJson(res, 200, { ok: true });
}

const MATCHES_KEYS = new Set(['event', 'interested_talk_ids']);

async function matches(req, res) {
  const ip = clientIp(req);
  limit(`people-read:ip:${ip}`, LIMITS.readIp);
  const device = requireDevice(req);
  limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);

  const body = await jsonBody(req, MATCHES_KEYS);
  const interested = idList(body.interested_talk_ids, 'interested_talk_ids', 100, TALK_ID_RE);
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me || me.open_to_meet !== true) throw new HttpError(403, { error: 'visibility_required' });

  const query = peopleQuery(me, [{ term: { open_to_meet: true } }], MATCHES_SIZE);
  if (!query) {
    sendJson(res, 200, { results: [] });
    return;
  }
  // Only talks the requester marked and also shared for are named in a reason, so a match never
  // reveals a talk circle the requester has not joined.
  const mine = new Set(me.shared_talk_ids ?? []);
  const talkIds = interested.filter((id) => mine.has(id));
  const [{ json }, labels] = await Promise.all([
    people('POST', `${idx(PEOPLE_INDEX)}/_search`, query),
    topicLabels(conf.slug),
  ]);
  const hits = json.hits?.hits ?? [];
  const usedTalks = talkIds.filter((id) => hits.some((h) => (h._source?.shared_talk_ids ?? []).includes(id)));
  const talks = await talksById(conf.slug, usedTalks, ['title']);
  const titles = new Map([...talks].map(([id, s]) => [id, s.title ?? '']));
  sendJson(res, 200, { results: hits.map((h) => toPerson(h, me, labels, titles, null)) });
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

  const query = peopleQuery(me, [{ term: { shared_talk_ids: talkId } }], MEMBERS_SIZE, { includeEveryone: true });
  const [talks, { json }, labels] = await Promise.all([
    talksById(conf.slug, [talkId], ['title', 'start', 'end', 'url', 'speaker_profiles']),
    people('POST', `${idx(PEOPLE_INDEX)}/_search`, query),
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

// Handles /api/people/* and /api/circles/*. Resolves to true when the request was handled.
export async function handlePeopleApi(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith('/api/people/') && !path.startsWith('/api/circles/')) return false;
  const route = ROUTES[path];
  if (!route) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  const handler = route[req.method];
  if (!handler) {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: Object.keys(route).join(', ') });
    return true;
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
  return true;
}
