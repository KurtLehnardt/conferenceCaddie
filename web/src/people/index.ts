// Public surface of the people features (CONTRACT3 section 5). The shell imports
// only from this file and from ./import.
import './people.css';

export { PeopleScreen, EndedTalkBanner } from './PeopleScreen';
export { ForYouScreen } from './ForYou';
export { ProfileScreen } from './ProfileScreen';
export { TalkPeopleControls } from './TalkPeopleControls';
export { importProfile } from './import';
export type { ConferenceLike, InterestedProp, TalkLike } from './types';
