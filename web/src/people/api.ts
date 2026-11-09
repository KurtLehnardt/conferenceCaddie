// Calls to the people, circles, recommendations and topics endpoints of CONTRACT3.
// The X-Caddie-Device header goes only to /api/people/*, /api/circles/members, /api/presence
// and /api/meet/*. This is the only place that reads the device secret.
import { getDevice } from './storage';
import type { CircleMembers, Inbox, MeetDetail, MeetState, PersonResult, Position, PresenceMode, Recommendation, TopicHit } from './types';

export class PeopleApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
    public count: number | null = null,
  ) {
    super(message);
  }
}

/** The server's own wording for a text field that the filter held back. */
export const FILTERED_MESSAGE = 'That was held back by the filter. Edit it and try again.';

function friendly(status: number, code: string | null = null, message: string | null = null): string {
  if (code === 'filtered') return message ?? FILTERED_MESSAGE;
  if (status === 0) return 'You appear to be offline. Check your connection and try again.';
  if (status === 429) return message ?? 'Too many requests. Wait a minute and try again.';
  if (status === 403) return 'This device is not allowed to do that.';
  if (status >= 500) return 'This is unavailable right now. Please try again.';
  return 'That could not be saved. Check your details and try again.';
}

async function call<T>(path: string, init: RequestInit & { device?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.device) {
    const d = getDevice();
    if (!d) throw new PeopleApiError(friendly(403), 403, 'no_device');
    headers['X-Caddie-Device'] = `${d.profile_id}.${d.secret}`;
  }
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body, signal: init.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new PeopleApiError(friendly(0), 0);
  }
  if (!res.ok) {
    let code: string | null = null;
    let count: number | null = null;
    let message: string | null = null;
    try {
      const body = await res.json();
      code = typeof body?.error === 'string' ? body.error : null;
      count = typeof body?.count === 'number' ? body.count : null;
      message = typeof body?.message === 'string' ? body.message.slice(0, 200) : null;
    } catch {
      // The body is not JSON; the status is enough.
    }
    throw new PeopleApiError(friendly(res.status, code, message), res.status, code, count);
  }
  return (await res.json()) as T;
}

const post = (body: unknown, signal?: AbortSignal, device = false) =>
  ({ method: 'POST', body: JSON.stringify(body), signal, device }) as const;

export interface ProfileBody {
  event: string;
  profile: {
    display_name: string;
    about: string;
    interests: string;
    expertise: string;
    learn_topics: string[];
    speak_topics: string[];
    linkedin_url: string | null;
    contact_note: string;
  };
  open_to_meet: boolean;
  shared_talk_ids: string[];
}

export function putProfile(body: ProfileBody) {
  return call<{ ok: boolean; open_to_meet: boolean; shared_talk_ids: string[] }>('/api/people/profile', {
    method: 'PUT',
    body: JSON.stringify(body),
    device: true,
  });
}

export function deleteProfile(slug: string) {
  return call<{ ok: boolean }>(`/api/people/profile?event=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    device: true,
  });
}

export interface MatchQuery {
  /** Free text, up to 300 characters. Left out when empty, so the server uses the profile. */
  query?: string;
  when?: 'anyone' | 'around_now';
  from?: number;
  size?: number;
}

export const MATCH_PAGE = 20;

export function fetchMatches(slug: string, interestedIds: string[], signal?: AbortSignal, q: MatchQuery = {}) {
  const body: Record<string, unknown> = { event: slug, interested_talk_ids: interestedIds.slice(0, 100) };
  const text = q.query?.trim().slice(0, 300);
  if (text) body.query = text;
  if (q.when) body.when = q.when;
  if (q.from) body.from = q.from;
  if (q.size) body.size = Math.min(q.size, MATCH_PAGE);
  return call<{ results: PersonResult[] }>('/api/people/matches', post(body, signal, true));
}

/* ---------- Find & connect: block, presence, meet ---------- */

export function blockPerson(slug: string, ref: string) {
  return call<{ ok: boolean }>('/api/people/block', post({ event: slug, ref }, undefined, true));
}

export function unblockPerson(slug: string, ref: string) {
  return call<{ ok: boolean }>('/api/people/block', {
    method: 'DELETE',
    body: JSON.stringify({ event: slug, ref }),
    device: true,
  });
}

export function fetchBlocks(slug: string, signal?: AbortSignal) {
  return call<{ refs: string[]; blocks?: { ref: string; display_name: string | null; created_at: string }[] }>(
    `/api/people/blocks?event=${encodeURIComponent(slug)}`,
    { signal, device: true },
  );
}

/**
 * With a position, the server keeps it (rounded) only while its accuracy is within 200 m. `until`
 * 'day' runs presence to the end of the conference day instead of an hour.
 */
export function putPresence(slug: string, zone: string, spot: string, location: Position | null = null, until: PresenceMode = 'hour') {
  const body: Record<string, unknown> = { event: slug, zone, spot: spot.trim().slice(0, 60) };
  if (location) body.location = { lat: location.lat, lon: location.lon, accuracy: Math.round(location.accuracy) };
  if (until !== 'hour') body.until = until;
  return call<{ ok: boolean; presence_until: string; located?: boolean }>('/api/presence', {
    method: 'PUT',
    body: JSON.stringify(body),
    device: true,
  });
}

export function deletePresence(slug: string) {
  return call<{ ok: boolean }>(`/api/presence?event=${encodeURIComponent(slug)}`, { method: 'DELETE', device: true });
}

export function requestMeet(slug: string, ref: string, topicId: string | null, note: string) {
  return call<{ meet_id: string; state: MeetState }>(
    '/api/meet',
    post({ event: slug, ref, topic_id: topicId, note: note.trim().slice(0, 140) }, undefined, true),
  );
}

export function fetchInbox(slug: string, signal?: AbortSignal) {
  return call<Inbox>(`/api/meet/inbox?event=${encodeURIComponent(slug)}`, { signal, device: true });
}

export type MeetAction = 'accept' | 'decline' | 'found' | 'cancel';

export function meetAction(meetId: string, action: MeetAction) {
  return call<{ ok: boolean; state: MeetState }>(`/api/meet/${encodeURIComponent(meetId)}/${action}`, {
    method: 'POST',
    body: '{}',
    device: true,
  });
}

export function putMeetDetails(meetId: string, details: { spot_me?: string; rendezvous?: string }) {
  return call<{ ok: boolean }>(`/api/meet/${encodeURIComponent(meetId)}/details`, {
    method: 'PUT',
    body: JSON.stringify(details),
    device: true,
  });
}

export function fetchMeet(meetId: string, signal?: AbortSignal) {
  return call<MeetDetail>(`/api/meet/${encodeURIComponent(meetId)}`, { signal, device: true });
}

export function fetchCircleCounts(slug: string, talkIds: string[]) {
  return call<{ counts: Record<string, number> }>(
    '/api/circles/counts',
    post({ event: slug, talk_ids: talkIds.slice(0, 100) }),
  );
}

export function fetchCircleMembers(slug: string, talkId: string, signal?: AbortSignal) {
  return call<CircleMembers>(
    '/api/circles/members',
    post({ event: slug, talk_id: talkId }, signal, true),
  );
}

export interface RecommendationBody {
  event: string;
  learn_topics: string[];
  speak_topics: string[];
  interests: string;
  expertise: string;
  interested_talk_ids: string[];
  size: number;
}

export function fetchRecommendations(body: RecommendationBody, signal?: AbortSignal) {
  return call<{ results: Recommendation[]; needs_profile?: boolean }>(
    '/api/recommendations',
    post(body, signal),
  );
}

export function fetchTopics(slug: string, q: string, size: number, signal?: AbortSignal) {
  const qs = new URLSearchParams({ event: slug, q, size: String(size) });
  return call<{ topics: TopicHit[] }>(`/api/topics?${qs}`, { signal });
}

export function suggestTopics(slug: string, talkIds: string[], text: string, signal?: AbortSignal) {
  return call<{ topics: TopicHit[] }>(
    '/api/topics/suggest',
    post({ event: slug, talk_ids: talkIds.slice(0, 100), text: text.slice(0, 500) }, signal),
  );
}

export function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}
