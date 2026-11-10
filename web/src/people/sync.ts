// Writes the device's profile and visibility choices to the server. A document
// is written only while the user is visible conference-wide or shares for a talk;
// when both are off, one write asks the server to delete it.
//
// Deletes and profile writes never overlap. A delete first stops new profile writes for the
// conferences it covers, holds back a profile edit that is still waiting to be sent, and waits
// for the writes already sent to be answered. Only then does it send the DELETE, so no write can
// land after it and bring the profile back. A delete is marked on the device before it is sent
// and the mark goes only once the server confirms it. While a conference carries the mark, no
// profile write and no automatic share goes to it, and the delete is tried again when the app
// starts, comes back to the foreground or comes back online.
import { deleteProfile, fetchTopics, PeopleApiError, putProfile, type ProfileBody } from './api';
import { forgetPush } from './push';
import {
  clearAllPeopleData,
  ensureDevice,
  getDeletePending,
  getProfile,
  getVisibility,
  notify,
  setDeletePending,
  setProfile,
  setVisibility,
  slugsDeletePending,
  slugsOnServer,
  topicsFor,
} from './storage';
import type { Profile, TopicRef, Visibility } from './types';

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
 * Sends one profile write, or fails with WritesHeldError while writes for its conference are held.
 * The check and the request start in the same turn, so a delete that holds writes from then on
 * either sees this write in flight or stops it.
 */
function sendProfile(slug: string, p: Profile, v: Visibility) {
  if (writesHeld(slug)) return Promise.reject(new WritesHeldError());
  return putProfile(bodyFor(slug, p, v));
}

/**
 * Sends the profile. When the server rejects a topic it no longer offers, that topic is removed
 * from the profile and the write is tried once more, so one retired topic cannot block sharing.
 * The whole exchange counts as one write in flight, so a delete waits for both requests.
 */
function putChecked(slug: string, p: Profile, v: Visibility) {
  return track(putCheckedNow(slug, p, v));
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

/**
 * Applies a visibility change for one conference and writes it to the server.
 * On failure the local state is left unchanged and the error message is returned. The exception
 * is turning both choices off when the server may already have hidden the profile: the choice
 * then applies on the device, and the delete stays marked and is tried again.
 */
export async function changeVisibility(slug: string, patch: Partial<Visibility>): Promise<string | null> {
  // A delete that is running finishes first, so this change starts from the state it left.
  await deletesSettled();
  const current = getVisibility(slug);
  const next = { ...current, ...patch };
  const wantsServer = next.open_to_meet || next.shared_talk_ids.length > 0;
  if (!wantsServer && !current.on_server) {
    setVisibility(slug, { ...patch, on_server: false });
    return null;
  }
  // A write now would bring back a profile whose delete has not finished.
  if (wantsServer && getDeletePending(slug)) return DELETE_PENDING_MESSAGE;
  const p = getProfile();
  if (wantsServer) {
    const problem = profileProblem(p);
    if (problem) return problem;
    ensureDevice();
  }
  setStatus({ state: 'saving' });
  // Both choices are off, so the server copy is removed.
  if (!wantsServer) return removeFromServer(slug, patch);
  try {
    const res = await putChecked(slug, p as Profile, next);
    setVisibility(slug, {
      ...patch,
      open_to_meet: res.open_to_meet,
      shared_talk_ids: res.shared_talk_ids,
      on_server: res.open_to_meet || res.shared_talk_ids.length > 0,
      hidden_for_owner: res.hidden_for_owner === true,
    });
    setStatus({ state: 'saved' });
    return null;
  } catch (err) {
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
async function shareNow(slug: string, talkIds: string[]): Promise<{ ok: boolean; message: string | null }> {
  const current = getVisibility(slug).shared_talk_ids;
  const union = [...new Set([...current, ...talkIds])];
  const cut = union.length > MAX_SHARED_TALKS;
  const err = await changeVisibility(slug, {
    shared_talk_ids: union.slice(0, MAX_SHARED_TALKS),
    share_notice_seen: true,
  });
  if (err) return { ok: false, message: err };
  const retired = retiredNotice;
  retiredNotice = null;
  return { ok: true, message: cut ? CUT_MESSAGE : retired };
}

/** Stops sharing for the given talks. Returns an error message, or null. */
export function unshareTalks(slug: string, talkIds: string[]): Promise<string | null> {
  return serial(() => {
    const current = getVisibility(slug).shared_talk_ids;
    const next = current.filter((id) => !talkIds.includes(id));
    if (next.length === current.length) return Promise.resolve(null);
    return changeVisibility(slug, { shared_talk_ids: next });
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
  // While a delete for this conference has not finished, marking a talk shares nothing.
  if (!talkIds.length || !getVisibility(slug).share_new || getDeletePending(slug)) return Promise.resolve(null);
  return marked ? shareForTalks(slug, talkIds) : unshareTalks(slug, talkIds);
}

/** Debounces profile edits, then writes them to every conference that holds a document. */
export function scheduleProfileSync(): void {
  window.clearTimeout(timer);
  timer = undefined;
  // A conference with an unfinished delete never gets the edit; see the top of this file.
  const slugs = slugsOnServer().filter((slug) => !getDeletePending(slug));
  if (!slugs.length) return;
  // Every one of them is held by a running delete: the edit is sent once the delete is over.
  if (slugs.every(heldNow)) {
    syncDeferred = true;
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
        if (getDeletePending(slug)) continue;
        if (heldNow(slug)) {
          syncDeferred = true;
          continue;
        }
        const res = await putChecked(slug, getProfile() ?? p, getVisibility(slug));
        sent++;
        // The server says whether this profile is hidden after reports; the profile screen shows it.
        if ((res.hidden_for_owner === true) !== getVisibility(slug).hidden_for_owner) setVisibility(slug, { hidden_for_owner: res.hidden_for_owner === true });
      }
      setStatus({ state: sent ? 'saved' : 'idle' });
    } catch (err) {
      setStatus({ state: 'error', message: messageFor(err) });
    }
  }, 1000);
}

/* ---------- Deletes ---------- */

/** Shown when the user asks to share while a delete for the conference has not finished. */
export const DELETE_PENDING_MESSAGE =
  'Removing your profile from this conference has not finished. Finish it first with Try again at the top of your profile.';

/** Shown in the rare case a write is stopped because a delete started at the same moment. */
const WRITES_HELD_MESSAGE = 'Your profile is being removed, so that was not saved.';

/** Shown once "Delete my profile" has finished. */
export const DELETED_MESSAGE = 'Your profile was deleted from this phone and from our server.';

/** Thrown instead of sending a profile write while writes for its conference are held. */
class WritesHeldError extends Error {}

// Each running or queued delete holds the profile writes for its conferences (null: all of them).
const holds = new Set<{ slugs: string[] | null }>();
// Profile writes that have been sent and not yet answered.
const inFlight = new Set<Promise<unknown>>();
// Deletes run one at a time, in the order they were asked for.
let deleteChain: Promise<unknown> = Promise.resolve();
// Set when a profile edit was held back by a running delete; it is sent once no delete holds writes.
let syncDeferred = false;

function heldNow(slug: string): boolean {
  for (const h of holds) if (!h.slugs || h.slugs.includes(slug)) return true;
  return false;
}

/** True while no profile write may go to this conference: a delete for it is running or unfinished. */
export function writesHeld(slug: string): boolean {
  return heldNow(slug) || getDeletePending(slug) !== null;
}

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => void inFlight.delete(p);
  p.then(done, done);
  return p;
}

/** Resolves once every delete asked for so far is over. */
function deletesSettled(): Promise<void> {
  return deleteChain.then(() => undefined);
}

/**
 * Runs `fn`, which sends deletes, with the profile writes for `slugs` (every conference when null)
 * held. The hold starts at once. `fn` starts after the earlier deletes, and once every write
 * already sent has been answered: aborting such a write would not stop the server from applying
 * it, so it is waited for instead. A profile edit still waiting for its debounce is held back too
 * and sent when no hold is left, to the conferences that still hold the profile.
 */
function runDelete<T>(slugs: string[] | null, fn: () => Promise<T>): Promise<T> {
  const hold = { slugs };
  holds.add(hold);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
    syncDeferred = true;
    if (status.state === 'saving' && !inFlight.size) setStatus({ state: 'idle' });
  }
  const run = async () => {
    try {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      return await fn();
    } finally {
      holds.delete(hold);
      if (!holds.size && syncDeferred) {
        syncDeferred = false;
        scheduleProfileSync();
      }
    }
  };
  const p = deleteChain.then(run, run);
  deleteChain = p.catch(() => undefined);
  return p;
}

/** How a delete failed, as far as the user is concerned. */
type DeleteFailure = 'partial' | 'offline' | 'rate' | 'forbidden' | 'bad';

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

/** What "Delete my profile" tells the user when it did not finish. */
const PROFILE_DELETE_FAILED: Record<DeleteFailure, string> = {
  partial: 'Your profile may be partly deleted: it may already be hidden from other attendees, but deleting it did not finish. Try again to finish.',
  offline: 'You appear to be offline. Your profile may be partly deleted. Try again to finish once you are online.',
  rate: 'Too many requests right now, so your profile was not deleted. Wait a minute and try again.',
  forbidden: 'This device is not allowed to delete your profile, so it was not deleted.',
  bad: 'Our server could not handle the request, so your profile was not deleted. Try again later, or update the app.',
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

/** The extra line the unfinished-delete notice shows after a retry failed for a known reason. */
const PENDING_DETAIL: Record<DeleteFailure, string | null> = {
  partial: null,
  offline: 'You appear to be offline.',
  rate: 'Too many requests right now. Wait a minute and try again.',
  forbidden: 'This device is not allowed to delete your profile.',
  bad: 'Our server could not handle the request. Try again later, or update the app.',
};

// Why the last attempt at an unfinished delete failed; null once nothing is unfinished.
let lastFailure: DeleteFailure | null = null;

/** The reason the last attempt at an unfinished delete failed, in plain words, or null. */
export function getPendingDeleteDetail(): string | null {
  return lastFailure && slugsDeletePending().length ? PENDING_DETAIL[lastFailure] : null;
}

/**
 * Sends the delete for one conference. The conference is marked on the device first, so profile
 * writes stay off for it until the server confirms, even if the app is closed in the middle. The
 * mark goes on success, or when the server refused before changing anything (400, 403, 429) and
 * no earlier attempt had left it; any other failure keeps it for a retry. Throws the request's
 * error. Callers run it inside runDelete.
 */
async function deleteOnServer(slug: string, wipe: boolean): Promise<void> {
  const earlier = getDeletePending(slug);
  setDeletePending(slug, { wipe: wipe || earlier?.wipe === true });
  try {
    await deleteProfile(slug);
  } catch (err) {
    // A missing document is already gone.
    if (!(err instanceof PeopleApiError && err.status === 404)) {
      if (!earlier && !mayBePartlyDone(err)) setDeletePending(slug, null);
      else lastFailure = failureKind(err);
      throw err;
    }
  }
  setDeletePending(slug, null);
  setVisibility(slug, { on_server: false, hidden_for_owner: false });
  if (!slugsDeletePending().length) lastFailure = null;
}

/** Deletes on the server for each conference in turn. Returns the worst failure, or null. */
async function deleteEach(slugs: string[], wipe: boolean): Promise<DeleteFailure | null> {
  let worst: DeleteFailure | null = null;
  for (const slug of slugs) {
    try {
      await deleteOnServer(slug, wipe);
    } catch (err) {
      const kind = failureKind(err);
      if (!worst || FAILURE_RANK[kind] > FAILURE_RANK[worst]) worst = kind;
    }
  }
  return worst;
}

/** Removes the people data from the device. Only for after the server confirmed every delete. */
async function wipeDevice(): Promise<void> {
  // The server deleted the push subscriptions with the profile; the browser's own goes too.
  await forgetPush();
  clearAllPeopleData();
  lastFailure = null;
  setStatus({ state: 'idle' });
}

/** The both-off branch of changeVisibility: removes the server copy for one conference. */
async function removeFromServer(slug: string, patch: Partial<Visibility>): Promise<string | null> {
  try {
    await runDelete([slug], () => deleteOnServer(slug, false));
  } catch (err) {
    const message = VISIBILITY_DELETE_FAILED[failureKind(err)];
    // The server copy may already be hidden. The user's choice applies on the device and the
    // delete is tried again; until it is done, nothing is written for this conference. After a
    // refusal nothing changed on the server, so the device keeps the earlier state too.
    if (getDeletePending(slug)) setVisibility(slug, patch);
    setStatus({ state: 'error', message });
    return message;
  }
  setVisibility(slug, patch);
  setStatus({ state: 'saved' });
  return null;
}

/**
 * "Delete my profile": deletes the profile on the server for every conference that may hold it
 * and, only once the server has confirmed every one of those deletes, removes the people data
 * from the device, its key included. Returns null on success, else the message for the user.
 */
export function deleteMyProfile(): Promise<string | null> {
  return runDelete(null, async () => {
    const failure = await deleteEach([...new Set([...slugsOnServer(), ...slugsDeletePending()])], true);
    if (failure) return PROFILE_DELETE_FAILED[failure];
    await wipeDevice();
    return null;
  });
}

let retrying: Promise<boolean> | null = null;

/**
 * Tries again every delete the server has not confirmed. When one was part of "Delete my profile"
 * and no conference holds the profile any more, the device's people data goes too. Resolves to
 * true when nothing is left unfinished.
 */
export function finishPendingDeletes(): Promise<boolean> {
  if (retrying) return retrying;
  const pending = slugsDeletePending();
  if (!pending.length) return Promise.resolve(true);
  const wipe = pending.some((slug) => getDeletePending(slug)?.wipe === true);
  const run = runDelete(wipe ? null : pending, async () => {
    const now = slugsDeletePending();
    if (!now.length) return true;
    if (await deleteEach(now, false)) return false;
    if (wipe && !slugsOnServer().length) await wipeDevice();
    return true;
  });
  retrying = run;
  const clear = () => {
    if (retrying === run) retrying = null;
  };
  run.then(clear, clear);
  return run;
}

let retriesStarted = false;

/**
 * Tries unfinished deletes again now, whenever the app comes back to the foreground and whenever
 * the connection comes back. The shell calls it once at start-up.
 */
export function startDeleteRetries(): void {
  if (retriesStarted || typeof window === 'undefined') return;
  retriesStarted = true;
  const retry = () => {
    if (!slugsDeletePending().length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void finishPendingDeletes();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retry();
  });
  window.addEventListener('online', retry);
  retry();
}
