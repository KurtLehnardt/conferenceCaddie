// The Demo label of a demo conference (web/src/components/demo.ts): which conference entries count
// as a demo, the pill's markup and words, and the note at the top of the people screens.
//
// Run with `npm --prefix web test`. The screens that show the pill are JSX, which node --test
// cannot load, so the pill and the note are tested here as elements, and a check on the screens'
// sources makes sure each still shows them. The parity screenshots cover them in a browser.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEMO_LABEL,
  DEMO_NOTE,
  DEMO_SPOKEN,
  DemoNote,
  DemoPill,
  demoName,
  demoNoteFor,
  demoPill,
  demoPillFor,
  demoTitle,
  isDemo,
} from '../src/components/demo.ts';
import { loadInterested, storeConferences, storeInterested } from '../src/lib/storage.ts';

const REAL = { slug: 'sample-cloud-summit-2026', name: 'Sample Cloud Summit' };
const DEMO = { slug: 'caddie-demo-conference', name: 'Caddie Demo Conference', demo: true };

test('only "demo": true marks a demo conference', () => {
  assert.equal(isDemo(DEMO), true);
  assert.equal(isDemo({ ...REAL, demo: true }), true);
});

test('a missing demo field, or any value but true, is a real conference', () => {
  assert.equal(isDemo(REAL), false, 'absent');
  for (const value of ['true', 1, false, null, {}, [], 'demo', 0, '']) {
    assert.equal(isDemo({ ...REAL, demo: value }), false, `demo: ${JSON.stringify(value)}`);
  }
  assert.equal(isDemo(null), false);
  assert.equal(isDemo(undefined), false);
});

test('a conference read from JSON keeps the rule', () => {
  const list = JSON.parse(
    '[{"slug":"a","demo":true},{"slug":"b"},{"slug":"c","demo":"true"},{"slug":"d","demo":false},{"slug":"e","demo":1}]',
  );
  assert.deepEqual(
    list.map((c) => isDemo(c)),
    [true, false, false, false, false],
  );
});

test('demoName adds "(Demo)" for a demo conference only', () => {
  assert.equal(demoName('Caddie Demo Conference', true), 'Caddie Demo Conference (Demo)');
  assert.equal(demoName('Sample Cloud Summit', false), 'Sample Cloud Summit');
});

test('a notification of a demo conference says so in its title', () => {
  assert.equal(demoTitle('Conference Caddie', true), 'Conference Caddie · Demo conference');
  assert.equal(demoTitle('Conference Caddie', false), 'Conference Caddie');
});

test('the Bluetooth nudge of a demo conference is titled "Conference Caddie · Demo conference"', async () => {
  // A copy of ble.ts of its own (the query), with the conference list kept on this device.
  const { nearbyTitle, NEARBY_TITLE } = await import('../src/people/ble.ts?demo-title');
  storeConferences([
    { ...REAL, slug: 'real-2099' },
    { ...DEMO, slug: 'demo-2099' },
    { ...REAL, slug: 'odd-2099', demo: 'true' },
  ]);
  try {
    assert.equal(NEARBY_TITLE, 'Conference Caddie');
    assert.equal(nearbyTitle('demo-2099'), 'Conference Caddie · Demo conference');
    assert.equal(nearbyTitle('real-2099'), 'Conference Caddie');
    assert.equal(nearbyTitle('odd-2099'), 'Conference Caddie');
    assert.equal(nearbyTitle('unknown-2099'), 'Conference Caddie');
  } finally {
    localStorage.clear();
  }
});

test('a demo talk without an official page stays on the Interested list', () => {
  const talk = (n, url) => ({
    talk_id: `caddie-demo-conference:${n}`,
    conference: 'caddie-demo-conference',
    title: `Demo talk ${n}`,
    speakers: ['Ada Inventa'],
    room: 'Demo Hall',
    start: '2026-11-12T09:00:00+00:00',
    end: '2026-11-12T09:30:00+00:00',
    track: 'Demo Track',
    level: null,
    tags: [],
    slides_url: null,
    url,
    marked_at: '2026-11-12T08:00:00.000Z',
  });
  storeInterested('caddie-demo-conference', [talk(1, null), talk(2, 'https://example.invalid/2'), talk(3, 42)]);
  try {
    assert.deepEqual(
      loadInterested('caddie-demo-conference').map((t) => [t.talk_id, t.url]),
      [
        ['caddie-demo-conference:1', null],
        ['caddie-demo-conference:2', 'https://example.invalid/2'],
      ],
    );
  } finally {
    localStorage.clear();
  }
});

test('the pill says Demo and is read as "Demo conference, invented data", as on the native apps', () => {
  assert.equal(DEMO_LABEL, 'Demo');
  assert.equal(DEMO_SPOKEN, 'Demo conference, invented data');
  assert.equal(DEMO_NOTE, 'A demo conference with invented talks and speakers, not a real event.');
  const pill = demoPill();
  assert.equal(pill.type, 'span');
  assert.equal(pill.props.class, 'demo-pill');
  assert.equal(pill.props.title, DEMO_SPOKEN);
  const [visible, spoken] = pill.props.children;
  assert.equal(visible.type, 'span');
  assert.equal(visible.props['aria-hidden'], 'true');
  assert.equal(visible.props.children, 'Demo');
  assert.equal(spoken.props.class, 'sr-only');
  assert.equal(spoken.props.children, DEMO_SPOKEN);
});

test('the pill and the note show for a demo conference and for nothing else', () => {
  assert.equal(demoPillFor(DEMO).props.class, 'demo-pill');
  assert.equal(demoPillFor(REAL), null);
  assert.equal(demoPillFor({ ...REAL, demo: 'true' }), null);
  assert.equal(demoPillFor(null), null);
  assert.equal(DemoPill({ demo: true }).props.class, 'demo-pill');
  assert.equal(DemoPill({}).props.class, 'demo-pill');
  assert.equal(DemoPill({ demo: false }), null);

  const note = demoNoteFor(DEMO);
  assert.equal(note.type, 'p');
  assert.equal(note.props.class, 'demo-note');
  const [pill, text] = note.props.children;
  assert.equal(pill.props.class, 'demo-pill');
  assert.equal(text.props.class, 'demo-note-text');
  assert.equal(text.props.children, DEMO_NOTE);
  assert.equal(demoNoteFor(REAL), null);
  assert.equal(demoNoteFor({ ...REAL, demo: 1 }), null);
  assert.equal(DemoNote({ conference: DEMO }).props.class, 'demo-note');
  assert.equal(DemoNote({ conference: REAL }), null);
});

test('every surface of a demo conference still shows the pill or the note', () => {
  const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  // The app bar: after the conference name, and after the titles of Profile, Requests and Meet up.
  const app = src('app.tsx');
  assert.match(app, /<SwitcherButton[\s\S]*?demo=\{demo\}/);
  for (const title of ['Profile', 'Requests', 'Meet up']) {
    assert.match(app, new RegExp(`${title}\\s*<DemoPill demo=\\{demo\\} />`), `${title} has the pill`);
  }
  // Every conference screen opens with the note, before the Search and Schedule switch.
  const note = app.indexOf('<DemoNote conference={searchable} />');
  assert.ok(note > app.indexOf(') : !searchable ? ('), 'the note is in the screens of a searchable conference');
  assert.ok(note < app.indexOf('class="view-switch"'), 'the note is above the Search and Schedule switch');
  assert.match(app, /demoName\(conference\.name, isDemo\(conference\)\)/);
  // The switcher's rows and button.
  const switcher = src('components/switcher.tsx');
  assert.equal((switcher.match(/\{demoPillFor\(c\)\}/g) ?? []).length, 2);
  assert.match(switcher, /<DemoPill demo=\{demo\} \/>/);
  // Full talk cards, both kinds, carry the pill above the title.
  const talk = src('components/talk.tsx');
  assert.match(talk, /const demo = demoPillFor\(conference\);/);
  assert.equal((talk.match(/\{demoRow\}/g) ?? []).length, 2);
  // Both pages of Import my schedule open with the note.
  assert.equal((src('components/import.tsx').match(/<DemoNote conference=\{conference\} \/>/g) ?? []).length, 2);
});
