// Writes the device's profile and visibility choices to the server. A document
// is written only while the user is visible conference-wide or shares for a talk;
// when both are off, one write asks the server to delete it.
//
// Deletes and profile writes do not overlap. A delete first stops new profile writes for the
// conferences it covers, holds back a profile edit that is still waiting to be sent, and waits for
// the writes already sent to be answered, for up to 15 seconds. Where the browser has Web Locks,
// writes and deletes in every tab of the app also take one shared lock, so another tab cannot
// interleave them. Only then is the DELETE sent. If the wait ran out, the delete is sent anyway
// but counts as unconfirmed, and it is repeated later.
//
// A delete is marked on the device before it is sent, and the mark goes only once the server has
// confirmed it. "Delete my profile" is stored as a whole before its first request and removed
// only when the device's data goes. While a mark covers a conference, no profile write and no
// automatic share goes to it; while "Delete my profile" is stored, none goes anywhere. Unfinished
// deletes are tried again at start-up, when the app comes back to the foreground or back online,
// and on a timer that waits longer after each failure. Only one tab retries at a time.
import { deleteProfile, fetchTopics, PeopleApiError, putProfile, type ProfileBody } from './api';
import { forgetPush } from './push';
import {
  clearAllPeopleData,
  deviceRemovedElsewhere,
  ensureDevice,
  getDeleteAll,
  getDeletePending,
  getDevice,
  getProfile,
  getVisibility,
  NEW_RETRY,
  notify,
  setDeleteAll,
  setDeletePending,
  setProfile,
  setVisibility,
  slugsDeletePending,
  slugsMaybeOnServer,
  slugsOnServer,
  topicsFor,
  updateDeleteAll,
  updateDeletePending,
} from './storage';
import type { DeleteFailure, DeleteRetry, Profile, TopicRef, Visibility } from './types';

export const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

export type SyncState = { state: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
let status: SyncState = { state: 'idle' };

// The debounce timer of scheduleProfileSync; undefined when no profile edit is waiting to be sent.
let timer: number | undefined;

export function getSyncStatus(): SyncState {
  return status;
}

let saveCount = 0;

/** Increases after every successful write, so screens can refetch server results. */
export function getSaveCount(): number {
  return saveCount;
}

function setStatus(s: SyncState): void {
  status = s;
  if (s.state === 'saved') saveCount++;
  notify();
}

/** Returns a short message when the profile cannot be sent, else null. */
export function profileProblem(p: Profile | null): string | null {
  if (!p || !p.display_name.trim()) return 'Add your name to your profile first.';
  const url = p.linkedin_url.trim();
  if (url && !LINKEDIN_RE.test(url)) return 'The LinkedIn link should look like https://www.linkedin.com/in/your-name.';
  return null;
}

function bodyFor(slug: string, p: Profile, v: Visibility): ProfileBody {
  const t = topicsFor(p, slug);
  return {
    event: slug,
    profile: {
      display_name: p.display_name.trim().slice(0, 60),
      about: p.about.trim().slice(0, 280),
      interests: p.interests.trim().slice(0, 500),
      expertise: p.expertise.trim().slice(0, 500),
      learn_topics: t.learn.map((x) => x.topic_id).slice(0, 30),
      speak_topics: t.speak.map((x) => x.topic_id).slice(0, 30),
      linkedin_url: p.linkedin_url.trim() || null,
      contact_note: p.contact_note.trim().slice(0, 120),
    },
    open_to_meet: v.open_to_meet,
    shared_talk_ids: v.shared_talk_ids.slice(0, 50),
  };
}

// A PeopleApiError already carries the plain-language text: the server's own reason for a 400
// when the app knows how to put it in words, otherwise a generic line.
function messageFor(err: unknown): string {
  if (err instanceof WritesHeldError) return WRITES_HELD_MESSAGE;
  if (err instanceof PeopleApiError) return err.message;
  return 'That could not be saved. Please try again.';
}

/** Starts the note that tells the user which topics were removed. Also marks it as a hint, not an error. */
export const RETIRED_NOTICE_PREFIX = 'Topics the conference list no longer offers were removed from your profile';
let retiredNotice: string | null = null;

/** True for messages that report something done for the user rather than a failure. */
export function isHintMessage(message: string): boolean {
  return message === CUT_MESSAGE || message.startsWith(RETIRED_NOTICE_PREFIX);
}

/**
 * Removes the topics of this conference that its topic list no longer offers (a topics run can
 * drop a topic after someone picked it) and returns the changed profile, or null when nothing
 * can be removed. The list holds at most 150 topics, so one request returns all of them.
 */
async function retireTopics(slug: string, p: Profile): Promise<Profile | null> {
  let known: Set<string>;
  try {
    known = new Set((await fetchTopics(slug, '', 150)).topics.map((t) => t.topic_id));
  } catch {
    return null;
  }
  if (!known.size) return null;
  const t = topicsFor(p, slug);
  const gone = new Map<string, string>();
  const keep = (list: TopicRef[]) =>
    list.filter((x) => {
      if (known.has(x.topic_id)) return true;
      gone.set(x.topic_id, x.label);
      return false;
    });
  const learn = keep(t.learn);
  const speak = keep(t.speak);
  if (!gone.size) return null;
  const next: Profile = { ...p, topics: { ...p.topics, [slug]: { learn, speak } } };
  setProfile(next);
  retiredNotice = `${RETIRED_NOTICE_PREFIX}: ${[...gone.values()].join(', ')}.`;
  return next;
}

/**
 * Sends one profile write, or fails with WritesHeldError while a delete covers its conference or
 * another tab has removed the device's identity. The check and the request start in the same turn,
 * so a delete that holds writes from then on either sees this write in flight or stops it.
 */
function sendProfile(slug: string, p: Profile, v: Visibility) {
  if (writesHeld(slug) || deviceRemovedElsewhere()) return Promise.reject(new WritesHeldError());
  return putProfile(bodyFor(slug, p, v));
}

/**
 * Sends the profile. When the server rejects a topic it no longer offers, that topic is removed
 * from the profile and the write is tried once more, so one retired topic cannot block sharing.
 * The whole exchange counts as one write in flight and runs under the shared write lock, so a
 * delete waits for both requests.
 */
function putChecked(slug: string, p: Profile, v: Visibility) {
  return track(withWriteLock(() => putCheckedNow(slug, p, v)));
}

async function putCheckedNow(slug: string, p: Profile, v: Visibility) {
  retiredNotice = null;
  try {
    return await sendProfile(slug, p, v);
  } catch (err) {
    const retired = err instanceof PeopleApiError && err.status === 400 && /_topics contains an unknown topic/.test(err.code ?? '');
    const fixed = retired ? await retireTopics(slug, p) : null;
    if (!fixed) throw err;
    return await sendProfile(slug, fixed, v);
  }
}

function wantsServer(v: Visibility): boolean {
  return v.open_to_meet || v.shared_talk_ids.length > 0;
}

/** True for a failed write that created nothing: never sent, or refused (4xx). */
function refusedOrUnsent(err: unknown): boolean {
  return err instanceof WritesHeldError || (err instanceof PeopleApiError && err.status >= 400 && err.status < 500);
}

/**
 * Applies a visibility change for one conference and writes it to the server.
 * On failure the local state is left unchanged and the error message is returned. The exception
 * is turning both choices off when the server may already have hidden the profile: the choice
 * then applies on the device, and the delete stays marked and is tried again.
 * `auto` is set for the automatic share of "sharing follows Interested", which ends quietly when a
 * delete covers the conference by the time its turn comes.
 */
export async function changeVisibility(slug: string, patch: Partial<Visibility>, auto = false): Promise<string | null> {
  // A delete that is running finishes first, so this change starts from the state it left.
  await deletesSettled();
  if (auto && (!getVisibility(slug).share_new || writesBlocked(slug))) return null;
  let current = getVisibility(slug);
  let next = { ...current, ...patch };
  if (!wantsServer(next)) {
    if (!current.on_server && !current.maybe_on_server) {
      setVisibility(slug, { ...patch, on_server: false });
      return null;
    }
    // Both choices are off, so the server copy is removed.
    setStatus({ state: 'saving' });
    const removed = await removeFromServer(slug, patch);
    if (removed !== SHARE_INSTEAD) return removed;
    setStatus({ state: 'idle' });
    current = getVisibility(slug);
    next = { ...current, ...patch };
  }
  // A write now would bring back a profile whose delete has not finished.
  if (writesBlocked(slug)) return DELETE_PENDING_MESSAGE;
  const p = getProfile();
  const problem = profileProblem(p);
  if (problem) return problem;
  ensureDevice();
  setStatus({ state: 'saving' });
  // Until the server answers a first write, it may hold a document or not; a delete covers both.
  const creating = !current.on_server;
  if (creating) setVisibility(slug, { maybe_on_server: true });
  try {
    const res = await putChecked(slug, p as Profile, next);
    setVisibility(slug, {
      ...patch,
      open_to_meet: res.open_to_meet,
      shared_talk_ids: res.shared_talk_ids,
      on_server: res.open_to_meet || res.shared_talk_ids.length > 0,
      maybe_on_server: false,
      hidden_for_owner: res.hidden_for_owner === true,
    });
    setStatus({ state: 'saved' });
    return null;
  } catch (err) {
    if (creating && refusedOrUnsent(err)) setVisibility(slug, { maybe_on_server: false });
    const message = messageFor(err);
    setStatus({ state: 'error', message });
    return message;
  }
}

export const MAX_SHARED_TALKS = 50;

/**
 * Writes to the shared-talk list run one at a time. Each one reads the list after the previous
 * write has landed, so two quick taps (mark A, mark B; or unmark, then Undo) cannot read the same
 * stale list and overwrite each other.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

/**
 * Shares for every talk in `talkIds` (keeping existing shares), up to the server's limit of 50.
 * Returns an error message, or null. When the limit cuts the list, the message says so but the
 * shares that fit are still written.
 */
export function shareForTalks(slug: string, talkIds: string[]): Promise<string | null> {
  return serial(async () => (await shareNow(slug, talkIds)).message);
}

export const CUT_MESSAGE = `You can share for up to ${MAX_SHARED_TALKS} talks, so the first ${MAX_SHARED_TALKS} are shared.`;

/** The write behind shareForTalks; `ok` is true when the shares that fit were written. */
async function shareNow(slug: string, talkIds: string[], auto = false): Promise<{ ok: boolean; message: string | null }> {
  const current = getVisibility(slug).shared_talk_ids;
  const union = [...new Set([...current, ...talkIds])];
  const cut = union.length > MAX_SHARED_TALKS;
  const err = await changeVisibility(
    slug,
    {
      shared_talk_ids: union.slice(0, MAX_SHARED_TALKS),
      share_notice_seen: true,
    },
    auto,
  );
  if (err) return { ok: false, message: err };
  const retired = retiredNotice;
  retiredNotice = null;
  return { ok: true, message: cut ? CUT_MESSAGE : retired };
}

/** Stops sharing for the given talks. Returns an error message, or null. */
export function unshareTalks(slug: string, talkIds: string[], auto = false): Promise<string | null> {
  return serial(() => {
    const current = getVisibility(slug).shared_talk_ids;
    const next = current.filter((id) => !talkIds.includes(id));
    if (next.length === current.length) return Promise.resolve(null);
    return changeVisibility(slug, { shared_talk_ids: next }, auto);
  });
}

/** Stops sharing for every talk at this conference. Conference-wide visibility is unchanged. */
export function unshareAll(slug: string): Promise<string | null> {
  return serial(() => changeVisibility(slug, { shared_talk_ids: [] }));
}

/**
 * Turns on "sharing follows Interested" and catches up by sharing for every talk already marked.
 * The preference is stored only once that share has succeeded, so a failed catch-up leaves the
 * switch off and the message returned here tells the user why.
 */
export function followInterested(slug: string, talkIds: string[]): Promise<string | null> {
  return serial(async () => {
    const r = await shareNow(slug, talkIds);
    if (r.ok) setVisibility(slug, { share_new: true, share_notice_seen: true });
    return r.message;
  });
}

/**
 * Called by the shell when talks are marked or unmarked. With the "sharing follows Interested"
 * preference on, marked talks are shared and unmarked ones are unshared. Otherwise nothing
 * happens and null is returned; the per-talk switch stays the only way to share. A returned
 * message (profile incomplete, the 50-talk limit, a failed write) is for the shell to show.
 */
export function onInterestedChanged(slug: string, talkIds: string[], marked: boolean): Promise<string | null> {
  // While a delete covers this conference, marking a talk shares nothing.
  if (!talkIds.length || !getVisibility(slug).share_new || writesBlocked(slug)) return Promise.resolve(null);
  return marked ? serial(async () => (await shareNow(slug, talkIds, true)).message) : unshareTalks(slug, talkIds, true);
}

/** Debounces profile edits, then writes them to every conference that holds a document. */
export function scheduleProfileSync(): void {
  window.clearTimeout(timer);
  timer = undefined;
  // A conference that a delete covers never gets the edit; see the top of this file.
  const slugs = slugsOnServer().filter((slug) => !writesBlocked(slug));
  // Every one of them is held by a running delete: the edit is sent once the delete is over.
  if (slugs.length && slugs.every(heldNow)) syncDeferred = true;
  if (!slugs.length || syncDeferred) {
    if (status.state === 'saving' && !inFlight.size) setStatus({ state: 'idle' });
    return;
  }
  setStatus({ state: 'saving' });
  timer = window.setTimeout(async () => {
    timer = undefined;
    const p = getProfile();
    const problem = profileProblem(p);
    if (problem || !p) {
      setStatus({ state: 'error', message: problem ?? undefined });
      return;
    }
    let sent = 0;
    try {
      for (const slug of slugsOnServer()) {
        if (writesBlocked(slug)) continue;
        if (heldNow(slug)) {
          syncDeferred = true;
          continue;
        }
        let res;
        try {
          res = await putChecked(slug, getProfile() ?? p, getVisibility(slug));
        } catch (err) {
          // A delete started while this write waited its turn; the edit goes once it is over.
          if (!(err instanceof WritesHeldError)) throw err;
          syncDeferred = true;
          continue;
        }
        sent++;
        // The server says whether this profile is hidden after reports; the profile screen shows it.
        if ((res.hidden_for_owner === true) !== getVisibility(slug).hidden_for_owner) setVisibility(slug, { hidden_for_owner: res.hidden_for_owner === true });
      }
      setStatus({ state: sent ? 'saved' : 'idle' });
    } catch (err) {
      setStatus({ state: 'error', message: messageFor(err) });
    }
    if (syncDeferred && !holds.size) {
      syncDeferred = false;
      scheduleProfileSync();
    }
  }, 1000);
}

/* ---------- Deletes: holding writes, and the shared lock ---------- */

/** Shown when the user asks to share while a delete covers the conference. */
export const DELETE_PENDING_MESSAGE =
  'Removing your profile has not finished. Finish it first with Try again at the top of your profile.';

/** Shown in the rare case a write is stopped because a delete started at the same moment. */
const WRITES_HELD_MESSAGE = 'Your profile is being removed, so that was not saved.';

/** Thrown instead of sending a profile write while writes for its conference are held. */
class WritesHeldError extends Error {}

// Each running or queued delete holds the profile writes for its conferences (null: all of them).
const holds = new Set<{ slugs: string[] | null }>();
// Profile writes that have been started and not yet answered.
const inFlight = new Set<Promise<unknown>>();
// Every delete asked for so far; a new one waits for the earlier ones, within its time budget.
let deleteChain: Promise<unknown> = Promise.resolve();
// Set when a profile edit was held back by a running delete; it is sent once no delete holds writes.
let syncDeferred = false;

/** How long a delete waits for earlier deletes, writes in flight and the lock, in all. */
const WAIT_MS = 15_000;
const WRITE_LOCK = 'caddie-people-writes';
const RETRY_LOCK = 'caddie-people-delete-retry';

function heldNow(slug: string): boolean {
  for (const h of holds) if (!h.slugs || h.slugs.includes(slug)) return true;
  return false;
}

/** True while an unfinished delete covers this conference, or "Delete my profile" is unfinished. */
function writesBlocked(slug: string): boolean {
  return getDeleteAll() !== null || getDeletePending(slug) !== null;
}

/** True while no profile write may go to this conference: a delete for it is running or unfinished. */
export function writesHeld(slug: string): boolean {
  return heldNow(slug) || writesBlocked(slug);
}

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => void inFlight.delete(p);
  p.then(done, done);
  return p;
}

/** Resolves true once `p` settles, or false at `deadline` (epoch milliseconds) if it has not. */
function settlesBy(p: Promise<unknown>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    // The global timer, not window's: the tests drive window's timers by hand.
    const t = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    const done = () => {
      clearTimeout(t);
      resolve(true);
    };
    p.then(done, done);
  });
}

/** Resolves once every delete asked for so far is over, or after the wait limit. */
function deletesSettled(): Promise<void> {
  return settlesBy(deleteChain, Date.now() + WAIT_MS).then(() => undefined);
}

interface Locks {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, fn: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/** The browser's Web Locks, shared by every tab of the app, or null where there are none. */
function webLocks(): Locks | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as unknown as { locks?: Locks }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Runs `fn` holding the lock that every tab takes for profile writes and deletes. Without Web
 * Locks, `fn` runs at once. With `waitMs`, waiting gives up after that long and `fn` runs without
 * the lock. `fn` learns whether nothing else can be writing: true when it holds the lock or there
 * is no lock to take.
 */
async function withWriteLock<T>(fn: (exclusive: boolean) => Promise<T>, waitMs?: number): Promise<T> {
  const locks = webLocks();
  if (!locks) return fn(true);
  if (waitMs === undefined) return (await locks.request(WRITE_LOCK, {}, () => fn(true))) as T;
  const ctrl = new AbortController();
  let granted = false;
  const t = setTimeout(() => ctrl.abort(), Math.max(0, waitMs));
  try {
    return (await locks.request(WRITE_LOCK, { signal: ctrl.signal }, () => {
      granted = true;
      clearTimeout(t);
      return fn(true);
    })) as T;
  } catch (err) {
    if (granted) throw err;
    clearTimeout(t);
    return fn(false);
  }
}

/**
 * Runs `fn`, which sends deletes, with the profile writes for `slugs` (every conference when null)
 * held. The hold starts at once and a profile edit still waiting for its debounce is held back,
 * to be sent when no hold is left. `fn` starts once the earlier deletes are over, every write
 * already started has been answered and the shared lock is free, or once 15 seconds have passed.
 * A write in flight is waited for rather than aborted, because aborting the request in the browser
 * does not stop the server from applying it. `fn` learns whether every wait finished: if not, a
 * write may still land after the delete, which then has to run again.
 */
function runDelete<T>(slugs: string[] | null, fn: (certain: boolean) => Promise<T>): Promise<T> {
  const hold = { slugs };
  holds.add(hold);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
    syncDeferred = true;
    if (status.state === 'saving' && !inFlight.size) setStatus({ state: 'idle' });
  }
  const earlier = deleteChain;
  const run = async () => {
    const deadline = Date.now() + WAIT_MS;
    try {
      // An earlier delete that is still running cannot bring a profile back, so it only delays.
      await settlesBy(earlier, deadline);
      let writesDone = true;
      while (writesDone && inFlight.size) writesDone = await settlesBy(Promise.allSettled([...inFlight]), deadline);
      return await withWriteLock(async (exclusive) => {
        try {
          return await fn(writesDone && exclusive);
        } finally {
          holds.delete(hold);
        }
      }, deadline - Date.now());
    } finally {
      holds.delete(hold);
      if (!holds.size && syncDeferred) {
        syncDeferred = false;
        scheduleProfileSync();
      }
      scheduleRetryTimer();
    }
  };
  const p = run();
  deleteChain = Promise.allSettled([earlier, p]);
  return p;
}

/* ---------- Deletes: failures and messages ---------- */

// When deletes for several conferences fail differently, the message speaks about the worst.
const FAILURE_RANK: Record<DeleteFailure, number> = { partial: 4, offline: 3, forbidden: 2, rate: 1, bad: 0 };

function failureKind(err: unknown): DeleteFailure {
  if (err instanceof PeopleApiError) {
    if (err.status === 0) return 'offline';
    if (err.status === 429) return 'rate';
    if (err.status === 403) return 'forbidden';
    if (err.status >= 400 && err.status < 500) return 'bad';
  }
  return 'partial';
}

/**
 * Whether a failed delete may have done part of its work. The server hides the profile first and
 * answers 502 when a later step fails, and a lost connection can hide any answer. A 400, 403 or
 * 429 comes before the server changes anything.
 */
function mayBePartlyDone(err: unknown): boolean {
  const kind = failureKind(err);
  return kind === 'partial' || kind === 'offline';
}

/**
 * A 404 counts as "already gone" only when it is the API's own JSON answer. A 404 page from
 * something in between (a proxy, a wrong origin) says nothing about the profile.
 */
function isGone(err: unknown): boolean {
  return err instanceof PeopleApiError && err.status === 404 && err.code !== null;
}

function retryAfterOf(err: unknown): number {
  return err instanceof PeopleApiError && err.retryAfter !== null ? err.retryAfter : 0;
}

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/** After this many refusals of the device's key in a row, the user can stop the retries. */
const STOP_AFTER_FORBIDDEN = 3;

/** A record after one more failed attempt: the wait doubles from 30 seconds up to 30 minutes, or follows a longer Retry-After. */
function afterFailure(r: DeleteRetry, kind: DeleteFailure, retryAfterSec: number): Partial<DeleteRetry> {
  const attempts = r.attempts + 1;
  const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (attempts - 1));
  return { attempts, next_at: Date.now() + Math.max(wait, retryAfterSec * 1000), forbidden: kind === 'forbidden' ? r.forbidden + 1 : 0, last: kind };
}

/** Shown once "Delete my profile" has finished. */
export const DELETED_MESSAGE = 'Your profile was deleted from this phone and from our server.';

/** Shown when the device's data went but the server copy could not be deleted from this device. */
export const DELETED_HERE_MESSAGE =
  'Your profile was deleted from this phone. This phone could not delete what our server still holds; that is removed after the conference ends.';

/** Shown when every delete went through while a profile write may still have been in flight. */
const ALMOST_DONE_MESSAGE =
  'Your profile was deleted from our server. A change sent just before may still arrive, so the app deletes it once more shortly and then clears this phone.';

type Refusal = 'rate' | 'forbidden' | 'bad';

/** What "Delete my profile" tells the user when it did not finish. */
const PROFILE_DELETE_FAILED: Record<DeleteFailure, string> = {
  partial: 'Your profile may be partly deleted: it may already be hidden from other attendees, but deleting it did not finish. Try again to finish.',
  offline: 'You appear to be offline. Your profile may be partly deleted. Try again to finish once you are online.',
  rate: 'Too many requests right now, so your profile was not deleted yet. Wait a minute and try again.',
  forbidden: 'This device is not allowed to delete your profile, so it was not deleted.',
  bad: 'Our server could not handle the request, so your profile was not deleted yet. Try again later, or update the app.',
};

/** The same, for a refusal after an earlier attempt may have done part of the work. */
const PROFILE_DELETE_UNFINISHED: Record<Refusal, string> = {
  rate: 'Too many requests right now, so deleting your profile has not finished. It may be partly deleted. Wait a minute and try again.',
  forbidden: 'This device is not allowed to finish deleting your profile. It may be partly deleted.',
  bad: 'Our server could not handle the request, so deleting your profile has not finished. It may be partly deleted. Try again later, or update the app.',
};

/** What turning both visibility choices off tells the user when removing the server copy failed. */
const VISIBILITY_DELETE_FAILED: Record<DeleteFailure, string> = {
  partial:
    'Your profile may already be hidden from others at this conference, but removing it did not finish. The app will try again, or you can finish it from your profile.',
  offline:
    'You appear to be offline, so removing your profile did not finish. It may already be hidden from others at this conference. The app will try again once you are online.',
  rate: 'Too many requests right now, so nothing changed. Wait a minute and try again.',
  forbidden: 'This device is not allowed to remove your profile, so nothing changed.',
  bad: 'Our server could not handle the request, so nothing changed. Try again later, or update the app.',
};

/** The same, for a refusal after an earlier attempt may have done part of the work. */
const VISIBILITY_DELETE_UNFINISHED: Record<Refusal, string> = {
  rate: 'Too many requests right now, so removing your profile has not finished. It may already be hidden from others at this conference. Wait a minute and try again.',
  forbidden: 'This device is not allowed to finish removing your profile. It may already be hidden from others at this conference.',
  bad: 'Our server could not handle the request, so removing your profile has not finished. It may already be hidden from others at this conference.',
};

function failureMessage(kind: DeleteFailure, partlyDone: boolean, all: boolean): string {
  const unfinished = all ? PROFILE_DELETE_UNFINISHED : VISIBILITY_DELETE_UNFINISHED;
  if (partlyDone && (kind === 'rate' || kind === 'forbidden' || kind === 'bad')) return unfinished[kind];
  return (all ? PROFILE_DELETE_FAILED : VISIBILITY_DELETE_FAILED)[kind];
}

/** The extra line the unfinished-delete notice shows after an attempt failed for a known reason. */
const PENDING_DETAIL: Record<DeleteFailure, string | null> = {
  partial: null,
  offline: 'You appear to be offline.',
  rate: 'Too many requests right now. Wait a minute and try again.',
  forbidden: 'This device is not allowed to delete your profile.',
  bad: 'Our server could not handle the request. Try again later, or update the app.',
};

/** True while any delete is unfinished: "Delete my profile", or the server copy at some conference. */
export function hasUnfinishedDelete(): boolean {
  return getDeleteAll() !== null || slugsDeletePending().length > 0;
}

/** The reason the last attempt at an unfinished delete failed, in plain words, or null. */
export function getPendingDeleteDetail(): string | null {
  const all = getDeleteAll();
  const last = all ? all.last : (slugsDeletePending().map((s) => getDeletePending(s)?.last ?? null).find((x) => x !== null) ?? null);
  return last ? PENDING_DETAIL[last] : null;
}

/* ---------- Deletes: sending them ---------- */

/** The device stops treating this conference as holding its profile. */
function forgetServerCopy(slug: string): void {
  setVisibility(slug, { on_server: false, maybe_on_server: false, hidden_for_owner: false });
  setDeletePending(slug, null);
}

/**
 * Sends the delete for one conference. The conference is marked on the device first, so profile
 * writes stay off for it until the server confirms, even if the app is closed in the middle. The
 * mark goes on success, or when the server refused before changing anything (400, 403, 429) and
 * no earlier attempt had left it; any other failure keeps it, with the time of the next attempt.
 * A mark that another tab removed meanwhile is never written back. With `certain` false, a write
 * may still land after the delete, so the mark stays even on success and the delete runs again.
 * Returns 'no_key' when the device has no identity: nothing on the server can be deleted from
 * here, so the mark goes too. Throws the request's error. Callers run it inside runDelete.
 */
async function deleteOnServer(slug: string, certain: boolean): Promise<'deleted' | 'no_key'> {
  if (!getDevice()) {
    forgetServerCopy(slug);
    return 'no_key';
  }
  const earlier = getDeletePending(slug);
  if (!earlier) setDeletePending(slug, NEW_RETRY);
  try {
    await deleteProfile(slug);
  } catch (err) {
    if (!isGone(err)) {
      const kind = failureKind(err);
      if (!earlier && !mayBePartlyDone(err)) setDeletePending(slug, null);
      else {
        const r = getDeletePending(slug);
        if (r) updateDeletePending(slug, afterFailure(r, kind, retryAfterOf(err)));
      }
      throw err;
    }
  }
  // on_server goes first: if the app stops between the two writes, the mark is still there and the
  // next attempt only repeats a delete that is done.
  setVisibility(slug, { on_server: false, maybe_on_server: false, hidden_for_owner: false });
  if (certain) setDeletePending(slug, null);
  else updateDeletePending(slug, { next_at: Date.now() + RETRY_FIRST_MS, last: null });
  return 'deleted';
}

/** Removes the people data from the device. Only for after the server confirmed every delete. */
async function wipeDevice(): Promise<void> {
  // The server deleted the push subscriptions with the profile; the browser's own goes too.
  await forgetPush();
  clearAllPeopleData();
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  setStatus({ state: 'idle' });
}

// Returned by removeFromServer when the choices, read again after the wait, still want the server.
const SHARE_INSTEAD = Symbol('share instead');

/** The both-off branch of changeVisibility: removes the server copy for one conference. */
async function removeFromServer(slug: string, patch: Partial<Visibility>): Promise<string | null | typeof SHARE_INSTEAD> {
  let outcome: 'removed' | 'share';
  try {
    outcome = await runDelete([slug], async (certain) => {
      // A write answered while this delete waited may have changed the choices. The state as it
      // is now decides whether there is anything to remove.
      if (wantsServer({ ...getVisibility(slug), ...patch })) return 'share';
      await deleteOnServer(slug, certain);
      return 'removed';
    });
  } catch (err) {
    const partlyDone = getDeletePending(slug) !== null;
    const message = failureMessage(failureKind(err), partlyDone, false);
    // The server copy may already be hidden. The user's choice applies on the device and the
    // delete is tried again; until it is done, nothing is written for this conference. After a
    // refusal nothing changed on the server, so the device keeps the earlier state too.
    if (partlyDone) setVisibility(slug, patch);
    setStatus({ state: 'error', message });
    return message;
  }
  if (outcome === 'share') return SHARE_INSTEAD;
  setVisibility(slug, patch);
  setStatus({ state: 'saved' });
  return null;
}

export interface DeleteResult {
  /** True once the device's data is gone. */
  done: boolean;
  /** What to tell the user. */
  message: string;
}

/**
 * One pass of "Delete my profile": deletes on the server for every conference that holds the
 * profile, may hold it, or has an unfinished delete, and removes the device's data, its key
 * included, only when the server has confirmed every one of them.
 */
async function deleteEverywhere(certain: boolean): Promise<DeleteResult> {
  // Another tab finished the delete and cleared the device meanwhile.
  if (!getDeleteAll()) {
    deviceRemovedElsewhere();
    return { done: true, message: DELETED_MESSAGE };
  }
  const targets = [...new Set([...slugsMaybeOnServer(), ...slugsDeletePending()])];
  let worst: DeleteFailure | null = null;
  let retryAfter = 0;
  let noKey = false;
  for (const slug of targets) {
    try {
      if ((await deleteOnServer(slug, certain)) === 'no_key') noKey = true;
    } catch (err) {
      const kind = failureKind(err);
      if (!worst || FAILURE_RANK[kind] > FAILURE_RANK[worst]) worst = kind;
      retryAfter = Math.max(retryAfter, retryAfterOf(err));
    }
  }
  if (worst) {
    const r = getDeleteAll();
    if (r) updateDeleteAll(afterFailure(r, worst, retryAfter));
    return { done: false, message: failureMessage(worst, slugsDeletePending().length > 0, true) };
  }
  if (slugsDeletePending().length || slugsMaybeOnServer().length) {
    updateDeleteAll({ next_at: Date.now() + RETRY_FIRST_MS, last: null });
    return { done: false, message: ALMOST_DONE_MESSAGE };
  }
  await wipeDevice();
  return { done: true, message: noKey ? DELETED_HERE_MESSAGE : DELETED_MESSAGE };
}

/**
 * "Delete my profile". The request is stored on the device before anything is sent, and only the
 * final clearing of the device removes it, so a refusal, a failure or a closed app cannot make the
 * device forget it: the retries carry on until every conference is done.
 */
export function deleteMyProfile(): Promise<DeleteResult> {
  if (!getDeleteAll()) setDeleteAll(NEW_RETRY);
  return runDelete(null, deleteEverywhere);
}

let retrying: Promise<boolean> | null = null;

function isDue(r: DeleteRetry | null): boolean {
  return r !== null && r.next_at <= Date.now();
}

/** One retry pass. With `onlyDue`, deletes whose next attempt is not due yet are left alone. */
function retryPass(onlyDue: boolean): Promise<boolean> {
  if (retrying) return retrying;
  const run = (async () => {
    if (getDeleteAll()) {
      if (!onlyDue || isDue(getDeleteAll())) await runDelete(null, deleteEverywhere);
    } else {
      const slugs = slugsDeletePending().filter((s) => !onlyDue || isDue(getDeletePending(s)));
      if (slugs.length) {
        await runDelete(slugs, async (certain) => {
          for (const slug of slugs) {
            // Another tab may have finished this one meanwhile.
            if (!getDeletePending(slug)) continue;
            try {
              await deleteOnServer(slug, certain);
            } catch {
              // The mark keeps the failure and the time of the next attempt.
            }
          }
        });
      }
    }
    return !hasUnfinishedDelete();
  })();
  retrying = run;
  const clear = () => {
    if (retrying === run) retrying = null;
  };
  run.then(clear, clear);
  return run;
}

/** Tries every unfinished delete again now, as the Try again button does. Resolves to true when nothing is left unfinished. */
export function finishPendingDeletes(): Promise<boolean> {
  return retryPass(false);
}

/**
 * True after the server refused this device's key three times in a row for every unfinished
 * delete: trying again will not help, and the user may stop.
 */
export function canStopTrying(): boolean {
  const all = getDeleteAll();
  if (all) return all.forbidden >= STOP_AFTER_FORBIDDEN;
  const pending = slugsDeletePending();
  return pending.length > 0 && pending.every((s) => (getDeletePending(s)?.forbidden ?? 0) >= STOP_AFTER_FORBIDDEN);
}

/**
 * Gives up on unfinished deletes. After "Delete my profile" the device's data goes; otherwise the
 * device stops treating those conferences as holding the profile. Returns the message for the
 * user after "Delete my profile", else null.
 */
export function stopTrying(): Promise<string | null> {
  return runDelete(null, async () => {
    if (getDeleteAll()) {
      await wipeDevice();
      return DELETED_HERE_MESSAGE;
    }
    for (const slug of slugsDeletePending()) forgetServerCopy(slug);
    return null;
  });
}

let retriesStarted = false;
let retryTimer: number | undefined;

/** Starts the retry the browser can run on its own: only one tab at a time, and only when due. */
function backgroundRetry(): void {
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  if (!hasUnfinishedDelete()) return;
  // Offline, nothing is sent; the 'online' event starts the next attempt.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const locks = webLocks();
  const pass = locks
    ? locks.request(RETRY_LOCK, { ifAvailable: true }, (lock) => (lock ? retryPass(true) : Promise.resolve(false)))
    : retryPass(true);
  pass.then(scheduleRetryTimer, scheduleRetryTimer);
}

/** Sets the timer for the next due retry, while the app is open and retries have started. */
function scheduleRetryTimer(): void {
  if (!retriesStarted) return;
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  const all = getDeleteAll();
  const times = all ? [all.next_at] : slugsDeletePending().map((s) => getDeletePending(s)?.next_at ?? 0);
  if (!times.length) return;
  retryTimer = window.setTimeout(backgroundRetry, Math.max(5_000, Math.min(...times) - Date.now()));
}

/**
 * Tries unfinished deletes again at start-up, whenever the app comes back to the foreground,
 * whenever the connection comes back, and when the wait after the last failure is over. The shell
 * calls it once.
 */
export function startDeleteRetries(): void {
  if (retriesStarted || typeof window === 'undefined') return;
  retriesStarted = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') backgroundRetry();
  });
  window.addEventListener('online', backgroundRetry);
  backgroundRetry();
}
