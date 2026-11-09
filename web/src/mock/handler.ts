// MOCK_FIXTURE_DO_NOT_SHIP
// A crude in-browser stand-in for every /api route, used only in development
// with VITE_MOCK=1. It follows the response shapes of the contract roughly, so
// the UI can be exercised without Elasticsearch. Ranking here is a placeholder;
// the real server does all matching and ranking in Elasticsearch.
import type { Facets, SearchFilters, SearchRequest, SearchResponse, TagFacet } from '../types';
import { EMPTY_FILTERS } from '../types';
import { MOCK_CONFERENCES, MOCK_PEOPLE, MOCK_TALKS, MOCK_TOPICS, type MockPerson, type MockTalk } from './fixtures';

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    public status: number,
    public body: Json,
  ) {
    super(String(body.error ?? status));
  }
}

function minutes(iso: string): number {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}

function hhmm(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

type Group = 'day' | 'track' | 'level' | 'has_slides' | `tag:${string}` | 'none';

function passes(t: MockTalk, f: SearchFilters, skip: Group): boolean {
  if (skip !== 'day' && f.day && t.start.slice(0, 10) !== f.day) return false;
  const after = hhmm(f.start_after);
  const before = hhmm(f.start_before);
  if (after !== null && minutes(t.start) < after) return false;
  if (before !== null && minutes(t.start) >= before) return false;
  if (skip !== 'track' && f.track.length && !f.track.includes(t.track)) return false;
  if (skip !== 'level' && f.level.length && !f.level.includes(t.level ?? '')) return false;
  const groups = new Set(f.tags.map((x) => x.group));
  for (const g of groups) {
    if (skip === `tag:${g}`) continue;
    const wanted = f.tags.filter((x) => x.group === g).map((x) => x.value);
    if (!t.tags.some((x) => x.group === g && wanted.includes(x.value))) return false;
  }
  if (skip !== 'has_slides' && f.has_slides !== null && (t.slides_url !== null) !== f.has_slides) return false;
  if (f.hide_sponsor && t.sponsor) return false;
  if (f.happening_now) {
    const now = Date.now();
    if (!(Date.parse(t.end) > now && Date.parse(t.start) < now + 60 * 60_000)) return false;
  }
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

function strip({ abstract: _a, sponsor: _s, kind: _k, ...t }: MockTalk) {
  return t;
}

function conferenceOf(slug: unknown) {
  const c = MOCK_CONFERENCES.find((x) => x.slug === slug && x.status === 'searchable');
  if (!c) throw new HttpError(400, { error: 'conference is not available' });
  return c;
}

function handleSearch(body: SearchRequest): SearchResponse {
  const conf = conferenceOf(body.conference);
  const f = { ...EMPTY_FILTERS, ...body.filters };
  if (f.level.length && !conf.has_level) {
    throw new HttpError(400, { error: 'filters.level is not available for this conference' });
  }
  const terms = body.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const pool = MOCK_TALKS.filter((t) => {
    if (t.conference !== conf.slug) return false;
    if (!terms.length) return true;
    const hay = `${t.title} ${t.abstract} ${t.speakers.join(' ')}`.toLowerCase();
    return terms.some((w) => hay.includes(w));
  });

  const matched = pool.filter((t) => passes(t, f, 'none'));
  const tags: TagFacet[] = conf.tag_groups.map((group) => {
    const values = new Map<string, number>();
    for (const t of pool.filter((x) => passes(x, f, `tag:${group}`))) {
      for (const tag of t.tags) if (tag.group === group) values.set(tag.value, (values.get(tag.value) ?? 0) + 1);
    }
    for (const sel of f.tags) if (sel.group === group && !values.has(sel.value)) values.set(sel.value, 0);
    return { group, values: [...values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count) };
  });
  const facets: Facets = {
    day: count(pool.filter((t) => passes(t, f, 'day')), (t) => t.start.slice(0, 10)).sort((a, b) =>
      a.value.localeCompare(b.value),
    ),
    track: count(pool.filter((t) => passes(t, f, 'track')), (t) => t.track).sort((a, b) => b.count - a.count),
    has_slides: count(pool.filter((t) => passes(t, f, 'has_slides')), (t) => t.slides_url !== null),
    tags,
  };
  if (conf.has_level) {
    facets.level = count(pool.filter((t) => passes(t, f, 'level')), (t) => t.level ?? '').sort((a, b) => b.count - a.count);
  }

  const results = matched.slice(0, body.size ?? 10).map((t) => ({
    ...strip(t),
    evidence: highlight(t.abstract, terms) ?? highlight(t.title, terms) ?? t.abstract.slice(0, 160),
  }));
  return { total: matched.length, conference: conf.slug, results, facets };
}

/* ---------- People, circles, recommendations and topics ---------- */

// Profiles written by this browser, kept in sessionStorage so a reload keeps them.
interface Stored {
  profile: Json;
  open_to_meet: boolean;
  shared_talk_ids: string[];
}
const STORE_KEY = 'caddie.mock.people';

function readStore(): Record<string, Stored> {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeStore(s: Record<string, Stored>) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Mock data is disposable.
  }
}

function device(headers: Headers): string {
  const v = headers.get('X-Caddie-Device') ?? '';
  const [id, secret] = v.split('.');
  if (!id || !secret) throw new HttpError(403, { error: 'forbidden' });
  return id;
}

function topicRefs(conference: string, ids: string[]) {
  return ids.map((id) => ({
    topic_id: id,
    label: MOCK_TOPICS.find((t) => t.conference === conference && t.topic_id === id)?.label ?? id,
  }));
}

function personResult(p: MockPerson, me: Stored | undefined, interestedIds: string[]) {
  const myLearn = (me?.profile.learn_topics as string[] | undefined) ?? [];
  const mySpeak = (me?.profile.speak_topics as string[] | undefined) ?? [];
  const reasons: string[] = [];
  const canTeach = p.speak_topics.filter((t) => myLearn.includes(t));
  const wantsMine = p.learn_topics.filter((t) => mySpeak.includes(t));
  const label = (ids: string[]) => topicRefs(p.event_id, ids).map((t) => t.label).join(', ');
  if (canTeach.length) reasons.push(`They can speak to ${label(canTeach)}, which you want to learn about.`);
  if (wantsMine.length) reasons.push(`They want to learn about ${label(wantsMine)}, which you can speak to.`);
  const both = p.shared_talk_ids.find((id) => interestedIds.includes(id));
  if (both) reasons.push(`You are both interested in ${MOCK_TALKS.find((t) => t.talk_id === both)?.title}.`);
  if (!reasons.length) reasons.push(`Ask them about ${label(p.speak_topics)}.`);
  return {
    ref: p.ref,
    display_name: p.display_name,
    about: p.about,
    sample: p.sample,
    learn_topics: topicRefs(p.event_id, p.learn_topics),
    speak_topics: topicRefs(p.event_id, p.speak_topics),
    reasons,
    opener: reasons[0],
    contact: { linkedin_url: null, contact_note: 'Sample profile, not a real person' },
  };
}

function route(method: string, path: string, query: URLSearchParams, headers: Headers, body: Json): Json {
  if (path === '/api/conferences' && (method === 'GET' || method === 'HEAD')) {
    return { conferences: MOCK_CONFERENCES };
  }
  if (path === '/api/health') return { ok: true };
  if (path === '/api/search' && method === 'POST') return handleSearch(body as unknown as SearchRequest) as unknown as Json;

  if (path === '/api/topics' && method === 'GET') {
    const conf = conferenceOf(query.get('event'));
    const q = (query.get('q') ?? '').toLowerCase();
    const size = Math.min(Number(query.get('size')) || 150, 150);
    const topics = MOCK_TOPICS.filter((t) => t.conference === conf.slug && (!q || t.label.toLowerCase().startsWith(q)))
      .slice(0, size)
      .map(({ topic_id, label, talk_count }) => ({ topic_id, label, talk_count }));
    return { topics };
  }
  if (path === '/api/topics/suggest' && method === 'POST') {
    const conf = conferenceOf(body.event);
    const ids = new Set<string>();
    for (const t of MOCK_TALKS) {
      if (t.conference === conf.slug && (body.talk_ids as string[] | undefined)?.includes(t.talk_id)) {
        for (const tp of t.topics ?? []) ids.add(tp.topic_id);
      }
    }
    const text = String(body.text ?? '').toLowerCase();
    const topics = MOCK_TOPICS.filter(
      (t) => t.conference === conf.slug && (ids.has(t.topic_id) || (text && text.includes(t.label.toLowerCase()))),
    )
      .slice(0, 12)
      .map(({ topic_id, label, talk_count }) => ({ topic_id, label, talk_count }));
    return { topics };
  }

  if (path === '/api/recommendations' && method === 'POST') {
    const conf = conferenceOf(body.event);
    const learn = (body.learn_topics as string[]) ?? [];
    const text = `${body.interests ?? ''}`.trim();
    if (!learn.length && !text) return { results: [], needs_profile: true };
    const skip = new Set((body.interested_talk_ids as string[]) ?? []);
    const wanted = learn;
    const results = MOCK_TALKS.filter(
      (t) => t.conference === conf.slug && t.kind === 'talk' && Date.parse(t.end) > Date.now() && !skip.has(t.talk_id),
    )
      .filter((t) => !wanted.length || t.topics?.some((tp) => wanted.includes(tp.topic_id)))
      .slice(0, Number(body.size) || 10)
      .map((t) => ({
        ...strip(t),
        evidence: t.abstract.slice(0, 160),
        why: {
          topics: (t.topics ?? []).filter((tp) => wanted.includes(tp.topic_id)).map((tp) => tp.label),
          learn_topics: (t.topics ?? []).filter((tp) => wanted.includes(tp.topic_id)).map((tp) => tp.label),
          passage: null,
        },
        circle_count: MOCK_PEOPLE.filter((p) => p.shared_talk_ids.includes(t.talk_id)).length,
      }));
    return { results };
  }

  if (path === '/api/circles/counts' && method === 'POST') {
    const conf = conferenceOf(body.event);
    const store = readStore();
    const counts: Record<string, number> = {};
    for (const id of (body.talk_ids as string[]) ?? []) {
      let n = MOCK_PEOPLE.filter((p) => p.event_id === conf.slug && p.shared_talk_ids.includes(id)).length;
      for (const [key, s] of Object.entries(store)) if (key.startsWith(`${conf.slug}:`) && s.shared_talk_ids.includes(id)) n++;
      if (n) counts[id] = n;
    }
    return { counts };
  }

  if (path === '/api/people/profile' && method === 'PUT') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const store = readStore();
    const key = `${conf.slug}:${id}`;
    const open = !!body.open_to_meet;
    const shared = ((body.shared_talk_ids as string[]) ?? []).slice(0, 50);
    if (!open && !shared.length) delete store[key];
    else store[key] = { profile: (body.profile as Json) ?? {}, open_to_meet: open, shared_talk_ids: shared };
    writeStore(store);
    return { ok: true, open_to_meet: open, shared_talk_ids: shared };
  }
  if (path === '/api/people/profile' && method === 'DELETE') {
    const id = device(headers);
    const store = readStore();
    delete store[`${query.get('event')}:${id}`];
    writeStore(store);
    return { ok: true };
  }

  if (path === '/api/people/matches' && method === 'POST') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const me = readStore()[`${conf.slug}:${id}`];
    if (!me?.open_to_meet) throw new HttpError(403, { error: 'visibility_required' });
    const interestedIds = (body.interested_talk_ids as string[]) ?? [];
    const results = MOCK_PEOPLE.filter((p) => p.event_id === conf.slug && p.open_to_meet).map((p) =>
      personResult(p, me, interestedIds),
    );
    return { results };
  }

  if (path === '/api/circles/members' && method === 'POST') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const talkId = String(body.talk_id);
    const me = readStore()[`${conf.slug}:${id}`];
    const members = MOCK_PEOPLE.filter((p) => p.event_id === conf.slug && p.shared_talk_ids.includes(talkId));
    const count = members.length + (me?.shared_talk_ids.includes(talkId) ? 1 : 0);
    if (!me?.shared_talk_ids.includes(talkId)) throw new HttpError(403, { error: 'share_required', count });
    const t = MOCK_TALKS.find((x) => x.talk_id === talkId);
    return {
      talk: t ? { title: t.title, start: t.start, end: t.end, url: t.url } : null,
      speakers: t?.speaker_profiles ?? [],
      count,
      members: members.map((p) => personResult(p, me, [talkId])),
    };
  }

  throw new HttpError(404, { error: 'not found' });
}

/** Routes every same-origin /api request to the mock; everything else uses the real fetch. */
export function installMockFetch(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let body: Json = {};
    const raw = await req.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: 'invalid JSON' }, { status: 400 });
      }
    }
    try {
      return Response.json(route(req.method, url.pathname, url.searchParams, req.headers, body));
    } catch (err) {
      if (err instanceof HttpError) return Response.json(err.body, { status: err.status });
      return Response.json({ error: 'mock failure' }, { status: 500 });
    }
  };
}
