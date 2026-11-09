// The Search tab while the device is offline: a plain keyword match over the conference's cached
// schedule, in schedule order. This is the only search that runs outside Elasticsearch, and it
// is always labelled "Offline: keyword search only".
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CalendarX, SearchX, WifiOff } from 'lucide-preact';
import type { Conference, Talk } from '../types';
import { TalkCard } from '../components/talk';
import { loadSchedule, type Schedule, type ScheduleTalk } from './status';
import './offline.css';

const SHOW_MAX = 50;
const SNIPPET_MAX = 200;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function haystack(t: ScheduleTalk): string {
  return [
    t.title,
    t.speakers.join(' '),
    t.abstract,
    t.track,
    t.level ?? '',
    t.room ?? '',
    (t.tags ?? []).map((x) => x.value).join(' '),
    (t.topics ?? []).map((x) => x.label).join(' '),
  ]
    .join(' \n ')
    .toLowerCase();
}

/**
 * The abstract, or the part of it around the first match, as escaped text with <mark> around each
 * matched word, in the format the Evidence component renders without parsing HTML.
 */
function snippet(abstract: string, terms: string[]): string | null {
  if (!abstract) return null;
  let text = abstract;
  if (terms.length && text.length > SNIPPET_MAX) {
    const lower = text.toLowerCase();
    const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
    const start = Number.isFinite(first) ? Math.max(0, first - 60) : 0;
    text = (start > 0 ? '…' : '') + text.slice(start, start + SNIPPET_MAX) + (start + SNIPPET_MAX < text.length ? '…' : '');
  } else if (text.length > SNIPPET_MAX) {
    text = text.slice(0, SNIPPET_MAX) + '…';
  }
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return text
    .split(re)
    .map((piece, i) => (i % 2 === 1 ? `<mark>${escapeHtml(piece)}</mark>` : escapeHtml(piece)))
    .join('');
}

export function OfflineSearch({
  conference,
  query,
  interestedIds,
  onToggle,
}: {
  conference: Conference;
  query: string;
  interestedIds: Set<string>;
  onToggle: (t: Talk) => void;
}) {
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setSchedule(undefined);
    loadSchedule(conference.slug).then((s) => live && setSchedule(s));
    return () => {
      live = false;
    };
  }, [conference.slug]);

  const indexed = useMemo(
    () => (schedule ? schedule.talks.map((t) => ({ talk: t, text: haystack(t) })) : []),
    [schedule],
  );

  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 10);
  const matches = indexed.filter((x) => terms.every((t) => x.text.includes(t))).map((x) => x.talk);

  const label = (
    <p class="offline-label" role="note">
      <WifiOff size={16} aria-hidden="true" />
      Offline: keyword search only
    </p>
  );

  if (schedule === undefined) {
    return (
      <div aria-busy="true">
        {label}
        <p class="state-body offline-pad">Opening the saved schedule…</p>
      </div>
    );
  }
  if (schedule === null) {
    return (
      <div>
        {label}
        <div class="state">
          <CalendarX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-title">This schedule isn't saved on this phone yet</p>
          <p class="state-body">Open {conference.name} once while you have a connection, and its talks will be here offline.</p>
        </div>
      </div>
    );
  }

  const n = matches.length;
  return (
    <div>
      {label}
      <div class="results-header">
        <p class="results-count" aria-live="polite">
          {terms.length ? `${n} ${n === 1 ? 'talk' : 'talks'}` : `All talks · ${n}`}
        </p>
      </div>
      {n === 0 ? (
        <div class="state">
          <SearchX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-body">No talks contain every word. Try fewer or different words.</p>
        </div>
      ) : (
        <div class="results">
          {matches.slice(0, SHOW_MAX).map((t) => (
            <TalkCard
              key={t.talk_id}
              talk={t}
              conference={conference}
              evidence={snippet(t.abstract, terms)}
              interested={interestedIds.has(t.talk_id)}
              onToggleInterested={onToggle}
            />
          ))}
          {n > SHOW_MAX && <p class="footnote">Showing the first {SHOW_MAX} in schedule order. Add a word to narrow the list.</p>}
        </div>
      )}
    </div>
  );
}

/** The calm state for screens that need the server: People, For you and talk circles. */
export function NeedsConnection({ title, body }: { title: string; body: string }) {
  return (
    <div class="state offline-state" role="status">
      <WifiOff size={40} class="state-icon" aria-hidden="true" />
      <p class="state-title">{title}</p>
      <p class="state-body">{body}</p>
    </div>
  );
}

/** The "Offline" indicator in the app bar. */
export function OfflineBadge() {
  return (
    <span class="offline-badge" role="status">
      <WifiOff size={14} aria-hidden="true" />
      Offline
    </span>
  );
}
