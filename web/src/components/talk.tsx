import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { CalendarDays, Clock, ExternalLink, MapPin, Presentation, Star, WifiOff } from 'lucide-preact';
import { getRelated, isAbort } from '../api';
import type { Conference, Talk } from '../types';
import { Evidence } from '../lib/evidence';
import { formatWhen, hasEnded, zoneOf } from '../lib/time';
import { TalkPeopleControls } from '../people/index';
import { useOnline } from '../offline/status';

/** Track, level and tag chips, skipping placeholders. Tags carry their group name as a tooltip. */
function talkTags(talk: Talk): { label: string; title?: string }[] {
  const out: { label: string; title?: string }[] = [];
  if (talk.track && talk.track !== 'Not specified') out.push({ label: talk.track });
  if (talk.level && talk.level !== 'Not specified') out.push({ label: talk.level });
  for (const t of talk.tags ?? []) out.push({ label: t.value, title: t.group });
  return out;
}

/** The "I'm interested" toggle; after the talk ends it reads "I was there / wanted to be". */
export function InterestedToggle({ talk, on, onToggle }: { talk: Talk; on: boolean; onToggle: () => void }) {
  const label = hasEnded(talk) ? 'I was there / wanted to be' : "I'm interested";
  return (
    <button type="button" class={`interest-btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onToggle}>
      <Star size={18} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** Up to five talks of the same conference with the closest meaning, fetched when first opened. */
function RelatedTalks({ talk, conference }: { talk: Talk; conference: Conference }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | Talk[]>('idle');
  const started = useRef(false);
  const load = () => {
    setState('loading');
    getRelated(conference.slug, talk.talk_id)
      .then(setState)
      .catch((err) => {
        if (!isAbort(err)) setState('error');
      });
  };
  const onToggle = (e: Event) => {
    if (!(e.currentTarget as HTMLDetailsElement).open || started.current) return;
    started.current = true;
    load();
  };
  return (
    <details class="related" onToggle={onToggle}>
      <summary>Related talks</summary>
      {state === 'loading' && <p class="related-note">Finding related talks...</p>}
      {state === 'error' && (
        <p class="related-note">
          Related talks are unavailable right now.{' '}
          <button type="button" class="link" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {Array.isArray(state) && state.length === 0 && <p class="related-note">No related talks found.</p>}
      {Array.isArray(state) && state.length > 0 && (
        <ul class="related-list">
          {state.map((r) => (
            <li key={r.talk_id}>
              <a href={r.url} target="_blank" rel="noopener noreferrer" class="link">
                {r.title}
              </a>
              <span class="related-meta">
                {r.speakers.length > 0 ? `${r.speakers.join(', ')} · ` : ''}
                {formatWhen(r.start, r.end, zoneOf(conference))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * One talk: title, speakers, time in the conference's zone, room, chips, optional
 * evidence, the interested toggle, the people controls, and the official links.
 */
export function TalkCard({
  talk,
  conference,
  interested,
  onToggleInterested,
  evidence,
  headingLevel = 3,
  extra,
}: {
  talk: Talk;
  conference: Conference;
  interested: boolean;
  onToggleInterested: (talk: Talk) => void;
  evidence?: string | null;
  headingLevel?: 2 | 3 | 4;
  /** Optional content under the actions, such as the ranking drawer on search results. */
  extra?: ComponentChildren;
}) {
  const tags = talkTags(talk);
  // Talk circles need the server, so offline they give way to a calm note on marked talks.
  const online = useOnline();
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 4 ? 'h4' : 'h3';
  // A co-located event or showcase is not a talk: it has its own card, with no interest toggle,
  // no talk circle and no related talks, and a link to its official page.
  if (talk.kind === 'ambient') {
    return (
      <article class="card card-event">
        <p class="event-badge">
          <CalendarDays size={14} aria-hidden="true" />
          Event or showcase, not a talk
        </p>
        <Heading class="card-title">{talk.title}</Heading>
        <p class="card-meta">
          <span class="meta-item">
            <Clock size={16} aria-hidden="true" />
            {formatWhen(talk.start, talk.end, zoneOf(conference))}
          </span>
          {talk.room && (
            <span class="meta-item">
              <MapPin size={16} aria-hidden="true" />
              {talk.room}
            </span>
          )}
        </p>
        {tags.length > 0 && (
          <ul class="tags" aria-label="Details">
            {tags.map((t, i) => (
              <li class="tag" key={`${t.title ?? ''}:${t.label}:${i}`} title={t.title}>
                {t.label}
              </li>
            ))}
          </ul>
        )}
        {evidence && (
          <p class="card-evidence">
            <Evidence text={evidence} />
          </p>
        )}
        <div class="card-links">
          <a href={talk.url} target="_blank" rel="noopener noreferrer" class="link">
            <ExternalLink size={16} aria-hidden="true" />
            Details on the official site
          </a>
        </div>
      </article>
    );
  }
  return (
    <article class="card">
      <Heading class="card-title">{talk.title}</Heading>
      {talk.speakers.length > 0 && <p class="card-speakers">{talk.speakers.join(', ')}</p>}
      <p class="card-meta">
        <span class="meta-item">
          <Clock size={16} aria-hidden="true" />
          {formatWhen(talk.start, talk.end, zoneOf(conference))}
        </span>
        {talk.room && (
          <span class="meta-item">
            <MapPin size={16} aria-hidden="true" />
            {talk.room}
          </span>
        )}
      </p>
      {tags.length > 0 && (
        <ul class="tags" aria-label="Details">
          {tags.map((t, i) => (
            <li class="tag" key={`${t.title ?? ''}:${t.label}:${i}`} title={t.title}>
              {t.label}
            </li>
          ))}
        </ul>
      )}
      {evidence && (
        <p class="card-evidence">
          <Evidence text={evidence} />
        </p>
      )}
      <div class="card-actions">
        <InterestedToggle talk={talk} on={interested} onToggle={() => onToggleInterested(talk)} />
      </div>
      {extra}
      {online ? (
        <TalkPeopleControls conference={conference} talk={talk} interested={interested} />
      ) : (
        interested && (
          <p class="offline-note">
            <WifiOff size={14} aria-hidden="true" />
            Talk circles need a connection.
          </p>
        )
      )}
      {online && <RelatedTalks talk={talk} conference={conference} />}
      <div class="card-links">
        <a href={talk.url} target="_blank" rel="noopener noreferrer" class="link">
          <ExternalLink size={16} aria-hidden="true" />
          Add to my schedule on the official site
        </a>
        {talk.slides_url && (
          <a href={talk.slides_url} target="_blank" rel="noopener noreferrer" class="link">
            <Presentation size={16} aria-hidden="true" />
            Slides
          </a>
        )}
      </div>
    </article>
  );
}
