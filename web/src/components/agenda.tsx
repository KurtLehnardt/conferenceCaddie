import { Bookmark, CalendarCheck, MapPin, TriangleExclamationPoint } from 'lucide-preact';
import type { SavedTalk } from '../types';
import { formatDayLong, formatTime, formatTimeRange, overlaps, venueDay } from '../lib/time';

export function AgendaScreen({
  saved,
  onRemove,
  onBrowse,
}: {
  saved: SavedTalk[];
  onRemove: (t: SavedTalk) => void;
  onBrowse: () => void;
}) {
  if (!saved.length) {
    return (
      <div class="state">
        <CalendarCheck size={40} class="state-icon" aria-hidden="true" />
        <p class="state-body">No saved talks yet. Tap the bookmark on any talk to add it.</p>
        <button type="button" class="btn btn-tonal" onClick={onBrowse}>
          Find talks
        </button>
      </div>
    );
  }

  // Saved talks are shown in time order, grouped by venue-local day.
  const sorted = [...saved].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const days = new Map<string, SavedTalk[]>();
  for (const t of sorted) {
    const d = venueDay(t.start);
    days.set(d, [...(days.get(d) ?? []), t]);
  }

  return (
    <div class="agenda">
      {[...days.entries()].map(([day, talks]) => (
        <section key={day} class="agenda-day" aria-labelledby={`day-${day}`}>
          <h2 class="day-header" id={`day-${day}`}>
            {formatDayLong(day)}
          </h2>
          <ul class="agenda-list">
            {talks.map((t) => {
              const clash = talks.some((o) => o.talk_id !== t.talk_id && overlaps(o, t));
              return (
                <li class="agenda-row" key={t.talk_id}>
                  <div class="agenda-time">
                    <span class="sr-only">{`${formatTimeRange(t.start, t.end)} MT`}</span>
                    <span class="agenda-start" aria-hidden="true">{formatTime(t.start)}</span>
                    <span class="agenda-end" aria-hidden="true">{formatTime(t.end)}</span>
                  </div>
                  <div class="agenda-main">
                    <a class="agenda-title" href={t.url} target="_blank" rel="noopener noreferrer">
                      {t.title}
                    </a>
                    {t.room && (
                      <p class="agenda-room">
                        <MapPin size={14} aria-hidden="true" />
                        {t.room}
                      </p>
                    )}
                    {clash && (
                      <p class="card-clash">
                        <TriangleExclamationPoint size={14} aria-hidden="true" />
                        Overlaps another saved talk
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    class="icon-btn bookmark is-on"
                    aria-pressed="true"
                    aria-label={`Remove ${t.title} from agenda`}
                    onClick={() => onRemove(t)}
                  >
                    <Bookmark size={22} fill="currentColor" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p class="footnote">All times are Mountain Time (MT).</p>
    </div>
  );
}
