// Conference-local time helpers, ported from server/people.mjs and server/nudge.mjs. A conference
// without a time zone uses UTC-12, the last place on earth where a given day ends.

// The offset of a time zone from UTC at an instant, in milliseconds.
export function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// The instant at which a wall-clock reading (given as a UTC timestamp of the same digits) occurs
// in a time zone.
export function wallToInstant(wall, timeZone) {
  if (!timeZone) return wall + 12 * 3600_000;
  const t = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(t, timeZone);
}

// 23:59:59 on the conference's last day in its own time zone, in milliseconds.
export function visibleUntilMs(endDate, timeZone) {
  const [y, m, d] = String(endDate).split('-').map(Number);
  return wallToInstant(Date.UTC(y, m - 1, d, 23, 59, 59), timeZone);
}

function localParts(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

// The start (00:00:00) and end (23:59:59) of the current conference day, in milliseconds. The end
// is 23:59:59.000, so from then until midnight it is already behind nowMs (see dayEndAfter).
export function dayBounds(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  return {
    start: wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0), timeZone),
    end: wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59), timeZone),
  };
}

// The end (23:59:59) of the conference day for a presence with until: 'day', in milliseconds:
// today's, or tomorrow's once today's has passed. Today's end is 23:59:59.000, so from then until
// midnight it is not after nowMs, and a presence that ended there would be over before it was
// written; it runs to the end of the next day instead, as it does from 00:00:00 on. That is the
// last second of a day, and where daylight saving time ends at midnight west of UTC (such as
// America/Santiago) the whole repeated last hour, because today's 23:59:59 reads as its first
// pass. The result is always after nowMs. Date.UTC carries day + 1 over a month end.
// The same rule as server/people-shared.mjs.
export function dayEndAfter(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  const today = wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59), timeZone);
  return today > nowMs ? today : wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1, 23, 59, 59), timeZone);
}

// The first instant of the next conference day (midnight at the end of the current one), when the
// "Not now" count starts again, in milliseconds. Normally one second after dayBounds' end. Where
// daylight saving time ends at midnight west of UTC (America/Santiago), that end is the first pass
// of a repeated last hour, and where it starts at midnight the next day's 00:00 does not exist and
// reads an hour early; the later of the two readings is midnight in either case. The same rule as
// server/people-shared.mjs.
export function nextDayStart(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  return Math.max(
    wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59), timeZone) + 1000,
    wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1, 0, 0, 0), timeZone),
  );
}

// YYYY-MM-DD of an instant in the conference's time zone.
export function dayKey(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  return `${y}-${m}-${d}`;
}

// YYYY-MM-DD of an instant in UTC, the day Cloudflare's daily limits count.
export const utcDay = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);
