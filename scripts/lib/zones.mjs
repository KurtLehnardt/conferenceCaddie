// Time zone resolution: Sessionize api/data gives a Windows zone name, which the committed CLDR table
// maps to IANA. An operator override file covers events whose Sessionize site is not published.
// Nothing is ever guessed.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadZoneTables(root) {
  const windows = JSON.parse(readFileSync(join(root, 'data/windows-zones.json'), 'utf8'));
  const overridesPath = join(root, 'data/conference-overrides.json');
  const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
  return { windows, overrides };
}

function validIana(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// apiData is the parsed body of https://{publicSlug}.sessionize.com/api/data, or null.
// Returns { time_zone, time_zone_windows, published, reason, message }. reason is null on success.
export function resolveTimeZone(slug, apiData, { windows, overrides }) {
  const winName = apiData && typeof apiData.timezone === 'string' && apiData.timezone.trim() ? apiData.timezone.trim() : null;
  const published = winName !== null;
  const override = overrides[slug]?.time_zone ?? null;
  const base = { time_zone: null, time_zone_windows: winName, published };

  if (override !== null && !validIana(override)) {
    return { ...base, reason: 'time_zone_unmapped', message: `The override for ${slug} names "${override}", which Intl does not accept as an IANA zone.` };
  }
  if (winName !== null) {
    const iana = windows[winName];
    if (iana && validIana(iana)) return { ...base, time_zone: iana, reason: null, message: null };
    if (override) return { ...base, time_zone: override, reason: null, message: `Windows zone "${winName}" is not in data/windows-zones.json; using the override ${override}.` };
    return {
      ...base,
      reason: 'time_zone_unmapped',
      message:
        `Sessionize gives the Windows zone "${winName}", which is not in data/windows-zones.json. ` +
        `Rebuild the table with "node scripts/build-windows-zones.mjs", or add this entry to data/conference-overrides.json: ` +
        JSON.stringify({ [slug]: { time_zone: '<IANA zone>' } }),
    };
  }
  if (override) return { ...base, time_zone: override, reason: null, message: `Sessionize gives no time zone; using the override ${override}.` };
  return {
    ...base,
    reason: 'time_zone_missing',
    message:
      `Sessionize gives no time zone (the public site is not published). To make the event searchable, an operator adds ` +
      `this entry to data/conference-overrides.json after checking the venue: ` +
      JSON.stringify({ [slug]: { time_zone: '<IANA zone>' } }),
  };
}

// Venue-local times arrive without an offset. The offset in force at that instant comes from Intl.
export function makeLocalTime(timeZone) {
  const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  function offsetMinutesAt(epochMs) {
    const label = offsetFormat.formatToParts(new Date(epochMs)).find((p) => p.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
    if (!m) return 0; // Plain "GMT" means a zero offset.
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }
  return function withOffset(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local);
    if (!m) throw new Error(`Unexpected local time: ${local}`);
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    // Find the offset in force at the real instant. Two passes settle it around changeovers.
    let offset = offsetMinutesAt(asUtc);
    offset = offsetMinutesAt(asUtc - offset * 60000);
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return { iso: `${local}${sign}${hh}:${mm}`, day: local.slice(0, 10), minutes: h * 60 + mi };
  };
}
