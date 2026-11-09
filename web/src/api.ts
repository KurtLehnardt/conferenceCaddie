import type { ConferencesResponse, SearchFilters, SearchRequest, SearchResponse, SearchResult, Talk } from './types';

// In development with VITE_MOCK=1, main.tsx installs an in-browser stand-in for
// every /api route before the app renders, so this module always uses fetch.

export class ApiError extends Error {}

async function post<T>(path: string, body: unknown, signal: AbortSignal, failure: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError(res.status >= 500 ? 'Search is unavailable right now. Please try again.' : failure);
  return (await res.json()) as T;
}

export function search(
  conference: string,
  query: string,
  filters: SearchFilters,
  size: number,
  signal: AbortSignal,
  debug = false,
  ignorePhrases: string[] = [],
): Promise<SearchResponse> {
  const body: SearchRequest = {
    conference,
    query: query.trim().slice(0, 200),
    filters,
    size,
  };
  if (debug) body.debug = true;
  if (ignorePhrases.length) body.ignore_phrases = ignorePhrases;
  return post<SearchResponse>('/api/search', body, signal, 'That search could not be run. Try removing a filter.');
}

export async function getConferences(signal?: AbortSignal): Promise<ConferencesResponse> {
  let res: Response;
  try {
    res = await fetch('/api/conferences', { signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError('Conferences are temporarily unavailable. Please try again.');
  return (await res.json()) as ConferencesResponse;
}

/** Up to five talks of the same conference that are closest in meaning to one talk. */
export async function getRelated(conference: string, talkId: string, signal?: AbortSignal): Promise<Talk[]> {
  let res: Response;
  try {
    res = await fetch(`/api/related?event=${encodeURIComponent(conference)}&talk_id=${encodeURIComponent(talkId)}`, { signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError('Related talks are unavailable right now. Please try again.');
  return ((await res.json()) as { results: Talk[] }).results;
}

export type ImportConfidence = 'exact_title' | 'title_and_speaker' | 'title_and_time' | 'title_words';

export interface ImportMatch {
  talk: SearchResult;
  confidence: ImportConfidence;
  /** A short piece of the user's own file, returned only to them. */
  matched_text_excerpt: string;
}

export interface ImportResponse {
  matched: ImportMatch[];
  unmatched_count: number;
  extracted_chars: number;
}

export type ImportPayload = { filename: string; mime: string; content_base64: string } | { text: string };

/**
 * Sends a schedule file or pasted text once, to find the conference's talks in it. The server
 * processes it in memory and stores nothing.
 */
export async function importSchedule(conference: string, payload: ImportPayload, signal?: AbortSignal): Promise<ImportResponse> {
  let res: Response;
  try {
    res = await fetch('/api/import/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: conference, ...payload }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  if (res.ok) return (await res.json()) as ImportResponse;
  // 413, 415, 422 and 429 carry a plain-language reason written for the user.
  let reason = '';
  try {
    reason = String(((await res.json()) as { error?: unknown }).error ?? '');
  } catch {
    /* no reason */
  }
  if ([413, 415, 422, 429].includes(res.status) && reason) throw new ApiError(reason);
  if (res.status >= 500) throw new ApiError('Import is unavailable right now. Please try again.');
  throw new ApiError('That file could not be read. Please try another file or paste the text.');
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error)?.name === 'AbortError';
}
