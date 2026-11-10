// Regenerates the table of US-English time zone abbreviations in
// shared/src/commonMain/kotlin/app/conferencecaddie/shared/bundle/TalkTime.kt, between its
// "BEGIN GENERATED ZONES" and "END GENERATED ZONES" lines, from what Node's Intl prints.
//
// Usage, from the repository root (any Node with full ICU, which is the default build):
//   node native/shared/scripts/generate-zone-names.mjs
//
// The web app writes a talk's zone with Intl's `timeZoneName: 'short'` in en-US. That prints an
// abbreviation (EST, PDT, AKST...) only for the zones that US English names; every other zone is
// "GMT", "GMT+1" or "GMT+5:30", which TalkTime derives from the talk's offset. So the table lists
// only the zones that print an abbreviation in January or July: the standard name, the daylight
// name (null when the zone keeps one name all year) and the standard offset in minutes, which is
// the smaller of the two offsets.
//
// Zone names come from Intl's canonical list and, where the system has one, /usr/share/zoneinfo,
// which adds the aliases (US/Eastern, America/Indiana/Indianapolis...) that a bundle may carry.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/commonMain/kotlin/app/conferencecaddie/shared/bundle/TalkTime.kt');
const BEGIN = '        // BEGIN GENERATED ZONES';
const END = '        // END GENERATED ZONES';

function systemZones(dir = '/usr/share/zoneinfo', prefix = '') {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (prefix === '' && (name === 'posix' || name === 'right' || name === 'Etc')) continue;
    if (!/^[A-Z]/.test(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...systemZones(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function part(tz, date, style) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value;
}

function offsetMinutes(tz, date) {
  const s = part(tz, date, 'longOffset');
  if (s === 'GMT') return 0;
  const m = s.match(/^GMT([+-])(\d\d):(\d\d)$/);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const GMT_FORM = /^(GMT|UTC)([+-]\d{1,2}(:\d\d)?)?$/;
const samples = [new Date(Date.UTC(2026, 0, 15, 12)), new Date(Date.UTC(2026, 6, 15, 12))];
const zones = [...new Set([...Intl.supportedValuesOf('timeZone'), ...systemZones()])].sort();
const rows = [];
for (const tz of zones) {
  let seen;
  try {
    seen = samples.map((d) => ({ name: part(tz, d, 'short'), offset: offsetMinutes(tz, d) }));
  } catch {
    continue; // A file Intl does not know as a zone.
  }
  if (seen.every((s) => GMT_FORM.test(s.name))) continue;
  seen.sort((a, b) => a.offset - b.offset);
  const [standard, other] = seen;
  const daylight = other.name === standard.name ? null : other.name;
  rows.push(`        "${tz}" to Triple("${standard.name}", ${daylight ? `"${daylight}"` : 'null'}, ${standard.offset}),`);
}

const source = readFileSync(OUT, 'utf8');
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start < 0 || end < start) throw new Error(`markers not found in ${OUT}`);
const generated = `${BEGIN} (node ${process.version}, ICU ${process.versions.icu}, tz ${process.versions.tz})\n${rows.join('\n')}\n`;
writeFileSync(OUT, source.slice(0, start) + generated + source.slice(end));
console.log(`${rows.length} zones written to ${path.relative(process.cwd(), OUT)}`);
