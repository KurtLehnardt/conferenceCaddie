// Polite HTTP for the ingestion CLI: a descriptive User-Agent, each distinct URL fetched at most once
// per run, a pause after every network call and a 30 second timeout. Node built-ins only.

// The ingest identifies itself to the sites it reads. CADDIE_USER_AGENT sets the whole string (put your
// own contact in it); the default names no one, so a fork never presents itself as the original project.
// The value becomes a header, so it must be printable ASCII (no CR, LF or other control character, which
// could inject headers) and at most 200 characters; anything else is replaced by the default, with one
// warning on stderr that never prints the rejected value.
export const DEFAULT_USER_AGENT = 'conference-caddie-ingest (+set CADDIE_USER_AGENT)';
export const USER_AGENT_MAX = 200;

export function resolveUserAgent(raw, warn = (m) => process.stderr.write(`${m}\n`)) {
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_USER_AGENT;
  const value = String(raw).trim();
  if (!/^[\x20-\x7e]+$/.test(value) || value.length > USER_AGENT_MAX) {
    warn(`CADDIE_USER_AGENT ignored: it must be printable ASCII of at most ${USER_AGENT_MAX} characters; using the default.`);
    return DEFAULT_USER_AGENT;
  }
  return value;
}

export const USER_AGENT = resolveUserAgent(process.env.CADDIE_USER_AGENT);
const PAUSE_MS = 1000;
const TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One entry per URL for the whole run. A second request for the same URL gets the first result back.
const seen = new Map();
let calls = 0;

// Returns { ok, status, text, error }. ok is true only for HTTP 200. It never throws.
export function fetchOnce(url) {
  if (!seen.has(url)) seen.set(url, doFetch(url));
  return seen.get(url);
}

async function doFetch(url) {
  calls++;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return { ok: res.status === 200, status: res.status, text, error: res.status === 200 ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  } finally {
    await sleep(PAUSE_MS);
  }
}

export function networkCalls() {
  return calls;
}
