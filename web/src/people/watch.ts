// Watched people (device only, caddie.watch.v1.{slug}): a match who is not around right now can
// be watched instead of asked; the nudge tick says when they turn up. This file mirrors the
// interface of the MVP branch's watch.ts (getWatches, isWatched, toggleWatch); the merge keeps
// that branch's version.
import { notify } from './storage';

const WATCH_PREFIX = 'caddie.watch.v1.';

export interface Watch {
  ref: string;
  display_name: string;
  /** ISO time the watch was set. */
  since: string;
}

const mem = new Map<string, Watch[]>();

function read(slug: string): Watch[] {
  let w = mem.get(slug);
  if (!w) {
    try {
      const raw = JSON.parse(localStorage.getItem(WATCH_PREFIX + slug) ?? '[]');
      w = Array.isArray(raw)
        ? raw
            .filter((x) => x && typeof x.ref === 'string')
            .map((x) => ({
              ref: x.ref as string,
              display_name: typeof x.display_name === 'string' ? x.display_name.slice(0, 60) : '',
              since: typeof x.since === 'string' ? x.since : '',
            }))
            .slice(0, 200)
        : [];
    } catch {
      w = [];
    }
    mem.set(slug, w);
  }
  return w;
}

function write(slug: string, next: Watch[]): void {
  mem.set(slug, next);
  try {
    localStorage.setItem(WATCH_PREFIX + slug, JSON.stringify(next));
  } catch {
    // Storage may be full or blocked; the in-memory list still applies for this visit.
  }
  notify();
}

export function getWatches(slug: string): Watch[] {
  return read(slug);
}

export function isWatched(slug: string, ref: string): boolean {
  return read(slug).some((w) => w.ref === ref);
}

/** Starts or stops watching one person; returns whether they are watched afterwards. */
export function toggleWatch(slug: string, person: { ref: string; display_name: string }): boolean {
  const current = read(slug);
  if (current.some((w) => w.ref === person.ref)) {
    write(
      slug,
      current.filter((w) => w.ref !== person.ref),
    );
    return false;
  }
  write(slug, [...current, { ref: person.ref, display_name: person.display_name.slice(0, 60), since: new Date().toISOString() }].slice(-200));
  return true;
}
