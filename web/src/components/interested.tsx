import type { ComponentChildren } from 'preact';
import { Star } from 'lucide-preact';
import type { Conference, InterestedTalk, Talk } from '../types';
import { formatDayLong, localDay, todayIn, zoneLabel, zoneOf } from '../lib/time';
import type { TabParams } from '../lib/route';
import { TalkCard } from './talk';
import { Segmented } from './common';
import { DayChips, DayTimeline, useNow } from './schedule';
import { ShareAllControls } from '../people/index';
import { useOnline } from '../offline/status';

// The List or Day choice is remembered on this device only.
const VIEW_KEY = 'caddie.myschedule.view.v1';

export type MyScheduleView = 'list' | 'day';

export function loadMyScheduleView(): MyScheduleView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'day' ? 'day' : 'list';
  } catch {
    return 'list';
  }
}

function storeMyScheduleView(view: MyScheduleView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // The choice still holds for this visit through the URL.
  }
}

/**
 * My schedule: the talks the user marked, as a list grouped by local day or as a timeline of one
 * day. It only shows what was marked. Talks at the same time sit side by side with no warning,
 * and nothing is planned for the person.
 */
export function InterestedScreen({
  conference,
  interested,
  params,
  onParams,
  onToggle,
  onOpen,
  onBrowse,
}: {
  conference: Conference;
  interested: InterestedTalk[];
  params: TabParams;
  onParams: (p: TabParams) => void;
  onToggle: (t: Talk) => void;
  onOpen: (t: Talk) => void;
  onBrowse: () => void;
}) {
  // Sharing needs the server, so offline the list shows without the share controls.
  const online = useOnline();
  const now = useNow();
  const header = (children?: ComponentChildren) => (
    <div class="screen-head">
      <h2 class="screen-title">My schedule</h2>
      {children}
    </div>
  );

  if (!interested.length) {
    return (
      <div class="interested">
        {header()}
        <div class="state">
          <Star size={40} class="state-icon" aria-hidden="true" />
          <p class="state-body">No talks marked yet. Tap “I'm interested” on any talk to keep it here.</p>
          <button type="button" class="btn btn-tonal" onClick={onBrowse}>
            Find talks
          </button>
          <p class="state-hint">
            You can import your schedule in <a href="#/settings">Settings</a>
          </p>
        </div>
      </div>
    );
  }

  const tz = zoneOf(conference);
  const sorted = [...interested].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const days = new Map<string, InterestedTalk[]>();
  for (const t of sorted) {
    const d = localDay(t.start, tz);
    days.set(d, [...(days.get(d) ?? []), t]);
  }
  const dayList = [...days.keys()];
  const today = todayIn(tz, now);
  const view: MyScheduleView = params.view === 'day' || params.view === 'list' ? params.view : loadMyScheduleView();
  const day = params.day && days.has(params.day) ? params.day : days.has(today) ? today : dayList[0];

  const setView = (v: MyScheduleView) => {
    storeMyScheduleView(v);
    onParams(v === 'day' ? { view: v, day } : { view: v });
  };

  const footnote = (
    <p class="footnote">
      Times are shown in the event's local time ({zoneLabel(sorted[0].start, tz)}). This list is kept on this device
      only.
    </p>
  );

  return (
    <div class="interested">
      {header(
        <Segmented
          label="My schedule view"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: 'List' },
            { value: 'day', label: 'Day' },
          ]}
        />,
      )}
      {online && <ShareAllControls conference={conference} interested={interested} />}
      {view === 'day' ? (
        <>
          <DayChips
            days={dayList}
            value={day}
            onChange={(d) => onParams({ view: 'day', day: d })}
            label="Day"
            today={days.has(today) ? today : undefined}
          />
          <h3 class="sr-only">{formatDayLong(day)}</h3>
          <DayTimeline talks={days.get(day) ?? []} conference={conference} day={day} onOpen={onOpen} />
          {footnote}
        </>
      ) : (
        <>
          {[...days.entries()].map(([d, talks]) => (
            <section key={d} class="interested-day" aria-labelledby={`day-${d}`}>
              <h3 class="day-header" id={`day-${d}`}>
                {formatDayLong(d)}
              </h3>
              <div class="results">
                {talks.map((t) => (
                  <TalkCard key={t.talk_id} talk={t} conference={conference} interested onToggleInterested={onToggle} headingLevel={4} />
                ))}
              </div>
            </section>
          ))}
          {footnote}
        </>
      )}
    </div>
  );
}
