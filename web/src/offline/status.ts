// Offline mode: the connection state, the service worker registration, and the cached schedule
// that the offline keyword search reads.
import { useEffect, useState } from 'preact/hooks';
import { apiFetch, apiOrigin, apiUrl, appPath } from '../lib/apiBase';
import type { Talk } from '../types';
import { isNative } from '../native';

/** One talk of GET /api/schedule: public feed fields plus an abstract of about 400 characters. */
export interface ScheduleTalk extends Talk {
  abstract: string;
}

export interface Schedule {
  conference: string;
  talks: ScheduleTalk[];
}

// The schedule's and the conference list's absolute URLs when the API is on another origin. The
// service worker caches them under these URLs, and caches.match looks them up under the same ones.
const scheduleUrl = (slug: string) => apiUrl(`/api/schedule?event=${encodeURIComponent(slug)}`);
const CONFERENCES_URL = apiUrl('/api/conferences');

/**
 * The Cache Storage cache the Android app writes itself, since it registers no service worker.
 * The reads below search every cache, so they find these copies under the same URLs as the
 * worker's own (caddie-data-{build}).
 */
const NATIVE_CACHE = 'caddie-data-native';

/** True while the browser reports a connection. Re-renders the caller when that changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    // The connection can change between the first render and this effect, before the listeners
    // exist, so the state is read again once they are in place.
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Registers {base}sw.js in production builds only. The build id is the hashed file name of the
 * entry script, so each build registers a new worker with its own caches. The worker is told the
 * API origin, when it is not the app's own, so it can cache the schedule from there. Dev and mock
 * mode never register a worker.
 */
export function registerServiceWorker(entryUrl: string): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const file = new URL(entryUrl).pathname.split('/').pop() ?? '';
  const build = file.replace(/\.js$/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'build';
  const register = () => {
    const api = apiOrigin();
    const url = `${appPath('sw.js')}?build=${build}${api ? `&api=${encodeURIComponent(api)}` : ''}`;
    navigator.serviceWorker.register(url, { scope: appPath('') }).catch(() => {
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

/** The JSON saved for a URL in any Cache Storage cache, or null. */
export async function readCachedJson(url: string): Promise<unknown> {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await caches.match(url, { ignoreVary: true });
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function readCached(slug: string): Promise<Schedule | null> {
  const json = await readCachedJson(scheduleUrl(slug));
  return isSchedule(json, slug) ? json : null;
}

/** Saves JSON under a URL in the app's own cache (the Android app; the web uses its worker). */
async function writeCachedJson(url: string, json: unknown): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(NATIVE_CACHE);
  await cache.put(url, new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
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
    const res = await apiFetch(scheduleUrl(slug));
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
 * per visit. On the web the service worker caches both as they load; when the page is not yet
 * controlled by it, as on the first visit, the worker is asked to fetch and cache both itself.
 * The Android app has no worker, so it writes both into Cache Storage here, under the URLs that
 * loadSchedule and getConferences read back offline.
 */
export function saveForOffline(slug: string): void {
  if (warmed.has(slug)) return;
  warmed.add(slug);
  const native = isNative();
  apiFetch(scheduleUrl(slug))
    .then(async (res) => {
      if (!res.ok) throw new Error('not saved');
      const json = await res.json();
      if (!isSchedule(json, slug)) return;
      memory.set(slug, json);
      if (native) await writeCachedJson(scheduleUrl(slug), json);
    })
    .catch(() => warmed.delete(slug));
  if (native) {
    apiFetch('/api/conferences')
      .then(async (res) => {
        if (!res.ok) throw new Error('not saved');
        const json = await res.json();
        if (Array.isArray(json?.conferences)) await writeCachedJson(CONFERENCES_URL, json);
      })
      .catch(() => warmed.delete(slug));
    return;
  }
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'save', urls: [scheduleUrl(slug), CONFERENCES_URL] }))
    .catch(() => undefined);
}
