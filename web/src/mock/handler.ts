// MOCK_FIXTURE_DO_NOT_SHIP
// A crude in-browser stand-in for POST /api/search, used only in development
// with VITE_MOCK=1. It applies filters and saved-talk conflicts roughly the way
// the server does, so the UI can be exercised without Elasticsearch.
import type { Facets, SearchFilters, SearchRequest, SearchResponse } from '../types';
import { EMPTY_FILTERS } from '../types';
import { MOCK_TALKS, type MockTalk } from './fixtures';

function minutes(iso: string): number {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}

function hhmm(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

type Group = 'day' | 'track' | 'level' | 'has_slides' | 'none';

function passes(t: MockTalk, f: SearchFilters, skip: Group): boolean {
  if (skip !== 'day' && f.day && t.start.slice(0, 10) !== f.day) return false;
  const after = hhmm(f.start_after);
  const before = hhmm(f.start_before);
  if (after !== null && minutes(t.start) < after) return false;
  if (before !== null && minutes(t.start) >= before) return false;
  if (skip !== 'track' && f.track.length && !f.track.includes(t.track)) return false;
  if (skip !== 'level' && f.level.length && !f.level.includes(t.level)) return false;
  if (skip !== 'has_slides' && f.has_slides !== null && (t.slides_url !== null) !== f.has_slides) return false;
  if (f.hide_sponsor && t.sponsor) return false;
  return true;
}

function count<T>(talks: MockTalk[], key: (t: MockTalk) => T) {
  const map = new Map<T, number>();
  for (const t of talks) map.set(key(t), (map.get(key(t)) ?? 0) + 1);
  return [...map.entries()].map(([value, count]) => ({ value, count }));
}

function highlight(text: string, terms: string[]): string | null {
  let hit = false;
  let out = text;
  for (const term of terms) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    if (re.test(out)) {
      hit = true;
      out = out.replace(re, '<mark>$1</mark>');
    }
  }
  return hit ? out : null;
}

export async function handleSearch(body: SearchRequest): Promise<SearchResponse> {
  const f = { ...EMPTY_FILTERS, ...body.filters };
  const terms = body.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  const saved = MOCK_TALKS.filter((t) => body.saved_talk_ids?.includes(t.talk_id));
  const pool = MOCK_TALKS.filter((t) => {
    if (saved.some((s) => t.start < s.end && t.end > s.start)) return false;
    if (!terms.length) return true;
    const hay = `${t.title} ${t.abstract} ${t.speakers.join(' ')}`.toLowerCase();
    return terms.some((w) => hay.includes(w));
  });

  const matched = pool.filter((t) => passes(t, f, 'none'));
  const facets: Facets = {
    day: count(pool.filter((t) => passes(t, f, 'day')), (t) => t.start.slice(0, 10)).sort((a, b) =>
      a.value.localeCompare(b.value),
    ),
    track: count(pool.filter((t) => passes(t, f, 'track')), (t) => t.track).sort((a, b) => b.count - a.count),
    level: count(pool.filter((t) => passes(t, f, 'level')), (t) => t.level).sort((a, b) => b.count - a.count),
    has_slides: count(pool.filter((t) => passes(t, f, 'has_slides')), (t) => t.slides_url !== null),
  };

  const results = matched.slice(0, body.size ?? 10).map(({ abstract, sponsor: _sponsor, ...t }) => ({
    ...t,
    evidence:
      highlight(abstract, terms) ?? highlight(t.title, terms) ?? abstract.slice(0, 160),
  }));

  return { total: matched.length, results, facets };
}
