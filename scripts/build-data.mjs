// Builds data/talks.ndjson from the committed feed snapshot at data/raw/schedule.json.
// Node built-ins only. It never calls the network.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const feed = JSON.parse(readFileSync(join(root, 'data/raw/schedule.json'), 'utf8'));

const SESSION_URL = 'https://kubecon-cloudnativecon-north-america-2026.sessionize.com/session/';
const TIME_ZONE = 'America/Denver';
const SLIDES_CATEGORY_ITEM = 523121;
const SLIDES_QUESTION = 137003;
const NOT_SPECIFIED = 'Not specified';

// Name tables.
const rooms = new Map(feed.rooms.map((r) => [r.id, r.name.trim()]));
const speakers = new Map(
  feed.speakers.map((s) => [s.id, { name: (s.fullName || `${s.firstName} ${s.lastName}`).trim(), tagline: (s.tagLine || '').trim() }])
);

// Category groups. The role of a group is decided from its title.
const itemName = new Map();
const itemRole = new Map();
const unfitGroups = [];
for (const group of feed.categories) {
  let role = null;
  if (/^all sessions$/i.test(group.title.trim())) role = 'track';
  else if (/level/i.test(group.title)) role = 'level';
  else if (/programming|presentation slides/i.test(group.title)) role = 'flags';
  if (!role) unfitGroups.push(group.title);
  for (const item of group.items) {
    itemName.set(item.id, item.name.trim());
    itemRole.set(item.id, role);
  }
}
if (unfitGroups.length) {
  console.error(`Category groups that fit no role: ${unfitGroups.join(', ')}`);
  process.exit(1);
}
if (itemName.get(SLIDES_CATEGORY_ITEM) !== 'Slides Attached') {
  console.error('Category item 523121 is not "Slides Attached".');
  process.exit(1);
}
if (!/presentation slides/i.test(feed.questions.find((q) => q.id === SLIDES_QUESTION)?.question || '')) {
  console.error('Question 137003 is not the presentation slides question.');
  process.exit(1);
}

// Venue-local time handling. The feed gives local times with no offset.
const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' });
function offsetMinutesAt(epochMs) {
  const label = offsetFormat.formatToParts(new Date(epochMs)).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!m) return 0; // Plain "GMT" means a zero offset.
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
function withOffset(local) {
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
}

// kind rules, first match wins:
//   1. housekeeping: no description and the title reads as an opening, closing, welcome, remarks or wrap-up.
//   2. break: no speakers and the title or track is coffee, lunch, breakfast, registration, badge pickup,
//      coat or bag check, snacks or a reception, or the track is Breaks or Registration.
//   3. talk: at least one speaker. An empty description does not change this once rule 1 has passed.
//   4. ambient: no speakers and nothing above matched.
const HOUSEKEEPING_TITLE = /(^|\s)(opening|closing)(\s*\/\s*intro)?(\s+remarks)?\s*$|\bremarks\b|\bwrap-?up\b|^welcome\b/i;
const BREAK_TITLE = /\b(coffee|lunch|breakfast|registration|badge|coat|bag check|snacks?|receptions?)\b/i;
const BREAK_TRACKS = new Set(['Breaks', 'Registration']);
function classify(title, description, speakerCount, track) {
  // Titles such as "Foo Day | SEPARATE REGISTRATION REQUIRED" carry a suffix that must not count as a break word.
  const head = title.split(' | ')[0];
  if (!description && HOUSEKEEPING_TITLE.test(title)) return 'housekeeping';
  if (speakerCount === 0 && (BREAK_TITLE.test(head) || BREAK_TRACKS.has(track))) return 'break';
  if (speakerCount > 0) return 'talk';
  return 'ambient';
}

// sponsor rule: the Sponsor Demo Theater or Sponsor-hosted Co-located Events track, or a title that says
// "sponsored by", "sponsored keynote" or "in-booth demos". Descriptions are not used because many carry
// a boilerplate sentence about sponsored content.
const SPONSOR_TRACKS = new Set(['Sponsor Demo Theater', 'Sponsor-hosted Co-located Events']);
const SPONSOR_TITLE = /\bsponsored (by|keynote)\b|\bin-booth demos?\b/i;

const lines = [];
const missingNames = [];
for (const s of feed.sessions) {
  const title = s.title.trim();
  const abstract = (s.description || '').replace(/\r\n?/g, '\n').trim();

  const names = [];
  const taglines = [];
  for (const id of s.speakers) {
    const sp = speakers.get(id);
    if (!sp) { missingNames.push(`speaker ${id} in session ${s.id}`); continue; }
    names.push(sp.name);
    if (sp.tagline) taglines.push(sp.tagline);
  }

  let room = null;
  if (s.roomId != null) {
    room = rooms.get(s.roomId) ?? null;
    if (room === null) missingNames.push(`room ${s.roomId} in session ${s.id}`);
  }

  const tracks = [];
  const levels = [];
  const flags = [];
  for (const id of s.categoryItems) {
    const name = itemName.get(id);
    if (!name) { missingNames.push(`category item ${id} in session ${s.id}`); continue; }
    const role = itemRole.get(id);
    (role === 'track' ? tracks : role === 'level' ? levels : flags).push(name);
  }
  const track = tracks[0] ?? NOT_SPECIFIED;
  const level = levels[0] ?? NOT_SPECIFIED;

  // Slides: the link comes from the "Presentation Slides" answer and only http or https links count.
  const answer = s.questionAnswers.find((a) => a.questionId === SLIDES_QUESTION);
  const link = answer && typeof answer.answerValue === 'string' ? answer.answerValue.trim() : '';
  const slides_url = /^https?:\/\//i.test(link) ? link : null;
  const has_slides = slides_url !== null;
  // The feed's "Slides Attached" flag lags the uploaded links, so the flag follows has_slides.
  const finalFlags = flags.filter((f) => f !== 'Slides Attached');
  if (has_slides) finalFlags.push('Slides Attached');

  const start = withOffset(s.startsAt);
  const end = withOffset(s.endsAt);

  lines.push(JSON.stringify({
    talk_id: String(s.id),
    kind: classify(title, abstract, names.length, track),
    title,
    abstract,
    speakers: names,
    speaker_taglines: taglines,
    room,
    track,
    level,
    flags: finalFlags,
    sponsor: SPONSOR_TRACKS.has(track) || SPONSOR_TITLE.test(title),
    has_slides,
    slides_url,
    url: SESSION_URL + s.id,
    start: start.iso,
    end: end.iso,
    day: start.day,
    start_minutes: start.minutes,
    end_minutes: end.day === start.day ? end.minutes : end.minutes + 1440
  }));
}

if (missingNames.length) {
  console.error(`Unresolved names: ${missingNames.length}`);
  process.exit(1);
}
writeFileSync(join(root, 'data/talks.ndjson'), lines.join('\n') + '\n');
console.log(`Wrote ${lines.length} documents to data/talks.ndjson`);
