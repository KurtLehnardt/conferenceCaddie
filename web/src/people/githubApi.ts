// The call to POST /api/import/github. It sends only the conference slug and the handle the
// person typed, carries no device header (nothing is written) and follows api.ts's conventions:
// a PeopleApiError with the status and the server's error code on failure. The handle is never
// stored on the device; it lives in component state until the preview is closed.
import { PeopleApiError } from './api';
import type { TopicRef } from './types';

/** The same rule as the server: 1 to 39 characters, letters, digits and single hyphens inside. */
export const GITHUB_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface GithubProposal {
  /** One line from the GitHub bio, or "" when there is none. At most 280 characters. */
  about: string;
  /** "Built {repo} ({language}): {description}." sentences, at most 500 characters. */
  expertise: string;
  /** Lowercased languages and repository topics, at most 20. */
  topic_candidates: string[];
  repo_count: number;
  /** Candidates that matched this conference's topics, at most 15. */
  suggested_speak_topics: TopicRef[];
  /** Candidates that matched nothing here. */
  extra_terms: string[];
}

/** Error codes the server sends for this route; anything else is treated as "could not reach". */
export type GithubImportCode = 'not_found' | 'rate_limited' | 'upstream';

/** Accepts "octocat", "@octocat" or "https://github.com/octocat" and returns the bare handle. */
export function normalizeHandle(raw: string): string {
  let s = raw.trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  return s.replace(/^@/, '').trim();
}

export async function importGithub(event: string, handle: string, signal?: AbortSignal): Promise<GithubProposal> {
  let res: Response;
  try {
    res = await fetch('/api/import/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, handle }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new PeopleApiError(GITHUB_ERROR_COPY.upstream, 0, 'upstream');
  }
  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = await res.json();
      code = typeof body?.error === 'string' ? body.error : null;
    } catch {
      // The status is enough.
    }
    throw new PeopleApiError(githubErrorCopy(res.status, code), res.status, code);
  }
  const body = (await res.json()) as { ok: boolean; proposal: GithubProposal };
  return body.proposal;
}

export const GITHUB_ERROR_COPY = {
  not_found: 'No GitHub user with that name.',
  rate_limited: 'GitHub is busy; try again in a few minutes.',
  upstream: 'Could not reach GitHub.',
  invalid: 'That does not look like a GitHub user name.',
} as const;

/** The person-facing sentence for a failed import. Our own rate limit reads as GitHub being busy. */
export function githubErrorCopy(status: number, code: string | null): string {
  if (status === 404 || code === 'not_found') return GITHUB_ERROR_COPY.not_found;
  if (status === 429 || code === 'rate_limited') return GITHUB_ERROR_COPY.rate_limited;
  if (status === 400) return GITHUB_ERROR_COPY.invalid;
  return GITHUB_ERROR_COPY.upstream;
}
