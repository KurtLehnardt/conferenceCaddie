// POST /api/import/github: propose profile text and topics from a public GitHub handle.
//
// The person types a handle. The server reads the public GitHub REST API (no sign-in, no OAuth),
// turns the public repositories into a proposal, maps the languages and repository topics onto
// the conference's own topics, and returns the proposal. Nothing is stored anywhere and the
// handle is never logged: only what the person accepts in the app lands in the profile fields,
// through the ordinary profile write.
//
// Body: { event, handle }. No device header, because nothing is written.
// Returns { ok: true, proposal }, where proposal is
//   { about, expertise, topic_candidates, repo_count, suggested_speak_topics, extra_terms }.
// Errors: 400 for bad input, 404 { error: 'not_found' } for an unknown handle, 429
// { error: 'rate_limited' } when GitHub rate-limits this server, 502 { error: 'upstream' } for
// any other GitHub failure, and the usual 429 { error: 'Too many requests' } from our own limit.
//
// Env: GITHUB_TOKEN (optional). When set it is sent as a Bearer token and raises GitHub's limit
// from 60 to 5000 requests per hour; when absent the calls are unauthenticated. It is never
// printed or written anywhere.

import { take, clientIp } from './ratelimit.mjs';
import {
  BadRequest, failure, isPlainObject, readJsonPost, searchTopics, sendJson, UpstreamError, validEvent,
} from './recommend.mjs';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'ConferenceCaddie/0.2';
const GITHUB_TIMEOUT_MS = 8000;

const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BODY_KEYS = new Set(['event', 'handle']);

// Our own limit: GitHub gives an unauthenticated server 60 calls an hour and each import spends
// two, so one address gets five imports per ten minutes.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60_000;

const ABOUT_MAX = 280;
const EXPERTISE_MAX = 500;
const RECENT_REPOS = 15;
const RECENT_WEIGHT = 2;
const DESCRIBED_REPOS = 6;
const CANDIDATES_MAX = 20;
const SUGGESTED_MAX = 15;
const TOPICS_FETCH = 100;
// The same fields /api/topics type-ahead uses.
const TYPE_AHEAD_FIELDS = ['label', 'label._2gram', 'label._3gram', 'aliases', 'aliases._2gram', 'aliases._3gram'];

export class GithubError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code; // 'not_found' | 'rate_limited' | 'upstream'
    this.httpStatus = status;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub transport.

function githubHeaders() {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet(path, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(GITHUB_API + path, { headers: githubHeaders(), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  } catch (err) {
    throw new GithubError('upstream', err?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new GithubError('not_found', 404);
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    await res.body?.cancel();
    throw new GithubError('rate_limited', res.status);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GithubError('upstream', res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new GithubError('upstream', 'invalid');
  }
}

// Reads the public user and the repositories they own. The handle goes only into the URL path.
export async function fetchGithub(handle, fetchImpl = fetch) {
  const h = encodeURIComponent(handle);
  const [user, repos] = await Promise.all([
    githubGet(`/users/${h}`, fetchImpl),
    githubGet(`/users/${h}/repos?per_page=100&sort=pushed&type=owner`, fetchImpl),
  ]);
  if (!isPlainObject(user) || !Array.isArray(repos)) throw new GithubError('upstream', 'shape');
  return { user, repos };
}

// ---------------------------------------------------------------------------------------------
// Proposal building. Plain text from GitHub's own fields; nothing is invented.

// Collapses whitespace and drops control characters, which have no place in a profile field.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function cut(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return (space > max * 0.6 ? head.slice(0, space) : head) + '…';
}

// A description as one sentence: trailing full stops stripped so exactly one is added.
const sentence = (text) => text.replace(/[.\s]+$/g, '');

const lower = (s) => clean(s).toLowerCase();

export function buildProposal(user, repos) {
  const kept = repos
    .filter((r) => isPlainObject(r) && !r.fork && !r.archived && typeof r.name === 'string')
    .sort((a, b) => String(b.pushed_at ?? '').localeCompare(String(a.pushed_at ?? '')));

  // Weighted counts, lowercased: a term on one of the 15 most recently pushed repos counts double.
  const languages = new Map();
  const repoTopics = new Map();
  kept.forEach((r, i) => {
    const w = i < RECENT_REPOS ? RECENT_WEIGHT : 1;
    const lang = lower(r.language);
    if (lang) languages.set(lang, (languages.get(lang) ?? 0) + w);
    for (const t of Array.isArray(r.topics) ? r.topics : []) {
      const topic = lower(t);
      if (topic) repoTopics.set(topic, (repoTopics.get(topic) ?? 0) + w);
    }
  });
  const byWeight = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  // Languages first, then repository topics, deduplicated, at most 20.
  const candidates = [];
  for (const term of [...byWeight(languages), ...byWeight(repoTopics)]) {
    if (candidates.length >= CANDIDATES_MAX) break;
    if (!candidates.includes(term)) candidates.push(term);
  }

  // "Built {repo} ({language}): {description}." for the most recent repos that have one, joined
  // by spaces while the whole stays within the field's 500 characters.
  const parts = [];
  for (const r of kept) {
    if (parts.length >= DESCRIBED_REPOS) break;
    const description = sentence(clean(r.description));
    if (!description) continue;
    const name = clean(r.name);
    const language = clean(r.language);
    let part = `Built ${name}${language ? ` (${language})` : ''}: ${description}.`;
    const room = EXPERTISE_MAX - parts.join(' ').length - (parts.length ? 1 : 0);
    if (part.length > room) {
      // The first sentence is cut to fit; a later one that does not fit is left out.
      if (parts.length) continue;
      part = cut(part, room);
    }
    parts.push(part);
  }
  const expertise = parts.join(' ');

  const bio = clean(user.bio);
  const about = bio ? cut(bio, ABOUT_MAX) : '';

  return { about, expertise, topic_candidates: candidates, repo_count: kept.length };
}

// ---------------------------------------------------------------------------------------------
// Topic mapping: the conference's topics whose label is the candidate, or starts with it as a
// whole word. The lookup is the same bool_prefix type-ahead /api/topics runs, in one request.

const normalizeLabel = (s) => lower(s).replace(/[-_]/g, ' ');

function labelMatches(label, candidate) {
  const l = normalizeLabel(label);
  const c = normalizeLabel(candidate);
  return l === c || l.startsWith(`${c} `);
}

export async function mapTopics(event, candidates) {
  if (!candidates.length) return { suggested: [], extra: [] };
  const json = await searchTopics({
    size: TOPICS_FETCH,
    _source: ['topic_id', 'label'],
    query: {
      bool: {
        filter: [{ term: { conference: event } }],
        should: candidates.map((q) => ({ multi_match: { query: q, type: 'bool_prefix', fields: TYPE_AHEAD_FIELDS } })),
        minimum_should_match: 1,
      },
    },
  });
  const topics = (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((s) => s.topic_id && s.label);
  const suggested = [];
  const seen = new Set();
  const extra = [];
  for (const candidate of candidates) {
    const hits = topics.filter((t) => labelMatches(t.label, candidate));
    if (!hits.length) {
      extra.push(candidate);
      continue;
    }
    for (const t of hits) {
      if (seen.has(t.topic_id) || suggested.length >= SUGGESTED_MAX) continue;
      seen.add(t.topic_id);
      suggested.push({ topic_id: t.topic_id, label: t.label });
    }
  }
  return { suggested, extra };
}

// ---------------------------------------------------------------------------------------------

function validate(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);
  const event = validEvent(body.event);
  if (typeof body.handle !== 'string' || !HANDLE_RE.test(body.handle.trim())) throw new BadRequest('handle is not a GitHub user name');
  return { event, handle: body.handle.trim() };
}

export async function proposeFromGithub(event, handle, fetchImpl = fetch) {
  const { user, repos } = await fetchGithub(handle, fetchImpl);
  const proposal = buildProposal(user, repos);
  let mapped;
  try {
    mapped = await mapTopics(event, proposal.topic_candidates);
  } catch (err) {
    // The GitHub data is the point of the call; a failed topic lookup leaves every term unmatched.
    console.error(`GitHub import topic lookup unavailable: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'Error')}`);
    mapped = { suggested: [], extra: proposal.topic_candidates };
  }
  return { ...proposal, suggested_speak_topics: mapped.suggested, extra_terms: mapped.extra };
}

export async function handleImportGithubApi(req, res, url) {
  if (url.pathname !== '/api/import/github') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    return true;
  }
  const rate = take(`github:${clientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.ok) {
    sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(rate.retryAfterSec) });
    return true;
  }
  const body = await readJsonPost(req, res);
  if (body === undefined) return true;
  let params;
  try {
    params = validate(body);
  } catch (err) {
    failure(res, err, 'GitHub import');
    return true;
  }
  try {
    sendJson(res, 200, { ok: true, proposal: await proposeFromGithub(params.event, params.handle) });
  } catch (err) {
    if (err instanceof GithubError) {
      // The log names the failure class and GitHub's status, never the handle.
      if (err.code !== 'not_found') console.error(`GitHub import ${err.code}: ${err.httpStatus}`);
      const status = err.code === 'not_found' ? 404 : err.code === 'rate_limited' ? 429 : 502;
      sendJson(res, status, { error: err.code }, err.code === 'rate_limited' ? { 'Retry-After': '600' } : {});
    } else {
      console.error(`GitHub import failed: ${err?.name ?? 'Error'}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream' });
    }
  }
  return true;
}
