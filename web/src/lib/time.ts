// Every time is shown in the conference's own time zone, whatever the device's zone.
// Formatters are cached per zone because Intl.DateTimeFormat is costly to build.

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string, kind: 'day' | 'long' | 'time' | 'ymd' | 'zone' | 'range' | 'hm'): Intl.DateTimeFormat {
  const key = `${timeZone}|${kind}`;
  let f = cache.get(key);
  if (!f) {
    const opts: Record<typeof kind, Intl.DateTimeFormatOptions> = {
      day: { weekday: 'short', month: 'short', day: 'numeric' },
      long: { weekday: 'long', month: 'long', day: 'numeric' },
      time: { hour: 'numeric', minute: '2-digit' },
      ymd: { year: 'numeric', month: '2-digit', day: '2-digit' },
      zone: { hour: 'numeric', timeZoneName: 'short' },
      range: { month: 'short', day: 'numeric' },
      hm: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    };
    f = new Intl.DateTimeFormat(kind === 'ymd' ? 'en-CA' : 'en-US', { timeZone, ...opts[kind] });
    cache.set(key, f);
  }
  return f;
}

/** A conference's zone, or UTC when the feed gave none (only unavailable events lack one). */
export function zoneOf(conference: { time_zone: string | null } | null | undefined): string {
  return conference?.time_zone || 'UTC';
}

// A "YYYY-MM-DD" day value is a local date. Noon UTC on that date is the same
// date in every zone from UTC-11 to UTC+11, so it is formatted in UTC.
function dayDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** "Tue, Nov 10" */
export function formatDay(day: string): string {
  return fmt('UTC', 'day').format(dayDate(day));
}

/** "Tuesday, November 10" */
export function formatDayLong(day: string): string {
  return fmt('UTC', 'long').format(dayDate(day));
}

/** "Nov 9–12, 2026" or "Nov 30 – Dec 2, 2026" for a conference's date range. */
export function formatDateRange(start: string, end: string): string {
  const year = end.slice(0, 4);
  const a = fmt('UTC', 'range').format(dayDate(start));
  if (start === end) return `${a}, ${year}`;
  const b = fmt('UTC', 'range').format(dayDate(end));
  if (start.slice(0, 7) === end.slice(0, 7)) return `${a}–${b.split(' ')[1]}, ${year}`;
  return `${a} – ${b}, ${year}`;
}

/** Local "YYYY-MM-DD" in the given zone for an ISO timestamp. */
export function localDay(iso: string, timeZone: string): string {
  const parts = fmt(timeZone, 'ymd').formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today's local "YYYY-MM-DD" in the conference's zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  return localDay(new Date(now).toISOString(), timeZone);
}

/** Minutes after local midnight in the given zone, for placing a talk on a day's timeline. */
export function minutesInDay(iso: string, timeZone: string): number {
  const parts = fmt(timeZone, 'hm').formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** "9 AM", "12 PM" for an hour of the local day from 0 to 24. */
export function formatHour(hour: number): string {
  const h = hour % 24;
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Intl's short name for the zone at that instant, such as "GMT+3" or "CST". */
export function zoneLabel(iso: string, timeZone: string): string {
  const parts = fmt(timeZone, 'zone').formatToParts(new Date(iso));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

function splitTime(iso: string, timeZone: string): { clock: string; period: string } {
  const parts = fmt(timeZone, 'time').formatToParts(new Date(iso));
  const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
  const clock = parts
    .filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
    .map((p) => p.value)
    .join('')
    .trim();
  return { clock, period };
}

/** "9:00 AM" */
export function formatTime(iso: string, timeZone: string): string {
  return fmt(timeZone, 'time').format(new Date(iso));
}

/** "9:00–9:30 AM" or "11:30 AM–12:15 PM" */
export function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const a = splitTime(startIso, timeZone);
  const b = splitTime(endIso, timeZone);
  if (a.period === b.period) return `${a.clock}–${b.clock} ${b.period}`;
  return `${a.clock} ${a.period}–${b.clock} ${b.period}`;
}

/** "Tue, Nov 10 · 9:00–9:30 AM GMT+3" */
export function formatWhen(startIso: string, endIso: string, timeZone: string): string {
  const day = formatDay(localDay(startIso, timeZone));
  return `${day} · ${formatTimeRange(startIso, endIso, timeZone)} ${zoneLabel(startIso, timeZone)}`;
}

/** True once the talk's end time has passed. */
export function hasEnded(talk: { end: string }, now = Date.now()): boolean {
  return Date.parse(talk.end) <= now;
}
