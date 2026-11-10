// "Tell me when they're around": a device-only watch list (caddie.watch.v1.{slug}) of matches
// who are not around right now. Asks are now-only, so a match who is not around is watched, not
// booked; the nudge code reads this list to say when someone on it is around. Nothing here
// leaves the device.
import { notify } from './storage';

const WATCH_PREFIX = 'caddie.watch.v1.';
const WATCH_MAX = 200;

export interface Watch {
  ref: string;
  display_name: string;
  /** ISO time the watch was set. */
  since: string;
}

const mem = new Map<string, Watch[]>();

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The people this device is watching at a conference, oldest first. */
export function getWatches(slug: string): Watch[] {
  let list = mem.get(slug);
  if (!list) {
    let raw: unknown = null;
    try {
      const s = localStorage.getItem(WATCH_PREFIX + slug);
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = null;
    }
    list = Array.isArray(raw)
      ? raw
          .filter((w) => w && typeof w.ref === 'string')
          .map((w) => ({ ref: str(w.ref, 32), display_name: str(w.display_name, 60), since: str(w.since, 40) }))
          .slice(0, WATCH_MAX)
      : [];
    mem.set(slug, list);
  }
  return list;
}

function save(slug: string, list: Watch[]): void {
  mem.set(slug, list);
  try {
    localStorage.setItem(WATCH_PREFIX + slug, JSON.stringify(list));
  } catch {
    // Storage blocked or full: the in-memory list still applies for this visit.
  }
  notify();
}

export function isWatched(slug: string, ref: string): boolean {
  return getWatches(slug).some((w) => w.ref === ref);
}

/** Starts watching a person, or stops when they are already watched. Returns the new state. */
export function toggleWatch(slug: string, person: { ref: string; display_name: string }): boolean {
  const list = getWatches(slug);
  if (list.some((w) => w.ref === person.ref)) {
    save(
      slug,
      list.filter((w) => w.ref !== person.ref),
    );
    return false;
  }
  save(slug, [...list, { ref: person.ref, display_name: person.display_name.slice(0, 60), since: new Date().toISOString() }].slice(-WATCH_MAX));
  return true;
}

/** Forgets the in-memory lists, for "Delete my profile" (which removes the stored ones). */
export function clearWatches(): void {
  mem.clear();
}

export function removeWatch(slug: string, ref: string): void {
  save(
    slug,
    getWatches(slug).filter((w) => w.ref !== ref),
  );
}
