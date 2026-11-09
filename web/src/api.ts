import type { ConferencesResponse, SearchFilters, SearchRequest, SearchResponse } from './types';

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
): Promise<SearchResponse> {
  const body: SearchRequest = {
    conference,
    query: query.trim().slice(0, 200),
    filters,
    size,
  };
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

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error)?.name === 'AbortError';
}
