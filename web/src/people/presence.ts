// Presence ("I'm around"): a zone, and optionally the device's position. The device keeps the
// switch state under caddie.presence.v1.{slug}; the server enforces presence_until. This module
// owns the timers. In the hour mode presence is off by itself 60 minutes after it was turned on
// and after 5 minutes in the background. In the day mode it runs until it is turned off, at the
// latest at the end of the conference day, and the safeguard is the zone confirmation instead:
// whenever the app comes back to the foreground with a zone that was last confirmed more than
// ten minutes ago, the People tab asks "Still in {zone}?" (hour mode too). It also owns the
// geolocation watch: with the user's say-so, watchPosition with high accuracy, at most one PUT
// every 15 s, only while the page is visible, stopped when it is hidden and when presence turns
// off. Denied or unavailable means zone-only, silently. Writes that only carry a position (a fix,
// or the position turned off) do not restart the server's hour where the backend offers
// until: 'keep' (capabilities.ts); turning presence on, moving zone, confirming it and Extend do.
import { useEffect, useState } from 'preact/hooks';
import { pacedMs } from '../lib/pace';
import { loadSchedule } from '../offline/status';
import { deletePresence, PeopleApiError, putPresence } from './api';
import { keepUntilOffered, resetCapabilities } from './capabilities';
import { getPresence, onPresenceFromOtherTab, setPresence } from './storage';
import type { Presence, Position, PresenceMode, PresenceUntil, TalkLike } from './types';

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
// A position is sent at most this often at pace 1 (and only when the device has moved, because the
// geolocation watch reports changes); the wait is stretched by the pace the API reports.
export const POSITION_MIN_INTERVAL_MS = 30_000;
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
// When the page last went to the background. A suspended page (iOS) runs no timers, so the
// five-minute rule is also checked against this when it comes back.
let hiddenAt: number | null = null;
let lastZone: string | null = null;
// Moves on whenever presence is turned off here, so a turnOn whose write was still under way
// does not switch it back on afterwards.
let epoch = 0;

const OFF: Partial<Presence> = { on: false, zone: null, until: null, position: false, confirmed_at: null, confirm_pending: false };

function clearTimers() {
  window.clearTimeout(expiryTimer);
  window.clearTimeout(hiddenTimer);
  expiryTimer = hiddenTimer = undefined;
}

// Every presence write (zone, position, Bluetooth token, delete) runs one at a time, in the order
// it was asked for, so a slow position write can never land after the delete that turned
// presence off and switch it back on on the server.
let writes: Promise<unknown> = Promise.resolve();

export function presenceWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = writes.then(fn, fn);
  writes = p.catch(() => undefined);
  return p;
}

/* ---------- Position watch ---------- */

let watchId: number | null = null;
let watchSlug: string | null = null;
let lastSentAt = 0;
let pendingFix: Position | null = null;
let lastSentFix: Position | null = null;
let sendTimer: number | undefined;
let sending = false;

/**
 * The last position sent with presence for this conference while the watch is on, so another
 * presence write (the Android companion's Bluetooth switch) can carry it instead of clearing it.
 */
export function lastPositionFix(slug: string): Position | null {
  return watchSlug === slug && getPresence(slug).position ? lastSentFix : null;
}

export const geolocationAvailable = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

function toPosition(pos: GeolocationPosition): Position | null {
  const { latitude, longitude, accuracy } = pos.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { lat: latitude, lon: longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 1e6 };
}

/** True for the server's 400 presence_not_active: a 'keep' while presence is not live there. */
export function isPresenceNotActive(err: unknown): boolean {
  return err instanceof PeopleApiError && err.status === 400 && err.code === 'presence_not_active';
}

/**
 * A presence write while presence is on that the person did not ask for as a new end (a position
 * fix, the position or Bluetooth turned on or off), run from inside a presenceWrite callback.
 * `write(until)` is sent with 'keep' where the backend offers it (`keep`), so it never moves the
 * end the person chose, and with `mode` otherwise (the server then extends presence_until, but the
 * device keeps its own hour, so the switch still goes off on time).
 *
 * A 'keep' refused with 400 presence_not_active means the device holds presence as on and the
 * server does not: presence ends on the device (endedUnderKeep) and the error is rethrown. Any other
 * 400 to a 'keep' may mean the backend no longer takes it, so the capabilities are read again next
 * time; with `retry` the write is sent once more with the mode, for a write that must still land
 * (clearing the stored position, starting or ending Bluetooth).
 */
export async function writeWhileOn<T>(slug: string, keep: boolean, mode: PresenceMode, write: (until: PresenceUntil) => Promise<T>, { retry = false }: { retry?: boolean } = {}): Promise<T> {
  if (!keep) return write(mode);
  const started = epoch;
  try {
    return await write('keep');
  } catch (err) {
    if (isPresenceNotActive(err)) {
      endedUnderKeep(slug, started);
      throw err;
    }
    if (err instanceof PeopleApiError && err.status === 400) {
      resetCapabilities();
      if (retry) return write(mode);
    }
    throw err;
  }
}

/**
 * The server refused a 'keep' with presence_not_active: the presence this device holds as on is
 * not live there (it ran out, or a delete, the purge or another device cleared it), and 'keep'
 * never starts it. Presence ends on the device as it does at its `until`: no request, the timers
 * and the position watch stop, and the screens follow the stored state (BleControls stops
 * Bluetooth). Presence turned off here while the write was under way is off already, with its
 * delete queued (the epoch moved on).
 *
 * It runs inside the presence write queue and leaves the epoch alone, unlike
 * presenceEndedOnServer: a turnOn queued behind the refused write was asked for after it, and its
 * answer (presence started again with the hour or the day) must still be recorded.
 */
function endedUnderKeep(slug: string, started: number): void {
  if (epoch !== started) return;
  endOnDevice(slug);
}

// Sends the newest fix with the current zone and spot.
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
  const wanted = () => {
    const p = getPresence(slug);
    return p.on && p.zone && p.position && watchSlug === slug ? p : null;
  };
  if (!fix || !wanted()) return;
  sending = true;
  lastSentAt = Date.now();
  try {
    const keep = await keepUntilOffered();
    await presenceWrite(async () => {
      // Presence may have been turned off (here or in another tab) while this waited its turn.
      const p = wanted();
      if (!p) return;
      await writeWhileOn(slug, keep, p.mode, (until) => putPresence(slug, p.zone as string, p.spot, fix, until));
      lastSentFix = fix;
    });
  } catch (err) {
    // Ended on the device inside the queue (writeWhileOn), or turned off meanwhile.
    if (isPresenceNotActive(err)) return;
    // A profile that is gone, or presence the server no longer accepts: stop sending positions;
    // the zone-only timers decide the rest. A 409 means the profile changed while the server
    // wrote, and 429 a short limit: the next fix tries again.
    if (err instanceof PeopleApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 409) stopPositionWatch();
  } finally {
    sending = false;
  }
}

function onFix(slug: string, pos: GeolocationPosition) {
  if (document.visibilityState === 'hidden' || watchSlug !== slug) return;
  const fix = toPosition(pos);
  if (!fix) return;
  pendingFix = fix;
  const wait = lastSentAt + pacedMs(POSITION_MIN_INTERVAL_MS) - Date.now();
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
  lastSentFix = null;
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
      const keep = await keepUntilOffered();
      await presenceWrite(async () => {
        const now = getPresence(slug);
        if (now.on && now.zone) await writeWhileOn(slug, keep, now.mode, (until) => putPresence(slug, now.zone as string, now.spot, null, until), { retry: true });
      });
    } catch {
      // presence_not_active ended presence on the device inside the queue (writeWhileOn). Anything
      // else lapses with the presence; the hour on the device is unchanged.
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
    if (hiddenAt === null) hiddenAt = Date.now();
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
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    const p = getPresence(slug);
    // Back after a long time away: the server has already let it lapse. Or back in hour mode
    // after five minutes or more: the timer could not run while the page was suspended.
    if (p.on && ((p.until && Date.parse(p.until) <= Date.now()) || (p.mode === 'hour' && away >= HIDDEN_MS))) void turnOff(slug);
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

/**
 * Installs the background and expiry timers (and the position watch) for one conference, and
 * returns the function that removes them. usePresenceWatch runs it for the shell.
 */
export function watchPresence(slug: string): () => void {
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
    hiddenAt = null;
    if (watchedSlug === slug) watchedSlug = null;
  };
}

/** Installs the background and expiry timers (and the position watch) for one conference. Call from the shell. */
export function usePresenceWatch(slug: string | null): void {
  useEffect(() => (slug ? watchPresence(slug) : undefined), [slug]);
}

// Another tab turned presence off, or on, or changed it: this tab's timers and position watch
// follow the stored state, so it never keeps writing a presence the user has ended.
onPresenceFromOtherTab((changed) => {
  const slug = watchedSlug;
  if (!slug || (changed !== null && changed !== slug)) return;
  if (!getPresence(slug).on) {
    epoch++;
    clearTimers();
    stopPositionWatch();
    return;
  }
  scheduleExpiry(slug);
  syncPositionWatch(slug);
});

/**
 * Presence the server has already cleared (conference-wide visibility turned off): off on the
 * device too, with its timers and the position watch, and no request of its own.
 */
export function presenceEndedOnServer(slug: string): void {
  epoch++;
  endOnDevice(slug);
}

// Presence off on the device, with its timers and the position watch, without a request.
function endOnDevice(slug: string): void {
  const p = getPresence(slug);
  if (p.on) {
    lastZone = p.zone;
    setPresence(slug, OFF);
  }
  if (watchedSlug === slug) clearTimers();
  if (watchSlug === slug) stopPositionWatch();
}

/** Stops every presence timer and the position watch, for "Delete my profile". */
export function resetPresence(): void {
  epoch++;
  clearTimers();
  stopPositionWatch();
  hiddenAt = null;
  lastZone = null;
}

export function presenceProblem(err: unknown): string {
  if (err instanceof PeopleApiError) {
    if (err.code === 'profile_required' || err.code === 'no_device') return 'Make your profile visible first.';
    // The profile changed while the server wrote presence (another device or tab, a report): the
    // same tap works a moment later.
    if (err.status === 409) return 'That did not go through. Try again.';
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
  const started = epoch;
  try {
    const res = await presenceWrite(() => putPresence(slug, zone, spot, null, mode));
    if (epoch !== started) {
      // Turned off while the write was under way: here (its delete is queued behind this write),
      // in another tab, or by the server (visibility off). The answer is not recorded, so the
      // device stays off; fail closed and tell the server too, after anything still queued,
      // unless presence was turned on again meanwhile. A second delete after this tab's own is
      // harmless.
      void presenceWrite(async () => {
        if (!getPresence(slug).on) await deletePresence(slug).catch(() => undefined);
      });
      return null;
    }
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

/**
 * Turns presence off on the device at once and tells the server once any presence write still
 * under way has finished, so that write cannot land after the delete; a failed delete is retried
 * once.
 */
export async function turnOff(slug: string): Promise<void> {
  const p = getPresence(slug);
  if (p.on) lastZone = p.zone;
  epoch++;
  setPresence(slug, OFF);
  clearTimers();
  stopPositionWatch();
  await presenceWrite(async () => {
    try {
      await deletePresence(slug);
    } catch {
      try {
        await deletePresence(slug);
      } catch {
        // The server lets it lapse on its own at presence_until.
      }
    }
  });
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
