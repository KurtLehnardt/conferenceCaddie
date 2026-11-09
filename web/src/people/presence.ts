// Zone-only presence ("I'm around"). The device keeps the switch state under
// caddie.presence.v1.{slug}; the server enforces presence_until. This module owns the
// timers: off by itself 60 minutes after it was turned on, and after 5 minutes in the
// background, both while the app is open on any tab.
import { useEffect, useState } from 'preact/hooks';
import { loadSchedule } from '../offline/status';
import { deletePresence, PeopleApiError, putPresence } from './api';
import { getPresence, setPresence } from './storage';
import type { TalkLike } from './types';

export const PRESENCE_NOTICE =
  "While this is on, people you can see can also see that you're around and which zone you're in. How to spot you is shared only with someone you accept, only until you meet, and never stored after. It turns off by itself in an hour.";

export const PRESENCE_MINUTES = 60;
const HIDDEN_MS = 5 * 60_000;

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
    if (getPresence(slug).on) hiddenTimer = window.setTimeout(() => void turnOff(slug), HIDDEN_MS);
  } else {
    window.clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    // Back after a long time away: the server has already let it lapse.
    const p = getPresence(slug);
    if (p.on && p.until && Date.parse(p.until) <= Date.now()) void turnOff(slug);
  }
}

/** Installs the background and expiry timers for one conference. Call from the shell. */
export function usePresenceWatch(slug: string | null): void {
  useEffect(() => {
    if (!slug) return;
    watchedSlug = slug;
    document.addEventListener('visibilitychange', onVisibility);
    scheduleExpiry(slug);
    if (document.visibilityState === 'hidden') onVisibility();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimers();
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

/** Turns presence on (or moves it) and restarts the hour. Returns an error message, or null. */
export async function turnOn(slug: string, zone: string, spot: string): Promise<string | null> {
  try {
    const res = await putPresence(slug, zone, spot);
    const until =
      typeof res.presence_until === 'string' && Number.isFinite(Date.parse(res.presence_until))
        ? res.presence_until
        : new Date(Date.now() + PRESENCE_MINUTES * 60_000).toISOString();
    lastZone = zone;
    setPresence(slug, { on: true, zone, spot: spot.trim().slice(0, 60), until, notice_seen: true });
    if (watchedSlug === slug) scheduleExpiry(slug);
    return null;
  } catch (err) {
    return presenceProblem(err);
  }
}

/** Keeps the zone and spot, starts a fresh hour. */
export function extend(slug: string): Promise<string | null> {
  const p = getPresence(slug);
  if (!p.on || !p.zone) return Promise.resolve(null);
  return turnOn(slug, p.zone, p.spot);
}

/** Turns presence off on the device at once and tells the server; a failed delete is retried once. */
export async function turnOff(slug: string): Promise<void> {
  const p = getPresence(slug);
  if (p.on) lastZone = p.zone;
  setPresence(slug, { on: false, zone: null, until: null });
  clearTimers();
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
