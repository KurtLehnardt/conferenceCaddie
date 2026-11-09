// GET /api/schedule?event={slug}: one conference's talks, exported from Elasticsearch for the
// app's offline mode.
//
// The export holds only kind:talk documents of that conference, read with the read-only key, and
// only public feed fields: talk_id, conference, title, speakers, room, start, end, track, level,
// tags, topic labels, url, slides_url and the abstract trimmed to about 400 characters. It never
// touches the people index. Talks are sorted by start, then talk_id, in Elasticsearch; the app
// runs a plain keyword match over the cached copy only while the device is offline.
//
// The response is public and cacheable for five minutes. The server keeps each conference's
// export in memory for the same five minutes, so repeated loads do not reach Elasticsearch, and
// each address may ask for 20 exports a minute. An unknown or unavailable slug gets 400.

import zlib from 'node:zlib';
import { esRequest, topicLabels, UpstreamError } from './search.mjs';
import { conferencePreference, withPreference } from './preference.mjs';
import { searchableConference } from './conferences.mjs';
import { take, clientIp } from './ratelimit.mjs';

const ES_INDEX = process.env.ES_INDEX || 'caddie-talks';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MAX_TALKS = 5000;
const ABSTRACT_MAX = 400;
const TTL_MS = 5 * 60 * 1000;
const PER_MIN = 20;
const CACHE_CONTROL = 'public, max-age=300';
const SOURCE_FIELDS = ['talk_id', 'conference', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'topics', 'url', 'slides_url', 'abstract'];

const cache = new Map(); // slug -> { at, body, gzip }

function send(req, res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function trimAbstract(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= ABSTRACT_MAX) return t;
  const cut = t.slice(0, ABSTRACT_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > ABSTRACT_MAX * 0.6 ? cut.slice(0, space) : cut) + '…';
}

const asArray = (v) => (Array.isArray(v) ? v : []);

async function exportSchedule(slug) {
  const json = await esRequest(withPreference(`/${encodeURIComponent(ES_INDEX)}/_search`, conferencePreference(slug)), {
    size: MAX_TALKS,
    track_total_hits: false,
    _source: SOURCE_FIELDS,
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }] } },
    sort: [{ start: 'asc' }, { talk_id: 'asc' }],
  }, { timeoutMs: 15000 });
  const hits = json.hits?.hits ?? [];
  const labels = await topicLabels(slug, hits.flatMap((h) => asArray(h._source?.topics)));
  const talks = hits.map((h) => {
    const s = h._source ?? {};
    return {
      talk_id: String(s.talk_id ?? h._id),
      conference: slug,
      title: s.title ?? '',
      speakers: asArray(s.speakers).filter((x) => typeof x === 'string'),
      room: s.room ?? null,
      start: s.start,
      end: s.end,
      track: s.track ?? '',
      level: s.level ?? null,
      tags: asArray(s.tags)
        .filter((t) => t && typeof t.group === 'string' && typeof t.value === 'string')
        .map((t) => ({ group: t.group, value: t.value })),
      topics: asArray(s.topics).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) })),
      url: s.url,
      slides_url: s.slides_url ?? null,
      abstract: trimAbstract(s.abstract),
    };
  });
  return { conference: slug, talks };
}

// Handles GET and HEAD /api/schedule. Resolves when the response has been sent.
export async function handleSchedule(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
    return;
  }
  const rate = take(`schedule:${clientIp(req)}`, PER_MIN);
  if (!rate.ok) {
    send(req, res, 429, { error: 'Too many requests' }, { 'Retry-After': String(rate.retryAfterSec) });
    return;
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'event') {
      send(req, res, 400, { error: `Unknown parameter: ${key.slice(0, 40)}` });
      return;
    }
  }
  const slug = url.searchParams.get('event') ?? '';
  if (!SLUG_RE.test(slug)) {
    send(req, res, 400, { error: 'event is not available' });
    return;
  }
  let entry;
  try {
    if (!(await searchableConference(slug))) {
      send(req, res, 400, { error: 'event is not available' });
      return;
    }
    entry = cache.get(slug);
    if (!entry || Date.now() - entry.at > TTL_MS) {
      const body = Buffer.from(JSON.stringify(await exportSchedule(slug)));
      entry = { at: Date.now(), body, gzip: zlib.gzipSync(body) };
      cache.set(slug, entry);
    }
  } catch (err) {
    console.error(`Schedule export failed: ${err instanceof UpstreamError ? err.message : 'error'}`);
    send(req, res, 502, { error: 'The schedule is temporarily unavailable' });
    return;
  }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const payload = gzip ? entry.gzip : entry.body;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': CACHE_CONTROL,
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}
