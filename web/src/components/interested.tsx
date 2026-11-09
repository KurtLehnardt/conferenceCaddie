import { Star } from 'lucide-preact';
import type { Conference, InterestedTalk, Talk } from '../types';
import { formatDayLong, localDay, zoneLabel, zoneOf } from '../lib/time';
import { TalkCard } from './talk';

/** The talks the user marked, in time order and grouped by local day. No scheduling logic. */
export function InterestedScreen({
  conference,
  interested,
  onToggle,
  onBrowse,
}: {
  conference: Conference;
  interested: InterestedTalk[];
  onToggle: (t: Talk) => void;
  onBrowse: () => void;
}) {
  if (!interested.length) {
    return (
      <div class="state">
        <Star size={40} class="state-icon" aria-hidden="true" />
        <p class="state-body">No talks marked yet. Tap “I'm interested” on any talk to keep it here.</p>
        <button type="button" class="btn btn-tonal" onClick={onBrowse}>
          Find talks
        </button>
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

  return (
    <div class="interested">
      {[...days.entries()].map(([day, talks]) => (
        <section key={day} class="interested-day" aria-labelledby={`day-${day}`}>
          <h2 class="day-header" id={`day-${day}`}>
            {formatDayLong(day)}
          </h2>
          <div class="results">
            {talks.map((t) => (
              <TalkCard key={t.talk_id} talk={t} conference={conference} interested onToggleInterested={onToggle} />
            ))}
          </div>
        </section>
      ))}
      <p class="footnote">
        Times are shown in the event's local time ({zoneLabel(sorted[0].start, tz)}). This list is kept on this
        device only.
      </p>
    </div>
  );
}
