// Types that mirror the API contract (docs/CONTRACT.md, phase 2 and people-first changes).

/** One entry of GET /api/conferences. */
export interface Conference {
  slug: string;
  name: string;
  start_date: string;
  end_date: string;
  time_zone: string | null;
  location: { city?: string; region?: string; country?: string; virtual?: boolean } | null;
  status: 'searchable' | 'unavailable';
  official_schedule_url: string;
  source: string;
  has_level: boolean;
  track_group: string | null;
  tag_groups: string[];
  talk_count: number;
}

export interface ConferencesResponse {
  conferences: Conference[];
}

/** A generic category value that keeps its Sessionize group name. */
export interface TagRef {
  group: string;
  value: string;
}

export interface TopicRef {
  topic_id: string;
  label: string;
}

/** Public speaker data from the feed, used to list a talk circle's speakers. */
export interface SpeakerProfile {
  name: string;
  tagline: string | null;
  links: { title: string; url: string }[];
}

export interface SearchFilters {
  day: string | null;
  start_after: string | null;
  start_before: string | null;
  track: string[];
  level: string[];
  tags: TagRef[];
  has_slides: boolean | null;
  hide_sponsor: boolean;
}

export interface SearchRequest {
  conference: string;
  query: string;
  filters?: SearchFilters;
  saved_talk_ids?: string[];
  size?: number;
  /** Asks for the ranking drawer's details; normal searches leave it out. */
  debug?: boolean;
  /** Keys of time phrases the person removed; the server then stops filtering by them. */
  ignore_phrases?: string[];
}

/** A time phrase the server found in the search text, such as "after lunch" or "Tuesday". */
export interface TimePhrase {
  key: string;
  label: string;
  /** The conference days a day or weekday phrase stands for; empty for the other phrases. */
  days: string[];
  /** False when the person removed it: it left the text but no longer filters. */
  applied: boolean;
}

export interface Talk {
  talk_id: string;
  conference: string;
  title: string;
  speakers: string[];
  room: string | null;
  start: string;
  end: string;
  track: string;
  level: string | null;
  tags: TagRef[];
  topics?: TopicRef[];
  speaker_profiles?: SpeakerProfile[];
  slides_url: string | null;
  url: string;
}

/** Where a result stood in each of the two rankings Elasticsearch fused; null is outside the window. */
export interface ResultRanking {
  rank: number;
  keyword_rank: number | null;
  semantic_rank: number | null;
}

export interface SearchResult extends Talk {
  evidence: string;
  /** Only present when the request asked for debug. */
  ranking?: ResultRanking;
}

/** The ranking window sizes and the filters every query of a debug search applied. */
export interface RankingInfo {
  rank_window: number;
  semantic_k: number;
  filters: {
    kind: string;
    day: string | null;
    start_after: string | null;
    start_before: string | null;
    track: string[];
    level: string[];
    tags: TagRef[];
    has_slides: boolean | null;
    hide_sponsor: boolean;
    time_phrases?: string[];
  };
}

/** A talk the user marked as interesting, stored on the device without its evidence. */
export interface InterestedTalk extends Talk {
  marked_at: string;
}

export interface FacetBucket<T = string> {
  value: T;
  count: number;
}

export interface TagFacet {
  group: string;
  values: FacetBucket<string>[];
}

export interface Facets {
  day: FacetBucket<string>[];
  track: FacetBucket<string>[];
  level?: FacetBucket<string>[];
  has_slides: FacetBucket<boolean>[];
  tags: TagFacet[];
}

export interface SearchResponse {
  total: number;
  conference: string;
  /** The text the search ran on, after time phrases left it. */
  search_text?: string;
  time_phrases?: TimePhrase[];
  results: SearchResult[];
  facets: Facets;
  /** Only present when the request asked for debug. */
  ranking?: RankingInfo;
}

export interface ErrorResponse {
  error: string;
}

export const EMPTY_FILTERS: SearchFilters = {
  day: null,
  start_after: null,
  start_before: null,
  track: [],
  level: [],
  tags: [],
  has_slides: null,
  hide_sponsor: false,
};
