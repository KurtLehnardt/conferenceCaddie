// Calls to the people, circles, recommendations and topics endpoints of CONTRACT3.
// The X-Caddie-Device header goes only to /api/people/* and /api/circles/members.
import { getDevice } from './storage';
import type { CircleMembers, PersonResult, Recommendation, TopicHit } from './types';

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

// The server explains a rejected write in its own words, naming the field ("display_name is
// required"). The user gets the same fact in plain words, without field names or ids. Anything not
// listed here keeps the generic text.
const FIELD_LABELS: Record<string, string> = {
  display_name: 'Your name',
  about: 'About me',
  interests: 'The text under "I want to learn about"',
  expertise: 'The text under "I can speak to"',
  contact_note: '"Another way to reach me"',
};

export function explainBadRequest(code: string | null): string | null {
  if (!code) return null;
  if (/^display_name is required/.test(code)) return 'Add your name to your profile first.';
  const tooLong = /^(\w+) must be at most (\d+) characters$/.exec(code);
  if (tooLong) return `${FIELD_LABELS[tooLong[1]] ?? 'One of your details'} is too long: ${tooLong[2]} characters at most. Shorten it in your profile.`;
  if (/^linkedin_url must be/.test(code)) return 'The LinkedIn link should look like https://www.linkedin.com/in/your-name. Fix it in your profile.';
  if (/^(learn|speak)_topics contains an unknown topic/.test(code)) return 'A topic you picked is no longer offered. Open your profile and remove it.';
  if (/^(learn|speak)_topics must be an array/.test(code)) return 'Your topics could not be saved. Open your profile and check the topics you picked.';
  if (/^shared_talk_ids (contains an unknown talk|must be talks of this conference)/.test(code)) {
    return 'A talk you share for is no longer in the schedule. Tap "Stop sharing for all", then share again.';
  }
  if (/^shared_talk_ids must be an array/.test(code)) return 'You can share for up to 50 talks.';
  if (/^conference has ended/.test(code)) return 'This conference has ended, so sharing is closed.';
  if (/^conference is not available/.test(code)) return 'Sharing is not open for this conference.';
  return null;
}

function friendly(status: number): string {
  if (status === 0) return 'You appear to be offline. Check your connection and try again.';
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
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
    try {
      const body = await res.json();
      code = typeof body?.error === 'string' ? body.error : null;
      count = typeof body?.count === 'number' ? body.count : null;
    } catch {
      // The body is not JSON; the status is enough.
    }
    throw new PeopleApiError((res.status === 400 ? explainBadRequest(code) : null) ?? friendly(res.status), res.status, code, count);
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

export function fetchMatches(slug: string, interestedIds: string[], signal?: AbortSignal) {
  return call<{ results: PersonResult[] }>(
    '/api/people/matches',
    post({ event: slug, interested_talk_ids: interestedIds.slice(0, 100) }, signal, true),
  );
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
  interests: string;
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
