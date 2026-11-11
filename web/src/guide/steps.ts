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

// Every name here is one the app shows: the tabs People, For you and Interested (whose screen is
// titled My schedule), the profile's two topic pickers, "See who's here", and Settings. Each body
// is 20 words or fewer, so a step reads at a glance with the screen still in view.
export const GUIDE_STEPS: GuideStep[] = [
  {
    id: 'people',
    tab: 'people',
    position: 'bottom',
    title: 'Welcome to Conference Caddie',
    body: 'People first: attendees who share your topics show here, with why you matched and an opener.',
  },
  {
    id: 'topics',
    tab: 'profile',
    position: 'bottom',
    reveal: 'section.pp-picker',
    title: 'Pick your topics',
    body: "Pick topics to learn about and, below, topics you can speak to. It stays on this phone until you're visible.",
  },
  {
    id: 'for-you',
    tab: 'for-you',
    position: 'bottom',
    title: 'For you',
    body: 'Talks picked from what you want to learn, each with why.',
  },
  {
    id: 'schedule',
    tab: 'interested',
    position: 'bottom',
    title: 'My schedule',
    body: "Talks you mark live here and work offline. Share your profile on a talk, then See who's here.",
  },
  {
    id: 'settings',
    tab: 'settings',
    position: 'top',
    title: 'Settings',
    body: 'Profile, schedule import and appearance live here. Tap ? at the bottom to replay this tour.',
  },
];
