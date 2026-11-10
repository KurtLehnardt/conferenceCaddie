// HTTP helpers shared by the Worker, the Durable Objects and the route modules.
//
// Every handler throws HttpError for an expected failure (validation, auth, limits); the router
// turns it into a JSON response with its status, body and headers. Anything else becomes a 502
// with the route's fixed message, so no internal detail ever reaches a client.

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error ?? 'error');
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const bad = (message) => new HttpError(400, { error: message });
export const forbidden = () => new HttpError(403, { error: 'forbidden' });

// A JSON response. Cache-Control defaults to no-store unless the caller sets it.
export function json(status, obj, headers = {}) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Reads a JSON object body. The Worker has already capped its size. Throws 415 for another
// content type, and 400 for malformed JSON, a non-object, or a key outside allowedKeys (a Set).
export async function readJson(req, allowedKeys) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, { error: 'Content-Type must be application/json' });
  let raw;
  try {
    raw = await req.text();
  } catch {
    throw bad('Could not read the request body');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bad('Malformed JSON');
  }
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  if (allowedKeys) {
    for (const k of Object.keys(body)) if (!allowedKeys.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  }
  return body;
}

// A trimmed text field with CRLF normalised, at most max characters. Missing gives ''.
export function text(value, name, max, { required = false } = {}) {
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

// A deduplicated list of at most max ids, each matching re. Missing gives [].
export function idList(value, name, max, re) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((v) => typeof v === 'string' && re.test(v))) {
    throw bad(`${name} must be an array of at most ${max} ids`);
  }
  return [...new Set(value)];
}

// The id formats of server/people.mjs and server/connect.mjs.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
export const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
export const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const REF_RE = /^[0-9a-f]{16}$/;
export const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

// Seconds from now until 00:00 UTC, when Cloudflare's daily limits reset. At least 1.
export function secondsUntilUtcMidnight(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

// True when an error says a daily Cloudflare limit was reached (Durable Object requests, rows
// read or rows written). Such errors become 503 daily_limit instead of a generic 502.
export function isDailyLimitError(err) {
  const m = String(err?.message ?? '');
  return /daily|exceeded.*(limit|quota|allowance)|(limit|quota|allowance).*exceeded/i.test(m);
}

export function dailyLimitResponse(nowMs = Date.now()) {
  return json(503, { error: 'daily_limit' }, { 'Retry-After': String(secondsUntilUtcMidnight(nowMs)) });
}
