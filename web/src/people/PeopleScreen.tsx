// The home tab: the ended-talk banner, the people search ("What are you working on, or about
// to?") with "Around now", the "I'm around" switch, People to meet, and the "For you" row.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, MessagesSquare, Search, UserRound, Users, X } from 'lucide-preact';
import { fetchMatches, isAbort, MATCH_PAGE, PeopleApiError } from './api';
import { takePendingSearch, withoutBlocked } from './connect';
import { ForYouRow } from './ForYou';
import { PersonCard, SampleNote } from './PersonCard';
import { PresenceControls } from './PresenceControls';
import { getPresence, getProfile, getVisibility, setVisibility, usePeopleStore } from './storage';
import { changeVisibility, getSaveCount, getSyncStatus } from './sync';
import { TalkPeopleControls } from './TalkPeopleControls';
import type { ConferenceLike, InterestedProp, PersonResult, TalkLike } from './types';
import { hasEnded, interestedIds, interestedTalks, useVisibleTick } from './util';

export const VISIBILITY_NOTICE =
  'Turning this on stores your profile on our server until the conference ends: your name, about, topics, free text and How to reach me. Other attendees who are also visible at this conference can see it and may be matched with you. People who are not visible see nothing. Turn it off at any time to remove it from the server, or delete your profile.';

export const SEARCH_PLACEHOLDER = 'What are you working on, or about to?';
export const SEARCH_EMPTY = "Nobody's profile matches that yet. Try different words, or fewer.";
const DEBOUNCE_MS = 350;

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
          Make a short profile: what you've built and what you're trying to learn or figure out next. It stays on this phone
          until you choose to be visible.
        </p>
        <a class="btn btn-primary btn-small pp-prompt-btn" href="#/profile">
          Create my profile
        </a>
      </div>
    </div>
  );
}

/** The search box and the "Around now" chip. */
function PeopleSearchBar({
  value,
  around,
  onInput,
  onAround,
}: {
  value: string;
  around: boolean;
  onInput: (v: string) => void;
  onAround: (on: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="pp-search">
      <form
        class="search-field"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          input.current?.blur();
        }}
      >
        <Search class="search-icon" size={20} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          enterkeyhint="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          maxLength={300}
          placeholder={SEARCH_PLACEHOLDER}
          aria-label="Find people"
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        />
        {value && (
          <button type="button" class="icon-btn search-clear" aria-label="Clear" onClick={() => onInput('')}>
            <X size={20} aria-hidden="true" />
          </button>
        )}
      </form>
      <span class={`chip${around ? ' is-active' : ''}`}>
        <button type="button" class="chip-main" aria-pressed={around} onClick={() => onAround(!around)}>
          {around && <Check size={16} aria-hidden="true" />}
          <span>Around now</span>
        </button>
      </span>
    </div>
  );
}

type Page = { key: string; results: PersonResult[]; done: boolean };

/**
 * People to meet, or the results of a text search. Pages of 20 are appended as the list is
 * scrolled; there is no cap.
 */
function PeopleList({
  conference,
  interested,
  query,
  around,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  query: string;
  around: boolean;
}) {
  usePeopleStore();
  const visibleTick = useVisibleTick();
  const slug = conference.slug;
  const profile = getProfile();
  const vis = getVisibility(slug);
  const saves = getSaveCount();
  // Matches come from the copy of the profile on the server, so while an edit is still being
  // written they would describe the old profile; the fetch waits for the write to finish.
  const saving = getSyncStatus().state === 'saving';
  const ids = useRef<string[]>([]);
  ids.current = interestedIds(interested);
  const idsKey = ids.current.join(',');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const searching = !!query.trim() || around;
  // Zones come back only while I am around, so the list is fetched again when that changes.
  const meAround = getPresence(slug).on;
  const key = `${slug}|${saves}|${idsKey}|${query.trim()}|${around}|${meAround}`;
  const current = useRef(key);
  current.current = key;

  const load = (from: number, signal: AbortSignal) =>
    fetchMatches(slug, ids.current, signal, {
      query: query.trim() || undefined,
      when: around ? 'around_now' : searching ? 'anyone' : undefined,
      from: from || undefined,
      size: MATCH_PAGE,
    });

  useEffect(() => {
    if (!vis.open_to_meet || saving) return;
    const ctl = new AbortController();
    setError(null);
    load(0, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const results = r.results ?? [];
        setPage({ key, results, done: results.length < MATCH_PAGE });
      })
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
  }, [key, vis.open_to_meet, saving, visibleTick]);

  // Appends the next page when the end of the list comes into view. The effect depends on the
  // page only: the "more" flag is for display, so setting it must not abort the fetch. A page
  // that belongs to an earlier search or profile is never extended.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !page || page.done || page.key !== current.current || typeof IntersectionObserver === 'undefined') return;
    const ctl = new AbortController();
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      setMore(true);
      const startKey = current.current;
      load(page.results.length, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted || current.current !== startKey) return;
          const next = r.results ?? [];
          const seen = new Set(page.results.map((p) => p.ref));
          setPage({ key: page.key, results: [...page.results, ...next.filter((p) => !seen.has(p.ref))], done: next.length < MATCH_PAGE });
        })
        .catch((err) => {
          if (!isAbort(err)) setPage({ ...page, done: true });
        })
        .finally(() => setMore(false));
    });
    io.observe(el);
    return () => {
      io.disconnect();
      ctl.abort();
    };
  }, [page, key]);

  if (!profile?.display_name.trim()) return <CreateProfilePrompt />;
  if (!vis.open_to_meet) return <VisibilityPrompt conference={conference} />;
  if (error) return <p class="pp-error pp-pad">{error}</p>;
  // The earlier list stays, dimmed, until the one for the current profile and search arrives.
  const shown = page && page.key.startsWith(`${slug}|`) ? page : null;
  if (!shown) return <p class="pp-hint pp-pad">Finding people…</p>;
  const refreshing = saving || shown.key !== key;
  const results = withoutBlocked(slug, shown.results);
  if (!results.length) {
    return (
      <p class="pp-hint pp-pad">
        {searching ? SEARCH_EMPTY : 'No matches yet. Add more topics to your profile, or check back as more people join.'}
      </p>
    );
  }
  return (
    <div class="pp-progress-host">
      <div class={`pp-progress pp-progress-top${refreshing ? ' is-active' : ''}`} aria-hidden="true" />
      <div class={`pp-list${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
        <SampleNote people={results} />
        {results.map((p) => (
          <PersonCard key={p.ref} person={p} slug={slug} />
        ))}
        {!shown.done && !refreshing && (
          <div ref={sentinel} class="pp-more-sentinel" aria-hidden={!more}>
            {more && <p class="pp-hint">Finding more people…</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function PeopleScreen({
  conference,
  interested,
  onOpenTalk,
  hereZone,
  onHereHandled,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onOpenTalk?: (talk: TalkLike) => void;
  /** The raw zone of a #/here/{zone} deep link, if the tab was opened through one. */
  hereZone?: string | null;
  onHereHandled?: () => void;
}) {
  const [input, setInput] = useState(() => takePendingSearch() ?? '');
  const [query, setQuery] = useState(input);
  const [around, setAround] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const onInput = (v: string) => {
    setInput(v);
    window.clearTimeout(timer.current);
    if (!v.trim()) setQuery('');
    else timer.current = window.setTimeout(() => setQuery(v), DEBOUNCE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const searching = !!query.trim() || around;
  return (
    <div class="pp-screen">
      <PeopleSearchBar value={input} around={around} onInput={onInput} onAround={setAround} />
      <PresenceControls conference={conference} interested={interested} deepLink={hereZone} onDeepLinkHandled={onHereHandled} />
      {!searching && <EndedTalkBanner conference={conference} interested={interested} onOpenTalk={onOpenTalk} />}
      <section class="pp-section" aria-labelledby="pp-people-title">
        <div class="pp-section-head">
          <h2 id="pp-people-title" class="pp-section-title">
            {searching ? (around && !query.trim() ? 'People around now' : 'People who match') : 'People to meet'}
          </h2>
        </div>
        <PeopleList conference={conference} interested={interested} query={query} around={around} />
      </section>
      {!searching && <ForYouRow conference={conference} interested={interested} onOpenTalk={onOpenTalk} />}
    </div>
  );
}
