// POST /api/import/schedule: finds one conference's talks in a personal schedule that an attendee
// exported from anywhere, so the app can offer to mark them as Interested on the device.
//
// Body: { event, filename?, mime?, content_base64 } for a file, or { event, text, filename?, mime? }
// for pasted or browser-extracted text, as the Worker accepts it. With text, filename and mime are
// format hints only: they help choose CSV, TSV, iCalendar or plain text and never cause anything to
// be fetched or decoded. Unknown keys get 400, and so do both or neither of content_base64 and text. A file may hold at most 5 MB once decoded; a larger body gets 413.
// Response: { matched: [ { talk, confidence, matched_text_excerpt } ], unmatched_count,
// extracted_chars }. talk has the search result shape; matched_text_excerpt is a short piece of
// the requester's own file and goes back only to them.
//
// Bounds: the text is read line by line, never split into one array. Each line, CSV cell and
// iCalendar property is cut to MAX_LINE (1,000) characters before any regular expression runs;
// plain text and iCalendar stop after MAX_LINES lines, CSV after MAX_CSV_ROWS rows or
// MAX_CSV_CELLS cells, and every parser stops once it holds MAX_ENTRIES entries.
//
// Privacy: the upload lives in memory for this one request. Nothing is stored, indexed or logged.
// The request log line holds only the method, path, status and duration, and an error line holds
// only a status code.
//
// Elasticsearch does the work:
// - Extraction. A PDF, or a Word, OpenDocument or RTF file, is sent to the attachment ingest
//   processor (Apache Tika) through POST _ingest/pipeline/_simulate with an inline pipeline, so
//   nothing is indexed. iCalendar, CSV, JSON and plain text are UTF-8 and are split here.
// - Matching. The text is split into title-like candidate lines. One _msearch runs one search per
//   candidate over the conference's kind:talk documents. Each search is a bool of named queries:
//     exact_title  match_phrase on title (sent only for candidates with at least three content words)
//     title_words  match on title with minimum_should_match "3<75%"
//     speaker      match on speakers with the candidate's nearby speaker text, two words minimum
//     time         a start-time range, when the file gave a date and time for the candidate
//   A hit must match exact_title or title_words. The confidence label is read from the hit's
//   matched_queries. Elasticsearch's top hit is kept for each candidate, then the highest-scoring
//   hit for each talk. The server never scores or re-ranks anything itself.

import { esRequest, topicLabels, toResult, UpstreamError } from './search.mjs';
import { conferencePreference } from './preference.mjs';
import { searchableConference } from './conferences.mjs';
import { sendJson, sameOrigin, isPlainObject, validEvent, BadRequest } from './recommend.mjs';
import { take, clientIp } from './ratelimit.mjs';

const ES_INDEX = process.env.ES_INDEX || 'caddie-talks';

const MAX_DECODED = 5 * 1024 * 1024; // 5 MB of file bytes
const MAX_BODY = 7_200_000; // the base64 of 5 MB is 6,990,508 characters, plus the other keys
const MAX_TEXT = 200_000; // pasted characters
const INDEXED_CHARS = 200_000; // characters Tika may return
const MAX_CANDIDATES = 300;
const MAX_ENTRIES = 3000;
const MAX_CSV_ROWS = 5000;
const MAX_CSV_CELLS = 100_000;
// Characters read from one line, CSV cell or iCalendar property. Everything after is ignored, so
// every regular expression below runs on bounded input. A schedule title is far shorter.
const MAX_LINE = 1000;
// An item of plain text merges at most four lines.
const MAX_ITEM = 4 * (MAX_LINE + 1);
// Lines read from plain text or iCalendar. A whole conference's .ics with descriptions has a few
// tens of thousands; this bounds the time one 5 MB file of short lines can hold the event loop.
const MAX_LINES = 100_000;
const TITLE_MAX = 300;
const EXCERPT_MAX = 160;
const CONTEXT_MAX = 300;
const PER_MIN = 10;
// Each import holds the upload in memory several times over (body, bytes, request to
// Elasticsearch), so an instance runs only a few at once.
const MAX_ACTIVE = 4;
const TIKA_TIMEOUT_MS = 15_000;
const MSEARCH_TIMEOUT_MS = 10_000;

const SOURCE_FIELDS = ['talk_id', 'conference', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'topics', 'speaker_profiles', 'slides_url', 'url'];
const KEYS = new Set(['event', 'filename', 'mime', 'content_base64', 'text']);

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TOO_LARGE = 'That file is larger than 5 MB. Export a shorter schedule, or paste its text instead.';
const UNSUPPORTED = 'That file type is not supported. Use a PDF, CSV, plain text, calendar (.ics) or JSON file.';
const UNREADABLE = 'No text could be read from that file. If it is a scanned or password-protected PDF, export the schedule as text or CSV instead.';

// ---------------------------------------------------------------------------------------------
// Body reading with this route's own size limit. An oversized body is answered at once with 413
// and the rest of the upload is read and discarded, so the client always receives the answer.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new ImportError(413, TOO_LARGE);
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        reject(new ImportError(400, 'Could not read the request body'));
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Validation and type sniffing. The content decides the type; the file name and type only help
// tell CSV from plain text.

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

async function validate(body) {
  if (!isPlainObject(body)) throw new BadRequest('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!KEYS.has(k)) throw new BadRequest(`Unknown key: ${k.slice(0, 40)}`);
  const event = validEvent(body.event);
  const hasFile = body.content_base64 !== undefined;
  const hasText = body.text !== undefined;
  if (hasFile === hasText) throw new BadRequest('Send either content_base64 or text');
  // With text, filename and mime are hints about its format and nothing more, as in the Worker.
  if (body.filename !== undefined && (typeof body.filename !== 'string' || body.filename.length > 255)) throw new BadRequest('filename must be a string of at most 255 characters');
  if (body.mime !== undefined && (typeof body.mime !== 'string' || body.mime.length > 127)) throw new BadRequest('mime must be a string of at most 127 characters');

  let bytes = null;
  let text = null;
  if (hasFile) {
    if (typeof body.content_base64 !== 'string') throw new BadRequest('content_base64 must be a string');
    const b64 = body.content_base64.replace(/\s+/g, '');
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw new BadRequest('content_base64 is not valid base64');
    bytes = Buffer.from(b64, 'base64');
    if (bytes.length > MAX_DECODED) throw new ImportError(413, TOO_LARGE);
    if (!bytes.length) throw new ImportError(422, 'That file is empty.');
  } else {
    if (typeof body.text !== 'string') throw new BadRequest('text must be a string');
    if (body.text.length > MAX_TEXT) throw new ImportError(413, 'That text is too long. Paste at most 200,000 characters.');
    if (!body.text.trim()) throw new ImportError(422, 'Paste the text of your schedule first.');
    text = body.text;
  }

  const conference = await searchableConference(event);
  if (!conference) throw new BadRequest('event is not available');
  return { conference, bytes, text, filename: body.filename ?? '', mime: body.mime ?? '' };
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Returns "document" for formats Tika reads (PDF, zip-based office files, legacy office files and
// RTF), or the decoded UTF-8 text. Anything else is not supported.
function sniff(bytes) {
  const head = bytes.subarray(0, 1024);
  if (head.includes('%PDF-')) return { kind: 'document' };
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return { kind: 'document' };
  if (bytes.subarray(0, 8).equals(OLE_MAGIC)) return { kind: 'document' };
  if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return { kind: 'document' };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    throw new ImportError(415, UNSUPPORTED);
  }
}

const TITLE_HEADERS = ['title', 'session title', 'talk title', 'session name', 'session', 'talk', 'name', 'event name', 'event title', 'summary', 'subject', 'event'];
const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Bounded reading. A file may hold 5 MB, so the text is never split into one array: lines are
// found by index, each is cut to MAX_LINE characters before any regular expression sees it, and
// the parsers stop as soon as they have MAX_ENTRIES entries.

// The first MAX_LINES lines of text, split at \r\n, \r or \n, each cut to MAX_LINE characters.
function* lines(text) {
  const n = text.length;
  let i = 0;
  for (let count = 0; count < MAX_LINES; count++) {
    let j = i;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) break;
      j++;
    }
    yield text.slice(i, Math.min(j, i + MAX_LINE));
    if (j >= n) return;
    i = j + (text.charCodeAt(j) === 13 && text.charCodeAt(j + 1) === 10 ? 2 : 1);
  }
}

// The text up to the first \n (without a \r before it), cut to MAX_LINE characters.
function firstLine(text) {
  const nl = text.indexOf('\n');
  const line = text.slice(0, Math.min(nl === -1 ? text.length : nl, MAX_LINE));
  return nl !== -1 && nl <= MAX_LINE && line.endsWith('\r') ? line.slice(0, -1) : line;
}

// Collapses every run of spaces, including the Unicode spaces some exports use, to one space.
// Splitting on separators assumes this: on long runs of spaces a pattern that starts and ends
// with \s+ would backtrack.
const squash = (s) => s.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/\s+/g, ' ').trim();

// { format } for the text's format, plus the parsed value for JSON, so the file is parsed once.
function textFormat(text, filename, mime) {
  const t = text.trimStart();
  if (/^BEGIN:VCALENDAR/i.test(t)) return { format: 'ics' };
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const value = JSON.parse(t);
      if (value && typeof value === 'object') return { format: 'json', value };
    } catch {
      /* not JSON */
    }
  }
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(filename)?.[1] ?? '').toLowerCase();
  if (ext === 'csv' || ext === 'tsv' || /^text\/(csv|tab-separated-values)/i.test(mime)) return { format: 'csv' };
  // A first line with a delimiter and a title-like column name reads as a CSV header.
  const first = firstLine(t);
  const delim = csvDelimiter(first);
  if (delim && parseCsv(first, delim)[0]?.some((h) => TITLE_HEADERS.includes(normHeader(h)))) return { format: 'csv' };
  return { format: 'text' };
}

// ---------------------------------------------------------------------------------------------
// Dates and times. A time hint becomes an exact start-time range in UTC; local times are read in
// the conference's own time zone.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};
const WEEKDAYS = new Set(['mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'weds', 'wednesday', 'thu', 'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday']);

const TIME = String.raw`(?:\d{1,2}[:.]\d{2}(?:\s*[ap]\.?\s?m\.?)?|\d{1,2}\s*[ap]\.?\s?m\.?)(?![\p{L}\p{N}])`;
const LEAD_TIME_RE = new RegExp(String.raw`^(${TIME})(?:\s*(?:-|–|—|to)\s*(${TIME}))?\s*`, 'iu');
const ANY_TIME_RE = new RegExp(TIME, 'giu');

function clockMinutes(s) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s?m\.?)?/i.exec(String(s ?? '').trim());
  if (!m || (m[2] === undefined && !m[3])) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms) / 60000;
}

// A local wall-clock time in a zone, as a UTC ISO string, or null.
function localToIso(y, mo, d, minutes, zone) {
  if (!(y >= 2000 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) || minutes === null || !validZone(zone)) return null;
  const wall = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let utc = wall - offsetMinutes(wall, zone) * 60000;
  utc = wall - offsetMinutes(utc, zone) * 60000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

const ISO_DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

// A start value from a structured file: ISO with or without an offset, or a date plus a time.
function structuredStart(value, zone, timeValue) {
  if (typeof value !== 'string' || value.length > 60) return null;
  const v = value.trim();
  const iso = ISO_DT_RE.exec(v);
  if (iso) {
    if (iso[6]) {
      const ms = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:00${iso[6].length === 5 ? `${iso[6].slice(0, 3)}:${iso[6].slice(3)}` : iso[6]}`);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    return localToIso(+iso[1], +iso[2], +iso[3], +iso[4] * 60 + +iso[5], zone);
  }
  const date = looseDate(v);
  if (!date) return null;
  const minutes = clockMinutes(timeValue ?? date.rest);
  return minutes === null ? null : localToIso(date.y, date.m, date.d, minutes, zone);
}

// "2026-11-10", "11/10/2026" (month first) or "Nov 10, 2026" at the start of a value.
function looseDate(v) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b\s*(.*)$/.exec(v);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], rest: m[4] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b\s*(.*)$/.exec(v);
  if (m) return { y: +m[3], m: +m[1], d: +m[2], rest: m[4] };
  m = /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b\s*(.*)$/i.exec(v);
  if (m && MONTHS[m[1].toLowerCase()]) return { y: +m[3], m: MONTHS[m[1].toLowerCase()], d: +m[2], rest: m[4] };
  return null;
}

// A line that holds only a date and/or times (with weekday names and punctuation), such as
// "MONDAY 10 • NOVEMBER", "Tue, Nov 10, 2026" or "10:30am – 11:00am". Returns null otherwise.
function dateTimeLine(line, defaultYear) {
  const times = line.match(ANY_TIME_RE) ?? [];
  const rest = line.replace(ANY_TIME_RE, ' ');
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(rest);
  const tokens = rest.replace(/\b\d{4}-\d{2}-\d{2}\b/, ' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length > 6) return null;
  let month = null;
  let day = null;
  let year = null;
  for (const t of tokens) {
    if (MONTHS[t] && month === null) month = MONTHS[t];
    else if (WEEKDAYS.has(t)) continue;
    else if (/^\d{4}$/.test(t) && year === null) year = Number(t);
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(t) && day === null) day = parseInt(t, 10);
    else if (['to', 'at', 'from', 'until', 'mst', 'mdt', 'pst', 'pdt', 'est', 'edt', 'cst', 'cdt', 'utc', 'gmt'].includes(t)) continue;
    else return null;
  }
  const date = iso ? { y: +iso[1], m: +iso[2], d: +iso[3] } : month && day ? { y: year ?? defaultYear, m: month, d: day } : null;
  if (!date && !times.length) return null;
  if (!date && tokens.some((t) => !['to', 'at', 'from', 'until'].includes(t) && !/^(mst|mdt|pst|pdt|est|edt|cst|cdt|utc|gmt)$/.test(t))) return null;
  return { date, minutes: times.length ? clockMinutes(times[0]) : null };
}

// ---------------------------------------------------------------------------------------------
// Free text (PDF, office documents, pasted or plain text) into entries. An entry is one item of
// the schedule; it offers candidate texts in order of preference, the nearby speaker text and an
// optional start time.

const NOISE_LINE = /^(?:add (?:it )?to (?:my |your )?(?:calendar|schedule|sched|google calendar|outlook|ical)|remove from (?:my |your )?(?:calendar|schedule|sched)|view (?:session )?details|more info(?:rmation)?|join (?:the )?waitlist|this session is full|filling up|page \d+(?: of \d+)?|\d+\s*(?:\/|of)\s*\d+|\d+)$/i;
const URL_LINE = /^(?:https?:\/\/|www\.)\S*$/i;
// One address and nothing else, with a dot in the domain. Checked without a pattern that can
// backtrack: [^\s@]+ cannot overlap the "@".
function emailLine(line) {
  if (line.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(line)) return false;
  const dot = line.lastIndexOf('.');
  return dot > line.indexOf('@') + 1 && dot < line.length - 1;
}
const CONTEXT_LABEL = /^(?:speakers?|presenters?|moderators?|panel(?:ists)?|hosts?|instructors?|by)\s*:\s*/i;
const DROP_LABEL = /^(?:rooms?|location|where|venue|track|type|session type|format|level|experience level|audience|tags?|categor(?:y|ies)|when|time|date|language|capacity|status)\s*:/i;
const ROOM_WORD = /\b(?:room|rooms|hall|level|floor|building|bldg|salon|ballroom|suite|theater|theatre|stage|booth|lobby|foyer|auditorium|pavilion|terrace|lounge|expo|exhibit|exhibition|mezzanine|wing|online|virtual)\b/i;
const SEPARATOR_RE = /\s+[-–—|]\s+/g;

// "Salt Palace | Level 2 | Room 250 A" or "Room 250 A": short pieces, one of which names a room.
function roomLike(line) {
  const segs = line.split(/\s*(?:\||•|·|\/)\s*/).filter(Boolean);
  if (!segs.length || segs.some((s) => s.split(/\s+/).length > 4)) return false;
  const roomish = segs.some((s) => ROOM_WORD.test(s) || /\b[A-Z]?\d{2,4}[A-Z]?(?:-\d{2,4}[A-Z]?)?\b/.test(s));
  return roomish && (segs.length >= 2 || (ROOM_WORD.test(line) && /\d/.test(line)));
}

// Removes a session-type badge after a stripped time: one letter or digit, or a run of symbols
// such as an emoji, that some exports print before the title.
const stripBadge = (s) => s.replace(/^(?:[\p{L}\p{N}]|[^\p{L}\p{N}\s"'“‘(\[]+)\s+/u, '');

function splitVariants(text) {
  const parts = text.split(SEPARATOR_RE);
  if (parts.length < 2) return { variants: [], after: '' };
  return {
    variants: [parts.slice(0, -1).join(' - '), parts[0]],
    after: parts[parts.length - 1],
  };
}

function textEntries(text, conference) {
  const defaultYear = Number(String(conference.start_date ?? '').slice(0, 4)) || new Date().getUTCFullYear();
  const zone = conference.time_zone || 'UTC';
  const entries = [];
  let date = null;
  let pendingMinutes = null;
  let block = null; // { lines, context, contextChars, minutes }

  const flush = () => {
    if (!block) return;
    const b = block;
    block = null;
    if (!b.lines.length || entries.length >= MAX_ENTRIES) return;
    const hint = date && b.minutes !== null ? localToIso(date.y, date.m, date.d, b.minutes, zone) : null;
    // More than four text lines is a list, one item per line, not one wrapped title.
    if (b.lines.length > 4) {
      for (const line of b.lines) {
        if (entries.length >= MAX_ENTRIES) return;
        const split = splitVariants(line);
        entries.push({ variants: [line, ...split.variants], context: [split.after, ...b.context].join(' '), hint: null });
      }
      return;
    }
    const merged = b.lines.join(' ');
    const split = splitVariants(merged);
    const variants = [...split.variants.slice(0, 1), merged, ...split.variants.slice(1)];
    if (b.lines.length > 1) variants.push(...b.lines);
    // An item that starts with a time is clearly one schedule entry, so its title may be short.
    entries.push({ variants, context: [split.after, ...b.context].join(' '), hint, short: b.minutes !== null });
  };
  const start = (minutes) => {
    flush();
    block = { lines: [], context: [], contextChars: 0, minutes };
  };

  for (const raw of lines(text)) {
    if (entries.length >= MAX_ENTRIES) break;
    const line = squash(raw);
    if (!line) {
      flush();
      continue;
    }
    if (URL_LINE.test(line) || emailLine(line) || NOISE_LINE.test(line)) continue;
    const dt = dateTimeLine(line, defaultYear);
    if (dt) {
      if (dt.date) date = dt.date;
      if (dt.minutes !== null) pendingMinutes = dt.minutes;
      flush();
      continue;
    }
    const ctx = CONTEXT_LABEL.exec(line);
    if (ctx) {
      // Only the first CONTEXT_MAX characters of the speaker text are ever sent.
      const names = line.slice(ctx[0].length);
      if (block && names && block.contextChars < CONTEXT_MAX) {
        block.context.push(names);
        block.contextChars += names.length + 1;
      }
      continue;
    }
    if (DROP_LABEL.test(line) || roomLike(line)) continue;
    const lead = LEAD_TIME_RE.exec(line);
    if (lead) {
      start(clockMinutes(lead[1]));
      const rest = stripBadge(line.slice(lead[0].length)).trim();
      if (rest) block.lines.push(rest);
      continue;
    }
    if (!block) {
      start(pendingMinutes);
      pendingMinutes = null;
    }
    block.lines.push(line);
    // A list block gives one entry per line, so once it can fill the remaining entries, the
    // rest of the text cannot add any.
    if (block.lines.length > 4 && entries.length + block.lines.length >= MAX_ENTRIES) break;
  }
  flush();
  return entries;
}

// ---------------------------------------------------------------------------------------------
// iCalendar: one entry per VEVENT, from SUMMARY, with DESCRIPTION as the speaker text and DTSTART
// as the time hint.

const icsUnescape = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

// The content lines of an iCalendar file: a line that starts with a space or a tab continues the
// one before it (RFC 5545 folding). Each is cut to MAX_LINE characters.
function* icsLines(text) {
  let cur = null;
  for (const line of lines(text)) {
    const c = line.charCodeAt(0);
    if (cur !== null && (c === 32 || c === 9)) {
      if (cur.length < MAX_LINE) cur = (cur + line.slice(1)).slice(0, MAX_LINE);
      continue;
    }
    if (cur !== null) yield cur;
    cur = line;
  }
  if (cur !== null) yield cur;
}

function icsEntries(text, conference) {
  const zone = conference.time_zone || 'UTC';
  const entries = [];
  let ev = null;
  for (const line of icsLines(text)) {
    if (entries.length >= MAX_ENTRIES) break;
    if (/^BEGIN:VEVENT\s*$/i.test(line)) ev = {};
    else if (/^END:VEVENT\s*$/i.test(line)) {
      if (ev?.summary) {
        const split = splitVariants(ev.summary);
        entries.push({ variants: [ev.summary, ...split.variants], context: [split.after, ev.description ?? ''].join(' '), hint: ev.start ?? null, short: true });
      }
      ev = null;
    } else if (ev) {
      const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1].toUpperCase();
      if (name === 'SUMMARY') ev.summary = squash(icsUnescape(m[3]));
      else if (name === 'DESCRIPTION') ev.description = icsUnescape(m[3]).slice(0, CONTEXT_MAX);
      else if (name === 'DTSTART') ev.start = icsStart(m[3].trim(), m[2], zone);
    }
  }
  return entries;
}

function icsStart(value, params, zone) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!m) return null; // an all-day date has no time
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  const tzid = /;TZID="?([^;:"]+)"?/i.exec(params)?.[1];
  return localToIso(+m[1], +m[2], +m[3], +m[4] * 60 + +m[5], tzid && validZone(tzid) ? tzid : zone);
}

// ---------------------------------------------------------------------------------------------
// CSV: a title-like column when the header names one, else every cell.

function csvDelimiter(line) {
  let best = null;
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const n = line.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

// Rows of cells. A cell keeps its first MAX_LINE characters, and reading stops after MAX_CSV_ROWS
// rows or MAX_CSV_CELLS cells.
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let cells = 0;
  const add = (ch) => {
    if (cell.length < MAX_LINE) cell += ch;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          add('"');
          i++;
        } else quoted = false;
      } else add(ch);
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
      if (++cells >= MAX_CSV_CELLS) {
        rows.push(row);
        return rows;
      }
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_CSV_ROWS || ++cells >= MAX_CSV_CELLS) return rows;
    } else add(ch);
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvEntries(text, conference, filename) {
  const zone = conference.time_zone || 'UTC';
  const body = text.replace(/^﻿/, '');
  const delim = /\.tsv$/i.test(filename) ? '\t' : csvDelimiter(firstLine(body)) ?? ',';
  const rows = parseCsv(body, delim).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [];
  const header = rows[0].map(normHeader);
  const find = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  let titleCol = find(TITLE_HEADERS);
  if (titleCol === -1) titleCol = header.findIndex((h) => /\btitle\b/.test(h));
  if (titleCol === -1) {
    // No title column: every cell is a possible title.
    return rows.flat().slice(0, MAX_ENTRIES).map((cell) => {
      const c = squash(cell);
      const split = splitVariants(c);
      return { variants: [c, ...split.variants], context: split.after, hint: null };
    });
  }
  const speakerCols = header.map((h, i) => (/\b(speakers?|presenters?|moderators?)\b/.test(h) ? i : -1)).filter((i) => i !== -1);
  const startCol = find(['start', 'starts', 'start time', 'start date time', 'start datetime', 'starts at', 'begin', 'dtstart', 'event start', 'start at']);
  const dateCol = find(['start date', 'date', 'day']);
  const timeCol = find(['start time', 'time', 'from']);
  return rows.slice(1, MAX_ENTRIES + 1).map((r) => {
    const title = squash(r[titleCol] ?? '');
    const split = splitVariants(title);
    let hint = null;
    if (startCol !== -1 && startCol !== timeCol) hint = structuredStart(r[startCol], zone);
    if (!hint && dateCol !== -1) hint = structuredStart(r[dateCol], zone, timeCol !== -1 ? r[timeCol] : undefined);
    return { variants: [title, ...split.variants], context: [split.after, ...speakerCols.map((i) => r[i] ?? '')].join(' '), hint, short: true };
  });
}

// ---------------------------------------------------------------------------------------------
// JSON: Sessionize exports (view/All, view/Sessions), Sched exports and generic arrays. Each object
// with a title-like string field is one entry; speakers and a start time are read when present.

const JSON_TITLE_KEYS = ['title', 'name', 'session', 'session_title', 'sessionTitle', 'talk', 'summary', 'subject'];
const JSON_START_KEYS = ['startsAt', 'start', 'event_start', 'start_time', 'startTime', 'dtstart', 'starts_at'];
const SPEAKER_KEYS = new Set(['speakers', 'speaker', 'presenters', 'moderators']);
const MAX_SPEAKERS = 100; // names read per speaker field; the speaker text is cut to CONTEXT_MAX anyway
const jsonTitle = (s) => squash(s.slice(0, MAX_LINE)).slice(0, 500);

function jsonEntries(value, conference) {
  const zone = conference.time_zone || 'UTC';
  const speakerNames = new Map(); // Sessionize view/All lists speakers by id
  let budget = 50_000;
  const collect = (v, depth) => {
    if (budget-- <= 0 || depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (budget <= 0) return;
        collect(x, depth + 1);
      }
      return;
    }
    if (typeof v.id === 'string' && typeof v.fullName === 'string') speakerNames.set(v.id, v.fullName);
    for (const k of Object.keys(v)) {
      if (budget <= 0) return;
      collect(v[k], depth + 1);
    }
  };
  collect(value, 0);

  const nameOf = (s) => (typeof s === 'string' ? speakerNames.get(s) ?? s : typeof s?.name === 'string' ? s.name : typeof s?.fullName === 'string' ? s.fullName : '');
  const entries = [];
  budget = 50_000;
  const walk = (v, depth) => {
    if (budget-- <= 0 || depth > 8 || entries.length >= MAX_ENTRIES || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (entries.length >= MAX_ENTRIES) return;
        if (typeof x === 'string') entries.push({ variants: [jsonTitle(x)], context: '', hint: null, short: true });
        else walk(x, depth + 1);
      }
      return;
    }
    const key = JSON_TITLE_KEYS.find((k) => typeof v[k] === 'string' && v[k].trim());
    if (key) {
      const title = jsonTitle(v[key]);
      const split = splitVariants(title);
      const speakers = [].concat(...[...SPEAKER_KEYS].map((k) => (Array.isArray(v[k]) ? v[k].slice(0, MAX_SPEAKERS) : v[k] ? [v[k]] : []))).map(nameOf).join(', ');
      const startKey = JSON_START_KEYS.find((k) => typeof v[k] === 'string');
      entries.push({ variants: [title, ...split.variants], context: [split.after, speakers].join(' '), hint: startKey ? structuredStart(v[startKey], zone) : null, short: true });
    }
    for (const k of Object.keys(v)) {
      if (budget <= 0 || entries.length >= MAX_ENTRIES) return;
      if (!SPEAKER_KEYS.has(k)) walk(v[k], depth + 1);
    }
  };
  walk(value, 0);
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Candidates. The first preferred text of every entry comes first, then the second of every
// entry, and so on, so a long file cannot crowd out later entries' best lines. Candidates need
// three words, at least two of them content words. The preferred text of an entry that is
// clearly one schedule item (a structured title, or a line that starts with a time) may have two
// words. exact_title is sent only with three content words, so a short phrase cannot claim an
// exact match; a two-word title can only match as title words, which needs both words.

const EN_STOP = new Set('a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(' '));
const HAS_WORD = /[\p{L}\p{N}]/u;

// Every input is already bounded (a line, cell or value, or an item of at most four lines); the
// slice only guards that. The trailing-punctuation strip runs after the cut to TITLE_MAX, because
// on a long run of those characters followed by anything else it backtracks.
function cleanCandidate(s) {
  let t = String(s ?? '').slice(0, MAX_ITEM).replace(/\s+/g, ' ').trim();
  t = t.replace(/^[^\p{L}\p{N}"'“‘(\[]+/u, '');
  const lead = LEAD_TIME_RE.exec(t);
  if (lead) t = stripBadge(t.slice(lead[0].length));
  return t.slice(0, TITLE_MAX).replace(/[\s\-–—|•·:,;]+$/u, '');
}

function buildCandidates(entries) {
  const out = [];
  const byKey = new Map();
  const rounds = entries.reduce((n, e) => Math.max(n, e.variants.length), 0);
  for (let v = 0; v < rounds && out.length < MAX_CANDIDATES; v++) {
    for (let i = 0; i < entries.length && out.length < MAX_CANDIDATES; i++) {
      const e = entries[i];
      if (v >= e.variants.length) continue;
      const text = cleanCandidate(e.variants[v]);
      const words = text.split(' ').filter((w) => HAS_WORD.test(w));
      if (words.length < (v === 0 && e.short ? 2 : 3) || words.length > 40) continue;
      const content = words.filter((w) => !EN_STOP.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))).length;
      if (content < 2) continue;
      const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const seen = byKey.get(key);
      if (seen) {
        seen.entries.add(i);
        continue;
      }
      const c = { text, entries: new Set([i]), exact: content >= 3, context: String(e.context ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_MAX), hint: e.hint };
      byKey.set(key, c);
      out.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Elasticsearch.

// Tika through the attachment processor in a simulated pipeline: the document is parsed and
// returned, and nothing is written to any index.
async function extractDocument(bytes) {
  const body = JSON.stringify({
    pipeline: {
      processors: [{ attachment: { field: 'data', target_field: 'doc', indexed_chars: INDEXED_CHARS, properties: ['content'], remove_binary: true } }],
    },
    docs: [{ _source: { data: bytes.toString('base64') } }],
  });
  const json = await esRequest('/_ingest/pipeline/_simulate', body, { timeoutMs: TIKA_TIMEOUT_MS });
  const doc = json.docs?.[0];
  if (!doc || doc.error) throw new ImportError(422, UNREADABLE);
  return String(doc.doc?._source?.doc?.content ?? '');
}

function candidateSearch(conference, c) {
  const title = [{ match: { title: { query: c.text, minimum_should_match: '3<75%', _name: 'title_words' } } }];
  if (c.exact) title.unshift({ match_phrase: { title: { query: c.text, _name: 'exact_title' } } });
  const should = [];
  if (c.context) should.push({ match: { speakers: { query: c.context, minimum_should_match: 2, _name: 'speaker' } } });
  if (c.hint) {
    const end = new Date(Date.parse(c.hint) + 60_000).toISOString();
    should.push({ range: { start: { gte: c.hint, lt: end, _name: 'time' } } });
  }
  return {
    size: 1,
    track_total_hits: false,
    _source: SOURCE_FIELDS,
    query: {
      bool: {
        filter: [{ term: { conference } }, { term: { kind: 'talk' } }],
        must: [{ bool: { should: title, minimum_should_match: 1 } }],
        should,
      },
    },
  };
}

async function matchCandidates(conference, candidates) {
  if (!candidates.length) return [];
  // Every search names the conference's preference, so a title that ties between two talks always
  // resolves to the same one.
  const header = JSON.stringify({ preference: conferencePreference(conference) });
  const body = candidates.map((c) => `${header}\n${JSON.stringify(candidateSearch(conference, c))}\n`).join('');
  const json = await esRequest(`/${encodeURIComponent(ES_INDEX)}/_msearch`, body, { contentType: 'application/x-ndjson', timeoutMs: MSEARCH_TIMEOUT_MS });
  const responses = json.responses ?? [];
  if (responses.length !== candidates.length) throw new UpstreamError('msearch returned the wrong number of responses');
  const failed = responses.filter((r) => r.error).length;
  if (failed) console.error(`Import: ${failed} of ${responses.length} searches failed`);
  return responses.map((r) => (r.error ? null : r.hits?.hits?.[0] ?? null));
}

// The confidence label, from the named queries that matched (across every candidate that found
// the talk).
function confidence(names) {
  if (names.has('exact_title')) return 'exact_title';
  if (names.has('speaker')) return 'title_and_speaker';
  if (names.has('time')) return 'title_and_time';
  return 'title_words';
}

function excerpt(text) {
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut) + '…';
}

async function runImport({ conference, bytes, text, filename, mime }) {
  let content = text;
  let isDocument = false;
  if (bytes) {
    const sniffed = sniff(bytes);
    isDocument = sniffed.kind === 'document';
    content = isDocument ? await extractDocument(bytes) : sniffed.text;
  }
  content = content.replace(/^﻿/, '');
  if (!content.trim()) throw new ImportError(422, UNREADABLE);
  const { format, value } = isDocument ? { format: 'text' } : textFormat(content, filename, mime);

  let entries;
  if (format === 'ics') entries = icsEntries(content, conference);
  else if (format === 'json') entries = jsonEntries(value, conference);
  else if (format === 'csv') entries = csvEntries(content, conference, filename);
  else entries = textEntries(content, conference);

  const candidates = buildCandidates(entries.slice(0, MAX_ENTRIES));
  const hits = await matchCandidates(conference.slug, candidates);

  const best = new Map(); // talk_id -> { hit, candidate, names }
  const matchedEntries = new Set();
  const entriesWithCandidates = new Set();
  hits.forEach((hit, i) => {
    const c = candidates[i];
    for (const e of c.entries) entriesWithCandidates.add(e);
    if (!hit) return;
    for (const e of c.entries) matchedEntries.add(e);
    const id = String(hit._source?.talk_id ?? hit._id);
    const names = Array.isArray(hit.matched_queries) ? hit.matched_queries : Object.keys(hit.matched_queries ?? {});
    const prev = best.get(id);
    if (!prev) best.set(id, { hit, candidate: c, names: new Set(names) });
    else {
      for (const n of names) prev.names.add(n);
      if ((hit._score ?? 0) > (prev.hit._score ?? 0)) {
        prev.hit = hit;
        prev.candidate = c;
      }
    }
  });

  // Listed in the order the talks appear in the file.
  const found = [...best.values()].sort((a, b) => Math.min(...a.candidate.entries) - Math.min(...b.candidate.entries));
  const labels = await topicLabels(conference.slug, found.flatMap((f) => (Array.isArray(f.hit._source?.topics) ? f.hit._source.topics : [])));
  return {
    matched: found.map((f) => ({
      talk: toResult(f.hit, labels),
      confidence: confidence(f.names),
      matched_text_excerpt: excerpt(f.candidate.text),
    })),
    unmatched_count: [...entriesWithCandidates].filter((e) => !matchedEntries.has(e)).length,
    extracted_chars: content.length,
  };
}

// ---------------------------------------------------------------------------------------------

let active = 0;

export async function handleImportApi(req, res, url) {
  if (url.pathname !== '/api/import/schedule') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    return true;
  }
  const rate = take(`import:${clientIp(req)}`, PER_MIN);
  if (!rate.ok) {
    req.resume();
    sendJson(res, 429, { error: 'Too many imports in a short time. Wait a minute and try again.' }, { 'Retry-After': String(rate.retryAfterSec) });
    return true;
  }
  if (!sameOrigin(req)) {
    req.resume();
    sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
    return true;
  }
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return true;
  }
  if (active >= MAX_ACTIVE) {
    req.resume();
    sendJson(res, 503, { error: 'Import is busy right now. Try again in a few seconds.' }, { 'Retry-After': '5' });
    return true;
  }
  active++;
  try {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new BadRequest('Malformed JSON');
    }
    const params = await validate(body);
    body = null;
    sendJson(res, 200, await runImport(params));
  } catch (err) {
    if (err instanceof ImportError) sendJson(res, err.status, { error: err.message });
    else if (err instanceof BadRequest) sendJson(res, 400, { error: err.message });
    else {
      // Only a status code or an error name is logged, never content.
      console.error(`Import failed: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'Error')}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'Import is temporarily unavailable. Please try again.' });
    }
  } finally {
    active--;
  }
  return true;
}
