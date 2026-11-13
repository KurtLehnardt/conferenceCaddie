// The conference list behind GET /api/conferences and the "is this conference searchable" check
// behind every search.
//
// The documents are read from ES_CONFERENCES_INDEX (default caddie-conferences) with one search
// sorted by start_date then name, and cached for 60 seconds. A failed read is not cached: the
// next request tries again, and until one succeeds the last successful list keeps being used.

import { esRequest, UpstreamError } from './search.mjs';
import { CONFERENCES_PREFERENCE, withPreference } from './preference.mjs';

const ES_CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const TTL_MS = 60 * 1000;

let cache = null; // { at, docs } from the last successful read
let pending = null; // the read in flight, shared by concurrent callers

async function fetchConferences() {
  const json = await esRequest(withPreference(`/${encodeURIComponent(ES_CONFERENCES_INDEX)}/_search`, CONFERENCES_PREFERENCE), {
    size: 500,
    sort: ['start_date', 'name'],
    query: { match_all: {} },
  });
  return (json.hits?.hits ?? []).map((h) => h._source).filter((s) => s && typeof s.slug === 'string');
}

async function conferenceDocs() {
  if (cache && Date.now() - cache.at <= TTL_MS) return cache.docs;
  if (!pending) {
    pending = fetchConferences()
      .then((docs) => {
        cache = { at: Date.now(), docs };
        return docs;
      })
      .finally(() => {
        pending = null;
      });
  }
  try {
    return await pending;
  } catch (err) {
    if (cache) return cache.docs;
    throw err instanceof UpstreamError ? err : new UpstreamError('conferences read failed');
  }
}

// The searchable conference with this slug, as stored, or null. Throws UpstreamError when the
// list has never been read successfully.
export async function searchableConference(slug) {
  const docs = await conferenceDocs();
  return docs.find((c) => c.slug === slug && c.status === 'searchable') ?? null;
}

// The public list of CONTRACT2 F.2. Only these fields are exposed; API codes, LF ids, status
// reasons, counts other than the talk count, and hashes never leave the server.
// The demo conference (demo: true, invented data) carries demo: true, and only while it is
// searchable: a hidden or switched-off demo is left out of the list altogether, as the talk bundles
// leave it out, so nothing of it stays visible.
export async function publicConferences() {
  const docs = await conferenceDocs();
  return docs.filter((c) => c.demo !== true || c.status === 'searchable').map((c) => {
    const mapping = c.category_mapping ?? null;
    const loc = c.location ?? {};
    const entry = {
      slug: c.slug,
      name: c.name ?? '',
      start_date: c.start_date ?? null,
      end_date: c.end_date ?? null,
      time_zone: c.time_zone ?? null,
      location: { city: loc.city ?? '', region: loc.region ?? '', country: loc.country ?? '', virtual: loc.virtual === true },
      status: c.status === 'searchable' ? 'searchable' : 'unavailable',
      official_schedule_url: c.official_schedule_url ?? null,
      source: c.source ?? 'sessionize',
      has_level: Boolean(mapping?.level_group),
      track_group: mapping?.track_group ?? null,
      tag_groups: Array.isArray(mapping?.tag_groups) ? mapping.tag_groups : [],
      talk_count: Number.isInteger(c.counts?.talk) ? c.counts.talk : 0,
    };
    if (c.demo === true) entry.demo = true;
    return entry;
  });
}
