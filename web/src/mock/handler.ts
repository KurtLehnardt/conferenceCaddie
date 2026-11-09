// MOCK_FIXTURE_DO_NOT_SHIP
// A crude in-browser stand-in for every /api route, used only in development
// with VITE_MOCK=1. It follows the response shapes of the contract roughly, so
// the UI can be exercised without Elasticsearch. Ranking here is a placeholder;
// the real server does all matching and ranking in Elasticsearch.
import type { Facets, SearchFilters, SearchRequest, SearchResponse, TagFacet } from '../types';
import { EMPTY_FILTERS } from '../types';
import {
  MOCK_CONFERENCES,
  MOCK_PEOPLE,
  MOCK_REQUESTER_REF,
  MOCK_TALKS,
  MOCK_TOPICS,
  type MockPerson,
  type MockTalk,
} from './fixtures';
import { mockImportGithub } from './github';

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

/* ---------- GPS bands (mock): positions are made up around the requester's own ---------- */

type Proximity = 'same_zone' | 'near' | 'around' | 'venue';
interface LatLon {
  lat: number;
  lon: number;
}
const EARTH_M = 6_371_000;
const ACCURACY_MAX_M = 200;
const rad = (d: number) => (d * Math.PI) / 180;

function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A point `metres` away from `from` in direction `bearing` (degrees clockwise from north). */
function offset(from: LatLon, metres: number, bearing: number): LatLon {
  const dLat = (metres * Math.cos(rad(bearing))) / EARTH_M;
  const dLon = (metres * Math.sin(rad(bearing))) / (EARTH_M * Math.cos(rad(from.lat)));
  return { lat: from.lat + (dLat * 180) / Math.PI, lon: from.lon + (dLon * 180) / Math.PI };
}

/** Sample people who are around stand at a fixed, made-up distance and bearing from the requester. */
function samplePosition(p: MockPerson, mine: LatLon): LatLon | null {
  if (!p.presence_zone) return null;
  const n = Number(p.ref.replace(/\D/g, '')) || 1;
  const metres = [40, 120, 260, 500, 900][n % 5];
  return offset(mine, metres, (n * 73) % 360);
}

function band(myZone: string, mine: LatLon | undefined, p: MockPerson): Proximity {
  if (p.presence_zone === myZone) return 'same_zone';
  const theirs = mine ? samplePosition(p, mine) : null;
  if (!mine || !theirs) return 'venue';
  const d = distanceM(mine, theirs);
  return d < 75 ? 'near' : d < 300 ? 'around' : 'venue';
}

function personResult(
  p: MockPerson,
  me: Stored | undefined,
  interestedIds: string[],
  extra: { terms?: string[]; meAround?: boolean; myZone?: string; myLocation?: LatLon } = {},
) {
  const myLearn = (me?.profile.learn_topics as string[] | undefined) ?? [];
  const mySpeak = (me?.profile.speak_topics as string[] | undefined) ?? [];
  const reasons: string[] = [];
  const canTeach = p.speak_topics.filter((t) => myLearn.includes(t));
  const wantsMine = p.learn_topics.filter((t) => mySpeak.includes(t));
  const label = (ids: string[]) => topicRefs(p.event_id, ids).map((t) => t.label).join(', ');
  // Find & connect: the passage that matched the text search, with <mark> tags.
  const terms = extra.terms ?? [];
  const hit = terms.length ? (highlight(p.expertise, terms) ?? highlight(p.about, terms)) : null;
  const evidence = hit ?? p.expertise.split(/(?<=\.)\s/)[0];
  const around = !!p.presence_zone;
  const zone = around && extra.meAround ? p.presence_zone : undefined;
  // The band only, and only when both are around; the mock never puts a distance on a result.
  const proximity: Proximity | null = around && extra.meAround ? band(extra.myZone ?? '', extra.myLocation, p) : null;
  if (hit) reasons.push(`They've worked on ${hit}`);
  if (canTeach.length) reasons.push(`They can speak to ${label(canTeach)}, which you want to learn about.`);
  if (wantsMine.length) reasons.push(`They want to learn about ${label(wantsMine)}, which you can speak to.`);
  const both = p.shared_talk_ids.find((id) => interestedIds.includes(id));
  if (both) reasons.push(`You are both interested in ${MOCK_TALKS.find((t) => t.talk_id === both)?.title}.`);
  if (zone) reasons.push(`They're in ${zone} right now.`);
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
    evidence,
    around,
    ...(zone ? { zone } : {}),
    proximity,
  };
}

/* ---------- Find & connect: blocks, presence, meets ---------- */

type MeetState = 'requested' | 'accepted' | 'declined' | 'active' | 'found' | 'cancelled' | 'expired';

interface MockMeet {
  meet_id: string;
  event_id: string;
  /** Participants are `dev:{profile_id}` for this browser and `ref:{ref}` for a sample person. */
  requester: string;
  recipient: string;
  topic_id: string | null;
  note: string;
  rendezvous: string | null;
  spot_me: Record<string, string>;
  state: MeetState;
  /** Both were around in the same zone when the ask was made; recomputed on accept. */
  same_zone: boolean;
  created_at: string;
  /** For the seeded incoming request: it appears in the inbox only after this time. */
  visible_at: string;
  active_since: string | null;
  /** Asks run out 15 minutes after they were made; an active meet 20 minutes after it started. */
  expires_at: string | null;
}

interface Connect {
  blocks: Record<string, string[]>;
  presence: Record<string, { zone: string; spot: string; since: string; until: string; location?: LatLon | null }>;
  meets: MockMeet[];
  seeded: string[];
  /** Reports sent from this browser, as `{slug}:{kind}:{id}`; a second one of the same target hides it. */
  reports: string[];
}

const CONNECT_KEY = 'caddie.mock.connect';
const PRESENCE_MS = 60 * 60_000;
const ACTIVE_MS = 20 * 60_000;
const REQUEST_MS = 15 * 60_000;
const SEED_DELAY_MS = 5_000;
const AUTO_ACCEPT_MS = 10_000;
const WAVE_ACCEPT_MS = 5_000;
const FILTERED = { error: 'filtered', message: 'That was held back by the filter. Edit it and try again.' };
// Reports: the real server hides a target at two distinct reporters. This browser is the only
// reporter here, so its second report of the same target stands in for the second person, and
// once it has sent two reports in all the mock pretends two people reported this browser's own
// profile, so PUT /api/people/profile answers hidden_for_owner: true and the banner can be seen.
const HIDE_AT = 2;
const REPORT_REASONS = ['harassment', 'hate', 'sexual', 'spam', 'other'];
const PRESENCE_REQUIRED = { error: 'presence_required', message: "Turn on 'Around and up for a conversation' first." };
const NOT_AROUND = { error: 'not_around', message: "They're not around right now." };

function readConnect(): Connect {
  try {
    const c = JSON.parse(sessionStorage.getItem(CONNECT_KEY) ?? '{}');
    return { blocks: c.blocks ?? {}, presence: c.presence ?? {}, meets: c.meets ?? [], seeded: c.seeded ?? [], reports: c.reports ?? [] };
  } catch {
    return { blocks: {}, presence: {}, meets: [], seeded: [], reports: [] };
  }
}

function reportCount(c: Connect, key: string): number {
  return c.reports.filter((r) => r === key).length;
}

/** A sample person hidden after reports: two reports of their profile from this browser. */
function hiddenPerson(c: Connect, slug: string, ref: string): boolean {
  return reportCount(c, `${slug}:profile:${ref}`) >= HIDE_AT;
}

/** This browser's own profile counts as hidden once it has sent two reports (see above). */
function hiddenForOwner(c: Connect): boolean {
  return c.reports.length >= HIDE_AT;
}

function writeConnect(c: Connect) {
  try {
    sessionStorage.setItem(CONNECT_KEY, JSON.stringify(c));
  } catch {
    // Mock data is disposable.
  }
}

/** The mock filter: the word "rejectme" stands in for the server's wordlist. */
function filtered(text: unknown): boolean {
  return /rejectme/i.test(String(text ?? ''));
}

function myPresence(c: Connect, slug: string, id: string) {
  const p = c.presence[`${slug}:${id}`];
  if (!p) return null;
  if (Date.parse(p.until) <= Date.now()) {
    delete c.presence[`${slug}:${id}`];
    return null;
  }
  return p;
}

function blockedEitherWay(c: Connect, slug: string, id: string, ref: string): boolean {
  return (c.blocks[`${slug}:${id}`] ?? []).includes(ref);
}

function personByRef(slug: string, ref: string): MockPerson | undefined {
  return MOCK_PEOPLE.find((p) => p.event_id === slug && p.ref === ref);
}

function otherOf(m: MockMeet, me: string): MockPerson | undefined {
  const other = m.requester === me ? m.recipient : m.requester;
  return other.startsWith('ref:') ? personByRef(m.event_id, other.slice(4)) : undefined;
}

const OVER: MeetState[] = ['declined', 'found', 'cancelled', 'expired'];

/** Accept means now: the meet goes straight to active for 20 minutes. */
function activate(m: MockMeet, myZone: string | null, otherZone: string | null, now: number) {
  m.state = 'active';
  m.active_since = new Date(now).toISOString();
  m.expires_at = new Date(now + ACTIVE_MS).toISOString();
  m.same_zone = !!myZone && myZone === otherZone;
  if (!m.rendezvous) m.rendezvous = m.same_zone ? myZone : (otherZone ?? myZone);
}

/**
 * What the sample people "do" between polls: a sample person who is around accepts a while after
 * being asked (sooner for a same-zone wave), which makes the meet active at once; asks run out
 * after 15 minutes; an active meet ends when it runs out or my presence does.
 */
function advanceMeets(c: Connect, slug: string, id: string) {
  const me = `dev:${id}`;
  const now = Date.now();
  const mine = myPresence(c, slug, id);
  for (const m of c.meets) {
    if (m.event_id !== slug || (m.requester !== me && m.recipient !== me)) continue;
    const other = otherOf(m, me);
    if (m.state === 'requested' && m.expires_at && Date.parse(m.expires_at) <= now) m.state = 'expired';
    const delay = m.same_zone ? WAVE_ACCEPT_MS : AUTO_ACCEPT_MS;
    if (m.state === 'requested' && m.requester === me && mine && other?.presence_zone && now - Date.parse(m.created_at) > delay) {
      activate(m, mine.zone, other.presence_zone, now);
    }
    if (m.state === 'active' && (!mine || (m.expires_at && Date.parse(m.expires_at) <= now))) m.state = 'expired';
  }
}

function meetFor(c: Connect, meetId: string, id: string): MockMeet {
  const m = c.meets.find((x) => x.meet_id === meetId);
  if (!m) throw new HttpError(404, { error: 'not found' });
  const me = `dev:${id}`;
  if (m.requester !== me && m.recipient !== me) throw new HttpError(403, { error: 'forbidden' });
  return m;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
    const speak = (body.speak_topics as string[]) ?? [];
    const text = `${body.interests ?? ''} ${body.expertise ?? ''}`.trim();
    if (!learn.length && !speak.length && !text) return { results: [], needs_profile: true };
    const skip = new Set((body.interested_talk_ids as string[]) ?? []);
    const wanted = [...learn, ...speak];
    const results = MOCK_TALKS.filter(
      (t) => t.conference === conf.slug && t.kind === 'talk' && Date.parse(t.end) > Date.now() && !skip.has(t.talk_id),
    )
      .filter((t) => !wanted.length || t.topics?.some((tp) => wanted.includes(tp.topic_id)))
      .slice(0, Number(body.size) || 10)
      .map((t) => ({
        ...strip(t),
        evidence: t.abstract.slice(0, 160),
        why: { topics: (t.topics ?? []).filter((tp) => wanted.includes(tp.topic_id)).map((tp) => tp.label), passage: null },
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
    return { ok: true, open_to_meet: open, shared_talk_ids: shared, hidden_for_owner: hiddenForOwner(readConnect()) };
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
    const c = readConnect();
    const query = String(body.query ?? '').slice(0, 300);
    if (body.when !== undefined && body.when !== 'anyone' && body.when !== 'around_now') throw new HttpError(400, { error: 'when' });
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const from = Math.max(0, Number(body.from) || 0);
    const size = Math.min(Math.max(1, Number(body.size) || 20), 20);
    const mine = myPresence(c, conf.slug, id);
    const meAround = !!mine;
    const pool = MOCK_PEOPLE.filter(
      (p) =>
        p.event_id === conf.slug &&
        p.open_to_meet &&
        !blockedEitherWay(c, conf.slug, id, p.ref) &&
        !hiddenPerson(c, conf.slug, p.ref) &&
        (body.when !== 'around_now' || !!p.presence_zone) &&
        (!terms.length || terms.some((w) => `${p.expertise} ${p.about}`.toLowerCase().includes(w))),
    );
    // Text hits first, then people who are around (nearer first when I sent a position), as the
    // real ranking would.
    const near = (p: MockPerson) => {
      const theirs = mine?.location ? samplePosition(p, mine.location) : null;
      return theirs && mine?.location ? Math.max(0, 1 - distanceM(mine.location, theirs) / 1000) : 0;
    };
    const score = (p: MockPerson) =>
      (terms.filter((w) => p.expertise.toLowerCase().includes(w)).length || 0) * 10 + (p.presence_zone ? 1 : 0) + near(p);
    const ranked = pool.sort((a, b) => score(b) - score(a));
    const results = ranked
      .slice(from, from + size)
      .map((p) => personResult(p, me, interestedIds, { terms, meAround, myZone: mine?.zone, myLocation: mine?.location ?? undefined }));
    writeConnect(c);
    return { results };
  }

  if (path === '/api/schedule' && method === 'GET') {
    const conf = conferenceOf(query.get('event'));
    const talks = MOCK_TALKS.filter((t) => t.conference === conf.slug && t.kind === 'talk').map((t) => ({
      ...strip(t),
      abstract: t.abstract.slice(0, 400),
    }));
    return { conference: conf.slug, talks };
  }

  if (path === '/api/people/block' && (method === 'POST' || method === 'DELETE')) {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const ref = String(body.ref ?? '');
    if (!ref) throw new HttpError(400, { error: 'ref' });
    const c = readConnect();
    const key = `${conf.slug}:${id}`;
    const list = new Set(c.blocks[key] ?? []);
    if (method === 'POST') list.add(ref);
    else list.delete(ref);
    c.blocks[key] = [...list];
    writeConnect(c);
    return { ok: true };
  }
  if (path === '/api/people/blocks' && method === 'GET') {
    const id = device(headers);
    const conf = conferenceOf(query.get('event'));
    return { refs: readConnect().blocks[`${conf.slug}:${id}`] ?? [] };
  }

  if (path === '/api/presence' && method === 'PUT') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const me = readStore()[`${conf.slug}:${id}`];
    if (!me?.open_to_meet) throw new HttpError(403, { error: 'profile_required' });
    const zone = String(body.zone ?? '').trim();
    if (!zone) throw new HttpError(400, { error: 'zone' });
    const spot = String(body.spot ?? '').slice(0, 60);
    if (filtered(spot)) throw new HttpError(400, FILTERED);
    // GPS bands: an optional { lat, lon, accuracy }; worse than 200 m, or absent, means zone-only.
    let location: LatLon | null = null;
    if (body.location !== undefined && body.location !== null) {
      const l = body.location as Partial<Record<'lat' | 'lon' | 'accuracy', unknown>>;
      if (typeof l.lat !== 'number' || typeof l.lon !== 'number' || typeof l.accuracy !== 'number') throw new HttpError(400, { error: 'location' });
      if (l.accuracy <= ACCURACY_MAX_M) location = { lat: Number(l.lat.toFixed(5)), lon: Number(l.lon.toFixed(5)) };
    }
    if (body.until !== undefined && body.until !== null && body.until !== 'hour' && body.until !== 'day') throw new HttpError(400, { error: 'until' });
    const c = readConnect();
    const now = Date.now();
    // 'day' runs to the end of the day (the browser's clock stands in for the conference's time zone).
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 0);
    const until = new Date(body.until === 'day' ? dayEnd.getTime() : now + PRESENCE_MS).toISOString();
    const key = `${conf.slug}:${id}`;
    const since = c.presence[key]?.since ?? new Date(now).toISOString();
    c.presence[key] = { zone, spot, since, until, location };
    // Once per session: a sample person asks to talk shop a few seconds after presence goes on.
    const requester = personByRef(conf.slug, MOCK_REQUESTER_REF);
    if (requester && !c.seeded.includes(key) && !blockedEitherWay(c, conf.slug, id, requester.ref)) {
      c.seeded.push(key);
      c.meets.push({
        meet_id: randomId(),
        event_id: conf.slug,
        requester: `ref:${requester.ref}`,
        recipient: `dev:${id}`,
        topic_id: requester.speak_topics[0] ?? null,
        note: "I'd like to compare notes on eBPF probes in production",
        rendezvous: null,
        spot_me: { [`ref:${requester.ref}`]: 'Orange lanyard, standing by the demo screen' },
        state: 'requested',
        same_zone: requester.presence_zone === zone,
        created_at: new Date(now).toISOString(),
        visible_at: new Date(now + SEED_DELAY_MS).toISOString(),
        active_since: null,
        expires_at: new Date(now + SEED_DELAY_MS + REQUEST_MS).toISOString(),
      });
    }
    writeConnect(c);
    return { ok: true, until: body.until === 'day' ? 'day' : 'hour', presence_until: until, located: location !== null };
  }
  if (path === '/api/presence' && method === 'DELETE') {
    const id = device(headers);
    const c = readConnect();
    delete c.presence[`${query.get('event')}:${id}`];
    writeConnect(c);
    return { ok: true };
  }

  if (path === '/api/meet' && method === 'POST') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const me = readStore()[`${conf.slug}:${id}`];
    if (!me?.open_to_meet) throw new HttpError(403, { error: 'visibility_required' });
    const ref = String(body.ref ?? '');
    const target = personByRef(conf.slug, ref);
    if (!target) throw new HttpError(404, { error: 'not found' });
    const c = readConnect();
    if (hiddenPerson(c, conf.slug, ref)) throw new HttpError(404, { error: 'not_found' });
    if (blockedEitherWay(c, conf.slug, id, ref)) throw new HttpError(403, { error: 'blocked' });
    // Asks are now-only: both must be around.
    const mine = myPresence(c, conf.slug, id);
    if (!mine) throw new HttpError(403, PRESENCE_REQUIRED);
    if (!target.presence_zone) throw new HttpError(409, NOT_AROUND);
    const note = String(body.note ?? '').slice(0, 140);
    if (filtered(note)) throw new HttpError(400, FILTERED);
    const meKey = `dev:${id}`;
    const them = `ref:${ref}`;
    const hour = Date.now() - 3_600_000;
    const recent = c.meets.filter((m) => m.requester === meKey && Date.parse(m.created_at) > hour).length;
    if (recent >= 10) throw new HttpError(429, { error: 'rate_limited', message: 'Slow down a little.' });
    const open = c.meets.find(
      (m) =>
        m.event_id === conf.slug &&
        !OVER.includes(m.state) &&
        ((m.requester === meKey && m.recipient === them) || (m.requester === them && m.recipient === meKey)),
    );
    if (open) throw new HttpError(409, { error: 'meet_open', meet_id: open.meet_id });
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const meet: MockMeet = {
      meet_id: randomId(),
      event_id: conf.slug,
      requester: meKey,
      recipient: them,
      topic_id: typeof body.topic_id === 'string' ? body.topic_id : null,
      note,
      rendezvous: null,
      spot_me: { [them]: 'Blue jacket, laptop with a sticker wall' },
      state: 'requested',
      same_zone: mine.zone === target.presence_zone,
      created_at: now,
      visible_at: now,
      active_since: null,
      expires_at: new Date(nowMs + REQUEST_MS).toISOString(),
    };
    c.meets.push(meet);
    writeConnect(c);
    return { meet_id: meet.meet_id, state: meet.state, same_zone: meet.same_zone, expires_at: meet.expires_at };
  }

  if (path === '/api/meet/inbox' && method === 'GET') {
    const id = device(headers);
    const conf = conferenceOf(query.get('event'));
    const c = readConnect();
    advanceMeets(c, conf.slug, id);
    writeConnect(c);
    const me = `dev:${id}`;
    const now = Date.now();
    const incoming = c.meets
      .filter((m) => m.event_id === conf.slug && m.recipient === me && Date.parse(m.visible_at) <= now && !OVER.includes(m.state))
      .flatMap((m) => {
        const from = otherOf(m, me);
        if (!from || blockedEitherWay(c, conf.slug, id, from.ref)) return [];
        return [
          {
            meet_id: m.meet_id,
            from: { ref: from.ref, display_name: from.display_name, about: from.about },
            topic_label: m.topic_id ? topicRefs(conf.slug, [m.topic_id])[0].label : null,
            note: m.note,
            created_at: m.created_at,
            expires_at: m.expires_at,
            same_zone: m.same_zone,
            other: { zone: m.same_zone ? (from.presence_zone ?? null) : null },
            state: m.state,
          },
        ];
      });
    const outgoing = c.meets
      .filter((m) => m.event_id === conf.slug && m.requester === me && !OVER.includes(m.state))
      .flatMap((m) => {
        const to = otherOf(m, me);
        if (!to || blockedEitherWay(c, conf.slug, id, to.ref)) return [];
        return [{ meet_id: m.meet_id, to: { ref: to.ref, display_name: to.display_name }, state: m.state }];
      });
    return { incoming, outgoing };
  }

  const meetMatch = path.match(/^\/api\/meet\/([A-Za-z0-9_-]+)(?:\/(accept|decline|found|cancel|details))?$/);
  if (meetMatch) {
    const id = device(headers);
    const c = readConnect();
    const m = meetFor(c, meetMatch[1], id);
    advanceMeets(c, m.event_id, id);
    const me = `dev:${id}`;
    const action = meetMatch[2];
    const other = otherOf(m, me);
    if (!action && method === 'GET') {
      if (OVER.includes(m.state)) throw new HttpError(410, { error: 'over', state: m.state });
      writeConnect(c);
      const active = m.state === 'active';
      const otherKey = m.requester === me ? m.recipient : m.requester;
      // GPS bands: with my position stored, the sample partner starts 240 m away at a fixed
      // bearing and walks closer at about a metre a second, down to 10 m. Only on this read.
      const mine = myPresence(c, m.event_id, id);
      const position: { distance_m?: number; bearing_deg?: number } = {};
      if (active && mine?.location && other?.presence_zone && m.active_since) {
        const walked = (Date.now() - Date.parse(m.active_since)) / 1000;
        position.distance_m = Math.max(10, Math.round((240 - walked) / 10) * 10);
        position.bearing_deg = 45;
      }
      return {
        state: m.state,
        same_zone: m.same_zone,
        active_until: active ? m.expires_at : null,
        other: {
          ref: other?.ref ?? null,
          display_name: other?.display_name ?? 'Someone',
          zone: active || m.same_zone ? (other?.presence_zone ?? null) : null,
          spot: active ? (other?.presence_spot ?? null) : null,
          spot_me: active ? (m.spot_me[otherKey] ?? null) : null,
          ...position,
        },
        rendezvous: m.rendezvous ?? (active ? (other?.presence_zone ?? myPresence(c, m.event_id, id)?.zone ?? null) : null),
        mine: { spot_me: m.spot_me[me] ?? null },
      };
    }
    if (action === 'details' && method === 'PUT') {
      if (OVER.includes(m.state)) throw new HttpError(410, { error: 'over', state: m.state });
      if (body.spot_me !== undefined) {
        if (filtered(body.spot_me)) throw new HttpError(400, FILTERED);
        m.spot_me[me] = String(body.spot_me).slice(0, 60);
      }
      if (body.rendezvous !== undefined) m.rendezvous = String(body.rendezvous).slice(0, 120) || null;
      writeConnect(c);
      return { ok: true };
    }
    if (action && method === 'POST') {
      if (OVER.includes(m.state)) throw new HttpError(410, { error: 'over', state: m.state });
      if (action === 'accept' || action === 'decline') {
        if (m.recipient !== me || m.state !== 'requested') throw new HttpError(409, { error: 'state' });
        if (action === 'accept') {
          // Accept means now: I must be around, and so must the asker.
          const mine = myPresence(c, m.event_id, id);
          if (!mine) throw new HttpError(403, PRESENCE_REQUIRED);
          if (!other?.presence_zone) {
            m.state = 'expired';
            writeConnect(c);
            throw new HttpError(410, { error: 'over', state: 'expired' });
          }
          activate(m, mine.zone, other.presence_zone, Date.now());
        } else {
          m.state = 'declined';
        }
      } else if (action === 'found') {
        m.state = 'found';
      } else {
        m.state = 'cancelled';
      }
      writeConnect(c);
      return { ok: true, state: m.state };
    }
  }

  if (path === '/api/circles/members' && method === 'POST') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    const talkId = String(body.talk_id);
    const me = readStore()[`${conf.slug}:${id}`];
    const c = readConnect();
    const members = MOCK_PEOPLE.filter((p) => p.event_id === conf.slug && p.shared_talk_ids.includes(talkId) && !hiddenPerson(c, conf.slug, p.ref));
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

  if (path === '/api/people/report' && method === 'POST') {
    const id = device(headers);
    const conf = conferenceOf(body.event);
    if (!readStore()[`${conf.slug}:${id}`]) throw new HttpError(403, { error: 'profile_required' });
    const ref = String(body.ref ?? '');
    const context = (body.context ?? {}) as Json;
    const kind = String(context.kind ?? '');
    const target = String(context.id ?? '');
    if (!['profile', 'meet', 'spot'].includes(kind)) throw new HttpError(400, { error: 'context.kind' });
    if (!REPORT_REASONS.includes(String(body.reason))) throw new HttpError(400, { error: 'reason' });
    if (kind !== 'meet' && target !== ref) throw new HttpError(400, { error: 'context.id' });
    const c = readConnect();
    if (kind === 'meet') {
      const m = c.meets.find((x) => x.meet_id === target && x.event_id === conf.slug);
      if (!m || (m.requester !== `dev:${id}` && m.recipient !== `dev:${id}`)) throw new HttpError(404, { error: 'not_found' });
    } else if (!personByRef(conf.slug, ref)) {
      throw new HttpError(404, { error: 'not_found' });
    }
    const key = `${conf.slug}:${kind}:${target}`;
    c.reports.push(key);
    writeConnect(c);
    return { ok: true, hidden: reportCount(c, key) >= HIDE_AT };
  }

  if (path === '/api/import/github' && method === 'POST') return mockImportGithub(String(body.handle ?? ''), (s, b) => new HttpError(s, b));

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
