// Public surface of the people features (CONTRACT3 section 5). The shell imports
// only from this file and from ./import.
import './people.css';

export { PeopleScreen, EndedTalkBanner } from './PeopleScreen';
export { ForYouScreen } from './ForYou';
export { ProfileScreen } from './ProfileScreen';
export { TalkPeopleControls } from './TalkPeopleControls';
export { ShareAllControls } from './ShareAllControls';
export { InboxScreen } from './InboxScreen';
export { MeetScreen } from './MeetScreen';
export { BlockedPeople, NudgeSettings, PeopleIMet } from './SettingsPeople';
export { onInterestedChanged } from './sync';
export { importProfile } from './import';
export { registerPeopleUi } from './ui';
export { usePresenceWatch } from './presence';
export { forgetPush } from './push';
export { useInboxWatch, useInboxCount } from './connect';
export type { ConferenceLike, InterestedProp, TalkLike } from './types';
