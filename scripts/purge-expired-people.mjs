// Deletes every people profile whose conference has ended, in every conference.
//
// Usage: node scripts/purge-expired-people.mjs
// Env:   ES_URL; ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY); ES_PEOPLE_INDEX (default caddie-people).
//
// The server runs the same delete when it starts and once an hour. This is the operator's step
// for after a conference, when no instance may be running. It prints only the number deleted.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';

if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

// A profile is expired once visible_until has passed. A document without visible_until is never
// shown, so it is deleted as well.
const query = {
  bool: {
    should: [{ range: { visible_until: { lt: 'now' } } }, { bool: { must_not: { exists: { field: 'visible_until' } } } }],
    minimum_should_match: 1,
  },
};

const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_delete_by_query?conflicts=proceed`, {
  method: 'POST',
  headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(60_000),
});
const json = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`The delete failed with status ${res.status}: ${json.error?.type ?? ''}`);
  process.exit(1);
}
console.log(`Deleted ${json.deleted ?? 0} expired profiles.`);
