import type { Conference, InterestedTalk, Talk } from '../types';

// Every read and write is wrapped: storage can be full, blocked or missing.
const INTERESTED_PREFIX = 'caddie.interested.v1.';
const CONFERENCES_KEY = 'caddie.conferences.v1';
const THEME_KEY = 'caddie.theme';

export type ThemePref = 'system' | 'light' | 'dark';

function isInterested(v: unknown, slug: string): v is InterestedTalk {
  const t = v as InterestedTalk;
  return (
    !!t &&
    typeof t.talk_id === 'string' &&
    t.conference === slug &&
    typeof t.title === 'string' &&
    typeof t.start === 'string' &&
    typeof t.end === 'string' &&
    // A demo conference's talks have no official page, so their url is null.
    (typeof t.url === 'string' || t.url === null) &&
    Array.isArray(t.speakers) &&
    Array.isArray(t.tags)
  );
}

/** The talks marked "I'm interested" for one conference, on this device only. */
export function loadInterested(slug: string): InterestedTalk[] {
  try {
    const raw = localStorage.getItem(INTERESTED_PREFIX + slug);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => isInterested(t, slug)) : [];
  } catch {
    return [];
  }
}

export function storeInterested(slug: string, talks: InterestedTalk[]): void {
  try {
    localStorage.setItem(INTERESTED_PREFIX + slug, JSON.stringify(talks));
  } catch {
    // The in-memory list still works for this visit.
  }
}

/** Keeps only the talk fields, so evidence and recommendation reasons are never stored. */
export function toInterested(t: Talk): InterestedTalk {
  return {
    talk_id: t.talk_id,
    conference: t.conference,
    title: t.title,
    speakers: t.speakers,
    room: t.room,
    start: t.start,
    end: t.end,
    track: t.track,
    level: t.level,
    tags: t.tags ?? [],
    topics: t.topics,
    speaker_profiles: t.speaker_profiles,
    slides_url: t.slides_url,
    url: t.url,
    marked_at: new Date().toISOString(),
  };
}

export function loadConferences(): Conference[] | null {
  try {
    const raw = localStorage.getItem(CONFERENCES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.conferences) ? (parsed.conferences as Conference[]) : null;
  } catch {
    return null;
  }
}

export function storeConferences(conferences: Conference[]): void {
  try {
    localStorage.setItem(CONFERENCES_KEY, JSON.stringify({ conferences }));
  } catch {
    // The list is fetched again on the next visit.
  }
}

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const THEME_COLORS = { light: '#f5f6f8', dark: '#0f1115' };

export function applyTheme(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // The theme still applies for this visit.
  }
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  // Keep the browser chrome color in step with a forced theme.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m) => {
    const isDarkMeta = (m.getAttribute('media') ?? '').includes('dark');
    const color = pref === 'system' ? THEME_COLORS[isDarkMeta ? 'dark' : 'light'] : THEME_COLORS[pref];
    m.setAttribute('content', color);
  });
}
