// Device-local state for the people features: the device identity, the profile
// and the per-conference visibility choices. Every write notifies subscribers so
// all mounted people components stay in step.
import { useEffect, useState } from 'preact/hooks';
import type { Device, Profile, TopicRef, Visibility } from './types';

const DEVICE_KEY = 'caddie.device.v1';
const PROFILE_KEY = 'caddie.profile.v1';
const VIS_PREFIX = 'caddie.visibility.v1.';

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

/** Removes the profile, the device identity and every visibility record from the device. */
export function clearAllPeopleData(): void {
  const keys: string[] = [DEVICE_KEY, PROFILE_KEY];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(VIS_PREFIX)) keys.push(key);
    }
  } catch {
    // Nothing to enumerate.
  }
  keys.forEach(remove);
  deviceMem = null;
  profileMem = null;
  visMem.clear();
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
