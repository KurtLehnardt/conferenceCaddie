// Web Push nudges on the device: can this browser receive them, is the app installed, the
// "Add to Home Screen" prompt, and subscribing through the service worker. The server keeps the
// subscription (endpoint and keys) and sends; the device keeps only whether nudges are on and the
// endpoint, under caddie.push.v1.{slug}.
//
// Mock builds (VITE_MOCK=1 in dev) never reach a push service: the subscription is a stand-in
// posted to the mock handler, and window.__caddiePushTest shows a notification through the
// registered worker so the flow can be driven up to the permission step.
import { appPath, stripBase } from '../lib/apiBase';
import { deletePushSubscription, fetchVapidKey, PeopleApiError, putPushSubscription } from './api';
import { getPush, setPush, slugsWithPush } from './storage';

const MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';

export const PUSH_LABEL = 'Nudge me even when the app is closed';
export const PUSH_NOTICE =
  'Nudges tell you when someone whose experience matches yours is in your zone. They never say who until you open the app, and you get at most a few an hour.';
export const PUSH_DENIED_HINT = 'Notifications are blocked for this site. Allow them in your browser settings to get nudges.';

/** The Chrome event that lets a page offer "Add to Home Screen". Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** True when this browser can hold a push subscription at all. */
export function supportsPush(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** True on an iPhone or iPad, where push works only once the app is on the Home Screen. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** True when the app runs from the Home Screen (or as an installed app). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // No matchMedia; fall through.
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

let installPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installListeners.forEach((fn) => fn());
  });
}

/** True while the browser has offered an install prompt that was not used yet. */
export function canPromptInstall(): boolean {
  return installPrompt !== null;
}

/** Re-runs the callback when the install prompt becomes available or is used. */
export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => {
    installListeners.delete(fn);
  };
}

/** Shows the browser's install prompt. Resolves to the outcome, or null when there is none. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  const p = installPrompt;
  if (!p) return null;
  installPrompt = null;
  installListeners.forEach((fn) => fn());
  try {
    await p.prompt();
    const choice = await p.userChoice;
    return choice.outcome;
  } catch {
    return null;
  }
}

/**
 * The service worker registration pushes arrive through. Production registers the worker at
 * start (offline/status.ts); mock mode registers it here, on demand, so the test hook has one.
 */
async function worker(): Promise<ServiceWorkerRegistration> {
  if (MOCK && !navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register(`${appPath('sw.js')}?build=mock`, { scope: appPath('') });
  }
  return navigator.serviceWorker.ready;
}

function base64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBase64url(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'unavailable' | 'profile' | 'error' };

/**
 * Asks for notification permission (when not yet granted), subscribes this browser with the
 * server's VAPID key and stores the subscription on the server. Resolves with the outcome; never
 * throws.
 */
export async function subscribePush(slug: string): Promise<SubscribeResult> {
  if (!supportsPush()) return { ok: false, reason: 'unsupported' };
  let publicKey: string | null = null;
  try {
    publicKey = (await fetchVapidKey()).publicKey;
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (!publicKey && !MOCK) return { ok: false, reason: 'unavailable' };
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  try {
    const reg = await worker();
    let json: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (MOCK) {
      // No push service in mock mode: a stand-in subscription the mock handler accepts.
      json = { endpoint: `https://push.mock.invalid/${randomBase64url(16)}`, keys: { p256dh: randomBase64url(65), auth: randomBase64url(16) } };
    } else {
      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlToBytes(publicKey as string) as BufferSource }));
      json = sub.toJSON();
    }
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return { ok: false, reason: 'error' };
    await putPushSubscription(slug, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
    setPush(slug, { on: true, endpoint: json.endpoint, notice_seen: true, synced_at: Date.now() });
    return { ok: true };
  } catch (err) {
    if (err instanceof PeopleApiError && (err.code === 'profile_required' || err.code === 'no_device')) return { ok: false, reason: 'profile' };
    return { ok: false, reason: 'error' };
  }
}

let resyncStarted = false;

/** How long a conference's subscription counts as freshly sent: it is not sent again within this. */
export const RESYNC_EVERY_MS = 24 * 60 * 60 * 1000;
/** The longest random wait before the first PUT, so phones that open together do not send together. */
export const RESYNC_SPREAD_MS = 30_000;

/** The server will not take a subscription for this conference any more (no profile, ended or unknown). */
function conferenceRefuses(err: unknown): boolean {
  if (!(err instanceof PeopleApiError)) return false;
  if (err.status === 403) return err.code === 'profile_required';
  if (err.status === 400) return /^conference (has ended|is not available)/.test(err.code ?? '');
  return false;
}

/**
 * Quietly tells the server about this browser's push subscription again, for conferences whose
 * nudge switch is On, at most once a day per conference (RESYNC_EVERY_MS) unless the browser's
 * endpoint changed, in which case it is sent at once. The PUT is idempotent (one row per
 * endpoint), so this restores a row the server lost, for example one deleted before a push service
 * host was allowed. It sends nothing unless notification permission is granted, the switch is On
 * and the browser really holds a subscription; it never asks for permission, never subscribes and
 * never shows anything. When the server says a conference has ended, is unknown or has no profile
 * for this device, that conference's switch is turned off here so it is not sent again. A failure
 * is otherwise ignored: the next load tries again. The first PUT waits a random 0 to spreadMs
 * milliseconds, so a room full of phones opened at the same break does not hit the Worker at the
 * same moment. A switch turned Off while a PUT is in flight is honoured: the row that PUT made is
 * deleted again.
 */
export async function resyncPush({ spreadMs = RESYNC_SPREAD_MS }: { spreadMs?: number } = {}): Promise<void> {
  if (resyncStarted || MOCK || !supportsPush()) return;
  resyncStarted = true;
  try {
    if (Notification.permission !== 'granted') return;
    const slugs = slugsWithPush();
    if (!slugs.length) return;
    const reg = await navigator.serviceWorker.getRegistration(appPath(''));
    const json = (await reg?.pushManager.getSubscription())?.toJSON();
    if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
    const endpoint = json.endpoint;
    const body = { endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
    const now = Date.now();
    const due = slugs.filter((slug) => {
      const state = getPush(slug);
      const fresh = state.synced_at !== null && state.synced_at <= now && now - state.synced_at < RESYNC_EVERY_MS;
      return !(fresh && state.endpoint === endpoint);
    });
    if (!due.length) return;
    if (spreadMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * spreadMs));
    for (const slug of due) {
      // The person may have turned this conference off while an earlier PUT was in flight.
      if (!getPush(slug).on) continue;
      try {
        await putPushSubscription(slug, body);
      } catch (err) {
        // Ended, unknown or no profile: the server will never take it, so stop trying. Anything
        // else (offline, rate limited, a delete unfinished) leaves the switch as it is.
        if (conferenceRefuses(err)) pushDeletedOnServer(slug);
        continue;
      }
      if (!getPush(slug).on) {
        // Turned Off while the PUT was in flight: the PUT re-created a row the person just removed.
        try {
          await deletePushSubscription(slug, endpoint);
        } catch {
          // The server deletes it with the conference, or on the next 410.
        }
        continue;
      }
      setPush(slug, { endpoint, synced_at: Date.now() });
    }
  } catch {
    // The browser would not say; nothing to restore.
  }
}

/** Removes the server's copy for this conference and, when no conference uses it, the browser's subscription. */
export async function unsubscribePush(slug: string): Promise<void> {
  const state = getPush(slug);
  setPush(slug, { on: false, endpoint: null, synced_at: null });
  if (state.endpoint) {
    try {
      await deletePushSubscription(slug, state.endpoint);
    } catch {
      // The server deletes it with the conference, or on the next 410.
    }
  }
  if (slugsWithPush().length) return;
  await dropBrowserSubscription();
}

/** Unsubscribes the browser itself. Used when nothing needs the subscription any more. */
export async function dropBrowserSubscription(): Promise<void> {
  if (MOCK || !supportsPush()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(appPath(''));
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // Nothing else to do; the server's copy expires with the conference.
  }
}

/**
 * The server deleted this conference's subscription with the profile (both visibility choices
 * off): off on the device too, so the switch shows it and turning it on sends it again.
 */
export function pushDeletedOnServer(slug: string): void {
  const state = getPush(slug);
  if (!state.on && !state.endpoint) return;
  setPush(slug, { on: false, endpoint: null, synced_at: null });
  if (!slugsWithPush().length) void dropBrowserSubscription();
}

/** Turns nudges off everywhere on this device, as part of "Delete my profile". */
export async function forgetPush(): Promise<void> {
  for (const slug of slugsWithPush()) setPush(slug, { on: false, endpoint: null, synced_at: null });
  await dropBrowserSubscription();
}

if (MOCK && typeof window !== 'undefined') {
  // Shows a nudge through the registered worker, so a browser test can assert the notification
  // path without a push service. Returns the notifications the worker currently shows.
  (window as Window & { __caddiePushTest?: (body?: string) => Promise<number> }).__caddiePushTest = async (body) => {
    const reg = await worker();
    await reg.showNotification('Conference Caddie', {
      body: body ?? "Someone who's worked on eBPF probes in production is in Expo hall right now",
      icon: appPath('icons/icon-192.png'),
      tag: 'caddie-nudge',
      // The same shape as a server payload: a path from the root, which the worker resolves.
      data: { url: `${stripBase(location.pathname)}#/people?around=1` },
    });
    return (await reg.getNotifications()).length;
  };
}
