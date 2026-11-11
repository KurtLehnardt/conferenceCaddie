// Public surface of the people features (CONTRACT3 section 5). The shell imports
// only from this file and from ./import.
import './people.css';
import './nudges.css';
import { bleRunning, resetBle, stopBle } from './ble';
import { clearInbox } from './connect';
import { resetNudges } from './nudges';
import { resetPresence } from './presence';
import { registerRuntimeReset, registerRuntimeStop } from './sync';
import { clearWatches } from './watch';

// When "Delete my profile" finishes, from the profile screen or from a retry in the background,
// the position watch, the timers, the Bluetooth scan, the inbox poll's state, the nudges and the
// watch list stop before the stored data goes.
// When a delete starts, before its first request: Bluetooth stops (for "Delete my profile", with
// every presence timer and the position watch), so nothing keeps the person findable meanwhile.
registerRuntimeStop(async (slug) => {
  if (slug === null) {
    await resetBle();
    resetPresence();
  } else if (bleRunning(slug)) {
    await stopBle(slug, { tellServer: false });
  }
});

registerRuntimeReset(async () => {
  await resetBle();
  resetPresence();
  clearInbox();
  resetNudges();
  clearWatches();
});

export { PeopleScreen, EndedTalkBanner } from './PeopleScreen';
export { ForYouScreen } from './ForYou';
export { ProfileScreen } from './ProfileScreen';
export { TalkPeopleControls } from './TalkPeopleControls';
export { ShareAllControls } from './ShareAllControls';
export { InboxScreen } from './InboxScreen';
export { MeetScreen } from './MeetScreen';
export { BlockedPeople, NudgeSettings, PeopleIMet, PeopleIWatch } from './SettingsPeople';
export { getWatches, isWatched, toggleWatch, removeWatch } from './watch';
export { NudgeSetting } from './NudgeBanner';
export { onInterestedChanged, startDeleteRetries } from './sync';
export { importProfile } from './import';
export { registerPeopleUi } from './ui';
export { usePresenceWatch } from './presence';
export { forgetPush, resyncPush } from './push';
export { useInboxWatch, useInboxCount } from './connect';
export { useProfileName } from './storage';
export type { ConferenceLike, InterestedProp, TalkLike } from './types';
