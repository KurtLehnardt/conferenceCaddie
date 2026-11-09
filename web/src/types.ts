// Types that mirror the POST /api/search contract in docs/CONTRACT.md.

export interface SearchFilters {
  day: string | null;
  start_after: string | null;
  start_before: string | null;
  track: string[];
  level: string[];
  has_slides: boolean | null;
  hide_sponsor: boolean;
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  saved_talk_ids?: string[];
  size?: number;
}

export interface Talk {
  talk_id: string;
  title: string;
  speakers: string[];
  room: string | null;
  start: string;
  end: string;
  track: string;
  level: string;
  flags: string[];
  slides_url: string | null;
  url: string;
}

export interface SearchResult extends Talk {
  evidence: string;
}

export interface FacetBucket<T = string> {
  value: T;
  count: number;
}

export interface Facets {
  day: FacetBucket<string>[];
  track: FacetBucket<string>[];
  level: FacetBucket<string>[];
  has_slides: FacetBucket<boolean>[];
}

export interface SearchResponse {
  total: number;
  results: SearchResult[];
  facets: Facets;
}

export interface ErrorResponse {
  error: string;
}

/** A saved talk is stored without its evidence. */
export type SavedTalk = Talk;

export const EMPTY_FILTERS: SearchFilters = {
  day: null,
  start_after: null,
  start_before: null,
  track: [],
  level: [],
  has_slides: null,
  hide_sponsor: false,
};
