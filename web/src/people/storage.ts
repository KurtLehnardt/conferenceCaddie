// Device-local state for the people features: the device identity, the profile
// and the per-conference visibility choices. Every write notifies subscribers so
// all mounted people components stay in step.
import { useEffect, useState } from 'preact/hooks';
import type { BlockedPerson, Device, MetPerson, Presence, Profile, PushState, TopicRef, Visibility } from './types';

const DEVICE_KEY = 'caddie.device.v1';
const PROFILE_KEY = 'caddie.profile.v1';
const VIS_PREFIX = 'caddie.visibility.v1.';
const PRESENCE_PREFIX = 'caddie.presence.v1.';
const PUSH_PREFIX = 'caddie.push.v1.';
const BLOCKS_PREFIX = 'caddie.blocks.v1.';
const MET_PREFIX = 'caddie.met.v1.';

const listeners = new Set<() => void>();
let version = 0;

export function notify(): void {
  version++;
  listeners.forEach((fn) => fn());
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be full or blocked; the in-memory state still applies for this visit.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing else to do when storage is blocked.
  }
}

// In-memory copies, so a blocked localStorage still works for the visit.
let deviceMem: Device | null | undefined;
let profileMem: Profile | null | undefined;
const visMem = new Map<string, Visibility>();

function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function getDevice(): Device | null {
  if (deviceMem === undefined) {
    const d = read<Device>(DEVICE_KEY);
    deviceMem = d && typeof d.profile_id === 'string' && typeof d.secret === 'string' ? d : null;
  }
  return deviceMem;
}

/** Returns the device identity, creating it on first opt-in. */
export function ensureDevice(): Device {
  const existing = getDevice();
  if (existing) return existing;
  const d: Device = { profile_id: randomToken(16), secret: randomToken(32) };
  deviceMem = d;
  write(DEVICE_KEY, d);
  return d;
}

export const EMPTY_PROFILE: Profile = {
  display_name: '',
  about: '',
  interests: '',
  expertise: '',
  linkedin_url: '',
  contact_note: '',
  topics: {},
};

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function topicList(v: unknown): TopicRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => t && typeof t.topic_id === 'string' && typeof t.label === 'string')
    .map((t) => ({ topic_id: t.topic_id, label: t.label }))
    .slice(0, 30);
}

export function getProfile(): Profile | null {
  if (profileMem === undefined) {
    const p = read<Partial<Profile>>(PROFILE_KEY);
    if (!p || typeof p !== 'object') {
      profileMem = null;
    } else {
      const topics: Profile['topics'] = {};
      for (const [slug, t] of Object.entries(p.topics ?? {})) {
        topics[slug] = { learn: topicList(t?.learn), speak: topicList(t?.speak) };
      }
      profileMem = {
        display_name: str(p.display_name, 60),
        about: str(p.about, 280),
        interests: str(p.interests, 500),
        expertise: str(p.expertise, 500),
        linkedin_url: str(p.linkedin_url, 200),
        contact_note: str(p.contact_note, 120),
        topics,
      };
    }
  }
  return profileMem;
}

export function setProfile(p: Profile): void {
  profileMem = p;
  write(PROFILE_KEY, p);
  notify();
}

export function topicsFor(p: Profile | null, slug: string): { learn: TopicRef[]; speak: TopicRef[] } {
  return p?.topics[slug] ?? { learn: [], speak: [] };
}

/** True when the profile has anything that talk suggestions can use. */
export function hasProfileInput(p: Profile | null, slug: string): boolean {
  if (!p) return false;
  const t = topicsFor(p, slug);
  return t.learn.length + t.speak.length > 0 || !!p.interests.trim() || !!p.expertise.trim();
}

const EMPTY_VIS: Visibility = {
  open_to_meet: false,
  shared_talk_ids: [],
  on_server: false,
  share_notice_seen: false,
  banner_seen: [],
  share_new: false,
  hidden_for_owner: false,
};

export function getVisibility(slug: string): Visibility {
  let v = visMem.get(slug);
  if (!v) {
    const raw = read<Partial<Visibility>>(VIS_PREFIX + slug) ?? {};
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);
    v = {
      open_to_meet: raw.open_to_meet === true,
      shared_talk_ids: ids(raw.shared_talk_ids).slice(0, 50),
      on_server: raw.on_server === true,
      share_notice_seen: raw.share_notice_seen === true,
      banner_seen: ids(raw.banner_seen).slice(-200),
      share_new: raw.share_new === true,
      hidden_for_owner: raw.hidden_for_owner === true,
    };
    visMem.set(slug, v);
  }
  return v ?? EMPTY_VIS;
}

export function setVisibility(slug: string, patch: Partial<Visibility>): Visibility {
  const next = { ...getVisibility(slug), ...patch };
  visMem.set(slug, next);
  write(VIS_PREFIX + slug, next);
  notify();
  return next;
}

/** Slugs whose visibility state says the server may hold a document. */
export function slugsOnServer(): string[] {
  const out = new Set<string>();
  for (const [slug, v] of visMem) if (v.on_server) out.add(slug);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(VIS_PREFIX)) continue;
      const slug = key.slice(VIS_PREFIX.length);
      if (getVisibility(slug).on_server) out.add(slug);
    }
  } catch {
    // Fall back to the in-memory list.
  }
  return [...out];
}

/* ---------- Find & connect: presence, blocks, people I met ---------- */

const EMPTY_PRESENCE: Presence = { on: false, zone: null, spot: '', until: null, notice_seen: false };
const presenceMem = new Map<string, Presence>();

export function getPresence(slug: string): Presence {
  let p = presenceMem.get(slug);
  if (!p) {
    const raw = read<Partial<Presence>>(PRESENCE_PREFIX + slug) ?? {};
    const until = typeof raw.until === 'string' && Number.isFinite(Date.parse(raw.until)) ? raw.until : null;
    // Presence that has run out while the app was closed is already off on the server.
    const live = raw.on === true && until !== null && Date.parse(until) > Date.now();
    p = {
      on: live,
      zone: live && typeof raw.zone === 'string' ? raw.zone.slice(0, 120) : null,
      spot: str(raw.spot, 60),
      until: live ? until : null,
      notice_seen: raw.notice_seen === true,
    };
    presenceMem.set(slug, p);
  }
  return p ?? EMPTY_PRESENCE;
}

export function setPresence(slug: string, patch: Partial<Presence>): Presence {
  const next = { ...getPresence(slug), ...patch };
  presenceMem.set(slug, next);
  write(PRESENCE_PREFIX + slug, next);
  notify();
  return next;
}

const EMPTY_PUSH: PushState = { on: false, endpoint: null, notice_seen: false };
const pushMem = new Map<string, PushState>();

/** Whether this browser gets push nudges for one conference, and the subscription's endpoint. */
export function getPush(slug: string): PushState {
  let p = pushMem.get(slug);
  if (!p) {
    const raw = read<Partial<PushState>>(PUSH_PREFIX + slug) ?? {};
    const endpoint = typeof raw.endpoint === 'string' && raw.endpoint.startsWith('https://') ? raw.endpoint.slice(0, 2048) : null;
    p = { on: raw.on === true && endpoint !== null, endpoint, notice_seen: raw.notice_seen === true };
    pushMem.set(slug, p);
  }
  return p ?? EMPTY_PUSH;
}

export function setPush(slug: string, patch: Partial<PushState>): PushState {
  const next = { ...getPush(slug), ...patch };
  pushMem.set(slug, next);
  write(PUSH_PREFIX + slug, next);
  notify();
  return next;
}

/** The conferences whose push state is on, from the device. */
export function slugsWithPush(): string[] {
  const out = new Set<string>();
  for (const [slug, p] of pushMem) if (p.on) out.add(slug);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PUSH_PREFIX)) continue;
      const slug = key.slice(PUSH_PREFIX.length);
      if (getPush(slug).on) out.add(slug);
    }
  } catch {
    // Fall back to the in-memory list.
  }
  return [...out];
}

const blocksMem = new Map<string, BlockedPerson[]>();

function blockList(v: unknown): BlockedPerson[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((b) => b && typeof b.ref === 'string')
    .map((b) => ({ ref: b.ref as string, display_name: typeof b.display_name === 'string' ? b.display_name.slice(0, 60) : null }))
    .slice(0, 500);
}

/** The people this device has blocked at one conference; `ref` is a key only and never shown. */
export function getBlocks(slug: string): BlockedPerson[] {
  let b = blocksMem.get(slug);
  if (!b) {
    b = blockList(read<unknown>(BLOCKS_PREFIX + slug));
    blocksMem.set(slug, b);
  }
  return b;
}

export function isBlocked(slug: string, ref: string): boolean {
  return getBlocks(slug).some((b) => b.ref === ref);
}

export function setBlocks(slug: string, next: BlockedPerson[]): void {
  blocksMem.set(slug, next);
  write(BLOCKS_PREFIX + slug, next);
  notify();
}

export function addBlock(slug: string, ref: string, display_name: string | null): void {
  const current = getBlocks(slug).filter((b) => b.ref !== ref);
  setBlocks(slug, [...current, { ref, display_name }]);
}

export function removeBlock(slug: string, ref: string): void {
  setBlocks(
    slug,
    getBlocks(slug).filter((b) => b.ref !== ref),
  );
}

/**
 * Replaces the cached list with the server's, taking the server's display names where it has them
 * and keeping the names this device already knows otherwise.
 */
export function mergeBlocks(slug: string, entries: { ref: string; display_name?: string | null }[]): void {
  const known = new Map(getBlocks(slug).map((b) => [b.ref, b.display_name]));
  setBlocks(
    slug,
    entries.slice(0, 500).map((e) => ({ ref: e.ref, display_name: e.display_name ?? known.get(e.ref) ?? null })),
  );
}

const metMem = new Map<string, MetPerson[]>();

/** People saved after a meet, on this device only. */
export function getMet(slug: string): MetPerson[] {
  let m = metMem.get(slug);
  if (!m) {
    const raw = read<unknown>(MET_PREFIX + slug);
    m = Array.isArray(raw)
      ? raw
          .filter((p) => p && typeof p.display_name === 'string')
          .map((p) => ({ display_name: str(p.display_name, 60), about: str(p.about, 280), met_at: str(p.met_at, 40) }))
          .slice(0, 500)
      : [];
    metMem.set(slug, m);
  }
  return m;
}

export function addMet(slug: string, person: { display_name: string; about: string | null }): void {
  const next = [
    ...getMet(slug),
    { display_name: person.display_name.slice(0, 60), about: (person.about ?? '').slice(0, 280), met_at: new Date().toISOString() },
  ].slice(-500);
  metMem.set(slug, next);
  write(MET_PREFIX + slug, next);
  notify();
}

export function removeMet(slug: string, index: number): void {
  const next = getMet(slug).filter((_, i) => i !== index);
  metMem.set(slug, next);
  write(MET_PREFIX + slug, next);
  notify();
}

/**
 * Removes the profile, the device identity and every visibility, presence, push and block record
 * from the device. The "People I met" list is the user's own notes and stays, like the Interested
 * list.
 */
export function clearAllPeopleData(): void {
  const keys: string[] = [DEVICE_KEY, PROFILE_KEY];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(VIS_PREFIX) || key?.startsWith(PRESENCE_PREFIX) || key?.startsWith(PUSH_PREFIX) || key?.startsWith(BLOCKS_PREFIX)) keys.push(key);
    }
  } catch {
    // Nothing to enumerate.
  }
  keys.forEach(remove);
  deviceMem = null;
  profileMem = null;
  visMem.clear();
  presenceMem.clear();
  pushMem.clear();
  blocksMem.clear();
  notify();
}

/** Re-renders the calling component whenever people state changes. */
export function usePeopleStore(): number {
  const [, setV] = useState(version);
  useEffect(() => {
    const fn = () => setV(version);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return version;
}
