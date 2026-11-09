import type { SearchFilters, SearchRequest, SearchResponse } from './types';

type Handler = (body: SearchRequest) => Promise<SearchResponse>;

// In development with VITE_MOCK=1 the request goes to an in-browser mock.
// The condition is static, so production builds drop the mock module entirely.
let mockHandler: Promise<Handler> | null = null;
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  mockHandler = import('./mock/handler').then((m) => m.handleSearch);
}

export class ApiError extends Error {}

export async function search(
  query: string,
  filters: SearchFilters,
  savedTalkIds: string[],
  size: number,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const body: SearchRequest = {
    query: query.trim().slice(0, 200),
    filters,
    saved_talk_ids: savedTalkIds.slice(0, 100),
    size,
  };

  if (mockHandler) {
    const handle = await mockHandler;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return handle(body);
  }

  let res: Response;
  try {
    res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  if (!res.ok) {
    throw new ApiError(
      res.status >= 500
        ? 'Search is unavailable right now. Please try again.'
        : 'That search could not be run. Try removing a filter.',
    );
  }
  return (await res.json()) as SearchResponse;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error)?.name === 'AbortError';
}
