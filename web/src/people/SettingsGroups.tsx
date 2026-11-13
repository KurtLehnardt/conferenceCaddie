// Settings' people groups for one conference, in the web's order: Blocked people, People I met,
// People I'm watching, the nudge switch and Push. They hold that conference's people, so a demo
// conference's Demo note comes first, as on every other screen of the conference.
import { DemoNote } from '../components/demo';
import { NudgeSetting } from './NudgeBanner';
import { BlockedPeople, NudgeSettings, PeopleIMet, PeopleIWatch } from './SettingsPeople';
import type { ConferenceLike } from './types';

export function SettingsPeopleGroups({ conference }: { conference: ConferenceLike }) {
  return (
    <>
      <DemoNote conference={conference} />
      <BlockedPeople conference={conference} />
      <PeopleIMet conference={conference} />
      <PeopleIWatch conference={conference} />
      <NudgeSetting conference={conference} />
      <NudgeSettings conference={conference} />
    </>
  );
}
