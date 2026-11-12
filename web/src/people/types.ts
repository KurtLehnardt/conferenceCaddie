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
  /** True for a broad match: found only through a common topic, so it carries no evidence. */
  broad?: boolean;
}

/**
 * How close someone who is around is: the same zone, the same ~100 m cell, cells under 300 m apart,
 * or just the venue. The server computes it from cells only, never from a precise position.
 */
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
/**
 * What a presence write sends as `until`: a mode, or 'keep' to leave the server's end as it is
 * (only to a backend whose capabilities say people.presence_keep_until).
 */
export type PresenceUntil = PresenceMode | 'keep';

/** A position as sent with presence: degrees and the accuracy in metres. */
export interface Position {
  lat: number;
  lon: number;
  accuracy: number;
}

/** Web Push nudges: device-side state (caddie.push.v1.{slug}). */
export interface PushState {
  /** True while this browser holds a subscription the server knows about. */
  on: boolean;
  /** The subscription's endpoint, so it can be removed by name; null while off. */
  endpoint: string | null;
  notice_seen: boolean;
  /** When the server last accepted this endpoint for this conference (ms since the epoch), or null. */
  synced_at: number | null;
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

/** Asks are now-only: accept moves a meet straight to `active`. `accepted` is a legacy value the server no longer sends. */
export type MeetState = 'requested' | 'accepted' | 'declined' | 'active' | 'found' | 'cancelled' | 'expired';

export interface InboxIncoming {
  meet_id: string;
  from: { ref: string; display_name: string; about: string | null };
  topic_label: string | null;
  note: string;
  created_at: string;
  /** When the ask runs out: 15 minutes after it was made. */
  expires_at?: string | null;
  /** True when both were around in the same zone when the ask was made; `other.zone` is then set. */
  same_zone?: boolean;
  other?: { zone?: string | null };
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
  same_zone?: boolean;
  other: {
    ref?: string | null;
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
  // learn_topics names the request's learn topics that the talk has; topics is kept equal to it
  // and is read only when a response predates the split.
  why: { topics: string[]; learn_topics?: string[]; passage: string | null };
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
  /**
   * True from the moment a first write for this conference is sent until the server answers it:
   * if the answer never arrives, the server may hold a document all the same.
   */
  maybe_on_server: boolean;
  share_notice_seen: boolean;
  /** Ended talks whose banner the user has already seen or closed. */
  banner_seen: string[];
  /**
   * Device-only preference: sharing follows the Interested list, so marking a talk shares for
   * it and unmarking stops. Off by default; the user turns it on from the Interested screen.
   */
  share_new: boolean;
  /** True when the server last said this profile is hidden after reports (its owner still sees it). */
  hidden_for_owner: boolean;
}

/** How a profile delete failed, as far as the user is concerned. */
export type DeleteFailure = 'partial' | 'offline' | 'rate' | 'forbidden' | 'bad';

/**
 * A profile delete the server has not confirmed yet: either for one conference (its server copy
 * may be partly deleted) or "Delete my profile" as a whole. While one is stored, the device sends
 * no profile write it covers, and the delete is tried again.
 */
export interface DeleteRetry {
  /** Failed attempts so far; they set how long the next automatic attempt waits. */
  attempts: number;
  /** Time in epoch milliseconds before which no automatic attempt is sent; 0 for at once. */
  next_at: number;
  /** Attempts in a row that the server refused this device's key (403). */
  forbidden: number;
  /** How the last attempt failed, or null before the first failure. */
  last: DeleteFailure | null;
  /** Time in epoch milliseconds the delete was first asked for. */
  since: number;
}

/** Report: what a report is about and why. */
export type ReportKind = 'profile' | 'meet' | 'spot';
export type ReportReason = 'harassment' | 'hate' | 'sexual' | 'spam' | 'other';

export interface Device {
  profile_id: string;
  secret: string;
}
