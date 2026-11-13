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

// 23:59:59 on the conference's last day in its own time zone, in milliseconds; with graceDays,
// that many days later (Date.UTC carries the day over into the next month or year).
export function visibleUntilMs(endDate, timeZone, graceDays = 0) {
  const [y, m, d] = String(endDate).split('-').map(Number);
  return wallToInstant(Date.UTC(y, m - 1, d + graceDays, 23, 59, 59), timeZone);
}

// The demo conference (demo: true, invented data) rolls its dates every day, so its last day is
// always tomorrow. Its people, their push subscriptions and their blocks get DEMO_GRACE_DAYS more,
// as on tier 3 (conferenceFor's visibleUntil), so a profile saved on one day of a demonstration
// still exists a few days later instead of running out at the end of tomorrow.
export const DEMO_GRACE_DAYS = 7;

// The end of a conference document's visibility, in milliseconds: visibleUntilMs of its end_date
// in its zone, DEMO_GRACE_DAYS later for the demo conference. Null without an end_date.
export function conferenceVisibleUntilMs(doc) {
  if (!doc?.end_date) return null;
  return visibleUntilMs(doc.end_date, doc.time_zone, doc.demo === true ? DEMO_GRACE_DAYS : 0);
}

function localParts(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

// The start (00:00:00) and end (23:59:59) of the current conference day, in milliseconds.
export function dayBounds(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  return {
    start: wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0), timeZone),
    end: wallToInstant(Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59), timeZone),
  };
}

// YYYY-MM-DD of an instant in the conference's time zone.
export function dayKey(nowMs, timeZone) {
  const { y, m, d } = localParts(nowMs, timeZone);
  return `${y}-${m}-${d}`;
}

// YYYY-MM-DD of an instant in UTC, the day Cloudflare's daily limits count.
export const utcDay = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);
