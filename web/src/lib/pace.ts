// Request pacing. The API reports how close it is to its daily request budget in an
// `X-Caddie-Pace` header (1 to 10, where 1 is normal). Every poll interval is multiplied by it, so
// the app slows its background requests down before the daily cap is reached. Calls the person
// makes themselves are never delayed. The value decays back to 1 after 30 minutes without news.

const MIN_PACE = 1;
const MAX_PACE = 10;
const DECAY_MS = 30 * 60_000;

let pace = MIN_PACE;
let seenAt = 0;

/** Reads the pace from an API response. A missing or malformed header changes nothing. */
export function notePace(res: Response): void {
  const raw = res.headers.get('X-Caddie-Pace');
  if (raw === null) return;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return;
  pace = Math.min(MAX_PACE, Math.max(MIN_PACE, value));
  seenAt = Date.now();
}

/** The pace now: the latest reported value, or 1 once it is older than 30 minutes. */
export function currentPace(): number {
  if (pace !== MIN_PACE && Date.now() - seenAt > DECAY_MS) pace = MIN_PACE;
  return pace;
}

/** A poll interval stretched by the pace. */
export function pacedMs(ms: number): number {
  return Math.round(ms * currentPace());
}

/** The open-meet poll is stretched by at most 3, because a live meet is time-sensitive. */
export function pacedMeetMs(ms: number): number {
  return Math.round(ms * Math.min(currentPace(), 3));
}

function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** When a daily cap lifts, from a Retry-After header (seconds or a date), else the next 00:00 UTC. */
function resumeAt(retryAfter: string | null): Date {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return new Date(Date.now() + secs * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > Date.now()) return new Date(date);
  }
  return new Date(nextUtcMidnight());
}

/** The sentence shown when the API answers 503 with `error: 'daily_limit'`. */
export function pausedMessage(retryAfter: string | null, what = 'People features'): string {
  const time = resumeAt(retryAfter).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${what} are paused until ${time}. Saved schedules still work offline.`;
}

/** True when a response is the API's daily-limit answer. Reads a clone, so the body stays usable. */
export async function isDailyLimit(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return body?.error === 'daily_limit';
  } catch {
    return false;
  }
}
