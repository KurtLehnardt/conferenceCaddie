// One person in People to meet, a search result or a talk circle: the opener, the passage that
// matched, the other reasons, their topics and, when present, "How to reach me". Every card has
// Block in its overflow menu and "Ask to talk shop".
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink, MapPin, MessageCircle } from 'lucide-preact';
import { OverflowMenu } from '../components/common';
import { AskSheet, plainText } from './AskSheet';
import { blockWithConfirm, outgoingTo, rememberPerson, requestTo } from './connect';
import { usePeopleStore } from './storage';
import type { PersonResult, TopicRef } from './types';
import { Marked } from './util';

function Topics({ label, topics }: { label: string; topics: TopicRef[] }) {
  if (!topics?.length) return null;
  const shown = topics.slice(0, 6);
  return (
    <p class="pp-person-topics">
      <span class="pp-person-topics-label">{label}</span> {shown.map((t) => t.label).join(', ')}
      {topics.length > shown.length && ` and ${topics.length - shown.length} more`}
    </p>
  );
}

// A line to show under a list of people when any of them is a sample profile.
export function SampleNote({ people }: { people: PersonResult[] }) {
  if (!people.some((p) => p.sample)) return null;
  return <p class="pp-sample-note">Profiles marked Sample are demo profiles, not real attendees.</p>;
}

export function PersonCard({ person, slug }: { person: PersonResult; slug: string }) {
  usePeopleStore();
  const [asking, setAsking] = useState(false);
  useEffect(() => rememberPerson(person), [person.ref]);

  const evidence = person.evidence ? plainText(person.evidence) : '';
  // The evidence block already shows the matched passage, so a reason that repeats it is left out.
  const repeats = (r: string) => !!evidence && plainText(r).includes(evidence);
  const opener = person.opener && !repeats(person.opener) ? person.opener : '';
  const reasons = (person.reasons ?? []).filter((r) => r && r !== person.opener && !repeats(r));
  const contact = person.contact;
  const hasContact = !!(contact && (contact.linkedin_url || contact.contact_note));
  const asked = requestTo(slug, person.ref);
  const open = asked && asked !== 'requested' ? outgoingTo(slug, person.ref) : null;

  return (
    <article class="pp-person">
      <header class="pp-person-head">
        <h3 class="pp-person-name">{person.display_name}</h3>
        {person.sample && (
          <span class="pp-sample" title="A sample profile, not a real person">
            <span aria-hidden="true">Sample</span>
            <span class="sr-only">Sample profile, not a real person</span>
          </span>
        )}
        <span class="pp-person-menu">
          <OverflowMenu
            label={`Options for ${person.display_name}`}
            items={[{ label: 'Block', destructive: true, onSelect: () => blockWithConfirm(slug, person) }]}
          />
        </span>
      </header>
      {person.around && (
        <p class="pp-around">
          <MapPin size={16} aria-hidden="true" />
          {person.zone ? `Around · ${person.zone}` : 'Around now'}
        </p>
      )}
      {person.about && <p class="pp-person-about">{person.about}</p>}
      {person.evidence && (
        <blockquote class="pp-evidence">
          <Marked text={person.evidence} />
        </blockquote>
      )}
      {opener && (
        <p class="pp-opener">
          <MessageCircle size={18} aria-hidden="true" />
          <span>
            <Marked text={opener} />
          </span>
        </p>
      )}
      {reasons.length > 0 && (
        <ul class="pp-reasons">
          {reasons.map((r, i) => (
            <li key={i}>
              <Marked text={r} />
            </li>
          ))}
        </ul>
      )}
      <Topics label="Can speak to:" topics={person.speak_topics} />
      <Topics label="Wants to learn:" topics={person.learn_topics} />
      {hasContact && (
        <div class="pp-contact">
          <h4 class="pp-subhead">How to reach me</h4>
          {contact!.linkedin_url && /^https:\/\//.test(contact!.linkedin_url) && (
            <a class="link" href={contact!.linkedin_url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              LinkedIn profile
            </a>
          )}
          {contact!.contact_note && <p class="pp-contact-note">{contact!.contact_note}</p>}
        </div>
      )}
      <div class="pp-actions pp-person-actions">
        {asked === 'requested' ? (
          <span class="pp-hint pp-asked" role="status">
            No reply yet
          </span>
        ) : open ? (
          <a class="btn btn-tonal btn-small" href={`#/meet/${encodeURIComponent(open.meet_id)}`}>
            Open meet-up
          </a>
        ) : (
          <button type="button" class="btn btn-tonal btn-small" onClick={() => setAsking(true)}>
            <MessageCircle size={16} aria-hidden="true" />
            Ask to talk shop
          </button>
        )}
      </div>
      {asking && <AskSheet slug={slug} person={person} onClose={() => setAsking(false)} />}
    </article>
  );
}
