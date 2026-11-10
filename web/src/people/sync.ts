// Writes the device's profile and visibility choices to the server. A document
// is written only while the user is visible conference-wide or shares for a talk;
// when both are off, one write asks the server to delete it.
import { deleteProfile, fetchTopics, PeopleApiError, putProfile, type ProfileBody } from './api';
import { presenceEndedOnServer } from './presence';
import { pushDeletedOnServer } from './push';
import { ensureDevice, getProfile, getVisibility, notify, setProfile, setVisibility, slugsOnServer, topicsFor } from './storage';
import type { Profile, TopicRef, Visibility } from './types';

export const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

export type SyncState = { state: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
let status: SyncState = { state: 'idle' };

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
 * Sends the profile. When the server rejects a topic it no longer offers, that topic is removed
 * from the profile and the write is tried once more, so one retired topic cannot block sharing.
 * When the server answers degraded (it could not embed the text and saved the profile without it
 * for now), one more write of the profile is scheduled for after its one-minute pause.
 */
async function putChecked(slug: string, p: Profile, v: Visibility) {
  retiredNotice = null;
  let res;
  try {
    res = await putProfile(bodyFor(slug, p, v));
  } catch (err) {
    const retired = err instanceof PeopleApiError && err.status === 400 && /_topics contains an unknown topic/.test(err.code ?? '');
    const fixed = retired ? await retireTopics(slug, p) : null;
    if (!fixed) throw err;
    res = await putProfile(bodyFor(slug, fixed, v));
  }
  if (res.degraded?.semantic === true) scheduleDegradedResend();
  return res;
}

/** The server pauses embedding for 60 s after a failure; the re-send waits a little longer. */
const DEGRADED_RESEND_MS = 70_000;
let resendTimer: number | undefined;
let resending = false;

/**
 * Schedules one quiet re-send of the profile to every conference that holds a document, so text
 * the server could not embed gets embedded once it can. Once per degraded answer: a re-send that
 * is answered degraded again does not schedule another (the server also embeds the kept text on
 * this device's next presence write), and a re-send already waiting is not doubled.
 */
function scheduleDegradedResend(): void {
  if (resending || resendTimer !== undefined || typeof window === 'undefined') return;
  resendTimer = window.setTimeout(() => {
    resendTimer = undefined;
    resending = true;
    void resendProfile().finally(() => {
      resending = false;
    });
  }, DEGRADED_RESEND_MS);
}

async function resendProfile(): Promise<void> {
  const p = getProfile();
  if (!p || profileProblem(p)) return;
  for (const slug of slugsOnServer()) {
    try {
      const res = await putChecked(slug, getProfile() ?? p, getVisibility(slug));
      if ((res.hidden_for_owner === true) !== getVisibility(slug).hidden_for_owner) setVisibility(slug, { hidden_for_owner: res.hidden_for_owner === true });
    } catch {
      // Quiet: the next edit or presence write sends the text again.
    }
  }
}

/**
 * Applies a visibility change for one conference and writes it to the server.
 * On failure the local state is left unchanged and the error message is returned.
 */
export async function changeVisibility(slug: string, patch: Partial<Visibility>): Promise<string | null> {
  const current = getVisibility(slug);
  const next = { ...current, ...patch };
  const wantsServer = next.open_to_meet || next.shared_talk_ids.length > 0;
  if (!wantsServer && !current.on_server) {
    setVisibility(slug, { ...patch, on_server: false });
    return null;
  }
  const p = getProfile();
  if (wantsServer) {
    const problem = profileProblem(p);
    if (problem) return problem;
    ensureDevice();
  }
  setStatus({ state: 'saving' });
  try {
    if (!wantsServer) {
      // Both choices are off, so the server copy is removed.
      try {
        await deleteProfile(slug);
      } catch (err) {
        if (!(err instanceof PeopleApiError && err.status === 404)) throw err;
      }
      setVisibility(slug, { ...patch, on_server: false });
      // The server deleted the document with its presence and push subscription.
      presenceEndedOnServer(slug);
      pushDeletedOnServer(slug);
      setStatus({ state: 'saved' });
      return null;
    }
    const res = await putChecked(slug, p as Profile, next);
    setVisibility(slug, {
      ...patch,
      open_to_meet: res.open_to_meet,
      shared_talk_ids: res.shared_talk_ids,
      on_server: res.open_to_meet || res.shared_talk_ids.length > 0,
      hidden_for_owner: res.hidden_for_owner === true,
    });
    // Presence needs conference-wide visibility; the server cleared it with that.
    if (!res.open_to_meet) presenceEndedOnServer(slug);
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
  if (!talkIds.length || !getVisibility(slug).share_new) return Promise.resolve(null);
  return marked ? shareForTalks(slug, talkIds) : unshareTalks(slug, talkIds);
}

let timer: number | undefined;

/** The server's answer to a visible write at a conference that has ended or is gone. */
const closed = (err: unknown) => err instanceof PeopleApiError && err.status === 400 && /^conference (has ended|is not available)/.test(err.code ?? '');

/**
 * Debounces profile edits, then writes them to every conference that holds a document: the one
 * on screen (`current`) first, then each of the others on its own, so one failure cannot hold
 * the rest up. A conference that has ended takes no visible writes any more, so its visibility is
 * turned off on the device and later edits skip it; that is reported only when it is `current`.
 */
export function scheduleProfileSync(current?: string): void {
  window.clearTimeout(timer);
  const slugs = slugsOnServer();
  if (!slugs.length) return;
  setStatus({ state: 'saving' });
  timer = window.setTimeout(async () => {
    const p = getProfile();
    const problem = profileProblem(p);
    if (problem || !p) {
      setStatus({ state: 'error', message: problem ?? undefined });
      return;
    }
    let failure: string | null = null;
    for (const slug of slugsOnServer().sort((a, b) => Number(b === current) - Number(a === current))) {
      try {
        const res = await putChecked(slug, getProfile() ?? p, getVisibility(slug));
        // The server says whether this profile is hidden after reports; the profile screen shows it.
        if ((res.hidden_for_owner === true) !== getVisibility(slug).hidden_for_owner) setVisibility(slug, { hidden_for_owner: res.hidden_for_owner === true });
      } catch (err) {
        if (closed(err)) {
          setVisibility(slug, { on_server: false, open_to_meet: false, shared_talk_ids: [] });
          if (slug !== current) continue;
        }
        failure ??= messageFor(err);
      }
    }
    setStatus(failure ? { state: 'error', message: failure } : { state: 'saved' });
  }, 1000);
}
