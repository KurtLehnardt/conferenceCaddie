// Sessionize endpoints. The api code and public slug always come from the schedule page config;
// they are never derived or guessed.

const CODE_RE = /^[a-z0-9]{4,32}$/i;
const PUBLIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/i;

// Returns { apiCode, publicSlug } from a data-sched-config object, or null when either is unusable.
export function feedIds(config) {
  const apiCode = typeof config?.sessionizeApiCode === 'string' ? config.sessionizeApiCode.trim() : '';
  const publicSlug = typeof config?.sessionizePublicSlug === 'string' ? config.sessionizePublicSlug.trim() : '';
  if (!CODE_RE.test(apiCode) || !PUBLIC_SLUG_RE.test(publicSlug)) return null;
  return { apiCode, publicSlug };
}

export const viewAllUrl = (apiCode) => `https://sessionize.com/api/v2/${apiCode}/view/All`;
export const apiDataUrl = (publicSlug) => `https://${publicSlug}.sessionize.com/api/data`;

// Parses a view/All body and checks that it has the five tables the importer reads.
export function parseViewAll(text) {
  const feed = JSON.parse(text);
  for (const key of ['sessions', 'speakers', 'questions', 'categories', 'rooms']) {
    if (!Array.isArray(feed?.[key])) throw new Error(`view/All has no "${key}" array.`);
  }
  return feed;
}
