// Nudges, in-app only, zero-fatigue (Find & connect, "Then"). While presence is on, the inbox
// poll's tick asks once for the people around now and shows one banner on the People tab when
// either a specific match stands in my own zone ("Someone who's worked on {evidence} is in {zone}
// right now") or someone I'm watching is around anywhere ("{display_name} is around in {zone}
// now"). Once per person per day, on this device (caddie.nudged.v1.{slug}); broad matches never
// nudge by themselves; nothing shows while presence or the setting is off. The banner lives here,
// not in a component, so it survives moving between tabs until it is dismissed or tapped.
import { fetchMatches, isAbort, MATCH_PAGE } from './api';
import { getPresence, getVisibility, isBlocked, notify, usePeopleStore } from './storage';
import type { PersonResult } from './types';
import { getWatches } from './watch';

const NUDGED_PREFIX = 'caddie.nudged.v1.';
const SETTING_PREFIX = 'caddie.nudges.v1.';
/** The evidence is cut at a word boundary around this length, so the banner stays one thought. */
const EVIDENCE_MAX = 80;

export const NUDGE_SETTING_LABEL = "Nudge me when a strong match or someone I'm watching is around";

export interface Nudge {
  slug: string;
  ref: string;
  zone: string;
  /** The full banner sentence, built once so it never changes under the reader. */
  text: string;
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

/* ---------- Setting ---------- */

const settingMem = new Map<string, boolean>();

/** Whether nudges are wanted at this conference. On by default. */
export function nudgesEnabled(slug: string): boolean {
  let on = settingMem.get(slug);
  if (on === undefined) {
    const raw = read<{ on?: unknown }>(SETTING_PREFIX + slug);
    on = raw?.on !== false;
    settingMem.set(slug, on);
  }
  return on;
}

export function setNudgesEnabled(slug: string, on: boolean): void {
  settingMem.set(slug, on);
  write(SETTING_PREFIX + slug, { on });
  if (!on && current?.slug === slug) current = null;
  notify();
}

/* ---------- Once per person per day ---------- */

type Nudged = Record<string, string>;
const nudgedMem = new Map<string, Nudged>();

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nudgedToday(slug: string): Nudged {
  let m = nudgedMem.get(slug);
  if (!m) {
    const raw = read<unknown>(NUDGED_PREFIX + slug);
    m = {};
    if (raw && typeof raw === 'object') {
      for (const [ref, date] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof date === 'string') m[ref] = date;
      }
    }
    nudgedMem.set(slug, m);
  }
  return m;
}

function wasNudgedToday(slug: string, ref: string): boolean {
  return nudgedToday(slug)[ref] === today();
}

function recordNudge(slug: string, ref: string): void {
  const day = today();
  // Older days are of no further use, so the map holds today's entries only.
  const next: Nudged = {};
  for (const [r, d] of Object.entries(nudgedToday(slug))) if (d === day) next[r] = d;
  next[ref] = day;
  nudgedMem.set(slug, next);
  write(NUDGED_PREFIX + slug, next);
}

/* ---------- The one banner ---------- */

let current: Nudge | null = null;
// The person whose card "See who" should land on, once the Around now list has loaded.
let reveal: { slug: string; ref: string } | null = null;

/** The evidence as plain words: <mark> tags gone, entities decoded, whitespace collapsed. */
function plainText(s: string): string {
  return s
    .replace(/<\/?mark>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (w, b: string) =>
      b === 'amp' ? '&' : b === 'lt' ? '<' : b === 'gt' ? '>' : b === 'quot' ? '"' : b === 'apos' ? "'" : b === 'nbsp' ? ' ' : w,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortens the evidence at a word boundary; no name, no distance, nothing else. */
export function evidenceFor(p: PersonResult): string | null {
  // A trailing full stop would land mid-sentence in the banner, so it goes.
  const text = p.evidence ? plainText(p.evidence).replace(/[.;,:]+$/, '') : '';
  if (text) {
    if (text.length <= EVIDENCE_MAX) return text;
    const cut = text.slice(0, EVIDENCE_MAX + 1).replace(/\s+\S*$/, '').trim();
    return `${cut || text.slice(0, EVIDENCE_MAX).trim()}…`;
  }
  return p.speak_topics?.[0]?.label ?? null;
}

export function nudgeText(evidence: string, zone: string): string {
  return `Someone who's worked on ${evidence} is in ${zone} right now`;
}

export function watchText(name: string, zone: string): string {
  return `${name} is around in ${zone} now`;
}

/** The banner to show for this conference, or null. Nothing shows while presence is off. */
export function currentNudge(slug: string): Nudge | null {
  if (!current || current.slug !== slug) return null;
  if (!nudgesEnabled(slug) || !getPresence(slug).on) return null;
  return current;
}

export function dismissNudge(): void {
  current = null;
  notify();
}

/** "See who": closes the banner and asks the People tab to show that person's card. */
export function seeWho(nudge: Nudge): void {
  reveal = { slug: nudge.slug, ref: nudge.ref };
  current = null;
  notify();
  if (!/^#\/(people|here)\b/.test(location.hash)) location.hash = '#/people';
}

export function pendingReveal(slug: string): string | null {
  return reveal && reveal.slug === slug ? reveal.ref : null;
}

/**
 * Scrolls to and highlights the card of the person "See who" asked for, among the cards rendered
 * in `list` in the order of `people`. The request is consumed either way, so a person who has
 * left the list does not get highlighted later by surprise.
 */
export function revealIn(slug: string, list: HTMLElement | null, people: PersonResult[]): void {
  const ref = pendingReveal(slug);
  if (!ref) return;
  reveal = null;
  const index = people.findIndex((p) => p.ref === ref);
  const card = index >= 0 ? list?.querySelectorAll<HTMLElement>(':scope > .pp-person')[index] : undefined;
  if (!card) {
    notify();
    return;
  }
  card.classList.add('pp-person-revealed');
  window.setTimeout(() => card.classList.remove('pp-person-revealed'), 4000);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  notify();
}

/** Re-renders when the banner or the reveal request changes. */
export function useNudges(slug: string): { nudge: Nudge | null; reveal: string | null } {
  usePeopleStore();
  return { nudge: currentNudge(slug), reveal: pendingReveal(slug) };
}

/* ---------- The check, piggy-backed on the inbox poll ---------- */

let inflight: AbortController | null = null;

/** Drops the banner, the reveal request and the in-memory records, for "Delete my profile". */
export function resetNudges(): void {
  inflight?.abort();
  inflight = null;
  current = null;
  reveal = null;
  settingMem.clear();
  nudgedMem.clear();
  notify();
}

/**
 * One `around_now` request on each poll tick while presence is on and nudges are wanted. The
 * first specific match in my zone that has not been nudged today becomes the banner. Errors are
 * kept quiet: the next tick tries again.
 */
export async function nudgeTick(slug: string): Promise<void> {
  const presence = getPresence(slug);
  if (!presence.on || !presence.zone) {
    if (current?.slug === slug) dismissNudge();
    return;
  }
  if (!nudgesEnabled(slug) || !getVisibility(slug).open_to_meet) return;
  // One banner at a time: while one waits to be read, nothing else is asked for.
  if (current?.slug === slug) return;
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  try {
    const res = await fetchMatches(slug, [], ctl.signal, { when: 'around_now', size: MATCH_PAGE });
    if (ctl.signal.aborted) return;
    const now = getPresence(slug);
    if (!now.on || !now.zone || current || !nudgesEnabled(slug)) return;
    const results = (res.results ?? []).filter((p) => !isBlocked(slug, p.ref) && !wasNudgedToday(slug, p.ref));
    const show = (p: PersonResult, zone: string, text: string) => {
      recordNudge(slug, p.ref);
      current = { slug, ref: p.ref, zone, text };
      notify();
    };
    // 1. A specific match in my own zone.
    for (const p of results) {
      if (p.broad === true || !p.zone || p.zone !== now.zone) continue;
      const evidence = evidenceFor(p);
      if (!evidence) continue;
      return show(p, now.zone, nudgeText(evidence, now.zone));
    }
    // 2. Someone I'm watching, in any zone, broad or not. The watch itself stays: they decide.
    const watched = new Set(getWatches(slug).map((w) => w.ref));
    for (const p of results) {
      if (!watched.has(p.ref) || !p.zone) continue;
      return show(p, p.zone, watchText(p.display_name, p.zone));
    }
  } catch (err) {
    if (isAbort(err)) return;
    // Offline, rate-limited or not visible any more: quiet, like the inbox poll.
  }
}
