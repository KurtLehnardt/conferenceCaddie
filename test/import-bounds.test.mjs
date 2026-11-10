// The bounds of POST /api/import/schedule (server/import.mjs), run against an in-memory stand-in
// for Elasticsearch.
//
// Run with `npm test`. Nothing here reaches the network: fetch is replaced before
// server/import.mjs is imported, every Elasticsearch call is answered from memory, and a call to
// any other host fails the test. The key and the URL are dummy values.
//
// - Inputs that made a regular expression backtrack for 10 to 20 seconds and block the event
//   loop (an 8 KB line of "@.", a 150 KB run of colons, a 200 KB iCalendar SUMMARY and a 200 KB
//   CSV cell of spaces or colons) each finish in under half a second.
// - A worst-case 5 MB upload (1.7 million short lines, one 5 MB line, a million "By:" lines, a
//   5 MB headerless CSV, a 5 MB quoted CSV cell, a 5 MB iCalendar event, a JSON array of a
//   million strings) imports in a child process whose V8 heap is capped at 64 MB, about twice
//   what the import needs now. Before the bounds every case but the iCalendar one ran out of that
//   heap, and three uploads of short lines at once used about a gigabyte, more than the 512 MB
//   container has. The iCalendar case guards that path's bound; it fitted before as well.
// - The bounds keep the results of ordinary files: the candidates sent to Elasticsearch, with
//   their speaker text and time hints, and the matches. These pass against the code before the
//   bounds too.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const ES_HOST = 'es.caddie.test';
Object.assign(process.env, { ES_URL: `https://${ES_HOST}`, ES_API_KEY: 'dummy-read-key', ES_INDEX: 'caddie-talks' });

const EVENT = 'testconf-2099';
const TALKS = [
  ['Inside the Kubernetes Scheduler', ['Xavier Dupont'], '2099-11-11T15:00:00-07:00'],
  ['Rust Operators for Kubernetes', ['Arjun Mehta'], '2099-11-12T09:30:00-07:00'],
  ['Running Postgres on Kubernetes Without Losing Sleep', ['Alice Moreau', 'Bjorn Ek'], '2099-11-10T10:30:00-07:00'],
  ['Zero Trust Service Mesh in Practice', ['Pablo Ruiz'], '2099-11-11T10:00:00-07:00'],
].map(([title, speakers, start], i) => ({ talk_id: `${EVENT}:t${i + 1}`, conference: EVENT, kind: 'talk', title, speakers, start: new Date(start).toISOString(), topics: [] }));

const words = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
// The searches of the last _msearch, as { text, context, hint }.
let sent = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.host !== ES_HOST) throw new Error(`unexpected request to ${url.host}`);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/caddie-conferences/_search') {
    return json({ hits: { hits: [{ _source: { slug: EVENT, status: 'searchable', time_zone: 'America/Denver', start_date: '2099-11-10', end_date: '2099-11-12' } }] } });
  }
  if (url.pathname === '/caddie-topics/_search') return json({ hits: { hits: [] } });
  if (url.pathname === '/caddie-talks/_msearch') {
    const lines = String(init.body).split('\n').filter(Boolean);
    sent = [];
    const responses = [];
    for (let i = 1; i < lines.length; i += 2) {
      const q = JSON.parse(lines[i]).query.bool;
      const text = q.must[0].bool.should.at(-1).match.title.query;
      sent.push({ text, context: q.should.find((s) => s.match)?.match.speakers.query ?? null, hint: q.should.find((s) => s.range)?.range.start.gte ?? null });
      // A talk matches when the candidate's words appear in its title in order.
      const talk = TALKS.find((t) => ` ${words(t.title)} `.includes(` ${words(text)} `));
      responses.push({ hits: { hits: talk ? [{ _id: talk.talk_id, _score: 1, _source: talk, matched_queries: ['exact_title'] }] : [] } });
    }
    return json({ responses });
  }
  return json({ error: 'unexpected' }, 404);
};

const { handleImportApi } = await import('../server/import.mjs');

let ipCounter = 0;

// Runs one import and returns { status, body, ms }.
async function importSchedule(body) {
  const raw = JSON.stringify({ event: EVENT, ...body });
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { host: 'caddie.test', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) };
  ipCounter++;
  req.socket = { remoteAddress: `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` };
  const res = {
    headersSent: false,
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(chunk) {
      this.text = chunk === undefined ? '' : String(chunk);
    },
    destroy() {},
  };
  sent = [];
  const started = performance.now();
  const handled = await handleImportApi(req, res, new URL('/api/import/schedule', 'http://caddie.test'));
  const ms = performance.now() - started;
  assert.equal(handled, true);
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null, ms };
}

const file = (text, filename) => ({ filename, content_base64: Buffer.from(text, 'utf8').toString('base64') });
const ics = (...props) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...props, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const titlesOf = (body) => body.matched.map((m) => m.talk.title);

describe('inputs that used to backtrack finish quickly', () => {
  const K200 = 200_000;
  const cases = {
    'an 8 KB pasted line of "@."': { text: '@.'.repeat(4000) + ' x' },
    'a pasted 150 KB run of colons': { text: 'a' + ':'.repeat(150_000) + 'b' },
    'a pasted 150 KB run of spaces': { text: 'a' + ' '.repeat(150_000) + 'b' },
    'an iCalendar SUMMARY of 200 KB of spaces': file(ics('DTSTART:20991110T173000Z', `SUMMARY:a${' '.repeat(K200)}b`), 's.ics'),
    'an iCalendar SUMMARY of 200 KB of colons': file(ics('DTSTART:20991110T173000Z', `SUMMARY:a${':'.repeat(K200)}b`), 's.ics'),
    'an iCalendar DESCRIPTION of 200 KB of "@."': file(ics('SUMMARY:Inside the Kubernetes Scheduler', `DESCRIPTION:${'@.'.repeat(K200 / 2)} x`), 's.ics'),
    'a CSV title cell of 200 KB of spaces': file(`Title,Speakers\r\n"a${' '.repeat(K200)}b",x\r\n`, 's.csv'),
    'a CSV title cell of 200 KB of colons': file(`Title,Speakers\r\n"a${':'.repeat(K200)}b",x\r\n`, 's.csv'),
    'a headerless CSV cell of 200 KB of spaces': file(`x;"a${' '.repeat(K200)}b"\n`, 's.csv'),
    'a JSON title of 200 KB of spaces': file(JSON.stringify([{ title: `a${' '.repeat(K200)}b` }]), 's.json'),
  };
  for (const [name, body] of Object.entries(cases)) {
    test(name, async () => {
      const r = await importSchedule(body);
      assert.equal(r.status, 200);
      assert.ok(r.ms < 500, `took ${r.ms.toFixed(0)} ms`);
    });
  }

  test('a long title line still gives a candidate of at most 300 characters', async () => {
    const r = await importSchedule({ text: `Inside the Kubernetes Scheduler ${'x'.repeat(5000)}::::\n` });
    assert.equal(r.status, 200);
    assert.ok(sent.length > 0 && sent.every((s) => s.text.length <= 300));
  });
});

describe('a worst-case 5 MB upload fits in a 64 MB heap', () => {
  // Each case builds its file inside a child process whose V8 heap is capped, stubs fetch the same
  // way, and runs one import. A parser that holds the whole file as an array of lines or entries
  // runs out of heap and the child dies.
  const CHILD = `
    import { Readable } from 'node:stream';
    Object.assign(process.env, { ES_URL: 'https://${ES_HOST}', ES_API_KEY: 'dummy-read-key' });
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(String(input));
      if (u.host !== '${ES_HOST}') throw new Error('unexpected host');
      const json = (o) => new Response(JSON.stringify(o), { status: 200 });
      if (u.pathname === '/caddie-conferences/_search') return json({ hits: { hits: [{ _source: { slug: '${EVENT}', status: 'searchable', time_zone: 'UTC', start_date: '2099-11-10' } }] } });
      if (u.pathname.endsWith('/_msearch')) {
        const n = String(init.body).split('\\n').filter(Boolean).length / 2;
        return json({ responses: Array.from({ length: n }, () => ({ hits: { hits: [] } })) });
      }
      return json({ hits: { hits: [] } });
    };
    const { handleImportApi } = await import(process.env.IMPORT_MODULE);
    const [prefix, unit, suffix, filename] = JSON.parse(process.env.IMPORT_CASE);
    const size = 5 * 1024 * 1024 - prefix.length - suffix.length;
    let raw = JSON.stringify({ event: '${EVENT}', filename, content_base64: Buffer.from(prefix + unit.repeat(Math.floor(size / unit.length)) + suffix).toString('base64') });
    const req = Readable.from([Buffer.from(raw)]);
    req.method = 'POST';
    req.headers = { host: 'caddie.test', 'content-type': 'application/json', 'content-length': String(raw.length) };
    req.socket = { remoteAddress: '10.2.0.1' };
    raw = null;
    let status = 0;
    const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, end() {}, destroy() {} };
    await handleImportApi(req, res, new URL('/api/import/schedule', 'http://caddie.test'));
    console.log('status ' + status);
  `;
  const run = (spec) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', CHILD], {
        env: { PATH: process.env.PATH, IMPORT_MODULE: new URL('../server/import.mjs', import.meta.url).href, IMPORT_CASE: JSON.stringify(spec) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  const cases = {
    'plain text, 1.7 million short lines and no blank line': ['', 'ab\n', '', 's.txt'],
    'plain text, one 5 MB line': ['', 'ab ', '', 's.txt'],
    'plain text, a title and a million "By:" lines': ['Inside the Kubernetes Scheduler\n', 'By:ab\n', '', 's.txt'],
    'CSV without a header, 1.7 million cells': ['', 'ab,', '', 's.csv'],
    'CSV, one 5 MB quoted cell': ['Title,Speakers\n"', 'ab', '"\n', 's.csv'],
    'iCalendar, one event of 1.7 million lines': ['BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Inside the Kubernetes Scheduler\n', 'ab\n', 'END:VEVENT\nEND:VCALENDAR\n', 's.ics'],
    'JSON, an array of a million strings': ['[', '"ab",', '"x"]', 's.json'],
  };
  for (const [name, spec] of Object.entries(cases)) {
    test(name, async () => {
      const { code, out } = await run(spec);
      assert.equal(code, 0, out.slice(0, 300));
      assert.match(out, /status 200/);
    });
  }
});

describe('the bounds keep the results of ordinary files', () => {
  test('a pasted list of "Title — Speaker — Day time" lines', async () => {
    const text = [
      'My picks',
      'Inside the Kubernetes Scheduler — Xavier Dupont — Wed 15:00',
      'Rust Operators for Kubernetes — Arjun Mehta — Thu 9:30',
      'Running Postgres on Kubernetes Without Losing Sleep — Alice Moreau, Bjorn Ek — Tue 10:30',
      'Zero Trust Service Mesh in Practice — Pablo Ruiz — Wed 10:00',
      'A Talk That Is Not On The Schedule — Nobody — Thu 13:00',
    ].join('\n');
    const r = await importSchedule({ text });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), TALKS.map((t) => t.title));
    assert.equal(r.body.unmatched_count, 1);
    // A list of more than four lines is one entry per line: the line, then the part before the
    // speaker suffix, then the first part.
    assert.equal(sent[0].text, 'Inside the Kubernetes Scheduler — Xavier Dupont — Wed 15:00');
    assert.ok(sent.some((s) => s.text === 'Inside the Kubernetes Scheduler - Xavier Dupont' && s.context === 'Wed 15:00'));
    assert.ok(sent.some((s) => s.text === 'Inside the Kubernetes Scheduler'));
  });

  test('e-mail lines are dropped and other lines with an "@" are kept', async () => {
    const text = 'Inside the Kubernetes Scheduler\nxavier.dupont@example.com\n\nRust Operators for Kubernetes\nfirst.last@localhost';
    const r = await importSchedule({ text });
    assert.equal(r.status, 200);
    assert.deepEqual(sent.map((s) => s.text), ['Inside the Kubernetes Scheduler', 'Rust Operators for Kubernetes first.last@localhost', 'Rust Operators for Kubernetes']);
  });

  test('wrapped Sched-style items keep their time hint and speaker text', async () => {
    const text = 'Wednesday, November 11, 2099\n\n3:00pm – 3:30pm K Inside the Kubernetes\nScheduler\nSpeakers: Xavier Dupont\nRoom 250\n';
    const r = await importSchedule({ text });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0], { text: 'Inside the Kubernetes Scheduler', context: 'Xavier Dupont', hint: TALKS[0].start });
    assert.deepEqual(titlesOf(r.body), ['Inside the Kubernetes Scheduler']);
  });

  test('speaker text stops growing once it is long enough, and still holds the first names', async () => {
    const text = 'Inside the Kubernetes Scheduler\n' + 'Speakers: Xavier Dupont\n'.repeat(10_000);
    const r = await importSchedule(file(text, 'speakers.txt'));
    assert.equal(r.status, 200);
    assert.equal(sent[0].context, Array(30).fill('Xavier Dupont').join(' ').slice(0, 300));
  });

  test('a block of more lines than the entry limit gives exactly 3,000 entries', async () => {
    const r = await importSchedule(file('alpha beta gamma\n'.repeat(5000), 'list.txt'));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(r.body.unmatched_count, 3000);
  });

  test('an iCalendar event with folded lines, a TZID start and a speaker suffix', async () => {
    const body = file(ics('DTSTART;TZID=America/Denver:20991111T150000', 'SUMMARY:Inside the Kubernetes\r\n  Scheduler   -   Xavier\r\n  Dupont', 'DESCRIPTION:Speakers: Xavier Dupont\\, Example Inc.'), 'my.ics');
    const r = await importSchedule(body);
    assert.equal(r.status, 200);
    assert.deepEqual(sent.map((s) => s.text), ['Inside the Kubernetes Scheduler - Xavier Dupont', 'Inside the Kubernetes Scheduler']);
    assert.equal(sent[0].context, 'Xavier Dupont Speakers: Xavier Dupont, Example Inc.');
    assert.equal(sent[0].hint, TALKS[0].start);
    assert.deepEqual(titlesOf(r.body), ['Inside the Kubernetes Scheduler']);
  });

  test('CSV cells with runs of spaces still split into title and speaker', async () => {
    const csv = 'Title,Speakers,Start\r\n"Inside   the Kubernetes Scheduler   -   Xavier Dupont",Xavier Dupont,2099-11-11 15:00\r\nRust Operators for Kubernetes,Arjun Mehta,2099-11-12T16:30:00Z\r\n';
    const r = await importSchedule(file(csv, 'export.csv'));
    assert.equal(r.status, 200);
    assert.deepEqual(sent, [
      { text: 'Inside the Kubernetes Scheduler - Xavier Dupont', context: 'Xavier Dupont Xavier Dupont', hint: TALKS[0].start },
      { text: 'Rust Operators for Kubernetes', context: 'Arjun Mehta', hint: TALKS[1].start },
      { text: 'Inside the Kubernetes Scheduler', context: 'Xavier Dupont Xavier Dupont', hint: TALKS[0].start },
    ]);
    assert.deepEqual(titlesOf(r.body), ['Inside the Kubernetes Scheduler', 'Rust Operators for Kubernetes']);
  });

  test('Sessionize-style JSON with speakers listed by id', async () => {
    const json = JSON.stringify({
      sessions: [{ id: '1', title: 'Rust Operators for Kubernetes', speakers: ['s1'], startsAt: '2099-11-12T09:30:00' }],
      speakers: [{ id: 's1', fullName: 'Arjun Mehta' }],
    });
    const r = await importSchedule(file(json, 'sessionize.json'));
    assert.equal(r.status, 200);
    assert.deepEqual(sent, [{ text: 'Rust Operators for Kubernetes', context: 'Arjun Mehta', hint: TALKS[1].start }]);
    assert.deepEqual(titlesOf(r.body), ['Rust Operators for Kubernetes']);
  });
});

describe('pasted text with filename and mime hints, as the Worker accepts it', () => {
  const csvText = 'Session,Speaker\nInside the Kubernetes Scheduler,Xavier Dupont\nRust Operators for Kubernetes,Arjun Mehta\n';
  const two = ['Inside the Kubernetes Scheduler', 'Rust Operators for Kubernetes'];

  test('text with a .csv hint reads as CSV', async () => {
    const r = await importSchedule({ text: csvText, filename: 'my.csv', mime: 'text/csv' });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), two);
  });

  test('text with a .tsv hint reads as tab separated, even when commas outnumber tabs in the header', async () => {
    const text = 'Session, title\tSpeaker, name, role\nInside the Kubernetes Scheduler\tXavier Dupont\nRust Operators for Kubernetes\tArjun Mehta\n';
    const r = await importSchedule({ text, filename: 'my.tsv' });
    assert.equal(r.status, 200);
    assert.ok(titlesOf(r.body).includes('Rust Operators for Kubernetes'));
  });

  test('text with an ics hint and an iCalendar body reads as iCalendar', async () => {
    const r = await importSchedule({ text: ics('SUMMARY:Inside the Kubernetes Scheduler', 'DTSTART:20991111T220000Z'), filename: 'cal.ics', mime: 'text/calendar' });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), [TALKS[0].title]);
  });

  test('text without hints behaves as before', async () => {
    const r = await importSchedule({ text: 'My picks\nInside the Kubernetes Scheduler\nRust Operators for Kubernetes\n' });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), two);
  });

  test('the browser-extracted PDF shape { filename, mime: text/plain, text } is plain text', async () => {
    const r = await importSchedule({ text: 'Inside the Kubernetes Scheduler\nRust Operators for Kubernetes\n', filename: 'schedule.pdf', mime: 'text/plain' });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), two);
  });

  test('an unexpected mime falls back to content detection', async () => {
    const r = await importSchedule({ text: 'Inside the Kubernetes Scheduler\nRust Operators for Kubernetes\n', filename: 'x.bin', mime: 'application/octet-stream' });
    assert.equal(r.status, 200);
    assert.deepEqual(titlesOf(r.body), two);
  });

  test('hints are validated: a non-string or an overlong value gets 400', async () => {
    const t = 'Inside the Kubernetes Scheduler';
    assert.equal((await importSchedule({ text: t, filename: 5 })).status, 400);
    assert.equal((await importSchedule({ text: t, filename: 'a'.repeat(256) })).status, 400);
    assert.equal((await importSchedule({ text: t, mime: 'a'.repeat(128) })).status, 400);
  });

  test('unknown keys are still rejected, with or without hints', async () => {
    assert.equal((await importSchedule({ text: 'Inside the Kubernetes Scheduler', filename: 'a.csv', store: true })).status, 400);
  });

  test('text together with content_base64 is rejected, as in the Worker', async () => {
    const r = await importSchedule({ text: 'Inside the Kubernetes Scheduler', filename: 'a.txt', content_base64: Buffer.from('x').toString('base64') });
    assert.equal(r.status, 400);
  });

  test('size limits still apply with hints', async () => {
    const long = await importSchedule({ text: 'a'.repeat(200001), filename: 'a.csv', mime: 'text/csv' });
    assert.equal(long.status, 413);
    const empty = await importSchedule({ text: '   ', filename: 'a.csv' });
    assert.equal(empty.status, 422);
  });
});
