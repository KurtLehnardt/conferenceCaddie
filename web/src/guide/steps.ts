import type { Tab } from '../lib/route';

export interface GuideStep {
  id: string;
  /** The screen shown behind the dialog while this step is up. */
  tab: Tab;
  /** Where the dialog sits. The Settings step sits at the top so the help icon at the bottom stays visible. */
  position: 'top' | 'bottom';
  /** A selector for the part of the screen to bring into view above the dialog, when it is not at the top. */
  reveal?: string;
  title: string;
  body: string;
}

// Every name here is one the app shows: the tabs People, For you, Search and Interested (whose
// screen is titled My schedule), the profile's two topic pickers, and Settings with its gear.
export const GUIDE_STEPS: GuideStep[] = [
  {
    id: 'welcome',
    tab: 'people',
    position: 'bottom',
    title: 'Welcome to Conference Caddie',
    body: 'Find the right talk, and the right people around it. This quick tour shows where everything is. It takes about a minute, and you can skip it at any time.',
  },
  {
    id: 'topics',
    tab: 'profile',
    position: 'bottom',
    reveal: 'section.pp-picker',
    title: 'Say what you want to learn',
    body: 'In your profile, pick the topics you want to learn about and the topics you can speak to. You can also describe a problem you are working on. All of it stays on this phone until you choose to be visible.',
  },
  {
    id: 'people',
    tab: 'people',
    position: 'bottom',
    title: 'People to meet',
    body: 'Attendees who share your topics show up here, with the reason you matched and a line to start the conversation. You see others only while you are visible to them too, and you choose when.',
  },
  {
    id: 'circles',
    tab: 'search',
    position: 'bottom',
    title: 'Talk circles',
    body: "Mark a talk as interested, then choose to share your profile for that talk, and See who's here shows who else is interested in it. People appear only if they shared their profile for that talk too.",
  },
  {
    id: 'for-you',
    tab: 'for-you',
    position: 'bottom',
    title: 'For you',
    body: 'Talks picked from the topics you want to learn, each with the reason it was suggested. Talks that have ended and talks you already marked are left out.',
  },
  {
    id: 'schedule',
    tab: 'interested',
    position: 'bottom',
    title: 'My schedule',
    body: 'The talks you mark are kept in the Interested tab, as a list or by day, and they stay on this phone without a connection. You can also import your schedule from a PDF, CSV, calendar or text file in Settings.',
  },
  {
    id: 'settings',
    tab: 'settings',
    position: 'top',
    title: 'Settings, and this guide',
    body: 'The gear at the top right opens Settings: your profile, schedule import and appearance. The question mark at the very bottom of Settings shows this guide again.',
  },
];
