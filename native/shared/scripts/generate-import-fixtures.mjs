// Generates native/shared/src/commonTest/kotlin/app/conferencecaddie/shared/importer/ImportParityFixtures.kt:
// schedule files with what the Worker's in-memory import (worker/src/talks/import.js and
// import-parse.js, the port of server/import.mjs) makes of them. The device's import must make the
// same: the same format, the same candidates (text, the items that offered it, whether it may match
// as an exact title, the speaker text and the time hint) and the same matches over the same talks.
//
// Usage, from the repository root (no dependencies):
//   node native/shared/scripts/generate-import-fixtures.mjs
//
// The cases are written to catch differences between JavaScript's regular expressions and string
// functions and the hand-written Kotlin: every kind of time ("9am", "9 a.m.", "9.30 PM", ranges,
// a time run into a word), date headers, session-type badges, room, noise, URL and e-mail lines,
// speaker labels, lists and wrapped titles, Unicode spaces and line separators, accents and other
// scripts, emoji, iCalendar folding, escapes, TZID and all-day dates, CSV quoting, delimiters,
// header names and date and time columns, JSON exports with speakers by id, keys that are array
// indexes, deep nesting and odd values, and the format detection itself. Time zones other than the
// conference's, an unknown zone and no zone at all are covered too.
//
// The generated file is ASCII: every other character is written as a \uXXXX escape.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCandidates, csvEntries, icsEntries, jsonEntries, MAX_ENTRIES, textEntries, textFormat } from '../../../worker/src/talks/import-parse.js';
import { runImport } from '../../../worker/src/talks/import.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'native/shared/src/commonTest/kotlin/app/conferencecaddie/shared/importer/ImportParityFixtures.kt');

const EVENT = 'testconf-2099';

// The talks the matches are made against: the four of test/import-bounds.test.mjs, titles that
// share words with them, a talk at the same time as another, and kinds the import never matches.
const TALKS = [
  ['talk', 'Inside the Kubernetes Scheduler', ['Xavier Dupont'], '2099-11-11T15:00:00-07:00'],
  ['talk', 'Rust Operators for Kubernetes', ['Arjun Mehta'], '2099-11-12T09:30:00-07:00'],
  ['talk', 'Running Postgres on Kubernetes Without Losing Sleep', ['Alice Moreau', 'Bjorn Ek'], '2099-11-10T10:30:00-07:00'],
  ['talk', 'Zero Trust Service Mesh in Practice', ['Pablo Ruiz'], '2099-11-11T10:00:00-07:00'],
  ['talk', 'Inside the Kubernetes Scheduler: Deep Dive', ['Mei Lin', 'Xavier Dupont'], '2099-11-12T14:00:00-07:00'],
  ['talk', 'Kubernetes Scheduler Office Hours', ['Ola Nordmann'], '2099-11-11T15:00:00-07:00'],
  ['talk', 'Café Résumé: Naïve Approaches to Observability', ['José Núñez'], '2099-11-10T13:00:00-07:00'],
  ['talk', 'eBPF für Einsteiger: Netzwerke verstehen', ['Jürgen Groß'], '2099-11-10T16:00:00-07:00'],
  ['talk', 'クラウドネイティブ入門 Kubernetes Basics', ['Yuki Tanaka'], '2099-11-12T11:00:00-07:00'],
  ['talk', 'Scaling Prometheus to a Billion Series', ['Priya Raman', 'Sam Okafor'], '2099-11-10T09:00:00-07:00'],
  ['talk', 'Lightning Talk: GitOps in 5 Minutes', ['Chris Doe'], '2099-11-11T17:00:00-07:00'],
  ['talk', 'Securing the Software Supply Chain with Sigstore', ['Dana Kim', 'Lee Park', 'Ana Silva'], '2099-11-12T16:30:00-07:00'],
  ['break', 'Lunch Break', [], '2099-11-11T12:00:00-07:00'],
  ['ambient', 'Kubernetes Scheduler Expo Booth Crawl', [], '2099-11-11T18:00:00-07:00'],
].map(([kind, title, speakers, start], i) => ({
  talk_id: `${EVENT}:t${i + 1}`,
  conference: EVENT,
  kind,
  title,
  speakers,
  start: new Date(start).toISOString(),
  start_ms: Date.parse(start),
  topics: [],
}));

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const ev = (...props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'].join('\r\n');

const DENVER = { start_date: '2099-11-10', time_zone: 'America/Denver' };

// [name, text, filename, mime, conference]
const CASES = [
  // Plain text: Sched-style exports.
  ['sched days, badges, rooms and calendar links', [
    'My Schedule', '', 'Tuesday, November 10, 2099', '', '10:30am – 11:05am B Running Postgres on Kubernetes Without', 'Losing Sleep',
    'Speakers: Alice Moreau, Bjorn Ek', 'Salt Palace | Level 2 | Room 250 A', 'Add to calendar', '',
    '1:00pm - 1:30pm 🎤 Café Résumé: Naïve Approaches to Observability', 'José Núñez', 'Room 101-102', '',
    'Wednesday, November 11, 2099', '', '3:00pm – 3:30pm K Inside the Kubernetes', 'Scheduler', 'Speakers: Xavier Dupont', 'Hall B', 'View details', '',
    '5:00 PM ★ Lightning Talk: GitOps in 5 Minutes', 'https://kccncna2099.sched.com/event/abc', 'chris@example.com', '',
  ].join('\n'), '', '', DENVER],
  ['times of every shape', [
    '9am Scaling Prometheus to a Billion Series', '', '9 a.m. Scaling Prometheus to a Billion Series', '', '9.30 PM Zero Trust Service Mesh in Practice', '',
    '10:30 a.m.x Rust Operators for Kubernetes', '', '10:00to11:00 Inside the Kubernetes Scheduler', '', '14:00 - 15:00 Inside the Kubernetes Scheduler',
    '', '2 pm – 3 pm Zero Trust Service Mesh in Practice', '', '11:30am-12:15pm Rust Operators for Kubernetes', '', '13pm Bad Time Title Here',
    '', '25:00 Another Bad Time Title', '', '9:61 Bad Minutes Title Here', '', '12 PM Noon Talk About Kubernetes', '', '12 AM Midnight Talk About Kubernetes',
    '', '10:30 am Rust Operators for Kubernetes', '', '10:30 a m Rust Operators for Kubernetes', '', '10 . 30 Not A Time But A Title',
  ].join('\n'), 'times.txt', 'text/plain', DENVER],
  ['date headers of every shape', [
    'Tue, Nov 10, 2099', '9:00 AM', 'Scaling Prometheus to a Billion Series', '', 'MONDAY 10 • NOVEMBER', '10:30am', 'Running Postgres on Kubernetes Without Losing Sleep', '',
    '2099-11-11', '15:00', 'Inside the Kubernetes Scheduler', '', 'November 12th', '9:30am', 'Rust Operators for Kubernetes', '',
    'Nov 11 at 10:00am', 'Zero Trust Service Mesh in Practice', '', 'Day 1 - Tuesday', 'Kubernetes Scheduler Office Hours', '',
    'Thursday', '2pm', 'Inside the Kubernetes Scheduler: Deep Dive', '', '10:00am to 11:00am MST', 'Kubernetes Scheduler Office Hours', '',
    'Wed 11 Nov 2099 10:00', 'Zero Trust Service Mesh in Practice',
  ].join('\n'), '', '', DENVER],
  ['speaker labels, noise and drop labels', [
    'Inside the Kubernetes Scheduler', 'Moderator: Xavier Dupont', 'Track: Scheduling', 'Level: Advanced', 'Page 2 of 5', '',
    'Securing the Software Supply Chain with Sigstore', 'Panelists: Dana Kim, Lee Park, Ana Silva', 'By: nobody', '3/10', '12', 'Join the waitlist', '',
    'Kubernetes Scheduler Office Hours', 'Presenter : Ola Nordmann', 'Location: Hall C', 'Filling up', 'This session is full', '',
    'Remove from my schedule', 'Add it to your Google Calendar', 'More information', 'www.example.org/path', 'not.an.email@', 'two@at@signs.org',
  ].join('\n'), '', '', DENVER],
  ['lists with separators', [
    'Inside the Kubernetes Scheduler - Xavier Dupont', 'Rust Operators for Kubernetes | Arjun Mehta', 'Zero Trust Service Mesh in Practice – Pablo Ruiz – Wed',
    'Scaling Prometheus to a Billion Series — Priya Raman, Sam Okafor', 'Lightning Talk: GitOps in 5 Minutes - Chris Doe - Thu - 5pm',
    'A - - Strange - Line With Dashes', 'Café Résumé: Naïve Approaches to Observability – José Núñez',
  ].join('\n'), 'list.txt', '', DENVER],
  ['Unicode spaces, separators and punctuation', [
    'Inside the Kubernetes​Scheduler', '', '  Rust Operators\tfor Kubernetes　', '',
    'Zero Trust Service Mesh in Practice', '', '“Scaling Prometheus to a Billion Series”', '', '••• Lightning Talk: GitOps in 5 Minutes :::', '',
    '(Securing the Software Supply Chain with Sigstore)', '', '﻿Kubernetes Scheduler Office Hours', '', '— — Running Postgres on Kubernetes Without Losing Sleep —,;',
  ].join('\n'), '', '', DENVER],
  ['accents, other scripts and emoji', [
    'CAFÉ RÉSUMÉ: NAÏVE APPROACHES TO OBSERVABILITY', '', 'eBPF fur Einsteiger: Netzwerke verstehen', '', 'クラウドネイティブ入門 Kubernetes Basics', '',
    '🚀 Scaling Prometheus 🚀 to a Billion Series', '', '10:00 🔥🔥 Zero Trust Service Mesh in Practice', '', '9:00 é Rust Operators for Kubernetes', '',
    'İstanbul Kubernetes Scheduler Office Hours', '', 'Ⅻ Roman Numeral Talk Kubernetes',
  ].join('\n'), '', '', DENVER],
  ['wrapped items and long lines', [
    'Running Postgres', 'on Kubernetes', 'Without Losing', 'Sleep', '', 'Securing the Software', 'Supply Chain', 'with Sigstore', 'Dana Kim', 'Lee Park', '',
    `Inside the Kubernetes Scheduler ${'and more words '.repeat(100)}`, '', `${'x'.repeat(1200)} Rust Operators for Kubernetes`,
  ].join('\n'), '', '', DENVER],
  ['crlf and lone carriage returns', 'Inside the Kubernetes Scheduler\r\n\r\nRust Operators for Kubernetes\rZero Trust Service Mesh in Practice\r\r9:30am Scaling Prometheus to a Billion Series', '', '', DENVER],
  ['a time zone east of UTC', 'Wednesday, November 11, 2099\n\n10:00 Zero Trust Service Mesh in Practice\n', '', '', { start_date: '2099-11-10', time_zone: 'Asia/Kolkata' }],
  ['an unknown time zone', 'Wednesday, November 11, 2099\n\n10:00 Zero Trust Service Mesh in Practice\n', '', '', { start_date: '2099-11-10', time_zone: 'Mars/Olympus' }],
  ['no time zone and no start date', 'November 11\n\n3:00 PM Inside the Kubernetes Scheduler\n', '', '', { start_date: null, time_zone: null }],

  // iCalendar.
  ['iCalendar of every shape', ics(
    ev('DTSTART;TZID=America/Denver:20991111T150000', 'SUMMARY:Inside the Kubernetes\r\n  Scheduler   -   Xavier\r\n  Dupont', 'DESCRIPTION:Speakers: Xavier Dupont\\, Example Inc.\\nRoom 1'),
    ev('DTSTART:20991112T163000Z', 'summary:Rust Operators for Kubernetes', 'description:Arjun Mehta'),
    ev('DTSTART;TZID="Europe/Berlin":20991110T090000', 'SUMMARY:Scaling Prometheus to a Billion Series'),
    ev('DTSTART;VALUE=DATE:20991111', 'SUMMARY:Zero Trust Service Mesh in Practice'),
    ev('DTSTART;TZID=Nowhere/Land:20991111T170000', 'SUMMARY:Lightning Talk\\: GitOps in 5 Minutes \\; quick'),
    ev('DTSTART:20991340T150000Z', 'SUMMARY:Kubernetes Scheduler Office Hours'),
    ev('SUMMARY:'),
    'BEGIN:VEVENT\r\nSUMMARY:An event that never ends Kubernetes Scheduler',
    ev('DTSTART:20991110T200000Z', 'SUMMARY:Café Résumé\\, Naïve Approaches to Observability', 'X-WEIRD;PARAM=a:b:c', 'SUMMARY;LANGUAGE=en:Café Résumé: Naïve Approaches to Observability'),
  ), 'cal.ics', 'text/calendar', DENVER],
  ['iCalendar with leading white space and a BOM', `﻿  \n${ics(ev('SUMMARY:Rust Operators for Kubernetes'))}`, 'x.ics', '', DENVER],

  // CSV.
  ['CSV with date and time columns', [
    'Session Name,Presenters,Date,Time,Room',
    'Inside the Kubernetes Scheduler,Xavier Dupont,11/11/2099,3:00 PM,Hall B',
    '"Rust Operators for Kubernetes","Arjun Mehta",2099-11-12,9:30am,"Room 1"',
    'Zero Trust Service Mesh in Practice,Pablo Ruiz,"Nov 11, 2099",10am,',
    '"Scaling Prometheus to a ""Billion"" Series",Priya Raman,"Tuesday, November 10th, 2099",09:00,',
    '',
    '"Securing the Software Supply Chain\nwith Sigstore","Dana Kim, Lee Park",2099-11-12,4:30 PM,',
  ].join('\r\n'), 'export.csv', 'text/csv', DENVER],
  ['CSV with a start column and offsets', [
    'Talk Title;Speaker;Start',
    'Inside the Kubernetes Scheduler;Xavier Dupont;2099-11-11T22:00:00Z',
    'Rust Operators for Kubernetes;Arjun Mehta;2099-11-12T09:30-0700',
    'Running Postgres on Kubernetes Without Losing Sleep;Alice Moreau;2099-11-10 10:30',
    'Zero Trust Service Mesh in Practice;Pablo Ruiz;2099-11-31 10:00',
    'Kubernetes Scheduler Office Hours;Ola Nordmann;2099-11-11T15:00:00+24:00',
    'Lightning Talk: GitOps in 5 Minutes;Chris Doe;2099-11-11T24:00:00Z',
  ].join('\n'), 'semi.csv', '', DENVER],
  ['CSV detected from its header', '﻿Event Title\tSpeakers\nInside the Kubernetes Scheduler\tXavier Dupont\nRust Operators for Kubernetes\tArjun Mehta\n', 'pasted', '', DENVER],
  ['CSV without a title column', 'a,b,c\nInside the Kubernetes Scheduler,Rust Operators for Kubernetes - Arjun Mehta,x\n,,\n"Zero Trust Service Mesh in Practice",9,10\n', 'cells.csv', '', DENVER],
  ['CSV with a title-like header word', 'id,Session Title Text,Speakers\n1,Inside the Kubernetes Scheduler,Xavier Dupont\n2,Kubernetes Scheduler Office Hours,Ola Nordmann\n', 'x.CSV', '', DENVER],
  ['TSV by name', 'title,speaker\tother\nInside the Kubernetes Scheduler\tx\n', 'notes.TSV', '', DENVER],
  ['altered titles: every confidence label', [
    'Title,Speakers,Start',
    'The Kubernetes Scheduler from the Inside,Xavier Dupont,',
    'Office Hours for the Kubernetes Scheduler,,2099-11-11 15:00',
    'Office Hours for the Kubernetes Scheduler Again,,2099-11-11 16:00',
    'Rust Kubernetes Operators Workshop,Somebody Else Entirely,',
    'Kubernetes Without Sleep Running Postgres,Alice Moreau,2099-11-10T17:30:00Z',
    'Billion Series Scaling Prometheus,Sam Okafor Priya Raman,',
  ].join('\n'), 'altered.csv', '', DENVER],
  ['a start a few seconds past the minute', ics(ev('DTSTART:20991111T170030Z', 'SUMMARY:Zero Trust Service Mesh Practice')), 'x.ics', '', DENVER],

  // JSON.
  ['Sessionize view/All', JSON.stringify({
    sessions: [
      { id: '1', title: 'Rust Operators for Kubernetes', speakers: ['s1'], startsAt: '2099-11-12T09:30:00' },
      { id: '2', title: 'Running Postgres on Kubernetes Without Losing Sleep', speakers: ['s2', 's3'], startsAt: '2099-11-10T17:30:00Z' },
      { id: '3', title: '   ', speakers: [] },
    ],
    speakers: [{ id: 's1', fullName: 'Arjun Mehta' }, { id: 's2', fullName: 'Alice Moreau' }, { id: 's3', fullName: 'Bjorn Ek' }],
  }), 'sessionize.json', 'application/json', DENVER],
  ['Sched export and odd values', JSON.stringify([
    { name: 'Inside the Kubernetes Scheduler', event_start: '2099-11-11 15:00', speakers: [{ name: 'Xavier Dupont' }, { fullName: 'Mei Lin' }, 7, ['nested']] },
    { name: 'Zero Trust Service Mesh in Practice', speaker: 'Pablo Ruiz', start_time: 'Nov 11, 2099 10:00 AM' },
    { session: 'Scaling Prometheus to a Billion Series', presenters: 'Priya Raman', moderators: ['Sam Okafor'], dtstart: 42 },
    'Kubernetes Scheduler Office Hours',
    { title: 5, name: 'Lightning Talk: GitOps in 5 Minutes', speaker: true },
    { nested: { deeper: { title: 'Securing the Software Supply Chain with Sigstore', startsAt: '2099-11-12T16:30:00-07:00' } } },
  ]), 'sched.json', '', DENVER],
  ['JSON keys that are array indexes', '{"b":{"title":"Rust Operators for Kubernetes"},"2":{"title":"Zero Trust Service Mesh in Practice"},"10":{"title":"Inside the Kubernetes Scheduler"},"1":{"title":"Kubernetes Scheduler Office Hours"},"01":{"title":"Scaling Prometheus to a Billion Series"},"a":{"title":"Running Postgres on Kubernetes Without Losing Sleep"}}', 'keys.json', '', DENVER],
  ['JSON nested too deep', JSON.stringify([[[[[[[[[[{ title: 'Inside the Kubernetes Scheduler' }]]]]]]]]], { a: { b: { c: { d: { e: { f: { g: { title: 'Rust Operators for Kubernetes' } } } } } } } }]), 'deep.json', '', DENVER],
  ['JSON that does not parse is text', '[ Inside the Kubernetes Scheduler,\nRust Operators for Kubernetes ]', '', '', DENVER],
  ['a JSON string is text', '"Inside the Kubernetes Scheduler"', '', '', DENVER],
];

function kotlinString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x22) out += '\\"';
    else if (c === 0x24) out += '\\$';
    else if (c >= 0x20 && c < 0x7f) out += s[i];
    else out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `${out}"`;
}

const store = { talksEpoch: 1, talks: () => TALKS, topics: () => ({ labels: new Map() }) };

const rows = CASES.map(([name, text, filename, mime, conf]) => {
  const conference = { slug: EVENT, start_date: conf.start_date, time_zone: conf.time_zone };
  const content = text.replace(/^﻿/, '');
  const { format, value } = textFormat(content, filename, mime);
  let entries;
  if (format === 'ics') entries = icsEntries(content, conference);
  else if (format === 'json') entries = jsonEntries(value, conference);
  else if (format === 'csv') entries = csvEntries(content, conference, filename);
  else entries = textEntries(content, conference);
  const candidates = buildCandidates(entries.slice(0, MAX_ENTRIES)).map((c) => ({
    text: c.text,
    entries: [...c.entries],
    exact: c.exact,
    context: c.context,
    hint: c.hint ? Date.parse(c.hint) : null,
  }));
  const result = runImport({ slug: EVENT, conf: conference, store }, { bytes: null, text, filename, mime });
  const expected = {
    format,
    entries: entries.length,
    candidates,
    matched: result.matched.map((m) => ({ talk_id: m.talk.talk_id, confidence: m.confidence, excerpt: m.matched_text_excerpt })),
    unmatched_count: result.unmatched_count,
    extracted_chars: result.extracted_chars,
  };
  return { name, text, filename, mime, zone: conf.time_zone, startDate: conf.start_date, expected: JSON.stringify(expected) };
});

let kt = '';
kt += '// Generated by native/shared/scripts/generate-import-fixtures.mjs. Do not edit.\n';
kt += 'package app.conferencecaddie.shared.importer\n\n';
kt += '/**\n';
kt += ' * Schedule files and what the Worker\'s in-memory import (worker/src/talks/import.js and import-parse.js)\n';
kt += ` * makes of them over [talks]: ${rows.length} cases. [Case.expected] is JSON: the format, the number of\n`;
kt += ' * entries, the candidates (text, entries, exact, context, hint in milliseconds) and the matches.\n';
kt += ' */\n';
kt += 'internal object ImportParityFixtures {\n';
kt += `    const val EVENT = ${kotlinString(EVENT)}\n\n`;
kt += '    class Talk(val n: Int, val kind: String, val title: String, val speakers: List<String>, val start: String)\n\n';
kt += '    val talks: List<Talk> = listOf(\n';
TALKS.forEach((t, i) => {
  const local = new Date(t.start_ms - 7 * 3600_000).toISOString().slice(0, 19) + '-07:00';
  kt += `        Talk(${i + 1}, ${kotlinString(t.kind)}, ${kotlinString(t.title)}, listOf(${t.speakers.map(kotlinString).join(', ')}), ${kotlinString(local)}),\n`;
});
kt += '    )\n\n';
kt += '    class Case(val name: String, val text: String, val filename: String, val mime: String, val zone: String?, val startDate: String?, val expected: String)\n\n';
kt += '    val cases: List<Case> = listOf(\n';
for (const r of rows) {
  if ((r.text.length + r.expected.length) * 3 > 60_000) throw new Error(`"${r.name}" is too long for one JVM string constant`);
  kt += `        Case(\n            ${kotlinString(r.name)},\n            ${kotlinString(r.text)},\n            ${kotlinString(r.filename)},\n`;
  kt += `            ${kotlinString(r.mime)},\n            ${r.zone === null ? 'null' : kotlinString(r.zone)},\n            ${r.startDate === null ? 'null' : kotlinString(r.startDate)},\n`;
  kt += `            ${kotlinString(r.expected)},\n        ),\n`;
}
kt += '    )\n}\n';
writeFileSync(OUT, kt);
console.log(`${path.relative(ROOT, OUT)}: ${rows.length} cases, ${rows.reduce((n, r) => n + JSON.parse(r.expected).candidates.length, 0)} candidates, ` +
  `${rows.reduce((n, r) => n + JSON.parse(r.expected).matched.length, 0)} matches`);
