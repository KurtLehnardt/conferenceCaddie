import { notePace } from './pace';

// Where the API and the app live. Both are build settings with empty defaults, so the Cloud Run
// and Cloudflare Worker builds keep relative `/api/...` calls and root paths. A build for another host
// can set them:
//   VITE_API_BASE  the Worker's origin, for example https://caddie.example.workers.dev
//   VITE_BASE      the path the app is served under, for example /conferenceCaddie/ (read by Vite,
//                  which exposes it here as import.meta.env.BASE_URL, always with a trailing slash)

/** The API origin with no trailing slash, or the empty string when the API is same-origin. */
export const API_BASE: string = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').trim().replace(/\/+$/, '');

/** The path the app is served under, always starting and ending with a slash. */
export const BASE_URL: string = import.meta.env.BASE_URL || '/';

/** Prefixes an API path such as `/api/search` with the API origin; unchanged when there is none. */
export function apiUrl(path: string): string {
  return API_BASE && path.startsWith('/') ? `${API_BASE}${path}` : path;
}

/** The API's origin, or null when the API is served from the app's own origin. */
export function apiOrigin(): string | null {
  if (!API_BASE) return null;
  try {
    return new URL(API_BASE).origin;
  } catch {
    return null;
  }
}

/** A path inside the app, such as `icons/icon-192.png` or `/icons/icon-192.png`, under the base. */
export function appPath(path: string): string {
  return `${BASE_URL}${path.replace(/^\/+/, '')}`;
}

/** Removes the base from a pathname, leaving a path that starts with a slash. */
export function stripBase(pathname: string): string {
  if (BASE_URL !== '/' && (pathname === BASE_URL.slice(0, -1) || pathname.startsWith(BASE_URL))) {
    return `/${pathname.slice(BASE_URL.length)}`;
  }
  return pathname;
}

/**
 * fetch() for an API path: prefixes the API origin and records the `X-Caddie-Pace` header of the
 * answer, so every API call, from any module, keeps the poll pacing up to date.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), init);
  notePace(res);
  return res;
}
