// Presence ("I'm around"): a zone, and optionally the device's position. The device keeps the
// switch state under caddie.presence.v1.{slug}; the server enforces presence_until. This module
// owns the timers. In the hour mode presence is off by itself 60 minutes after it was turned on
// and after 5 minutes in the background. In the day mode it runs until it is turned off, at the
// latest at the end of the conference day, and the safeguard is the zone confirmation instead:
// whenever the app comes back to the foreground with a zone that was last confirmed more than
// ten minutes ago, the People tab asks "Still in {zone}?" (hour mode too). It also owns the
// geolocation watch: with the user's say-so, watchPosition with high accuracy, at most one PUT
// every 15 s, only while the page is visible, stopped when it is hidden and when presence turns
// off. Denied or unavailable means zone-only, silently.
import { useEffect, useState } from 'preact/hooks';
import { loadSchedule } from '../offline/status';
import { deletePresence, PeopleApiError, putPresence } from './api';
import { getPresence, setPresence } from './storage';
import type { Position, PresenceMode, TalkLike } from './types';

export const PRESENCE_NOTICE =
  "While this is on, people you can see can also see that you're around and which zone you're in. How to spot you is shared only with someone you accept, only until you meet, and never stored after. Your exact position is shared only with someone you accept, only until you meet, and never stored after. It turns off by itself after an hour unless you choose to stay around for the day.";

export const POSITION_LABEL = 'Use my position too (optional)';
export const POSITION_EXPLAINER =
  "Ranks people near you higher and, once you've both agreed to meet, shows how far apart you are. Nobody else ever sees your position, and it's never stored after.";

export const PRESENCE_MINUTES = 60;
const HIDDEN_MS = 5 * 60_000;
/** A zone older than this is asked about when the app comes back to the foreground. */
const ZONE_CONFIRM_DEFAULT_MS = 10 * 60_000;
export const DURATION_LABELS: Record<PresenceMode, string> = { hour: 'For an hour', day: 'Until I turn it off today' };
const RECENT_ZONES_MAX = 8;

// The threshold, which the mock build lets a check shorten through localStorage
// (caddie.mock.confirm_ms); production ignores that key.
function zoneConfirmMs(): number {
  if (!import.meta.env.DEV || import.meta.env.VITE_MOCK !== '1') return ZONE_CONFIRM_DEFAULT_MS;
  try {
    const v = Number(localStorage.getItem('caddie.mock.confirm_ms'));
    return v > 0 ? v : ZONE_CONFIRM_DEFAULT_MS;
  } catch {
    return ZONE_CONFIRM_DEFAULT_MS;
  }
}
/** The spec's ceiling: at most one position update per 15 s. */
export const POSITION_MIN_INTERVAL_MS = 15_000;
const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 };

/** Zones every conference has, after its room names. */
export const FIXED_ZONES = ['Expo hall', 'Registration', 'Food and coffee', 'Hallway', 'Outside'];

const zoneCache = new Map<string, Promise<string[]>>();

function dedupe(rooms: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rooms) {
    const name = (r ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/**
 * The conference's zones: its room names from the schedule the app already has (or, failing
 * that, from the talks passed in), deduplicated, then the fixed zones.
 */
export function zonesFor(slug: string, fallbackTalks: TalkLike[] = []): Promise<string[]> {
  let p = zoneCache.get(slug);
  if (!p) {
    p = loadSchedule(slug)
      .then((s) => (s?.talks ?? []).map((t) => t.room))
      .catch(() => [] as (string | null)[])
      .then((rooms) => {
        const names = dedupe(rooms.length ? rooms : fallbackTalks.map((t) => t.room));
        const fixedLower = new Set(FIXED_ZONES.map((z) => z.toLowerCase()));
        return [...names.filter((n) => !fixedLower.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b)), ...FIXED_ZONES];
      });
    p.then((z) => {
      // A schedule that was not available yet is asked for again next time.
      if (z.length === FIXED_ZONES.length) zoneCache.delete(slug);
    });
    zoneCache.set(slug, p);
  }
  return p;
}

export function useZones(slug: string, fallbackTalks: TalkLike[] = []): string[] {
  const [zones, setZones] = useState<string[]>(FIXED_ZONES);
  useEffect(() => {
    let live = true;
    zonesFor(slug, fallbackTalks).then((z) => live && setZones(z));
    return () => {
      live = false;
    };
  }, [slug]);
  return zones;
}

/** The zone from the list that matches a deep-link value, ignoring case and encoding; else null. */
export function matchZone(zones: string[], raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Use it as written.
  }
  const key = value.replace(/[-_+]+/g, ' ').trim().toLowerCase();
  if (!key) return null;
  return zones.find((z) => z.toLowerCase() === key || z.replace(/[-_+]+/g, ' ').toLowerCase() === key) ?? null;
}

let watchedSlug: string | null = null;
let expiryTimer: number | undefined;
let hiddenTimer: number | undefined;
let lastZone: string | null = null;

function clearTimers() {
  window.clearTimeout(expiryTimer);
  window.clearTimeout(hiddenTimer);
  expiryTimer = hiddenTimer = undefined;
}

/* ---------- Position watch ---------- */

let watchId: number | null = null;
let watchSlug: string | null = null;
let lastSentAt = 0;
let pendingFix: Position | null = null;
let sendTimer: number | undefined;
let sending = false;

export const geolocationAvailable = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

function toPosition(pos: GeolocationPosition): Position | null {
  const { latitude, longitude, accuracy } = pos.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { lat: latitude, lon: longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 1e6 };
}

// Sends the newest fix with the current zone and spot. The server extends presence_until on
// every write, but the device keeps its own hour, so the switch still goes off on time.
async function sendFix(slug: string) {
  window.clearTimeout(sendTimer);
  sendTimer = undefined;
  if (sending) {
    // A write is still in flight: the newest fix waits for it.
    sendTimer = window.setTimeout(() => void sendFix(slug), 1_000);
    return;
  }
  const fix = pendingFix;
  pendingFix = null;
  const p = getPresence(slug);
  if (!fix || !p.on || !p.zone || !p.position || watchSlug !== slug) return;
  sending = true;
  lastSentAt = Date.now();
  try {
    await putPresence(slug, p.zone, p.spot, fix, p.mode);
  } catch (err) {
    // A profile that is gone, or presence the server no longer accepts: stop sending positions;
    // the zone-only timers decide the rest.
    if (err instanceof PeopleApiError && err.status >= 400 && err.status < 500 && err.status !== 429) stopPositionWatch();
  } finally {
    sending = false;
  }
}

function onFix(slug: string, pos: GeolocationPosition) {
  if (document.visibilityState === 'hidden' || watchSlug !== slug) return;
  const fix = toPosition(pos);
  if (!fix) return;
  pendingFix = fix;
  const wait = lastSentAt + POSITION_MIN_INTERVAL_MS - Date.now();
  if (wait <= 0) void sendFix(slug);
  else if (sendTimer === undefined) sendTimer = window.setTimeout(() => void sendFix(slug), wait);
}

function onFixError(slug: string, err: GeolocationPositionError) {
  // Denied: zone-only from now on, and not asked again. Anything else is transient; the watch
  // keeps trying and the presence stays zone-only until a fix arrives.
  if (err.code === err.PERMISSION_DENIED) {
    stopPositionWatch();
    if (getPresence(slug).position) setPresence(slug, { position: false, position_choice: 'no' });
  }
}

/** Starts (or restarts) the geolocation watch for a conference whose presence is on. */
function startPositionWatch(slug: string) {
  stopPositionWatch();
  if (!geolocationAvailable() || document.visibilityState === 'hidden') return;
  watchSlug = slug;
  try {
    watchId = navigator.geolocation.watchPosition(
      (pos) => onFix(slug, pos),
      (err) => onFixError(slug, err),
      POSITION_OPTIONS,
    );
  } catch {
    watchId = null;
    watchSlug = null;
  }
}

function stopPositionWatch() {
  if (watchId !== null && geolocationAvailable()) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  watchSlug = null;
  pendingFix = null;
  window.clearTimeout(sendTimer);
  sendTimer = undefined;
}

// Keeps the watch in step with the stored state: running while presence is on with the position
// choice and the page is visible, stopped otherwise.
function syncPositionWatch(slug: string) {
  const p = getPresence(slug);
  const wanted = p.on && p.position && document.visibilityState !== 'hidden';
  if (wanted && watchSlug !== slug) startPositionWatch(slug);
  else if (!wanted && watchSlug !== null) stopPositionWatch();
}

/**
 * Turns the position on or off for presence that is on. On: the watch starts and its first fix
 * is sent at once (the zone-only write stands until then). Off: the next zone write clears the
 * stored position on the server right away.
 */
export async function sharePosition(slug: string, on: boolean): Promise<void> {
  const p = getPresence(slug);
  setPresence(slug, { position: on && geolocationAvailable(), position_choice: on ? 'yes' : 'no' });
  if (!p.on || !p.zone) return;
  if (on) {
    lastSentAt = 0;
    syncPositionWatch(slug);
  } else {
    syncPositionWatch(slug);
    try {
      await putPresence(slug, p.zone, p.spot, null, p.mode);
    } catch {
      // It lapses with the presence; the hour on the device is unchanged.
    }
  }
}

function scheduleExpiry(slug: string) {
  window.clearTimeout(expiryTimer);
  const p = getPresence(slug);
  if (!p.on || !p.until) return;
  const ms = Math.max(0, Date.parse(p.until) - Date.now());
  // setTimeout cannot wait longer than about 24 days; presence never does.
  expiryTimer = window.setTimeout(() => void turnOff(slug), Math.min(ms, 0x7fffffff));
}

function onVisibility() {
  const slug = watchedSlug;
  if (!slug) return;
  if (document.visibilityState === 'hidden') {
    window.clearTimeout(hiddenTimer);
    // Five minutes in the background end an hour-mode presence. In the day mode backgrounding is
    // the normal state (the phone is in a pocket), so presence stays and the next foreground asks
    // whether the zone still holds.
    const p = getPresence(slug);
    if (p.on && p.mode === 'hour') hiddenTimer = window.setTimeout(() => void turnOff(slug), HIDDEN_MS);
    // Positions are foreground only.
    stopPositionWatch();
  } else {
    window.clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    // Back after a long time away: the server has already let it lapse.
    const p = getPresence(slug);
    if (p.on && p.until && Date.parse(p.until) <= Date.now()) void turnOff(slug);
    else {
      checkZoneAge(slug);
      syncPositionWatch(slug);
    }
  }
}

/* ---------- Zone confirmation ---------- */

// Flags a zone that has not been confirmed within the threshold, so the People tab asks about it.
function checkZoneAge(slug: string) {
  const p = getPresence(slug);
  if (!p.on || !p.zone || p.confirm_pending) return;
  const age = p.confirmed_at ? Date.now() - Date.parse(p.confirmed_at) : Infinity;
  if (age > zoneConfirmMs()) setPresence(slug, { confirm_pending: true });
}

function withRecent(zones: string[], zone: string): string[] {
  return [zone, ...zones.filter((z) => z !== zone)].slice(0, RECENT_ZONES_MAX);
}

/**
 * The zones to offer beside "Yes", most likely first: the zones this device chose before, most
 * recent first, then the rest of the list in order; never the current zone. There are no
 * room-to-position hints (the schedule has no coordinates), so a position does not reorder them.
 */
export function likelyZones(slug: string, zones: string[], count = 4): string[] {
  const p = getPresence(slug);
  const out: string[] = [];
  for (const z of [...p.recent_zones, ...zones]) {
    if (z !== p.zone && zones.includes(z) && !out.includes(z)) out.push(z);
    if (out.length >= count) break;
  }
  return out;
}

/** "Still in {zone}?" answered: the same zone, or a new one. Both write presence and record the time. */
export async function confirmZone(slug: string, zone: string): Promise<string | null> {
  const p = getPresence(slug);
  if (!p.on) return null;
  return turnOn(slug, zone, p.spot, p.mode);
}

/** The row closed without an answer: that counts as "yes" until the next threshold. */
export function dismissZoneCheck(slug: string): void {
  setPresence(slug, { confirm_pending: false, confirmed_at: new Date().toISOString() });
}

/** Installs the background and expiry timers (and the position watch) for one conference. Call from the shell. */
export function usePresenceWatch(slug: string | null): void {
  useEffect(() => {
    if (!slug) return;
    watchedSlug = slug;
    document.addEventListener('visibilitychange', onVisibility);
    scheduleExpiry(slug);
    if (document.visibilityState === 'hidden') onVisibility();
    else {
      // Opening the app again counts as coming to the foreground.
      checkZoneAge(slug);
      syncPositionWatch(slug);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimers();
      stopPositionWatch();
      if (watchedSlug === slug) watchedSlug = null;
    };
  }, [slug]);
}

export function presenceProblem(err: unknown): string {
  if (err instanceof PeopleApiError) {
    if (err.code === 'profile_required' || err.code === 'no_device') return 'Make your profile visible first.';
    return err.message;
  }
  return 'That could not be saved. Please try again.';
}

/**
 * Turns presence on (or moves it) and restarts the hour. The write itself is zone-only; when
 * the device has the position choice, the watch (re)starts and sends the first fix as soon as
 * there is one. Returns an error message, or null.
 */
export async function turnOn(slug: string, zone: string, spot: string, mode: PresenceMode = getPresence(slug).mode): Promise<string | null> {
  try {
    const res = await putPresence(slug, zone, spot, null, mode);
    const until =
      typeof res.presence_until === 'string' && Number.isFinite(Date.parse(res.presence_until))
        ? res.presence_until
        : new Date(Date.now() + PRESENCE_MINUTES * 60_000).toISOString();
    lastZone = zone;
    const p = getPresence(slug);
    const position = p.position_choice === 'yes' && geolocationAvailable();
    setPresence(slug, {
      on: true,
      zone,
      spot: spot.trim().slice(0, 60),
      until,
      notice_seen: true,
      position,
      mode,
      confirmed_at: new Date().toISOString(),
      confirm_pending: false,
      recent_zones: withRecent(p.recent_zones, zone),
    });
    if (watchedSlug === slug) scheduleExpiry(slug);
    lastSentAt = 0;
    stopPositionWatch();
    syncPositionWatch(slug);
    return null;
  } catch (err) {
    return presenceProblem(err);
  }
}

/** Keeps the zone and spot, starts a fresh hour (or renews the day). */
export function extend(slug: string): Promise<string | null> {
  const p = getPresence(slug);
  if (!p.on || !p.zone) return Promise.resolve(null);
  return turnOn(slug, p.zone, p.spot, p.mode);
}

/** Turns presence off on the device at once and tells the server; a failed delete is retried once. */
export async function turnOff(slug: string): Promise<void> {
  const p = getPresence(slug);
  if (p.on) lastZone = p.zone;
  setPresence(slug, { on: false, zone: null, until: null, position: false, confirmed_at: null, confirm_pending: false });
  clearTimers();
  stopPositionWatch();
  try {
    await deletePresence(slug);
  } catch {
    try {
      await deletePresence(slug);
    } catch {
      // The server lets it lapse on its own at presence_until.
    }
  }
}

/** The zone the user last chose, for the picker's default. */
export function lastChosenZone(): string | null {
  return lastZone;
}

/** Minutes left, rounded up, or 0. */
export function minutesLeft(until: string | null): number {
  if (!until) return 0;
  return Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
}

/** Re-renders once a minute while presence is on, so the remaining time stays right. */
export function useMinuteTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [active]);
  return tick;
}
