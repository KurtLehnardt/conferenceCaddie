import { Clock, ExternalLink, MapPin, Presentation, Star } from 'lucide-preact';
import type { Conference, Talk } from '../types';
import { Evidence } from '../lib/evidence';
import { formatWhen, hasEnded, zoneOf } from '../lib/time';
import { TalkPeopleControls } from '../people/index';

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
}: {
  talk: Talk;
  conference: Conference;
  interested: boolean;
  onToggleInterested: (talk: Talk) => void;
  evidence?: string | null;
  headingLevel?: 2 | 3;
}) {
  const tags = talkTags(talk);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
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
      <TalkPeopleControls conference={conference} talk={talk} interested={interested} />
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
