// Find people near me by Bluetooth: the Android companion's proximity feature (server/ble.mjs,
// the CaddieBle Capacitor plugin under web/android). Only inside the app, only while "I'm around"
// is on, off by default.
//
// On: the presence write carries ble: true and comes back with a 16-byte token that lives ten
// minutes; the plugin advertises it and scans for others. Every ten seconds the plugin hands
// over the tokens it heard, this module reports them, and the server answers with the strong
// matches standing within a few metres. The first one not nudged today becomes one local
// notification, "Someone who's worked on {evidence} is right near you"; tapping it opens the
// People tab on "Around now" with that person's card revealed. Once per person per day, on this
// device (caddie.nudged.v1.{slug}, ref -> date, the same record the in-app nudges keep).
// Off: the plugin stops and the token is cleared; presence stays as it was.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useEffect, useState } from 'preact/hooks';
import { isAbort, PeopleApiError, postSightings, putPresenceBle, rotateBleToken, type BleToken, type NearbyPerson, type Sighting } from './api';
import { keepUntilOffered } from './capabilities';
import { demoTitle, isDemo } from '../components/demo';
import { loadConferences } from '../lib/storage';
import { isPresenceNotActive, lastPositionFix, presenceWrite, writeWhileOn } from './presence';
import { getPresence, isBlocked, notify, usePeopleStore } from './storage';
import type { PersonResult } from './types';
import { toast } from './ui';

export const BLE_LABEL = 'Find people near me by Bluetooth (phone can stay in your pocket)';
export const BLE_NOTICE =
  "Your phone broadcasts a random code that changes every 10 minutes and listens for others. Nothing about you is sent over Bluetooth; the code means something only to our server, only while you're around. Only people who also turned this on can be found, and you're told only about strong matches within a few metres.";
export const NEARBY_TITLE = 'Conference Caddie';

/**
 * The notification title for a conference: "Conference Caddie", or "Conference Caddie · Demo
 * conference" for a demo conference, read from the conference list kept on this device.
 */
export function nearbyTitle(slug: string): string {
  return demoTitle(NEARBY_TITLE, isDemo(loadConferences()?.find((c) => c.slug === slug)));
}

/** The notification body, word for word. */
export function nearbyText(evidence: string): string {
  return `Someone who's worked on ${evidence} is right near you`;
}

const BLE_PREFIX = 'caddie.ble.v1.';
const NUDGED_PREFIX = 'caddie.nudged.v1.';
/** The token is asked for again this long before it stops resolving. */
const ROTATE_EARLY_MS = 20_000;
const ROTATE_RETRY_MS = 30_000;
const EVIDENCE_MAX = 80;

/* ---------- The plugin ---------- */

interface PermissionReport {
  granted: boolean;
  rationale?: Record<string, string>;
}

interface CaddieBlePlugin {
  isAvailable(): Promise<{ available: boolean; enabled: boolean; extended: boolean; rationale: Record<string, string> }>;
  checkPermissions(): Promise<PermissionReport>;
  requestPermissions(): Promise<PermissionReport>;
  start(options: { token: string; scan: boolean; durationMs: number }): Promise<void>;
  rotate(options: { token: string; durationMs?: number }): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<{ running: boolean }>;
  notify(options: { title: string; body: string; data?: string }): Promise<void>;
  addListener(event: 'sightings', cb: (ev: { sightings: Sighting[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'stopped', cb: (ev: { reason: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'notificationTap', cb: (ev: { data: string }) => void): Promise<PluginListenerHandle>;
}

const CaddieBle = registerPlugin<CaddieBlePlugin>('CaddieBle');

/** True inside the Android app. Everything in this module is a no-op elsewhere. */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

let availability: Promise<boolean> | null = null;

/** Whether this phone can take part: the app, with a Bluetooth LE adapter. Cached for the visit. */
export function bleAvailable(): Promise<boolean> {
  if (!isNativeApp()) return Promise.resolve(false);
  if (!availability) {
    availability = CaddieBle.isAvailable()
      .then((a) => a.available === true)
      .catch(() => false);
  }
  return availability;
}

export function useBleAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    bleAvailable().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/* ---------- Device state ---------- */

export interface BleState {
  on: boolean;
  notice_seen: boolean;
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

const stateMem = new Map<string, BleState>();

export function getBle(slug: string): BleState {
  let s = stateMem.get(slug);
  if (!s) {
    const raw = read<Partial<BleState>>(BLE_PREFIX + slug) ?? {};
    s = { on: raw.on === true, notice_seen: raw.notice_seen === true };
    stateMem.set(slug, s);
  }
  return s;
}

export function setBle(slug: string, patch: Partial<BleState>): BleState {
  const next = { ...getBle(slug), ...patch };
  stateMem.set(slug, next);
  write(BLE_PREFIX + slug, next);
  notify();
  return next;
}

/* ---------- Once per person per day (shared record with the in-app nudges) ---------- */

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Read fresh each time: the in-app nudges keep their own copy of the same key.
function nudgedToday(slug: string): Record<string, string> {
  const raw = read<unknown>(NUDGED_PREFIX + slug);
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [ref, date] of Object.entries(raw as Record<string, unknown>)) if (typeof date === 'string') out[ref] = date;
  }
  return out;
}

function wasNudgedToday(slug: string, ref: string): boolean {
  return nudgedToday(slug)[ref] === today();
}

function recordNudge(slug: string, ref: string): void {
  const day = today();
  const next: Record<string, string> = {};
  for (const [r, d] of Object.entries(nudgedToday(slug))) if (d === day) next[r] = d;
  next[ref] = day;
  write(NUDGED_PREFIX + slug, next);
}

/* ---------- Evidence as plain words ---------- */

function plainText(s: string): string {
  return s
    .replace(/<\/?mark>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gi, (w, b: string) => {
      const k = b.toLowerCase();
      return k === 'amp' ? '&' : k === 'lt' ? '<' : k === 'gt' ? '>' : k === 'quot' ? '"' : k === 'apos' || k === '#39' ? "'" : k === 'nbsp' ? ' ' : w;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short evidence for the notification: no name, nothing else. Null when there is none. */
export function evidenceWords(p: NearbyPerson): string | null {
  const text = p.evidence ? plainText(p.evidence).replace(/[.;,:]+$/, '') : '';
  if (text) {
    if (text.length <= EVIDENCE_MAX) return text;
    const cut = text.slice(0, EVIDENCE_MAX + 1).replace(/\s+\S*$/, '').trim();
    return `${cut || text.slice(0, EVIDENCE_MAX).trim()}…`;
  }
  return p.speak_topics?.[0]?.label ?? null;
}

/* ---------- The session: one conference, one token, the timers and listeners ---------- */

interface Session {
  slug: string;
  token: string;
  rotateAt: number;
  rotateTimer: number | undefined;
  handles: PluginListenerHandle[];
  inflight: AbortController | null;
  /** Set while a stop is under way, so a late event does not restart anything. */
  closing: boolean;
}

let session: Session | null = null;

export function bleRunning(slug: string): boolean {
  return !!session && session.slug === slug && !session.closing;
}

function presenceDuration(slug: string): number {
  const until = getPresence(slug).until;
  return Math.max(1000, (until ? Date.parse(until) : Date.now()) - Date.now());
}

function describe(err: unknown): string {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null;
  switch (code) {
    case 'bluetooth_off':
      return 'Turn on Bluetooth first.';
    case 'unsupported':
    case 'unavailable':
      return "This phone's Bluetooth can't send the code.";
    case 'permission_denied':
      return 'Caddie needs the Nearby devices permission for this. You can allow it in Settings.';
    case 'notifications_denied':
      return 'Turn on notifications for Caddie so it can tell you when someone is near.';
    default:
      return err instanceof PeopleApiError ? err.message : 'That could not be started. Please try again.';
  }
}

async function teardown(): Promise<void> {
  const s = session;
  if (!s) return;
  s.closing = true;
  window.clearTimeout(s.rotateTimer);
  s.inflight?.abort();
  for (const h of s.handles) {
    try {
      await h.remove();
    } catch {
      // Already gone.
    }
  }
  if (session === s) session = null;
}

function scheduleRotate(s: Session, atMs: number): void {
  window.clearTimeout(s.rotateTimer);
  const delay = Math.max(5_000, atMs - Date.now());
  s.rotateTimer = window.setTimeout(() => void rotateNow(s.slug), Math.min(delay, 0x7fffffff));
}

/** Asks the server for a fresh token and hands it to the plugin with the remaining presence time. */
export async function rotateNow(slug: string): Promise<void> {
  const s = session;
  if (!s || s.slug !== slug || s.closing) return;
  if (!getPresence(slug).on) {
    await stopBle(slug, { tellServer: false });
    return;
  }
  try {
    const res = await rotateBleToken(slug);
    if (session !== s || s.closing) return;
    s.token = res.ble.token;
    s.rotateAt = Date.parse(res.ble.rotate_at);
    await CaddieBle.rotate({ token: s.token, durationMs: presenceDuration(slug) });
    scheduleRotate(s, s.rotateAt - ROTATE_EARLY_MS);
  } catch (err) {
    if (session !== s || s.closing) return;
    if (err instanceof PeopleApiError && err.status === 403) {
      // Presence lapsed or the profile is gone: the server cleared the token with it.
      await stopBle(slug, { tellServer: false });
      return;
    }
    const code = (err as { code?: unknown })?.code;
    if (code === 'not_running') {
      await stopBle(slug, { tellServer: true });
      return;
    }
    // Offline for a moment: the old token still resolves until rotateAt; try again soon.
    scheduleRotate(s, Date.now() + ROTATE_RETRY_MS);
  }
}

async function onSightings(slug: string, sightings: Sighting[]): Promise<void> {
  const s = session;
  if (!s || s.slug !== slug || s.closing || !sightings.length) return;
  if (!getPresence(slug).on) {
    await stopBle(slug, { tellServer: false });
    return;
  }
  s.inflight?.abort();
  const ctl = new AbortController();
  s.inflight = ctl;
  let nearby: NearbyPerson[];
  try {
    nearby = (await postSightings(slug, sightings, ctl.signal)).nearby ?? [];
  } catch (err) {
    if (isAbort(err)) return;
    if (err instanceof PeopleApiError && err.status === 403 && err.code !== 'no_device') {
      // ble_required or profile_required: the server no longer holds a live token for us.
      if (session === s) await stopBle(slug, { tellServer: false });
    }
    return;
  }
  if (session !== s || s.closing) return;
  for (const p of nearby) {
    if (isBlocked(slug, p.ref) || wasNudgedToday(slug, p.ref)) continue;
    const evidence = evidenceWords(p);
    if (!evidence) continue;
    recordNudge(slug, p.ref);
    try {
      await CaddieBle.notify({ title: nearbyTitle(slug), body: nearbyText(evidence), data: `${slug}|${p.ref}` });
    } catch {
      // Notifications are off for the app; the Around now list still shows them.
    }
    return;
  }
}

async function onStopped(slug: string, reason: string): Promise<void> {
  const s = session;
  if (!s || s.slug !== slug || s.closing) return;
  await teardown();
  setBle(slug, { on: false });
  if (reason === 'user' || reason === 'stale') {
    void clearOnServer(slug);
  }
  if (reason === 'bluetooth_off') toast('Bluetooth turned off, so finding people near you stopped.');
  else if (reason.startsWith('advertise_failed') || reason === 'unsupported' || reason === 'extended_advertising_unsupported') {
    toast("This phone's Bluetooth couldn't send the code.");
  }
}

// Most of these run without a tap (the rotate timer's not_running, the 'stale' alarm, a failed
// start, a switch of conference), so they send 'keep' where the backend offers it and never move
// the end of presence (writeWhileOn). A 'keep' refused with presence_not_active ends presence on
// the device; Bluetooth is stopped already.
async function clearOnServer(slug: string): Promise<void> {
  if (!getPresence(slug).on) return;
  try {
    const keep = await keepUntilOffered();
    // In the presence write queue, and only if presence is still on when its turn comes: a write
    // after the delete would switch presence back on.
    await presenceWrite(async () => {
      const p = getPresence(slug);
      if (p.on && p.zone) await writeWhileOn(slug, keep, p.mode, (until) => putPresenceBle(slug, p.zone as string, p.spot, false, lastPositionFix(slug), until), { retry: true });
    });
  } catch {
    // The token dies with presence, at the latest in ten minutes.
  }
}

async function attach(slug: string, token: BleToken): Promise<Session> {
  const s: Session = { slug, token: token.token, rotateAt: Date.parse(token.rotate_at), rotateTimer: undefined, handles: [], inflight: null, closing: false };
  session = s;
  s.handles.push(await CaddieBle.addListener('sightings', (ev) => void onSightings(slug, ev.sightings ?? [])));
  s.handles.push(await CaddieBle.addListener('stopped', (ev) => void onStopped(slug, ev.reason ?? 'stopped')));
  scheduleRotate(s, s.rotateAt - ROTATE_EARLY_MS);
  return s;
}

/** Turns the feature on for this conference. Resolves to an error message, or null. */
export async function startBle(slug: string): Promise<string | null> {
  if (!isNativeApp()) return 'This works in the Conference Caddie app for Android.';
  const p = getPresence(slug);
  if (!p.on || !p.zone) return 'Turn on being around first.';
  if (session) await stopBle(session.slug, { tellServer: session.slug !== slug });
  try {
    let perms = await CaddieBle.checkPermissions();
    if (!perms.granted) perms = await CaddieBle.requestPermissions();
    if (!perms.granted) return describe({ code: 'permission_denied' });
    const a = await CaddieBle.isAvailable();
    if (!a.available) return describe({ code: 'unavailable' });
    if (!a.enabled) return describe({ code: 'bluetooth_off' });
    if (!a.extended) return describe({ code: 'unsupported' });
  } catch (err) {
    return describe(err);
  }
  let res: Awaited<ReturnType<typeof putPresenceBle>> | null;
  try {
    // Presence is on already, so this keeps its end where the backend offers 'keep'.
    const keep = await keepUntilOffered();
    res = await presenceWrite(async () => {
      // Presence may have been turned off while the permission prompts were open.
      const now = getPresence(slug);
      return now.on && now.zone
        ? writeWhileOn(slug, keep, now.mode, (until) => putPresenceBle(slug, now.zone as string, now.spot, true, lastPositionFix(slug), until), { retry: true })
        : null;
    });
  } catch (err) {
    // Presence had ended on the server; it has ended on the device too (writeWhileOn), and
    // nothing was started.
    if (isPresenceNotActive(err)) return 'Turn on being around first.';
    return describe(err);
  }
  if (!res) return 'Turn on being around first.';
  if (!res.ble?.token) return 'That could not be started. Please try again.';
  try {
    await CaddieBle.start({ token: res.ble.token, scan: true, durationMs: presenceDuration(slug) });
  } catch (err) {
    void clearOnServer(slug);
    return describe(err);
  }
  await attach(slug, res.ble);
  setBle(slug, { on: true, notice_seen: true });
  return null;
}

/** Turns the feature off. Presence stays as it was. */
export async function stopBle(slug: string, { tellServer = true }: { tellServer?: boolean } = {}): Promise<void> {
  await teardown();
  if (isNativeApp()) {
    try {
      await CaddieBle.stop();
    } catch {
      // Not running.
    }
  }
  if (getBle(slug).on) setBle(slug, { on: false });
  if (tellServer) await clearOnServer(slug);
}

/** Stops the feature and forgets its device state, for "Delete my profile" (the server cleared the token). */
export async function resetBle(): Promise<void> {
  if (session) await stopBle(session.slug, { tellServer: false });
  stateMem.clear();
}

/**
 * On opening the People tab: the device says the feature is on, so pick the session back up if
 * the service is still running (a fresh token at once), otherwise record that it is off.
 */
export async function resumeBle(slug: string): Promise<void> {
  if (!isNativeApp() || !getBle(slug).on || bleRunning(slug)) return;
  const p = getPresence(slug);
  let running = false;
  try {
    running = (await CaddieBle.isRunning()).running === true;
  } catch {
    running = false;
  }
  if (!running || !p.on) {
    setBle(slug, { on: false });
    if (running) await stopBle(slug, { tellServer: p.on });
    return;
  }
  try {
    const res = await rotateBleToken(slug);
    await CaddieBle.rotate({ token: res.ble.token, durationMs: presenceDuration(slug) });
    await attach(slug, res.ble);
  } catch {
    await stopBle(slug, { tellServer: false });
  }
}

/* ---------- "See who": the tapped notification lands on the card ---------- */

let reveal: { slug: string; ref: string } | null = null;

function onTap(data: string): void {
  const sep = data.indexOf('|');
  if (sep <= 0) return;
  reveal = { slug: data.slice(0, sep), ref: data.slice(sep + 1) };
  notify();
  if (!/^#\/(people|here)\b/.test(location.hash)) location.hash = '#/people';
}

if (isNativeApp()) {
  // Registered at start so a tap that cold-started the app is delivered too.
  void CaddieBle.addListener('notificationTap', (ev) => onTap(typeof ev?.data === 'string' ? ev.data : '')).catch(() => undefined);
}

/** The ref whose card the People tab should land on, once the Around now list has loaded. */
export function pendingBleReveal(slug: string): string | null {
  return reveal && reveal.slug === slug ? reveal.ref : null;
}

/** Re-renders when a reveal is asked for; returns the pending ref. */
export function useBleReveal(slug: string): string | null {
  usePeopleStore();
  return pendingBleReveal(slug);
}

/**
 * Scrolls to and highlights the card of the revealed person among the cards rendered in `list`,
 * in the order of `people`. The request is consumed either way.
 */
export function revealBleCard(slug: string, list: HTMLElement | null, people: PersonResult[]): void {
  const ref = pendingBleReveal(slug);
  if (!ref) return;
  reveal = null;
  const index = people.findIndex((p) => p.ref === ref);
  const card = index >= 0 ? list?.querySelectorAll<HTMLElement>(':scope > .pp-person')[index] : undefined;
  if (card) {
    card.classList.add('pp-person-revealed');
    window.setTimeout(() => card.classList.remove('pp-person-revealed'), 4000);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  notify();
}

/** Re-renders with the people store; returns the device state for the switch. */
export function useBleState(slug: string): BleState {
  usePeopleStore();
  return getBle(slug);
}
