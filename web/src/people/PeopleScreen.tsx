// The home tab. Home is Around: while presence is on it opens on the Around view ("Still in
// {zone}?", the nudge banner, the presence card, then who's around, my zone first), with the text
// search collapsed to one "Find someone specific" button. While presence is off it opens as
// before: the presence switch on top, the people search ("What are you working on, or about to?")
// with "Around now", People to meet, and the "For you" row.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, MessagesSquare, Search, UserRound, Users, X } from 'lucide-preact';
import { fetchMatches, isAbort, MATCH_PAGE, PeopleApiError } from './api';
import { revealBleCard, useBleReveal } from './ble';
import { takePendingSearch, withoutBlocked } from './connect';
import { ForYouRow } from './ForYou';
import { NudgeBanner } from './NudgeBanner';
import { revealIn, useNudges } from './nudges';
import { PersonCard, SampleNote } from './PersonCard';
import { PresenceControls, StillHereRow } from './PresenceControls';
import { getPresence, getProfile, getVisibility, setVisibility, usePeopleStore } from './storage';
import { changeVisibility, getSaveCount } from './sync';
import { TalkPeopleControls } from './TalkPeopleControls';
import type { ConferenceLike, InterestedProp, PersonResult, TalkLike } from './types';
import { hasEnded, interestedIds, interestedTalks } from './util';

export const VISIBILITY_NOTICE =
  'Turning this on stores your profile on our server until the conference ends: your name, about, topics, free text and How to reach me. Other attendees who are also visible at this conference can see it and may be matched with you. People who are not visible see nothing. Turn it off at any time to remove it from the server, or delete your profile.';

export const SEARCH_PLACEHOLDER = 'What are you working on, or about to?';
export const SEARCH_EMPTY = "Nobody's profile matches that yet. Try different words, or fewer.";
export const FIND_LABEL = 'Find someone specific';
export const AROUND_TITLE = "Who's around";
export const AROUND_EMPTY = "Nobody else is around right now. People show up here as they turn on \"Around and up for a conversation\".";
const DEBOUNCE_MS = 350;
// The Around home list is refreshed quietly this often while the tab is visible: people come and go.
const AROUND_REFRESH_MS = 60_000;

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
          Make a short profile: what you've built and what you're trying to figure out next. It stays on this phone
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

type Page = { results: PersonResult[]; done: boolean };

/**
 * People to meet, or the results of a text search. Pages of 20 are appended as the list is
 * scrolled; there is no cap.
 */
function PeopleList({
  conference,
  interested,
  query,
  around,
  groupZone,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  query: string;
  around: boolean;
  /** The Around home view: people in this zone are listed first, then the rest of the venue. */
  groupZone?: string | null;
}) {
  usePeopleStore();
  const slug = conference.slug;
  const profile = getProfile();
  const vis = getVisibility(slug);
  const saves = getSaveCount();
  const ids = useRef<string[]>([]);
  ids.current = interestedIds(interested);
  const idsKey = ids.current.join(',');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Nudges: the key whose first page is on screen, so "See who" waits for the Around now list.
  const loaded = useRef('');
  const { reveal } = useNudges(slug);
  // Android app: a tapped "right near you" notification lands on that card the same way.
  const bleReveal = useBleReveal(slug);
  const searching = !!query.trim() || around;
  // Zones come back only while I am around, so the list is fetched again when that changes.
  const meAround = getPresence(slug).on;
  const key = `${slug}|${query.trim()}|${around}|${meAround}`;
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
    if (!vis.open_to_meet) return;
    const ctl = new AbortController();
    setError(null);
    setPage(null);
    load(0, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const results = r.results ?? [];
        loaded.current = key;
        setPage({ results, done: results.length < MATCH_PAGE });
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
  }, [slug, vis.open_to_meet, saves, idsKey, key]);

  // Appends the next page when the end of the list comes into view. The effect depends on the
  // page only: the "more" flag is for display, so setting it must not abort the fetch.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !page || page.done || typeof IntersectionObserver === 'undefined') return;
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
          setPage({ results: [...page.results, ...next.filter((p) => !seen.has(p.ref))], done: next.length < MATCH_PAGE });
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
  }, [page]);

  // The Around home view: a quiet refresh of the first page while the tab is visible, so the list
  // follows people as they come and go without a flash. A list the person scrolled further is
  // left alone.
  useEffect(() => {
    if (!groupZone || !vis.open_to_meet) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !page || page.results.length > MATCH_PAGE) return;
      const ctl = new AbortController();
      const startKey = current.current;
      load(0, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted || current.current !== startKey) return;
          const results = r.results ?? [];
          setPage({ results, done: results.length < MATCH_PAGE });
        })
        .catch(() => {});
    }, AROUND_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [groupZone, key, vis.open_to_meet, page]);

  // Nudges: "See who" (and a tapped Bluetooth "right near you" notification in the Android app)
  // fetches the list again (the person arrived after it loaded) and then lands on their card, in
  // the order the cards are rendered.
  const shown = useRef<PersonResult[]>([]);
  const [revealAt, setRevealAt] = useState(0);
  useEffect(() => {
    if (!around || (!reveal && !bleReveal) || !vis.open_to_meet) return;
    const ctl = new AbortController();
    load(0, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const results = r.results ?? [];
        loaded.current = key;
        setPage({ results, done: results.length < MATCH_PAGE });
        setRevealAt(Date.now());
      })
      .catch((err) => {
        if (!isAbort(err)) setRevealAt(Date.now());
      });
    return () => ctl.abort();
  }, [reveal, bleReveal, key]);
  useEffect(() => {
    if (!revealAt) return;
    revealIn(slug, list.current, shown.current);
    revealBleCard(slug, list.current, shown.current);
  }, [revealAt]);

  if (!profile?.display_name.trim()) return <CreateProfilePrompt />;
  if (!vis.open_to_meet) return <VisibilityPrompt conference={conference} />;
  if (error) return <p class="pp-error pp-pad">{error}</p>;
  if (!page) return <p class="pp-hint pp-pad">Finding people…</p>;
  const results = withoutBlocked(slug, page.results);
  if (!results.length) {
    return (
      <p class="pp-hint pp-pad">
        {groupZone ? AROUND_EMPTY : searching ? SEARCH_EMPTY : 'No matches yet. Add more topics to your profile, or check back as more people join.'}
      </p>
    );
  }
  // The Around home view groups by zone (server order kept inside each group): my zone first.
  const inZone = groupZone ? results.filter((p) => p.proximity === 'same_zone' || p.zone === groupZone) : [];
  const elsewhere = groupZone ? results.filter((p) => !inZone.includes(p)) : results;
  shown.current = [...inZone, ...elsewhere];
  return (
    <div class="pp-list" ref={list}>
      <SampleNote people={results} />
      {groupZone && (
        <h3 class="pp-group-title">{inZone.length ? `In ${groupZone}` : `Nobody else in ${groupZone} yet`}</h3>
      )}
      {inZone.map((p) => (
        <PersonCard key={p.ref} person={p} slug={slug} />
      ))}
      {groupZone && elsewhere.length > 0 && <h3 class="pp-group-title">Elsewhere at the venue</h3>}
      {elsewhere.map((p) => (
        <PersonCard key={p.ref} person={p} slug={slug} />
      ))}
      {!page.done && (
        <div ref={sentinel} class="pp-more-sentinel" aria-hidden={!more}>
          {more && <p class="pp-hint">Finding more people…</p>}
        </div>
      )}
    </div>
  );
}

export function PeopleScreen({
  conference,
  interested,
  onOpenTalk,
  hereZone,
  onHereHandled,
  aroundNow,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onOpenTalk?: (talk: TalkLike) => void;
  /** The raw zone of a #/here/{zone} deep link, if the tab was opened through one. */
  hereZone?: string | null;
  onHereHandled?: () => void;
  /** True when opened as #/people?around=1 (from a push nudge): "Around now" starts on. */
  aroundNow?: boolean;
}) {
  usePeopleStore();
  const slug = conference.slug;
  const pending = useRef(takePendingSearch());
  const [input, setInput] = useState(() => pending.current ?? '');
  const [query, setQuery] = useState(input);
  // The "Around now" chip of the search bar; the Around home view is around whatever it says.
  // A push nudge opens #/people?around=1, which starts the chip on.
  const [aroundChip, setAroundChip] = useState(!!aroundNow);
  // "Find someone specific": the search bar, collapsed while presence is on until it is tapped
  // (a search handed over from a topic chip opens it at once).
  const [findOpen, setFindOpen] = useState(() => !!pending.current);
  const timer = useRef<number | undefined>(undefined);
  const searchInput = useRef<HTMLDivElement>(null);

  const presence = getPresence(slug);
  const presenceOn = presence.on && !!presence.zone;
  // Home is Around: with presence on and the search collapsed, the tab shows who's around.
  const aroundHome = presenceOn && !findOpen;
  const searchOpen = !presenceOn || findOpen;
  const around = aroundHome ? true : aroundChip;

  const onInput = (v: string) => {
    setInput(v);
    window.clearTimeout(timer.current);
    if (!v.trim()) setQuery('');
    else timer.current = window.setTimeout(() => setQuery(v), DEBOUNCE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const openFind = () => {
    setAroundChip(presenceOn);
    setFindOpen(true);
    window.setTimeout(() => searchInput.current?.querySelector('input')?.focus(), 0);
  };
  const closeFind = () => {
    onInput('');
    setFindOpen(false);
  };

  // Nudges: "See who" on the in-app banner, a push nudge tapped while the app is already open
  // (#/people?around=1) and, in the Android app, a tapped "right near you" notification open the
  // Around view, where the person's card is.
  const { reveal } = useNudges(slug);
  const bleReveal = useBleReveal(slug);
  useEffect(() => {
    if (!reveal && !aroundNow && !bleReveal) return;
    onInput('');
    if (presenceOn) setFindOpen(false);
    else {
      setAroundChip(true);
      setFindOpen(true);
    }
  }, [reveal, aroundNow, bleReveal]);

  const searching = !aroundHome && (!!query.trim() || around);
  const title = aroundHome
    ? AROUND_TITLE
    : searching
      ? around && !query.trim()
        ? 'People around now'
        : 'People who match'
      : 'People to meet';
  const findButton = (
    <button type="button" class="btn btn-tonal pp-find-btn" onClick={openFind}>
      <Search size={18} aria-hidden="true" />
      {FIND_LABEL}
    </button>
  );
  const searchBar = (
    <div ref={searchInput}>
      <PeopleSearchBar value={input} around={around} onInput={onInput} onAround={setAroundChip} />
      {presenceOn && (
        <button type="button" class="btn btn-text btn-small pp-find-back" onClick={closeFind}>
          Back to who's around
        </button>
      )}
    </div>
  );
  return (
    <div class="pp-screen">
      <StillHereRow conference={conference} interested={interested} />
      <NudgeBanner conference={conference} />
      <PresenceControls conference={conference} interested={interested} deepLink={hereZone} onDeepLinkHandled={onHereHandled} />
      {searchOpen && searchBar}
      {!searching && <EndedTalkBanner conference={conference} interested={interested} onOpenTalk={onOpenTalk} />}
      <section class="pp-section" aria-labelledby="pp-people-title">
        <div class="pp-section-head">
          <h2 id="pp-people-title" class="pp-section-title">
            {title}
          </h2>
        </div>
        <PeopleList conference={conference} interested={interested} query={query} around={around} groupZone={aroundHome ? presence.zone : null} />
      </section>
      {aroundHome && findButton}
      {!searching && <ForYouRow conference={conference} interested={interested} onOpenTalk={onOpenTalk} />}
    </div>
  );
}
