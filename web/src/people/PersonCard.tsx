// One person in People to meet or in a talk circle: the opener, the other
// reasons, their topics and, when present, "How to reach me".
import { ExternalLink, MessageCircle } from 'lucide-preact';
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

export function PersonCard({ person }: { person: PersonResult }) {
  const reasons = (person.reasons ?? []).filter((r) => r && r !== person.opener);
  const contact = person.contact;
  const hasContact = !!(contact && (contact.linkedin_url || contact.contact_note));
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
      </header>
      {person.about && <p class="pp-person-about">{person.about}</p>}
      {person.opener && (
        <p class="pp-opener">
          <MessageCircle size={18} aria-hidden="true" />
          <span>
            <Marked text={person.opener} />
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
    </article>
  );
}
