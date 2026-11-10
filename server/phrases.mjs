// Time phrases in the search text: "morning", "afternoon", "before lunch", "after lunch", "day 1"
// to "day N" and weekday names. A fixed, rule-based table maps each phrase to a filter; no model is
// involved. A matched phrase leaves the search text and comes back to the client as a chip, so the
// remaining text is what the keyword and semantic retrievers see.
//
// Each phrase becomes a filter clause that the search applies with its base filters, so facet
// counts and totals already reflect it. Elasticsearch does all the filtering; this module only
// decides which clauses to send.
//
// - morning: the talk starts before 12:00. afternoon: it starts at 12:00 or later. These are the
//   same boundaries as the Time chip in the filter sheet.
// - day N: the Nth day counted from the conference's start_date, accepted only while that date is
//   no later than its end_date.
// - A weekday name: every day with talks that falls on that weekday. It is accepted only when such
//   a day exists, so "friday" stays in the text for a conference that has no Friday talks.
// - before lunch, after lunch: lunch comes from the conference's own break items whose title
//   contains "lunch", one window per day, read with one Elasticsearch query per conference and
//   cached for ten minutes. A talk is before lunch when it starts before that day's lunch begins,
//   and after lunch when it starts once that day's lunch has ended. A day with no lunch item
//   matches neither phrase, and a conference with no lunch item at all does not recognise them.
// - Several day or weekday phrases are alternatives; every other phrase narrows the result.
// - A phrase the client has removed is sent back in ignore_phrases. It still leaves the text,
//   because the person asked for it to stop filtering, but it adds no clause and is reported with
//   applied: false so the client can drop it from its list once the text no longer holds it.

import { esRequest } from './search.mjs';
import { conferencePreference, withPreference } from './preference.mjs';

const ES_INDEX = process.env.ES_INDEX || 'caddie-talks';
const SHAPE_TTL_MS = 10 * 60 * 1000;
const NOON = 12 * 60;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ALTERNATIVES = WEEKDAYS.join('|');

// One optional lead-in word, so "on tuesday" and "in the morning" leave nothing behind. Then the
// phrase itself, in the order that lets "before lunch" win over any shorter phrase.
const PHRASE_RE = new RegExp(
  `\\b(?:(?:in|on|during)\\s+(?:the\\s+)?)?(before\\s+lunch|after\\s+lunch|morning|afternoon|day\\s*(\\d{1,2})|${WEEKDAY_ALTERNATIVES})\\b`,
  'gi',
);
const NEEDS_SHAPE = /lunch|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;

// ---------------------------------------------------------------------------------------------
// The schedule's shape for one conference: the days that have talks and each day's lunch window.

const shapeCache = new Map(); // slug -> { at, promise }

async function fetchShape(slug) {
  const json = await esRequest(withPreference(`/${encodeURIComponent(ES_INDEX)}/_search`, conferencePreference(slug)), {
    size: 0,
    query: { term: { conference: slug } },
    aggs: {
      talk_days: {
        filter: { term: { kind: 'talk' } },
        aggs: { day: { terms: { field: 'day', size: 100 } } },
      },
      lunch: {
        filter: { bool: { filter: [{ term: { kind: 'break' } }, { match: { title: 'lunch' } }] } },
        aggs: {
          day: {
            terms: { field: 'day', size: 100 },
            aggs: { starts: { min: { field: 'start_minutes' } }, ends: { max: { field: 'end_minutes' } } },
          },
        },
      },
    },
  });
  const talkDays = (json.aggregations?.talk_days?.day?.buckets ?? []).map((b) => b.key).sort();
  const lunch = new Map();
  for (const b of json.aggregations?.lunch?.day?.buckets ?? []) {
    const start = b.starts?.value;
    const end = b.ends?.value;
    if (Number.isFinite(start) && Number.isFinite(end)) lunch.set(b.key, { start: Math.round(start), end: Math.round(end) });
  }
  return { talkDays, lunch };
}

function scheduleShape(slug) {
  const now = Date.now();
  let entry = shapeCache.get(slug);
  if (!entry || now - entry.at > SHAPE_TTL_MS) {
    const promise = fetchShape(slug);
    entry = { at: now, promise };
    shapeCache.set(slug, entry);
    promise.catch(() => {
      if (shapeCache.get(slug)?.promise === promise) shapeCache.delete(slug);
    });
  }
  return entry.promise;
}

// ---------------------------------------------------------------------------------------------
// Parsing.

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The date n days after a "YYYY-MM-DD" date, as "YYYY-MM-DD", in plain calendar arithmetic.
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

// Finds the recognised phrases in the text. Returns the text without them, the phrases in the
// order they first appear, and the filter clauses of those that are not ignored.
// conference supplies start_date and end_date; ignored is a Set of phrase keys.
export async function parseTimePhrases(text, conference, ignored) {
  const found = [...text.matchAll(PHRASE_RE)];
  if (!found.length) return { text, phrases: [], clauses: [] };

  const shape = NEEDS_SHAPE.test(text) ? await scheduleShape(conference.slug) : null;
  const start = DATE_RE.test(conference.start_date ?? '') ? conference.start_date : null;
  const end = DATE_RE.test(conference.end_date ?? '') ? conference.end_date : start;

  const phrases = new Map(); // key -> { key, label, days }
  const cuts = []; // [from, to) ranges of the text to remove
  for (const m of found) {
    const word = m[1].toLowerCase().replace(/\s+/g, ' ');
    let phrase = null;
    if (word === 'morning') phrase = { key: 'morning', label: 'Morning', days: [] };
    else if (word === 'afternoon') phrase = { key: 'afternoon', label: 'Afternoon', days: [] };
    else if (word === 'before lunch' || word === 'after lunch') {
      if (shape && shape.lunch.size > 0) phrase = { key: word.replace(' ', '-'), label: capitalize(word), days: [] };
    } else if (m[2] !== undefined) {
      const n = Number(m[2]);
      const date = start && n >= 1 ? addDays(start, n - 1) : null;
      if (date && end && date <= end) phrase = { key: `day-${n}`, label: `Day ${n}`, days: [date] };
    } else if (shape) {
      const days = shape.talkDays.filter((d) => weekdayOf(d) === WEEKDAYS.indexOf(word));
      if (days.length) phrase = { key: word, label: capitalize(word), days };
    }
    if (!phrase) continue;
    if (!phrases.has(phrase.key)) phrases.set(phrase.key, phrase);
    cuts.push([m.index, m.index + m[0].length]);
  }

  let rest = '';
  let at = 0;
  for (const [from, to] of cuts) {
    rest += text.slice(at, from) + ' ';
    at = to;
  }
  rest += text.slice(at);
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '');

  const list = [...phrases.values()].map((p) => ({ ...p, applied: !ignored.has(p.key) }));
  const applied = list.filter((p) => p.applied);
  const clauses = [];
  for (const p of applied) {
    if (p.key === 'morning') clauses.push({ range: { start_minutes: { lt: NOON } } });
    else if (p.key === 'afternoon') clauses.push({ range: { start_minutes: { gte: NOON } } });
    else if (p.key === 'before-lunch' || p.key === 'after-lunch') {
      const before = p.key === 'before-lunch';
      const windows = [...shape.lunch].map(([day, w]) => ({
        bool: { filter: [{ term: { day } }, { range: { start_minutes: before ? { lt: w.start } : { gte: w.end } } }] },
      }));
      clauses.push({ bool: { should: windows, minimum_should_match: 1 } });
    }
  }
  const days = [...new Set(applied.flatMap((p) => p.days))];
  if (days.length) clauses.push({ terms: { day: days } });

  return { text: rest, phrases: list, clauses };
}
