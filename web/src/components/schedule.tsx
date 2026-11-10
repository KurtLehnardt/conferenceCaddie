// Viewing the schedule: the day chips, the Day timeline of My schedule, and the full schedule on
// the Search tab. These are views only. Talks at the same time sit side by side with no warning
// and nothing is planned for the person; the official site keeps the calendar.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { CalendarDays, CalendarX, CircleExclamationPoint, Clock, SearchX, Star, WifiOff } from 'lucide-preact';
import type { Conference, Facets, SearchFilters, SearchResult, Talk } from '../types';
import { EMPTY_FILTERS } from '../types';
import { ApiError, browse, isAbort } from '../api';
import { formatDay, formatHour, formatTime, formatTimeRange, localDay, minutesInDay, todayIn, zoneLabel, zoneOf } from '../lib/time';
import { loadSchedule } from '../offline/status';
import './schedule.css';

/** The current time, updated every minute, for the "now" line and Jump to now. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One chip per day, as a radio group: one tab stop, arrow keys move the choice. */
export function DayChips({
  days,
  value,
  onChange,
  label,
  today,
}: {
  days: string[];
  value: string | null;
  onChange: (day: string) => void;
  label: string;
  today?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Keep the chosen chip in view when the row scrolls sideways.
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step || !days.length) return;
    e.preventDefault();
    const i = Math.max(0, days.indexOf(value ?? ''));
    onChange(days[(i + step + days.length) % days.length]);
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div class="day-chips" role="radiogroup" aria-label={label} ref={row} onKeyDown={onKeyDown}>
      {days.map((d) => {
        const on = d === value;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (!value && d === days[0]) ? 0 : -1}
            class={`chip day-chip${on ? ' is-active' : ''}`}
            onClick={() => onChange(d)}
          >
            <span class="chip-main">
              {formatDay(d)}
              {d === today && <span class="day-chip-today">Today</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- My schedule: the Day timeline ---------- */

const PX_PER_MIN = 2;
// A card is its slot's height less a 2px gap, and never under the 44px tap target.
const MIN_CARD_PX = 46;

interface Placed {
  talk: Talk;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/**
 * Places a day's marked talks on a timeline. Talks whose times overlap share the width in equal
 * columns, side by side. This is layout only: nothing is flagged and nothing is removed.
 */
function place(talks: Talk[], tz: string, day: string): { placed: Placed[]; from: number; to: number } {
  const spans = talks.map((t) => {
    const start = minutesInDay(t.start, tz);
    // A talk that runs past midnight is drawn to the end of this day.
    const endRaw = localDay(t.end, tz) === day ? minutesInDay(t.end, tz) : 24 * 60;
    // A short talk still gets a card of the minimum height, so its span is at least that long and
    // a card never covers the next one.
    return { talk: t, start, end: Math.max(endRaw, start + MIN_CARD_PX / PX_PER_MIN) };
  });
  const from = Math.floor(Math.min(...spans.map((s) => s.start)) / 60) * 60;
  const to = Math.min(24 * 60, Math.ceil(Math.max(...spans.map((s) => s.end)) / 60) * 60);
  const placed: Placed[] = [];
  // Groups of talks that overlap one another, each laid out in as few columns as it needs.
  let group: { span: (typeof spans)[number]; col: number }[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const flush = () => {
    for (const g of group) {
      placed.push({
        talk: g.span.talk,
        top: (g.span.start - from) * PX_PER_MIN,
        height: Math.max(MIN_CARD_PX, (g.span.end - g.span.start) * PX_PER_MIN),
        col: g.col,
        cols: columnEnds.length,
      });
    }
    group = [];
    columnEnds = [];
  };
  for (const span of spans) {
    if (span.start >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    let col = columnEnds.findIndex((end) => end <= span.start);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(span.end);
    } else columnEnds[col] = span.end;
    group.push({ span, col });
    groupEnd = Math.max(groupEnd, span.end);
  }
  flush();
  return { placed, from, to };
}

/** A vertical timeline of one day's marked talks, with an hour gutter and a "now" line today. */
export function DayTimeline({
  talks,
  conference,
  day,
  onOpen,
}: {
  /** The day's talks in start order. */
  talks: Talk[];
  conference: Conference;
  day: string;
  onOpen: (t: Talk) => void;
}) {
  const tz = zoneOf(conference);
  const now = useNow();
  if (!talks.length) return null;
  const { placed, from, to } = place(talks, tz, day);
  const hours: number[] = [];
  for (let m = from; m <= to; m += 60) hours.push(m / 60);
  const nowMin = todayIn(tz, now) === day ? minutesInDay(new Date(now).toISOString(), tz) : null;
  const showNow = nowMin !== null && nowMin >= from && nowMin <= to;
  return (
    <div class="tl" style={{ height: `${(to - from) * PX_PER_MIN + 16}px` }}>
      {hours.map((h) => (
        <div key={h} class="tl-hour" style={{ top: `${(h * 60 - from) * PX_PER_MIN}px` }} aria-hidden="true">
          <span class="tl-hour-label">{formatHour(h)}</span>
        </div>
      ))}
      <ol class="tl-events" aria-label={`Your talks on ${formatDay(day)}`}>
        {placed.map((p) => {
          const lines = Math.max(1, Math.floor((p.height - 32) / 18));
          return (
            <li
              key={p.talk.talk_id}
              class="tl-item"
              style={{
                top: `${p.top}px`,
                height: `${p.height}px`,
                left: `${(p.col / p.cols) * 100}%`,
                width: `${100 / p.cols}%`,
              }}
            >
              <button type="button" class="tl-card" onClick={() => onOpen(p.talk)}>
                <span class="tl-title" style={{ WebkitLineClamp: lines }}>
                  {p.talk.title}
                </span>
                <span class="tl-meta">
                  {formatTimeRange(p.talk.start, p.talk.end, tz)}
                  {p.talk.room ? ` · ${p.talk.room}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {showNow && (
        <div class="tl-now" style={{ top: `${(nowMin - from) * PX_PER_MIN}px` }} aria-hidden="true">
          <span class="tl-now-label">Now</span>
        </div>
      )}
    </div>
  );
}

/* ---------- The full schedule (Search tab) ---------- */

const PAGE = 50;
const MAX_FROM = 1000;

// Days with talks per conference, from one browse request; the list does not change in a visit.
const knownDays = new Map<string, string[]>();

interface Slot {
  start: string;
  talks: Talk[];
}

/** Consecutive talks with the same start, in the order Elasticsearch returned them. */
function slots(talks: Talk[]): Slot[] {
  const out: Slot[] = [];
  for (const t of talks) {
    const last = out[out.length - 1];
    if (last && last.start === t.start) last.talks.push(t);
    else out.push({ start: t.start, talks: [t] });
  }
  return out;
}

/** The slot in progress (started, with a talk still running), else the next one, else the last. */
function nowSlot(list: Slot[], now: number): number {
  let current = -1;
  for (let i = 0; i < list.length; i++) {
    if (Date.parse(list[i].start) > now) return current !== -1 ? current : i;
    if (list[i].talks.some((t) => Date.parse(t.end) > now)) current = i;
  }
  return current !== -1 ? current : list.length - 1;
}

function ScheduleRow({
  talk,
  interested,
  onToggle,
  onOpen,
}: {
  talk: Talk;
  interested: boolean;
  onToggle: (t: Talk) => void;
  onOpen: (t: Talk) => void;
}) {
  const event = talk.kind === 'ambient';
  const meta = [talk.room, talk.track && talk.track !== 'Not specified' ? talk.track : null].filter(Boolean).join(' · ');
  return (
    <li class="sched-row">
      <button type="button" class="sched-open" onClick={() => onOpen(talk)}>
        {event && (
          <span class="sched-event">
            <CalendarDays size={12} aria-hidden="true" />
            Event or showcase
          </span>
        )}
        <span class="sched-title">{talk.title}</span>
        {talk.speakers.length > 0 && <span class="sched-speakers">{talk.speakers.join(', ')}</span>}
        {meta && <span class="sched-meta">{meta}</span>}
      </button>
      {!event && (
        <button
          type="button"
          class={`icon-btn sched-star${interested ? ' is-on' : ''}`}
          aria-pressed={interested}
          aria-label={`I'm interested: ${talk.title}`}
          title="I'm interested"
          onClick={() => onToggle(talk)}
        >
          <Star size={22} fill={interested ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul class="sched-list" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} class="sched-row skeleton">
          <div class="sched-open">
            <div class="sk sk-title" />
            <div class="sk sk-line sk-short" />
          </div>
        </li>
      ))}
    </ul>
  );
}

const countLabel = (n: number, events: boolean) =>
  events ? `${n} ${n === 1 ? 'result' : 'results'}` : `${n} ${n === 1 ? 'talk' : 'talks'}`;

type Loaded = { day: string; talks: Talk[]; total: number; complete: boolean };

/**
 * The conference's schedule for one day, grouped under start-time headers. Online, every page
 * comes from Elasticsearch in its start order, with the filters applied there. Offline, it is
 * the saved /api/schedule copy, which is already in that order.
 */
export function FullSchedule({
  conference,
  online,
  filters,
  day: requestedDay,
  onDay,
  interestedIds,
  onToggle,
  onOpen,
  onFacets,
  filterRow,
}: {
  conference: Conference;
  online: boolean;
  filters: SearchFilters;
  day: string | null;
  onDay: (day: string) => void;
  interestedIds: Set<string>;
  onToggle: (t: Talk) => void;
  onOpen: (t: Talk) => void;
  /** The facets and total of the day on screen, for the filter sheet. */
  onFacets: (facets: Facets | null, total: number | null) => void;
  /** The filter chips, shown under the day chips while online. */
  filterRow: ComponentChildren;
}) {
  const slug = conference.slug;
  const tz = zoneOf(conference);
  const now = useNow();
  const today = todayIn(tz, now);
  const [days, setDays] = useState<string[] | null>(() => (online ? (knownDays.get(slug) ?? null) : null));
  const [offlineTalks, setOfflineTalks] = useState<Talk[] | null | undefined>(undefined);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [, setJumpTick] = useState(0);
  const jump = useRef(false);
  const headers = useRef<(HTMLElement | null)[]>([]);

  // The days: online from Elasticsearch's day facet; offline from the saved schedule.
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    setError(null);
    if (!online) {
      setOfflineTalks(undefined);
      loadSchedule(slug).then((s) => {
        if (!live) return;
        const talks = s?.talks ?? null;
        setOfflineTalks(talks);
        // The saved schedule is in start order, so its days come out in order too.
        setDays(talks ? [...new Set(talks.map((t) => localDay(t.start, tz)))] : []);
      });
    } else if (knownDays.has(slug)) {
      setDays(knownDays.get(slug)!);
    } else {
      setDays(null);
      browse(slug, EMPTY_FILTERS, 0, 1, ctrl.signal)
        .then((res) => {
          const list = res.facets.day.filter((d) => d.count > 0).map((d) => d.value);
          knownDays.set(slug, list);
          if (live) setDays(list);
        })
        .catch((err) => {
          if (live && !isAbort(err)) setError(err instanceof ApiError ? err.message : 'The schedule is unavailable right now.');
        });
    }
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [slug, online, retry]);

  const day = days?.length ? (requestedDay && days.includes(requestedDay) ? requestedDay : days.includes(today) ? today : days[0]) : null;

  // The chosen day's talks, page by page, until Elasticsearch has returned all of them.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    if (!online || !day) return;
    const ctrl = new AbortController();
    setLoaded(null);
    setError(null);
    onFacets(null, null);
    (async () => {
      const f: SearchFilters = { ...filters, day, start_after: null, start_before: null, happening_now: false };
      let talks: SearchResult[] = [];
      for (let from = 0; from <= MAX_FROM; from += PAGE) {
        const res = await browse(slug, f, from, PAGE, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (from === 0) onFacets(res.facets, res.total);
        talks = [...talks, ...res.results];
        const complete = !res.results.length || talks.length >= res.total || from + PAGE > MAX_FROM;
        setLoaded({ day, talks, total: res.total, complete });
        if (complete) return;
      }
    })().catch((err) => {
      if (!ctrl.signal.aborted && !isAbort(err)) setError(err instanceof ApiError ? err.message : 'The schedule is unavailable right now.');
    });
    return () => ctrl.abort();
  }, [slug, online, day, filterKey, retry]);

  const dayTalks: Talk[] | null = !day
    ? null
    : online
      ? loaded?.day === day
        ? loaded.talks
        : null
      : (offlineTalks ?? []).filter((t) => localDay(t.start, tz) === day);
  const complete = online ? !!loaded?.complete && loaded.day === day : true;
  const list = dayTalks ? slots(dayTalks) : [];

  // Jump to now, once the whole day is on screen.
  useLayoutEffect(() => {
    if (!jump.current || !complete || day !== today || !list.length) return;
    jump.current = false;
    const el = headers.current[nowSlot(list, Date.now())];
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  });

  const onJump = () => {
    jump.current = true;
    if (day !== today) onDay(today);
    // Re-render, so the effect above runs once today's talks are all on screen.
    setJumpTick((t) => t + 1);
  };

  const offlineLabel = !online && (
    <p class="offline-label" role="note">
      <WifiOff size={16} aria-hidden="true" />
      Offline: the saved schedule, without filters
    </p>
  );

  if (error && !dayTalks) {
    return (
      <div class="state">
        <CircleExclamationPoint size={40} class="state-icon" aria-hidden="true" />
        <p class="state-title">Something went wrong</p>
        <p class="state-body">{error}</p>
        <button type="button" class="btn btn-tonal" onClick={() => setRetry((r) => r + 1)}>
          Retry
        </button>
      </div>
    );
  }
  if (!online && offlineTalks === null) {
    return (
      <div>
        {offlineLabel}
        <div class="state">
          <CalendarX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-title">This schedule isn't saved on this phone yet</p>
          <p class="state-body">Open {conference.name} once while you have a connection, and its schedule will be here offline.</p>
        </div>
      </div>
    );
  }

  const running = !!days?.includes(today);
  return (
    <div class="sched">
      {offlineLabel}
      {days === null ? (
        <div class="day-chips" aria-hidden="true">
          <span class="chip day-chip sk-chip" />
          <span class="chip day-chip sk-chip" />
          <span class="chip day-chip sk-chip" />
        </div>
      ) : (
        <DayChips days={days} value={day} onChange={onDay} label="Day" today={running ? today : undefined} />
      )}
      {online && filterRow}
      <div class="results-header">
        <p class="results-count" aria-live="polite">
          {day && dayTalks ? `${formatDay(day)} · ${countLabel(online && loaded ? loaded.total : dayTalks.length, online && filters.include_events)}` : 'Loading the schedule…'}
        </p>
        {running && (
          <button type="button" class="btn btn-tonal btn-small" onClick={onJump}>
            <Clock size={16} aria-hidden="true" />
            Jump to now
          </button>
        )}
      </div>
      {!dayTalks ? (
        <SkeletonRows />
      ) : dayTalks.length === 0 ? (
        <div class="state">
          <SearchX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-body">{days?.length ? 'Nothing on this day matches. Try removing a filter.' : 'No talks are listed yet.'}</p>
        </div>
      ) : (
        <div aria-busy={!complete}>
          {list.map((slot, i) => (
            <section key={slot.start} class="sched-slot" aria-labelledby={`slot-${i}`}>
              <h2
                class="sched-time"
                id={`slot-${i}`}
                tabIndex={-1}
                ref={(el) => {
                  headers.current[i] = el;
                }}
              >
                {formatTime(slot.start, tz)}
              </h2>
              <ul class="sched-list">
                {slot.talks.map((t) => (
                  <ScheduleRow key={t.talk_id} talk={t} interested={interestedIds.has(t.talk_id)} onToggle={onToggle} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))}
          {!complete && <p class="footnote sched-more">Loading more talks…</p>}
          <p class="footnote sched-foot">
            Times are in the event's local time ({zoneLabel(list[0].start, tz)}). Your own schedule lives on the official site.
          </p>
        </div>
      )}
    </div>
  );
}
