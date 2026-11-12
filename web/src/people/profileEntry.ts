// The standing Profile button in the app bar of the People screen, next to Requests.
//
// Before this button, the only way back to the profile editor once a display name was set was the
// Settings gear and then the Profile row; the People screen offers "Create my profile" only while the
// name is blank. The native apps add the same button to their People tab, so both clients match.
//
// This file has no JSX on purpose: the tests run under node --test, which cannot load .tsx files,
// so the element is built with h() here and the tests check the element itself.
import { h } from 'preact';
import { UserRound } from 'lucide-preact';
import type { Tab } from '../lib/route';
import { useProfileName } from './storage';

/** The profile editor's route, the same one the Settings row and the People prompts link to. */
export const PROFILE_HREF = '#/profile';

/**
 * Whether the app bar shows the people actions (Requests and Profile): on the People screen, also
 * when it was opened as #/here/{zone}, and only for a conference that can be searched. The profile
 * editor itself is shown only for such a conference, so the button never leads to an empty screen.
 */
export function showsPeopleActions(tab: Tab, searchable: boolean): boolean {
  return searchable && (tab === 'people' || tab === 'here');
}

/** The button's accessible name and tooltip: an invitation while the display name is blank. */
export function profileEntryLabel(displayName: string): string {
  return displayName.trim() ? 'Your profile' : 'Set up your profile';
}

/** The Profile link for a display name. Split from ProfileButton so the tests need no renderer. */
export function profileEntryLink(displayName: string) {
  const label = profileEntryLabel(displayName);
  return h('a', { class: 'icon-btn appbar-profile', href: PROFILE_HREF, 'aria-label': label, title: label }, h(UserRound, { size: 24, 'aria-hidden': 'true' }));
}

/**
 * The Profile link with the current display name. It reads the name itself, so a change to the
 * profile re-renders only this button and not the whole app shell.
 */
export function ProfileButton() {
  return profileEntryLink(useProfileName());
}
