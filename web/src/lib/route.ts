import type { Conference } from '../types';

// Routes are /e/{slug} with a hash tab on top, for example /e/some-event-2026#/search.
// The server serves index.html for unknown HTML paths, so no router library is needed.

export type Tab = 'people' | 'for-you' | 'search' | 'interested' | 'profile' | 'settings';

const TABS: Tab[] = ['people', 'for-you', 'search', 'interested', 'profile', 'settings'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

export interface Route {
  slug: string | null;
  tab: Tab;
}

export function readRoute(): Route {
  const m = location.pathname.match(/^\/e\/([^/]+)\/?$/);
  let slug: string | null = null;
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      slug = SLUG.test(decoded) ? decoded : decoded ? '' : null;
    } catch {
      slug = '';
    }
  }
  const h = location.hash.replace(/^#\/?/, '') as Tab;
  return { slug, tab: TABS.includes(h) ? h : 'people' };
}

export function conferencePath(slug: string, tab: Tab): string {
  return `/e/${encodeURIComponent(slug)}#/${tab}`;
}

/** Navigates to another conference, adding a history entry so Back returns. */
export function goToConference(slug: string, tab: Tab): void {
  history.pushState(null, '', conferencePath(slug, tab));
  window.dispatchEvent(new Event('caddie:route'));
}

/** Rewrites the URL without a history entry, used for the "/" redirect. */
export function replaceConference(slug: string, tab: Tab): void {
  history.replaceState(null, '', conferencePath(slug, tab));
  window.dispatchEvent(new Event('caddie:route'));
}

/** "/" goes to the first searchable conference that has not ended, else the last searchable one. */
export function defaultConference(conferences: Conference[]): Conference | null {
  const today = new Date().toISOString().slice(0, 10);
  const searchable = conferences.filter((c) => c.status === 'searchable');
  return searchable.find((c) => c.end_date >= today) ?? searchable[searchable.length - 1] ?? null;
}
