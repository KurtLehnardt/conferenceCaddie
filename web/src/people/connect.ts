// Find & connect state shared across screens: the inbox poll, what this device has asked,
// which people it has seen (for the opener and about after a meet), and the block action.
import { useEffect } from 'preact/hooks';
import { blockPerson, errorField, fetchInbox, isAbort, PeopleApiError, unblockPerson } from './api';
import { nudgeTick } from './nudges';
import { addBlock, getPresence, isBlocked, notify, removeBlock, usePeopleStore } from './storage';
import type { Inbox, InboxIncoming, InboxOutgoing, MeetState, PersonResult } from './types';
import { confirm, toast } from './ui';

export const INBOX_POLL_MS = 20_000;

/** States that still wait for something to happen. Asks are now-only, so accept goes straight to active. */
export const OPEN_STATES: MeetState[] = ['requested', 'active'];

let inboxSlug: string | null = null;
let inbox: Inbox = { incoming: [], outgoing: [] };
let inboxLoaded = false;
/** An ask runs out 15 minutes after it was made, so a note of one is never kept longer. */
const ASKED_MAX_MS = 15 * 60_000;
// Requests this device just sent (or its own open meet a 409 meet_open named), by ref, so a card
// says "No reply yet" until the next poll, whose list then decides: the card follows an open
// request of ours the server lists, and with none there is nothing to wait for.
const asked = new Map<string, { meetId: string; at: number }>();
// meet_id -> ref of the other person, from the inbox and from requests sent here.
const meetRefs = new Map<string, string>();
// People this device has seen, by ref: the match card (opener, reasons) or the inbox card (about).
const seen = new Map<string, { display_name: string; about: string | null; opener: string | null; reasons: string[] }>();

export function rememberPerson(p: PersonResult): void {
  seen.set(p.ref, { display_name: p.display_name, about: p.about, opener: p.opener || null, reasons: p.reasons ?? [] });
}

export function rememberIncoming(r: InboxIncoming): void {
  const prev = seen.get(r.from.ref);
  seen.set(r.from.ref, {
    display_name: r.from.display_name,
    about: r.from.about ?? prev?.about ?? null,
    opener: prev?.opener ?? null,
    reasons: prev?.reasons ?? [],
  });
}

export function personForMeet(meetId: string) {
  const ref = meetRefs.get(meetId);
  return ref ? (seen.get(ref) ?? null) : null;
}

export function noteSentRequest(slug: string, ref: string, meetId: string): void {
  if (inboxSlug !== slug) resetInbox(slug);
  meetRefs.set(meetId, ref);
  // A 409 that names their ask to me: it waits in my inbox for my answer, not for theirs.
  if (!inbox.incoming.some((r) => r.meet_id === meetId)) asked.set(ref, { meetId, at: Date.now() });
  notify();
}

/** The meet_id a 409 meet_open names: the meet already open between the two people. */
export function openMeetId(err: unknown): string | null {
  if (!(err instanceof PeopleApiError) || err.status !== 409 || err.code !== 'meet_open') return null;
  return errorField(err, 'meet_id');
}

function resetInbox(slug: string) {
  inboxSlug = slug;
  inbox = { incoming: [], outgoing: [] };
  inboxLoaded = false;
  asked.clear();
}

export function getInbox(slug: string): Inbox & { loaded: boolean } {
  if (inboxSlug !== slug) return { incoming: [], outgoing: [], loaded: false };
  return {
    incoming: inbox.incoming.filter((r) => !isBlocked(slug, r.from.ref)),
    outgoing: inbox.outgoing.filter((r) => !isBlocked(slug, r.to.ref)),
    loaded: inboxLoaded,
  };
}

/** Incoming requests waiting for an answer: the badge count. */
export function inboxCount(slug: string): number {
  return getInbox(slug).incoming.filter((r) => r.state === 'requested').length;
}

/** The state of this device's open request to one person, or null. */
export function requestTo(slug: string, ref: string): MeetState | null {
  const out = getInbox(slug).outgoing.find((r) => r.to.ref === ref && OPEN_STATES.includes(r.state));
  if (out) return out.state;
  const a = asked.get(ref);
  return a && Date.now() - a.at <= ASKED_MAX_MS ? 'requested' : null;
}

export function outgoingTo(slug: string, ref: string): InboxOutgoing | null {
  return getInbox(slug).outgoing.find((r) => r.to.ref === ref && OPEN_STATES.includes(r.state)) ?? null;
}

let inflight: AbortController | null = null;

/** Fetches the inbox once. Errors are kept quiet: the next poll tries again. */
export async function refreshInbox(slug: string): Promise<void> {
  if (inboxSlug !== slug) resetInbox(slug);
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  const startedAt = Date.now();
  try {
    const res = await fetchInbox(slug, ctl.signal);
    if (ctl.signal.aborted || inboxSlug !== slug) return;
    inbox = { incoming: res.incoming ?? [], outgoing: res.outgoing ?? [] };
    inboxLoaded = true;
    for (const r of inbox.incoming) {
      meetRefs.set(r.meet_id, r.from.ref);
      rememberIncoming(r);
    }
    for (const r of inbox.outgoing) meetRefs.set(r.meet_id, r.to.ref);
    // The server's list decides now: an open request of ours is in `outgoing` and the card follows
    // it; otherwise it is over (or it was their ask), so nothing waits. A note made after this
    // poll set out stays until the next one, which is sure to see it.
    for (const [ref, a] of asked) if (a.at < startedAt) asked.delete(ref);
    notify();
  } catch (err) {
    if (isAbort(err)) return;
    // No device, or no profile at this conference any more: there is nothing to ask about.
    if (err instanceof PeopleApiError && (err.code === 'no_device' || err.code === 'profile_required')) {
      inbox = { incoming: [], outgoing: [] };
      inboxLoaded = true;
      asked.clear();
      notify();
    }
  }
}

/** Removes one request from the local inbox right away, before the next poll confirms it. */
export function dropIncoming(slug: string, meetId: string): void {
  if (inboxSlug !== slug) return;
  inbox = { ...inbox, incoming: inbox.incoming.filter((r) => r.meet_id !== meetId) };
  // A wave that met this open request (409 meet_open) waits for nothing any more.
  for (const [ref, a] of asked) if (a.meetId === meetId) asked.delete(ref);
  notify();
}

export function setIncomingState(slug: string, meetId: string, state: MeetState): void {
  if (inboxSlug !== slug) return;
  inbox = { ...inbox, incoming: inbox.incoming.map((r) => (r.meet_id === meetId ? { ...r, state } : r)) };
  for (const [ref, a] of asked) if (a.meetId === meetId) asked.delete(ref);
  notify();
}

/**
 * Polls the inbox every 20 s while the app is visible and presence is on or a request of ours is
 * open. One fetch runs when the watch starts (and whenever `always` is on, as on the inbox screen),
 * so the device learns about its open requests at all.
 */
export function useInboxWatch(slug: string | null, always = false): void {
  usePeopleStore();
  const open = slug ? getPresence(slug).on || getInbox(slug).outgoing.some((r) => OPEN_STATES.includes(r.state)) || asked.size > 0 : false;
  const active = !!slug && (always || open);
  useEffect(() => {
    if (!slug) return;
    void refreshInbox(slug);
  }, [slug]);
  useEffect(() => {
    if (!slug || !active) return;
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState !== 'hidden') {
        void refreshInbox(slug);
        void nudgeTick(slug);
      }
      timer = window.setTimeout(tick, INBOX_POLL_MS);
    };
    timer = window.setTimeout(tick, INBOX_POLL_MS);
    const onVis = () => {
      if (document.visibilityState !== 'hidden') void refreshInbox(slug);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [slug, active]);
}

/** Re-renders when the inbox changes; returns the badge count. */
export function useInboxCount(slug: string | null): number {
  usePeopleStore();
  return slug ? inboxCount(slug) : 0;
}

/* ---------- "Find people who've done this" ---------- */

let pendingSearch: string | null = null;

/** Hands a topic label to the People tab, which runs the search with it when it opens. */
export function setPendingSearch(text: string): void {
  pendingSearch = text.slice(0, 300);
}

export function takePendingSearch(): string | null {
  const t = pendingSearch;
  pendingSearch = null;
  return t;
}

/* ---------- Block ---------- */

export const BLOCK_BODY =
  "You won't see each other in matches, talk circles or requests, and neither of you can ask the other to talk shop. They are not told.";

/**
 * Asks for confirmation, then blocks. Symmetric and silent on the server; here the person is
 * dropped from every list at once through the blocks cache.
 */
export function blockWithConfirm(slug: string, person: { ref: string; display_name: string }, after?: () => void): void {
  confirm({
    title: `Block ${person.display_name}?`,
    body: BLOCK_BODY,
    confirmLabel: 'Block',
    onConfirm: () => {
      addBlock(slug, person.ref, person.display_name);
      after?.();
      blockPerson(slug, person.ref)
        .then(() => {
          toast(`Blocked ${person.display_name}`, {
            label: 'Undo',
            onClick: () => void unblock(slug, person.ref, person.display_name),
          });
        })
        .catch((err) => {
          removeBlock(slug, person.ref);
          toast(err instanceof PeopleApiError ? err.message : 'That could not be saved. Please try again.');
        });
    },
  });
}

export async function unblock(slug: string, ref: string, name: string | null): Promise<string | null> {
  try {
    await unblockPerson(slug, ref);
    removeBlock(slug, ref);
    toast(name ? `Unblocked ${name}` : 'Unblocked');
    return null;
  } catch (err) {
    if (err instanceof PeopleApiError && err.status === 404) {
      removeBlock(slug, ref);
      return null;
    }
    return err instanceof PeopleApiError ? err.message : 'That could not be saved. Please try again.';
  }
}

/** A list without the people this device has blocked. Callers that render it use usePeopleStore. */
export function withoutBlocked<T extends { ref: string }>(slug: string, people: T[]): T[] {
  return people.filter((p) => !isBlocked(slug, p.ref));
}
