import type { Conference } from '../types';

// Routes are /e/{slug} with a hash tab on top, for example /e/some-event-2026#/search.
// A tab can carry a view and a day, for example #/interested?view=day&day=2026-11-10 or
// #/search?view=schedule&day=2026-11-10, so Back and a reload keep the view.
// The server serves index.html for unknown HTML paths, so no router library is needed.

export type Tab = 'people' | 'for-you' | 'search' | 'interested' | 'profile' | 'settings';

const TABS: Tab[] = ['people', 'for-you', 'search', 'interested', 'profile', 'settings'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** The view inside a tab: List or Day on Interested, Search or Schedule on Search. */
export type TabView = 'list' | 'day' | 'search' | 'schedule';

const VIEWS: TabView[] = ['list', 'day', 'search', 'schedule'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface TabParams {
  view?: TabView;
  /** A local "YYYY-MM-DD" day in the conference's time zone. */
  day?: string;
}

export interface Route {
  slug: string | null;
  tab: Tab;
  params: TabParams;
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
  const [h, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const tab = TABS.includes(h as Tab) ? (h as Tab) : 'people';
  const q = new URLSearchParams(query);
  const params: TabParams = {};
  const view = q.get('view') as TabView | null;
  if (view && VIEWS.includes(view)) params.view = view;
  const day = q.get('day');
  if (day && DAY.test(day)) params.day = day;
  return { slug, tab, params };
}

/** "#/interested?view=day&day=2026-11-10", leaving out what is not set. */
export function tabHash(tab: Tab, params: TabParams = {}): string {
  const q = new URLSearchParams();
  if (params.view) q.set('view', params.view);
  if (params.day) q.set('day', params.day);
  const qs = q.toString();
  return `#/${tab}${qs ? `?${qs}` : ''}`;
}

/**
 * Changes the current tab's view or day in the URL without a history entry. The entry's state is
 * kept, because the history record in trail.ts numbers each entry there.
 */
export function replaceTabParams(tab: Tab, params: TabParams): void {
  history.replaceState(history.state, '', `${location.pathname}${location.search}${tabHash(tab, params)}`);
  window.dispatchEvent(new Event('caddie:route'));
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
