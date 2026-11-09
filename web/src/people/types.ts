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
  /** The highlighted passage that matched a text search (Find & connect, M2). */
  evidence?: string | null;
  /** True while they are around; `zone` is sent only when both of us are around. */
  around?: boolean;
  zone?: string | null;
  /** A band only, sent only when both of us are around; never a distance. */
  proximity?: Proximity | null;
}

/** How close someone who is around is: the same zone, under 75 m, under 300 m, or just the venue. */
export type Proximity = 'same_zone' | 'near' | 'around' | 'venue';

/** Find & connect: device-side presence state (caddie.presence.v1.{slug}). */
export interface Presence {
  on: boolean;
  zone: string | null;
  spot: string;
  /** ISO time when presence turns off by itself; null while off. */
  until: string | null;
  notice_seen: boolean;
  /** GPS bands: true while the device also sends its position with presence. */
  position: boolean;
  /** The answer to "Use my position too", asked once; null until answered. */
  position_choice: 'yes' | 'no' | null;
  /** How long presence runs: an hour, or until turned off, at the latest at the end of the day. */
  mode: PresenceMode;
  /** ISO time the zone was last chosen, confirmed or dismissed; null while off. */
  confirmed_at: string | null;
  /** True once the app came back to the foreground with a zone older than the threshold. */
  confirm_pending: boolean;
  /** Zones chosen on this device, most recent first, for ordering the "Still in" chips. */
  recent_zones: string[];
}

export type PresenceMode = 'hour' | 'day';

/** A position as sent with presence: degrees and the accuracy in metres. */
export interface Position {
  lat: number;
  lon: number;
  accuracy: number;
}

/** One blocked person, cached on the device (caddie.blocks.v1.{slug}). */
export interface BlockedPerson {
  ref: string;
  display_name: string | null;
}

/** Someone saved from a finished meet (caddie.met.v1.{slug}); device-only. */
export interface MetPerson {
  display_name: string;
  about: string;
  met_at: string;
}

export type MeetState = 'requested' | 'accepted' | 'declined' | 'active' | 'found' | 'cancelled' | 'expired';

export interface InboxIncoming {
  meet_id: string;
  from: { ref: string; display_name: string; about: string | null };
  topic_label: string | null;
  note: string;
  created_at: string;
  state: MeetState;
}

export interface InboxOutgoing {
  meet_id: string;
  to: { ref: string; display_name: string };
  state: MeetState;
}

export interface Inbox {
  incoming: InboxIncoming[];
  outgoing: InboxOutgoing[];
}

export interface MeetDetail {
  state: MeetState;
  active_until: string | null;
  other: {
    display_name: string;
    zone: string | null;
    spot: string | null;
    spot_me: string | null;
    about?: string | null;
    /** Only while the meet is active and both of us sent a position: metres, rounded to 10. */
    distance_m?: number;
    /** With `distance_m`: degrees clockwise from north, from me to them. */
    bearing_deg?: number;
  };
  rendezvous: string | null;
  mine: { spot_me: string | null };
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
  why: { topics: string[]; passage: string | null };
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
