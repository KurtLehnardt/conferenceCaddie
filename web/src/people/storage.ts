// Device-local state for the people features: the device identity, the profile
// and the per-conference visibility choices. Every write notifies subscribers so
// all mounted people components stay in step.
import { useEffect, useState } from 'preact/hooks';
import type { BlockedPerson, DeleteFailure, DeleteRetry, Device, MetPerson, Presence, Profile, PushState, TopicRef, Visibility } from './types';

const DEVICE_KEY = 'caddie.device.v1';
const PROFILE_KEY = 'caddie.profile.v1';
const VIS_PREFIX = 'caddie.visibility.v1.';
const PRESENCE_PREFIX = 'caddie.presence.v1.';
const PUSH_PREFIX = 'caddie.push.v1.';
const BLOCKS_PREFIX = 'caddie.blocks.v1.';
const MET_PREFIX = 'caddie.met.v1.';
const DELETE_PENDING_PREFIX = 'caddie.delete-pending.v1.';
const DELETE_ALL_KEY = 'caddie.delete-all.v1';

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

// Keys whose last write did not reach storage, so storage does not hold their current value.
const unsaved = new Set<string>();

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    unsaved.delete(key);
  } catch {
    // Storage may be full or blocked; the in-memory state still applies for this visit.
    unsaved.add(key);
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
    unsaved.delete(key);
  } catch {
    // Nothing else to do when storage is blocked.
    unsaved.add(key);
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

/**
 * True when another tab removed this device's identity (after "Delete my profile") or replaced it
 * since this tab read it. The cached copies are dropped then, so this tab reads what is stored now.
 */
export function deviceRemovedElsewhere(): boolean {
  if (!deviceMem || unsaved.has(DEVICE_KEY)) return false;
  let raw: string | null;
  try {
    raw = localStorage.getItem(DEVICE_KEY);
  } catch {
    return false;
  }
  let stored: Partial<Device> | null = null;
  try {
    stored = raw === null ? null : (JSON.parse(raw) as Partial<Device>);
  } catch {
    // An unreadable identity counts as replaced.
  }
  if (stored?.profile_id === deviceMem.profile_id) return false;
  deviceMem = undefined;
  profileMem = undefined;
  visMem.clear();
  notify();
  return true;
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

/** True when the profile has anything that talk suggestions can use: what the user wants to learn. */
export function hasProfileInput(p: Profile | null, slug: string): boolean {
  if (!p) return false;
  return topicsFor(p, slug).learn.length > 0 || !!p.interests.trim();
}

const EMPTY_VIS: Visibility = {
  open_to_meet: false,
  shared_talk_ids: [],
  on_server: false,
  maybe_on_server: false,
  share_notice_seen: false,
  banner_seen: [],
  share_new: false,
  hidden_for_owner: false,
};

function parseVisibility(raw: Partial<Visibility>): Visibility {
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);
  return {
    open_to_meet: raw.open_to_meet === true,
    shared_talk_ids: ids(raw.shared_talk_ids).slice(0, 50),
    on_server: raw.on_server === true,
    maybe_on_server: raw.maybe_on_server === true,
    share_notice_seen: raw.share_notice_seen === true,
    banner_seen: ids(raw.banner_seen).slice(-200),
    share_new: raw.share_new === true,
    hidden_for_owner: raw.hidden_for_owner === true,
  };
}

export function getVisibility(slug: string): Visibility {
  let v = visMem.get(slug);
  if (!v) {
    v = parseVisibility(read<Partial<Visibility>>(VIS_PREFIX + slug) ?? {});
    visMem.set(slug, v);
  }
  return v ?? EMPTY_VIS;
}

/**
 * The visibility of one conference as storage holds it now, not as this tab cached it: another
 * tab may have changed it a moment ago and its storage event may not have arrived yet. Writes that
 * could make a profile visible read it this way, under the shared write lock.
 */
export function getVisibilityFresh(slug: string): Visibility {
  const key = VIS_PREFIX + slug;
  if (unsaved.has(key)) return getVisibility(slug);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return getVisibility(slug);
  }
  let parsed: Partial<Visibility> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Partial<Visibility>) : {};
  } catch {
    // Unreadable: as good as empty.
  }
  const v = parseVisibility(parsed && typeof parsed === 'object' ? parsed : {});
  visMem.set(slug, v);
  return v;
}

export function setVisibility(slug: string, patch: Partial<Visibility>): Visibility {
  const next = { ...getVisibility(slug), ...patch };
  visMem.set(slug, next);
  write(VIS_PREFIX + slug, next);
  notify();
  return next;
}

function slugsWhere(test: (v: Visibility) => boolean): string[] {
  const out = new Set<string>();
  for (const [slug, v] of visMem) if (test(v)) out.add(slug);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(VIS_PREFIX)) continue;
      const slug = key.slice(VIS_PREFIX.length);
      if (test(getVisibility(slug))) out.add(slug);
    }
  } catch {
    // Fall back to the in-memory list.
  }
  return [...out];
}

/** Slugs whose visibility state says the server holds a document. */
export function slugsOnServer(): string[] {
  return slugsWhere((v) => v.on_server);
}

/** Slugs where the server holds a document, or may hold one because a first write went unanswered. */
export function slugsMaybeOnServer(): string[] {
  return slugsWhere((v) => v.on_server || v.maybe_on_server);
}

/* ---------- Deletes the server has not confirmed ---------- */

// These records are read from storage every time instead of being cached, so a tab sees at once
// what another tab wrote. The in-memory copy stands in only where storage does not hold the value.
const retryMem = new Map<string, DeleteRetry | null>();
const FAILURES: DeleteFailure[] = ['partial', 'offline', 'rate', 'forbidden', 'bad'];

// No automatic attempt waits longer than this; a stored time further ahead is corrupt or from a
// clock that has since been set back.
const LONGEST_WAIT_MS = 60 * 60_000;

function parseRetry(raw: string | null): DeleteRetry | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Partial<DeleteRetry> | null;
    if (!r || typeof r !== 'object') return null;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    const now = Date.now();
    return {
      attempts: n(r.attempts),
      next_at: Math.min(n(r.next_at), now + LONGEST_WAIT_MS),
      forbidden: n(r.forbidden),
      last: FAILURES.includes(r.last as DeleteFailure) ? (r.last as DeleteFailure) : null,
      since: Math.min(n(r.since) || now, now),
    };
  } catch {
    return null;
  }
}

function readRetry(key: string): DeleteRetry | null {
  if (!unsaved.has(key)) {
    try {
      return parseRetry(localStorage.getItem(key));
    } catch {
      // Storage is blocked; the in-memory copy is all there is.
    }
  }
  return retryMem.get(key) ?? null;
}

function writeRetry(key: string, value: DeleteRetry | null): void {
  retryMem.set(key, value);
  if (value) write(key, value);
  else remove(key);
  notify();
}

/** A fresh record, for a delete that is about to be sent for the first time. */
export function newRetry(): DeleteRetry {
  return { attempts: 0, next_at: 0, forbidden: 0, last: null, since: Date.now() };
}

/** The unfinished profile delete for one conference, or null when there is none. */
export function getDeletePending(slug: string): DeleteRetry | null {
  return readRetry(DELETE_PENDING_PREFIX + slug);
}

/** Marks a profile delete for one conference as unfinished, or clears the mark with null. */
export function setDeletePending(slug: string, value: DeleteRetry | null): void {
  writeRetry(DELETE_PENDING_PREFIX + slug, value);
}

/**
 * Changes the stored mark for one conference, only if it is still stored: a mark that another tab
 * has removed in the meantime is not written back. Returns whether it was there.
 */
export function updateDeletePending(slug: string, patch: Partial<DeleteRetry>): boolean {
  const current = getDeletePending(slug);
  if (current) setDeletePending(slug, { ...current, ...patch });
  return current !== null;
}

/** The conferences with an unfinished profile delete. */
export function slugsDeletePending(): string[] {
  const out = new Set<string>();
  for (const [key, d] of retryMem) if (d && unsaved.has(key) && key.startsWith(DELETE_PENDING_PREFIX)) out.add(key.slice(DELETE_PENDING_PREFIX.length));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DELETE_PENDING_PREFIX) && !unsaved.has(key)) out.add(key.slice(DELETE_PENDING_PREFIX.length));
    }
  } catch {
    for (const [key, d] of retryMem) if (d && key.startsWith(DELETE_PENDING_PREFIX)) out.add(key.slice(DELETE_PENDING_PREFIX.length));
  }
  return [...out];
}

/**
 * "Delete my profile" when it has not finished: stored before the first request and removed only
 * when the device's people data goes, so the device cannot forget the user asked for it.
 */
export function getDeleteAll(): DeleteRetry | null {
  return readRetry(DELETE_ALL_KEY);
}

export function setDeleteAll(value: DeleteRetry | null): void {
  writeRetry(DELETE_ALL_KEY, value);
}

/**
 * True while a delete covers this conference: "Delete my profile" is unfinished, or the delete of
 * this conference's copy is. Nothing that could make the device visible again is sent then: no
 * profile write, presence, Bluetooth token, push subscription or ask. Read from storage, so
 * another tab's delete counts at once.
 */
export function deleteCovers(slug: string): boolean {
  return getDeleteAll() !== null || getDeletePending(slug) !== null;
}

/** Changes the stored "Delete my profile" record, only if it is still stored. */
export function updateDeleteAll(patch: Partial<DeleteRetry>): boolean {
  const current = getDeleteAll();
  if (current) setDeleteAll({ ...current, ...patch });
  return current !== null;
}

/* ---------- Find & connect: presence, blocks, people I met ---------- */

const EMPTY_PRESENCE: Presence = {
  on: false,
  zone: null,
  spot: '',
  until: null,
  notice_seen: false,
  position: false,
  position_choice: null,
  mode: 'hour',
  confirmed_at: null,
  confirm_pending: false,
  recent_zones: [],
};
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
      position: live && raw.position === true,
      position_choice: raw.position_choice === 'yes' || raw.position_choice === 'no' ? raw.position_choice : null,
      mode: raw.mode === 'day' ? 'day' : 'hour',
      confirmed_at: live && typeof raw.confirmed_at === 'string' && Number.isFinite(Date.parse(raw.confirmed_at)) ? raw.confirmed_at : null,
      confirm_pending: live && raw.confirm_pending === true,
      recent_zones: Array.isArray(raw.recent_zones) ? raw.recent_zones.filter((z): z is string => typeof z === 'string').slice(0, 8) : [],
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

const EMPTY_PUSH: PushState = { on: false, endpoint: null, notice_seen: false, synced_at: null };
const pushMem = new Map<string, PushState>();

/** Whether this browser gets push nudges for one conference, and the subscription's endpoint. */
export function getPush(slug: string): PushState {
  let p = pushMem.get(slug);
  if (!p) {
    const raw = read<Partial<PushState>>(PUSH_PREFIX + slug) ?? {};
    const endpoint = typeof raw.endpoint === 'string' && raw.endpoint.startsWith('https://') ? raw.endpoint.slice(0, 2048) : null;
    const syncedAt = typeof raw.synced_at === 'number' && Number.isFinite(raw.synced_at) ? raw.synced_at : null;
    p = { on: raw.on === true && endpoint !== null, endpoint, notice_seen: raw.notice_seen === true, synced_at: syncedAt };
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

// Kept by watch.ts, nudges.ts and ble.ts, which hold their own in-memory copies and reset them
// when the profile is deleted.
const CLEARED_PREFIXES = [
  VIS_PREFIX,
  PRESENCE_PREFIX,
  PUSH_PREFIX,
  BLOCKS_PREFIX,
  'caddie.watch.v1.',
  'caddie.nudged.v1.',
  'caddie.nudges.v1.',
  'caddie.ble.v1.',
  DELETE_PENDING_PREFIX,
];

/**
 * Removes the profile, the device identity and every visibility, presence, push, block, watch,
 * nudge, Bluetooth and unfinished-delete record (the "Delete my profile" one included) from the
 * device. The "People I met" list is the user's own notes and stays, like the Interested list.
 * Callers run this only once the server has confirmed every delete: without the device identity,
 * nothing left on the server could be deleted from here.
 */
export function clearAllPeopleData(): void {
  const keys: string[] = [DEVICE_KEY, PROFILE_KEY, DELETE_ALL_KEY];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && CLEARED_PREFIXES.some((p) => key.startsWith(p))) keys.push(key);
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
  retryMem.clear();
  notify();
}

const presenceListeners = new Set<(slug: string | null) => void>();

/**
 * Runs `fn` after another tab changed the stored presence of a conference (null: of every
 * conference), once this tab's copy has been dropped, so the timers and the position watch can
 * follow the new state. Returns the unsubscribe function.
 */
export function onPresenceFromOtherTab(fn: (slug: string | null) => void): () => void {
  presenceListeners.add(fn);
  return () => {
    presenceListeners.delete(fn);
  };
}

// Another tab or window of this site shares localStorage but not these in-memory copies. When it
// writes, the copies are dropped and read again, so this tab never keeps working from an older
// profile or presence (a presence turned off there must stop this tab's writes too), and the
// screens that depend on it fetch again.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    const key = e.key;
    let presenceSlug: string | null | undefined;
    // A null key means the other tab cleared all storage.
    if (key === null) {
      profileMem = undefined;
      deviceMem = undefined;
      visMem.clear();
      presenceMem.clear();
      pushMem.clear();
      blocksMem.clear();
      metMem.clear();
      presenceSlug = null;
    } else if (key === PROFILE_KEY) {
      profileMem = undefined;
    } else if (key === DEVICE_KEY) {
      deviceMem = undefined;
    } else if (key.startsWith(VIS_PREFIX)) {
      visMem.delete(key.slice(VIS_PREFIX.length));
    } else if (key.startsWith(PRESENCE_PREFIX)) {
      presenceSlug = key.slice(PRESENCE_PREFIX.length);
      presenceMem.delete(presenceSlug);
    } else if (key.startsWith(PUSH_PREFIX)) {
      pushMem.delete(key.slice(PUSH_PREFIX.length));
    } else if (key.startsWith(BLOCKS_PREFIX)) {
      blocksMem.delete(key.slice(BLOCKS_PREFIX.length));
    } else if (key.startsWith(MET_PREFIX)) {
      metMem.delete(key.slice(MET_PREFIX.length));
    } else if (key.startsWith(DELETE_PENDING_PREFIX) || key === DELETE_ALL_KEY) {
      // Read from storage every time; the screens only need to render again.
    } else {
      return;
    }
    if (presenceSlug !== undefined) {
      const slug = presenceSlug;
      presenceListeners.forEach((fn) => fn(slug));
    }
    notify();
  });
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

/** The display name on this device's profile, empty when there is none. Re-renders on change. */
export function useProfileName(): string {
  usePeopleStore();
  return (getProfile()?.display_name ?? '').trim();
}
