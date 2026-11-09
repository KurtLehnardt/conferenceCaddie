// Small helpers shared by the people screens.
import { useEffect, useState } from 'preact/hooks';
import { fetchCircleCounts } from './api';
import type { ConferenceLike, InterestedProp, TalkLike } from './types';

/** Shown once before the first per-talk share, and before "Share for all". */
export const SHARE_NOTICE =
  'Sharing stores your profile on our server until the conference ends. Only people who also shared for this talk can see it, including How to reach me. Everyone else sees only the count. It does not make you visible conference-wide. Turn it off at any time to remove it.';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

/** Renders server text that may hold <mark> tags, without parsing it as HTML. */
export function Marked({ text }: { text: string }) {
  const out = [];
  let marked = false;
  const pieces = text.split(/(<\/?mark>)/);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p === '<mark>') marked = true;
    else if (p === '</mark>') marked = false;
    else if (p) out.push(marked ? <mark key={i}>{decode(p)}</mark> : decode(p));
  }
  return <>{out}</>;
}

/** The talk ids of the Interested list, whatever form the shell passes. */
export function interestedIds(interested: InterestedProp): string[] {
  if (!Array.isArray(interested)) return [];
  return interested.map((t) => (typeof t === 'string' ? t : t.talk_id)).filter(Boolean);
}

export function interestedTalks(interested: InterestedProp): TalkLike[] {
  if (!Array.isArray(interested)) return [];
  return interested.filter((t): t is TalkLike => typeof t === 'object' && !!t && typeof t.talk_id === 'string');
}

function zoneOf(conference: ConferenceLike): string | undefined {
  const tz = conference.time_zone;
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** "Tue, Nov 10 · 9:00 AM" in the conference's own time zone. */
export function formatWhen(conference: ConferenceLike, startIso: string): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOf(conference),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(d)
    .replace(/, (\d+:\d\d)/, ' · $1')
    .replace(/ at /, ' · ');
}

export function hasEnded(talk: { end: string }): boolean {
  const t = Date.parse(talk.end);
  return Number.isFinite(t) && t < Date.now();
}

// Circle counts are fetched in batches: every control asks for its talk, and one
// request per conference goes out a moment later. Results are kept for a minute.
const countCache = new Map<string, { n: number; at: number }>();
const pending = new Map<string, Set<string>>();
const waiters = new Set<() => void>();
let flushTimer: number | undefined;
const COUNT_TTL = 60_000;

function key(slug: string, id: string) {
  return `${slug}\u001f${id}`;
}

function flush() {
  flushTimer = undefined;
  const batches = [...pending.entries()];
  pending.clear();
  for (const [slug, ids] of batches) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      fetchCircleCounts(slug, chunk)
        .then((res) => {
          const now = Date.now();
          chunk.forEach((id) => countCache.set(key(slug, id), { n: res.counts?.[id] ?? 0, at: now }));
          waiters.forEach((fn) => fn());
        })
        .catch(() => {
          // Counts are optional; the control simply shows no count.
        });
    }
  }
}

export function invalidateCount(slug: string, id: string): void {
  countCache.delete(key(slug, id));
  requestCount(slug, id);
}

function requestCount(slug: string, id: string) {
  const set = pending.get(slug) ?? new Set<string>();
  set.add(id);
  pending.set(slug, set);
  if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 60);
}

/** The number of people sharing for a talk, or null while unknown. */
export function useCircleCount(slug: string, talkId: string, known?: number): number | null {
  const read = () => {
    const c = countCache.get(key(slug, talkId));
    return c ? c.n : (known ?? null);
  };
  const [n, setN] = useState<number | null>(read);
  useEffect(() => {
    const c = countCache.get(key(slug, talkId));
    if (!c || Date.now() - c.at > COUNT_TTL) {
      if (known !== undefined && !c) countCache.set(key(slug, talkId), { n: known, at: Date.now() });
      else requestCount(slug, talkId);
    }
    setN(read());
    const fn = () => setN(read());
    waiters.add(fn);
    return () => {
      waiters.delete(fn);
    };
  }, [slug, talkId]);
  return n;
}

export function peopleCountLabel(n: number): string {
  return n === 1 ? '1 person wants to talk about this' : `${n} people want to talk about this`;
}
