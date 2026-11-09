// One person in People to meet, a search result or a talk circle: the opener, the passage that
// matched, the other reasons, their topics and, when present, "How to reach me". Every card has
// Report and Block in its overflow menu. Asks are now-only: "Ask to talk shop" only while they are
// around (one-tap "Wave" when they are in my zone); otherwise "Tell me when they're around" toggles
// a device-side watch.
import { useEffect, useState } from 'preact/hooks';
import { Bell, BellOff, ExternalLink, Hand, MapPin, MessageCircle } from 'lucide-preact';
import { OverflowMenu } from '../components/common';
import { requestMeet } from './api';
import { AskSheet, isMeetOpen, plainText, problem } from './AskSheet';
import { BroadLine, broadReason } from './BroadLine';
import { blockWithConfirm, noteSentRequest, outgoingTo, rememberPerson, requestTo } from './connect';
import { ReportSheet } from './ReportSheet';
import { getPresence, usePeopleStore } from './storage';
import type { PersonResult, TopicRef } from './types';
import { toast } from './ui';
import { Marked } from './util';
import { isWatched, toggleWatch } from './watch';

export const WAVED_COPY = "Waved. You'll hear back here.";
export const waveNote = (zone: string) => `I'm in ${zone} too — want to talk shop?`.slice(0, 140);

// Refs this device waved at, so the card says "Waved" rather than "No reply yet".
const waved = new Set<string>();

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

/** The short label of a proximity band; nothing for the venue as a whole. */
export function proximityLabel(band: PersonResult['proximity']): string | null {
  if (band === 'same_zone') return 'Same zone';
  if (band === 'near') return 'Near';
  if (band === 'around') return 'Around';
  return null;
}

// A line to show under a list of people when any of them is a sample profile.
export function SampleNote({ people }: { people: PersonResult[] }) {
  if (!people.some((p) => p.sample)) return null;
  return <p class="pp-sample-note">Profiles marked Sample are demo profiles, not real attendees.</p>;
}

export function PersonCard({ person, slug }: { person: PersonResult; slug: string }) {
  usePeopleStore();
  const [asking, setAsking] = useState(false);
  const [reporting, setReporting] = useState(false);
  useEffect(() => rememberPerson(person), [person.ref]);

  const evidence = person.evidence ? plainText(person.evidence) : '';
  // The evidence block already shows the matched passage, so a reason that repeats it is left out.
  const repeats = (r: string) => !!evidence && plainText(r).includes(evidence);
  // A broad match leads with its "Also interested in" line instead of an opener (BroadLine).
  const broad = person.broad === true;
  const opener = !broad && person.opener && !repeats(person.opener) ? person.opener : '';
  const reasons = (person.reasons ?? []).filter((r) => r && r !== person.opener && !repeats(r) && !(broad && r === broadReason(person)));
  const contact = person.contact;
  const hasContact = !!(contact && (contact.linkedin_url || contact.contact_note));
  const asked = requestTo(slug, person.ref);
  const open = asked && asked !== 'requested' ? outgoingTo(slug, person.ref) : null;
  const around = person.around === true;
  const presence = getPresence(slug);
  const myZone = presence.on ? presence.zone : null;
  const sameZone = around && !!myZone && person.zone === myZone;
  const watched = isWatched(slug, person.ref);
  const [waving, setWaving] = useState(false);

  // One tap: the ask goes out with a default note, no sheet.
  const wave = async () => {
    if (!myZone) return;
    setWaving(true);
    try {
      const res = await requestMeet(slug, person.ref, null, waveNote(myZone));
      waved.add(person.ref);
      noteSentRequest(slug, person.ref, res.meet_id);
      toast(WAVED_COPY);
    } catch (err) {
      if (isMeetOpen(err)) noteSentRequest(slug, person.ref, `pending:${person.ref}`);
      toast(problem(err));
    }
    setWaving(false);
  };
  // A band only; the server never sends a distance here.
  const band = person.around ? proximityLabel(person.proximity) : null;

  return (
    <article class={`pp-person${broad ? ' pp-person-broad' : ''}`}>
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
            items={[
              { label: 'Report', onSelect: () => setReporting(true) },
              { label: 'Block', destructive: true, onSelect: () => blockWithConfirm(slug, person) },
            ]}
          />
        </span>
      </header>
      {broad && <BroadLine person={person} />}
      {person.around && (
        <p class="pp-around">
          <MapPin size={16} aria-hidden="true" />
          {person.zone ? `Around · ${person.zone}` : 'Around now'}
          {band && <span class="pp-band">{band}</span>}
        </p>
      )}
      {person.about && <p class="pp-person-about">{person.about}</p>}
      {!broad && person.evidence && (
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
            {waved.has(person.ref) ? 'Waved' : 'No reply yet'}
          </span>
        ) : open ? (
          <a class="btn btn-tonal btn-small" href={`#/meet/${encodeURIComponent(open.meet_id)}`}>
            Open meet-up
          </a>
        ) : sameZone ? (
          <button type="button" class="btn btn-primary btn-small" disabled={waving} onClick={wave}>
            <Hand size={16} aria-hidden="true" />
            {waving ? 'Waving…' : 'Wave'}
          </button>
        ) : around ? (
          <button type="button" class="btn btn-tonal btn-small" onClick={() => setAsking(true)}>
            <MessageCircle size={16} aria-hidden="true" />
            Ask to talk shop
          </button>
        ) : (
          <button
            type="button"
            class={`btn btn-small ${watched ? 'btn-tonal pp-watching' : 'btn-text'}`}
            aria-pressed={watched}
            onClick={() => {
              const on = toggleWatch(slug, person);
              toast(on ? `You'll be told when ${person.display_name} is around.` : `Stopped watching ${person.display_name}.`);
            }}
          >
            {watched ? <BellOff size={16} aria-hidden="true" /> : <Bell size={16} aria-hidden="true" />}
            {watched ? 'Watching' : "Tell me when they're around"}
          </button>
        )}
      </div>
      {asking && <AskSheet slug={slug} person={person} onClose={() => setAsking(false)} />}
      {reporting && (
        <ReportSheet
          slug={slug}
          target={{ ref: person.ref, display_name: person.display_name, kind: 'profile', id: person.ref }}
          onClose={() => setReporting(false)}
        />
      )}
    </article>
  );
}
