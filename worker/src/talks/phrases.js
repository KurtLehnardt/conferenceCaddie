// Time phrases in the search text, ported from server/phrases.mjs: "morning", "afternoon",
// "before lunch", "after lunch", "day 1" to "day N" and weekday names. A fixed rule table maps each
// phrase to a filter; no model is involved. A matched phrase leaves the search text and comes back
// to the client as a chip, so the remaining text is what the keyword and semantic legs see.
//
// - morning: the talk starts before 12:00. afternoon: at 12:00 or later.
// - day N: the Nth day counted from the conference's start_date, accepted only while that date is
//   no later than its end_date.
// - A weekday name: every day with talks that falls on that weekday, accepted only when one exists.
// - before lunch, after lunch: each day's lunch window comes from the conference's own break items
//   whose title names lunch (scheduleShape in cache.js). A day without one matches neither phrase,
//   and a conference without any lunch item does not recognise them.
// - Several day or weekday phrases are alternatives; every other phrase narrows the result.
// - A phrase named in ignore_phrases still leaves the text but adds no filter, and is reported with
//   applied: false.
//
// The filters are returned as predicates over a cached talk row instead of Elasticsearch clauses.

import { scheduleShape } from './cache.js';

const NOON = 12 * 60;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PHRASE_RE = new RegExp(
  `\\b(?:(?:in|on|during)\\s+(?:the\\s+)?)?(before\\s+lunch|after\\s+lunch|morning|afternoon|day\\s*(\\d{1,2})|${WEEKDAYS.join('|')})\\b`,
  'gi',
);
const NEEDS_SHAPE = /lunch|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

// Returns { text, phrases, predicates }: the text without the phrases, the phrases in the order
// they first appear, and one predicate per applied filter (a talk must pass all of them).
export function parseTimePhrases(textValue, conf, store, ignored) {
  const found = [...textValue.matchAll(PHRASE_RE)];
  if (!found.length) return { text: textValue, phrases: [], predicates: [] };

  const shape = NEEDS_SHAPE.test(textValue) ? scheduleShape(store) : null;
  const start = DATE_RE.test(conf.start_date ?? '') ? conf.start_date : null;
  const end = DATE_RE.test(conf.end_date ?? '') ? conf.end_date : start;

  const phrases = new Map();
  const cuts = [];
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
    rest += `${textValue.slice(at, from)} `;
    at = to;
  }
  rest += textValue.slice(at);
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '');

  const list = [...phrases.values()].map((p) => ({ ...p, applied: !ignored.has(p.key) }));
  const applied = list.filter((p) => p.applied);
  const predicates = [];
  for (const p of applied) {
    if (p.key === 'morning') predicates.push((t) => Number.isFinite(t.start_minutes) && t.start_minutes < NOON);
    else if (p.key === 'afternoon') predicates.push((t) => Number.isFinite(t.start_minutes) && t.start_minutes >= NOON);
    else if (p.key === 'before-lunch' || p.key === 'after-lunch') {
      const before = p.key === 'before-lunch';
      const lunch = shape.lunch;
      predicates.push((t) => {
        const w = lunch.get(t.day);
        if (!w || !Number.isFinite(t.start_minutes)) return false;
        return before ? t.start_minutes < w.start : t.start_minutes >= w.end;
      });
    }
  }
  const days = new Set(applied.flatMap((p) => p.days));
  if (days.size) predicates.push((t) => days.has(t.day));

  return { text: rest, phrases: list, predicates };
}
