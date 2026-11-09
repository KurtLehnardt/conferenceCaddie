// Every time is shown in venue time (America/Denver), whatever the device's zone.
const TZ = 'America/Denver';

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const longDayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
});

// A "YYYY-MM-DD" day value is a venue-local date. Noon UTC on that date is
// still the same date in Denver, so formatting it there is safe.
function dayDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** "Tue, Nov 10" */
export function formatDay(day: string): string {
  return dayFmt.format(dayDate(day));
}

/** "Tuesday, November 10" */
export function formatDayLong(day: string): string {
  return longDayFmt.format(dayDate(day));
}

/** Venue-local "YYYY-MM-DD" for an ISO timestamp. */
export function venueDay(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function splitTime(iso: string): { clock: string; period: string } {
  const parts = timeFmt.formatToParts(new Date(iso));
  const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
  const clock = parts
    .filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
    .map((p) => p.value)
    .join('')
    .trim();
  return { clock, period };
}

/** "9:00–9:30 AM" or "11:30 AM–12:15 PM" */
export function formatTimeRange(startIso: string, endIso: string): string {
  const a = splitTime(startIso);
  const b = splitTime(endIso);
  if (a.period === b.period) return `${a.clock}–${b.clock} ${b.period}`;
  return `${a.clock} ${a.period}–${b.clock} ${b.period}`;
}

/** "Tue, Nov 10 · 9:00–9:30 AM MT" */
export function formatWhen(startIso: string, endIso: string): string {
  return `${formatDay(venueDay(startIso))} · ${formatTimeRange(startIso, endIso)} MT`;
}

export function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}
