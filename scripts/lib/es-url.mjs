// The Elasticsearch address for the operator scripts. It has no default: a fork must never send its
// API key to somebody else's cluster. It is read when a request is made, not when a module loads,
// so --dry-run, --no-fetch and --list paths that make no request run without ES_URL.

/** ES_URL without a trailing slash. Throws "Set ES_URL." when it is empty or unset. */
export function esUrl() {
  const url = String(process.env.ES_URL || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Set ES_URL.');
  return url;
}

/** Same as esUrl(), for the standalone scripts: prints the message and exits 1 instead of throwing. */
export function esUrlOrExit() {
  try {
    return esUrl();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
