// Deletes every people profile whose conference has ended, in every conference, clears presence
// that has run out and deletes meets that have run out.
//
// Usage: node scripts/purge-expired-people.mjs
// Env:   ES_URL; ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY); ES_PEOPLE_INDEX (default caddie-people);
//        ES_PEOPLE_MEETS_INDEX (default caddie-people-meets).
//
// The server runs the same three steps when it starts and once an hour. This is the operator's
// step for after a conference, when no instance may be running. It prints only counts. Blocks are
// not purged here: they are deleted with the profile that made them.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
const PRESENCE_PAGE = 500;

if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

async function es(method, path, body, ndjson = false) {
  const res = await fetch(`${ES_URL}${path}`, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path.split('?')[0]} failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return json;
}

// A profile is expired once visible_until has passed. A document without visible_until is never
// shown, so it is deleted as well.
const expiredProfiles = {
  bool: {
    should: [{ range: { visible_until: { lt: 'now' } } }, { bool: { must_not: { exists: { field: 'visible_until' } } } }],
    minimum_should_match: 1,
  },
};
const profiles = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_delete_by_query?conflicts=proceed`, { query: expiredProfiles });
console.log(`Deleted ${profiles.deleted ?? 0} expired profiles.`);

// Presence that has run out is cleared with a Bulk partial update of its four fields, the same
// write the server uses, so nothing is re-embedded.
const off = { presence_zone: null, presence_spot: null, presence_since: null, presence_until: null };
let cleared = 0;
for (;;) {
  const found = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_search`, {
    size: PRESENCE_PAGE,
    _source: false,
    query: { range: { presence_until: { lt: 'now' } } },
  });
  const ids = (found.hits?.hits ?? []).map((h) => h._id);
  if (!ids.length) break;
  const body = ids.map((id) => `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc: off })}\n`).join('');
  const res = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, true);
  const ok = (res.items ?? []).filter((i) => i.update?.status >= 200 && i.update?.status < 300).length;
  cleared += ok;
  if (ok < ids.length) break;
}
console.log(`Cleared ${cleared} expired presence entries.`);

const meets = await es('POST', `/${encodeURIComponent(MEETS_INDEX)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, {
  query: { range: { expires_at: { lt: 'now' } } },
});
console.log(`Deleted ${meets.deleted ?? 0} expired meets.`);
