// Offline mode: the connection state, the service worker registration, and the cached schedule
// that the offline keyword search reads.
import { useEffect, useState } from 'preact/hooks';
import type { Talk } from '../types';

/** One talk of GET /api/schedule: public feed fields plus an abstract of about 400 characters. */
export interface ScheduleTalk extends Talk {
  abstract: string;
}

export interface Schedule {
  conference: string;
  talks: ScheduleTalk[];
}

const scheduleUrl = (slug: string) => `/api/schedule?event=${encodeURIComponent(slug)}`;

/** True while the browser reports a connection. Re-renders the caller when that changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Registers /sw.js in production builds only. The build id is the hashed file name of the entry
 * script, so each build registers a new worker with its own caches. Dev and mock mode never
 * register a worker.
 */
export function registerServiceWorker(entryUrl: string): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const file = new URL(entryUrl).pathname.split('/').pop() ?? '';
  const build = file.replace(/\.js$/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'build';
  const register = () => {
    navigator.serviceWorker.register(`/sw.js?build=${build}`, { scope: '/' }).catch(() => {
      // Without a worker the app still works online; only the offline shell is missing.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

const memory = new Map<string, Schedule>();
const warmed = new Set<string>();

function isSchedule(v: unknown, slug: string): v is Schedule {
  const s = v as Schedule;
  return !!s && s.conference === slug && Array.isArray(s.talks);
}

async function readCached(slug: string): Promise<Schedule | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await caches.match(scheduleUrl(slug), { ignoreVary: true });
    if (!res) return null;
    const json = await res.json();
    return isSchedule(json, slug) ? json : null;
  } catch {
    return null;
  }
}

/**
 * The schedule for one conference: the copy in memory, else the network (which the service
 * worker answers from its cache when offline), else the Cache Storage copy. Null when this
 * device has never saved it.
 */
export async function loadSchedule(slug: string): Promise<Schedule | null> {
  const known = memory.get(slug);
  if (known) return known;
  try {
    const res = await fetch(scheduleUrl(slug));
    if (res.ok) {
      const json = await res.json();
      if (isSchedule(json, slug)) {
        memory.set(slug, json);
        return json;
      }
    }
  } catch {
    // Offline without a worker; try the cache directly.
  }
  const cached = await readCached(slug);
  if (cached) memory.set(slug, cached);
  return cached;
}

/**
 * Saves the conference's schedule and the conference list for offline use, once per conference
 * per visit. When the page is not yet controlled by the service worker, as on the first visit,
 * the worker is asked to fetch and cache both itself.
 */
export function saveForOffline(slug: string): void {
  if (warmed.has(slug)) return;
  warmed.add(slug);
  fetch(scheduleUrl(slug))
    .then(async (res) => {
      if (!res.ok) throw new Error('not saved');
      const json = await res.json();
      if (isSchedule(json, slug)) memory.set(slug, json);
    })
    .catch(() => warmed.delete(slug));
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'save', urls: [scheduleUrl(slug), '/api/conferences'] }))
    .catch(() => undefined);
}
