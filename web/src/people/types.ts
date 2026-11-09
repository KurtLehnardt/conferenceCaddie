// Types for the people features. They mirror CONTRACT3 section 4 and are kept
// structural, so the shell's own conference and talk types can be passed in.

export interface ConferenceLike {
  slug: string;
  name: string;
  start_date?: string;
  end_date?: string;
  time_zone?: string | null;
}

/** The talk fields the people screens read. A shell talk result fits this. */
export interface TalkLike {
  talk_id: string;
  title: string;
  start: string;
  end: string;
  url?: string;
  room?: string | null;
  speakers?: string[];
}

/** The shell passes the Interested list (talk objects) or, for one talk, a boolean. */
export type InterestedProp = boolean | ReadonlyArray<TalkLike | string> | null | undefined;

export interface TopicRef {
  topic_id: string;
  label: string;
}

export interface TopicHit extends TopicRef {
  talk_count: number;
}

export interface Contact {
  linkedin_url: string | null;
  contact_note: string | null;
}

export interface PersonResult {
  ref: string;
  display_name: string;
  about: string | null;
  sample: boolean;
  learn_topics: TopicRef[];
  speak_topics: TopicRef[];
  reasons: string[];
  opener: string;
  contact: Contact | null;
}

export interface SpeakerProfile {
  name: string;
  tagline: string | null;
  links: { title: string; url: string }[];
}

export interface CircleMembers {
  talk: { title: string; start: string; end: string; url: string };
  speakers: SpeakerProfile[];
  count: number;
  members: PersonResult[];
}

export interface Recommendation extends TalkLike {
  url: string;
  room: string | null;
  speakers: string[];
  track?: string;
  level?: string | null;
  topics?: TopicRef[];
  speaker_profiles?: SpeakerProfile[];
  // learn_topics and speak_topics name the request's topics by set; topics is the older union of both
  // and is read only when a server predates the split.
  why: { topics: string[]; learn_topics?: string[]; speak_topics?: string[]; passage: string | null };
  circle_count: number;
}

export interface Profile {
  display_name: string;
  about: string;
  interests: string;
  expertise: string;
  linkedin_url: string;
  contact_note: string;
  /** Topic choices per conference slug. */
  topics: Record<string, { learn: TopicRef[]; speak: TopicRef[] }>;
}

export interface Visibility {
  open_to_meet: boolean;
  shared_talk_ids: string[];
  /** True once the server holds a document for this conference. */
  on_server: boolean;
  share_notice_seen: boolean;
  /** Ended talks whose banner the user has already seen or closed. */
  banner_seen: string[];
  /**
   * Device-only preference: sharing follows the Interested list, so marking a talk shares for
   * it and unmarking stops. Off by default; the user turns it on from the Interested screen.
   */
  share_new: boolean;
}

export interface Device {
  profile_id: string;
  secret: string;
}
