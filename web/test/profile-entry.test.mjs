// The standing Profile button in the People screen's app bar (web/src/people/profileEntry.ts) and
// where Back on the profile editor leads (profileBack in web/src/lib/route.ts).
//
// Run with `npm --prefix web test`. The app shell (app.tsx) is JSX, which node --test cannot load,
// so the element and the decision are tested here, and a check on the shell's source makes sure the
// shell still renders the button under that decision. The phone check covers it in a browser.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UserRound } from 'lucide-preact';
import { PROFILE_HREF, ProfileButton, profileEntryLabel, profileEntryLink, showsPeopleActions } from '../src/people/profileEntry.ts';
import { profileBack } from '../src/lib/route.ts';

const TABS = ['people', 'for-you', 'search', 'interested', 'profile', 'settings', 'inbox', 'meet', 'here'];

test('the button shows on the People screen and on #/here/{zone} for a searchable conference', () => {
  assert.equal(showsPeopleActions('people', true), true);
  assert.equal(showsPeopleActions('here', true), true);
});

test('the button is absent on every other screen, and on People when the conference cannot be searched', () => {
  for (const tab of TABS) {
    if (tab !== 'people' && tab !== 'here') assert.equal(showsPeopleActions(tab, true), false, `${tab} has no Profile button`);
    assert.equal(showsPeopleActions(tab, false), false, `${tab} without a searchable conference has no Profile button`);
  }
});

test('the button links to the profile editor, with the icon-btn styling and a user icon', () => {
  const link = profileEntryLink('Sam');
  assert.equal(link.type, 'a');
  assert.equal(link.props.href, '#/profile');
  assert.equal(PROFILE_HREF, '#/profile');
  assert.equal(link.props.class, 'icon-btn appbar-profile');
  const icon = link.props.children;
  assert.equal(icon.type, UserRound);
  assert.equal(icon.props['aria-hidden'], 'true');
});

test('the label says "Your profile" once a name is set, and "Set up your profile" while it is blank', () => {
  assert.equal(profileEntryLabel('Sam'), 'Your profile');
  assert.equal(profileEntryLabel(''), 'Set up your profile');
  assert.equal(profileEntryLabel('   '), 'Set up your profile');
  for (const [name, label] of [
    ['Sam', 'Your profile'],
    ['', 'Set up your profile'],
  ]) {
    const link = profileEntryLink(name);
    assert.equal(link.props['aria-label'], label);
    assert.equal(link.props.title, label);
  }
});

test('the people features export the button for the app shell', () => {
  // index.ts loads CSS and JSX, so its source is checked instead of importing it.
  const index = readFileSync(new URL('../src/people/index.ts', import.meta.url), 'utf8');
  assert.match(index, /export \{ ProfileButton, showsPeopleActions \} from '\.\/profileEntry';/);
  assert.equal(typeof ProfileButton, 'function');
});

test('the app shell renders the button next to Requests, under the same condition', () => {
  const app = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
  assert.match(app, /const peopleActions = showsPeopleActions\(tab, !!searchable\);/);
  const requests = app.indexOf('{isTabScreen && peopleActions && (\n        <a class="icon-btn appbar-inbox"');
  const button = app.indexOf('{isTabScreen && peopleActions && <ProfileButton />}');
  const settings = app.indexOf('<a class="icon-btn" href="#/settings" aria-label="Settings"');
  assert.ok(requests > 0, 'Requests is shown under peopleActions');
  assert.ok(button > requests, 'the Profile button follows Requests');
  assert.ok(settings > button, 'the Settings gear stays last');
});

test('on a phone narrower than 360px, the button steps aside while the Offline badge shows', () => {
  const css = readFileSync(new URL('../src/people/people.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.offline-badge ~ \.appbar-profile \{\s*display: none;/);
  // The badge comes before the button in the app bar, so the sibling selector can reach it.
  const app = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
  assert.ok(app.indexOf('<OfflineBadge />') < app.indexOf('<ProfileButton />'));
});

const route = (slug, tab) => ({ slug, tab, param: null, query: new URLSearchParams(), params: {} });

test('Back on the profile editor returns to People when it was opened from People', () => {
  assert.deepEqual(profileBack(route('kc', 'people'), 'kc'), { href: '#/people', pops: true, label: 'People' });
});

test('Back on the profile editor goes to Settings otherwise, popping only when Settings is behind it', () => {
  assert.deepEqual(profileBack(route('kc', 'settings'), 'kc'), { href: '#/settings', pops: true, label: 'Settings' });
  // A reload or a deep link: the screen behind is not known.
  assert.deepEqual(profileBack(null, 'kc'), { href: '#/settings', pops: false, label: 'Settings' });
  // Another screen, or People of another conference: Back links to Settings, as before.
  assert.deepEqual(profileBack(route('kc', 'for-you'), 'kc'), { href: '#/settings', pops: false, label: 'Settings' });
  assert.deepEqual(profileBack(route('other', 'people'), 'kc'), { href: '#/settings', pops: false, label: 'Settings' });
  // #/here/{zone} turns presence on, so Back never pops to it.
  assert.deepEqual(profileBack(route('kc', 'here'), 'kc'), { href: '#/settings', pops: false, label: 'Settings' });
});
