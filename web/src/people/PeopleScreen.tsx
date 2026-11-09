// The home tab: the ended-talk banner, People to meet, and the "For you" row.
import { useEffect, useRef, useState } from 'preact/hooks';
import { MessagesSquare, UserRound, Users, X } from 'lucide-preact';
import { fetchMatches, isAbort, PeopleApiError } from './api';
import { ForYouRow } from './ForYou';
import { PersonCard, SampleNote } from './PersonCard';
import { getProfile, getVisibility, setVisibility, usePeopleStore } from './storage';
import { changeVisibility, getSaveCount } from './sync';
import { TalkPeopleControls } from './TalkPeopleControls';
import type { ConferenceLike, InterestedProp, PersonResult, TalkLike } from './types';
import { hasEnded, interestedIds, interestedTalks } from './util';

export const VISIBILITY_NOTICE =
  'Turning this on stores your profile on our server until the conference ends: your name, about, topics, free text and How to reach me. Other attendees who are also visible at this conference can see it and may be matched with you. People who are not visible see nothing. Turn it off at any time to remove it from the server, or delete your profile.';

export function EndedTalkBanner({
  conference,
  interested,
  onOpenTalk,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onOpenTalk?: (talk: TalkLike) => void;
}) {
  usePeopleStore();
  const [open, setOpen] = useState(false);
  const vis = getVisibility(conference.slug);
  const ended = interestedTalks(interested)
    .filter((t) => hasEnded(t) && !vis.banner_seen.includes(t.talk_id))
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  // Keep showing the talk the user opened, even after it is marked as seen.
  const [pinned, setPinned] = useState<TalkLike | null>(null);
  // A talk id starts with its conference's slug, so a talk pinned at another conference is ignored.
  const talk = (pinned && pinned.talk_id.startsWith(`${conference.slug}:`) ? pinned : null) ?? ended[0];
  if (!talk) return null;

  const dismiss = () => {
    setVisibility(conference.slug, { banner_seen: [...vis.banner_seen, talk.talk_id].slice(-200) });
    setPinned(null);
    setOpen(false);
  };

  return (
    <div class="pp-banner" role="region" aria-label="Ended talk">
      <div class="pp-banner-row">
        <MessagesSquare size={20} aria-hidden="true" class="pp-banner-icon" />
        <p class="pp-banner-text">
          Want to keep talking about <strong>{talk.title}</strong>? See who else was interested.
        </p>
        <button type="button" class="icon-btn" aria-label="Close" onClick={dismiss}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {!open ? (
        <div class="pp-actions pp-banner-actions">
        <button
          type="button"
          class="btn btn-tonal btn-small"
          onClick={() => {
            setPinned(talk);
            setOpen(true);
            setVisibility(conference.slug, { banner_seen: [...vis.banner_seen, talk.talk_id].slice(-200) });
          }}
        >
          See who else was interested
        </button>
        {onOpenTalk && (
          <button type="button" class="btn btn-text btn-small" onClick={() => onOpenTalk(talk)}>
            Open talk
          </button>
        )}
        </div>
      ) : (
        <TalkPeopleControls conference={conference} talk={talk} interested startOpen />
      )}
    </div>
  );
}

function VisibilityPrompt({ conference }: { conference: ConferenceLike }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div class="pp-prompt">
      <Users size={22} aria-hidden="true" class="pp-prompt-icon" />
      <div>
        <p class="pp-prompt-title">Turn on visibility to see who to meet</p>
        <p class="pp-prompt-body">You see other attendees only while they can see you too.</p>
        <p class="pp-notice-text">{VISIBILITY_NOTICE}</p>
        <button
          type="button"
          class="btn btn-primary btn-small pp-prompt-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMessage(await changeVisibility(conference.slug, { open_to_meet: true }));
            setBusy(false);
          }}
        >
          Make me visible
        </button>
        {message && (
          <p class="pp-error">
            {message}{' '}
            <a class="pp-inline-link" href="#/profile">
              Open my profile
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function CreateProfilePrompt() {
  return (
    <div class="pp-prompt">
      <UserRound size={22} aria-hidden="true" class="pp-prompt-icon" />
      <div>
        <p class="pp-prompt-title">Find people worth meeting</p>
        <p class="pp-prompt-body">
          Make a short profile: what you want to learn and what you can speak to. It stays on this phone until you
          choose to be visible.
        </p>
        <a class="btn btn-primary btn-small pp-prompt-btn" href="#/profile">
          Create my profile
        </a>
      </div>
    </div>
  );
}

function PeopleToMeet({ conference, interested }: { conference: ConferenceLike; interested: InterestedProp }) {
  usePeopleStore();
  const slug = conference.slug;
  const profile = getProfile();
  const vis = getVisibility(slug);
  const saves = getSaveCount();
  const ids = useRef<string[]>([]);
  ids.current = interestedIds(interested);
  const idsKey = ids.current.join(',');
  const [results, setResults] = useState<PersonResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vis.open_to_meet) return;
    const ctl = new AbortController();
    setError(null);
    fetchMatches(slug, ids.current, ctl.signal)
      .then((r) => !ctl.signal.aborted && setResults(r.results ?? []))
      .catch((err) => {
        if (isAbort(err)) return;
        if (err instanceof PeopleApiError && (err.code === 'visibility_required' || err.code === 'no_device')) {
          // The server copy has gone (expired or removed), so the device follows.
          setVisibility(slug, { open_to_meet: false });
          return;
        }
        setError(err instanceof PeopleApiError ? err.message : 'People are unavailable right now.');
      });
    return () => ctl.abort();
  }, [slug, vis.open_to_meet, saves, idsKey]);

  if (!profile?.display_name.trim()) return <CreateProfilePrompt />;
  if (!vis.open_to_meet) return <VisibilityPrompt conference={conference} />;
  if (error) return <p class="pp-error pp-pad">{error}</p>;
  if (!results) return <p class="pp-hint pp-pad">Finding people…</p>;
  if (!results.length) {
    return (
      <p class="pp-hint pp-pad">
        No matches yet. Add more topics to your profile, or check back as more people join.
      </p>
    );
  }
  return (
    <div class="pp-list">
      <SampleNote people={results} />
      {results.map((p) => (
        <PersonCard key={p.ref} person={p} />
      ))}
    </div>
  );
}

export function PeopleScreen({
  conference,
  interested,
  onOpenTalk,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onOpenTalk?: (talk: TalkLike) => void;
}) {
  return (
    <div class="pp-screen">
      <EndedTalkBanner conference={conference} interested={interested} onOpenTalk={onOpenTalk} />
      <section class="pp-section" aria-labelledby="pp-people-title">
        <div class="pp-section-head">
          <h2 id="pp-people-title" class="pp-section-title">
            People to meet
          </h2>
        </div>
        <PeopleToMeet conference={conference} interested={interested} />
      </section>
      <ForYouRow conference={conference} interested={interested} onOpenTalk={onOpenTalk} />
    </div>
  );
}
