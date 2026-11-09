// Stable Elasticsearch shard-copy preferences.
//
// The talks, topics and people indexes each have one shard with a primary and a replica. The two
// copies hold different numbers of deleted documents, so they score and break ties differently,
// and without a preference two identical requests can read different copies and come back in a
// different order. A custom preference string makes Elasticsearch pick the same copy for the
// same string, so every request for one conference, from any Cloud Run instance, reads the same
// copy. Ranking, retrievers and scores are untouched; this only chooses which copy answers.
//
// One preference per conference for talks, topics and facets, so a conference's talks search,
// For you, related talks, topic labels and chips all agree. One per event for the people index,
// and one for the conference list. The blocks and meets indexes use their event's people
// preference too, and the hourly sweep for expired presence, which spans every event, has its own.

export const conferencePreference = (slug) => `caddie-${slug}`;
export const peoplePreference = (event) => `caddie-people-${event}`;
export const CONFERENCES_PREFERENCE = 'caddie-conferences';
export const PEOPLE_PURGE_PREFERENCE = 'caddie-people-purge';

// Adds ?preference=... (or &preference=... when the path already has a query string) to a path.
export function withPreference(path, preference) {
  return `${path}${path.includes('?') ? '&' : '?'}preference=${encodeURIComponent(preference)}`;
}
