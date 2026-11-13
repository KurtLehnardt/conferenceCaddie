// The Demo label of a demo conference (web/src/components/demo.ts): which conference entries count
// as a demo, the words of the label and of notifications, and the pill and the note as the screens
// draw them (rendered with Preact into the small DOM of dom.mjs).
//
// Run with `npm --prefix web test`. The parity screenshots cover the screens in a browser.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byTag, draw, spokenText, visibleText } from './dom.mjs';
import {
  DEMO_LABEL,
  DEMO_NOTE,
  DEMO_SPOKEN,
  DemoNote,
  DemoPill,
  demoBody,
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

test('a notification of a demo conference is titled "Conference Caddie (Demo)" and its body starts with "Demo: "', () => {
  assert.equal(demoTitle('Conference Caddie', true), 'Conference Caddie (Demo)');
  assert.equal(demoTitle('Conference Caddie', false), 'Conference Caddie');
  assert.equal(demoTitle('Conference Caddie', true), demoName('Conference Caddie', true), 'one rule for names and titles');
  assert.equal(demoBody('Someone is near you', true), 'Demo: someone is near you', 'lower case after the prefix, as the server writes it');
  assert.equal(demoBody('Someone is near you', false), 'Someone is near you');
});

test('the Bluetooth nudge of a demo conference follows the notification rule', async () => {
  // A copy of ble.ts of its own (the query), with the conference list kept on this device.
  const { nearbyBody, nearbyText, nearbyTitle, NEARBY_TITLE } = await import('../src/people/ble.ts?demo-title');
  storeConferences([
    { ...REAL, slug: 'real-2099' },
    { ...DEMO, slug: 'demo-2099' },
    { ...REAL, slug: 'odd-2099', demo: 'true' },
  ]);
  try {
    assert.equal(NEARBY_TITLE, 'Conference Caddie');
    assert.equal(nearbyTitle('demo-2099'), 'Conference Caddie (Demo)');
    assert.equal(nearbyBody('demo-2099', 'eBPF'), "Demo: someone who's worked on eBPF is right near you");
    assert.equal(nearbyTitle('real-2099'), 'Conference Caddie');
    assert.equal(nearbyBody('real-2099', 'eBPF'), nearbyText('eBPF'));
    assert.equal(nearbyTitle('odd-2099'), 'Conference Caddie');
    assert.equal(nearbyTitle('unknown-2099'), 'Conference Caddie');
  } finally {
    localStorage.clear();
  }
});

test("the companion app's service is told when it runs for a demo conference", async () => {
  const { startOptions } = await import('../src/people/ble.ts?demo-start');
  storeConferences([
    { ...REAL, slug: 'real-2099' },
    { ...DEMO, slug: 'demo-2099' },
  ]);
  try {
    const demo = startOptions('demo-2099', 'dG9rZW4');
    assert.equal(demo.demo, true);
    assert.equal(demo.token, 'dG9rZW4');
    assert.equal(demo.scan, true);
    assert.equal(startOptions('real-2099', 'dG9rZW4').demo, false);
    assert.equal(startOptions('unknown-2099', 'dG9rZW4').demo, false);
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
  assert.equal(DemoPill({}), null, 'no pill unless asked for');
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

// --- Rendered ----------------------------------------------------------------------------------

/** A conference entry of GET /api/conferences, a demo one when [demo]. */
function conference(demo, extra = {}) {
  return {
    slug: demo ? 'caddie-demo-conference' : 'sample-cloud-summit-2026',
    name: demo ? 'Caddie Demo Conference' : 'Sample Cloud Summit',
    start_date: '2026-11-11',
    end_date: '2026-11-13',
    time_zone: 'UTC',
    location: { city: 'Demo City', region: '', country: '', virtual: false },
    status: 'searchable',
    official_schedule_url: demo ? null : 'https://example.invalid/schedule/',
    source: demo ? 'demo' : 'sessionize',
    has_level: false,
    track_group: 'Track',
    tag_groups: [],
    talk_count: 1,
    ...(demo ? { demo: true } : {}),
    ...extra,
  };
}

/** A talk of [c], without an official page when [url] is null. */
function talkOf(c, url, kind = 'talk') {
  return {
    talk_id: `${c.slug}:1`,
    conference: c.slug,
    title: 'Kubernetes upgrades without the drama',
    speakers: ['Ada Inventa'],
    room: 'Demo Hall',
    start: '2026-11-12T09:00:00+00:00',
    end: '2026-11-12T09:30:00+00:00',
    track: 'Demo Track',
    level: null,
    tags: [],
    slides_url: null,
    url,
    kind,
  };
}

const links = (root) => byTag(root, 'a').map((a) => visibleText(a).trim());

test('the pill and the note render with their words, read as on the native apps', () => {
  const pill = draw(DemoPill, { demo: true });
  try {
    const [span] = byClass(pill.root, 'demo-pill');
    assert.equal(visibleText(span), 'Demo');
    assert.equal(spokenText(span), DEMO_SPOKEN, 'screen readers hear the full words, not "Demo"');
    assert.equal(span.getAttribute('title'), DEMO_SPOKEN);
  } finally {
    pill.unmount();
  }
  const note = draw(DemoNote, { conference: DEMO });
  try {
    const [p] = byClass(note.root, 'demo-note');
    assert.equal(byClass(p, 'demo-pill').length, 1);
    assert.equal(visibleText(p), `Demo${DEMO_NOTE}`);
  } finally {
    note.unmount();
  }
  for (const c of [REAL, { ...REAL, demo: 'true' }, null]) {
    const none = draw(DemoNote, { conference: c });
    assert.equal(none.root.childNodes.length, 0, `no note for ${JSON.stringify(c)}`);
    none.unmount();
  }
});

test('a demo talk card shows the pill, says Demo in its heading and links nowhere without a URL', async () => {
  const { TalkCard } = await import('../src/components/talk.tsx');
  const demo = conference(true);
  const card = draw(TalkCard, { talk: talkOf(demo, null), conference: demo, interested: false, onToggleInterested: () => {} });
  try {
    const [article] = byTag(card.root, 'article');
    assert.ok(article.firstChild.classes.includes('card-demo'), 'the pill row comes first');
    assert.equal(byClass(article.firstChild, 'demo-pill').length, 1);
    const [heading] = byTag(article, 'h3');
    assert.equal(visibleText(heading), 'Kubernetes upgrades without the drama');
    assert.equal(spokenText(heading), 'Kubernetes upgrades without the drama, Demo conference');
    assert.ok(!links(card.root).includes('Add to my schedule on the official site'), 'no official link without a URL');
  } finally {
    card.unmount();
  }

  const event = draw(TalkCard, { talk: talkOf(demo, null, 'ambient'), conference: demo, interested: false, onToggleInterested: () => {} });
  try {
    assert.equal(byClass(event.root, 'demo-pill').length, 1);
    assert.ok(!links(event.root).includes('Details on the official site'));
  } finally {
    event.unmount();
  }

  const real = conference(false);
  const plain = draw(TalkCard, { talk: talkOf(real, 'https://example.invalid/talk/1'), conference: real, interested: false, onToggleInterested: () => {} });
  try {
    assert.equal(byClass(plain.root, 'demo-pill').length, 0, 'a real conference has no pill');
    assert.equal(spokenText(byTag(plain.root, 'h3')[0]), 'Kubernetes upgrades without the drama');
    assert.ok(links(plain.root).includes('Add to my schedule on the official site'));
  } finally {
    plain.unmount();
  }
});

test('the switcher names the demo conference with the pill and lists it without a link when it has no schedule page', async () => {
  const { SwitcherButton, SwitcherSheet } = await import('../src/components/switcher.tsx');
  const button = draw(SwitcherButton, { name: 'Caddie Demo Conference', demo: true, onOpen: () => {} });
  try {
    assert.equal(spokenText(byTag(button.root, 'button')[0]), `Caddie Demo Conference${DEMO_SPOKEN}, change conference`);
  } finally {
    button.unmount();
  }

  const conferences = [
    conference(false),
    conference(true),
    conference(true, { slug: 'old-demo', name: 'Old Demo', status: 'unavailable' }),
    conference(false, { slug: 'old-real', name: 'Old Real', status: 'unavailable' }),
  ];
  const sheet = draw(SwitcherSheet, { open: true, conferences, current: 'caddie-demo-conference', error: null, onPick: () => {}, onClose: () => {} });
  try {
    const row = (name) => byClass(sheet.root, 'conf-row').find((r) => byClass(r, 'conf-name').some((n) => visibleText(n) === name));
    assert.equal(byClass(row('Caddie Demo Conference'), 'demo-pill').length, 1);
    assert.equal(byClass(row('Sample Cloud Summit'), 'demo-pill').length, 0);
    const old = row('Old Demo');
    assert.equal(old.localName, 'div', 'no link without an official schedule page');
    assert.ok(old.classes.includes('conf-row-static'));
    assert.equal(byClass(old, 'demo-pill').length, 1);
    assert.equal(row('Old Real').localName, 'a');
    assert.equal(row('Old Real').getAttribute('href'), 'https://example.invalid/schedule/');
  } finally {
    sheet.unmount();
  }
});

test("Settings' people groups of a demo conference open with the note", async () => {
  const { SettingsPeopleGroups } = await import('../src/people/SettingsGroups.tsx');
  const demo = draw(SettingsPeopleGroups, { conference: conference(true) });
  try {
    assert.ok(demo.root.firstChild.classes.includes('demo-note'), 'the note comes before the groups');
    assert.ok(demo.root.childNodes.length > 1, 'the groups follow it');
  } finally {
    demo.unmount();
  }
  const real = draw(SettingsPeopleGroups, { conference: conference(false) });
  try {
    assert.equal(byClass(real.root, 'demo-note').length, 0);
  } finally {
    real.unmount();
  }
  localStorage.clear();
});
