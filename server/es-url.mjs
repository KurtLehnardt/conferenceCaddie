// The Elasticsearch address of this server, from ES_URL. It has no default: a deployment without
// it must not start, because a default would send this deployment's API keys to somebody else's
// cluster. Importing this module throws when ES_URL is empty or unset, the way server/capabilities.mjs
// refuses an unusable TALKS_BUNDLE_BASE, and server/index.mjs imports it first.

/** ES_URL without trailing slashes, or throws. */
export function esUrlFrom(value) {
  const url = String(value ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('ES_URL is not set. Set it to the Elasticsearch address, for example https://<deployment>.es.io:443.');
  return url;
}

export const ES_URL = esUrlFrom(process.env.ES_URL);
