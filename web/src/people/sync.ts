// Writes the device's profile and visibility choices to the server. A document
// is written only while the user is visible conference-wide or shares for a talk;
// when both are off, one write asks the server to delete it.
import { deleteProfile, PeopleApiError, putProfile, type ProfileBody } from './api';
import { ensureDevice, getProfile, getVisibility, notify, setVisibility, slugsOnServer, topicsFor } from './storage';
import type { Profile, Visibility } from './types';

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

function messageFor(err: unknown): string {
  if (err instanceof PeopleApiError) {
    if (err.status === 400) return 'That could not be saved. Check your details and try again.';
    return err.message;
  }
  return 'That could not be saved. Please try again.';
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
      setStatus({ state: 'saved' });
      return null;
    }
    const res = await putProfile(bodyFor(slug, p as Profile, next));
    setVisibility(slug, {
      ...patch,
      open_to_meet: res.open_to_meet,
      shared_talk_ids: res.shared_talk_ids,
      on_server: res.open_to_meet || res.shared_talk_ids.length > 0,
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
  return { ok: true, message: cut ? CUT_MESSAGE : null };
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

/** Debounces profile edits, then writes them to every conference that holds a document. */
export function scheduleProfileSync(): void {
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
    try {
      for (const slug of slugsOnServer()) {
        await putProfile(bodyFor(slug, p, getVisibility(slug)));
      }
      setStatus({ state: 'saved' });
    } catch (err) {
      setStatus({ state: 'error', message: messageFor(err) });
    }
  }, 1000);
}
