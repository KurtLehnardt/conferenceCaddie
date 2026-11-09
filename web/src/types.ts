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

export interface SearchResult extends Talk {
  evidence: string;
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
  results: SearchResult[];
  facets: Facets;
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
