import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, CalendarX, CircleExclamationPoint, CircleUserRound, ExternalLink, Inbox, X } from 'lucide-preact';
import type { Conference, InterestedTalk, SearchFilters, SearchResponse, Talk } from './types';
import { EMPTY_FILTERS } from './types';
import { ApiError, getConferences, isAbort, search } from './api';
import {
  applyTheme,
  loadConferences,
  loadInterested,
  loadTheme,
  storeConferences,
  storeInterested,
  toInterested,
  type ThemePref,
} from './lib/storage';
import { decodeParam, defaultConference, goToConference, readRoute, replaceConference, type Route } from './lib/route';
import { useFocusTrap } from './lib/focus';
import { AppBar, ConfirmDialog, NavBar, OverflowMenu, Toast, type ConfirmData, type ToastData } from './components/common';
import { ChipRow, FilterSheet, Results, SearchField, activeFilterCount, type SheetSection } from './components/search';
import { InterestedScreen } from './components/interested';
import { SettingsScreen } from './components/settings';
import { SwitcherButton, SwitcherSheet } from './components/switcher';
import { TalkCard } from './components/talk';
import {
  BlockedPeople,
  ForYouScreen,
  InboxScreen,
  MeetScreen,
  NudgeSetting,
  PeopleIMet,
  PeopleIWatch,
  PeopleScreen,
  ProfileScreen,
  onInterestedChanged,
  registerPeopleUi,
  useInboxCount,
  useInboxWatch,
  usePresenceWatch,
  type TalkLike,
} from './people/index';
import { saveForOffline, useOnline } from './offline/status';
import { NeedsConnection, OfflineBadge, OfflineSearch } from './offline/OfflineSearch';

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 20;

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Search is unavailable right now. Please try again.';
}

/** A single talk in a bottom sheet, opened from the People screen or its banner. */
function TalkSheet({
  talk,
  conference,
  interested,
  onToggle,
  onClose,
}: {
  talk: Talk | null;
  conference: Conference;
  interested: boolean;
  onToggle: (t: Talk) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, !!talk, onClose);
  if (!talk) return null;
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={talk.title} ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2>Talk</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div class="sheet-body sheet-talk">
          <TalkCard talk={talk} conference={conference} interested={interested} onToggleInterested={onToggle} headingLevel={2} />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [conferences, setConferences] = useState<Conference[] | null>(loadConferences);
  const [confError, setConfError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [interested, setInterestedState] = useState<{ slug: string; talks: InterestedTalk[] }>(() => ({
    slug: route.slug ?? '',
    talks: route.slug ? loadInterested(route.slug) : [],
  }));
  const [toast, setToast] = useState<ToastData | null>(null);
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [openTalk, setOpenTalk] = useState<Talk | null>(null);

  // Search state lives here so it survives tab switches; it resets per conference.
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; section?: SheetSection }>({ open: false });
  const online = useOnline();

  const { slug, tab, param } = route;
  const conference = slug && conferences ? (conferences.find((c) => c.slug === slug) ?? null) : null;
  const searchable = conference?.status === 'searchable' ? conference : null;
  const talks = interested.slug === slug ? interested.talks : [];

  // Find & connect: presence timers and the inbox poll run on every tab while the app is open.
  usePresenceWatch(searchable?.slug ?? null);
  useInboxWatch(searchable?.slug ?? null);
  const inboxCount = useInboxCount(searchable?.slug ?? null);

  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ input, filters, slug: searchable?.slug ?? null, talks, data });
  latest.current = { input, filters, slug: searchable?.slug ?? null, talks, data };
  const searchedKey = useRef('');

  const showToast = useCallback((message: string, action?: ToastData['action']) => {
    setToast({ id: Date.now(), message, action });
  }, []);

  // The people screens use the shell's one Toast and ConfirmDialog.
  useEffect(() => {
    registerPeopleUi({ toast: showToast, confirm: (d) => setConfirm(d) });
    return () => registerPeopleUi(null);
  }, [showToast]);

  const loadList = useCallback(async () => {
    try {
      const res = await getConferences();
      setConferences(res.conferences);
      storeConferences(res.conferences);
      setConfError(null);
    } catch (err) {
      if (!isAbort(err)) setConfError(err instanceof ApiError ? err.message : 'Conferences are temporarily unavailable.');
    }
  }, []);

  useEffect(() => {
    loadList();
    // A navigation closes any open sheet, so it never stays over the next screen.
    const onRoute = () => {
      setSwitcherOpen(false);
      setOpenTalk(null);
      setRoute(readRoute());
    };
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('caddie:route', onRoute);
    return () => {
      window.removeEventListener('popstate', onRoute);
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('caddie:route', onRoute);
    };
  }, []);

  // "/" goes to the default conference once the list is known.
  useEffect(() => {
    if (slug !== null || !conferences) return;
    const c = defaultConference(conferences);
    if (c) replaceConference(c.slug, tab);
  }, [slug, conferences]);

  // A new conference brings its own interested list and a clean search.
  useEffect(() => {
    if (interested.slug !== (slug ?? '')) {
      setInterestedState({ slug: slug ?? '', talks: slug ? loadInterested(slug) : [] });
    }
    controller.current?.abort();
    window.clearTimeout(timer.current);
    searchedKey.current = '';
    // Filters name the old conference's values, so they must not reach the next search.
    latest.current.filters = EMPTY_FILTERS;
    setFilters(EMPTY_FILTERS);
    setData(null);
    setError(null);
    setLoading(false);
    setOpenTalk(null);
    setSheet({ open: false });
  }, [slug]);

  useEffect(() => {
    document.title = conference ? `${conference.name} · Conference Caddie` : 'Conference Caddie';
  }, [conference?.name]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, slug]);

  useEffect(() => applyTheme(theme), [theme]);

  // Back online: refresh the conference list. Online: save the current conference's schedule
  // shortly after it opens, so airplane mode works right away.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) loadList();
    wasOnline.current = online;
  }, [online]);

  useEffect(() => {
    if (!online || !searchable) return;
    const s = searchable.slug;
    const t = window.setTimeout(() => saveForOffline(s), 1500);
    return () => window.clearTimeout(t);
  }, [online, searchable?.slug]);

  const setInterested = useCallback((forSlug: string, next: InterestedTalk[]) => {
    setInterestedState({ slug: forSlug, talks: next });
    storeInterested(forSlug, next);
  }, []);

  const runSearch = useCallback(async () => {
    window.clearTimeout(timer.current);
    controller.current?.abort();
    const { input: q, filters: f, slug: s } = latest.current;
    if (!s) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    searchedKey.current = `${s}|${JSON.stringify(f)}`;
    setLoading(true);
    try {
      const res = await search(s, q, f, PAGE_SIZE, ctrl.signal);
      if (ctrl.signal.aborted || latest.current.slug !== s) return;
      setData(res);
      setLastQuery(q.trim());
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(errorMessage(err));
    } finally {
      if (controller.current === ctrl) setLoading(false);
    }
  }, []);

  // Search runs when the Search tab is shown and its conference or filters changed.
  useEffect(() => {
    if (tab !== 'search' || !searchable) return;
    // Offline, the keyword search over the saved schedule runs instead; the next online visit
    // searches again.
    if (!online) {
      controller.current?.abort();
      window.clearTimeout(timer.current);
      searchedKey.current = '';
      return;
    }
    if (searchedKey.current !== `${searchable.slug}|${JSON.stringify(filters)}`) runSearch();
  }, [tab, searchable?.slug, filters, online]);

  const onInput = (v: string) => {
    setInput(v);
    latest.current.input = v;
    window.clearTimeout(timer.current);
    if (!online) return;
    timer.current = window.setTimeout(() => runSearch(), DEBOUNCE_MS);
  };

  // The people screens pass talk objects that carry the full search result shape
  // (recommendations and Interested entries), typed structurally as TalkLike.
  // With "sharing follows Interested" on, a mark or unmark also changes the shared-talk list.
  // Anything that stops the share (no name on the profile yet, the 50-talk limit, a failed write)
  // is shown here, since the list changed on a screen without the sharing controls.
  const followShare = (s: string, ids: string[], marked: boolean) =>
    void onInterestedChanged(s, ids, marked).then((message) => {
      if (!message) return;
      showToast(message, message.includes('profile') ? { label: 'Open profile', onClick: () => (location.hash = '#/profile') } : undefined);
    });

  const toggleInterested = (input: Talk | TalkLike | string) => {
    const s = latest.current.slug;
    if (!s) return;
    const t = input as Talk | string;
    const current = latest.current.talks;
    const id = typeof t === 'string' ? t : t.talk_id;
    const index = current.findIndex((x) => x.talk_id === id);
    if (index >= 0) {
      const removed = current[index];
      setInterested(s, current.filter((x) => x.talk_id !== id));
      followShare(s, [id], false);
      showToast('Removed from Interested', {
        label: 'Undo',
        onClick: () => {
          const now = latest.current.talks.filter((x) => x.talk_id !== removed.talk_id);
          now.splice(Math.min(index, now.length), 0, removed);
          setInterested(s, now);
          followShare(s, [removed.talk_id], true);
        },
      });
      return;
    }
    if (typeof t === 'string' || t.conference !== s) return;
    const added = toInterested(t);
    setInterested(s, [...current, added]);
    followShare(s, [added.talk_id], true);
    showToast('Added to Interested', {
      label: 'Undo',
      onClick: () => {
        setInterested(s, latest.current.talks.filter((x) => x.talk_id !== added.talk_id));
        followShare(s, [added.talk_id], false);
      },
    });
  };

  const onOpenTalk = (input: Talk | TalkLike | string) => {
    const t = input as Talk | string;
    if (typeof t !== 'string') return setOpenTalk(t);
    const found =
      latest.current.talks.find((x) => x.talk_id === t) ?? latest.current.data?.results.find((x) => x.talk_id === t);
    if (found) setOpenTalk(found);
  };

  const clearInterested = () => {
    const s = latest.current.slug;
    if (!s) return;
    setToast(null);
    const n = talks.length;
    setConfirm({
      title: 'Clear your Interested list?',
      body: `This removes all ${n} ${n === 1 ? 'talk' : 'talks'} you marked for this conference from this device.`,
      confirmLabel: 'Clear',
      onConfirm: () => {
        const before = latest.current.talks;
        const ids = before.map((x) => x.talk_id);
        setInterested(s, []);
        followShare(s, ids, false);
        showToast('Interested list cleared', {
          label: 'Undo',
          onClick: () => {
            setInterested(s, before);
            followShare(s, ids, true);
          },
        });
      },
    });
  };

  // Screens that belong to one conference and one moment go back to People on a switch.
  const perConference = tab === 'settings' || tab === 'inbox' || tab === 'meet' || tab === 'here';
  const pickConference = (next: string) => {
    setSwitcherOpen(false);
    if (next !== slug) goToConference(next, perConference ? 'people' : tab);
  };

  // #/here/{zone} is the People tab with presence turned on; once handled, the hash becomes #/people.
  const hereHandled = () => {
    if (readRoute().tab !== 'here') return;
    history.replaceState(null, '', `${location.pathname}#/people`);
    window.dispatchEvent(new Event('caddie:route'));
  };

  const interestedIds = new Set(talks.map((t) => t.talk_id));
  const base = slug ? `/e/${encodeURIComponent(slug)}` : '';
  const isTabScreen = tab !== 'profile' && tab !== 'settings' && tab !== 'inbox' && tab !== 'meet';
  const navTab = tab === 'here' || tab === 'inbox' || tab === 'meet' ? 'people' : tab;

  const leading = !isTabScreen ? (
    <a class="icon-btn appbar-back" href={tab === 'settings' ? '#/profile' : '#/people'} aria-label="Back">
      <ArrowLeft size={22} aria-hidden="true" />
    </a>
  ) : null;

  const title = isTabScreen ? (
    <SwitcherButton
      name={conference?.name ?? (conferences ? 'Choose a conference' : 'Conference Caddie')}
      onOpen={() => {
        setToast(null);
        setSwitcherOpen(true);
      }}
    />
  ) : tab === 'profile' ? (
    'Profile'
  ) : tab === 'inbox' ? (
    'Requests'
  ) : tab === 'meet' ? (
    'Meet up'
  ) : (
    'Settings'
  );

  const actions = (
    <>
      {!online && <OfflineBadge />}
      {tab === 'interested' && searchable && (
        <OverflowMenu
          label="Interested options"
          items={[{ label: 'Clear list', destructive: true, disabled: !talks.length, onSelect: clearInterested }]}
        />
      )}
      {isTabScreen && (tab === 'people' || tab === 'here') && searchable && (
        <a class="icon-btn appbar-inbox" href="#/inbox" aria-label={inboxCount ? `Requests, ${inboxCount} new` : 'Requests'}>
          <Inbox size={24} aria-hidden="true" />
          {inboxCount > 0 && (
            <span class="badge nav-badge" aria-hidden="true">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </a>
      )}
      {isTabScreen && (
        <a class="icon-btn" href="#/profile" aria-label="Your profile">
          <CircleUserRound size={24} aria-hidden="true" />
        </a>
      )}
    </>
  );

  // What to show instead of a conference screen when there is no searchable conference.
  function blocker() {
    if (!conferences) {
      if (confError) {
        return (
          <div class="state">
            <CircleExclamationPoint size={40} class="state-icon" aria-hidden="true" />
            <p class="state-title">Something went wrong</p>
            <p class="state-body">{confError}</p>
            <button type="button" class="btn btn-tonal" onClick={loadList}>
              Retry
            </button>
          </div>
        );
      }
      return (
        <div class="state" aria-busy="true">
          <p class="state-body">Loading conferences…</p>
        </div>
      );
    }
    if (!conference) {
      return (
        <div class="state">
          <CalendarX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-title">{slug === null ? 'No conferences yet' : "This conference isn't available here"}</p>
          <p class="state-body">Choose another conference to continue.</p>
          <button type="button" class="btn btn-tonal" onClick={() => setSwitcherOpen(true)}>
            Choose a conference
          </button>
        </div>
      );
    }
    return (
      <div class="state">
        <CalendarX size={40} class="state-icon" aria-hidden="true" />
        <p class="state-title">Schedule not available here yet</p>
        <p class="state-body">{conference.name} can't be searched here yet. Its schedule is on the official site.</p>
        <a class="btn btn-tonal" href={conference.official_schedule_url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={18} aria-hidden="true" />
          Open the official schedule
        </a>
      </div>
    );
  }

  return (
    <div class="shell">
      <NavBar tab={navTab} base={base} interestedCount={talks.length} peopleCount={inboxCount} />
      <div class="content">
        <AppBar leading={leading} title={title} actions={actions} />
        <main class="main" id="main">
          {tab === 'settings' ? (
            <SettingsScreen
              theme={theme}
              onTheme={setTheme}
              people={searchable ? <><BlockedPeople conference={searchable} /><PeopleIMet conference={searchable} /><PeopleIWatch conference={searchable} /><NudgeSetting conference={searchable} /></> : null}
            />
          ) : !searchable ? (
            blocker()
          ) : (
            <>
              {!online && (tab === 'people' || tab === 'here' || tab === 'for-you' || tab === 'inbox' || tab === 'meet') && (
                <NeedsConnection
                  title={tab === 'for-you' ? 'Suggestions need a connection' : 'People to meet needs a connection'}
                  body="They will load when you're back online. Search, your Interested list and your profile still work on this phone."
                />
              )}
              {online && (tab === 'people' || tab === 'here') && (
                <PeopleScreen
                  key={searchable.slug}
                  conference={searchable}
                  interested={talks}
                  onOpenTalk={onOpenTalk}
                  hereZone={tab === 'here' ? param : null}
                  onHereHandled={hereHandled}
                />
              )}
              {online && tab === 'inbox' && <InboxScreen key={searchable.slug} conference={searchable} />}
              {online && tab === 'meet' && param && (
                <MeetScreen key={`${searchable.slug}:${param}`} conference={searchable} meetId={decodeParam(param)} interested={talks} />
              )}
              {online && tab === 'for-you' && (
                <ForYouScreen key={searchable.slug} conference={searchable} interested={talks} onToggleInterested={toggleInterested} />
              )}
              {tab === 'profile' && <ProfileScreen key={searchable.slug} conference={searchable} interested={talks} />}
              {tab === 'search' && !online && (
                <>
                  <SearchField value={input} onInput={onInput} onSubmit={() => undefined} loading={false} />
                  <OfflineSearch conference={searchable} query={input} interestedIds={interestedIds} onToggle={toggleInterested} />
                </>
              )}
              {tab === 'search' && online && (
                <>
                  <SearchField value={input} onInput={onInput} onSubmit={() => runSearch()} loading={loading} />
                  <ChipRow
                    conference={searchable}
                    filters={filters}
                    facets={data?.facets ?? null}
                    onChange={setFilters}
                    onOpenSheet={(section) => {
                      setToast(null);
                      setSheet({ open: true, section });
                    }}
                  />
                  <Results
                    conference={searchable}
                    data={data}
                    browse={lastQuery === ''}
                    loading={loading}
                    error={error}
                    interestedIds={interestedIds}
                    filtersActive={activeFilterCount(filters) > 0}
                    onRetry={() => runSearch()}
                    onToggle={toggleInterested}
                    onClearFilters={() => setFilters(EMPTY_FILTERS)}
                  />
                </>
              )}
              {tab === 'interested' && (
                <InterestedScreen
                  conference={searchable}
                  interested={talks}
                  onToggle={toggleInterested}
                  onBrowse={() => (location.hash = '#/search')}
                />
              )}
            </>
          )}
        </main>
      </div>
      {searchable && (
        <FilterSheet
          conference={searchable}
          open={sheet.open}
          section={sheet.section}
          filters={filters}
          facets={data?.facets ?? null}
          total={data && !loading ? data.total : null}
          onChange={setFilters}
          onClose={() => setSheet({ open: false })}
        />
      )}
      {searchable && (
        <TalkSheet
          talk={openTalk}
          conference={searchable}
          interested={!!openTalk && interestedIds.has(openTalk.talk_id)}
          onToggle={toggleInterested}
          onClose={() => setOpenTalk(null)}
        />
      )}
      <SwitcherSheet
        open={switcherOpen}
        conferences={conferences}
        current={slug}
        error={confError}
        onPick={pickConference}
        onClose={() => setSwitcherOpen(false)}
      />
      <ConfirmDialog data={confirm} onClose={() => setConfirm(null)} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
