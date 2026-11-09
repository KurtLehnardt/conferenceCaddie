import type { Conference } from '../types';

// Routes are /e/{slug} with a hash tab on top, for example /e/some-event-2026#/search.
// The server serves index.html for unknown HTML paths, so no router library is needed.

export type Tab = 'people' | 'for-you' | 'search' | 'interested' | 'profile' | 'settings' | 'inbox' | 'meet' | 'here';

const TABS: Tab[] = ['people', 'for-you', 'search', 'interested', 'profile', 'settings', 'inbox', 'meet', 'here'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

export interface Route {
  slug: string | null;
  tab: Tab;
  /** The rest of the hash for `#/meet/{id}` and `#/here/{zone}`, raw (still encoded). */
  param: string | null;
  /** The query after the tab, as in `#/people?around=1` (a push nudge opens Around now). */
  query: URLSearchParams;
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
  const full = location.hash.replace(/^#\/?/, '');
  const qm = full.indexOf('?');
  const query = new URLSearchParams(qm >= 0 ? full.slice(qm + 1) : '');
  const h = qm >= 0 ? full.slice(0, qm) : full;
  const slash = h.indexOf('/');
  const head = (slash >= 0 ? h.slice(0, slash) : h) as Tab;
  const rest = slash >= 0 ? h.slice(slash + 1) : '';
  if (!TABS.includes(head)) return { slug, tab: 'people', param: null, query };
  // Only the meet and here routes take a parameter, and they need one.
  if (head === 'meet' || head === 'here') {
    return rest ? { slug, tab: head, param: rest.slice(0, 200), query } : { slug, tab: 'people', param: null, query };
  }
  return { slug, tab: head, param: null, query };
}

/** A route parameter as written in the hash, decoded; the raw value when it is not valid encoding. */
export function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
