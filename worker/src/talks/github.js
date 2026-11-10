// POST /api/import/github: proposes profile text and topics from a public GitHub handle, ported
// from server/import-github.mjs (PLAN section 1.7).
//
// The Durable Object reads the public GitHub REST API (no sign-in) with a User-Agent, and with
// GITHUB_TOKEN only if that secret exists. It turns the public repositories into a proposal and
// maps languages and repository topics onto the conference's own topics (store.topics()). Nothing
// is stored and the handle is never logged.
//
// Body: { event, handle }. Returns { ok: true, proposal } with
//   { about, expertise, topic_candidates, repo_count, suggested_speak_topics, extra_terms }.
// Errors: 400 for bad input, 404 { error: 'not_found' }, 429 { error: 'rate_limited' } when GitHub
// rate-limits us, 502 { error: 'upstream' } for any other GitHub failure.

import { HttpError, bad, isPlainObject } from '../lib/http.js';
import { validEvent } from './recommend.js';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'ConferenceCaddie/0.2';
const GITHUB_TIMEOUT_MS = 8000;
const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BODY_KEYS = new Set(['event', 'handle']);
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 10 * 60_000;

const ABOUT_MAX = 280;
const EXPERTISE_MAX = 500;
const RECENT_REPOS = 15;
const RECENT_WEIGHT = 2;
const DESCRIBED_REPOS = 6;
const CANDIDATES_MAX = 20;
const SUGGESTED_MAX = 15;

export class GithubError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code; // 'not_found' | 'rate_limited' | 'upstream'
    this.httpStatus = status;
  }
}

function githubHeaders(env) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (env?.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function githubGet(env, path) {
  let res;
  try {
    res = await fetch(GITHUB_API + path, { headers: githubHeaders(env), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
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

async function fetchGithub(env, handle) {
  const h = encodeURIComponent(handle);
  const [user, repos] = await Promise.all([
    githubGet(env, `/users/${h}`),
    githubGet(env, `/users/${h}/repos?per_page=100&sort=pushed&type=owner`),
  ]);
  if (!isPlainObject(user) || !Array.isArray(repos)) throw new GithubError('upstream', 'shape');
  return { user, repos };
}

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function cut(textValue, max) {
  if (textValue.length <= max) return textValue;
  const head = textValue.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${space > max * 0.6 ? head.slice(0, space) : head}…`;
}

const sentence = (textValue) => textValue.replace(/[.\s]+$/g, '');
const lower = (s) => clean(s).toLowerCase();

export function buildProposal(user, repos) {
  const kept = repos
    .filter((r) => isPlainObject(r) && !r.fork && !r.archived && typeof r.name === 'string')
    .sort((a, b) => String(b.pushed_at ?? '').localeCompare(String(a.pushed_at ?? '')));
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
  const candidates = [];
  for (const term of [...byWeight(languages), ...byWeight(repoTopics)]) {
    if (candidates.length >= CANDIDATES_MAX) break;
    if (!candidates.includes(term)) candidates.push(term);
  }
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
      if (parts.length) continue;
      part = cut(part, room);
    }
    parts.push(part);
  }
  const bio = clean(user.bio);
  return { about: bio ? cut(bio, ABOUT_MAX) : '', expertise: parts.join(' '), topic_candidates: candidates, repo_count: kept.length };
}

// The conference's topics whose label is the candidate or starts with it as a whole word; for each
// candidate the exact label first, then shorter labels, then by rank.
const normalizeLabel = (s) => lower(s).replace(/[-_]/g, ' ');

export function mapTopics(store, candidates) {
  if (!candidates.length) return { suggested: [], extra: [] };
  const topics = store.topics().list;
  const suggested = [];
  const seen = new Set();
  const extra = [];
  for (const candidate of candidates) {
    const c = normalizeLabel(candidate);
    const hits = topics
      .map((t) => ({ t, l: normalizeLabel(t.label) }))
      .filter(({ l }) => l === c || l.startsWith(`${c} `))
      .sort((a, b) => (a.l === c ? 0 : 1) - (b.l === c ? 0 : 1) || a.l.length - b.l.length || a.t.rank - b.t.rank);
    if (!hits.length) {
      extra.push(candidate);
      continue;
    }
    for (const { t } of hits) {
      if (seen.has(t.topic_id) || suggested.length >= SUGGESTED_MAX) continue;
      seen.add(t.topic_id);
      suggested.push({ topic_id: t.topic_id, label: t.label });
    }
  }
  return { suggested, extra };
}

export function validate(body) {
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  validEvent(body.event);
  if (typeof body.handle !== 'string' || !HANDLE_RE.test(body.handle.trim())) throw bad('handle is not a GitHub user name');
  return body.handle.trim();
}

// Returns the proposal, or throws an HttpError with today's status and body.
export async function proposeFromGithub(ctx, handle) {
  let data;
  try {
    data = await fetchGithub(ctx.env, handle);
  } catch (err) {
    if (!(err instanceof GithubError)) throw err;
    // The log names the failure class and GitHub's status, never the handle.
    if (err.code !== 'not_found') console.error(`GitHub import ${err.code}: ${err.httpStatus}`);
    const status = err.code === 'not_found' ? 404 : err.code === 'rate_limited' ? 429 : 502;
    throw new HttpError(status, { error: err.code }, err.code === 'rate_limited' ? { 'Retry-After': '600' } : {});
  }
  const proposal = buildProposal(data.user, data.repos);
  const mapped = mapTopics(ctx.store, proposal.topic_candidates);
  return { ...proposal, suggested_speak_topics: mapped.suggested, extra_terms: mapped.extra };
}
