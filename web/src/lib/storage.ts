import type { SavedTalk, SearchResult } from '../types';

const SAVED_KEY = 'caddie.saved.v1';
const THEME_KEY = 'caddie.theme';

export type ThemePref = 'system' | 'light' | 'dark';

function isSavedTalk(v: unknown): v is SavedTalk {
  const t = v as SavedTalk;
  return (
    !!t &&
    typeof t.talk_id === 'string' &&
    typeof t.title === 'string' &&
    typeof t.start === 'string' &&
    typeof t.end === 'string' &&
    Array.isArray(t.speakers) &&
    Array.isArray(t.flags)
  );
}

export function loadSaved(): SavedTalk[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedTalk) : [];
  } catch {
    return [];
  }
}

export function storeSaved(talks: SavedTalk[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(talks));
  } catch {
    // Storage may be full or blocked; the in-memory agenda still works.
  }
}

/** Drops the evidence so only talk details are stored on the device. */
export function toSaved(r: SearchResult | SavedTalk): SavedTalk {
  const { evidence: _evidence, ...rest } = r as SearchResult;
  return rest;
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
